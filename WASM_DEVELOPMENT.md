# WASM Development Rules

## Adding New WASM Functionality

When adding new functionality to the WASM module, follow these steps in order:

1. **Rust Implementation** (`src/lib.rs` for exports; protocol code belongs in `src/mcp/`):
   ```rust
   #[wasm_bindgen]
   pub fn my_new_function() -> Result<String, JsValue> {
       // Implementation
       Ok("result".to_string())
   }
   ```

2. **Service Worker Integration** (`public/sw.js`):
   - Add function to `wasmInstance` handling
   - Add appropriate debug logging
   - Add error handling
   ```javascript
   // In the message handler:
   case 'my_new_function':
       if (!wasmInstance) {
           throw new Error('WASM module not initialized');
       }
       try {
           const result = await wasmInstance.my_new_function();
           broadcastToClients({
               type: 'my_new_function_result',
               result: result
           });
       } catch (error) {
           logger.error(`my_new_function failed: ${error.message}`);
       }
       break;
   ```

3. **Client-Side Integration** (`public/index.html`):
   - Add UI elements if needed
   - Add message handling
   - Add status updates
   ```javascript
   // In handleServiceWorkerMessage:
   case 'my_new_function_result':
       // Handle the result
       this.updateUIWithResult(message.result);
       break;
   ```

## MCP Client API

The MCP client lives in `src/mcp/`, sign-in in `src/oauth/`, and both use `src/http.rs` for requests; the exports are in `src/lib.rs`. Every call takes and returns JSON strings. On failure the promise rejects with a JSON `McpError` (`src/error.rs`): `{kind, message, status?, code?, data?}`, where `kind` is one of `network`, `timeout`, `auth_required`, `auth_failed`, `http`, `protocol`, `unsupported_version`, `invalid_response` or `internal`. `mcpError()` in `sw.js` parses it. A 401 rejects with `auth_required`, and `data.wwwAuthenticate` holds the challenge when the browser could read it.

| Export | Returns |
| --- | --- |
| `connect(url, options)` | `{url, era, protocolVersion, serverInfo, capabilities, instructions}` |
| `list_tools(url, options)` | `{tools, rejected, ttlMs, cacheScope, fromCache}` |
| `call_tool(url, name, argsJson, options)` | the JSON-RPC `result` (check `resultType`: `complete` or `input_required`) |
| `forget_server(url)` | nothing; drops the remembered connection |
| `set_logger(fn)` | nothing; `fn` then receives every log entry as a JSON string (see [Logging](#logging)) |
| `auth_begin(serverUrl, options)` | `{authorizationUrl, pending, client, newClient, authServer, scope}` |
| `auth_finish(pendingJson, callbackJson)` | the tokens record |
| `auth_refresh(tokensJson)` | the refreshed tokens record (rejects with `auth_required` when the user has to sign in again) |

`options` is `{"bearerToken"?: string, "refresh"?: boolean}`. `list_tools` and `call_tool` connect on their own if needed, so they keep working after the browser restarts the service worker.

The auth exports do the network steps and checks but store nothing; the worker keeps their records in IndexedDB (`authStore.js`):

- `auth_begin` options are `{redirectUri, applicationType: 'native' | 'web', clients, wwwAuthenticate?}`. It discovers the authorization server, reuses a client from `clients` registered with that issuer for that redirect URI or registers a new one (store it when `newClient` is true), and builds the authorization URL. Keep `pending` (keyed by its `state`) until the callback arrives.
- `auth_finish` takes that `pending` record and the callback's `{code, state, iss, error, errorDescription}`. It checks `state` and `iss`, then exchanges the code.
- The tokens record is `{serverUrl, resource, issuer, clientId, clientSecret?, tokenEndpointAuthMethod, tokenEndpoint, accessToken, refreshToken?, scope?, expiresAt?}` (`expiresAt` in ms). Pass it to `auth_refresh` as is. A refresh keeps the old refresh token when the server doesn't rotate it.

Page-to-worker messages and the replies the worker broadcasts:

| Message | Reply |
| --- | --- |
| `{type: 'connect-mcp', url, bearerToken?}` (`initialize-mcp` still works) | `mcp_server_connected {url, info}` or `mcp_server_error {url, action, error}` |
| `{type: 'list_tools', url, refresh?, bearerToken?}` | `tools_list {url, tools, rejected, ttlMs, fromCache}` or `mcp_server_error` |
| `{type: 'call_tool', tapConfig, engramId, bearerToken?}` | `tool_result {result}` or `tool_result {error, errorKind}` |
| `{type: 'forget-mcp', url}` | none |
| `{type: 'auth-start', url, wwwAuthenticate?}` | `auth_redirect {url, authorizationUrl, issuer}` or `auth_error {url, error}`, to the sender only |
| `{type: 'auth-callback', query}` (the callback's query string, from `oauth-callback.html` or pasted into a page) | `auth_callback_done {ok, url?, error?, unknownState?}` to the sender, then `auth_complete {url, status}` or `auth_error {url, error}` to every page. `unknownState` means no sign-in in this browser has that `state`: it was started in another browser, expired, or was used already |
| `{type: 'auth-status', url}` | `auth_status {url, status}` |
| `{type: 'auth-signout', url, forgetClient?}` | `auth_status {url, status}` to every page |

`status` is `{signedIn, issuer?, scope?, expiresAt?, refreshable?, clientId?}`: pages learn whether they're signed in, never the tokens. MCP calls get their credentials in the worker: a static `bearerToken` wins, otherwise the stored access token, refreshed first when it expires within a minute. When a server turns down an OAuth token with `auth_required`, the worker refreshes it once and retries (`withAuth` in `sw.js`). Refreshes for one server run one at a time, because refresh tokens may rotate.

The worker handles every message inside `event.waitUntil()` so a long call keeps it alive. It logs only a message's type and target, never its payload, so bearer tokens and authorization codes stay out of the logs.

## Logging

Every log entry, wherever it starts, has the same shape and ends up in each open page's Logs tab:

```js
{ time, level: 'debug' | 'info' | 'warn' | 'error', source: 'page' | 'worker' | 'wasm', message, server?, detail? }
```

Log from wherever the event happens:

```rust
// Rust (src/mcp/): the server URL comes first. The service worker registers the logger at load.
logging::info(url, &format!("Reconnecting: {}", err.message));
logging::emit(Level::Debug, url, &format!("→ {request}"), Some(&detail));
```

```js
// Service worker (sw.js, wasm.js)
logger.info(`Listed ${count} tools in ${formatDuration(ms)}`, { server: url, detail: { ttlMs } });

// Page (index.html)
chatShell.log({ level: 'error', message: 'Select a server first', server: url });
```

What goes where:

- **info**: what a person testing the client wants to follow: each connect, listing and call with how long it took, and every protocol decision (fallbacks, version retries, reconnects) with the reason.
- **warn**: something was skipped or degraded: a hidden tool, an `isError` result, an `input_required` result.
- **error**: an operation failed. Put the `McpError` kind, status and code in `detail`, not the message.
- **debug**: the wire: `transport::post` traces each request (method, target, id, MCP headers, body) and reply (status, SSE or JSON, timing, body). Bodies over 4 KB are cut.

Write messages as sentences someone can act on, and put structured data in `detail` rather than in the message. Never log an `Authorization` value or a token; `http::send` redacts the `Authorization` header and the secret fields of form and JSON bodies (`access_token`, `refresh_token`, `id_token`, `code`, `code_verifier`, `client_secret`, `registration_access_token`), the transport trace shortens session IDs, and unit tests check both. The worker prints entries to its console with the matching `console` method, so debug entries only show at DevTools' Verbose level.

## Message Flow Pattern

1. **Client to Service Worker**:
   ```javascript
   // In index.html
   this.serviceWorker.postMessage({
       type: 'my_new_function',
       params: { /* any parameters */ }
   });
   ```

2. **Service Worker to WASM**:
   ```javascript
   // In sw.js
   const result = await wasmInstance.my_new_function();
   ```

3. **WASM to Service Worker**:
   ```rust
   // In lib.rs
   #[wasm_bindgen]
   pub fn my_new_function() -> Result<String, JsValue> {
       Ok("result".to_string())
   }
   ```

4. **Service Worker to Client**:
   ```javascript
   // In sw.js
   broadcastToClients({
       type: 'my_new_function_result',
       result: result
   });
   ```

## Status Updates Pattern

1. **Service Worker Status Broadcast**:
   ```javascript
   // In sw.js
   broadcastToClients({
       type: 'status_update',
       status: {
           healthy: true,
           metadata: {
               version: wasmInstance.get_version(),
               buildInfo: wasmInstance.get_compiled_info()
           }
       }
   });
   ```

2. **Client Status Handling**:
   ```javascript
   // In index.html
   case 'status_update':
       this.updateStatus(message.status);
       break;
   ```

## Error Handling Pattern

1. **WASM Level**:
   ```rust
   // In lib.rs
   #[wasm_bindgen]
   pub fn my_function() -> Result<String, JsValue> {
       if error_condition {
           return Err(JsValue::from_str("Error message"));
       }
       Ok("success".to_string())
   }
   ```

2. **Service Worker Level**:
   ```javascript
   // In sw.js
   try {
       const result = await wasmInstance.my_function();
       // Handle success
   } catch (error) {
       logger.error(`my_function failed: ${error.message}`);
       broadcastToClients({
           type: 'error',
           message: error.message
       });
   }
   ```

3. **Client Level**:
   ```javascript
   // In index.html
   case 'error':
       this.log({ level: 'error', message: message.message });
       break;
   ```

## Testing New Functionality

1. **Build and Test**:
   ```bash
   ./wasm-build.sh
   npm run test:rust      # unit tests for the protocol logic
   npm run test:browser   # the real UI in headless Chrome against the mock servers
   ```

2. **Reload the page**. Each load checks the worker's scripts, and `build.js` (written by `wasm-build.sh`) changes with every build, so a new worker installs and takes over. The Logs tab shows "Installing the service worker for WASM build …" followed by "Loaded the WASM module" with the new build time.

3. **If the old build is still running**: open DevTools → Application → Service workers and choose Unregister, then reload. Clear site data as well if saved servers or chat history get in the way.

## Debugging Tips

1. **Logs**:
   - The Logs tab has entries from the page, the worker and the WASM client. Choose Everything to see each HTTP request and reply.
   - The worker's own console is at `chrome://inspect/#service-workers`; debug entries show at DevTools' Verbose level.
   - `python3 test_mcp_server.py --verbose` prints what arrives at the mock, headers included.

2. **WASM Status**:
   - Monitor the status indicators in the UI
   - Check the uptime counter
   - Verify build info is displayed

3. **Message Flow**:
   - DevTools → Network, with the worker's DevTools open, shows the worker's requests to MCP servers
   - Page-to-worker messages appear as debug entries ("Page sent list_tools")

## Common Issues

1. **WASM Not Initialized**:
   - Check service worker registration
   - Verify WASM module loading
   - Check for initialization errors

2. **Message Not Received**:
   - Verify message type matches
   - Check service worker is active
   - Ensure proper error handling

3. **Status Not Updated**:
   - Verify broadcast is called
   - Check client message handling
   - Ensure UI update functions exist 