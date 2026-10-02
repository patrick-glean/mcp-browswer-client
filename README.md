# MCP Browser Client

A browser client for MCP (the Model Context Protocol). Its protocol logic is Rust compiled to WebAssembly and runs in a service worker that every open tab shares. It speaks MCP 2026-07-28 and falls back automatically for servers still on the older, `initialize`-based revisions.

## Try it

Open [patrick-glean.github.io/mcp-browswer-client](https://patrick-glean.github.io/mcp-browswer-client/). The Guide (top right, and open on your first visit) has one-click buttons for public MCP servers that need no account, such as Hugging Face and Microsoft Learn. Choose one, click a tool, fill in its fields and choose Call tool. The Logs tab shows what happened.

The [Sandbox](#sandbox) tab is where you work with servers: Pre-fill a tool's fields, use `{{variables}}`, save the calls that work and run them again to see what changed.

For servers that need an account, the client signs in with OAuth, as desktop MCP clients do. The Guide starts with Glean: enter your work email (or paste your Glean MCP server URL) and choose Add and sign in. See [Glean](#glean) for the one catch: Glean only answers pages from origins it allows.

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
│   ├── error.rs           # The error type every export rejects with
│   ├── http.rs            # fetch with timeouts, a redacted HTTP trace, form and JSON bodies
│   ├── logging.rs         # Structured log entries, sent to the worker's logger
│   ├── mcp/               # MCP client: transport, SSE parser, headers, modern and legacy eras
│   ├── oauth/             # Sign-in: discovery, client registration, PKCE, token exchange and refresh
│   └── build_info.rs      # Generated build metadata
├── public/                # Web assets and service worker
│   ├── mcp_browser_client_bg.wasm  # Compiled WASM module
│   ├── mcp_browser_client.js       # Generated JS bindings
│   ├── build.js           # Generated: the module's hash, so a rebuild updates the worker
│   ├── sw.js              # Service worker
│   ├── wasm.js            # Loads the WASM module in the worker and forwards its logs
│   ├── logger.js          # The worker's structured logger
│   ├── authStore.js       # IndexedDB storage for sign-ins: registered clients, tokens, sign-ins in progress
│   ├── chatStorage.js     # IndexedDB storage for conversations
│   ├── sandbox/           # The Sandbox tab: saved requests, environments, history (ES modules)
│   │   ├── ui.js          # Pre-fill, Save, the Saved and History views, Run all, export and import
│   │   ├── store.js       # IndexedDB storage (mcp_sandbox), shared by the page and the worker
│   │   ├── runs.js        # What counts as the same request and a changed result
│   │   ├── template.js    # {{variable}} resolution with type conversion
│   │   ├── prefill.js     # Field values from a tool's schema
│   │   └── diff.js        # The line diff behind Show changes
│   ├── index.html         # Web interface, including the Guide and the Logs tab
│   ├── oauth-callback.html # Where authorization servers send the browser back after sign-in
│   ├── styles.css         # UI styles (Glean design language)
│   ├── tokens.css         # Design tokens: light and dark theme colors, type, radii, shadows
│   ├── fonts/             # Inter and DM Sans (OFL)
│   └── icons/             # Feather icons, rendered as CSS masks (MIT)
├── tests/
│   ├── browser-smoke.mjs  # Drives the real UI in headless Chrome against test servers
│   └── reference_server.py # A server on the official MCP Python SDK, for interop checks
├── test_mcp_server.py     # Mock MCP server (modern, legacy or dual-era; JSON or SSE; tokens; OAuth; strict CORS)
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
- `npm run start:glean`: The same on `http://127.0.0.1:8888`, an origin Glean allows (see [Glean](#glean))
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

### Sign-in (OAuth)

A server that answers HTTP 401 needs you to sign in, and the server details then offer Sign in. The client follows the MCP authorization spec (2026-07-28):

1. **Find the authorization server.** It reads the protected resource metadata (RFC 9728) from the 401's `WWW-Authenticate` header when the browser lets it, and otherwise from `/.well-known/oauth-protected-resource` under the server's path, then its root. The metadata must name this server as its resource. Then it reads the authorization server's metadata (RFC 8414, falling back to OpenID Connect discovery); the issuer must match exactly, and it must support PKCE with S256.
2. **Register.** It registers itself with dynamic client registration (RFC 7591), as a `native` app when the page is served from `localhost` or `127.0.0.1` and a `web` app otherwise, with `oauth-callback.html` next to the page as the redirect. Registrations are kept per authorization server and reused.
3. **Sign in.** A pop-up opens on the authorization page with PKCE, `state` and the `resource` parameter (RFC 8707). It asks for the scope from the server's challenge or metadata, plus `offline_access` when offered, so it gets a refresh token. The authorization server sends the pop-up back to `oauth-callback.html`, which hands the response to the service worker. The worker checks `state` and the `iss` parameter (RFC 9207), exchanges the code, and the page reconnects.

   Where pop-ups don't work (embedded browsers such as Cursor's, or a strict blocker), the server details offer three other ways:

   - **Continue in this tab** goes to the sign-in page in the same tab. You come back to the client, connected.
   - **Copy link** copies the sign-in page's address, to open in another tab of the same browser. The tab you started in connects when you finish.
   - **Signing in from another browser?** is for browsers that can't complete the sign-in. Some identity providers refuse embedded browsers, for example. Open the copied link in another browser and sign in. That browser lands on a page that says it isn't where you started and shows its address; paste that address into the server details where you started. Only the browser that started a sign-in holds its `state` and PKCE verifier, so the code is redeemed there.
4. **Stay signed in.** Requests carry the access token. A token that expires within a minute is refreshed first, and a token the server turns down is refreshed once and the request retried. When the refresh token stops working, the server details ask you to sign in again.

Tokens live in this browser's IndexedDB (`mcp_auth`), are shared by every tab, and are only sent to the server they were issued for and its authorization server. Pages only learn whether you're signed in, never the tokens, and the HTTP trace redacts tokens, codes and verifiers. Sign out forgets the tokens; Shift-click it to also forget the client registration. A static bearer token, under "Use a static token instead of signing in", takes precedence over sign-in; it's stored in `localStorage`.

Not supported yet: client ID metadata documents (the spec's preferred alternative to dynamic registration), step-up authorization when a server asks for more scopes, and revoking tokens on sign-out.

### Inspecting a server

The Sandbox tab doubles as an inspector, in the spirit of the MCP Inspector but without installing anything:

- **Connection**: once connected, the server details show the protocol and era, the server's name and version, the capabilities it declared, how you're authenticated and the server's instructions.
- **Tools**: the count, a filter on name, title and description, each tool's title, and badges for its annotations (read-only, destructive, idempotent, open world), MCP Apps UI and an output schema. Annotations are hints from the server, not guarantees.
- **Tool details**: the call form, plus the input schema, output schema and raw definition.
- **Hidden tools**: tools the client won't call, with the reason.
- **Download** saves the server's details and full tool list as JSON.

Known constraints:

- **CORS**: the server must allow this site's origin and the headers above: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, any `Mcp-Param-*` its tools use, and `Authorization` for tokens. Legacy servers that use sessions must also list `Mcp-Session-Id` in `Access-Control-Expose-Headers`, or the browser can't read it. Sign-in also needs CORS on the metadata, registration and token endpoints.
- **Local servers**: from a public site such as GitHub Pages, Chrome 142+ asks the user before it lets the page reach `localhost` ("Apps on device").
- **Not yet supported**: `input_required` results (elicitation), `subscriptions/listen`, resources and prompts in the UI, and the deprecated 2024-11-05 HTTP+SSE transport.

## Sandbox

The Sandbox tab is a workbench for MCP servers: try their tools, keep the calls that work, and run them again to see what changed. Saved requests are also what apps will be built from next.

- **Pre-fill.** One click fills a tool's fields from what you last sent to it, or else your newest saved request for it, or else its schema. The menu beside it picks a source:
  - what you last sent
  - any saved request for the tool
  - the schema: each field's `const`, `default` or first `examples` value. Required fields without one get the first enum choice, the minimum (or 1) for numbers, and false for booleans. A field named like a variable gets that variable.
  - nothing (clears the fields)
- **Environments and variables.** Choose an environment in the tab's header and edit its variables under Variables.
  - Write `{{name}}` in any field, number fields included.
  - A field that is exactly one variable gets the variable's value converted to the field's type: a number, true or false, or JSON for objects and arrays. Text around variables stays text.
  - A call with an unknown variable doesn't go out, and says which variable.
  - Sends, under the fields, shows the arguments as they'll go out.
- **Saved requests.** Save keeps the tool, its arguments as written (variables and all) and a name, optionally in a collection.
  - The Saved view lists them by collection. Open one to fill its tool card, choose ▶ to run it, or rename and delete it from its menu.
  - A tool card opened from a saved request runs as that request, and Save updates it (or Save as new).
- **What changed.** Each result says whether it's the same as the last run of the same request or has changed, with Show changes for a line diff.
  - A saved request's runs compare with each other. Other calls compare with earlier calls of the same tool with the same arguments.
  - `_meta` is ignored, since servers put request IDs and timings there.
- **Run all** runs a collection's requests in the order they were saved, then sums up how many were the same, changed or failed. Each line opens that run.
- **History** lists every tool call, wherever it came from: this tab, Run all, the Console's chat, and tool calls found in chat replies.
  - Open one to see its arguments and result, then Run again or Save it.
  - Only the selected server narrows the list.
- **Export and Import**, on the Saved view, move saved requests, collections and environments as one JSON file. History isn't exported.

Everything stays in this browser, in IndexedDB (`mcp_sandbox`), shared by its tabs.

- History keeps the newest 500 calls with their results, which include whatever the servers sent back. Results over 256 KB keep only their start. Clear history, on the History view, deletes it.
- Tokens never go into the sandbox: arguments are stored as written, and credentials travel separately. Variables are plain text, so keep secrets out of them.

## Testing

### A five-minute check

With `npm start` and `npm run start:mock-mcp` running, open http://localhost:8080:

1. **Connect.** In the Guide, choose "Add and connect to 127.0.0.1:8081" (or paste `http://127.0.0.1:8081` on the Sandbox tab and choose Add server). The server details should show status `connected` and protocol `2026-07-28 (modern)`, and Available tools should list `echo`, `echo_region`, `count` and `ticket`. The mock also offers `broken_header`, which clients must hide.
2. **Call a tool.** Choose `echo`, type `hi` into `text` and choose Call tool. The result reads `Echo: hi`.
3. **Header parameters.** Call `echo_region` with region `Zürich`. The result reads `Echo from Zürich: …`; the mock checks that the `Mcp-Param-Region` header carried the same value, base64-encoded because it isn't ASCII.
4. **Logs.** On the Logs tab you should see lines like `Connected to Mock MCP Server 2.0.0 in 9 ms: MCP 2026-07-28 (modern)`, `Listed 4 tools in 5 ms`, `Hiding tool broken_header: …` and `echo returned in 3 ms`. Choose Everything to add each HTTP request (`→ tools/call echo (id 5)`) and reply (`← HTTP 200 for tools/call echo (id 5) in 3 ms`).
5. **Chat through a tool.** On the Console tab, choose the mock and `echo` under LLM target, tick Target for message on `text`, and send `hello`. The reply `Echo: hello` joins the conversation.
6. **Save and run again.** Choose `ticket`, then Pre-fill (the schema gives `prefix` its default, `T-`) and Save. On the Saved view, run it twice with ▶. The second result says Changed since the last run, and Show changes has the line that differs, because `ticket` returns the next number every time. A saved `echo` says Same as the last run.
7. **Variables.** Under Variables, add `greeting` = `hi`. Call `echo` with text `{{greeting}} world`; Sends shows `"hi world"`, and so does the result. The History view lists every call so far, including the chat's.
8. **The legacy fallback.** Stop the mock, start it with `npm run start:mock-mcp -- --mode legacy`, and choose Connect. The protocol becomes `2025-11-25 (legacy)`, and the Logs tab explains why: `server/discover got HTTP 400, …, so this looks like a 2025-era server; falling back to the initialize handshake`.

### More server behaviors

`test_mcp_server.py` needs only Python's standard library. Its flags simulate the situations a browser client has to handle:

| Flag | What the mock does |
| --- | --- |
| `--mode modern` | Speaks only 2026-07-28 |
| `--mode legacy` | Acts as a 2025-era server: `initialize` handshake and `Mcp-Session-Id` |
| `--sse` | Streams replies as SSE instead of JSON |
| `--token s3cret` | Requires `Authorization: Bearer s3cret`. Connect fails asking you to sign in or set a static token; open "Use a static token instead of signing in", paste it and choose Connect |
| `--oauth` | Requires an OAuth sign-in: serves protected resource and authorization server metadata, accepts client registrations, approves sign-ins at once (no login page), and issues refresh tokens that rotate |
| `--hide-www-authenticate` | Keeps the 401's `WWW-Authenticate` header from the page, as Glean does, so the client has to find the metadata at its well-known address |
| `--token-ttl 5` | How long access tokens last, in seconds (default 3600) |
| `--omit-expires-in` | Leaves `expires_in` out of token responses, so the client learns of expiry from a 401 |
| `--oauth-wrong-iss` | Names the wrong issuer in sign-in responses, which the client must reject |
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

### Glean

Glean's MCP server signs you in with your work account through dynamic client registration, which the client handles. Its URL looks like `https://your-company-be.glean.com/mcp/default`. You don't need to look it up: enter your work email in the Guide's Glean field, and the page asks `app.glean.com/config/search` which deployment your email belongs to, the way Glean's own sign-in page does. It then uses that deployment's default MCP server. Only the email's domain is logged. That endpoint isn't a documented API, so you can also paste the URL yourself, from Glean's Your settings, then Third party apps and MCP, on the "Connect to your AI apps with Glean MCP" card. Use the pasted URL if your company uses a server other than `default`.

Glean only sends CORS headers to page origins on its allowlist, so from an origin that isn't on it every request fails as "Couldn't reach". Glean's own deployment allows `http://127.0.0.1:8888` (and not `localhost:8888`), so:

```bash
npm run start:glean   # serves public/ on http://127.0.0.1:8888 (after ./setup.sh or npm install)
npx --yes http-server public -a 127.0.0.1 -p 8888 -c-1   # the same, without installing the project's dependencies
```

Avoid `python3 -m http.server` for the app: it resets connections when the page and the worker load their modules at the same time, which can stop the service worker from starting.

Open http://127.0.0.1:8888, enter your work email (or the URL) in the Guide's Glean field and choose Add and sign in. `app.glean.com` answers the same origins as Glean's MCP servers, so the email lookup works from here too. Sign in with your SSO in the pop-up; the server then connects and lists its tools. Try its search tool (`enterprise_search` on the default server) with query `onboarding`. Glean shows the client under Third party apps and MCP as "MCP Browser Client", where you can revoke it.

What to expect in the Logs tab: `server/discover` is blocked (Glean's CORS policy doesn't allow the 2026-07-28 headers), so the client connects with the 2025 handshake; the 401's challenge isn't readable, so the client finds `/.well-known/oauth-protected-resource/mcp/default`, registers, and signs in with `https://your-company-be.glean.com/oauth` for `mcp offline_access`.

### From the deployed site

The GitHub Pages copy can reach a mock on your machine too. Start it with the site's origin allowed, as the Guide's command does:

```bash
python3 test_mcp_server.py --allow-origin https://patrick-glean.github.io
```

When you connect to `http://127.0.0.1:8081`, Chrome asks whether the site may access apps on your device. Allow it.

### Automated tests

```bash
npm run test:rust                    # protocol logic: SSE parsing, headers, era detection, OAuth discovery and checks, redaction
npm run test:browser                 # the real UI in headless Chrome against every mock variant
npm run test:browser -- --reference  # plus the official Python SDK server
npm run test:public                  # plus the public servers above (needs internet)
```

The browser test starts its own servers on ports 18080-18092 and drives the UI the way a person would. It covers modern, legacy, SSE, dual-era, strict-CORS and token-protected servers; sign-in through the pop-up and without one (in this tab, from another tab, and from another browser by pasting the address back), both kinds of refresh, sign-out, and rejected sign-in responses (wrong issuer, unknown state); finding Glean from an email, with `app.glean.com` answered by the test; the inspector views and download; the sandbox (each Pre-fill source, variables in text and number fields, saved requests and collections, Run again and Run all with what changed, history including the chat's calls and after a reload, export and import, and no tokens in its store); a worker restart, a second tab, the logs pop-out, the Guide; and what the Logs tab records (timings, fallback reasons, no tokens anywhere, no HTML). It exits non-zero if a check fails, printing the client's own log and saving all of it as JSON.

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

The `Authorization` header never appears in logs, nor do access and refresh tokens, authorization codes, PKCE verifiers or client secrets in sign-in requests and replies. Session IDs are shortened. Each tab keeps its last 1,000 entries.

The worker also prints every entry to its own console: open `chrome://inspect/#service-workers` (or DevTools → Application → Service workers) and choose Inspect. Debug entries show there at DevTools' Verbose level.

## Troubleshooting

- **"Couldn't reach …"**: the server isn't running, or it doesn't allow this site through CORS. A server on `localhost` reached from a public site also needs Chrome's local network permission.
- **"… CORS policy must allow the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers"**: the server speaks 2026-07-28 but its CORS allowlist predates it. Add those headers (and any `Mcp-Param-*` its tools use) to `Access-Control-Allow-Headers`.
- **HTTP 404 or 405**: the URL isn't the MCP endpoint, which often ends in `/mcp`.
- **HTTP 401**: choose Sign in in the server details, or, for a server that uses a fixed token, set it under "Use a static token instead of signing in" and choose Connect.
- **Sign-in doesn't open**: the browser blocked the pop-up, or has none. Choose Continue in this tab or Copy link in the server details (see [Sign-in](#sign-in-oauth)), or allow pop-ups for the page.
- **"This browser or app may not be secure" (Google) in an embedded browser**: copy the link, sign in from a regular browser, and paste the address it lands on back under "Signing in from another browser?".
- **Sign-in fails before the pop-up shows a login page**: the Logs tab names the step. Usually the server's metadata or registration endpoint doesn't allow this origin through CORS, or the authorization server doesn't support dynamic client registration.
- **Glean: "Couldn't reach …" or "Couldn't ask app.glean.com …"**: this page's origin isn't on Glean's CORS allowlist. Use `npm run start:glean` and http://127.0.0.1:8888 (see [Glean](#glean)).
- **Glean: "Glean doesn't know a deployment for …"**: the email's domain isn't one Glean recognizes (it answered with its central deployment). Check the address, or paste the server URL.
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
