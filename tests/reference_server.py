#!/usr/bin/env python3
"""A reference MCP server built on the official Python SDK (v2), for interop testing.

    venv/bin/python tests/reference_server.py [--port 8082] [--sse]

It serves MCP 2026-07-28 (and the older revisions) statelessly at http://127.0.0.1:PORT/mcp,
with CORS so the browser client can call it from a local origin.
"""

import argparse

import uvicorn
from mcp.server.mcpserver import MCPServer
from starlette.middleware.cors import CORSMiddleware

LOCAL_ORIGINS = r"http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"

server = MCPServer("Reference Server")


@server.tool()
def echo(text: str) -> str:
    """Echoes back the input text."""
    return f"Echo: {text}"


@server.tool()
def add(a: int, b: int) -> str:
    """Adds two integers."""
    return str(a + b)


def main():
    parser = argparse.ArgumentParser(description="Reference MCP server on the official Python SDK.")
    parser.add_argument("--port", type=int, default=8082)
    parser.add_argument("--sse", action="store_true", help="stream replies over SSE instead of returning JSON")
    args = parser.parse_args()

    app = server.streamable_http_app(stateless_http=True, json_response=not args.sse)
    # The SDK checks Origin against localhost itself; browsers also need CORS headers.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=LOCAL_ORIGINS,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["Mcp-Session-Id"],
    )
    replies = "SSE" if args.sse else "JSON"
    print(f"Reference MCP server (official Python SDK, {replies} replies) on http://127.0.0.1:{args.port}/mcp", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
