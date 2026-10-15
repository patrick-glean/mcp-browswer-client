// Example Helpdesk on the official C# SDK: the server whose replies are in ../../example.json,
// described as fully as MCP allows and served over Streamable HTTP, so a browser client such as
// MCP Browser Client can connect to it.
//
//     dotnet run    # http://127.0.0.1:8090/mcp; PORT picks another port
//
// What a client shows comes from what's declared here: the server's identity and instructions,
// each tool's title, description, annotations and schemas, and the resources and prompts. The
// tickets are canned; a real server would look them up.

using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;

var port = Environment.GetEnvironmentVariable("PORT") ?? "8090";
var builder = WebApplication.CreateBuilder(args);
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");

// A page calling the server sends its origin and the MCP headers (MCP-Protocol-Version,
// Mcp-Method, Mcp-Name, Mcp-Param-*, Authorization), so the server lets those through CORS and lets
// the page read Mcp-Session-Id. AllowAnyHeader answers a preflight with the headers it asked for.
builder.Services.AddCors(cors => cors.AddDefaultPolicy(policy => policy
    .SetIsOriginAllowed(Helpdesk.IsAllowedOrigin)
    .AllowAnyHeader()
    .WithMethods("GET", "POST", "DELETE", "OPTIONS")
    .WithExposedHeaders("Mcp-Session-Id")));

builder.Services
    .AddMcpServer(options =>
    {
        options.ServerInfo = new Implementation
        {
            Name = "example-helpdesk",
            Title = "Example Helpdesk",
            Version = "1.4.0",
            Description = "Search, read and update the support tickets in Example Helpdesk, and chart how many come in.",
            WebsiteUrl = "https://helpdesk.example.com/docs/mcp",
            Icons =
            [
                new Icon { Source = Helpdesk.LightIcon, MimeType = "image/svg+xml", Sizes = ["any"], Theme = "light" },
                new Icon { Source = Helpdesk.DarkIcon, MimeType = "image/svg+xml", Sizes = ["any"], Theme = "dark" },
                new Icon { Source = "https://helpdesk.example.com/icons/helpdesk-48.png", MimeType = "image/png", Sizes = ["48x48"] },
            ],
        };
        options.ServerInstructions = Helpdesk.Instructions;
        options.Capabilities = new ServerCapabilities { Tools = new(), Resources = new(), Prompts = new() };
    })
    // Stateless: each request stands alone, which suits 2026-07-28 and still answers 2025 clients.
    .WithHttpTransport(transport => transport.Stateless = true)
    // The handlers return the protocol's own objects, so every field is as declared here,
    // schemas included.
    .WithListToolsHandler((request, cancellationToken) => ValueTask.FromResult(new ListToolsResult
    {
        Tools = Helpdesk.Tools,
        TimeToLive = TimeSpan.FromMinutes(10),
        CacheScope = CacheScope.Public,
    }))
    .WithCallToolHandler((request, cancellationToken) => ValueTask.FromResult(Helpdesk.Call(request.Params!.Name)))
    .WithListResourcesHandler((request, cancellationToken) => ValueTask.FromResult(new ListResourcesResult
    {
        Resources = Helpdesk.Resources,
        TimeToLive = TimeSpan.FromMinutes(10),
        CacheScope = CacheScope.Public,
    }))
    .WithListResourceTemplatesHandler((request, cancellationToken) => ValueTask.FromResult(new ListResourceTemplatesResult
    {
        ResourceTemplates = Helpdesk.Templates,
        TimeToLive = TimeSpan.FromMinutes(10),
        CacheScope = CacheScope.Public,
    }))
    .WithReadResourceHandler((request, cancellationToken) => ValueTask.FromResult(Helpdesk.Read(request.Params!.Uri)))
    .WithListPromptsHandler((request, cancellationToken) => ValueTask.FromResult(new ListPromptsResult
    {
        Prompts = Helpdesk.Prompts,
        TimeToLive = TimeSpan.FromMinutes(10),
        CacheScope = CacheScope.Public,
    }))
    .WithGetPromptHandler((request, cancellationToken) => ValueTask.FromResult(Helpdesk.GetPrompt(request.Params!.Name)));

var app = builder.Build();
app.UseCors();
app.MapMcp("/mcp");
Console.WriteLine($"Example Helpdesk (C# SDK) on http://127.0.0.1:{port}/mcp");
app.Run();

static partial class Helpdesk
{
    public const string Instructions = """
        Example Helpdesk holds the Example company's support tickets. Ticket IDs look like T-1042, and dates are in UTC.

        - To find a ticket, use search_tickets, then get_ticket with its ID. Don't guess IDs.
        - update_ticket changes only the fields you send. Before changing the status or assignee of a ticket the person didn't mention, ask them.
        - delete_ticket can't be undone. Only use it when the person asks to delete a specific ticket; otherwise set its status to closed.
        - For questions about workload or trends, use ticket_volume_chart.
        - helpdesk://guides/getting-started explains what each status and priority means.
        """;

    public static bool IsAllowedOrigin(string origin) => AllowedOrigin().IsMatch(origin);

    [GeneratedRegex(@"^(http://(localhost|127\.0\.0\.1)(:\d+)?|https://patrick-glean\.github\.io)$")]
    private static partial Regex AllowedOrigin();

    // --- Tools ---

    // Every hint, set explicitly: the protocol's defaults assume a tool may write, may destroy and
    // reaches the outside world.
    static ToolAnnotations Hints(bool readOnly, bool destructive, bool idempotent, bool openWorld) =>
        new() { ReadOnlyHint = readOnly, DestructiveHint = destructive, IdempotentHint = idempotent, OpenWorldHint = openWorld };

    static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();

    public static readonly List<Tool> Tools =
    [
        new()
        {
            Name = "search_tickets",
            Title = "Search tickets",
            Description = "Finds tickets by words in their subject and messages, most recently updated first. Use it to find a ticket before reading or changing it. Returns each ticket's ID, subject, status, priority and when it last changed, with a link to read the whole ticket. Narrow a long list with status, priority, assignee or updated_after.",
            Annotations = Hints(true, false, true, false),
            InputSchema = Json(SearchInput),
            OutputSchema = Json(SearchOutput),
        },
        new()
        {
            Name = "get_ticket",
            Title = "Get a ticket",
            Description = "Gets one ticket in full: subject, status, priority, requester, assignee, tags, dates and its address in the web app. Use it when you know the ticket's ID, from search_tickets or from the person; it doesn't search.",
            Annotations = Hints(true, false, true, false),
            InputSchema = Json(GetInput),
            OutputSchema = Json(GetOutput),
        },
        new()
        {
            Name = "update_ticket",
            Title = "Update a ticket",
            Description = "Changes a ticket's status, priority, assignee or tags. Fields you leave out stay as they are, and sending the same values again changes nothing. Send at least one field besides id.",
            Annotations = Hints(false, false, true, false),
            InputSchema = Json(UpdateInput),
        },
        new()
        {
            Name = "delete_ticket",
            Title = "Delete a ticket",
            Description = "Deletes a ticket and its messages for good. Only use it when the person asks to delete that ticket; to stop work on one, set its status to closed with update_ticket instead.",
            Annotations = Hints(false, true, true, false),
            InputSchema = Json(DeleteInput),
        },
        new()
        {
            Name = "ticket_volume_chart",
            Title = "Chart ticket volume",
            Description = "Charts how many tickets came in over the last days, one bar per status or priority, as a PNG image with a one-line summary. Use it for questions about workload and trends.",
            Annotations = Hints(true, false, true, false),
            InputSchema = Json(ChartInput),
        },
        new()
        {
            Name = "fetch_help_article",
            Title = "Fetch a help center article",
            Description = "Fetches an article from the public help center at help.example.com, as Markdown. Use it to quote or summarize published help for a requester. It only fetches help.example.com addresses.",
            Annotations = Hints(true, false, true, true),
            InputSchema = Json(ArticleInput),
        },
    ];

    // A link to read a ticket as a resource, labelled for people.
    static ResourceLinkBlock TicketLink(JsonElement ticket)
    {
        string Field(string name) => ticket.GetProperty(name).GetString()!;
        return new ResourceLinkBlock
        {
            Uri = $"helpdesk://tickets/{Field("id")}",
            Name = Field("id"),
            Title = $"{Field("id")}: {Field("subject")}",
            Description = $"{Field("status")}, {Field("priority")} priority, updated {Field("updatedAt")[..10]}",
            MimeType = "application/json",
        };
    }

    public static CallToolResult Call(string name)
    {
        switch (name)
        {
            case "search_tickets":
            {
                var found = Json($$"""{"tickets": {{Matches}}, "total": 3}""");
                // The same JSON as text: clients and models that only read text get the data too.
                List<ContentBlock> content = [new TextContentBlock { Text = found.GetRawText() }];
                content.AddRange(Json(Matches).EnumerateArray().Select(TicketLink));
                return new CallToolResult { Content = content, StructuredContent = found };
            }
            case "get_ticket":
                return new CallToolResult
                {
                    Content =
                    [
                        new TextContentBlock { Text = Ticket1042 },
                        new ResourceLinkBlock { Uri = "https://helpdesk.example.com/tickets/T-1042", Name = "T-1042", Title = "Open T-1042 in Example Helpdesk", MimeType = "text/html" },
                    ],
                    StructuredContent = Json(Ticket1042),
                };
            case "update_ticket":
            {
                var updated = Json("""{"id": "T-1042", "subject": "Printer on floor 3 shows offline", "status": "solved", "priority": "high", "updatedAt": "2026-10-15T09:30:00Z"}""");
                return new CallToolResult { Content = [new TextContentBlock { Text = "Updated T-1042: its status is now solved." }, TicketLink(updated)] };
            }
            case "delete_ticket":
                return new CallToolResult { Content = [new TextContentBlock { Text = "Deleted T-1042 and its 4 messages." }] };
            case "ticket_volume_chart":
                return new CallToolResult
                {
                    Content =
                    [
                        Chart(),
                        new TextContentBlock { Text = "Last 30 days: 214 new tickets. 37 are open, 21 pending, 142 solved and 14 closed." },
                    ],
                };
            case "fetch_help_article":
                return new CallToolResult
                {
                    Content =
                    [
                        new TextContentBlock { Text = PrinterOffline },
                        new ResourceLinkBlock { Uri = "https://help.example.com/articles/printer-offline", Name = "printer-offline", Title = "When a printer shows offline, in the help center", MimeType = "text/html" },
                    ],
                };
            default:
                throw new McpProtocolException($"There's no tool {name}", McpErrorCode.InvalidParams);
        }
    }

    // For people to look at; the text beside it says the same for models.
    static ImageContentBlock Chart()
    {
        var chart = ImageContentBlock.FromBytes(Convert.FromBase64String(VolumePng), "image/png");
        chart.Annotations = new Annotations { Audience = [Role.User] };
        return chart;
    }

    // --- Resources ---

    static Annotations Annotate(List<Role> audience, float priority, string lastModified) =>
        new() { Audience = audience, Priority = priority, LastModified = DateTimeOffset.Parse(lastModified) };

    public static readonly List<Resource> Resources =
    [
        new()
        {
            Uri = "helpdesk://guides/getting-started",
            Name = "getting-started",
            Title = "Getting started",
            Description = "What each ticket status and priority means. Read it before changing tickets.",
            MimeType = "text/markdown",
            Size = Encoding.UTF8.GetByteCount(GettingStarted),
            Annotations = Annotate([Role.User, Role.Assistant], 0.9f, "2026-09-30T12:00:00Z"),
        },
        new()
        {
            Uri = "helpdesk://schemas/ticket",
            Name = "ticket-schema",
            Title = "Ticket schema",
            Description = "The JSON Schema every ticket follows, with what each field means.",
            MimeType = "application/schema+json",
            Size = Encoding.UTF8.GetByteCount(TicketSchemaJson),
            Annotations = Annotate([Role.Assistant], 0.5f, "2026-08-14T08:00:00Z"),
        },
        new()
        {
            Uri = "helpdesk://reports/volume.png",
            Name = "volume-chart",
            Title = "Ticket volume, last 30 days",
            Description = "New tickets over the last 30 days, one bar per status. Updated every hour.",
            MimeType = "image/png",
            Size = Convert.FromBase64String(VolumePng).Length,
            Annotations = Annotate([Role.User], 0.3f, "2026-10-15T09:00:00Z"),
        },
    ];

    public static readonly List<ResourceTemplate> Templates =
    [
        new()
        {
            UriTemplate = "helpdesk://tickets/{id}",
            Name = "ticket",
            Title = "Ticket by ID",
            // A template's variables have no schema, so the description says what id looks like.
            Description = "One ticket as JSON, as get_ticket returns it. id is the ticket's ID, such as T-1042.",
            MimeType = "application/json",
        },
    ];

    // How long clients may reuse each read, and whether they may share it: the guide and schema
    // are the same for everyone; tickets and reports are this person's.
    public static ReadResourceResult Read(string uri) => uri switch
    {
        "helpdesk://guides/getting-started" => Text(uri, "text/markdown", GettingStarted, TimeSpan.FromHours(1), CacheScope.Public),
        "helpdesk://schemas/ticket" => Text(uri, "application/schema+json", TicketSchemaJson, TimeSpan.FromDays(1), CacheScope.Public),
        "helpdesk://reports/volume.png" => new ReadResourceResult
        {
            Contents = [BlobResourceContents.FromBytes(Convert.FromBase64String(VolumePng), uri, "image/png")],
            TimeToLive = TimeSpan.FromHours(1),
            CacheScope = CacheScope.Private,
        },
        "helpdesk://tickets/T-1042" => Text(uri, "application/json", Ticket1042, TimeSpan.Zero, CacheScope.Private),
        _ => throw new McpProtocolException($"There's no resource {uri}", McpErrorCode.ResourceNotFound),
    };

    static ReadResourceResult Text(string uri, string mimeType, string text, TimeSpan timeToLive, CacheScope scope) => new()
    {
        Contents = [new TextResourceContents { Uri = uri, MimeType = mimeType, Text = text }],
        TimeToLive = timeToLive,
        CacheScope = scope,
    };

    // --- Prompts ---

    public static readonly List<Prompt> Prompts =
    [
        new()
        {
            Name = "summarize_ticket",
            Title = "Summarize a ticket",
            Description = "Drafts a short summary of a ticket: what's wrong, what's been tried and what's next. For handing a ticket over, or for updating the requester.",
            // Prompt arguments are text without a schema: an example in each description is what a
            // client can fill in.
            Arguments =
            [
                new PromptArgument { Name = "id", Description = "The ticket to summarize, such as T-1042.", Required = true },
                new PromptArgument { Name = "audience", Description = "Who reads the summary: either \"agent\" or \"requester\". Defaults to \"agent\".", Required = false },
            ],
        },
        new()
        {
            Name = "triage_open_tickets",
            Title = "Triage the open tickets",
            Description = "Asks for the open tickets in order of urgency, with who should take each one.",
        },
    ];

    public static GetPromptResult GetPrompt(string name) => name switch
    {
        "summarize_ticket" => new GetPromptResult
        {
            Description = "A summary of T-1042 for the support team",
            Messages =
            [
                new PromptMessage { Role = Role.User, Content = new TextContentBlock { Text = "Summarize this ticket for the support team in three short paragraphs: the problem, what has been tried, and the next step. Keep the requester's own words where you can." } },
                new PromptMessage { Role = Role.User, Content = new EmbeddedResourceBlock { Resource = new TextResourceContents { Uri = "helpdesk://tickets/T-1042", MimeType = "application/json", Text = Ticket1042 } } },
            ],
        },
        "triage_open_tickets" => new GetPromptResult
        {
            Description = "Triage of the open tickets",
            Messages =
            [
                new PromptMessage { Role = Role.User, Content = new TextContentBlock { Text = "List the open tickets from most to least urgent. For each, say in one line why it's urgent and who should take it, from the people already working on similar tickets." } },
                new PromptMessage { Role = Role.Assistant, Content = new TextContentBlock { Text = "I'll search the open tickets first, then read the urgent and high-priority ones in full before ordering them." } },
            ],
        },
        _ => throw new McpProtocolException($"There's no prompt {name}", McpErrorCode.InvalidParams),
    };
}

// --- Schemas and canned data ---

static partial class Helpdesk
{
    const string SearchInput = """
        {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "minLength": 1,
              "description": "Words to look for in the subject and messages.",
              "examples": [
                "printer offline"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "open",
                "pending",
                "solved",
                "closed"
              ],
              "description": "Only tickets with this status."
            },
            "priority": {
              "type": "string",
              "enum": [
                "low",
                "normal",
                "high",
                "urgent"
              ],
              "description": "Only tickets with this priority."
            },
            "assignee": {
              "type": "string",
              "format": "email",
              "description": "Only tickets assigned to this person, by email address.",
              "examples": [
                "grace@example.com"
              ]
            },
            "updated_after": {
              "type": "string",
              "format": "date",
              "description": "Only tickets updated on or after this day (UTC), as YYYY-MM-DD.",
              "examples": [
                "2026-10-01"
              ]
            },
            "limit": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50,
              "default": 10,
              "description": "How many tickets to return at most."
            },
            "cursor": {
              "type": "string",
              "description": "nextCursor from an earlier response, for the next page."
            }
          },
          "required": [
            "query"
          ],
          "additionalProperties": false
        }
        """;

    const string SearchOutput = """
        {
          "type": "object",
          "properties": {
            "tickets": {
              "type": "array",
              "description": "The tickets found, most recently updated first.",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "subject": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "open",
                      "pending",
                      "solved",
                      "closed"
                    ]
                  },
                  "priority": {
                    "type": "string",
                    "enum": [
                      "low",
                      "normal",
                      "high",
                      "urgent"
                    ]
                  },
                  "updatedAt": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "id",
                  "subject",
                  "status",
                  "priority",
                  "updatedAt"
                ]
              }
            },
            "total": {
              "type": "integer",
              "description": "How many tickets match, on every page."
            },
            "nextCursor": {
              "type": "string",
              "description": "Send as cursor for the next page. Absent on the last page."
            }
          },
          "required": [
            "tickets",
            "total"
          ]
        }
        """;

    const string GetInput = """
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^T-[0-9]+$",
              "description": "The ticket's ID: T- and a number.",
              "examples": [
                "T-1042"
              ]
            }
          },
          "required": [
            "id"
          ],
          "additionalProperties": false
        }
        """;

    const string GetOutput = """
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "The ticket's ID."
            },
            "subject": {
              "type": "string",
              "description": "One line on what's wrong."
            },
            "status": {
              "type": "string",
              "enum": [
                "open",
                "pending",
                "solved",
                "closed"
              ]
            },
            "priority": {
              "type": "string",
              "enum": [
                "low",
                "normal",
                "high",
                "urgent"
              ]
            },
            "requester": {
              "type": "object",
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
              }
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
        }
        """;

    const string UpdateInput = """
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^T-[0-9]+$",
              "description": "The ticket's ID: T- and a number.",
              "examples": [
                "T-1042"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "open",
                "pending",
                "solved",
                "closed"
              ],
              "description": "The new status."
            },
            "priority": {
              "type": "string",
              "enum": [
                "low",
                "normal",
                "high",
                "urgent"
              ],
              "description": "The new priority."
            },
            "assignee": {
              "type": "string",
              "format": "email",
              "description": "Who to assign it to, by email address.",
              "examples": [
                "grace@example.com"
              ]
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z0-9-]+$"
              },
              "uniqueItems": true,
              "description": "The ticket's tags, replacing the ones it has: lowercase words and dashes.",
              "examples": [
                [
                  "hardware",
                  "printing"
                ]
              ]
            }
          },
          "required": [
            "id"
          ],
          "additionalProperties": false
        }
        """;

    const string DeleteInput = """
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^T-[0-9]+$",
              "description": "The ticket's ID: T- and a number.",
              "examples": [
                "T-1042"
              ]
            },
            "reason": {
              "type": "string",
              "maxLength": 500,
              "description": "Why it's being deleted, kept in the audit log.",
              "examples": [
                "Duplicate of T-1038"
              ]
            }
          },
          "required": [
            "id"
          ],
          "additionalProperties": false
        }
        """;

    const string ChartInput = """
        {
          "type": "object",
          "properties": {
            "days": {
              "type": "integer",
              "minimum": 7,
              "maximum": 90,
              "default": 30,
              "description": "How many days to chart, ending today."
            },
            "group_by": {
              "type": "string",
              "enum": [
                "status",
                "priority"
              ],
              "default": "status",
              "description": "What each bar counts."
            }
          },
          "additionalProperties": false
        }
        """;

    const string ArticleInput = """
        {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "format": "uri",
              "pattern": "^https://help\\.example\\.com/",
              "description": "The article's address on help.example.com.",
              "examples": [
                "https://help.example.com/articles/printer-offline"
              ]
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": false
        }
        """;

    const string Matches = """
        [
          {"id": "T-1042", "subject": "Printer on floor 3 shows offline", "status": "open", "priority": "high", "updatedAt": "2026-10-14T16:02:00Z"},
          {"id": "T-1038", "subject": "Printer driver won't install on macOS 16", "status": "pending", "priority": "normal", "updatedAt": "2026-10-13T11:40:00Z"},
          {"id": "T-1017", "subject": "Badge printer jams on the first card", "status": "solved", "priority": "low", "updatedAt": "2026-10-09T08:05:00Z"}
        ]
        """;

    const string Ticket1042 = """
        {"id": "T-1042", "subject": "Printer on floor 3 shows offline", "status": "open", "priority": "high", "requester": {"name": "Ada Lovelace", "email": "ada@example.com"}, "assignee": "grace@example.com", "tags": ["hardware", "printing"], "createdAt": "2026-10-12T09:14:00Z", "updatedAt": "2026-10-14T16:02:00Z", "url": "https://helpdesk.example.com/tickets/T-1042"}
        """;

    const string GettingStarted = """
        # Getting started with Example Helpdesk

        Every ticket has an ID like T-1042, a subject, a status and a priority.

        ## Statuses

        - **open**: someone needs to act on it.
        - **pending**: waiting for the requester to answer.
        - **solved**: fixed. It closes by itself after 7 days.
        - **closed**: done for good. A closed ticket can't be reopened; open a new one instead.

        ## Priorities

        low, normal, high and urgent. An urgent ticket pages whoever is on call, so only raise a ticket to urgent when the requester can't work at all.

        """;

    const string PrinterOffline = """
        # When a printer shows offline

        1. Check that the printer is on and its screen shows no error.
        2. Print a configuration page from the printer's menu, and check that its IP address starts with 10.3.
        3. On your computer, remove the printer and add it again from Settings, then Printers.

        Still offline? Open a ticket and include the configuration page.

        """;

    // The JSON Schema every ticket follows, the helpdesk://schemas/ticket resource.
    const string TicketSchemaJson = """
        {
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
        }
        """;

    // Icons for light and dark backgrounds, as data: URIs so they need no host of their own.
    public const string LightIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMWQ0ZWQ4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=";
    public const string DarkIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTNjNWZkIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=";

    // New tickets by status over the last 30 days, as a 160×80 PNG.
    const string VolumePng = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAMAAACpg44GAAAAElBMVEX///8lY+vZdwYWo0prcoCco69dcYm0AAAABnRSTlMA//////96eeD+AAAAWUlEQVR42u3OyQkAIRAAsPHY/lv25cfHgOCCYFJBIgA4riUEBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFHwuWhKCgoKDgVBOCgkuwJwQFBfeC36UC4H8DEoQebf3n2AwAAAAASUVORK5CYII=";
}
