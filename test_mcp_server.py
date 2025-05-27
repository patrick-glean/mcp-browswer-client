#!/usr/bin/env python3

import asyncio
import logging
import json
from datetime import datetime
from aiohttp import web
from aiohttp_cors import setup as cors_setup, ResourceOptions, CorsViewMixin

# Configure logging to both file and console
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('mcp_server.log'),
        logging.StreamHandler()  # This will log to console
    ]
)

class MCPServer:
    def __init__(self, host='localhost', port=8081):
        self.host = host
        self.port = port
        self.app = web.Application()
        self.setup_routes()
        self.setup_cors()
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
        
        # Configure CORS for all routes
        for route in list(self.app.router.routes()):
            cors.add(route)
        logging.info("CORS configured for all routes")

    def setup_routes(self):
        self.app.router.add_get('/', self.handle_get)
        self.app.router.add_post('/', self.handle_post)
        logging.info("Routes configured: GET and POST on /")

    async def handle_get(self, request):
        """Handle GET requests - return server status"""
        client = request.remote
        logging.info(f"Received GET request from {client}")
        
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        response = {
            "timestamp": timestamp,
            "status": "running",
            "message": "MCP server is running",
            "type": "status"
        }
        logging.info(f"Sending response: {json.dumps(response)}")
        return web.json_response(response)

    async def handle_post(self, request):
        """Handle POST requests - process messages and health checks"""
        client = request.remote
        logging.info(f"Received POST request from {client}")
        
        try:
            # Get the request body
            body = await request.text()
            logging.info(f"Request body: {body}")
            
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            
            # Handle health check
            if body == "HEALTH_CHECK":
                response = {
                    "timestamp": timestamp,
                    "status": "healthy",
                    "message": "MCP server is running",
                    "type": "health_check"
                }
                logging.info(f"Sending health check response: {json.dumps(response)}")
                return web.json_response(response)

            # Log the message
            log_message = f"Received message: {body}"
            logging.info(log_message)
            print(f"\n{log_message}")

            # Echo back to the client
            response = {
                "timestamp": timestamp,
                "message": body,
                "status": "received",
                "type": "message"
            }
            logging.info(f"Sending response: {json.dumps(response)}")
            return web.json_response(response)

        except Exception as e:
            error_msg = f"Error handling request: {str(e)}"
            logging.error(error_msg, exc_info=True)
            return web.json_response({
                "error": str(e),
                "status": "error"
            }, status=500)

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
                await asyncio.sleep(3600)  # Keep the server running
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