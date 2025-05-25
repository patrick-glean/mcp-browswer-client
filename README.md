# MCP Browser Client

A Rust WebAssembly-based browser client for MCP (Message Control Protocol) that runs as a service worker, enabling multi-tab communication capabilities.

## Prerequisites

- Rust (latest stable version)
- wasm-pack
- Node.js (for serving the web application)
- Python 3.x (for the test MCP server)

## Project Structure

```
.
├── src/               # Rust source code
├── public/           # Web assets and service worker
├── target/           # Build output
├── Cargo.toml        # Rust project configuration
└── wasm-build.sh     # WASM build script
```

## Setup

1. Install Rust and wasm-pack:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack
```

2. Install Node.js dependencies:
```bash
npm install -g http-server
```

3. Build the WASM module:
```bash
./wasm-build.sh
```

## Running the Application

1. Start the test MCP server (in a separate terminal):
```bash
python3 test_mcp_server.py
```

2. Start the web server:
```bash
http-server public
```

3. Open your browser to `http://localhost:8080`

## Testing

The test MCP server (`test_mcp_server.py`) provides a simple echo service that:
- Listens on port 8081
- Logs all received messages to `mcp_server.log`
- Echoes messages back to the client
- Displays messages in the terminal

You can test the system by:
1. Opening multiple browser tabs to `http://localhost:8080`
2. Sending messages through the chat interface
3. Observing the messages in:
   - The browser's chat interface
   - The MCP server terminal window
   - The `mcp_server.log` file

## Development

### Modifying the Rust Code
1. Edit `src/lib.rs`
2. Rebuild WASM:
```bash
./wasm-build.sh
```
3. Refresh your browser

### Modifying the Web Interface
1. Edit files in the `public` directory
2. Refresh your browser

## Troubleshooting

1. If the service worker isn't loading:
   - Check browser console for errors
   - Ensure `mcp_client_bg.wasm` is in the `public` directory
   - Try clearing browser cache

2. If messages aren't being received:
   - Verify the MCP server is running
   - Check the MCP server log file
   - Ensure port 8081 is available

## License

MIT License 