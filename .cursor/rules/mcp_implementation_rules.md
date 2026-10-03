# MCP Implementation Rules and Progress

## Overview
This file tracks the Model Context Protocol (MCP) client that runs in our service worker. The protocol logic is Rust compiled to WASM (`src/mcp/`, with sign-in in `src/oauth/` and shared HTTP in `src/http.rs`); the service worker (`public/sw.js`) routes page messages to it. The reference is the MCP specification itself (https://modelcontextprotocol.io/specification/2026-07-28); `rust-mcp-schema` and the official SDKs are useful for cross-checking types and behavior.

## Target Protocol
- Primary: MCP `2026-07-28` ("modern"): stateless, with protocol version, client info and client capabilities in `_meta` on every request, and `server/discover` instead of a handshake.
- Fallback: `2025-11-25`, `2025-06-18`, `2025-03-26` ("legacy"): the `initialize` handshake, then `Mcp-Session-Id` and `MCP-Protocol-Version` on every request.
- Transport: Streamable HTTP only. The deprecated 2024-11-05 HTTP+SSE transport is out of scope.
- Constants live in `src/mcp/types.rs` (`MODERN_VERSIONS`, `LEGACY_VERSIONS`, error codes).

## Rules
- All MCP wire logic stays in `src/mcp/`; `src/lib.rs` only exposes it. The service worker never builds JSON-RPC itself.
- Era detection follows the spec: try a modern request first. A recognized modern error (`-32020`, `-32021`, `-32022`, or `-32601` with HTTP 404) means "modern, fix the request or retry with a supported version"; any other `4xx` or non-modern JSON-RPC error means legacy.
- A probe the browser can't read at all (a network error) also gets the legacy handshake: browsers report a CORS preflight that rejects `Mcp-Method` and friends exactly like an unreachable server. If the handshake reaches a server that wants 2026-07-28, report the CORS headers it must allow; if it can't be reached either, keep the probe's error.
- Log every protocol decision at info with the server URL and the reason (fallbacks, version retries, reconnects, hidden tools), and the wire at debug through `http::send` or the MCP transport. Never log an `Authorization` value or a token; shorten session IDs.
- Every modern POST sends `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `resources/read` and `prompts/get`, `Mcp-Name`. Values that aren't plain ASCII use the `=?base64?...?=` form. Tool parameters marked `x-mcp-header` are mirrored into `Mcp-Param-*`; tools with invalid annotations are hidden and reported as `rejected`.
- Replies may be `application/json` or `text/event-stream`; both must work. SSE is parsed incrementally and the stream is dropped once the matching response arrives.
- Results without `resultType` are `complete`; `input_required` passes through to the UI; anything else is an error.
- Errors cross into JavaScript as JSON `McpError { kind, message, status?, code?, data? }` with a message a user can act on.
- Connection state is per server URL in `src/mcp/registry.rs`. Never hold a `RefCell` borrow (or any lock) across `.await`.
- The service worker can be stopped at any time: MCP exports reconnect on demand, and message handling runs inside `event.waitUntil()`.
- Bearer tokens come only from the page (or the server list the page registers) or the worker's sign-in store, never from tool output, and are redacted from logs.

### Sign-in (OAuth)
- Follow the MCP authorization spec (2026-07-28). `src/oauth/` does discovery, registration, PKCE, the authorization URL, the callback checks, code exchange and refresh. It stores nothing: the worker keeps clients, tokens and pending sign-ins in IndexedDB (`public/authStore.js`).
- Discovery order: protected resource metadata from the `WWW-Authenticate` challenge, then the path-inserted well-known URL, then the root. The metadata's `resource` must match the server URL. Authorization server metadata: RFC 8414 path insertion, then OIDC path insertion, then OIDC path appending; the `issuer` must match exactly and S256 must be supported.
- Always send PKCE S256, `state` and `resource` (on the authorization and token requests). Check `state` before anything else in a callback, then `iss` per RFC 9207, and only then show the callback's error.
- Register with DCR as `native` from loopback pages and `web` otherwise. Key registrations by issuer and redirect URI.
- Tokens never leave the worker except to the server they were issued for and its authorization server: pages get `authStatus` only, logs get `[redacted]`. Refreshes for one server are serialized because refresh tokens may rotate.
- A 401 rejects with `auth_required` and carries the challenge in `data.wwwAuthenticate` when it's readable. The worker retries once after a forced refresh.

### Workbench
- The Workbench lives in ES modules under `public/workbench/`; `index.html` loads `index.js` with `import()`, which calls `installWorkbench(chatShell)`. Keep new Workbench logic there rather than in `index.html`.
- `ChatShell` (in `index.html`) is the controller: the worker, servers, sign-in and calls. It doesn't draw the Workbench; it emits `servers`, `select`, `tools`, `auth`, `run` and `recorded` events. The Workbench state (`workbench.js`) owns selection, environments, saved requests, Run all and the frame, with its own events.
- Each part of the screen is one custom element in `components/` (rail, server bar, tools, request, response, dock, sheet, palette), extending `WbElement`. Components never call each other: they listen to and call `ChatShell` and the Workbench state only, and subscribe with `this.lifetime` so they clean up when moved. A new part is a new component, not code in another one.
- Layouts are CSS only: every component has a `wb-area-*` grid area, and a `#workbench[data-layout]` block in `workbench.css` arranges them (layout B today). Don't hard-code positions in the components.
- Every tool call is recorded as a run in `handleToolCall`, whatever its source. Recording must never fail the call; log a warning instead.
- `{{variables}}` are resolved in the page, which has the tool's schema for type conversion, before `call_tool` goes out. The worker gets the sent arguments plus the arguments as written in `run.args`.
- Runs compare on a hash of the result with sorted keys and no `_meta`. A saved request's runs compare with each other, and other calls with the same tool and sent arguments.
- Never put credentials in Workbench records. Arguments are stored as written, and tokens travel only in `mcpOptions`.
- The store keeps its first name, `mcp_sandbox`. Changing its stores or indexes needs a new `DB_VERSION` with an upgrade path for existing data. Run sources are `workbench`, `collection`, `chat` and `reply`; treat `sandbox` (from before the rename) as `workbench`.
- Saved requests, steps and app manifests share one shape for a call, `{serverUrl, toolName, args}`. Keep it that way, so saved requests can become workflow steps.

## Status

### Done (milestone 1)
- [x] Modern requests, `server/discover`, version retry on `-32022`
- [x] Legacy fallback with `initialize`, sessions and re-initialize on 404
- [x] JSON and SSE replies
- [x] `tools/list` with pagination, `ttlMs` caching and `x-mcp-header` validation
- [x] `tools/call` with `Mcp-Name` / `Mcp-Param-*` headers and a retry after `HeaderMismatch`
- [x] Structured errors and bearer-token auth
- [x] Legacy fallback when CORS blocks the modern probe
- [x] Structured logs from the page, worker and WASM client in the log, with an HTTP trace at debug level
- [x] Unit tests (`npm run test:rust`) and the browser smoke test (`npm run test:browser -- --reference`, `npm run test:public`)

### Done (milestone 2: sign-in and the inspector)
- [x] OAuth sign-in: discovery, DCR, PKCE, `state`/`iss` checks, code exchange, proactive refresh and refresh-and-retry, sign-out
- [x] Tokens in IndexedDB, shared by tabs, never in logs or pages
- [x] Inspector views: connection details, tool badges, filter, schemas, hidden tools, download
- [x] Glean first in the Guide; `npm run start:glean` for an origin Glean allows

### Done (the Workbench, milestone 1 of the app builder)
- [x] Pre-fill from what was last sent, saved requests and the schema; environments with `{{variables}}`
- [x] Saved requests in collections, running again and Run all with what changed, and a line diff
- [x] History of every tool call (Workbench, chat, tool calls in replies), kept in IndexedDB
- [x] Export and import of saved requests, collections and environments
- [x] Layout B built from components: rail, server bar, tools (filters, groups), request and response panes, dock (Log, Trace, Runs), side sheets, Go to and keyboard shortcuts
- [x] The Console moved to Apps as the Chat app (Model, Instructions and context, Conversation)

### Next
- [ ] App builder milestone 2: workflow steps and the Chat app as a manifest (a shape, allowed tools, pinned arguments, instructions and output checks)
- [ ] App builder milestone 3: export an app as a web component or static site; milestone 4: an in-browser model as a local MCP server
- [ ] Client ID metadata documents (the spec's preferred registration), step-up authorization, token revocation on sign-out
- [ ] Durable state in IndexedDB (server config, era cache, conversations)
- [ ] `input_required` / elicitation UI (multi round-trip requests)
- [ ] `subscriptions/listen` for list-change notifications
- [ ] Resources and prompts
- [ ] MCP Apps (`io.modelcontextprotocol/ui`) in sandboxed iframes

## Testing Requirements
- Protocol logic that doesn't touch the browser (SSE parsing, header encoding, era classification, envelopes) gets native unit tests in its module.
- Changes to the connection flow, sign-in, the service worker or the Workbench and Apps UI must pass `npm run test:browser -- --reference`, which covers modern, legacy, SSE, dual-era, strict-CORS, token-protected and OAuth mock servers, sign-in and refresh, the layout and inspector, the Workbench, the Chat app, the official Python SDK server, a service worker restart, a second tab, unreachable servers and what the log records. `npm run test:public` adds the public servers the in-app Guide suggests.
- New server behaviors should be added to `test_mcp_server.py` (standard library only) rather than mocked in the client.
