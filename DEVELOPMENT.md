# Development

How the pieces fit, for changing the worker, adding an MCP client library, or building an app on them. The [README](README.md) covers using the app.

## How a call flows

```text
page (index.html, the Workbench, apps) ──postMessage──▶ service worker (sw.js)
                                                          │  client-runtime.js: the library the page chose
                                                          ▼
                                       MCP client library (Rust/WASM or TypeScript SDK)
                                                          │  Streamable HTTP
                                                          ▼
                                                     MCP servers
```

- **Pages don't speak MCP.** They send the worker the messages in [Page and worker messages](#page-and-worker-messages), and the worker broadcasts what every tab should know.
- **The worker doesn't build JSON-RPC.** It calls the library and records what happened: runs in `public/workbench/store.js`, sign-ins in `public/authStore.js`, conversations in `public/chatStorage.js`, all in IndexedDB.
- **The library stores nothing.** It does the protocol and the sign-in network steps, and keeps connections in memory only.

The browser can stop the worker whenever it's idle, so every message is handled inside `event.waitUntil()`, and libraries reconnect on demand.

## MCP client libraries

`public/mcp-clients.js` lists the libraries and loads them; `public/client-runtime.js` keeps the one the page chose loaded and remembers the choice in Cache Storage (`mcp-client-settings`), so a restarted worker loads the same one. Switching unloads the old library at once: every request after a `set_client` goes to the new one, and each server connects again on its next request.

| Name | Library | Source | Built by | Output |
| --- | --- | --- | --- | --- |
| `wasm` (default) | Rust/WASM client | `src/`: exports in `lib.rs`, protocol in `mcp/`, sign-in in `oauth/`, requests in `http.rs` | `npm run build:wasm` (`wasm-build.sh`, wasm-bindgen `no-modules`) | `public/mcp_browser_client.js`, `public/mcp_browser_client_bg.wasm`, `public/build.js` |
| `sdk` | TypeScript SDK client | `sdk-client/`: the interface in `index.js` over [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk); `mcp.js` connections, `oauth.js` sign-in, `trace.js` the HTTP trace | `npm run build:sdk` (esbuild) | `public/sdk_client.js`, `public/build-sdk.js` |

Service workers can't `import()` on demand, so each library is a script the worker fetches and evaluates. Its build file (`build.js`, `build-sdk.js`) holds the output's hash and is imported by `mcp-clients.js`, which makes every rebuild a worker update.

### The interface

Every library exports the same functions. MCP and sign-in calls take and return JSON strings. On failure the promise rejects with a JSON `McpError` (`src/error.rs`, `sdk-client/errors.js`): `{kind, message, status?, code?, data?}`, where `kind` is one of `network`, `timeout`, `auth_required`, `auth_failed`, `http`, `protocol`, `unsupported_version`, `invalid_response` or `internal`. `mcpError()` in `sw.js` parses it. A 401 rejects with `auth_required`, and `data.wwwAuthenticate` holds the challenge when the browser could read it.

| Export | Returns |
| --- | --- |
| `connect(url, options)` | `{url, era, protocolVersion, serverInfo, capabilities, instructions}` |
| `list_tools(url, options)` | `{tools, rejected, ttlMs, cacheScope, fromCache}` |
| `call_tool(url, name, argsJson, options)` | the JSON-RPC `result` (check `resultType`: `complete` or `input_required`) |
| `forget_server(url)` | nothing; drops the remembered connection |
| `auth_begin(serverUrl, options)` | `{authorizationUrl, pending, client, newClient, authServer, scope}` |
| `auth_finish(pendingJson, callbackJson)` | the tokens record |
| `auth_refresh(tokensJson)` | the refreshed tokens record (rejects with `auth_required` when the user has to sign in again) |
| `set_logger(fn)` | nothing; `fn` then receives every log entry, as a JSON string or an object (see [Logging](#logging)) |
| `get_compiled_info()`, `get_version()` | what the Runtime menu and the log show about the build |
| `get_uptime()`, `increment_uptime()`, `get_metadata()` | the Runtime menu's health check |
| `reset()` (optional) | nothing; drops every connection when the worker unloads the library |

`options` is `{"bearerToken"?: string, "refresh"?: boolean}`. `list_tools` and `call_tool` connect on their own if needed, so they keep working after the browser restarts the worker. That's the whole interface: anything an app needs beyond MCP and sign-in, such as the Chat app's instructions, belongs to the worker.

The auth exports do the network steps and checks but store nothing; the worker keeps their records in IndexedDB (`authStore.js`):

- `auth_begin` options are `{redirectUri, applicationType: 'native' | 'web', clients, wwwAuthenticate?}`. It discovers the authorization server, reuses a client from `clients` registered with that issuer for that redirect URI or registers a new one (store it when `newClient` is true), and builds the authorization URL. Keep `pending` (keyed by its `state`) until the callback arrives.
- `auth_finish` takes that `pending` record and the callback's `{code, state, iss, error, errorDescription}`. It checks `state` and `iss`, then exchanges the code.
- The tokens record is `{serverUrl, resource, issuer, clientId, clientSecret?, tokenEndpointAuthMethod, tokenEndpoint, accessToken, refreshToken?, scope?, expiresAt?}` (`expiresAt` in ms). Pass it to `auth_refresh` as is. A refresh keeps the old refresh token when the server doesn't rotate it.

### Adding a library

1. **Implement the interface** above, in whatever language compiles to something a worker can evaluate. Behaviors the app relies on are in [MCP Support](README.md#mcp-support): era detection, the CORS fallback, reconnecting, `x-mcp-header` checks, and the log lines and trace entries the dock shows.
2. **Register it** in `public/mcp-clients.js`: an entry in `MCP_CLIENTS` (`name`, `label`, `logSource`, `build`), a loader that fetches and evaluates it and returns `{module, bytes}`, and a generated build file it imports.
3. **Offer it in the Runtime menu**: an `<option>` in `#clientSelect` in `index.html`. The page reads the list from there, and `?client=<name>` picks it.
4. **Test and measure it**: `node tests/browser-smoke.mjs --client=<name> --reference` runs every check on it, and a variant in `public/bench/sw.js` and `suite.js` adds it to the benchmark.

### How the two differ

Both pass the same smoke test and send the same requests in the same order, with the same headers, `_meta` and `Mcp-Param` encoding. Running it on both and comparing what they logged and sent turned up these differences:

- **The SDK's CORS fallback needs a window.** It only retries a blocked `server/discover` with the 2025 handshake when `window` and `document` exist, so in a worker `sdk-client/mcp.js` retries with the SDK's `prior: { kind: 'legacy' }` itself.
- **Results lose `resultType: "complete"`** with the SDK. Runs compare a result without one as complete (`comparedValue` in `public/workbench/runs.js`), so switching libraries doesn't make a saved request show "Changed".
- **Legacy servers get one more request** from the SDK, a `GET` for a server-sent stream after the handshake (the mock answers 405).
- **Sign-in differs a little.** The SDK adds `scope` to the client registration and `prompt=consent` when it asks for a refresh token.
- **Some wording is the SDK's**: hidden-tool reasons and the wrong-issuer error.
- **One fragile spot**: the SDK only says why it hid a tool through `console.warn`, so `sdk-client/mcp.js` overrides its internal `_excludeInvalidXMcpHeaderTools` to catch the reason. Check it when upgrading the SDK.

## Page and worker messages

| Message | Reply |
| --- | --- |
| `{type: 'connect-mcp', url, bearerToken?}` (`initialize-mcp` still works) | `mcp_server_connected {url, info}` or `mcp_server_error {url, action, error}` |
| `{type: 'list_tools', url, refresh?, bearerToken?}` | `tools_list {url, tools, rejected, ttlMs, fromCache}` or `mcp_server_error` |
| `{type: 'call_tool', call, bearerToken?, run?}`, where `call` is `{serverUrl, toolName, args}` | `tool_result {result, run}` or `tool_result {error, errorKind, run}`, plus `run_recorded {run}` to every page |
| `{type: 'forget-mcp', url}` | none |
| `{type: 'auth-start', url, wwwAuthenticate?}` | `auth_redirect {url, authorizationUrl, issuer}` or `auth_error {url, error}`, to the sender only |
| `{type: 'auth-callback', query}` (the callback's query string, from `oauth-callback.html` or pasted into a page) | `auth_callback_done {ok, url?, error?, unknownState?}` to the sender, then `auth_complete {url, status}` or `auth_error {url, error}` to every page. `unknownState` means no sign-in in this browser has that `state`: it was started in another browser, expired, or was used already |
| `{type: 'auth-status', url}` | `auth_status {url, status}` |
| `{type: 'auth-signout', url, forgetClient?}` | `auth_status {url, status}` to every page |
| `{type: 'set_client', client}` (a name from `mcp-clients.js`) | `client_set {client, loaded}` to the sender; `client_loaded {client, size, buildInfo}` to every page once it loads |
| `{type: 'check_client'}` | the JSON-RPC notification `client_status {status: {healthy, uptime}, metadata}` to every page |
| `{type: 'reload_client'}`, `{type: 'unload_client'}` | `client_loaded` after a reload; `client_status {healthy: false}` if it fails |
| `{type: 'init_mcp_servers_index', servers}` | none; the server list (with static tokens) for calls the worker starts itself |

`status` is `{signedIn, issuer?, scope?, expiresAt?, refreshable?, clientId?}`: pages learn whether they're signed in, never the tokens. MCP calls get their credentials in the worker: a static `bearerToken` wins, otherwise the stored access token, refreshed first when it expires within a minute. When a server turns down an OAuth token with `auth_required`, the worker refreshes it once and retries (`withAuth` in `sw.js`). Refreshes for one server run one at a time, because refresh tokens may rotate.

The worker logs only a message's type and target, never its payload, so bearer tokens and authorization codes stay out of the logs. The Chat app's messages are in [The agent loop](#the-agent-loop).

### Runs (the Workbench's history)

Every tool call becomes a run, whichever part of the app made it: `handleToolCall` in `sw.js` records it at its one success point and its one failure point (`recordRun`), in the `runs` store of `public/workbench/store.js`. Workbench calls have `source` `workbench` (or `collection` from Run all; runs saved before the rename say `sandbox`), the chat's model calls `chat` and tool calls found in its replies `reply`.

- **What the page sends:** `call_tool`'s `call.args` are the arguments to send, with `{{variables}}` already filled in by the page (`public/workbench/template.js`, which knows the tool's schema). `run` is `{id, args, requestId?, collectionRunId?, environmentName?}`: the page's id for the run, so it can wait for this answer; the arguments as written; the saved request and Run all it came from; and the environment whose variables it used.
- **What comes back:** `tool_result.run` and `run_recorded.run` are `{id, startedAt, durationMs, outcome, changed, previousRunId}`, and `run_recorded` adds `source`, `serverUrl`, `toolName`, `requestId` and `errorKind` for the history views. `outcome` is `ok`, `tool_error` (`isError` results) or `failed`. `changed` is `true` or `false` against the previous run of the same request, or `null` for the first.
- **Comparing:** runs of a saved request compare with each other, and other calls with earlier calls of the same tool and sent arguments (`compareKey`). Results are compared by a SHA-256 of their JSON with keys sorted and every `_meta` removed (`resultHash`, `public/workbench/runs.js`).
- **In the page:** `AppShell` turns these messages into events for the Workbench's components: `run` (`pending`, `done` or `not-sent`, for the call the response pane shows) and `recorded` (every `run_recorded`). See the README's Workbench section for how the components fit together.
- **Storage:** the store keeps the newest 500 runs. Arguments or results over 256 KB of JSON are kept as the start of their text (`argsText`, `sentArgsText`, `resultText`) with `truncated` set.
- **Failures:** recording failures are logged as warnings and never fail the call.

## The agent loop

The Chat app (Apps in the top bar) is the first app built on the libraries, and the place the agent loop lives. The model is an MCP tool on any server, and the worker runs the loop:

1. The page sends `chat_send {text, conversationId}`. The worker saves the message in the conversation and sends it to every page as `chat_message`; each page shows the messages of the conversation it has open.
2. If a model is set (`set_chat_model`), the worker builds its arguments (`modelArguments` in `sw.js`). The tool's message field (`messageField`) gets your message. Its conversation field (`conversationField`) gets what the model is told before the conversation and then the conversation so far, oldest first: the built-in instructions (`public/chat-instructions.js`), the server list with every tool's definition (static tokens removed), the context the page added (`set_chat_context`), then the conversation. A model without a conversation field only gets your message, so it doesn't know which tools there are.
3. The worker calls the model's tool through the MCP client library, like any call (a run with source `chat`), and the reply's text joins the conversation as a `tool` message.
4. **Tool use:** every JSON-RPC request in a code block of the reply, `{"jsonrpc": "2.0", "method": "<tool name>", "params": {…}}`, is a tool call. The worker finds a connected server with a tool of that name, calls it (a run with source `reply`, `runReplyToolCall`), and adds the result to the conversation. Results are scanned the same way, so calls can chain.
5. The model isn't called again until the next message, which sends it everything so far, tool results included.

**Guardrails:** at most three calls from replies per conversation every 10 seconds (`shouldBreakCircuit`); a method no server offers is reported as "Tool not found"; the server list the model gets has no static tokens (`serversForModel`), and calls from replies get their credentials in the worker, like every other call. Tool choice is the model's, from the definitions it was sent, and only tools on servers you've added can run.

**Messages:**

| Message | What it does |
| --- | --- |
| `{type: 'set_chat_model', model}` | sets the model: `{serverUrl, toolName, args, messageField, conversationField}`. A preset value for the message field is a template: `{{message}}` in it becomes your message |
| `{type: 'set_chat_context', context}` | the context you added, `[{id, name, text, timestamp}]`, which the model gets after the instructions and the server list |
| `{type: 'get_chat_instructions'}` | `chat_instructions {instructions}`: the built-in instructions' text, for the page to show |
| `{type: 'chat_send', text, conversationId}` | runs one turn, as above. Replies: `chat_message {message: {text, role, timestamp, conversationId}}` for each message, and `tool_result {…, conversationId}` for each call |
| `{type: 'get_chat_history', conversationId}` | `chat_history {conversationId, messages}`: the conversation so far |
| `{type: 'reply_tool_call', toolCall, conversationId}` | runs one JSON-RPC tool call as if a reply had made it |

**Where it's kept:** conversations in IndexedDB `chat_contexts` (`public/chatStorage.js`), a record per conversation and one per message, keyed by `conversationId`; the model in `localStorage` `chatModel`, the context in `chatContext`, and the last conversation in `lastChatConversation` (each tab's own in `sessionStorage` `chatConversation`). The first version of the loop called conversations engrams, the model a tap and the context imprints. Version 2 of `chat_contexts` moves engram records over when the worker first opens it, and the page moves the old `localStorage` keys (`lastEngramId`, `cbusTapConfig`, `mcp_module_metadata`) once; the old placeholder `{{cbus_message}}` still works.

## Logging

Every log entry, wherever it starts, has the same shape and ends up in each open page's log (the Workbench's dock):

```js
{ time, level: 'debug' | 'info' | 'warn' | 'error', source: 'page' | 'worker' | 'wasm' | 'sdk', message, server?, detail? }
```

A library's entries carry its `logSource` from `mcp-clients.js`. Log from wherever the event happens:

```rust
// Rust (src/mcp/): the server URL comes first. The service worker registers the logger at load.
logging::info(url, &format!("Reconnecting: {}", err.message));
logging::emit(Level::Debug, url, &format!("→ {request}"), Some(&detail));
```

```js
// TypeScript SDK client (sdk-client/)
log.info(url, `Reconnecting: ${error.message}`);

// Service worker (sw.js, client-runtime.js)
logger.info(`Listed ${count} tools in ${formatDuration(ms)}`, { server: url, detail: { ttlMs } });

// Page (index.html)
appShell.log({ level: 'error', message: 'Select a server first', server: url });
```

What goes where:

- **info**: what a person testing a library wants to follow: each connect, listing and call with how long it took, and every protocol decision (fallbacks, version retries, reconnects) with the reason.
- **warn**: something was skipped or degraded: a hidden tool, an `isError` result, an `input_required` result.
- **error**: an operation failed. Put the `McpError` kind, status and code in `detail`, not the message.
- **debug**: the wire. Each request (method, target, id, MCP headers, body) and reply (status, SSE or JSON, timing, body). Bodies over 4 KB are cut. The dock's Trace tab is a library's debug entries.

Write messages as sentences someone can act on, and put structured data in `detail` rather than in the message. Never log an `Authorization` value or a token: both libraries redact the `Authorization` header and the secret fields of form and JSON bodies (`access_token`, `refresh_token`, `id_token`, `code`, `code_verifier`, `client_secret`, `registration_access_token`), shorten session IDs, and the Rust unit tests and the smoke test check it. The worker prints entries to its console with the matching `console` method, so debug entries only show at DevTools' Verbose level.

## Adding a worker message

1. **If it's MCP**, add it to every library first: an export in `src/lib.rs` (logic in `src/mcp/`) and in `sdk-client/index.js`, with the same JSON shapes and `McpError`s, and a row in [The interface](#the-interface).
2. **Handle it in `sw.js`**: a `case` in `handleClientMessage`. Call the library through `mcpClient`, catch errors, log the outcome, and reply to the sender (`event.source.postMessage`) or every page (`broadcastToClients`).
3. **Use it from the page**: send it with `appShell.postToWorkerQuietly()` (or `this.serviceWorker.postMessage`), and handle the reply in `handleServiceWorkerMessage` in `index.html`. Workbench components go through `AppShell` events rather than handling worker messages themselves.
4. **Document it** in [Page and worker messages](#page-and-worker-messages), and add a smoke test check.

## Testing

```bash
npm run build                       # both libraries
npm run test:rust                   # the Rust library's protocol logic
npm run test:browser -- --reference # the real UI in headless Chrome, on the Rust/WASM library
npm run test:browser:sdk            # the same on the TypeScript SDK library
npm run bench -- --quick            # tool-call throughput of every library, in a few minutes
```

After a rebuild, reload the page. Each load checks the worker's scripts, and the build files change with every build, so a new worker installs. The log shows "Installing the service worker with the MCP client library builds …" and then "Loaded the Rust/WASM client (…)" with the new build time.

If the old build is still running, the new worker may be waiting: Chrome sometimes keeps it waiting despite `skipWaiting()`. Close the app's other tabs, or open DevTools → Application → Service workers and choose skipWaiting (or Unregister, then reload). Clear site data as well if saved servers or chat history get in the way.

## Debugging

- **Logs**: the dock's Log has entries from the page, the worker and the library. Choose Everything, or open Trace, to see each HTTP request and reply. The worker's own console is at `chrome://inspect/#service-workers`; debug entries show at DevTools' Verbose level. `python3 test_mcp_server.py --verbose` prints what arrives at the mock, headers included.
- **Which library is running**: Runtime in the top bar shows the library, its build and uptime; Check asks the worker for its health, and the log has the "Loaded the …" line.
- **Messages**: page-to-worker messages appear as debug entries ("Page sent list_tools"). DevTools → Network, with the worker's DevTools open, shows the worker's requests to MCP servers.
- **The library didn't load**: the log says why ("Couldn't load the TypeScript SDK client: …"), usually a missing build output. Run `npm run build`, then reload the MCP client from Runtime.
- **A message gets no answer**: check that the type matches a `case` in `sw.js` (the worker logs "Ignored a message of unknown type …") and that the page handles the reply's type.
