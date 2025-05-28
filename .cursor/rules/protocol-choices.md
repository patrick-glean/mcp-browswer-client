# MCP Message Format Summary

Format depends on the transport layer:

## 1. JSON-RPC Format
- Used when transport is 'stdio', 'websocket', or other persistent streams.
- Suitable for bidirectional communication.
- Messages contain fields: jsonrpc, method, params, id, result, error.
- Example:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "clientInfo": { "name": "myClient" } }
}
```

## 2. HTTP Format
- Used when transport is 'http'.
- Suitable for stateless, one-off requests.
- Follows standard HTTP methods (GET, POST, etc.).
- Example:
```http
POST /mcp/initialize
{
  "clientInfo": { "name": "myClient" }
}
```

## Decision Rule
- If transport is a persistent stream → use JSON-RPC.
- If transport is stateless HTTP → use HTTP format.

# Build Process

The WASM module is built using `wasm-build.sh` which:
1. Generates build info using `generate-build-info.sh`
2. Ensures wasm-bindgen-cli is installed
3. Builds the WASM module with `cargo build --target wasm32-unknown-unknown --release`
4. Generates JS bindings with `wasm-bindgen --target no-modules --out-dir public`
5. Ensures WASM target is installed

The build outputs:
- `public/mcp_browser_client_bg.wasm` - The WASM module
- `public/mcp_browser_client.js` - The JavaScript bindings

# Architecture Principles

## MCP Protocol Centralization
All MCP protocol-related logic should be implemented in the Rust/WASM module:
1. Protocol message formatting (JSON-RPC vs HTTP)
2. Request/response handling
3. Error handling
4. State management
5. Server registry

The service worker and browser UI should only:
1. Pass messages to/from the WASM module
2. Handle UI updates
3. Manage service worker lifecycle

This ensures:
- Single source of truth for MCP protocol implementation
- Easier protocol updates and maintenance
- Consistent behavior across all clients
- Better testability of protocol logic
