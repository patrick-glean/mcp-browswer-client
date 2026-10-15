// Example Helpdesk on the official Go SDK: the server whose replies are in ../../example.json,
// described as fully as MCP allows and served over Streamable HTTP, so a browser client such as
// MCP Browser Client can connect to it.
//
//	go run .    # http://127.0.0.1:8090/mcp; PORT picks another port
//
// What a client shows comes from what's declared here: the server's identity and instructions,
// each tool's title, description, annotations and schemas, and the resources and prompts. The
// tickets are canned; a real server would look them up.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}
	server := newServer()
	// Stateless with JSON replies: each request stands alone, which suits 2026-07-28 and still
	// answers 2025 clients' initialize.
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	http.Handle("/mcp", allowBrowsers(mcpHandler))
	address := "127.0.0.1:" + port
	log.Printf("Example Helpdesk (Go SDK) on http://%s/mcp", address)
	log.Fatal(http.ListenAndServe(address, nil))
}

func newServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name:        "example-helpdesk",
		Title:       "Example Helpdesk",
		Version:     "1.4.0",
		Description: "Search, read and update the support tickets in Example Helpdesk, and chart how many come in.",
		WebsiteURL:  "https://helpdesk.example.com/docs/mcp",
		Icons: []mcp.Icon{
			{Source: lightIcon, MIMEType: "image/svg+xml", Sizes: []string{"any"}, Theme: mcp.IconThemeLight},
			{Source: darkIcon, MIMEType: "image/svg+xml", Sizes: []string{"any"}, Theme: mcp.IconThemeDark},
			{Source: "https://helpdesk.example.com/icons/helpdesk-48.png", MIMEType: "image/png", Sizes: []string{"48x48"}},
		},
	}, &mcp.ServerOptions{
		Instructions: instructions,
		// Declared rather than inferred, which would add listChanged (and logging) this server
		// doesn't send.
		Capabilities: &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{}, Resources: &mcp.ResourceCapabilities{}, Prompts: &mcp.PromptCapabilities{}},
		SetCacheable: cacheHints,
	})
	addTools(server)
	addResources(server)
	addPrompts(server)
	return server
}

const instructions = `Example Helpdesk holds the Example company's support tickets. Ticket IDs look like T-1042, and dates are in UTC.

- To find a ticket, use search_tickets, then get_ticket with its ID. Don't guess IDs.
- update_ticket changes only the fields you send. Before changing the status or assignee of a ticket the person didn't mention, ask them.
- delete_ticket can't be undone. Only use it when the person asks to delete a specific ticket; otherwise set its status to closed.
- For questions about workload or trends, use ticket_volume_chart.
- helpdesk://guides/getting-started explains what each status and priority means.`

// How long clients may reuse server/discover and the lists, and that they're the same for
// everyone. Resource reads set their own, in readResult.
func cacheHints(_ context.Context, req mcp.Request, c *mcp.Cacheable) {
	switch req.(type) {
	case *mcp.ServerRequest[*mcp.DiscoverParams]:
		c.TTLMs, c.CacheScope = 3_600_000, "public"
	case *mcp.ListToolsRequest, *mcp.ListResourcesRequest, *mcp.ListResourceTemplatesRequest, *mcp.ListPromptsRequest:
		c.TTLMs, c.CacheScope = 600_000, "public"
	}
}

// --- Tools ---

var (
	statuses   = []any{"open", "pending", "solved", "closed"}
	priorities = []any{"low", "normal", "high", "urgent"}
	ticketID   = regexp.MustCompile(`^T-[0-9]+$`)
)

// Every hint, set explicitly: the protocol's defaults assume a tool may write, may destroy and
// reaches the outside world.
func hints(readOnly, destructive, idempotent, openWorld bool) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{ReadOnlyHint: readOnly, DestructiveHint: &destructive, IdempotentHint: idempotent, OpenWorldHint: &openWorld}
}

// The schema Go infers from T (types, descriptions from jsonschema tags, required from fields
// without omitempty, properties in field order), with `more` adding what tags can't say: enums,
// examples, formats, patterns, ranges and defaults.
func schemaFor[T any](more func(properties map[string]*jsonschema.Schema)) *jsonschema.Schema {
	schema, err := jsonschema.For[T](nil)
	if err != nil {
		log.Fatal(err)
	}
	if more != nil {
		more(schema.Properties)
	}
	return schema
}

func idSchema(p *jsonschema.Schema) {
	p.Pattern = ticketID.String()
	p.Examples = []any{"T-1042"}
}

// Go infers a slice as ["null", "array"], since a nil slice marshals as null; this one never is.
func arrayOnly(p *jsonschema.Schema) {
	p.Types, p.Type = nil, "array"
}

type SearchArgs struct {
	Query        string `json:"query" jsonschema:"Words to look for in the subject and messages."`
	Status       string `json:"status,omitempty" jsonschema:"Only tickets with this status."`
	Priority     string `json:"priority,omitempty" jsonschema:"Only tickets with this priority."`
	Assignee     string `json:"assignee,omitempty" jsonschema:"Only tickets assigned to this person, by email address."`
	UpdatedAfter string `json:"updated_after,omitempty" jsonschema:"Only tickets updated on or after this day (UTC), as YYYY-MM-DD."`
	Limit        int    `json:"limit,omitempty" jsonschema:"How many tickets to return at most."`
	Cursor       string `json:"cursor,omitempty" jsonschema:"nextCursor from an earlier response, for the next page."`
}

type TicketSummary struct {
	ID        string `json:"id"`
	Subject   string `json:"subject"`
	Status    string `json:"status"`
	Priority  string `json:"priority"`
	UpdatedAt string `json:"updatedAt"`
}

type SearchResult struct {
	Tickets    []TicketSummary `json:"tickets" jsonschema:"The tickets found, most recently updated first."`
	Total      int             `json:"total" jsonschema:"How many tickets match, on every page."`
	NextCursor string          `json:"nextCursor,omitempty" jsonschema:"Send as cursor for the next page. Absent on the last page."`
}

type Person struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Ticket struct {
	ID        string   `json:"id" jsonschema:"The ticket's ID."`
	Subject   string   `json:"subject" jsonschema:"One line on what's wrong."`
	Status    string   `json:"status"`
	Priority  string   `json:"priority"`
	Requester Person   `json:"requester"`
	Assignee  string   `json:"assignee,omitempty" jsonschema:"Who's working on it. Absent while it's unassigned."`
	Tags      []string `json:"tags"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
	URL       string   `json:"url" jsonschema:"The ticket in the helpdesk's web app."`
}

type TicketArgs struct {
	ID string `json:"id" jsonschema:"The ticket's ID: T- and a number."`
}

type UpdateArgs struct {
	ID       string   `json:"id" jsonschema:"The ticket's ID: T- and a number."`
	Status   string   `json:"status,omitempty" jsonschema:"The new status."`
	Priority string   `json:"priority,omitempty" jsonschema:"The new priority."`
	Assignee string   `json:"assignee,omitempty" jsonschema:"Who to assign it to, by email address."`
	Tags     []string `json:"tags,omitempty" jsonschema:"The ticket's tags, replacing the ones it has: lowercase words and dashes."`
}

type DeleteArgs struct {
	ID     string `json:"id" jsonschema:"The ticket's ID: T- and a number."`
	Reason string `json:"reason,omitempty" jsonschema:"Why it's being deleted, kept in the audit log."`
}

type ChartArgs struct {
	Days    int    `json:"days,omitempty" jsonschema:"How many days to chart, ending today."`
	GroupBy string `json:"group_by,omitempty" jsonschema:"What each bar counts."`
}

type ArticleArgs struct {
	URL string `json:"url" jsonschema:"The article's address on help.example.com."`
}

func addTools(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "search_tickets",
		Title:       "Search tickets",
		Description: "Finds tickets by words in their subject and messages, most recently updated first. Use it to find a ticket before reading or changing it. Returns each ticket's ID, subject, status, priority and when it last changed, with a link to read the whole ticket. Narrow a long list with status, priority, assignee or updated_after.",
		Annotations: hints(true, false, true, false),
		InputSchema: schemaFor[SearchArgs](func(p map[string]*jsonschema.Schema) {
			p["query"].MinLength = jsonschema.Ptr(1)
			p["query"].Examples = []any{"printer offline"}
			p["status"].Enum = statuses
			p["priority"].Enum = priorities
			p["assignee"].Format = "email"
			p["assignee"].Examples = []any{"grace@example.com"}
			p["updated_after"].Format = "date"
			p["updated_after"].Examples = []any{"2026-10-01"}
			p["limit"].Minimum, p["limit"].Maximum, p["limit"].Default = jsonschema.Ptr(1.0), jsonschema.Ptr(50.0), json.RawMessage("10")
		}),
		OutputSchema: schemaFor[SearchResult](func(p map[string]*jsonschema.Schema) {
			ticket := p["tickets"].Items.Properties
			ticket["status"].Enum = statuses
			ticket["priority"].Enum = priorities
			ticket["updatedAt"].Format = "date-time"
		}),
	}, searchTickets)

	mcp.AddTool(server, &mcp.Tool{
		Name:         "get_ticket",
		Title:        "Get a ticket",
		Description:  "Gets one ticket in full: subject, status, priority, requester, assignee, tags, dates and its address in the web app. Use it when you know the ticket's ID, from search_tickets or from the person; it doesn't search.",
		Annotations:  hints(true, false, true, false),
		InputSchema:  schemaFor[TicketArgs](func(p map[string]*jsonschema.Schema) { idSchema(p["id"]) }),
		OutputSchema: ticketSchema(),
	}, getTicket)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "update_ticket",
		Title:       "Update a ticket",
		Description: "Changes a ticket's status, priority, assignee or tags. Fields you leave out stay as they are, and sending the same values again changes nothing. Send at least one field besides id.",
		Annotations: hints(false, false, true, false),
		InputSchema: schemaFor[UpdateArgs](func(p map[string]*jsonschema.Schema) {
			idSchema(p["id"])
			p["status"].Enum = statuses
			p["priority"].Enum = priorities
			p["assignee"].Format = "email"
			p["assignee"].Examples = []any{"grace@example.com"}
			arrayOnly(p["tags"])
			p["tags"].Items.Pattern = "^[a-z0-9-]+$"
			p["tags"].UniqueItems = true
			p["tags"].Examples = []any{[]any{"hardware", "printing"}}
		}),
	}, updateTicket)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "delete_ticket",
		Title:       "Delete a ticket",
		Description: "Deletes a ticket and its messages for good. Only use it when the person asks to delete that ticket; to stop work on one, set its status to closed with update_ticket instead.",
		Annotations: hints(false, true, true, false),
		InputSchema: schemaFor[DeleteArgs](func(p map[string]*jsonschema.Schema) {
			idSchema(p["id"])
			p["reason"].MaxLength = jsonschema.Ptr(500)
			p["reason"].Examples = []any{"Duplicate of T-1038"}
		}),
	}, deleteTicket)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "ticket_volume_chart",
		Title:       "Chart ticket volume",
		Description: "Charts how many tickets came in over the last days, one bar per status or priority, as a PNG image with a one-line summary. Use it for questions about workload and trends.",
		Annotations: hints(true, false, true, false),
		InputSchema: schemaFor[ChartArgs](func(p map[string]*jsonschema.Schema) {
			p["days"].Minimum, p["days"].Maximum, p["days"].Default = jsonschema.Ptr(7.0), jsonschema.Ptr(90.0), json.RawMessage("30")
			p["group_by"].Enum = []any{"status", "priority"}
			p["group_by"].Default = json.RawMessage(`"status"`)
		}),
	}, volumeChart)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "fetch_help_article",
		Title:       "Fetch a help center article",
		Description: "Fetches an article from the public help center at help.example.com, as Markdown. Use it to quote or summarize published help for a requester. It only fetches help.example.com addresses.",
		Annotations: hints(true, false, true, true),
		InputSchema: schemaFor[ArticleArgs](func(p map[string]*jsonschema.Schema) {
			p["url"].Format = "uri"
			p["url"].Pattern = `^https://help\.example\.com/`
			p["url"].Examples = []any{"https://help.example.com/articles/printer-offline"}
		}),
	}, fetchArticle)
}

func ticketSchema() *jsonschema.Schema {
	return schemaFor[Ticket](func(p map[string]*jsonschema.Schema) {
		p["status"].Enum = statuses
		p["priority"].Enum = priorities
		p["requester"].Properties["email"].Format = "email"
		p["assignee"].Format = "email"
		arrayOnly(p["tags"])
		p["createdAt"].Format = "date-time"
		p["updatedAt"].Format = "date-time"
		p["url"].Format = "uri"
	})
}

// A link to read a ticket as a resource, labelled for people.
func ticketLink(t TicketSummary) *mcp.ResourceLink {
	return &mcp.ResourceLink{
		URI:         "helpdesk://tickets/" + t.ID,
		Name:        t.ID,
		Title:       t.ID + ": " + t.Subject,
		Description: fmt.Sprintf("%s, %s priority, updated %s", t.Status, t.Priority, t.UpdatedAt[:10]),
		MIMEType:    "application/json",
	}
}

// The same JSON as text: clients and models that only read text get the data too.
func asText(value any) *mcp.TextContent {
	data, err := json.Marshal(value)
	if err != nil {
		log.Fatal(err)
	}
	return &mcp.TextContent{Text: string(data)}
}

func searchTickets(_ context.Context, _ *mcp.CallToolRequest, args SearchArgs) (*mcp.CallToolResult, SearchResult, error) {
	found := SearchResult{Tickets: matches, Total: len(matches)}
	content := []mcp.Content{asText(found)}
	for _, ticket := range matches {
		content = append(content, ticketLink(ticket))
	}
	return &mcp.CallToolResult{Content: content}, found, nil
}

func getTicket(_ context.Context, _ *mcp.CallToolRequest, args TicketArgs) (*mcp.CallToolResult, Ticket, error) {
	if args.ID != ticket1042.ID {
		// An ordinary error comes back as an isError result the caller can act on.
		return nil, Ticket{}, fmt.Errorf("there's no ticket %s; search_tickets finds tickets by their words", args.ID)
	}
	return &mcp.CallToolResult{Content: []mcp.Content{
		asText(ticket1042),
		&mcp.ResourceLink{URI: ticket1042.URL, Name: ticket1042.ID, Title: "Open T-1042 in Example Helpdesk", MIMEType: "text/html"},
	}}, ticket1042, nil
}

func updateTicket(_ context.Context, _ *mcp.CallToolRequest, args UpdateArgs) (*mcp.CallToolResult, any, error) {
	updated := matches[0]
	updated.Status, updated.UpdatedAt = "solved", "2026-10-15T09:30:00Z"
	return &mcp.CallToolResult{Content: []mcp.Content{
		&mcp.TextContent{Text: "Updated T-1042: its status is now solved."},
		ticketLink(updated),
	}}, nil, nil
}

func deleteTicket(_ context.Context, _ *mcp.CallToolRequest, args DeleteArgs) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "Deleted T-1042 and its 4 messages."}}}, nil, nil
}

func volumeChart(_ context.Context, _ *mcp.CallToolRequest, args ChartArgs) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{Content: []mcp.Content{
		// For people to look at; the text says the same for models.
		&mcp.ImageContent{Data: volumePNG, MIMEType: "image/png", Annotations: &mcp.Annotations{Audience: []mcp.Role{"user"}}},
		&mcp.TextContent{Text: "Last 30 days: 214 new tickets. 37 are open, 21 pending, 142 solved and 14 closed."},
	}}, nil, nil
}

func fetchArticle(_ context.Context, _ *mcp.CallToolRequest, args ArticleArgs) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{Content: []mcp.Content{
		&mcp.TextContent{Text: printerOffline},
		&mcp.ResourceLink{URI: "https://help.example.com/articles/printer-offline", Name: "printer-offline", Title: "When a printer shows offline, in the help center", MIMEType: "text/html"},
	}}, nil, nil
}

// --- Resources ---

func readResult(uri, mimeType, text string, blob []byte, ttlMs int, scope string) *mcp.ReadResourceResult {
	return &mcp.ReadResourceResult{
		Cacheable: mcp.Cacheable{TTLMs: ttlMs, CacheScope: scope},
		Contents:  []*mcp.ResourceContents{{URI: uri, MIMEType: mimeType, Text: text, Blob: blob}},
	}
}

func addResources(server *mcp.Server) {
	resources := []struct {
		resource *mcp.Resource
		read     *mcp.ReadResourceResult
	}{
		{
			&mcp.Resource{
				URI: "helpdesk://guides/getting-started", Name: "getting-started", Title: "Getting started",
				Description: "What each ticket status and priority means. Read it before changing tickets.",
				MIMEType:    "text/markdown", Size: int64(len(gettingStarted)),
				Annotations: &mcp.Annotations{Audience: []mcp.Role{"user", "assistant"}, Priority: 0.9, LastModified: "2026-09-30T12:00:00Z"},
			},
			readResult("helpdesk://guides/getting-started", "text/markdown", gettingStarted, nil, 3_600_000, "public"),
		},
		{
			&mcp.Resource{
				URI: "helpdesk://schemas/ticket", Name: "ticket-schema", Title: "Ticket schema",
				Description: "The JSON Schema every ticket follows, with what each field means.",
				MIMEType:    "application/schema+json", Size: int64(len(ticketSchemaJSON)),
				Annotations: &mcp.Annotations{Audience: []mcp.Role{"assistant"}, Priority: 0.5, LastModified: "2026-08-14T08:00:00Z"},
			},
			readResult("helpdesk://schemas/ticket", "application/schema+json", ticketSchemaJSON, nil, 86_400_000, "public"),
		},
		{
			&mcp.Resource{
				URI: "helpdesk://reports/volume.png", Name: "volume-chart", Title: "Ticket volume, last 30 days",
				Description: "New tickets over the last 30 days, one bar per status. Updated every hour.",
				MIMEType:    "image/png", Size: int64(len(volumePNG)),
				Annotations: &mcp.Annotations{Audience: []mcp.Role{"user"}, Priority: 0.3, LastModified: "2026-10-15T09:00:00Z"},
			},
			// This organization's own figures: clients mustn't share them across sign-ins.
			readResult("helpdesk://reports/volume.png", "image/png", "", volumePNG, 3_600_000, "private"),
		},
	}
	for _, entry := range resources {
		read := entry.read
		server.AddResource(entry.resource, func(context.Context, *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return read, nil
		})
	}

	server.AddResourceTemplate(&mcp.ResourceTemplate{
		URITemplate: "helpdesk://tickets/{id}",
		Name:        "ticket",
		Title:       "Ticket by ID",
		// A template's variables have no schema, so the description says what id looks like.
		Description: "One ticket as JSON, as get_ticket returns it. id is the ticket's ID, such as T-1042.",
		MIMEType:    "application/json",
	}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		if req.Params.URI != "helpdesk://tickets/"+ticket1042.ID {
			return nil, mcp.ResourceNotFoundError(req.Params.URI)
		}
		data, _ := json.Marshal(ticket1042)
		return readResult(req.Params.URI, "application/json", string(data), nil, 0, "private"), nil
	})
}

// --- Prompts ---

func addPrompts(server *mcp.Server) {
	server.AddPrompt(&mcp.Prompt{
		Name:        "summarize_ticket",
		Title:       "Summarize a ticket",
		Description: "Drafts a short summary of a ticket: what's wrong, what's been tried and what's next. For handing a ticket over, or for updating the requester.",
		Arguments: []*mcp.PromptArgument{
			// Arguments have no schema either: an example in the description is what a client
			// can fill in.
			{Name: "id", Description: "The ticket to summarize, such as T-1042.", Required: true},
			{Name: "audience", Description: `Who reads the summary: either "agent" or "requester". Defaults to "agent".`},
		},
	}, func(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		data, _ := json.Marshal(ticket1042)
		return &mcp.GetPromptResult{
			Description: "A summary of T-1042 for the support team",
			Messages: []*mcp.PromptMessage{
				{Role: "user", Content: &mcp.TextContent{Text: "Summarize this ticket for the support team in three short paragraphs: the problem, what has been tried, and the next step. Keep the requester's own words where you can."}},
				{Role: "user", Content: &mcp.EmbeddedResource{Resource: &mcp.ResourceContents{URI: "helpdesk://tickets/T-1042", MIMEType: "application/json", Text: string(data)}}},
			},
		}, nil
	})

	server.AddPrompt(&mcp.Prompt{
		Name:        "triage_open_tickets",
		Title:       "Triage the open tickets",
		Description: "Asks for the open tickets in order of urgency, with who should take each one.",
	}, func(context.Context, *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return &mcp.GetPromptResult{
			Description: "Triage of the open tickets",
			Messages: []*mcp.PromptMessage{
				{Role: "user", Content: &mcp.TextContent{Text: "List the open tickets from most to least urgent. For each, say in one line why it's urgent and who should take it, from the people already working on similar tickets."}},
				{Role: "assistant", Content: &mcp.TextContent{Text: "I'll search the open tickets first, then read the urgent and high-priority ones in full before ordering them."}},
			},
		}, nil
	})
}

// --- Browsers ---

var allowedOrigin = regexp.MustCompile(`^(http://(localhost|127\.0\.0\.1)(:\d+)?|https://patrick-glean\.github\.io)$`)

// A page calling the server sends its origin and the MCP headers (MCP-Protocol-Version,
// Mcp-Method, Mcp-Name, Mcp-Param-*, Authorization), so the server lets those through CORS and
// lets the page read Mcp-Session-Id.
func allowBrowsers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !allowedOrigin.MatchString(origin) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- Canned data ---

var matches = []TicketSummary{
	{ID: "T-1042", Subject: "Printer on floor 3 shows offline", Status: "open", Priority: "high", UpdatedAt: "2026-10-14T16:02:00Z"},
	{ID: "T-1038", Subject: "Printer driver won't install on macOS 16", Status: "pending", Priority: "normal", UpdatedAt: "2026-10-13T11:40:00Z"},
	{ID: "T-1017", Subject: "Badge printer jams on the first card", Status: "solved", Priority: "low", UpdatedAt: "2026-10-09T08:05:00Z"},
}

var ticket1042 = Ticket{
	ID: "T-1042", Subject: "Printer on floor 3 shows offline", Status: "open", Priority: "high",
	Requester: Person{Name: "Ada Lovelace", Email: "ada@example.com"}, Assignee: "grace@example.com",
	Tags: []string{"hardware", "printing"}, CreatedAt: "2026-10-12T09:14:00Z", UpdatedAt: "2026-10-14T16:02:00Z",
	URL: "https://helpdesk.example.com/tickets/T-1042",
}

const gettingStarted = `# Getting started with Example Helpdesk

Every ticket has an ID like T-1042, a subject, a status and a priority.

## Statuses

- **open**: someone needs to act on it.
- **pending**: waiting for the requester to answer.
- **solved**: fixed. It closes by itself after 7 days.
- **closed**: done for good. A closed ticket can't be reopened; open a new one instead.

## Priorities

low, normal, high and urgent. An urgent ticket pages whoever is on call, so only raise a ticket to urgent when the requester can't work at all.
`

const printerOffline = `# When a printer shows offline

1. Check that the printer is on and its screen shows no error.
2. Print a configuration page from the printer's menu, and check that its IP address starts with 10.3.
3. On your computer, remove the printer and add it again from Settings, then Printers.

Still offline? Open a ticket and include the configuration page.
`

// The JSON Schema every ticket follows, the helpdesk://schemas/ticket resource.
const ticketSchemaJSON = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Ticket",
  "description": "A support request in Example Helpdesk.",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^T-[0-9]+$",
      "description": "T- and a number, such as T-1042. Never reused."
    },
    "subject": {
      "type": "string",
      "description": "One line on what's wrong, in the requester's words."
    },
    "status": {
      "enum": [
        "open",
        "pending",
        "solved",
        "closed"
      ],
      "description": "open: someone needs to act. pending: waiting for the requester. solved: fixed, and closes after 7 days. closed: done for good."
    },
    "priority": {
      "enum": [
        "low",
        "normal",
        "high",
        "urgent"
      ],
      "description": "urgent pages whoever is on call."
    },
    "requester": {
      "type": "object",
      "description": "Who asked for help.",
      "properties": {
        "name": {
          "type": "string"
        },
        "email": {
          "type": "string",
          "format": "email"
        }
      },
      "required": [
        "name",
        "email"
      ]
    },
    "assignee": {
      "type": "string",
      "format": "email",
      "description": "Who's working on it. Absent while it's unassigned."
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Lowercase words and dashes."
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time"
    },
    "url": {
      "type": "string",
      "format": "uri",
      "description": "The ticket in the helpdesk's web app."
    }
  },
  "required": [
    "id",
    "subject",
    "status",
    "priority",
    "requester",
    "tags",
    "createdAt",
    "updatedAt",
    "url"
  ]
}`

// Icons for light and dark backgrounds, as data: URIs so they need no host of their own.
const (
	lightIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMWQ0ZWQ4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4="
	darkIcon  = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTNjNWZkIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4="
)

// New tickets by status over the last 30 days, as a 160×80 PNG.
var volumePNG, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAMAAACpg44GAAAAElBMVEX///8lY+vZdwYWo0prcoCco69dcYm0AAAABnRSTlMA//////96eeD+AAAAWUlEQVR42u3OyQkAIRAAsPHY/lv25cfHgOCCYFJBIgA4riUEBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFHwuWhKCgoKDgVBOCgkuwJwQFBfeC36UC4H8DEoQebf3n2AwAAAAASUVORK5CYII=")
