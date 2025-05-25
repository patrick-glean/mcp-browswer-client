#!/usr/bin/env python3

import asyncio
import logging
import json
from datetime import datetime

# Configure logging
logging.basicConfig(
    filename='mcp_server.log',
    level=logging.INFO,
    format='%(asctime)s - %(message)s'
)

class MCPServer:
    def __init__(self, host='localhost', port=8081):
        self.host = host
        self.port = port
        self.clients = set()

    async def handle_client(self, reader, writer):
        addr = writer.get_extra_info('peername')
        print(f"\nNew connection from {addr}")
        self.clients.add(writer)

        try:
            while True:
                data = await reader.read(1024)
                if not data:
                    break

                message = data.decode()
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                
                # Log the message
                log_message = f"Received from {addr}: {message}"
                logging.info(log_message)
                print(f"\n{log_message}")

                # Echo back to the client
                response = {
                    "timestamp": timestamp,
                    "message": message,
                    "status": "received"
                }
                writer.write(json.dumps(response).encode())
                await writer.drain()

        except Exception as e:
            print(f"Error handling client {addr}: {e}")
        finally:
            self.clients.remove(writer)
            writer.close()
            print(f"Connection closed for {addr}")

    async def start(self):
        server = await asyncio.start_server(
            self.handle_client, self.host, self.port
        )

        print(f"\nMCP Server running on {self.host}:{self.port}")
        print("Press Ctrl+C to stop the server")
        print("Messages will be logged to mcp_server.log\n")

        async with server:
            await server.serve_forever()

def main():
    server = MCPServer()
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("\nServer stopped by user")

if __name__ == "__main__":
    main() 