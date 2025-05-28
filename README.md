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
├── src/                    # Rust source code
│   ├── lib.rs             # Main Rust implementation and MCP protocol
│   └── build_info.rs      # Generated build metadata
├── public/                # Web assets and service worker
│   ├── mcp_browser_client_bg.wasm  # Compiled WASM module
│   ├── mcp_browser_client.js       # Generated JS bindings
│   ├── sw.js              # Service worker
│   ├── index.html         # Web interface
│   └── styles.css         # UI styles
├── venv/                  # Python virtual environment
├── node_modules/          # Node.js dependencies
├── .cursor/               # Cursor IDE configuration
├── Cargo.toml             # Rust project configuration
├── package.json           # Node.js configuration
├── requirements.txt       # Python dependencies
├── wasm-build.sh          # WASM build script
├── generate-build-info.sh # Build metadata generator
└── setup.sh              # Project setup script
```

## Build Workflow

1. **Build Info Generation**
   - `generate-build-info.sh` creates `src/build_info.rs`
   - Tracks source file changes via SHA256 hashes
   - Includes build timestamp and source hash

2. **WASM Build Process**
   - `wasm-build.sh` orchestrates the build:
     1. Generates build info
     2. Ensures wasm-bindgen-cli is installed
     3. Builds WASM module with `cargo build`
     4. Generates JS bindings with `wasm-bindgen`
     5. Outputs to `public/` directory

3. **Service Worker Integration**
   - WASM module loaded by service worker
   - JS bindings provide Rust-WASM interface
   - Multi-tab communication via service worker

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

## Development

### Available Scripts

- `npm start`: Start the web server
- `npm run build`: Build the WASM module
- `npm run start:mock-mcp`: Start the mock MCP server for testing

### Modifying the Rust Code
1. Edit `src/lib.rs` for MCP protocol implementation
2. Rebuild WASM:
```bash
./wasm-build.sh
```
3. Refresh your browser

### Modifying the Web Interface
1. Edit files in the `public` directory
2. Refresh your browser

## Testing

The included mock MCP server provides:
- Echo service on port 8081
- Message logging to `mcp_server.log`
- Terminal output for debugging

Test the system by:
1. Starting the mock MCP server: `npm run start:mock-mcp`
2. Opening multiple browser tabs to `http://localhost:8080`
3. Using the web interface to:
   - Check WASM status
   - Initialize MCP connection
   - List available tools
   - Send test messages

## Troubleshooting

1. **Service Worker Issues**
   - Check browser console for errors
   - Verify WASM files in `public/` directory
   - Clear browser cache if needed

2. **MCP Connection Problems**
   - Verify MCP server is running
   - Check `mcp_server.log`
   - Ensure port 8081 is available
   - Verify connection settings in `src/lib.rs`

3. **WASM Loading Failures**
   - Check `public/` for correct WASM files
   - Verify build script completion
   - Check browser console for errors

## Architecture

The project follows a layered architecture:
1. **Rust/WASM Layer**
   - Core MCP protocol implementation in `lib.rs`
   - Message handling and state management
   - Build metadata tracking

2. **Service Worker Layer**
   - WASM module loading
   - Multi-tab communication
   - Message routing

3. **Web Interface Layer**
   - User interaction
   - Status monitoring
   - Debug controls

## License

MIT License 