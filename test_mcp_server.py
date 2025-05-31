#!/usr/bin/env python3

import asyncio
import logging
import json
from datetime import datetime
from aiohttp import web
from aiohttp_cors import setup as cors_setup, ResourceOptions, CorsViewMixin

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('mcp_server.log'),
        logging.StreamHandler()
    ]
)

# MCP Protocol Constants
JSONRPC_VERSION = "2.0"
PROTOCOL_VERSION = "2025-03-26"

# JSON-RPC Error Codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

class MCPServer:
    def __init__(self, host='localhost', port=8081):
        self.host = host
        self.port = port
        self.app = web.Application()
        self.setup_routes()
        self.setup_cors()
        self.tools = {
            "echo": {
                "name": "echo",
                "description": "Echoes back the input text",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"}
                    },
                    "required": ["text"]
                }
            }
        }
        logging.info(f"MCPServer initialized on {host}:{port}")

    def setup_cors(self):
        cors = cors_setup(self.app, defaults={
            "*": ResourceOptions(
                allow_credentials=True,
                expose_headers="*",
                allow_headers="*",
                allow_methods="*"
            )
        })
        
        for route in list(self.app.router.routes()):
            cors.add(route)
        logging.info("CORS configured for all routes")

    def setup_routes(self):
        self.app.router.add_post('/', self.handle_mcp_message)
        logging.info("Routes configured: POST on /")

    def create_response(self, id, result=None):
        response = {
            "jsonrpc": JSONRPC_VERSION,
            "id": id
        }
        if result is not None:
            response["result"] = result
        return response

    def create_error_response(self, id, code, message, data=None):
        response = {
            "jsonrpc": JSONRPC_VERSION,
            "id": id,
            "error": {
                "code": code,
                "message": message
            }
        }
        if data is not None:
            response["error"]["data"] = data
        return response

    async def handle_initialize(self, params, id):
        return self.create_response(id, {
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": {
                "name": "Mock MCP Server",
                "version": "1.0.0"
            },
            "capabilities": {
                "tools": {
                    "listChanged": True
                }
            },
            "tools": [
                {
                    "name": "echo",
                    "description": "Echo test tool for MCP server.",
                    "version": "1.0.0",
                    "parameters": [
                        {
                            "name": "message",
                            "description": "Message to echo back.",
                            "required": True,
                            "type": "string"
                        }
                    ]
                }
            ]
        })

    async def handle_tools_list(self, params, id):
        # Return tools in MCP spec-compliant format
        return self.create_response(id, {
            "tools": [
                {
                    "name": "echo",
                    "description": "Echoes back the input text",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string", "description": "Text to echo back."}
                        },
                        "required": ["text"],
                        "additionalProperties": False
                    }
                }
            ]
        })

    async def handle_echo_tool(self, params, id):
        if "text" not in params:
            return self.create_error_response(id, INVALID_PARAMS, "Missing required parameter: text")
        
        return self.create_response(id, {
            "text": f"Echo: {params['text']}"
        })

    async def handle_health_check(self, params, id):
        return self.create_response(id, {
            "status": "healthy",
            "uptime": 0,  # TODO: Add actual uptime tracking
            "version": "1.0.0"
        })

    async def handle_tools_call(self, params, id):
        # For the echo tool, just echo back the text argument
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if tool_name == "echo":
            text = arguments.get("text", "")
            return self.create_response(id, {
                "content": [
                    {
                        "type": "text",
                        "text": f"Echo: {text}"
                    }
                ]
            })
        else:
            return self.create_error_response(id, METHOD_NOT_FOUND, f"Tool '{tool_name}' not found")

    async def handle_mcp_message(self, request):
        try:
            # Log request headers and body
            headers = dict(request.headers)
            body = await request.text()
            logging.info(f"Incoming request headers: {json.dumps(headers, indent=2)}")
            logging.info(f"Incoming request body: {body}")
            print("\n--- Incoming Request ---")
            print("Headers:", json.dumps(headers, indent=2))
            print("Body:", body)
            # Handle JSON-RPC messages
            try:
                message = json.loads(body)
            except json.JSONDecodeError:
                return web.json_response(
                    self.create_error_response(None, PARSE_ERROR, "Invalid JSON")
                )
            if not isinstance(message, dict):
                return web.json_response(
                    self.create_error_response(None, INVALID_REQUEST, "Invalid message format")
                )
            if message.get("jsonrpc") != JSONRPC_VERSION:
                return web.json_response(
                    self.create_error_response(message.get("id"), INVALID_REQUEST, "Invalid JSON-RPC version")
                )
            method = message.get("method")
            params = message.get("params", {})
            id = message.get("id")
            if not method:
                return web.json_response(
                    self.create_error_response(id, INVALID_REQUEST, "Method is required")
                )
            # Route the message to the appropriate handler
            if method == "initialize":
                response = await self.handle_initialize(params, id)
            elif method == "tools/list":
                response = await self.handle_tools_list(params, id)
            elif method == "tools/call":
                response = await self.handle_tools_call(params, id)
            elif method == "tool/echo":
                response = await self.handle_echo_tool(params, id)
            elif method == "health_check":
                response = await self.handle_health_check(params, id)
            else:
                response = self.create_error_response(id, METHOD_NOT_FOUND, f"Method '{method}' not found")
            # Log outgoing response
            logging.info(f"Outgoing response: {json.dumps(response, indent=2)}")
            print("--- Outgoing Response ---")
            print(json.dumps(response, indent=2))
            return web.json_response(response)
        except Exception as e:
            logging.error(f"Error handling request: {str(e)}", exc_info=True)
            return web.json_response(
                self.create_error_response(None, INTERNAL_ERROR, str(e))
            )

    async def start(self):
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, self.host, self.port)
        await site.start()

        logging.info(f"MCP Server running on {self.host}:{self.port}")
        print(f"\nMCP Server running on {self.host}:{self.port}")
        print("Press Ctrl+C to stop the server")
        print("Messages will be logged to mcp_server.log\n")

        try:
            while True:
                await asyncio.sleep(3600)
        except KeyboardInterrupt:
            logging.info("Server stopped by user")
            print("\nServer stopped by user")
            await runner.cleanup()

def main():
    server = MCPServer()
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        logging.info("Server stopped by user")
        print("\nServer stopped by user")

if __name__ == "__main__":
    main() 