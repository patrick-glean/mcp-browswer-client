# MCP Implementation Rules and Progress

## Overview
This file tracks the MCP client libraries our service worker runs and the app built on them, a system for testing MCP client libraries in the browser and building agentic apps on them. There are two libraries with one interface (DEVELOPMENT.md): the official TypeScript SDK behind an adapter (`sdk-client/`), the default, and Rust compiled to WASM (`src/mcp/`, with sign-in in `src/oauth/` and shared HTTP in `src/http.rs`). `public/mcp-clients.js` lists them, `public/client-runtime.js` keeps the chosen one loaded, and the service worker (`public/sw.js`) routes page messages to it. The reference is the MCP specification itself (https://modelcontextprotocol.io/specification/2026-07-28); `rust-mcp-schema` and the official SDKs are useful for cross-checking types and behavior.

## Target Protocol
- Primary: MCP `2026-07-28` ("modern"): stateless, with protocol version, client info and client capabilities in `_meta` on every request, and `server/discover` instead of a handshake.
- Fallback: `2025-11-25`, `2025-06-18`, `2025-03-26` ("legacy"): the `initialize` handshake, then `Mcp-Session-Id` and `MCP-Protocol-Version` on every request.
- Transport: Streamable HTTP only. The deprecated 2024-11-05 HTTP+SSE transport is out of scope.
- Constants live in `src/mcp/types.rs` (`MODERN_VERSIONS`, `LEGACY_VERSIONS`, error codes) for the Rust library, and in the SDK for the other.

## Rules
- All MCP wire logic stays in a library: `src/mcp/` (with `src/lib.rs` only exposing it) or `sdk-client/` over the SDK. The service worker never builds JSON-RPC itself.
- Every library implements the same interface with the same JSON shapes and `McpError` kinds, and passes the same smoke test (`--client=`). A behavior below that only one library has is a bug in the other.
- Era detection follows the spec: try a modern request first. A recognized modern error (`-32020`, `-32021`, `-32022`, or `-32601` with HTTP 404) means "modern, fix the request or retry with a supported version"; any other `4xx` or non-modern JSON-RPC error means legacy.
- A probe the browser can't read at all (a network error) also gets the legacy handshake: browsers report a CORS preflight that rejects `Mcp-Method` and friends exactly like an unreachable server. If the handshake reaches a server that wants 2026-07-28, report the CORS headers it must allow; if it can't be reached either, keep the probe's error.
- Log every protocol decision at info with the server URL and the reason (fallbacks, version retries, reconnects, hidden tools), and the wire at debug (`http::send` or the MCP transport in Rust, `sdk-client/trace.js` for the SDK). Never log an `Authorization` value or a token; shorten session IDs.
- Every modern POST sends `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `resources/read` and `prompts/get`, `Mcp-Name`. Values that aren't plain ASCII use the `=?base64?...?=` form. Tool parameters marked `x-mcp-header` are mirrored into `Mcp-Param-*`; tools with invalid annotations are hidden and reported as `rejected`.
- Replies may be `application/json` or `text/event-stream`; both must work. SSE is parsed incrementally and the stream is dropped once the matching response arrives.
- Results without `resultType` are `complete`; `input_required` passes through to the UI; anything else is an error.
- Errors cross into JavaScript as JSON `McpError { kind, message, status?, code?, data? }` with a message a user can act on.
- Connection state is per server URL (`src/mcp/registry.rs`, `sdk-client/mcp.js`). In Rust, never hold a `RefCell` borrow (or any lock) across `.await`.
- The service worker can be stopped at any time: MCP exports reconnect on demand, and message handling runs inside `event.waitUntil()`.
- Bearer tokens come only from the page (or the server list the page registers) or the worker's sign-in store, never from tool output, and are redacted from logs. They never go into anything sent to a model: the Chat app's server list goes through `serversForModel`.

### Sign-in (OAuth)
- Follow the MCP authorization spec (2026-07-28). Each library (`src/oauth/`, `sdk-client/oauth.js` over the SDK's `auth()`) does discovery, registration, PKCE, the authorization URL, the callback checks, code exchange and refresh. It stores nothing: the worker keeps clients, tokens and pending sign-ins in IndexedDB (`public/authStore.js`).
- Discovery order: protected resource metadata from the `WWW-Authenticate` challenge, then the path-inserted well-known URL, then the root. The metadata's `resource` must match the server URL. Authorization server metadata: RFC 8414 path insertion, then OIDC path insertion, then OIDC path appending; the `issuer` must match exactly and S256 must be supported.
- Always send PKCE S256, `state` and `resource` (on the authorization and token requests). Check `state` before anything else in a callback, then `iss` per RFC 9207, and only then show the callback's error.
- Register with DCR as `native` from loopback pages and `web` otherwise. Key registrations by issuer and redirect URI.
- Tokens never leave the worker except to the server they were issued for and its authorization server: pages get `authStatus` only, logs get `[redacted]`. Refreshes for one server are serialized because refresh tokens may rotate.
- A 401 rejects with `auth_required` and carries the challenge in `data.wwwAuthenticate` when it's readable. The worker retries once after a forced refresh.

### Workbench
- The Workbench lives in ES modules under `public/workbench/`; `index.html` loads `index.js` with `import()`, which calls `installWorkbench(appShell)`. Keep new Workbench logic there rather than in `index.html`.
- `AppShell` (in `index.html`) is the controller: the worker, servers, sign-in, calls, resource reads and prompt gets. It doesn't draw the Workbench; it emits `servers`, `select`, `tools`, `catalog`, `auth`, `run` and `recorded` events. The Workbench state (`workbench.js`) owns selection (a tool, or a resource, template or prompt, and the open tab `view`), environments, saved requests, Run all, the frame and the pane sizes, with its own events.
- Each part of the screen is one custom element in `components/` (rail, server bar, tools, request, resource, prompt, response, contents, splitter, dock, sheet, palette), extending `WbElement`. Components never call each other: they listen to and call `AppShell` and the Workbench state only, and subscribe with `this.lifetime` so they clean up when moved. A new part is a new component, not code in another one.
- Layouts are CSS only: every component has a `wb-area-*` grid area, and a `#workbench[data-layout]` block in `workbench.css` arranges them (layout B today). Don't hard-code positions in the components. Components that share an area take turns by hiding themselves for the other tabs (`view`).
- Pane sizes are CSS variables (`--rail-width`, `--tools-width`, `--request-fr`, `--response-fr`) that `wb-splitter` sets from `workbench.panes` (saved in `localStorage` `workbenchPanes`). The layout wraps them in `clamp()` or `minmax()` so a saved size can't break a narrower window. Splitters must stay usable from the keyboard (arrow keys, Home, End) and reset on double-click.
- Resource reads and prompt gets aren't tool calls: they aren't recorded as runs. Resource lists aren't cached in the libraries; only `tools/list` is.
- Every tool call is recorded as a run in `handleToolCall`, whatever its source. Recording must never fail the call; log a warning instead.
- `{{variables}}` are resolved in the page, which has the tool's schema for type conversion, before `call_tool` goes out. The worker gets the sent arguments plus the arguments as written in `run.args`.
- Pre-fill's test data (`prefill.js`) takes hints first (`const`, a variable named like the field, `default`, examples, a value its description gives) and generates the rest. It must stay deterministic and valid for the schema: `npm run test:unit` validates it with Ajv. Staged test data is environment variables named like fields, never a separate store.
- Opening a tool fills only its required fields; Fill beside a field fills that one (`fieldTestData`). Never fill optional fields unasked, and never generate an optional pagination cursor. A value from a description must be one the description gives as a value, not prose: add the description to `tests/prefill.test.mjs` when one fills something that makes no sense.
- Runs compare on a hash of the result with sorted keys and no `_meta`. A saved request's runs compare with each other, and other calls with the same tool and sent arguments.
- Never put credentials in Workbench records. Arguments are stored as written, and tokens travel only in `mcpOptions`.
- The store keeps its first name, `mcp_sandbox`. Changing its stores or indexes needs a new `DB_VERSION` with an upgrade path for existing data. Run sources are `workbench`, `collection`, `app`, `chat` and `reply`; treat `sandbox` (from before the rename) as `workbench`.
- Saved requests, steps and app manifests share one shape for a call, `{serverUrl, toolName, args}`. Keep it that way, so saved requests can become workflow steps.

### Apps you build
- An app is a screen and a flow (`public/apps/`). The flow runs in the page and calls tools only through `AppShell.runTool` with `source: 'app'` and the arguments it filled in (`sentArgs`), so each call is a run and the worker has no app logic.
- The screen runs in a `sandbox="allow-scripts"` frame under `frameDocument`'s policy: no network, no scripts but the runtime, an opaque origin (never same-origin, even for HTML our own tool calls return). It reports events and shows values; it never calls tools. Messages both ways carry the load's token, and a frame that navigates stops the app.
- A part is HTML a model or a tool made, kept without scripts, handlers or forms (`sanitizePart`), its ids prefixed with the part's id and its styles in `@scope`. Ask a model calls the Chat app's model (`ask.js`), a run from the app like any other call.
- A rule's `when` is a list of triggers; `{{name}}` is an element's value, then an environment variable; a whole `{{name}}` takes the field's type. What a route shows is a template over the answer (`text`, `structured`, `json`, `html`, `result`, `error`) and the screen. Element ids can't be those answer names.
- The canvas draws the flow (`graph.js`): every wire is one part of a rule, and the canvas keeps only where each tool sits (`rule.position`). Change the flow's shape and the graph together.
- DML (`dml.js`) is the portable form. Its reader and writer change together and stay DOM-free; old files must stay readable, and a change older readers can't read raises `DML_VERSION`. Apps live in IndexedDB `mcp_apps`, separate from `mcp_sandbox`.
- Only edits may change an app: AppShell's `fillToolForm` fires `input` when it fills a form, which the call editor ignores.

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
- [x] Pre-fill from what was last sent, saved requests and test data from the schema (hints, staged variables, then generated values); environments with `{{variables}}`, and staging a request's values as variables
- [x] Saved requests in collections, running again and Run all with what changed, and a line diff
- [x] History of every tool call (Workbench, chat, tool calls in replies), kept in IndexedDB
- [x] Export and import of saved requests, collections and environments
- [x] Layout B built from components: rail, server bar, tools (filters, groups), request and response panes, dock (Log, Trace, Runs), side sheets, Go to and keyboard shortcuts
- [x] The Console moved to Apps as the Chat app (Model, Instructions and context, Conversation)

### Done (milestone 3: MCP client libraries)
- [x] A second library on the official TypeScript SDK (`sdk-client/`), with the same interface, trace, errors and sign-in
- [x] Switching libraries while the app runs (Runtime, then Library; `?client=`), for every tab, remembered across worker restarts
- [x] The smoke test on every library (`--client=`), and the tool-call benchmark (`npm run bench`, `/bench/`)
- [x] The Chat app's model never gets static tokens with the server list
- [x] The library interface is MCP, sign-in and runtime status only; the Chat app's instructions live in the worker (`public/chat-instructions.js`)
- [x] The agent loop's names are plain (conversation, model, context, instructions), with `chat_contexts` version 2 and the page moving its old settings over
- [x] Runs compare a result without `resultType` as complete, so switching libraries doesn't show "Changed"
- [x] The TypeScript SDK library is the default (`DEFAULT_CLIENT`); Rust/WASM is the alternative to compare against
- [x] Resources (every page, templates with RFC 6570 URIs, text and binary reads) and prompts (arguments with test data, messages) in both libraries and the Workbench, on both eras
- [x] Resizable Workbench panes (rail, tool list, request and response), kept across reloads
- [x] Test data for the required fields when a tool opens, Fill beside each field, and values from descriptions only when they're values

### Done (app builder milestone 2, first step: build, run and download an app)
- [x] Apps page rail: the built-in Chat app, your apps, New app and Import
- [x] A screen from components, or HTML from a tool call (or pasted), run in a sandboxed frame with no network, storage or scripts of its own
- [x] A flow of rules: when an element is clicked, gets Enter or changes, or the app opens; call a tool with `{{id}}` values from the screen; then, if it works or fails, put a template of the answer into an element
- [x] Try it beside the builder, with What happened step by step, and each call a run from App
- [x] Download as a zip (`app.dml`, `index.html`, `README.md`) or DML alone, with versions; Import back
- [x] The mock's `make_screen` (an HTML screen), unit tests for DML, zips and the flow, and the smoke test building an app on both libraries

### Done (app builder milestone 2, second step: the canvas)
- [x] The canvas: the screen running with a port beside each element, Start, a node for each rule's tool, wires dragged between ports (triggers, fields, answers and errors), transforms on the wires, Design and Run with wires lighting up, Tidy up
- [x] The Library (components, tools, transforms; click or drag) and the Inspector (an element, a tool's rule, a wire, Start, or the screen), with values picked from a rule's last answer
- [x] Rules with several triggers and a position, in DML as `<or>` and `x`/`y`; the Outline keeps the cards
- [x] HTML parts a model or a tool makes, among the components: sanitized, ids named after the part, styles scoped, wired like any element; Ask a model (Make it, Change it) with the Chat app's model; `parts/<id>.html` in the zip
- [x] The mock's `chat`, a stand-in model that writes a ticket dashboard, and the smoke test wiring the canvas with real mouse drags on both libraries

### Done (app builder milestone 2, third step: dashboards)
- [x] Boxes: outputs that say what they show (text, number, list, table, bar or line chart, HTML) and what goes in them; a rule wired to them adds to its prompt field a request for one JSON object with a key for each, and each box draws its key of the answer
- [x] Answers' JSON read from a ```json block, with line breaks inside strings escaped and citation marks dropped, as Glean's chat writes it
- [x] Wide screens with widths for components, and the Project pulse dashboard starter (Glean's chat, else the Chat app's model)
- [x] Links in a box open in a new tab through the page; the mock's chat answers boxes with made-up JSON in their shapes

### Next
- [ ] App builder milestone 2, next steps: rules that chain (a tool's Answer wired to another tool), the Chat app's model, instructions and conversation as parts of a flow, allowed tools and output checks
- [ ] App builder milestone 3: a download that runs on its own (a static site or web component with a library); milestone 4: an in-browser model as a local MCP server
- [ ] Client ID metadata documents (the spec's preferred registration), step-up authorization, token revocation on sign-out
- [ ] Durable state in IndexedDB (server config, era cache, conversations)
- [ ] `input_required` / elicitation UI (multi round-trip requests)
- [ ] `subscriptions/listen` for list-change notifications and resource subscriptions
- [ ] Completions for prompt and resource template arguments
- [ ] MCP Apps (`io.modelcontextprotocol/ui`) in sandboxed iframes

## Testing Requirements
- Protocol logic that doesn't touch the browser (SSE parsing, header encoding, era classification, envelopes) gets native unit tests in its module.
- Changes to a library, the connection flow, sign-in, the service worker or the Workbench and Apps UI must pass `npm run test:browser -- --reference` (the default, TypeScript SDK) and `npm run test:browser:wasm -- --reference`, which cover modern, legacy, SSE, dual-era, strict-CORS, token-protected and OAuth mock servers, sign-in and refresh, the layout and inspector, the Workbench, the Chat app, the official Python SDK server, a service worker restart, a second tab, unreachable servers and what the log records. `npm run test:public` adds the public servers the in-app Guide suggests.
- New server behaviors should be added to `test_mcp_server.py` (standard library only) rather than mocked in the client.
