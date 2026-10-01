# MCP Browser Client

A browser client for MCP (the Model Context Protocol). Its protocol logic is Rust compiled to WebAssembly and runs in a service worker that every open tab shares. It speaks MCP 2026-07-28 and falls back automatically for servers still on the older, `initialize`-based revisions.

## Try it

Open [patrick-glean.github.io/mcp-browswer-client](https://patrick-glean.github.io/mcp-browswer-client/). The Guide (top right, and open on your first visit) has one-click buttons for public MCP servers that need no account, such as Hugging Face and Microsoft Learn. Choose one, click a tool, fill in its fields and choose Call tool. The Logs tab shows what happened.

## Prerequisites

- Python 3.x (the mock MCP server uses only the standard library)
- Node.js 22+ (for the browser smoke test)
- Google Chrome (for the browser smoke test)
- Rust (latest stable version)
  - Install via rustup: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

## Project Structure

```
.
├── src/                    # Rust source code
│   ├── lib.rs             # WASM exports used by the service worker
│   ├── logging.rs         # Structured log entries, sent to the worker's logger
│   ├── mcp/               # MCP client: transport, SSE parser, headers, modern and legacy eras
│   └── build_info.rs      # Generated build metadata
├── public/                # Web assets and service worker
│   ├── mcp_browser_client_bg.wasm  # Compiled WASM module
│   ├── mcp_browser_client.js       # Generated JS bindings
│   ├── build.js           # Generated: the module's hash, so a rebuild updates the worker
│   ├── sw.js              # Service worker
│   ├── wasm.js            # Loads the WASM module in the worker and forwards its logs
│   ├── logger.js          # The worker's structured logger
│   ├── chatStorage.js     # IndexedDB storage for conversations
│   ├── index.html         # Web interface, including the Guide and the Logs tab
│   ├── styles.css         # UI styles (Glean design language)
│   ├── tokens.css         # Design tokens: light and dark theme colors, type, radii, shadows
│   ├── fonts/             # Inter and DM Sans (OFL)
│   └── icons/             # Feather icons, rendered as CSS masks (MIT)
├── tests/
│   ├── browser-smoke.mjs  # Drives the real UI in headless Chrome against test servers
│   └── reference_server.py # A server on the official MCP Python SDK, for interop checks
├── test_mcp_server.py     # Mock MCP server (modern, legacy or dual-era; JSON or SSE; tokens; strict CORS)
├── venv/                  # Python virtual environment (only for the reference server)
├── node_modules/          # Node.js dependencies
├── .cursor/               # Cursor IDE configuration
├── Cargo.toml             # Rust project configuration
├── package.json           # Node.js configuration
├── requirements.txt       # Python dependencies (the official MCP SDK, for the reference server)
├── wasm-build.sh          # WASM build script
├── generate-build-info.sh # Build metadata generator
├── deploy-gh-pages.sh     # Publishes public/ to the gh-pages branch
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
     5. Writes `public/build.js` with the module's hash
     6. Outputs to `public/` directory

3. **Service Worker Integration**
   - WASM module loaded by service worker
   - JS bindings provide Rust-WASM interface
   - Multi-tab communication via service worker
   - Every page load checks `sw.js` and its imports for changes. `build.js` changes with every WASM build, so after a rebuild the next reload installs a new worker, which takes over at once and loads the new module.

## Run it locally

1. Run the setup script once:
```bash
./setup.sh
```

2. Start the app on http://localhost:8080 (with HTTP caching off, so rebuilds show up on reload):
```bash
npm start
```

3. In a second terminal, start the mock MCP server on http://127.0.0.1:8081:
```bash
npm run start:mock-mcp
```

4. Open http://localhost:8080 and follow the Guide, or see [Testing](#testing) below.

## Development

### Available Scripts

- `npm start`: Start the web server on port 8080 with caching off
- `npm run build`: Build the WASM module
- `npm run start:mock-mcp`: Start the mock MCP server on port 8081 (pass flags after `--`, e.g. `npm run start:mock-mcp -- --mode legacy`)
- `npm run start:reference-mcp`: Start the official-SDK reference server on port 8082 (needs the venv)
- `npm run test:rust`: Run the Rust unit tests
- `npm run test:browser`: Run the browser smoke test (add `-- --reference` to include the SDK server)
- `npm run test:public`: The browser smoke test plus the public servers the Guide suggests (needs internet)

### Modifying the Rust Code
1. Edit the MCP client in `src/mcp/` (exports live in `src/lib.rs`)
2. Rebuild WASM:
```bash
./wasm-build.sh
```
3. Reload the page. The Logs tab shows "Installing the service worker for WASM build …" and then "Loaded the WASM module" with the new build time and hash.

### Modifying the Web Interface
1. Edit files in the `public` directory
2. Refresh your browser

Style new UI with the `--theme-*` variables from `public/tokens.css` rather than raw colors, so light and dark mode both keep working. Dark mode is the `dark-theme` class on `<html>`; the header toggle sets it and otherwise it follows the OS setting.

## MCP Support

Connecting to a server works out which protocol era it speaks:

1. The client sends `server/discover` as a 2026-07-28 request. Every modern request carries `_meta` with the protocol version, client info and capabilities, plus the `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`, `resources/read`, `prompts/get`) `Mcp-Name` headers.
2. If the server answers, it's modern. If it rejects the version with `-32022`, the client retries with one the server lists.
3. Any other `4xx`, or a JSON-RPC error that isn't one of the modern codes, means a legacy server. The client then runs the `initialize` handshake (offering 2025-11-25) and sends `Mcp-Session-Id` and the negotiated version from then on.
4. If the browser can't read any reply to `server/discover`, the client tries the `initialize` handshake anyway. A browser reports a CORS preflight that rejects the new headers exactly like an unreachable server, and the handshake needs fewer headers, so this covers 2025-era servers with strict CORS allowlists. If the handshake reaches a modern server, the error says which headers its CORS policy must allow.

The result is remembered per server URL. After the browser restarts the service worker, the first request reconnects automatically. Replies can be plain JSON or an SSE stream. Tool lists are paginated and cached for the server's `ttlMs`. Parameters a tool marks with `x-mcp-header` are also sent as `Mcp-Param-*` headers, and tools with invalid annotations are hidden.

Known constraints:

- **CORS**: the server must allow this site's origin and the headers above: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, any `Mcp-Param-*` its tools use, and `Authorization` if you use a token. Legacy servers that use sessions must also list `Mcp-Session-Id` in `Access-Control-Expose-Headers`, or the browser can't read it.
- **Local servers**: from a public site such as GitHub Pages, Chrome 142+ asks the user before it lets the page reach `localhost` ("Apps on device").
- **Auth**: OAuth isn't supported yet. For servers that accept a static token, add a bearer token in the server details; it's stored in this browser's `localStorage`.
- **Not yet supported**: `input_required` results (elicitation), `subscriptions/listen`, resources and prompts in the UI, and the deprecated 2024-11-05 HTTP+SSE transport.

## Testing

### A five-minute check

With `npm start` and `npm run start:mock-mcp` running, open http://localhost:8080:

1. **Connect.** In the Guide, choose "Add and connect to 127.0.0.1:8081" (or paste `http://127.0.0.1:8081` on the MCP tab and choose Add server). The server details should show status `connected` and protocol `2026-07-28 (modern)`, and Available tools should list `echo`, `echo_region` and `count`. The mock also offers `broken_header`, which clients must hide.
2. **Call a tool.** Choose `echo`, type `hi` into `text` and choose Call tool. The result reads `Echo: hi`.
3. **Header parameters.** Call `echo_region` with region `Zürich`. The result reads `Echo from Zürich: …`; the mock checks that the `Mcp-Param-Region` header carried the same value, base64-encoded because it isn't ASCII.
4. **Logs.** On the Logs tab you should see lines like `Connected to Mock MCP Server 2.0.0 in 9 ms: MCP 2026-07-28 (modern)`, `Listed 3 tools in 5 ms`, `Hiding tool broken_header: …` and `echo returned in 3 ms`. Choose Everything to add each HTTP request (`→ tools/call echo (id 5)`) and reply (`← HTTP 200 for tools/call echo (id 5) in 3 ms`).
5. **Chat through a tool.** On the Console tab, choose the mock and `echo` under LLM target, tick Target for message on `text`, and send `hello`. The reply `Echo: hello` joins the conversation.
6. **The legacy fallback.** Stop the mock, start it with `npm run start:mock-mcp -- --mode legacy`, and choose Connect. The protocol becomes `2025-11-25 (legacy)`, and the Logs tab explains why: `server/discover got HTTP 400, …, so this looks like a 2025-era server; falling back to the initialize handshake`.

### More server behaviors

`test_mcp_server.py` needs only Python's standard library. Its flags simulate the situations a browser client has to handle:

| Flag | What the mock does |
| --- | --- |
| `--mode modern` | Speaks only 2026-07-28 |
| `--mode legacy` | Acts as a 2025-era server: `initialize` handshake and `Mcp-Session-Id` |
| `--sse` | Streams replies as SSE instead of JSON |
| `--token s3cret` | Requires `Authorization: Bearer s3cret`. Connect fails with a request for a token; paste it into Bearer token and choose Connect |
| `--allow-headers "Content-Type, Mcp-Session-Id, MCP-Protocol-Version"` | Uses a CORS policy written before 2026-07-28. With `--mode legacy` the client still connects; with `--mode modern` it explains which headers to allow |
| `--allow-origin https://example.github.io` | Accepts requests from another page origin (repeatable) |
| `--verbose` | Prints every request's headers and body |

`--port` and `--host` change where it listens. Every request is printed with its result, such as `POST tools/call (modern) -> 200`.

### Real servers

These public servers need no account, allow browsers through CORS, and are in the Guide:

| Server | URL | Speaks | Try |
| --- | --- | --- | --- |
| Hugging Face | `https://huggingface.co/mcp` | 2026-07-28 | `hub_repo_search` with query `whisper` |
| Context7 | `https://mcp.context7.com/mcp` | 2026-07-28 | `resolve-library-id` with libraryName `react` and query `hooks` |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | 2025-06-18, with a session and SSE replies | `microsoft_docs_search` with query `service worker` |
| DeepWiki | `https://mcp.deepwiki.com/mcp` | 2025-11-25, without a session | `read_wiki_structure` with repoName `modelcontextprotocol/modelcontextprotocol` |

They're third-party services, so their behavior can change; `npm run test:public` checks that each one still connects and answers its sample call. It also connects to GitMCP (`https://gitmcp.io/docs`), whose reply to `server/discover` lacks CORS headers, so it's only reachable through the fallback described in [MCP Support](#mcp-support).

`tests/reference_server.py` runs a server on the official MCP Python SDK (`npm run setup:python` installs it, then `npm run start:reference-mcp`); add `http://127.0.0.1:8082/mcp`.

### From the deployed site

The GitHub Pages copy can reach a mock on your machine too. Start it with the site's origin allowed, as the Guide's command does:

```bash
python3 test_mcp_server.py --allow-origin https://patrick-glean.github.io
```

When you connect to `http://127.0.0.1:8081`, Chrome asks whether the site may access apps on your device. Allow it.

### Automated tests

```bash
npm run test:rust                    # protocol logic: SSE parsing, header encoding, era detection, log redaction
npm run test:browser                 # the real UI in headless Chrome against every mock variant
npm run test:browser -- --reference  # plus the official Python SDK server
npm run test:public                  # plus the public servers above (needs internet)
```

The browser test starts its own servers on ports 18080-18089 and drives the UI the way a person would. It covers modern, legacy, SSE, dual-era, strict-CORS and token-protected servers, a worker restart, a second tab, the logs pop-out, the Guide, and what the Logs tab records (timings, fallback reasons, no tokens, no HTML). It exits non-zero if a check fails, printing the client's own log and saving all of it as JSON.

## Logs

The Logs tab collects entries from three sources, shown in the third column:

- **page**: this tab (service worker registration, uncaught errors)
- **worker**: the service worker: each connect, tool listing and tool call with how long it took, and failures with their error kind and status
- **wasm**: the MCP client itself: why it chose a protocol (fallbacks, version retries, reconnects), tools it hid, and log messages the server sent

The level menu decides what's shown: Errors, Warnings and errors, Info (the default), or Everything, which adds the HTTP trace. Each request shows its MCP headers and body, and each reply its status, timing and body; bodies over 4 KB are cut short. Entries are kept even while hidden, so after a failure you can switch to Everything and see what led to it. Filter by text or server URL, and open Details for the structured data behind an entry.

- **Copy** copies the entries shown, one per line.
- **Download** saves every entry as JSON Lines, headed by the WASM build and browser, for bug reports.
- **Pop out** (the icon at the end of the tabs) opens the logs in their own window, with the history so far.
- **Errors** logged while you're on another tab show as a count on the Logs tab.

The `Authorization` header never appears in logs, and session IDs are shortened. Each tab keeps its last 1,000 entries.

The worker also prints every entry to its own console: open `chrome://inspect/#service-workers` (or DevTools → Application → Service workers) and choose Inspect. Debug entries show there at DevTools' Verbose level.

## Troubleshooting

- **"Couldn't reach …"**: the server isn't running, or it doesn't allow this site through CORS. A server on `localhost` reached from a public site also needs Chrome's local network permission.
- **"… CORS policy must allow the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers"**: the server speaks 2026-07-28 but its CORS allowlist predates it. Add those headers (and any `Mcp-Param-*` its tools use) to `Access-Control-Allow-Headers`.
- **HTTP 404 or 405**: the URL isn't the MCP endpoint, which often ends in `/mcp`.
- **HTTP 401**: add a bearer token in the server details and choose Connect.
- **A tool call fails with a validation error**: optional fields left empty aren't sent, but required ones are; check the fields marked `*`.
- **Old behavior after a rebuild**: reload the page and check that the Logs tab shows "Loaded the WASM module" with the new build time. If it doesn't, open the runtime controls from the status pill and reload the WASM module, or unregister the worker in DevTools → Application → Service workers.
- **Stuck on "connecting" or "Calling …"**: the page gives up after 50 seconds (connect) or 130 seconds (tool call) with an explanation. The Logs tab, set to Everything, shows the last request that went out.

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
    SW -- Streamable HTTP --> MCP1
    SW -- Streamable HTTP --> MCP2
    MCP2 -- (optional) --> Model
```

### Dataflow Explanation

1. **User** interacts with the **UI (Web Interface)**, providing input and receiving output.
2. The **UI** sends requests (e.g., tool calls, status checks) to the **Service Worker**.
3. The **Service Worker** acts as the interface layer, loading and using the **WASM Module (Rust MCP Client)** for protocol logic and message processing.
4. The **Service Worker** communicates with one or more **MCP Servers** over Streamable HTTP, through the WASM module.
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

A: Yes! We welcome contributions and feedback.

## License

MIT License 
