package com.example.helpdesk;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.TypeRef;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncPromptSpecification;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncResourceSpecification;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncResourceTemplateSpecification;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.transport.HttpServletStatelessServerTransport;
import io.modelcontextprotocol.spec.McpError;
import io.modelcontextprotocol.spec.McpSchema.Annotations;
import io.modelcontextprotocol.spec.McpSchema.BlobResourceContents;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.Content;
import io.modelcontextprotocol.spec.McpSchema.EmbeddedResource;
import io.modelcontextprotocol.spec.McpSchema.GetPromptResult;
import io.modelcontextprotocol.spec.McpSchema.Icon;
import io.modelcontextprotocol.spec.McpSchema.ImageContent;
import io.modelcontextprotocol.spec.McpSchema.Implementation;
import io.modelcontextprotocol.spec.McpSchema.Prompt;
import io.modelcontextprotocol.spec.McpSchema.PromptArgument;
import io.modelcontextprotocol.spec.McpSchema.PromptMessage;
import io.modelcontextprotocol.spec.McpSchema.ReadResourceResult;
import io.modelcontextprotocol.spec.McpSchema.Resource;
import io.modelcontextprotocol.spec.McpSchema.ResourceLink;
import io.modelcontextprotocol.spec.McpSchema.ResourceTemplate;
import io.modelcontextprotocol.spec.McpSchema.Role;
import io.modelcontextprotocol.spec.McpSchema.ServerCapabilities;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.TextResourceContents;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import io.modelcontextprotocol.spec.McpSchema.ToolAnnotations;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;
import org.eclipse.jetty.ee10.servlet.FilterHolder;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

/**
 * Example Helpdesk on the official Java SDK: the server whose replies are in ../../example.json,
 * described as fully as MCP allows and served over Streamable HTTP, so a browser client such as
 * MCP Browser Client can connect to it.
 *
 * <pre>
 *   mvn package && java -jar target/helpdesk.jar    # http://127.0.0.1:8090/mcp; PORT picks another port
 * </pre>
 *
 * <p>What a client shows comes from what's declared here: the server's identity and instructions,
 * each tool's title, description, annotations and schemas, and the resources and prompts. The
 * tickets are canned; a real server would look them up. The Java SDK speaks MCP up to 2025-11-25,
 * so clients connect with the initialize handshake.
 */
public final class HelpdeskServer {

    static final McpJsonMapper JSON = McpJsonDefaults.getMapper();

    static final String INSTRUCTIONS = """
            Example Helpdesk holds the Example company's support tickets. Ticket IDs look like T-1042, and dates are in UTC.

            - To find a ticket, use search_tickets, then get_ticket with its ID. Don't guess IDs.
            - update_ticket changes only the fields you send. Before changing the status or assignee of a ticket the person didn't mention, ask them.
            - delete_ticket can't be undone. Only use it when the person asks to delete a specific ticket; otherwise set its status to closed.
            - For questions about workload or trends, use ticket_volume_chart.
            - helpdesk://guides/getting-started explains what each status and priority means.""";

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8090"));
        // Stateless: each request stands alone, so there are no sessions to keep.
        var transport = HttpServletStatelessServerTransport.builder().jsonMapper(JSON).messageEndpoint("/mcp").build();
        McpServer.sync(transport)
                .serverInfo(Implementation.builder("example-helpdesk", "1.4.0")
                        .title("Example Helpdesk")
                        .description("Search, read and update the support tickets in Example Helpdesk, and chart how many come in.")
                        .websiteUrl("https://helpdesk.example.com/docs/mcp")
                        .icons(List.of(
                                Icon.builder(LIGHT_ICON).mimeType("image/svg+xml").sizes(List.of("any")).theme("light").build(),
                                Icon.builder(DARK_ICON).mimeType("image/svg+xml").sizes(List.of("any")).theme("dark").build(),
                                Icon.builder("https://helpdesk.example.com/icons/helpdesk-48.png").mimeType("image/png").sizes(List.of("48x48")).build()))
                        .build())
                .instructions(INSTRUCTIONS)
                .capabilities(ServerCapabilities.builder().tools(false).resources(false, false).prompts(false).build())
                .tools(tools())
                .resources(resources())
                .resourceTemplates(templates())
                .prompts(prompts())
                .build();

        var context = new ServletContextHandler();
        context.addServlet(new ServletHolder(transport), "/mcp");
        context.addFilter(new FilterHolder(new AllowBrowsers()), "/*", EnumSet.of(DispatcherType.REQUEST));
        var server = new Server(new InetSocketAddress("127.0.0.1", port));
        server.setHandler(context);
        server.start();
        System.out.println("Example Helpdesk (Java SDK) on http://127.0.0.1:" + port + "/mcp");
        server.join();
    }

    // --- Tools ---

    /**
     * Every hint, set explicitly: the protocol's defaults assume a tool may write, may destroy and
     * reaches the outside world.
     */
    static ToolAnnotations hints(boolean readOnly, boolean destructive, boolean idempotent, boolean openWorld) {
        return new ToolAnnotations(null, readOnly, destructive, idempotent, openWorld, null);
    }

    /**
     * A tool, with its schemas as JSON: the Java SDK takes them as written, so every keyword a
     * client reads (descriptions, enums, examples, formats, patterns, ranges, defaults) is there in
     * the order a form lists it.
     */
    static SyncToolSpecification tool(String name, String title, String description, ToolAnnotations hints,
            String inputSchema, String outputSchema, Function<Map<String, Object>, CallToolResult> handler) {
        var tool = Tool.builder().name(name).title(title).description(description).annotations(hints).inputSchema(JSON, inputSchema);
        if (outputSchema != null) {
            tool.outputSchema(JSON, outputSchema);
        }
        return new SyncToolSpecification(tool.build(), (context, request) -> handler.apply(request.arguments()));
    }

    static List<SyncToolSpecification> tools() {
        return List.of(
                tool("search_tickets", "Search tickets",
                        "Finds tickets by words in their subject and messages, most recently updated first. Use it to find a ticket before reading or changing it. Returns each ticket's ID, subject, status, priority and when it last changed, with a link to read the whole ticket. Narrow a long list with status, priority, assignee or updated_after.",
                        hints(true, false, true, false), SEARCH_INPUT, SEARCH_OUTPUT, args -> {
                            var found = Map.of("tickets", MATCHES, "total", MATCHES.size());
                            var content = new ArrayList<Content>(List.of(asText(found)));
                            MATCHES.forEach(ticket -> content.add(ticketLink(ticket)));
                            return CallToolResult.builder().content(content).structuredContent(found).build();
                        }),
                tool("get_ticket", "Get a ticket",
                        "Gets one ticket in full: subject, status, priority, requester, assignee, tags, dates and its address in the web app. Use it when you know the ticket's ID, from search_tickets or from the person; it doesn't search.",
                        hints(true, false, true, false), GET_INPUT, GET_OUTPUT, args -> {
                            if (!"T-1042".equals(args.get("id"))) {
                                // A failure the caller can fix comes back as an isError result that says what to change.
                                return CallToolResult.builder()
                                        .content(List.of(new TextContent("There's no ticket " + args.get("id") + "; search_tickets finds tickets by their words.")))
                                        .isError(true)
                                        .build();
                            }
                            var link = ResourceLink.builder().uri("https://helpdesk.example.com/tickets/T-1042").name("T-1042")
                                    .title("Open T-1042 in Example Helpdesk").mimeType("text/html").build();
                            return CallToolResult.builder().content(List.of(asText(TICKET_1042), link)).structuredContent(TICKET_1042).build();
                        }),
                tool("update_ticket", "Update a ticket",
                        "Changes a ticket's status, priority, assignee or tags. Fields you leave out stay as they are, and sending the same values again changes nothing. Send at least one field besides id.",
                        hints(false, false, true, false), UPDATE_INPUT, null, args -> {
                            var updated = new java.util.LinkedHashMap<>(MATCHES.get(0));
                            updated.put("status", "solved");
                            updated.put("updatedAt", "2026-10-15T09:30:00Z");
                            return CallToolResult.builder()
                                    .content(List.of(new TextContent("Updated T-1042: its status is now solved."), ticketLink(updated)))
                                    .build();
                        }),
                tool("delete_ticket", "Delete a ticket",
                        "Deletes a ticket and its messages for good. Only use it when the person asks to delete that ticket; to stop work on one, set its status to closed with update_ticket instead.",
                        hints(false, true, true, false), DELETE_INPUT, null,
                        args -> CallToolResult.builder().content(List.of(new TextContent("Deleted T-1042 and its 4 messages."))).build()),
                tool("ticket_volume_chart", "Chart ticket volume",
                        "Charts how many tickets came in over the last days, one bar per status or priority, as a PNG image with a one-line summary. Use it for questions about workload and trends.",
                        hints(true, false, true, false), CHART_INPUT, null, args -> CallToolResult.builder()
                                .content(List.of(
                                        // For people to look at; the text says the same for models.
                                        new ImageContent(new Annotations(List.of(Role.USER), null), VOLUME_PNG, "image/png"),
                                        new TextContent("Last 30 days: 214 new tickets. 37 are open, 21 pending, 142 solved and 14 closed.")))
                                .build()),
                tool("fetch_help_article", "Fetch a help center article",
                        "Fetches an article from the public help center at help.example.com, as Markdown. Use it to quote or summarize published help for a requester. It only fetches help.example.com addresses.",
                        hints(true, false, true, true), ARTICLE_INPUT, null, args -> CallToolResult.builder()
                                .content(List.of(
                                        new TextContent(PRINTER_OFFLINE),
                                        ResourceLink.builder().uri("https://help.example.com/articles/printer-offline").name("printer-offline")
                                                .title("When a printer shows offline, in the help center").mimeType("text/html").build()))
                                .build()));
    }

    /** A link to read a ticket as a resource, labelled for people. */
    static ResourceLink ticketLink(Map<String, Object> ticket) {
        return ResourceLink.builder()
                .uri("helpdesk://tickets/" + ticket.get("id"))
                .name((String) ticket.get("id"))
                .title(ticket.get("id") + ": " + ticket.get("subject"))
                .description(ticket.get("status") + ", " + ticket.get("priority") + " priority, updated " + ((String) ticket.get("updatedAt")).substring(0, 10))
                .mimeType("application/json")
                .build();
    }

    /** The same JSON as text: clients and models that only read text get the data too. */
    static TextContent asText(Object value) {
        try {
            return new TextContent(JSON.writeValueAsString(value));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // --- Resources ---

    static Annotations annotations(List<Role> audience, double priority, String lastModified) {
        return new Annotations(audience, priority, lastModified);
    }

    static SyncResourceSpecification resource(Resource resource, Function<String, ReadResourceResult> read) {
        return new SyncResourceSpecification(resource, (context, request) -> read.apply(request.uri()));
    }

    static List<SyncResourceSpecification> resources() {
        int pngBytes = Base64.getDecoder().decode(VOLUME_PNG).length;
        return List.of(
                resource(Resource.builder("helpdesk://guides/getting-started", "getting-started")
                                .title("Getting started")
                                .description("What each ticket status and priority means. Read it before changing tickets.")
                                .mimeType("text/markdown")
                                .size((long) GETTING_STARTED.getBytes(StandardCharsets.UTF_8).length)
                                .annotations(annotations(List.of(Role.USER, Role.ASSISTANT), 0.9, "2026-09-30T12:00:00Z"))
                                .build(),
                        uri -> new ReadResourceResult(List.of(new TextResourceContents(uri, "text/markdown", GETTING_STARTED)))),
                resource(Resource.builder("helpdesk://schemas/ticket", "ticket-schema")
                                .title("Ticket schema")
                                .description("The JSON Schema every ticket follows, with what each field means.")
                                .mimeType("application/schema+json")
                                .size((long) TICKET_SCHEMA_JSON.getBytes(StandardCharsets.UTF_8).length)
                                .annotations(annotations(List.of(Role.ASSISTANT), 0.5, "2026-08-14T08:00:00Z"))
                                .build(),
                        uri -> new ReadResourceResult(List.of(new TextResourceContents(uri, "application/schema+json", TICKET_SCHEMA_JSON)))),
                resource(Resource.builder("helpdesk://reports/volume.png", "volume-chart")
                                .title("Ticket volume, last 30 days")
                                .description("New tickets over the last 30 days, one bar per status. Updated every hour.")
                                .mimeType("image/png")
                                .size((long) pngBytes)
                                .annotations(annotations(List.of(Role.USER), 0.3, "2026-10-15T09:00:00Z"))
                                .build(),
                        uri -> new ReadResourceResult(List.of(new BlobResourceContents(uri, "image/png", VOLUME_PNG)))));
    }

    static List<SyncResourceTemplateSpecification> templates() {
        var template = ResourceTemplate.builder("helpdesk://tickets/{id}", "ticket")
                .title("Ticket by ID")
                // A template's variables have no schema, so the description says what id looks like.
                .description("One ticket as JSON, as get_ticket returns it. id is the ticket's ID, such as T-1042.")
                .mimeType("application/json")
                .build();
        return List.of(new SyncResourceTemplateSpecification(template, (context, request) -> {
            if (!"helpdesk://tickets/T-1042".equals(request.uri())) {
                throw McpError.RESOURCE_NOT_FOUND.apply(request.uri());
            }
            return new ReadResourceResult(List.of(new TextResourceContents(request.uri(), "application/json", asText(TICKET_1042).text())));
        }));
    }

    // --- Prompts ---

    static List<SyncPromptSpecification> prompts() {
        var summarize = new Prompt("summarize_ticket", "Summarize a ticket",
                "Drafts a short summary of a ticket: what's wrong, what's been tried and what's next. For handing a ticket over, or for updating the requester.",
                // Prompt arguments are text without a schema: an example in each description is what a client can fill in.
                List.of(new PromptArgument("id", "The ticket to summarize, such as T-1042.", true),
                        new PromptArgument("audience", "Who reads the summary: either \"agent\" or \"requester\". Defaults to \"agent\".", false)));
        var triage = new Prompt("triage_open_tickets", "Triage the open tickets",
                "Asks for the open tickets in order of urgency, with who should take each one.", List.of());
        return List.of(
                new SyncPromptSpecification(summarize, (context, request) -> new GetPromptResult("A summary of T-1042 for the support team", List.of(
                        new PromptMessage(Role.USER, new TextContent("Summarize this ticket for the support team in three short paragraphs: the problem, what has been tried, and the next step. Keep the requester's own words where you can.")),
                        new PromptMessage(Role.USER, new EmbeddedResource(null,
                                new TextResourceContents("helpdesk://tickets/T-1042", "application/json", asText(TICKET_1042).text())))))),
                new SyncPromptSpecification(triage, (context, request) -> new GetPromptResult("Triage of the open tickets", List.of(
                        new PromptMessage(Role.USER, new TextContent("List the open tickets from most to least urgent. For each, say in one line why it's urgent and who should take it, from the people already working on similar tickets.")),
                        new PromptMessage(Role.ASSISTANT, new TextContent("I'll search the open tickets first, then read the urgent and high-priority ones in full before ordering them."))))));
    }

    // --- Browsers ---

    /**
     * A page calling the server sends its origin and the MCP headers (MCP-Protocol-Version,
     * Mcp-Method, Mcp-Name, Mcp-Param-*, Authorization), so the server lets those through CORS and
     * lets the page read Mcp-Session-Id.
     */
    static final class AllowBrowsers implements Filter {
        static final Pattern ALLOWED = Pattern.compile("http://(localhost|127\\.0\\.0\\.1)(:\\d+)?|https://patrick-glean\\.github\\.io");

        @Override
        public void doFilter(ServletRequest servletRequest, ServletResponse servletResponse, FilterChain chain)
                throws IOException, ServletException {
            var request = (HttpServletRequest) servletRequest;
            var response = (HttpServletResponse) servletResponse;
            String origin = request.getHeader("Origin");
            if (origin != null) {
                if (!ALLOWED.matcher(origin).matches()) {
                    response.sendError(HttpServletResponse.SC_FORBIDDEN, "origin not allowed");
                    return;
                }
                response.setHeader("Access-Control-Allow-Origin", origin);
                response.setHeader("Vary", "Origin");
                response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
            }
            if ("OPTIONS".equals(request.getMethod())) {
                response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
                String requested = request.getHeader("Access-Control-Request-Headers");
                if (requested != null) {
                    response.setHeader("Access-Control-Allow-Headers", requested);
                }
                response.setHeader("Access-Control-Max-Age", "600");
                response.setStatus(HttpServletResponse.SC_NO_CONTENT);
                return;
            }
            chain.doFilter(servletRequest, servletResponse);
        }
    }

    // --- Schemas ---

    static final String SEARCH_INPUT = """
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
            }""";

    static final String SEARCH_OUTPUT = """
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
            }""";

    static final String GET_INPUT = """
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
            }""";

    static final String GET_OUTPUT = """
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
            }""";

    static final String UPDATE_INPUT = """
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
            }""";

    static final String DELETE_INPUT = """
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
            }""";

    static final String CHART_INPUT = """
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
            }""";

    static final String ARTICLE_INPUT = """
            {
              "type": "object",
              "properties": {
                "url": {
                  "type": "string",
                  "format": "uri",
                  "pattern": "^https://help\\\\.example\\\\.com/",
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
            }""";

    // --- Canned data ---

    static Map<String, Object> parse(String json) {
        try {
            return JSON.readValue(json, new TypeRef<Map<String, Object>>() {});
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static final List<Map<String, Object>> MATCHES = List.of(
            parse("""
                    {"id": "T-1042", "subject": "Printer on floor 3 shows offline", "status": "open", "priority": "high", "updatedAt": "2026-10-14T16:02:00Z"}"""),
            parse("""
                    {"id": "T-1038", "subject": "Printer driver won't install on macOS 16", "status": "pending", "priority": "normal", "updatedAt": "2026-10-13T11:40:00Z"}"""),
            parse("""
                    {"id": "T-1017", "subject": "Badge printer jams on the first card", "status": "solved", "priority": "low", "updatedAt": "2026-10-09T08:05:00Z"}"""));

    static final Map<String, Object> TICKET_1042 = parse("""
            {
              "id": "T-1042",
              "subject": "Printer on floor 3 shows offline",
              "status": "open",
              "priority": "high",
              "requester": {"name": "Ada Lovelace", "email": "ada@example.com"},
              "assignee": "grace@example.com",
              "tags": ["hardware", "printing"],
              "createdAt": "2026-10-12T09:14:00Z",
              "updatedAt": "2026-10-14T16:02:00Z",
              "url": "https://helpdesk.example.com/tickets/T-1042"
            }""");

    static final String GETTING_STARTED = """
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

    static final String PRINTER_OFFLINE = """
            # When a printer shows offline

            1. Check that the printer is on and its screen shows no error.
            2. Print a configuration page from the printer's menu, and check that its IP address starts with 10.3.
            3. On your computer, remove the printer and add it again from Settings, then Printers.

            Still offline? Open a ticket and include the configuration page.
            """;

    /** The JSON Schema every ticket follows, the helpdesk://schemas/ticket resource. */
    static final String TICKET_SCHEMA_JSON = """
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
            }""";

    /** Icons for light and dark backgrounds, as data: URIs so they need no host of their own. */
    static final String LIGHT_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMWQ0ZWQ4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=";
    static final String DARK_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTNjNWZkIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=";

    /** New tickets by status over the last 30 days, as a 160×80 PNG. */
    static final String VOLUME_PNG = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAMAAACpg44GAAAAElBMVEX///8lY+vZdwYWo0prcoCco69dcYm0AAAABnRSTlMA//////96eeD+AAAAWUlEQVR42u3OyQkAIRAAsPHY/lv25cfHgOCCYFJBIgA4riUEBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFHwuWhKCgoKDgVBOCgkuwJwQFBfeC36UC4H8DEoQebf3n2AwAAAAASUVORK5CYII=";

    private HelpdeskServer() {
    }
}
