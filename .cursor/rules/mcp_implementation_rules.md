# MCP Implementation Rules and Progress

## Overview
This file tracks the Model Context Protocol (MCP) client that runs in our service worker. The protocol logic is Rust compiled to WASM (`src/mcp/`); the service worker (`public/sw.js`) routes page messages to it. The reference is the MCP specification itself (https://modelcontextprotocol.io/specification/2026-07-28); `rust-mcp-schema` and the official SDKs are useful for cross-checking types and behavior.

## Target Protocol
- Primary: MCP `2026-07-28` ("modern"): stateless, with protocol version, client info and client capabilities in `_meta` on every request, and `server/discover` instead of a handshake.
- Fallback: `2025-11-25`, `2025-06-18`, `2025-03-26` ("legacy"): the `initialize` handshake, then `Mcp-Session-Id` and `MCP-Protocol-Version` on every request.
- Transport: Streamable HTTP only. The deprecated 2024-11-05 HTTP+SSE transport is out of scope.
- Constants live in `src/mcp/types.rs` (`MODERN_VERSIONS`, `LEGACY_VERSIONS`, error codes).

## Rules
- All MCP wire logic stays in `src/mcp/`; `src/lib.rs` only exposes it. The service worker never builds JSON-RPC itself.
- Era detection follows the spec: try a modern request first. A recognized modern error (`-32020`, `-32021`, `-32022`, or `-32601` with HTTP 404) means "modern, fix the request or retry with a supported version"; any other `4xx` or non-modern JSON-RPC error means legacy.
- A probe the browser can't read at all (a network error) also gets the legacy handshake: browsers report a CORS preflight that rejects `Mcp-Method` and friends exactly like an unreachable server. If the handshake reaches a server that wants 2026-07-28, report the CORS headers it must allow; if it can't be reached either, keep the probe's error.
- Log every protocol decision at info with the server URL and the reason (fallbacks, version retries, reconnects, hidden tools), and the wire at debug through `transport::post`. Never log an `Authorization` value; shorten session IDs.
- Every modern POST sends `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `resources/read` and `prompts/get`, `Mcp-Name`. Values that aren't plain ASCII use the `=?base64?...?=` form. Tool parameters marked `x-mcp-header` are mirrored into `Mcp-Param-*`; tools with invalid annotations are hidden and reported as `rejected`.
- Replies may be `application/json` or `text/event-stream`; both must work. SSE is parsed incrementally and the stream is dropped once the matching response arrives.
- Results without `resultType` are `complete`; `input_required` passes through to the UI; anything else is an error.
- Errors cross into JavaScript as JSON `McpError { kind, message, status?, code?, data? }` with a message a user can act on.
- Connection state is per server URL in `src/mcp/registry.rs`. Never hold a `RefCell` borrow (or any lock) across `.await`.
- The service worker can be stopped at any time: MCP exports reconnect on demand, and message handling runs inside `event.waitUntil()`.
- Bearer tokens come only from the page (or the server list the page registers), never from tool output, and are redacted from logs.

## Status

### Done (milestone 1)
- [x] Modern requests, `server/discover`, version retry on `-32022`
- [x] Legacy fallback with `initialize`, sessions and re-initialize on 404
- [x] JSON and SSE replies
- [x] `tools/list` with pagination, `ttlMs` caching and `x-mcp-header` validation
- [x] `tools/call` with `Mcp-Name` / `Mcp-Param-*` headers and a retry after `HeaderMismatch`
- [x] Structured errors and bearer-token auth
- [x] Legacy fallback when CORS blocks the modern probe
- [x] Structured logs from the page, worker and WASM client in the Logs tab, with an HTTP trace at debug level
- [x] Unit tests (`npm run test:rust`) and the browser smoke test (`npm run test:browser -- --reference`, `npm run test:public`)

### Next
- [ ] OAuth 2.1 with PKCE and client ID metadata documents, validating the authorization server's `iss`
- [ ] Durable state in IndexedDB (server config, era cache, conversations)
- [ ] `input_required` / elicitation UI (multi round-trip requests)
- [ ] `subscriptions/listen` for list-change notifications
- [ ] Resources and prompts
- [ ] MCP Apps (`io.modelcontextprotocol/ui`) in sandboxed iframes

## Testing Requirements
- Protocol logic that doesn't touch the browser (SSE parsing, header encoding, era classification, envelopes) gets native unit tests in its module.
- Changes to the connection flow, the service worker or the MCP UI must pass `npm run test:browser -- --reference`, which covers modern, legacy, SSE, dual-era, strict-CORS and token-protected mock servers, the official Python SDK server, a service worker restart, a second tab, unreachable servers and what the Logs tab records. `npm run test:public` adds the public servers the in-app Guide suggests.
- New server behaviors should be added to `test_mcp_server.py` (standard library only) rather than mocked in the client.
