//! Example Helpdesk on the official Rust SDK (rmcp): the server whose replies are in
//! ../../example.json, described as fully as MCP allows and served over Streamable HTTP, so a
//! browser client such as MCP Browser Client can connect to it.
//!
//!     cargo run    # http://127.0.0.1:8090/mcp; PORT picks another port
//!
//! What a client shows comes from what's declared here: the server's identity and instructions,
//! each tool's title, description, annotations and schemas, and the resources and prompts. The
//! tickets are canned; a real server would look them up.

#![allow(dead_code, reason = "the canned tools don't read their arguments")]

use axum::http::{HeaderName, HeaderValue, Method};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{common::schema_for_type, router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};

const INSTRUCTIONS: &str = "Example Helpdesk holds the Example company's support tickets. Ticket IDs look like T-1042, and dates are in UTC.

- To find a ticket, use search_tickets, then get_ticket with its ID. Don't guess IDs.
- update_ticket changes only the fields you send. Before changing the status or assignee of a ticket the person didn't mention, ask them.
- delete_ticket can't be undone. Only use it when the person asks to delete a specific ticket; otherwise set its status to closed.
- For questions about workload or trends, use ticket_volume_chart.
- helpdesk://guides/getting-started explains what each status and priority means.";

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8090".into());
    // Stateless with JSON replies: each request stands alone, which suits 2026-07-28 and still
    // answers 2025 clients' initialize. rmcp checks Host and Origin itself, so the deployed
    // client's origin is allowed as well as local pages.
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_allowed_origins([
            "http://localhost:*",
            "http://127.0.0.1:*",
            "https://patrick-glean.github.io",
        ]);
    let service: StreamableHttpService<Helpdesk, LocalSessionManager> =
        StreamableHttpService::new(|| Ok(Helpdesk::new()), Default::default(), config);
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(allow_browsers());
    let address = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("Example Helpdesk (Rust SDK) on http://{address}/mcp");
    axum::serve(listener, app).await
}

// A page calling the server sends its origin and the MCP headers (MCP-Protocol-Version,
// Mcp-Method, Mcp-Name, Mcp-Param-*, Authorization), so the server lets those through CORS and
// lets the page read Mcp-Session-Id.
fn allow_browsers() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            let origin = origin.to_str().unwrap_or("");
            origin == "https://patrick-glean.github.io"
                || ["http://localhost", "http://127.0.0.1"]
                    .iter()
                    .any(|local| {
                        origin == *local
                            || origin
                                .strip_prefix(local)
                                .is_some_and(|port| port.starts_with(':'))
                    })
        }))
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(AllowHeaders::mirror_request())
        .expose_headers([HeaderName::from_static("mcp-session-id")])
}

// --- Schemas ---

/// How schemars' schemas read in a client's form. An optional field is an `Option`, which
/// schemars writes as "string or null" with a default of null; it's optional because it isn't
/// required, so it's shown as its own type. And integers lose Rust's own formats (int32, uint32).
fn as_form(schema: &mut Schema) {
    let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else {
        return;
    };
    for property in properties.values_mut() {
        let Some(property) = property.as_object_mut() else {
            continue;
        };
        if let Some(Value::Array(types)) = property.get_mut("type") {
            types.retain(|kind| kind != "null");
            if types.len() == 1 {
                let only = types.remove(0);
                property.insert("type".into(), only);
            }
        }
        if let Some(Value::Array(values)) = property.get_mut("enum") {
            values.retain(|value| !value.is_null());
        }
        if let Some(Value::Array(choices)) = property.remove("anyOf") {
            let mut rest: Vec<Value> = choices
                .into_iter()
                .filter(|choice| choice.get("type") != Some(&json!("null")))
                .collect();
            match (rest.len(), rest.first_mut().and_then(Value::as_object_mut)) {
                (1, Some(only)) => {
                    for (key, value) in std::mem::take(only) {
                        property.entry(key).or_insert(value);
                    }
                }
                _ => {
                    property.insert("anyOf".into(), Value::Array(rest));
                }
            }
        }
        if property.get("default") == Some(&Value::Null) {
            property.remove("default");
        }
        if property.get("type") == Some(&json!("integer")) {
            property.remove("format");
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
enum Status {
    Open,
    Pending,
    Solved,
    Closed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
enum Priority {
    Low,
    Normal,
    High,
    Urgent,
}

// Serialize too: schemars writes a field's default only when it can serialize it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
enum GroupBy {
    Status,
    Priority,
}

// Doc comments are the descriptions; schemars attributes add the rest.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = as_form)]
struct SearchArgs {
    /// Words to look for in the subject and messages.
    #[schemars(length(min = 1), extend("examples" = ["printer offline"]))]
    query: String,
    /// Only tickets with this status.
    #[serde(default)]
    status: Option<Status>,
    /// Only tickets with this priority.
    #[serde(default)]
    priority: Option<Priority>,
    /// Only tickets assigned to this person, by email address.
    #[serde(default)]
    #[schemars(email, extend("examples" = ["grace@example.com"]))]
    assignee: Option<String>,
    /// Only tickets updated on or after this day (UTC), as YYYY-MM-DD.
    #[serde(default)]
    #[schemars(extend("format" = "date", "examples" = ["2026-10-01"]))]
    updated_after: Option<String>,
    /// How many tickets to return at most.
    #[serde(default = "ten")]
    #[schemars(range(min = 1, max = 50))]
    limit: u32,
    /// nextCursor from an earlier response, for the next page.
    #[serde(default)]
    cursor: Option<String>,
}

fn ten() -> u32 {
    10
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = as_form)]
struct TicketArgs {
    /// The ticket's ID: T- and a number.
    #[schemars(regex(pattern = r"^T-[0-9]+$"), extend("examples" = ["T-1042"]))]
    id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = as_form)]
struct UpdateArgs {
    /// The ticket's ID: T- and a number.
    #[schemars(regex(pattern = r"^T-[0-9]+$"), extend("examples" = ["T-1042"]))]
    id: String,
    /// The new status.
    #[serde(default)]
    status: Option<Status>,
    /// The new priority.
    #[serde(default)]
    priority: Option<Priority>,
    /// Who to assign it to, by email address.
    #[serde(default)]
    #[schemars(email, extend("examples" = ["grace@example.com"]))]
    assignee: Option<String>,
    /// The ticket's tags, replacing the ones it has: lowercase words and dashes.
    #[serde(default)]
    #[schemars(inner(regex(pattern = r"^[a-z0-9-]+$")), extend("uniqueItems" = true, "examples" = [["hardware", "printing"]]))]
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = as_form)]
struct DeleteArgs {
    /// The ticket's ID: T- and a number.
    #[schemars(regex(pattern = r"^T-[0-9]+$"), extend("examples" = ["T-1042"]))]
    id: String,
    /// Why it's being deleted, kept in the audit log.
    #[serde(default)]
    #[schemars(length(max = 500), extend("examples" = ["Duplicate of T-1038"]))]
    reason: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = as_form)]
struct ChartArgs {
    /// How many days to chart, ending today.
    #[serde(default = "thirty")]
    #[schemars(range(min = 7, max = 90))]
    days: u32,
    /// What each bar counts.
    #[serde(default = "by_status")]
    group_by: GroupBy,
}

fn thirty() -> u32 {
    30
}

fn by_status() -> GroupBy {
    GroupBy::Status
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = as_form)]
struct ArticleArgs {
    /// The article's address on help.example.com.
    #[schemars(regex(pattern = r"^https://help\.example\.com/"), extend("format" = "uri", "examples" = ["https://help.example.com/articles/printer-offline"]))]
    url: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TicketSummary {
    id: &'static str,
    subject: &'static str,
    status: Status,
    priority: Priority,
    #[schemars(extend("format" = "date-time"))]
    updated_at: &'static str,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = as_form)]
struct SearchResult {
    /// The tickets found, most recently updated first.
    tickets: Vec<TicketSummary>,
    /// How many tickets match, on every page.
    total: usize,
    /// Send as cursor for the next page. Absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
struct Person {
    name: &'static str,
    #[schemars(email)]
    email: &'static str,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = as_form)]
struct Ticket {
    /// The ticket's ID.
    id: &'static str,
    /// One line on what's wrong.
    subject: &'static str,
    status: Status,
    priority: Priority,
    requester: Person,
    /// Who's working on it. Absent while it's unassigned.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(email)]
    assignee: Option<&'static str>,
    tags: Vec<&'static str>,
    #[schemars(extend("format" = "date-time"))]
    created_at: &'static str,
    #[schemars(extend("format" = "date-time"))]
    updated_at: &'static str,
    /// The ticket in the helpdesk's web app.
    #[schemars(url)]
    url: &'static str,
}

// --- The server ---

#[derive(Clone)]
struct Helpdesk {
    tool_router: ToolRouter<Self>,
}

/// A link to read a ticket as a resource, labelled for people.
fn ticket_link(ticket: &TicketSummary) -> ContentBlock {
    let status = serde_json::to_value(ticket.status).unwrap_or_default();
    let priority = serde_json::to_value(ticket.priority).unwrap_or_default();
    ContentBlock::resource_link(
        Resource::new(format!("helpdesk://tickets/{}", ticket.id), ticket.id)
            .with_title(format!("{}: {}", ticket.id, ticket.subject))
            .with_description(format!(
                "{}, {} priority, updated {}",
                status.as_str().unwrap_or(""),
                priority.as_str().unwrap_or(""),
                &ticket.updated_at[..10]
            ))
            .with_mime_type("application/json"),
    )
}

/// The same JSON as text: clients and models that only read text get the data too.
fn as_text(value: &impl Serialize) -> ContentBlock {
    ContentBlock::text(serde_json::to_string(value).unwrap_or_default())
}

fn structured(content: Vec<ContentBlock>, value: &impl Serialize) -> CallToolResult {
    let mut result = CallToolResult::success(content);
    result.structured_content = serde_json::to_value(value).ok();
    result
}

#[tool_router]
impl Helpdesk {
    fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    // Every hint, set explicitly: the protocol's defaults assume a tool may write, may destroy
    // and reaches the outside world.
    #[tool(
        title = "Search tickets",
        description = "Finds tickets by words in their subject and messages, most recently updated first. Use it to find a ticket before reading or changing it. Returns each ticket's ID, subject, status, priority and when it last changed, with a link to read the whole ticket. Narrow a long list with status, priority, assignee or updated_after.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false),
        output_schema = schema_for_type::<SearchResult>()
    )]
    async fn search_tickets(
        &self,
        Parameters(_args): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let found = SearchResult {
            tickets: matches(),
            total: 3,
            next_cursor: None,
        };
        let mut content = vec![as_text(&found)];
        content.extend(found.tickets.iter().map(ticket_link));
        Ok(structured(content, &found))
    }

    #[tool(
        title = "Get a ticket",
        description = "Gets one ticket in full: subject, status, priority, requester, assignee, tags, dates and its address in the web app. Use it when you know the ticket's ID, from search_tickets or from the person; it doesn't search.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false),
        output_schema = schema_for_type::<Ticket>()
    )]
    async fn get_ticket(
        &self,
        Parameters(args): Parameters<TicketArgs>,
    ) -> Result<CallToolResult, McpError> {
        let ticket = ticket_1042();
        if args.id != ticket.id {
            // A failure the caller can fix comes back as an isError result that says what to change.
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "There's no ticket {}; search_tickets finds tickets by their words.",
                args.id
            ))]));
        }
        let link = ContentBlock::resource_link(
            Resource::new(ticket.url, ticket.id)
                .with_title("Open T-1042 in Example Helpdesk")
                .with_mime_type("text/html"),
        );
        Ok(structured(vec![as_text(&ticket), link], &ticket))
    }

    #[tool(
        title = "Update a ticket",
        description = "Changes a ticket's status, priority, assignee or tags. Fields you leave out stay as they are, and sending the same values again changes nothing. Send at least one field besides id.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn update_ticket(
        &self,
        Parameters(_args): Parameters<UpdateArgs>,
    ) -> Result<CallToolResult, McpError> {
        let updated = TicketSummary {
            status: Status::Solved,
            updated_at: "2026-10-15T09:30:00Z",
            ..matches()[0].clone()
        };
        Ok(CallToolResult::success(vec![
            ContentBlock::text("Updated T-1042: its status is now solved."),
            ticket_link(&updated),
        ]))
    }

    #[tool(
        title = "Delete a ticket",
        description = "Deletes a ticket and its messages for good. Only use it when the person asks to delete that ticket; to stop work on one, set its status to closed with update_ticket instead.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn delete_ticket(
        &self,
        Parameters(_args): Parameters<DeleteArgs>,
    ) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![ContentBlock::text(
            "Deleted T-1042 and its 4 messages.",
        )]))
    }

    #[tool(
        title = "Chart ticket volume",
        description = "Charts how many tickets came in over the last days, one bar per status or priority, as a PNG image with a one-line summary. Use it for questions about workload and trends.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn ticket_volume_chart(
        &self,
        Parameters(_args): Parameters<ChartArgs>,
    ) -> Result<CallToolResult, McpError> {
        // For people to look at; the text says the same for models.
        let mut chart = ContentBlock::image(VOLUME_PNG, "image/png");
        if let ContentBlock::Image(image) = &mut chart {
            image.annotations = Some(Annotations::default().with_audience(vec![Role::User]));
        }
        Ok(CallToolResult::success(vec![
            chart,
            ContentBlock::text(
                "Last 30 days: 214 new tickets. 37 are open, 21 pending, 142 solved and 14 closed.",
            ),
        ]))
    }

    #[tool(
        title = "Fetch a help center article",
        description = "Fetches an article from the public help center at help.example.com, as Markdown. Use it to quote or summarize published help for a requester. It only fetches help.example.com addresses.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn fetch_help_article(
        &self,
        Parameters(_args): Parameters<ArticleArgs>,
    ) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![
            ContentBlock::text(PRINTER_OFFLINE),
            ContentBlock::resource_link(
                Resource::new(
                    "https://help.example.com/articles/printer-offline",
                    "printer-offline",
                )
                .with_title("When a printer shows offline, in the help center")
                .with_mime_type("text/html"),
            ),
        ]))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Helpdesk {
    fn get_info(&self) -> ServerConfig {
        let icon = |src: &str, mime_type: &str, sizes: &str| {
            Icon::new(src)
                .with_mime_type(mime_type)
                .with_sizes(vec![sizes.to_string()])
        };
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().enable_prompts().build())
            .with_server_info(
                Implementation::new("example-helpdesk", "1.4.0")
                    .with_title("Example Helpdesk")
                    .with_description("Search, read and update the support tickets in Example Helpdesk, and chart how many come in.")
                    .with_website_url("https://helpdesk.example.com/docs/mcp")
                    .with_icons(vec![
                        icon(LIGHT_ICON, "image/svg+xml", "any").with_theme(IconTheme::Light),
                        icon(DARK_ICON, "image/svg+xml", "any").with_theme(IconTheme::Dark),
                        icon("https://helpdesk.example.com/icons/helpdesk-48.png", "image/png", "48x48"),
                    ]),
            )
            .with_instructions(INSTRUCTIONS)
    }

    // How long clients may reuse each result, and whether they may share it: server/discover and
    // the lists are the same for everyone; tickets and reports are this person's.
    async fn discover(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, McpError> {
        Ok(DiscoverResult::from_server_info(
            self.supported_protocol_versions().into_owned(),
            self.get_info(),
        )
        .with_ttl_ms(3_600_000)
        .with_cache_scope(CacheScope::Public))
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let annotations = |audience: Vec<Role>, priority: f32, last_modified: &str| {
            let mut annotations = Annotations::default()
                .with_audience(audience)
                .with_priority(priority);
            annotations.last_modified = Some(last_modified.to_string());
            annotations
        };
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new("helpdesk://guides/getting-started", "getting-started")
                .with_title("Getting started")
                .with_description(
                    "What each ticket status and priority means. Read it before changing tickets.",
                )
                .with_mime_type("text/markdown")
                .with_size(GETTING_STARTED.len() as u64)
                .with_annotations(annotations(
                    vec![Role::User, Role::Assistant],
                    0.9,
                    "2026-09-30T12:00:00Z",
                )),
            Resource::new("helpdesk://schemas/ticket", "ticket-schema")
                .with_title("Ticket schema")
                .with_description(
                    "The JSON Schema every ticket follows, with what each field means.",
                )
                .with_mime_type("application/schema+json")
                .with_size(TICKET_SCHEMA_JSON.len() as u64)
                .with_annotations(annotations(
                    vec![Role::Assistant],
                    0.5,
                    "2026-08-14T08:00:00Z",
                )),
            Resource::new("helpdesk://reports/volume.png", "volume-chart")
                .with_title("Ticket volume, last 30 days")
                .with_description(
                    "New tickets over the last 30 days, one bar per status. Updated every hour.",
                )
                .with_mime_type("image/png")
                .with_size(VOLUME_PNG_BYTES)
                .with_annotations(annotations(vec![Role::User], 0.3, "2026-10-15T09:00:00Z")),
        ])
        .with_ttl_ms(600_000)
        .with_cache_scope(CacheScope::Public))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        Ok(ListResourceTemplatesResult::with_all_items(vec![
            ResourceTemplate::new("helpdesk://tickets/{id}", "ticket")
                .with_title("Ticket by ID")
                // A template's variables have no schema, so the description says what id looks like.
                .with_description("One ticket as JSON, as get_ticket returns it. id is the ticket's ID, such as T-1042.")
                .with_mime_type("application/json"),
        ])
        .with_ttl_ms(600_000)
        .with_cache_scope(CacheScope::Public))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let uri = request.uri.as_str();
        let (contents, ttl_ms, scope) = match uri {
            "helpdesk://guides/getting-started" => (
                ResourceContents::text(GETTING_STARTED, uri).with_mime_type("text/markdown"),
                3_600_000,
                CacheScope::Public,
            ),
            "helpdesk://schemas/ticket" => (
                ResourceContents::text(TICKET_SCHEMA_JSON, uri)
                    .with_mime_type("application/schema+json"),
                86_400_000,
                CacheScope::Public,
            ),
            // This organization's own figures: clients mustn't share them across sign-ins.
            "helpdesk://reports/volume.png" => (
                ResourceContents::blob(VOLUME_PNG, uri).with_mime_type("image/png"),
                3_600_000,
                CacheScope::Private,
            ),
            "helpdesk://tickets/T-1042" => {
                let ticket = serde_json::to_string(&ticket_1042()).unwrap_or_default();
                (
                    ResourceContents::text(ticket, uri).with_mime_type("application/json"),
                    0,
                    CacheScope::Private,
                )
            }
            _ => {
                return Err(McpError::resource_not_found(
                    format!("There's no resource {uri}"),
                    None,
                ));
            }
        };
        Ok(ReadResourceResult::new(vec![contents])
            .with_ttl_ms(ttl_ms)
            .with_cache_scope(scope)
            .into())
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, McpError> {
        Ok(ListPromptsResult::with_all_items(vec![
            Prompt::new(
                "summarize_ticket",
                Some("Drafts a short summary of a ticket: what's wrong, what's been tried and what's next. For handing a ticket over, or for updating the requester."),
                // Prompt arguments are text without a schema: an example in each description is
                // what a client can fill in.
                Some(vec![
                    PromptArgument::new("id").with_description("The ticket to summarize, such as T-1042.").with_required(true),
                    PromptArgument::new("audience").with_description("Who reads the summary: either \"agent\" or \"requester\". Defaults to \"agent\".").with_required(false),
                ]),
            )
            .with_title("Summarize a ticket"),
            Prompt::new("triage_open_tickets", Some("Asks for the open tickets in order of urgency, with who should take each one."), None)
                .with_title("Triage the open tickets"),
        ])
        .with_ttl_ms(600_000)
        .with_cache_scope(CacheScope::Public))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, McpError> {
        let result = match request.name.as_str() {
            "summarize_ticket" => {
                let ticket = serde_json::to_string(&ticket_1042()).unwrap_or_default();
                GetPromptResult::new(vec![
                    PromptMessage::new_text(Role::User, "Summarize this ticket for the support team in three short paragraphs: the problem, what has been tried, and the next step. Keep the requester's own words where you can."),
                    PromptMessage::new(Role::User, ContentBlock::resource(ResourceContents::text(ticket, "helpdesk://tickets/T-1042").with_mime_type("application/json"))),
                ])
                .with_description("A summary of T-1042 for the support team")
            }
            "triage_open_tickets" => GetPromptResult::new(vec![
                PromptMessage::new_text(Role::User, "List the open tickets from most to least urgent. For each, say in one line why it's urgent and who should take it, from the people already working on similar tickets."),
                PromptMessage::new_text(Role::Assistant, "I'll search the open tickets first, then read the urgent and high-priority ones in full before ordering them."),
            ])
            .with_description("Triage of the open tickets"),
            other => return Err(McpError::invalid_params(format!("There's no prompt {other}"), None)),
        };
        Ok(result.into())
    }
}

// --- Canned data ---

fn matches() -> Vec<TicketSummary> {
    vec![
        TicketSummary {
            id: "T-1042",
            subject: "Printer on floor 3 shows offline",
            status: Status::Open,
            priority: Priority::High,
            updated_at: "2026-10-14T16:02:00Z",
        },
        TicketSummary {
            id: "T-1038",
            subject: "Printer driver won't install on macOS 16",
            status: Status::Pending,
            priority: Priority::Normal,
            updated_at: "2026-10-13T11:40:00Z",
        },
        TicketSummary {
            id: "T-1017",
            subject: "Badge printer jams on the first card",
            status: Status::Solved,
            priority: Priority::Low,
            updated_at: "2026-10-09T08:05:00Z",
        },
    ]
}

fn ticket_1042() -> Ticket {
    Ticket {
        id: "T-1042",
        subject: "Printer on floor 3 shows offline",
        status: Status::Open,
        priority: Priority::High,
        requester: Person {
            name: "Ada Lovelace",
            email: "ada@example.com",
        },
        assignee: Some("grace@example.com"),
        tags: vec!["hardware", "printing"],
        created_at: "2026-10-12T09:14:00Z",
        updated_at: "2026-10-14T16:02:00Z",
        url: "https://helpdesk.example.com/tickets/T-1042",
    }
}

const GETTING_STARTED: &str = "# Getting started with Example Helpdesk

Every ticket has an ID like T-1042, a subject, a status and a priority.

## Statuses

- **open**: someone needs to act on it.
- **pending**: waiting for the requester to answer.
- **solved**: fixed. It closes by itself after 7 days.
- **closed**: done for good. A closed ticket can't be reopened; open a new one instead.

## Priorities

low, normal, high and urgent. An urgent ticket pages whoever is on call, so only raise a ticket to urgent when the requester can't work at all.
";

const PRINTER_OFFLINE: &str = "# When a printer shows offline

1. Check that the printer is on and its screen shows no error.
2. Print a configuration page from the printer's menu, and check that its IP address starts with 10.3.
3. On your computer, remove the printer and add it again from Settings, then Printers.

Still offline? Open a ticket and include the configuration page.
";

// The JSON Schema every ticket follows, the helpdesk://schemas/ticket resource.
const TICKET_SCHEMA_JSON: &str = r#"{
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
}"#;

// Icons for light and dark backgrounds, as data: URIs so they need no host of their own.
const LIGHT_ICON: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMWQ0ZWQ4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=";
const DARK_ICON: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTNjNWZkIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=";

// New tickets by status over the last 30 days, as a 160×80 PNG of 194 bytes.
const VOLUME_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAMAAACpg44GAAAAElBMVEX///8lY+vZdwYWo0prcoCco69dcYm0AAAABnRSTlMA//////96eeD+AAAAWUlEQVR42u3OyQkAIRAAsPHY/lv25cfHgOCCYFJBIgA4riUEBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFHwuWhKCgoKDgVBOCgkuwJwQFBfeC36UC4H8DEoQebf3n2AwAAAAASUVORK5CYII=";
const VOLUME_PNG_BYTES: u64 = 194;
