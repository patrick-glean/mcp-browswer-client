# Protocol and Architecture Choices

## Transport
- MCP over Streamable HTTP only: JSON-RPC 2.0 in `POST` bodies, replies as `application/json` or `text/event-stream`.
- 2026-07-28 ("modern") first, falling back to the 2025 `initialize` handshake ("legacy"). The deprecated 2024-11-05 HTTP+SSE transport and stdio are out of scope: a browser can only make HTTP requests.

## Where protocol logic lives
All MCP protocol logic lives in an MCP client library, and every library implements the same interface (see DEVELOPMENT.md):
1. Message formatting, envelopes and headers
2. Request and response handling, SSE parsing
3. Era detection, version retries and reconnects
4. Error mapping to `McpError`
5. Connection state per server URL

The service worker and the page only:
1. Pass messages to and from the library
2. Keep state the library mustn't: sign-ins, runs and conversations in IndexedDB
3. Run the apps (the Chat app's agent loop) and the UI
4. Manage the service worker's lifecycle and the choice of library

This keeps libraries interchangeable: the same smoke test and benchmark run against each, and the rest of the app doesn't change when a library is added or switched.

# Build Process

Each library has its own build, and `npm run build` runs them all:

- **Rust/WASM** (`npm run build:wasm`, `wasm-build.sh`): generates build info (`generate-build-info.sh`), ensures the wasm32 target and wasm-bindgen-cli, builds with `cargo build --target wasm32-unknown-unknown --release`, and generates bindings with `wasm-bindgen --target no-modules --out-dir public`. Outputs `public/mcp_browser_client_bg.wasm`, `public/mcp_browser_client.js` and `public/build.js`.
- **TypeScript SDK** (`npm run build:sdk`, `sdk-client/build.mjs`): bundles `sdk-client/` with `@modelcontextprotocol/client` into an IIFE that sets `self.mcpSdkClient`. Outputs `public/sdk_client.js` and `public/build-sdk.js`.

Service workers can't `import()` on demand, so `public/mcp-clients.js` fetches and evaluates each library, and imports the build files so that a rebuild is a worker update.
