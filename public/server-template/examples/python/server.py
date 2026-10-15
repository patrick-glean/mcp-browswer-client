"""Example Helpdesk on the official Python SDK: the server whose replies are in ../../example.json,
described as fully as MCP allows and served over Streamable HTTP, so a browser client such as MCP
Browser Client can connect to it.

    pip install -r requirements.txt && python server.py    # http://127.0.0.1:8090/mcp; PORT picks another port

What a client shows comes from what's declared here: the server's identity and instructions, each
tool's title, description, annotations and schemas, and the resources and prompts. The tickets are
canned; a real server would look them up.
"""

import base64
import json
import os
from typing import Annotated, Any, Literal

import uvicorn
from mcp.server.caching import CacheHint
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ResourceNotFoundError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import (
    Annotations,
    CallToolResult,
    EmbeddedResource,
    GetPromptResult,
    Icon,
    ImageContent,
    ResourceLink,
    TextContent,
    TextResourceContents,
    ToolAnnotations,
)
from pydantic import BaseModel, Field
from pydantic.json_schema import SkipJsonSchema
from starlette.middleware.cors import CORSMiddleware

INSTRUCTIONS = """Example Helpdesk holds the Example company's support tickets. Ticket IDs look like T-1042, and dates are in UTC.

- To find a ticket, use search_tickets, then get_ticket with its ID. Don't guess IDs.
- update_ticket changes only the fields you send. Before changing the status or assignee of a ticket the person didn't mention, ask them.
- delete_ticket can't be undone. Only use it when the person asks to delete a specific ticket; otherwise set its status to closed.
- For questions about workload or trends, use ticket_volume_chart.
- helpdesk://guides/getting-started explains what each status and priority means."""


class Helpdesk(MCPServer):
    """MCPServer, plus what its decorators can't declare: each resource's size, and a description
    of each prompt's result rather than of the prompt."""

    async def list_resources(self):
        resources = await super().list_resources()
        return [resource.model_copy(update={"size": RESOURCE_SIZES.get(resource.uri)}) for resource in resources]

    async def get_prompt(self, name, arguments=None, context=None):
        result = await super().get_prompt(name, arguments, context)
        if isinstance(result, GetPromptResult) and name in PROMPT_RESULTS:
            result.description = PROMPT_RESULTS[name].format(**(arguments or {}))
        return result


server = Helpdesk(
    name="example-helpdesk",
    title="Example Helpdesk",
    version="1.4.0",
    description="Search, read and update the support tickets in Example Helpdesk, and chart how many come in.",
    website_url="https://helpdesk.example.com/docs/mcp",
    icons=[
        Icon(src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMWQ0ZWQ4IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=", mime_type="image/svg+xml", sizes=["any"], theme="light"),
        Icon(src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTNjNWZkIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PHBhdGggZD0iTTQuOSA0LjlsNC4zIDQuM00xNC44IDE0LjhsNC4zIDQuM00xNC44IDkuMmw0LjMtNC4zTTQuOSAxOS4xbDQuMy00LjMiLz48L3N2Zz4=", mime_type="image/svg+xml", sizes=["any"], theme="dark"),
        Icon(src="https://helpdesk.example.com/icons/helpdesk-48.png", mime_type="image/png", sizes=["48x48"]),
    ],
    instructions=INSTRUCTIONS,
    # How long clients may reuse each result, and whether they may share it. MCPServer takes one
    # hint per method, so every resource read gets the most careful one: tickets and reports are
    # this person's.
    cache_hints={
        "server/discover": CacheHint(ttl_ms=3_600_000, scope="public"),
        "tools/list": CacheHint(ttl_ms=600_000, scope="public"),
        "resources/list": CacheHint(ttl_ms=600_000, scope="public"),
        "resources/templates/list": CacheHint(ttl_ms=600_000, scope="public"),
        "prompts/list": CacheHint(ttl_ms=600_000, scope="public"),
        "resources/read": CacheHint(ttl_ms=0, scope="private"),
    },
)


def hints(read_only: bool, destructive: bool, idempotent: bool, open_world: bool) -> ToolAnnotations:
    """Every hint, set explicitly: the protocol's defaults assume a tool may write, may destroy and
    reaches the outside world."""
    return ToolAnnotations(read_only_hint=read_only, destructive_hint=destructive, idempotent_hint=idempotent, open_world_hint=open_world)


def optional(description: str, **schema: Any) -> Any:
    """An optional argument, shown as its own type. Paired with `X | SkipJsonSchema[None] = None`,
    which keeps null out of the schema; this drops the "default": null that would stay. `schema`
    adds JSON Schema keywords Pydantic has no parameter for (format, uniqueItems)."""

    def describe(property_schema: dict[str, Any]) -> None:
        property_schema.pop("default", None)
        property_schema.update(schema)

    return Field(description=description, json_schema_extra=describe)


Status = Literal["open", "pending", "solved", "closed"]
Priority = Literal["low", "normal", "high", "urgent"]
TicketId = Annotated[str, Field(description="The ticket's ID: T- and a number.", pattern=r"^T-[0-9]+$", examples=["T-1042"])]


class TicketSummary(BaseModel):
    id: str
    subject: str
    status: Status
    priority: Priority
    updatedAt: Annotated[str, Field(json_schema_extra={"format": "date-time"})]


class SearchResult(BaseModel):
    tickets: Annotated[list[TicketSummary], Field(description="The tickets found, most recently updated first.")]
    total: Annotated[int, Field(description="How many tickets match, on every page.")]
    nextCursor: Annotated[str | SkipJsonSchema[None], optional("Send as cursor for the next page. Absent on the last page.")] = None


class Person(BaseModel):
    name: str
    email: Annotated[str, Field(json_schema_extra={"format": "email"})]


class Ticket(BaseModel):
    id: Annotated[str, Field(description="The ticket's ID.")]
    subject: Annotated[str, Field(description="One line on what's wrong.")]
    status: Status
    priority: Priority
    requester: Person
    assignee: Annotated[str | SkipJsonSchema[None], optional("Who's working on it. Absent while it's unassigned.", format="email")] = None
    tags: list[str]
    createdAt: Annotated[str, Field(json_schema_extra={"format": "date-time"})]
    updatedAt: Annotated[str, Field(json_schema_extra={"format": "date-time"})]
    url: Annotated[str, Field(description="The ticket in the helpdesk's web app.", json_schema_extra={"format": "uri"})]


def ticket_link(ticket: dict[str, str]) -> ResourceLink:
    """A link to read a ticket as a resource, labelled for people."""
    return ResourceLink(
        uri=f"helpdesk://tickets/{ticket['id']}",
        name=ticket["id"],
        title=f"{ticket['id']}: {ticket['subject']}",
        description=f"{ticket['status']}, {ticket['priority']} priority, updated {ticket['updatedAt'][:10]}",
        mime_type="application/json",
    )


def as_text(value: Any) -> TextContent:
    """The same JSON as text: clients and models that only read text get the data too."""
    return TextContent(text=json.dumps(value))


# --- Tools ---


@server.tool(
    title="Search tickets",
    description="Finds tickets by words in their subject and messages, most recently updated first. Use it to find a ticket before reading or changing it. Returns each ticket's ID, subject, status, priority and when it last changed, with a link to read the whole ticket. Narrow a long list with status, priority, assignee or updated_after.",
    annotations=hints(True, False, True, False),
)
def search_tickets(
    query: Annotated[str, Field(description="Words to look for in the subject and messages.", min_length=1, examples=["printer offline"])],
    status: Annotated[Status | SkipJsonSchema[None], optional("Only tickets with this status.")] = None,
    priority: Annotated[Priority | SkipJsonSchema[None], optional("Only tickets with this priority.")] = None,
    assignee: Annotated[str | SkipJsonSchema[None], optional("Only tickets assigned to this person, by email address.", format="email", examples=["grace@example.com"])] = None,
    updated_after: Annotated[str | SkipJsonSchema[None], optional("Only tickets updated on or after this day (UTC), as YYYY-MM-DD.", format="date", examples=["2026-10-01"])] = None,
    limit: Annotated[int, Field(description="How many tickets to return at most.", ge=1, le=50)] = 10,
    cursor: Annotated[str | SkipJsonSchema[None], optional("nextCursor from an earlier response, for the next page.")] = None,
) -> Annotated[CallToolResult, SearchResult]:
    found = {"tickets": MATCHES, "total": len(MATCHES)}
    return CallToolResult(content=[as_text(found), *map(ticket_link, MATCHES)], structured_content=found)


@server.tool(
    title="Get a ticket",
    description="Gets one ticket in full: subject, status, priority, requester, assignee, tags, dates and its address in the web app. Use it when you know the ticket's ID, from search_tickets or from the person; it doesn't search.",
    annotations=hints(True, False, True, False),
)
def get_ticket(id: TicketId) -> Annotated[CallToolResult, Ticket]:
    if id != TICKET_1042["id"]:
        # A failure the caller can fix comes back as an isError result that says what to change.
        return CallToolResult(content=[TextContent(text=f"There's no ticket {id}; search_tickets finds tickets by their words.")], is_error=True)
    link = ResourceLink(uri=TICKET_1042["url"], name="T-1042", title="Open T-1042 in Example Helpdesk", mime_type="text/html")
    return CallToolResult(content=[as_text(TICKET_1042), link], structured_content=TICKET_1042)


@server.tool(
    title="Update a ticket",
    description="Changes a ticket's status, priority, assignee or tags. Fields you leave out stay as they are, and sending the same values again changes nothing. Send at least one field besides id.",
    annotations=hints(False, False, True, False),
)
def update_ticket(
    id: TicketId,
    status: Annotated[Status | SkipJsonSchema[None], optional("The new status.")] = None,
    priority: Annotated[Priority | SkipJsonSchema[None], optional("The new priority.")] = None,
    assignee: Annotated[str | SkipJsonSchema[None], optional("Who to assign it to, by email address.", format="email", examples=["grace@example.com"])] = None,
    tags: Annotated[
        list[Annotated[str, Field(pattern=r"^[a-z0-9-]+$")]] | SkipJsonSchema[None],
        optional("The ticket's tags, replacing the ones it has: lowercase words and dashes.", uniqueItems=True, examples=[["hardware", "printing"]]),
    ] = None,
) -> CallToolResult:
    updated = {**MATCHES[0], "status": "solved", "updatedAt": "2026-10-15T09:30:00Z"}
    return CallToolResult(content=[TextContent(text="Updated T-1042: its status is now solved."), ticket_link(updated)])


@server.tool(
    title="Delete a ticket",
    description="Deletes a ticket and its messages for good. Only use it when the person asks to delete that ticket; to stop work on one, set its status to closed with update_ticket instead.",
    annotations=hints(False, True, True, False),
)
def delete_ticket(
    id: TicketId,
    reason: Annotated[str | SkipJsonSchema[None], optional("Why it's being deleted, kept in the audit log.", maxLength=500, examples=["Duplicate of T-1038"])] = None,
) -> CallToolResult:
    return CallToolResult(content=[TextContent(text="Deleted T-1042 and its 4 messages.")])


@server.tool(
    title="Chart ticket volume",
    description="Charts how many tickets came in over the last days, one bar per status or priority, as a PNG image with a one-line summary. Use it for questions about workload and trends.",
    annotations=hints(True, False, True, False),
)
def ticket_volume_chart(
    days: Annotated[int, Field(description="How many days to chart, ending today.", ge=7, le=90)] = 30,
    group_by: Annotated[Literal["status", "priority"], Field(description="What each bar counts.")] = "status",
) -> CallToolResult:
    return CallToolResult(content=[
        # For people to look at; the text says the same for models.
        ImageContent(data=VOLUME_PNG, mime_type="image/png", annotations=Annotations(audience=["user"])),
        TextContent(text="Last 30 days: 214 new tickets. 37 are open, 21 pending, 142 solved and 14 closed."),
    ])


@server.tool(
    title="Fetch a help center article",
    description="Fetches an article from the public help center at help.example.com, as Markdown. Use it to quote or summarize published help for a requester. It only fetches help.example.com addresses.",
    annotations=hints(True, False, True, True),
)
def fetch_help_article(
    url: Annotated[str, Field(description="The article's address on help.example.com.", pattern=r"^https://help\.example\.com/", examples=["https://help.example.com/articles/printer-offline"], json_schema_extra={"format": "uri"})],
) -> CallToolResult:
    link = ResourceLink(uri="https://help.example.com/articles/printer-offline", name="printer-offline", title="When a printer shows offline, in the help center", mime_type="text/html")
    return CallToolResult(content=[TextContent(text=PRINTER_OFFLINE), link])


# --- Resources ---


@server.resource(
    "helpdesk://guides/getting-started",
    name="getting-started",
    title="Getting started",
    description="What each ticket status and priority means. Read it before changing tickets.",
    mime_type="text/markdown",
    annotations=Annotations(audience=["user", "assistant"], priority=0.9, last_modified="2026-09-30T12:00:00Z"),
)
def getting_started() -> str:
    return GETTING_STARTED


@server.resource(
    "helpdesk://schemas/ticket",
    name="ticket-schema",
    title="Ticket schema",
    description="The JSON Schema every ticket follows, with what each field means.",
    mime_type="application/schema+json",
    annotations=Annotations(audience=["assistant"], priority=0.5, last_modified="2026-08-14T08:00:00Z"),
)
def ticket_schema() -> str:
    return TICKET_SCHEMA_JSON


@server.resource(
    "helpdesk://reports/volume.png",
    name="volume-chart",
    title="Ticket volume, last 30 days",
    description="New tickets over the last 30 days, one bar per status. Updated every hour.",
    mime_type="image/png",
    annotations=Annotations(audience=["user"], priority=0.3, last_modified="2026-10-15T09:00:00Z"),
)
def volume_chart() -> bytes:
    return base64.b64decode(VOLUME_PNG)


@server.resource(
    "helpdesk://tickets/{id}",
    name="ticket",
    title="Ticket by ID",
    # A template's variables have no schema, so the description says what id looks like.
    description="One ticket as JSON, as get_ticket returns it. id is the ticket's ID, such as T-1042.",
    mime_type="application/json",
)
def ticket(id: str) -> str:
    if id != TICKET_1042["id"]:
        raise ResourceNotFoundError(f"helpdesk://tickets/{id}")
    return json.dumps(TICKET_1042)


# --- Prompts ---


@server.prompt(
    title="Summarize a ticket",
    description="Drafts a short summary of a ticket: what's wrong, what's been tried and what's next. For handing a ticket over, or for updating the requester.",
)
def summarize_ticket(
    # Prompt arguments are text without a schema: an example in each description is what a
    # client can fill in.
    id: Annotated[str, Field(description="The ticket to summarize, such as T-1042.")],
    audience: Annotated[str | None, Field(description='Who reads the summary: either "agent" or "requester". Defaults to "agent".')] = None,
) -> list[dict[str, Any]]:
    return [
        {"role": "user", "content": TextContent(text="Summarize this ticket for the support team in three short paragraphs: the problem, what has been tried, and the next step. Keep the requester's own words where you can.")},
        {"role": "user", "content": EmbeddedResource(resource=TextResourceContents(uri="helpdesk://tickets/T-1042", mime_type="application/json", text=json.dumps(TICKET_1042)))},
    ]


@server.prompt(title="Triage the open tickets", description="Asks for the open tickets in order of urgency, with who should take each one.")
def triage_open_tickets() -> list[dict[str, Any]]:
    return [
        {"role": "user", "content": TextContent(text="List the open tickets from most to least urgent. For each, say in one line why it's urgent and who should take it, from the people already working on similar tickets.")},
        {"role": "assistant", "content": TextContent(text="I'll search the open tickets first, then read the urgent and high-priority ones in full before ordering them.")},
    ]


# What each prompt's result is, filled in with its arguments: the client shows it above the messages.
PROMPT_RESULTS = {
    "summarize_ticket": "A summary of {id} for the support team",
    "triage_open_tickets": "Triage of the open tickets",
}


# --- Canned data ---

MATCHES = [
    {"id": "T-1042", "subject": "Printer on floor 3 shows offline", "status": "open", "priority": "high", "updatedAt": "2026-10-14T16:02:00Z"},
    {"id": "T-1038", "subject": "Printer driver won't install on macOS 16", "status": "pending", "priority": "normal", "updatedAt": "2026-10-13T11:40:00Z"},
    {"id": "T-1017", "subject": "Badge printer jams on the first card", "status": "solved", "priority": "low", "updatedAt": "2026-10-09T08:05:00Z"},
]

TICKET_1042 = {
    "id": "T-1042",
    "subject": "Printer on floor 3 shows offline",
    "status": "open",
    "priority": "high",
    "requester": {"name": "Ada Lovelace", "email": "ada@example.com"},
    "assignee": "grace@example.com",
    "tags": ["hardware", "printing"],
    "createdAt": "2026-10-12T09:14:00Z",
    "updatedAt": "2026-10-14T16:02:00Z",
    "url": "https://helpdesk.example.com/tickets/T-1042",
}

GETTING_STARTED = """# Getting started with Example Helpdesk

Every ticket has an ID like T-1042, a subject, a status and a priority.

## Statuses

- **open**: someone needs to act on it.
- **pending**: waiting for the requester to answer.
- **solved**: fixed. It closes by itself after 7 days.
- **closed**: done for good. A closed ticket can't be reopened; open a new one instead.

## Priorities

low, normal, high and urgent. An urgent ticket pages whoever is on call, so only raise a ticket to urgent when the requester can't work at all.
"""

PRINTER_OFFLINE = """# When a printer shows offline

1. Check that the printer is on and its screen shows no error.
2. Print a configuration page from the printer's menu, and check that its IP address starts with 10.3.
3. On your computer, remove the printer and add it again from Settings, then Printers.

Still offline? Open a ticket and include the configuration page.
"""

# New tickets by status over the last 30 days, as a 160×80 PNG.
VOLUME_PNG = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAMAAACpg44GAAAAElBMVEX///8lY+vZdwYWo0prcoCco69dcYm0AAAABnRSTlMA//////96eeD+AAAAWUlEQVR42u3OyQkAIRAAsPHY/lv25cfHgOCCYFJBIgA4riUEBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFHwuWhKCgoKDgVBOCgkuwJwQFBfeC36UC4H8DEoQebf3n2AwAAAAASUVORK5CYII="

# The JSON Schema every ticket follows, the helpdesk://schemas/ticket resource.
TICKET_SCHEMA_JSON = """{
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
}"""

RESOURCE_SIZES = {
    "helpdesk://guides/getting-started": len(GETTING_STARTED.encode()),
    "helpdesk://schemas/ticket": len(TICKET_SCHEMA_JSON.encode()),
    "helpdesk://reports/volume.png": len(base64.b64decode(VOLUME_PNG)),
}


# --- Serving it to browsers ---

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8090"))
    # The SDK checks Host and Origin itself on a localhost bind; the deployed client is a page on
    # GitHub Pages, so its origin is allowed too.
    origins = ["http://127.0.0.1:*", "http://localhost:*", "https://patrick-glean.github.io"]
    security = TransportSecuritySettings(allowed_hosts=["127.0.0.1:*", "localhost:*"], allowed_origins=origins)
    # Stateless with JSON replies: each request stands alone, which suits 2026-07-28 and still
    # answers 2025 clients' initialize.
    app = server.streamable_http_app(stateless_http=True, json_response=True, transport_security=security)
    # A page calling the server sends its origin and the MCP headers (MCP-Protocol-Version,
    # Mcp-Method, Mcp-Name, Mcp-Param-*, Authorization), so the server lets those through CORS
    # and lets the page read Mcp-Session-Id. allow_headers=["*"] echoes the requested headers.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?|https://patrick-glean\.github\.io",
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["Mcp-Session-Id"],
    )
    print(f"Example Helpdesk (Python SDK) on http://127.0.0.1:{port}/mcp", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
