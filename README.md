# MCP Browser Client

A Rust WebAssembly-based browser client for MCP (Message Control Protocol) that runs as a service worker, enabling multi-tab communication capabilities.

## Prerequisites

- Python 3.x
- Node.js
- Rust (latest stable version)

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

2. Start the development environment:
```bash
npm run dev
```

This will:
- Start the web server on port 8080
- Start the MCP test server on port 8081
- Build and serve the WASM module

## Manual Setup

If you prefer to set up manually:

1. Set up Python environment:
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

2. Install Node.js dependencies:
```bash
npm install
```

3. Set up Rust/WASM:
```bash
cargo install wasm-pack
./wasm-build.sh
```

## Development

### Available Scripts

- `npm start`: Start the web server
- `npm run build`: Build the WASM module
- `npm run dev`: Start both web server and MCP test server

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

The test MCP server provides a simple echo service that:
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