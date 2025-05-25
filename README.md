# MCP Browser Client

A Rust WebAssembly-based browser client for MCP (Message Control Protocol) that runs as a service worker, enabling multi-tab communication capabilities.

## Prerequisites

- Python 3.x
- Node.js
- Rust (latest stable version)
  - Install via rustup: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

## Project Structure

```
.
├── src/               # Rust source code
├── public/           # Web assets and service worker
├── target/           # Build output
├── venv/             # Python virtual environment
├── node_modules/     # Node.js dependencies
├── Cargo.toml        # Rust project configuration
├── package.json      # Node.js configuration
├── requirements.txt  # Python dependencies
└── wasm-build.sh     # WASM build script
```

## Quick Start

1. Run the setup script:
```bash
./setup.sh
```

2. Start the web server:
```bash
npm start
```

3. (Optional) Start the mock MCP server for testing:
```bash
npm run start:mock-mcp
```

## Using Your Own MCP Server

The browser client is designed to work with any MCP server implementation. By default, it connects to `localhost:8081`. To use your own MCP server:

1. Ensure your MCP server is running on port 8081 (or modify the connection settings in `src/lib.rs`)
2. Start the web server:
```bash
npm start
```

## Manual Setup

If you prefer to set up manually:

1. Install Rust:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

2. Set up Python environment (for mock MCP server):
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

3. Install Node.js dependencies:
```bash
npm install
```

4. Set up Rust/WASM:
```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
./wasm-build.sh
```

## Development

### Available Scripts

- `npm start`: Start the web server
- `npm run build`: Build the WASM module
- `npm run start:mock-mcp`: Start the mock MCP server for testing

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

## Testing

The included mock MCP server provides a simple echo service that:
- Listens on port 8081
- Logs all received messages to `mcp_server.log`
- Echoes messages back to the client
- Displays messages in the terminal

You can test the system by:
1. Starting the mock MCP server: `npm run start:mock-mcp`
2. Opening multiple browser tabs to `http://localhost:8080`
3. Sending messages through the chat interface
4. Observing the messages in:
   - The browser's chat interface
   - The MCP server terminal window
   - The `mcp_server.log` file

## Troubleshooting

1. If the service worker isn't loading:
   - Check browser console for errors
   - Ensure `mcp_client_bg.wasm` is in the `public` directory
   - Try clearing browser cache

2. If messages aren't being received:
   - Verify your MCP server is running
   - Check the MCP server log file
   - Ensure port 8081 is available
   - Verify the connection settings in `src/lib.rs`

## License

MIT License 