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

This project is designed for secure, multi-server, browser-based MCP communication. The architecture includes:

- **User**: Interacts with the web interface in the browser.
- **UI (Web Interface)**: The user input, output, and control layer. Handles all user interaction, displays results, and provides controls for MCP operations.
- **Browser**: Hosts the web UI and registers the service worker.
- **Service Worker (Interface Layer)**: The interface between the UI and the protocol logic. The service worker loads and uses the WASM module (Rust MCP Client), and routes messages between the UI and MCP servers. It manages multi-tab communication and state.
- **WASM Module (Rust MCP Client)**: The actual MCP client, implemented in Rust and compiled to WASM. This module is loaded by the service worker and performs all protocol logic, message processing, and communication with MCP servers. The service worker acts as a host and communication layer, while the Rust MCP Client (WASM) does the heavy lifting.
- **MCP Servers**: One or more remote servers implementing the MCP protocol.
- **Model Provider**: An external service (can be an MCP server) that provides model-based responses or tools.

### Dataflow Diagram

```mermaid
flowchart TD
    User[User (Web UI)]
    Browser[Browser]
    SW[Service Worker]
    WASM[WASM Module (Rust)]
    MCP1[MCP Server 1]
    MCP2[MCP Server 2]
    Model[Model Provider (MCP Server)]

    User -- UI Events --> Browser
    Browser -- Message --> SW
    SW -- Call/Response --> WASM
    SW -- JSON-RPC, Tools, Status --> Browser
    SW -- HTTP/WebSocket --> MCP1
    SW -- HTTP/WebSocket --> MCP2
    MCP2 -- (optional) --> Model
```

### Dataflow Explanation

1. **User** interacts with the **UI (Web Interface)**, providing input and receiving output.
2. The **UI** sends requests (e.g., tool calls, status checks) to the **Service Worker**.
3. The **Service Worker** acts as the interface layer, loading and using the **WASM Module (Rust MCP Client)** for protocol logic and message processing.
4. The **Service Worker** communicates with one or more **MCP Servers** over HTTP or WebSocket.
5. An **MCP Server** may itself act as a **Model Provider** or proxy requests to a model provider.
6. Responses and status updates flow back through the service worker and WASM to the UI, and are presented to the user.

This architecture enables secure, multi-server, and high-performance MCP operations in the browser, with a clear separation of concerns and robust protocol handling.

## Why We Chose Rust/WASM

This project implements its core logic in Rust, compiled to WebAssembly (WASM), for several reasons:

- **Security & Code Signing:** WASM binaries are easy to sign, verify, and distribute. You can ship a single `.wasm` file and know exactly what's running in the browser.
- **Dependency Management:** Rust's package management (Cargo) is robust and avoids the dependency hell and supply chain issues common in the JavaScript/TypeScript ecosystem.
- **Safety & Maintainability:** Rust's type system and memory safety features make it much harder to introduce bugs or vulnerabilities. Refactoring and maintaining a Rust codebase is often easier in the long run.
- **Performance:** Rust/WASM is highly performant for protocol handling, parsing, and compute-heavy tasks.
- **Code Reuse:** Rust code can be shared between backend and frontend, reducing duplication and inconsistencies.

While TypeScript is a great choice for many browser projects, we found Rust/WASM to be a better fit for our goals of security, maintainability, and performance.


## FAQ: Rust/WASM vs TypeScript/JS

**Q: Why not use a TypeScript MCP client?**

A: TypeScript is great for UI and browser APIs, but for protocol logic, Rust/WASM offers better safety, performance, and distribution guarantees. We also avoid the complexity and churn of the npm ecosystem.

**Q: Can you do socket-level networking in browser WASM?**

A: No. Browser WASM is sandboxed and limited to the same networking APIs as JavaScript: HTTP(S), WebSocket, and WebRTC. Raw TCP/UDP sockets are not available in the browser for security reasons.

**Q: Isn't Rust/WASM harder to debug and integrate?**

A: There is some extra complexity, but the benefits in safety, performance, and code signing outweigh the downsides for this project. We keep JS glue code minimal and let Rust handle the core logic.

**Q: What if I want to use TypeScript for the UI?**

A: You can! This project is designed so that the UI can be written in JS/TS, while the protocol and core logic remain in Rust/WASM. This hybrid approach gives you the best of both worlds.

**Q: Is this project open to contributions?**

A: Yes! We welcome contributions and feedback. Please see CONTRIBUTING.md for guidelines.

## License

MIT License 