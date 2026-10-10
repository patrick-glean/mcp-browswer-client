#!/usr/bin/env python3
"""Mock MCP server for local development and the browser smoke test (standard library only).

Modes:
  modern  MCP 2026-07-28 only: per-request _meta, server/discover, mirrored-header validation.
  legacy  A 2025-era Streamable HTTP server: initialize handshake and Mcp-Session-Id.
  dual    Both (the default): modern requests are stateless, initialize opens a legacy session.

Examples:
  python3 test_mcp_server.py                      # dual mode on http://127.0.0.1:8081
  python3 test_mcp_server.py --mode legacy --sse  # a 2025-era server that streams replies
  python3 test_mcp_server.py --token s3cret       # requires Authorization: Bearer s3cret
  python3 test_mcp_server.py --oauth              # requires an OAuth sign-in (approved at once)
  python3 test_mcp_server.py --oauth --hide-www-authenticate --token-ttl 5
                                                  # like Glean: no readable challenge; short tokens
  python3 test_mcp_server.py --allow-origin https://example.github.io
  python3 test_mcp_server.py --mode legacy --allow-headers "Content-Type, Mcp-Session-Id, MCP-Protocol-Version"
                                                  # a CORS policy written before 2026-07-28
"""

import argparse
import base64
import hashlib
import html
import json
import re
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODERN_VERSION = "2026-07-28"
LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"]
SERVER_INFO = {"name": "Mock MCP Server", "version": "2.0.0"}
DEFAULT_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*"]
PAGE_SIZE = 2

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
HEADER_MISMATCH = -32020
UNSUPPORTED_PROTOCOL_VERSION = -32022

TOOLS = [
    {
        "name": "echo",
        "title": "Echo",
        "description": "Echoes back the input text.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "Text to echo back.", "examples": ["hello"]}},
            "required": ["text"],
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "echo_region",
        "description": "Echoes the text and the region, which also travels in the Mcp-Param-Region header.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "region": {"type": "string", "description": "Region name, mirrored into a header.", "x-mcp-header": "Region"},
                "text": {"type": "string", "description": "Text to echo back."},
            },
            "required": ["region", "text"],
        },
    },
    {
        "name": "count",
        "description": "Counts to n (1-10). With --sse the reply streams in while it counts.",
        "inputSchema": {
            "type": "object",
            "properties": {"n": {"type": "integer", "description": "How far to count.", "default": 3}},
            "required": ["n"],
        },
        "outputSchema": {
            "type": "object",
            "properties": {"counted": {"type": "integer", "description": "The number reached."}},
            "required": ["counted"],
        },
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "ticket",
        "title": "Next ticket",
        "description": "Hands out the next ticket number, so every call returns something new.",
        "inputSchema": {
            "type": "object",
            "properties": {"prefix": {"type": "string", "description": "Text before the number.", "default": "T-"}},
        },
        "annotations": {"readOnlyHint": False, "idempotentHint": False},
    },
    {
        "name": "broken_header",
        "description": "Has an invalid x-mcp-header annotation (inside array items), so clients must hide it.",
        "inputSchema": {
            "type": "object",
            "properties": {"tags": {"type": "array", "items": {"type": "string", "x-mcp-header": "Tag"}}},
        },
    },
    {
        # Twenty fields, five of them required, described the way servers describe them for models.
        "name": "search_notes",
        "title": "Search notes",
        "description": "Searches the notes by words, dates and author, with the optional filters a real search tool has. Says what it was sent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Words to look for in the notes."},
                "after": {"type": "string", "description": "Only notes written on or after this day, as YYYY-MM-DD."},
                "before": {"type": "string", "description": "Only notes written before this day, as YYYY-MM-DD."},
                "author": {"type": "string", "description": "Email address of the person who wrote the notes."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "How many notes to return at most."},
                "owner": {"type": "string", "description": "Whose notes to search. Value can be a person's name, \"me\" or \"myteam\"."},
                "updated": {"type": "string", "description": "When the notes last changed: one of \"today\", \"past_week\" or \"past_month\". Only when the person mentioned a time frame (e.g. last week)."},
                "sort": {"type": "string", "enum": ["relevance", "newest", "oldest"], "description": "How to order the results."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Only notes with all of these tags (e.g. 'design', 'q3')."},
                "include_archived": {"type": "boolean", "description": "Also search archived notes."},
                "folder": {"type": "string", "description": "URL of the folder to search in."},
                "region": {"type": "string", "description": "Where the notes are stored, e.g. eu-west-1."},
                "language": {"type": "string", "description": "Language the notes are written in."},
                "peer": {"type": "string", "description": "Email address of someone whose shared notes to include (e.g. 'Which notes did alice@example.com share with me?')."},
                "fields": {"type": "array", "items": {"type": "string", "enum": ["title", "body", "tags", "author"]}, "description": "Which parts of each note to return."},
                "snippet": {
                    "type": "object",
                    "description": "How much text to show around each match.",
                    "properties": {
                        "length": {"type": "integer", "default": 200, "description": "Characters of text around a match."},
                        "marker": {"type": "string", "default": "**", "description": "What to put around the words that matched."},
                    },
                },
                "timeout_seconds": {"type": "number", "description": "How long to search before giving up."},
                "request_id": {"type": "string", "format": "uuid", "description": "An ID to find this search by in the server's log."},
                "format": {"type": "string", "enum": ["text", "markdown", "json"], "default": "markdown", "description": "How to write the results."},
                "cursor": {"type": "string", "description": "Pagination cursor from an earlier response's next_cursor."},
            },
            "required": ["query", "after", "before", "author", "limit"],
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        # An app's screen can be HTML a tool returns, as an embedded text/html resource.
        "name": "make_screen",
        "title": "Make a screen",
        "description": "Makes an HTML page for an app's screen: a text box (question), a button (ask) and an output (answer).",
        "inputSchema": {
            "type": "object",
            "properties": {"title": {"type": "string", "description": "The page's heading.", "default": "Ask the mock"}},
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        # A stand-in for a model, so the Chat app and the app builder's "Ask a model" work without one.
        "name": "chat",
        "title": "Chat (a stand-in model)",
        "description": "A stand-in for a model: it answers what you say; asked for an app's boxes, it answers with one JSON object of made-up values in their shapes; and asked for HTML, it writes a page in an ```html block (a ticket dashboard, if you ask for one).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "What you say to it."},
                "history": {"type": "array", "items": {"type": "string"}, "description": "The conversation so far."},
            },
            "required": ["message"],
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
]
TOOLS_BY_NAME = {tool["name"]: tool for tool in TOOLS}
# x-mcp-header arrived with 2026-07-28, so the legacy face of the server doesn't offer those tools.
LEGACY_TOOLS = [TOOLS_BY_NAME["echo"], TOOLS_BY_NAME["count"]]

# Three resources, so a listing takes two pages; text in two formats and one binary.
PIXEL_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
RESOURCES = [
    {"uri": "mock://readme", "name": "readme", "title": "Read me", "description": "What this mock server is for.", "mimeType": "text/markdown"},
    {"uri": "mock://config.json", "name": "config", "title": "Configuration", "description": "The mock's settings, as JSON.", "mimeType": "application/json"},
    {"uri": "mock://pixel.png", "name": "pixel", "title": "A pixel", "description": "A one-pixel PNG, base64 in blob.", "mimeType": "image/png"},
]
RESOURCE_TEMPLATES = [
    {"uriTemplate": "mock://notes/{id}", "name": "note", "title": "A note", "description": "Note number id, made up on the spot.", "mimeType": "text/plain"},
]
README = "# Mock MCP Server\n\nA server for testing MCP clients: tools, resources and prompts, in either protocol era.\n"
# What make_screen returns. Its script must never run where an app shows the screen.
SCREEN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body { margin: 0; padding: 24px; font: 15px/1.5 system-ui, sans-serif; }
    main { display: grid; gap: 12px; max-width: 560px; }
    input { padding: 8px 10px; font: inherit; }
    button { justify-self: start; padding: 8px 18px; font: inherit; }
    #answer { min-height: 40px; padding: 10px; background: #f3f3f3; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>{title}</h1>
    <label for="question">Question</label>
    <input id="question" placeholder="Ask the mock something">
    <button id="ask" type="button">Ask</button>
    <div id="answer" aria-live="polite"></div>
  </main>
  <script>document.getElementById('answer').textContent = 'The screen ran its own script';</script>
</body>
</html>
"""
# What chat writes when asked for a dashboard: cards, a search field, a Refresh button and a list,
# with an inline handler and a script that must never run where an app shows it.
DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Tickets</title>
  <style>
    body { font: 14px/1.4 system-ui, sans-serif; }
    .dash { display: grid; gap: 12px; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .card { padding: 10px 12px; border-radius: 10px; background: #eef2ff; color: #1e2a5a; }
    .card b { display: block; font-size: 1.5rem; }
    .row { display: flex; gap: 8px; }
    .row input { flex: 1; padding: 8px 10px; font: inherit; }
    #tickets { margin: 0; padding-left: 18px; }
    #details { min-height: 36px; padding: 8px 10px; border-radius: 8px; background: #f4f4f5; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main class="dash">
    <h2>{title}</h2>
    <div class="cards">
      <div class="card">Open <b id="open">12</b></div>
      <div class="card">Today <b id="today">3</b></div>
      <div class="card">Waiting <b id="waiting">5</b></div>
    </div>
    <form class="row" onsubmit="alert('submitted')">
      <label for="search" hidden>Find a ticket</label>
      <input id="search" placeholder="Find a ticket">
      <button id="refresh" type="submit" onclick="alert('clicked')">Refresh</button>
    </form>
    <ul id="tickets"><li>T-1 The printer jams</li><li>T-2 The VPN drops</li></ul>
    <div id="details" aria-live="polite"></div>
  </main>
  <script>document.getElementById('details').textContent = 'The dashboard ran its own script';</script>
</body>
</html>
"""


# How an app's boxes ask for their pieces of an answer: a line for each key, as
# - "key" (kind): what goes in it. As its shape.
BOX_LINE = re.compile(r'^- "([^"]+)" \(([^)]+)\): (.*)$', re.M)
WEEKS = ["Aug 31", "Sep 7", "Sep 14", "Sep 21", "Sep 28", "Oct 5"]


def box_value(key, kind, about):
    """A made-up piece of an answer for one box, in the shape its kind asks for."""
    words = f"{key} {about}".lower()
    if kind == "number":
        if "health" in words or "track" in words:
            return {"value": "On track", "note": "Two open risks, neither blocking"}
        return {"value": 12, "note": "Up 3 since last week"}
    if kind in ("bar chart", "line chart"):
        found = re.search(r"(\d+)\s+(?:weeks|months|days)", about)
        count = max(2, min(int(found.group(1)) if found else 6, 12))
        values = [4, 7, 5, 9, 12, 8, 10, 6, 11, 13, 9, 14]
        return {"labels": WEEKS if count == 6 else [f"Week {n + 1}" for n in range(count)], "values": values[:count]}
    if kind == "list":
        if "risk" in words or "block" in words:
            return [
                {"title": "The beta date depends on the API review", "detail": "Raised by the platform team"},
                {"title": "Two pilot customers haven't signed off", "detail": "Raised by sales"},
                {"title": "On-call isn't staffed for launch week", "detail": "Raised by support"},
            ]
        if "who" in words or "people" in words:
            return [
                {"title": "Ada Lovelace", "detail": "Leads it"},
                {"title": "Grace Hopper", "detail": "Runs the beta"},
            ]
        return [
            {"title": "Design doc", "url": "https://example.com/docs/design", "detail": "What it is, and the choices made so far"},
            {"title": "Launch plan", "url": "https://example.com/docs/launch", "detail": "Dates, owners and the go/no-go list"},
            {"title": "Weekly notes", "url": "https://example.com/docs/weekly", "detail": "Decisions from the last three meetings"},
        ]
    if kind == "table":
        return {"columns": ["Item", "Owner", "Status"], "rows": [["Design review", "Ada", "Done"], ["Beta", "Grace", "In progress"], ["Launch", "Alan", "Not started"]]}
    if kind == "html":
        return ('<div class="banner" style="padding:12px 14px;border-radius:10px;background:#e7f6ec;color:#14532d">'
                "<strong>On track.</strong> The beta starts once the API review is done.</div>")
    return "On track: the design review closed last week, and the beta starts once the API review is done. Two risks are open, neither blocking."


def boxes_reply(message):
    """Answers a prompt an app's boxes added to: one JSON object, with a key for each box, and the
    conversation's details after it, as Glean's chat answers."""
    answer = {key: box_value(key, kind.lower(), about) for key, kind, about in BOX_LINE.findall(message)}
    return f"```json\n{json.dumps(answer, indent=2)}\n```\n\n---\nchatId: mock-{uuid.uuid4().hex[:12]}"


def chat_reply(message):
    """What the stand-in model says: an answer, the JSON an app's boxes ask for, or a page when
    asked for HTML."""
    if "one JSON object" in message and BOX_LINE.search(message):
        return boxes_reply(message)
    if "html" not in message.lower():
        return f"You said: {message}"
    request = message.split("\n", 1)[0].split(": ", 1)[-1].strip()
    if "dashboard" in request.lower():
        page = DASHBOARD_HTML.replace("{title}", html.escape(request[:1].upper() + request[1:60]))
    else:
        page = SCREEN_HTML.replace("{title}", html.escape(request[:60] or "Ask the mock"))
    return f"Here is a page for that.\n\n```html\n{page}```\n\nIts buttons and fields have ids, so an app can wire them up."


PROMPTS = [
    {
        "name": "greet",
        "title": "Greet someone",
        "description": "Writes a greeting in the style you ask for.",
        "arguments": [
            {"name": "name", "description": "Who to greet", "required": True},
            {"name": "style", "description": "formal or casual", "required": False},
        ],
    },
    {"name": "summarize_server", "title": "Summarize this server", "description": "Asks for a summary of the server, with its README attached."},
]
RESOURCE_NOT_FOUND = -32002


def search_notes_problems(args):
    """What a real server would turn search_notes away for: missing or malformed arguments."""
    schema = TOOLS_BY_NAME["search_notes"]["inputSchema"]
    problems = [f"{key} is required" for key in schema["required"] if args.get(key) in (None, "")]
    for key in ("after", "before"):
        if args.get(key) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(args[key])):
            problems.append(f"{key} must be a day, as YYYY-MM-DD, not {args[key]!r}")
    for key in ("author", "peer"):
        if args.get(key) and "@" not in str(args[key]):
            problems.append(f"{key} must be an email address, not {args[key]!r}")
    limit = args.get("limit")
    if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 50):
        problems.append(f"limit must be a whole number from 1 to 50, not {limit!r}")
    unknown = sorted(set(args) - set(schema["properties"]))
    if unknown:
        problems.append(f"unknown arguments: {', '.join(unknown)}")
    return problems


def rpc_error(request_id, code, message, data=None):
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def text_content(text):
    return {"type": "text", "text": text}


def decode_header(value):
    if value and value.startswith("=?base64?") and value.endswith("?="):
        return base64.b64decode(value[len("=?base64?"):-2]).decode("utf-8")
    return value


def header_string(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def header_params(schema, path=()):
    """(header name, property path) for every x-mcp-header reachable through properties."""
    for name, prop in (schema.get("properties") or {}).items():
        if "x-mcp-header" in prop:
            yield prop["x-mcp-header"], path + (name,)
        yield from header_params(prop, path + (name,))


def lookup(args, path):
    for key in path:
        if not isinstance(args, dict) or key not in args:
            return None
        args = args[key]
    return args


def origin_matches(pattern, origin):
    if pattern == "*":
        return True
    if pattern.endswith(":*"):
        base = pattern[:-2]
        port = origin[len(base) + 1:]
        return origin == base or (origin.startswith(base + ":") and port.isdigit())
    return origin == pattern


class Server(ThreadingHTTPServer):
    # HTTP/1.0 opens a connection per request, and a browser keeps up to six open per server, so
    # the default backlog of 5 refuses some of them under load (npm run bench).
    request_queue_size = 128


class Handler(BaseHTTPRequestHandler):
    server_version = "MockMCP/2.0"
    label = ""

    def log_message(self, format, *args):
        if self.server.verbose:
            super().log_message(format, *args)

    def do_OPTIONS(self):
        if not self.origin_allowed():
            return self.send_json(403, rpc_error(None, INVALID_REQUEST, "Forbidden: origin not allowed"))
        self.send_response(204)
        self.send_cors_headers(preflight=True)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if self.server.oauth and self.oauth_get(path, urllib.parse.parse_qs(query)):
            return
        # Neither era serves the standalone GET stream here; 405 is the specified answer.
        self.label = "GET"
        self.send_json(405, rpc_error(None, INVALID_REQUEST, "Method not allowed"))

    def do_DELETE(self):
        session_id = self.headers.get("Mcp-Session-Id")
        self.label = "DELETE session"
        with self.server.lock:
            ended = self.server.mode != "modern" and self.server.sessions.pop(session_id, None) is not None
        if ended:
            self.send_json(200, {})
        else:
            self.send_json(405, rpc_error(None, INVALID_REQUEST, "Method not allowed"))

    def do_POST(self):
        if not self.origin_allowed():
            return self.send_json(403, rpc_error(None, INVALID_REQUEST, "Forbidden: origin not allowed"))
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.server.token and self.headers.get("Authorization") != f"Bearer {self.server.token}":
            self.label = "unauthorized request"
            return self.send_json(
                401, rpc_error(None, -32001, "Unauthorized: send Authorization: Bearer <token>"),
                headers={"WWW-Authenticate": 'Bearer realm="mock-mcp"'},
            )
        if self.server.oauth:
            path = self.path.partition("?")[0]
            if path == "/oauth/register":
                return self.register(body)
            if path == "/oauth/token":
                return self.token(body)
            if not self.has_valid_access_token():
                self.label = "request without a valid access token"
                challenge = (
                    f'Bearer resource_metadata="{self.base_url()}/.well-known/oauth-protected-resource", '
                    'scope="mcp", error="invalid_token"'
                )
                return self.send_json(401, rpc_error(None, -32001, "Unauthorized"), headers={"WWW-Authenticate": challenge})
        if self.server.verbose:
            print(f"--> {dict(self.headers)}\n    {body.decode('utf-8', 'replace')}", flush=True)
        try:
            message = json.loads(body or b"null")
        except json.JSONDecodeError:
            return self.send_json(400, rpc_error(None, PARSE_ERROR, "Parse error"))
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or "method" not in message:
            return self.send_json(400, rpc_error(None, INVALID_REQUEST, "Invalid JSON-RPC request"))

        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        self.label = message["method"]
        if "id" not in message:
            return self.send_json(202, None)
        if message["method"] == "initialize":
            return self.handle_initialize(message, params)
        if "io.modelcontextprotocol/protocolVersion" in meta:
            return self.handle_modern(message, params, meta)
        return self.handle_legacy(message, params)

    # --- Modern (2026-07-28) ---

    def handle_modern(self, message, params, meta):
        if self.server.mode == "legacy":
            # What a 2025-era server says to any request that skipped initialize.
            return self.send_json(400, rpc_error(None, -32000, "Bad Request: No valid session ID provided"))
        self.label += " (modern)"
        version = meta.get("io.modelcontextprotocol/protocolVersion")
        problem = self.header_problem(message["method"], params, version)
        if problem:
            return self.send_json(400, rpc_error(message["id"], HEADER_MISMATCH, f"Header mismatch: {problem}"))
        if version != MODERN_VERSION:
            return self.send_json(400, rpc_error(
                message["id"], UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version",
                {"supported": self.supported_versions(), "requested": version},
            ))
        if "io.modelcontextprotocol/clientCapabilities" not in meta:
            return self.send_json(400, rpc_error(message["id"], INVALID_PARAMS, "_meta is missing io.modelcontextprotocol/clientCapabilities"))
        return self.dispatch(message, params, modern=True)

    def header_problem(self, method, params, version):
        if self.headers.get("MCP-Protocol-Version") != version:
            return f"MCP-Protocol-Version is {self.headers.get('MCP-Protocol-Version')!r} but _meta says {version!r}"
        if self.headers.get("Mcp-Method") != method:
            return f"Mcp-Method is {self.headers.get('Mcp-Method')!r} but the body calls {method!r}"
        name_field = {"tools/call": "name", "prompts/get": "name", "resources/read": "uri"}.get(method)
        if name_field and decode_header(self.headers.get("Mcp-Name")) != params.get(name_field):
            return f"Mcp-Name is {self.headers.get('Mcp-Name')!r} but params.{name_field} is {params.get(name_field)!r}"
        tool = TOOLS_BY_NAME.get(params.get("name")) if method == "tools/call" else None
        for header, path in header_params(tool["inputSchema"]) if tool else ():
            value = lookup(params.get("arguments") or {}, path)
            if value is None:
                continue
            sent = self.headers.get(f"Mcp-Param-{header}")
            if sent is None:
                return f"Mcp-Param-{header} is missing"
            if decode_header(sent) != header_string(value):
                return f"Mcp-Param-{header} is {sent!r} but the argument is {value!r}"
        return None

    def supported_versions(self):
        return [MODERN_VERSION] + (LEGACY_VERSIONS if self.server.mode == "dual" else [])

    # --- Legacy (2025-03-26 through 2025-11-25) ---

    def handle_initialize(self, message, params):
        requested = params.get("protocolVersion")
        if self.server.mode == "modern":
            return self.send_json(400, rpc_error(
                message["id"], UNSUPPORTED_PROTOCOL_VERSION,
                f"This server only supports MCP {MODERN_VERSION}, which has no initialize handshake.",
                {"supported": [MODERN_VERSION], "requested": requested},
            ))
        version = requested if requested in LEGACY_VERSIONS else LEGACY_VERSIONS[0]
        session_id = uuid.uuid4().hex
        with self.server.lock:
            self.server.sessions[session_id] = version
        self.label += f" (legacy {version})"
        self.respond(message["id"], {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}, "resources": {}, "prompts": {}},
            "serverInfo": SERVER_INFO,
            "instructions": "A mock server for testing MCP clients.",
        }, headers={"Mcp-Session-Id": session_id})

    def handle_legacy(self, message, params):
        if self.server.mode == "modern":
            return self.send_json(400, rpc_error(message["id"], HEADER_MISMATCH, "Requests need MCP 2026-07-28 _meta and headers"))
        session_id = self.headers.get("Mcp-Session-Id")
        if not session_id:
            return self.send_json(400, rpc_error(None, -32000, "Bad Request: No valid session ID provided"))
        with self.server.lock:
            version = self.server.sessions.get(session_id)
        if version is None:
            return self.send_json(404, rpc_error(None, -32001, "Session not found"))
        sent_version = self.headers.get("MCP-Protocol-Version")
        if sent_version and sent_version != version:
            return self.send_json(400, rpc_error(message["id"], INVALID_REQUEST, f"MCP-Protocol-Version {sent_version} doesn't match the session's {version}"))
        self.label += " (legacy)"
        return self.dispatch(message, params, modern=False)

    # --- Methods ---

    def dispatch(self, message, params, modern):
        method, request_id = message["method"], message["id"]
        if method == "server/discover" and modern:
            return self.respond(request_id, {
                "resultType": "complete",
                "supportedVersions": self.supported_versions(),
                "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
                "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO},
                "instructions": "A mock server for testing MCP clients.",
                "ttlMs": 60000,
                "cacheScope": "public",
            })
        if method == "tools/list":
            return self.list_tools(request_id, params, modern)
        if method == "tools/call":
            return self.call_tool(request_id, params, modern)
        if method == "resources/list":
            return self.list_page(request_id, params, modern, "resources", RESOURCES)
        if method == "resources/templates/list":
            return self.list_page(request_id, params, modern, "resourceTemplates", RESOURCE_TEMPLATES)
        if method == "resources/read":
            return self.read_resource(request_id, params, modern)
        if method == "prompts/list":
            return self.list_page(request_id, params, modern, "prompts", PROMPTS)
        if method == "prompts/get":
            return self.get_prompt(request_id, params, modern)
        return self.send_json(404 if modern else 200, rpc_error(request_id, METHOD_NOT_FOUND, f"Method not found: {method}"))

    # Lists PAGE_SIZE items at a time; the cursor is where the next page starts.
    def list_page(self, request_id, params, modern, key, items):
        try:
            start = int(params.get("cursor") or 0)
        except ValueError:
            return self.send_json(400 if modern else 200, rpc_error(request_id, INVALID_PARAMS, "Invalid cursor"))
        result = {"resultType": "complete", "ttlMs": 30000, "cacheScope": "public"} if modern else {}
        result[key] = items[start:start + PAGE_SIZE]
        if start + PAGE_SIZE < len(items):
            result["nextCursor"] = str(start + PAGE_SIZE)
        return self.respond(request_id, result)

    def read_resource(self, request_id, params, modern):
        uri = params.get("uri") or ""
        # Reads are cacheable in 2026-07-28, so they say for how long, as lists do.
        result = {"resultType": "complete", "ttlMs": 30000, "cacheScope": "public"} if modern else {}
        if uri == "mock://readme":
            contents = [{"uri": uri, "mimeType": "text/markdown", "text": README}]
        elif uri == "mock://config.json":
            settings = {"mode": self.server.mode, "sse": self.server.sse, "pageSize": PAGE_SIZE}
            contents = [{"uri": uri, "mimeType": "application/json", "text": json.dumps(settings)}]
        elif uri == "mock://pixel.png":
            contents = [{"uri": uri, "mimeType": "image/png", "blob": PIXEL_PNG}]
        elif uri.startswith("mock://notes/") and uri.removeprefix("mock://notes/").isdigit():
            contents = [{"uri": uri, "mimeType": "text/plain", "text": f"Note {uri.removeprefix('mock://notes/')}: remember to test the templates."}]
        else:
            return self.send_json(200, rpc_error(request_id, RESOURCE_NOT_FOUND, f"Resource not found: {uri}", {"uri": uri}))
        return self.respond(request_id, {**result, "contents": contents})

    def get_prompt(self, request_id, params, modern):
        name, args = params.get("name"), params.get("arguments") or {}
        result = {"resultType": "complete"} if modern else {}
        if name == "greet":
            if not args.get("name"):
                return self.send_json(200, rpc_error(request_id, INVALID_PARAMS, "greet needs the argument name"))
            style = args.get("style") or "casual"
            text = f"Write a {style} greeting for {args['name']}."
            return self.respond(request_id, {**result, "description": "A greeting", "messages": [{"role": "user", "content": text_content(text)}]})
        if name == "summarize_server":
            return self.respond(request_id, {**result, "description": "A summary of this server", "messages": [
                {"role": "user", "content": {"type": "resource", "resource": {"uri": "mock://readme", "mimeType": "text/markdown", "text": README}}},
                {"role": "user", "content": text_content("Summarize what this server offers, in two sentences.")},
            ]})
        return self.send_json(200, rpc_error(request_id, INVALID_PARAMS, f"Unknown prompt: {name}"))

    def list_tools(self, request_id, params, modern):
        if not modern:
            return self.respond(request_id, {"tools": LEGACY_TOOLS})
        try:
            start = int(params.get("cursor") or 0)
        except ValueError:
            return self.send_json(400, rpc_error(request_id, INVALID_PARAMS, "Invalid cursor"))
        result = {"resultType": "complete", "tools": TOOLS[start:start + PAGE_SIZE], "ttlMs": 30000, "cacheScope": "public"}
        if start + PAGE_SIZE < len(TOOLS):
            result["nextCursor"] = str(start + PAGE_SIZE)
        return self.respond(request_id, result)

    def call_tool(self, request_id, params, modern):
        name, args = params.get("name"), params.get("arguments") or {}
        available = TOOLS if modern else LEGACY_TOOLS
        if name not in {tool["name"] for tool in available}:
            return self.send_json(200, rpc_error(request_id, INVALID_PARAMS, f"Unknown tool: {name}"))
        result = {"resultType": "complete"} if modern else {}
        steps = 0
        if name == "echo":
            text = f"Echo: {args.get('text', '')}"
        elif name == "echo_region":
            text = f"Echo from {args.get('region')}: {args.get('text', '')}"
        elif name == "count":
            steps = max(1, min(int(args.get("n", 3)), 10))
            text = f"Counted to {steps}"
            result["structuredContent"] = {"counted": steps}
        elif name == "ticket":
            with self.server.lock:
                self.server.tickets += 1
                number = self.server.tickets
            text = f"{args.get('prefix', 'T-')}{number}"
        elif name == "search_notes":
            problems = search_notes_problems(args)
            if problems:
                return self.respond(request_id, {**result, "content": [text_content("; ".join(problems))], "isError": True})
            text = f"No notes match. Searched with {json.dumps(args, sort_keys=True, ensure_ascii=False)}"
        elif name == "chat":
            text = chat_reply(str(args.get("message", "")))
        elif name == "make_screen":
            page = SCREEN_HTML.replace("{title}", html.escape(str(args.get("title") or "Ask the mock")))
            return self.respond(request_id, {**result, "content": [
                text_content("Here is the screen."),
                {"type": "resource", "resource": {"uri": "mock://screen.html", "mimeType": "text/html", "text": page}},
            ]})
        else:
            return self.respond(request_id, {**result, "content": [text_content("This tool shouldn't be callable.")], "isError": True})
        progress_token = (params.get("_meta") or {}).get("progressToken")
        self.respond(request_id, {**result, "content": [text_content(text)]}, steps=steps, progress_token=progress_token)

    # --- OAuth (--oauth): metadata, registration, an authorize endpoint that approves at once, tokens ---

    def base_url(self):
        return f"http://{self.headers.get('Host')}"

    def oauth_get(self, path, query):
        base = self.base_url()
        issuer = f"{base}/oauth"
        if path == "/.well-known/oauth-protected-resource":
            self.label = "protected resource metadata"
            self.send_json(200, {
                "resource": f"{base}/",
                "authorization_servers": [issuer],
                "scopes_supported": ["mcp"],
                "bearer_methods_supported": ["header"],
            })
        elif path == "/.well-known/oauth-authorization-server/oauth":
            self.label = "authorization server metadata"
            self.send_json(200, {
                "issuer": issuer,
                "authorization_endpoint": f"{issuer}/authorize",
                "token_endpoint": f"{issuer}/token",
                "registration_endpoint": f"{issuer}/register",
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["none"],
                "scopes_supported": ["mcp", "offline_access"],
                "authorization_response_iss_parameter_supported": True,
            })
        elif path == "/oauth/authorize":
            self.authorize(query, base, issuer)
        else:
            return False
        return True

    def register(self, body):
        self.label = "client registration"
        try:
            request = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return self.oauth_error("invalid_client_metadata", "the body isn't JSON")
        redirect_uris = request.get("redirect_uris")
        if not isinstance(redirect_uris, list) or not redirect_uris or not all(isinstance(u, str) for u in redirect_uris):
            return self.oauth_error("invalid_redirect_uri", "redirect_uris must list at least one URI")
        if request.get("application_type") not in ("native", "web"):
            return self.oauth_error("invalid_client_metadata", "application_type must be native or web")
        client_id = uuid.uuid4().hex
        with self.server.lock:
            self.server.oauth_clients[client_id] = redirect_uris
        self.send_json(201, {
            "client_id": client_id,
            "client_id_issued_at": int(time.time()),
            "redirect_uris": redirect_uris,
            "grant_types": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_method": "none",
            "application_type": request["application_type"],
        })

    def authorize(self, query, base, issuer):
        self.label = "authorization request"
        def one(name):
            return (query.get(name) or [None])[0]
        client_id, redirect_uri = one("client_id"), one("redirect_uri")
        with self.server.lock:
            registered = self.server.oauth_clients.get(client_id)
        if not registered or redirect_uri not in registered:
            return self.send_text(400, "Unknown client, or a redirect URI it didn't register.")
        problem = None
        if one("response_type") != "code":
            problem = "response_type must be code"
        elif one("code_challenge_method") != "S256" or not one("code_challenge"):
            problem = "PKCE with S256 is required"
        elif one("resource") != f"{base}/":
            problem = f"resource must be {base}/"
        elif not one("state"):
            problem = "state is required"
        if problem:
            return self.redirect(redirect_uri, {"error": "invalid_request", "error_description": problem, "state": one("state") or "", "iss": issuer})
        code = uuid.uuid4().hex
        with self.server.lock:
            self.server.oauth_codes[code] = {
                "client_id": client_id, "redirect_uri": redirect_uri, "challenge": one("code_challenge"),
                "resource": one("resource"), "scope": one("scope"),
            }
        iss = "http://impostor.test/oauth" if self.server.oauth_wrong_iss else issuer
        self.redirect(redirect_uri, {"code": code, "state": one("state"), "iss": iss})

    def token(self, body):
        form = {name: values[0] for name, values in urllib.parse.parse_qs(body.decode("utf-8")).items()}
        grant = form.get("grant_type")
        self.label = f"token ({grant})"
        if grant == "authorization_code":
            with self.server.lock:
                issued = self.server.oauth_codes.pop(form.get("code"), None)
            if not issued:
                return self.oauth_error("invalid_grant", "unknown or already used code")
            verifier = (form.get("code_verifier") or "").encode()
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier).digest()).rstrip(b"=").decode()
            if challenge != issued["challenge"]:
                return self.oauth_error("invalid_grant", "code_verifier doesn't match the code_challenge")
            if form.get("client_id") != issued["client_id"]:
                return self.oauth_error("invalid_client", "client_id doesn't match the code")
            if form.get("redirect_uri") != issued["redirect_uri"]:
                return self.oauth_error("invalid_grant", "redirect_uri doesn't match the authorization request")
            if form.get("resource") != issued["resource"]:
                return self.oauth_error("invalid_target", "resource doesn't match the authorization request")
            return self.issue_tokens(issued["client_id"], issued["resource"], issued["scope"])
        if grant == "refresh_token":
            with self.server.lock:
                held = self.server.oauth_refresh.pop(form.get("refresh_token"), None)
            if not held:
                return self.oauth_error("invalid_grant", "unknown or already used refresh token")
            if form.get("client_id") != held["client_id"]:
                return self.oauth_error("invalid_client", "client_id doesn't match the refresh token")
            if form.get("resource") not in (None, held["resource"]):
                return self.oauth_error("invalid_target", "resource doesn't match the refresh token")
            return self.issue_tokens(held["client_id"], held["resource"], held["scope"])
        self.oauth_error("unsupported_grant_type", f"grant_type {grant!r} isn't supported")

    def issue_tokens(self, client_id, resource, scope):
        access, refresh = uuid.uuid4().hex, uuid.uuid4().hex
        with self.server.lock:
            self.server.oauth_access[access] = time.time() + self.server.token_ttl
            # Refresh tokens rotate: each one works once.
            self.server.oauth_refresh[refresh] = {"client_id": client_id, "resource": resource, "scope": scope}
        reply = {"access_token": access, "token_type": "Bearer", "refresh_token": refresh, "scope": scope or "mcp"}
        if not self.server.omit_expires_in:
            reply["expires_in"] = self.server.token_ttl
        self.send_json(200, reply, headers={"Cache-Control": "no-store"})

    def oauth_error(self, error, description):
        self.send_json(400, {"error": error, "error_description": description})

    def has_valid_access_token(self):
        header = self.headers.get("Authorization") or ""
        token = header[len("Bearer "):] if header.startswith("Bearer ") else None
        with self.server.lock:
            expires = self.server.oauth_access.get(token)
        return expires is not None and expires > time.time()

    def redirect(self, location, params):
        separator = "&" if "?" in location else "?"
        self.send_response(302)
        self.send_header("Location", location + separator + urllib.parse.urlencode(params))
        self.send_header("Content-Length", "0")
        self.end_headers()
        print(f"{self.command} {self.label} -> 302", flush=True)

    def send_text(self, status, text):
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        print(f"{self.command} {self.label} -> {status}", flush=True)

    # --- Responses ---

    def respond(self, request_id, result, headers=None, steps=0, progress_token=None):
        reply = {"jsonrpc": "2.0", "id": request_id, "result": result}
        if not self.server.sse:
            return self.send_json(200, reply, headers)
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        if self.keeps_alive():
            # The stream ends with its last chunk, not the connection.
            self.send_header("Transfer-Encoding", "chunked")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        # CRLF line endings and keep-alive comments exercise the client's SSE parser.
        self.write_event(": stream opened")
        for step in range(1, steps + 1):
            time.sleep(0.05)
            if progress_token is None:
                self.write_event(f": working {step}/{steps}")
            else:
                self.write_event(self.sse_data({
                    "jsonrpc": "2.0", "method": "notifications/progress",
                    "params": {"progressToken": progress_token, "progress": step, "total": steps},
                }))
        self.write_event(f"id: {request_id}\r\nevent: message\r\n" + self.sse_data(reply))
        if self.keeps_alive():
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        print(f"POST {self.label} -> 200 (SSE)", flush=True)

    @staticmethod
    def sse_data(message):
        return f"data: {json.dumps(message)}"

    def keeps_alive(self):
        return self.protocol_version == "HTTP/1.1"

    def write_event(self, text):
        data = (text + "\r\n\r\n").encode("utf-8")
        if self.keeps_alive():
            data = f"{len(data):X}\r\n".encode() + data + b"\r\n"
        self.wfile.write(data)
        self.wfile.flush()

    def send_json(self, status, body, headers=None):
        data = b"" if body is None else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)
        print(f"{self.command} {self.label or self.path} -> {status}", flush=True)

    def send_cors_headers(self, preflight=False):
        origin = self.headers.get("Origin")
        if origin and self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            exposed = "Mcp-Session-Id" if self.server.hide_www_authenticate else "Mcp-Session-Id, WWW-Authenticate"
            self.send_header("Access-Control-Expose-Headers", exposed)
        if preflight:
            self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
            # By default, echo the request's list: it covers every Mcp-Param-* header and Authorization.
            allowed = self.server.allowed_headers or self.headers.get("Access-Control-Request-Headers") or "Content-Type"
            self.send_header("Access-Control-Allow-Headers", allowed)
            self.send_header("Access-Control-Max-Age", "600")

    def origin_allowed(self):
        origin = self.headers.get("Origin")
        return origin is None or any(origin_matches(p, origin) for p in self.server.allowed_origins)


def main():
    parser = argparse.ArgumentParser(description="Mock MCP server for local testing.")
    parser.add_argument("--mode", choices=["modern", "legacy", "dual"], default="dual")
    parser.add_argument("--sse", action="store_true", help="answer requests with SSE streams instead of JSON")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument(
        "--allow-origin", action="append", dest="allowed_origins", metavar="ORIGIN",
        help="browser origin to accept; repeatable, ':*' matches any port, '*' allows all "
             "(default: http://localhost:* and http://127.0.0.1:*)",
    )
    parser.add_argument("--token", help="require Authorization: Bearer TOKEN on every request")
    parser.add_argument(
        "--oauth", action="store_true",
        help="require an OAuth sign-in: serves resource and authorization server metadata, client registration, "
             "an authorize endpoint that approves at once, and a token endpoint",
    )
    parser.add_argument("--hide-www-authenticate", action="store_true", help="don't let browsers read WWW-Authenticate, as Glean does")
    parser.add_argument("--token-ttl", type=int, default=3600, metavar="SECONDS", help="how long OAuth access tokens last (default 3600)")
    parser.add_argument("--oauth-wrong-iss", action="store_true", help="name the wrong issuer in authorization responses, which clients must reject")
    parser.add_argument("--omit-expires-in", action="store_true", help="leave expires_in out of token responses, so clients learn of expiry from a 401")
    parser.add_argument(
        "--allow-headers", metavar="LIST",
        help="headers CORS preflights allow, e.g. 'Content-Type, Mcp-Session-Id' "
             "(default: whatever the browser asks for)",
    )
    parser.add_argument(
        "--keep-alive", action="store_true",
        help="speak HTTP/1.1 and keep connections open between requests, as most servers do, "
             "instead of HTTP/1.0's connection per request (npm run bench)",
    )
    parser.add_argument("--verbose", action="store_true", help="print request headers and bodies")
    args = parser.parse_args()

    if args.keep_alive:
        Handler.protocol_version = "HTTP/1.1"
    server = Server((args.host, args.port), Handler)
    server.mode = args.mode
    server.sse = args.sse
    server.verbose = args.verbose
    server.allowed_origins = args.allowed_origins or DEFAULT_ORIGINS
    server.allowed_headers = args.allow_headers
    server.token = args.token
    server.oauth = args.oauth
    server.hide_www_authenticate = args.hide_www_authenticate
    server.token_ttl = args.token_ttl
    server.oauth_wrong_iss = args.oauth_wrong_iss
    server.omit_expires_in = args.omit_expires_in
    server.oauth_clients, server.oauth_codes, server.oauth_access, server.oauth_refresh = {}, {}, {}, {}
    server.sessions = {}
    server.tickets = 0
    server.lock = threading.Lock()
    url = f"http://{args.host}:{args.port}"
    features = [args.mode] + (["SSE replies"] if args.sse else []) + (["bearer token required"] if args.token else [])
    if args.oauth:
        features.append(f"OAuth sign-in, tokens last {args.token_ttl} s")
    print(f"Mock MCP server ({', '.join(features)}) on {url}", flush=True)
    print(f"  Browser origins allowed: {', '.join(server.allowed_origins)}", flush=True)
    if args.allow_headers:
        print(f"  CORS preflights allow only: {args.allow_headers}", flush=True)
    print(f"  In the client, add {url} with + beside Servers (the Guide has a button for it). Ctrl+C stops the server.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
