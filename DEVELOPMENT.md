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
| `sdk` (default) | TypeScript SDK client | `sdk-client/`: the interface in `index.js` over [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk); `mcp.js` connections, `oauth.js` sign-in, `trace.js` the HTTP trace | `npm run build:sdk` (esbuild) | `public/sdk_client.js`, `public/build-sdk.js` |
| `wasm` | Rust/WASM client | `src/`: exports in `lib.rs`, protocol in `mcp/`, sign-in in `oauth/`, requests in `http.rs` | `npm run build:wasm` (`wasm-build.sh`, wasm-bindgen `no-modules`) | `public/mcp_browser_client.js`, `public/mcp_browser_client_bg.wasm`, `public/build.js` |

The default is `DEFAULT_CLIENT` in `mcp-clients.js`, which the worker runs until a page picks one, and the first option in the Runtime menu, which is what a page picks when you haven't. Keep the two the same.

Service workers can't `import()` on demand, so each library is a script the worker fetches and evaluates. Its build file (`build.js`, `build-sdk.js`) holds the output's hash and is imported by `mcp-clients.js`, which makes every rebuild a worker update.

### The interface

Every library exports the same functions. MCP and sign-in calls take and return JSON strings. On failure the promise rejects with a JSON `McpError` (`src/error.rs`, `sdk-client/errors.js`): `{kind, message, status?, code?, data?}`, where `kind` is one of `network`, `timeout`, `auth_required`, `auth_failed`, `http`, `protocol`, `unsupported_version`, `invalid_response` or `internal`. `mcpError()` in `sw.js` parses it. A 401 rejects with `auth_required`, and `data.wwwAuthenticate` holds the challenge when the browser could read it.

| Export | Returns |
| --- | --- |
| `connect(url, options)` | `{url, era, protocolVersion, serverInfo, capabilities, instructions}` |
| `list_tools(url, options)` | `{tools, rejected, ttlMs, cacheScope, fromCache}` |
| `call_tool(url, name, argsJson, options)` | the JSON-RPC `result` (check `resultType`: `complete` or `input_required`) |
| `list_resources(url, options)` | `{resources}`, every page |
| `list_resource_templates(url, options)` | `{resourceTemplates}`, every page |
| `read_resource(url, uri, options)` | the JSON-RPC `result`, `{contents: [{uri, mimeType?, text \| blob}]}` |
| `list_prompts(url, options)` | `{prompts}`, every page |
| `get_prompt(url, name, argsJson, options)` | the JSON-RPC `result`, `{description?, messages}` |
| `forget_server(url)` | nothing; drops the remembered connection |
| `auth_begin(serverUrl, options)` | `{authorizationUrl, pending, client, newClient, authServer, scope}` |
| `auth_finish(pendingJson, callbackJson)` | the tokens record |
| `auth_refresh(tokensJson)` | the refreshed tokens record (rejects with `auth_required` when the user has to sign in again) |
| `set_logger(fn)` | nothing; `fn` then receives every log entry, as a JSON string or an object (see [Logging](#logging)) |
| `get_compiled_info()`, `get_version()` | what the Runtime menu and the log show about the build |
| `get_uptime()`, `increment_uptime()`, `get_metadata()` | the Runtime menu's health check |
| `reset()` (optional) | nothing; drops every connection when the worker unloads the library |

`options` is `{"bearerToken"?: string, "refresh"?: boolean}`. Every call connects on its own if needed, so it keeps working after the browser restarts the worker. Only the tool list is cached (for its `ttlMs`); resources, templates and prompts are fetched fresh each time, and `resources/read` and `prompts/get` send `Mcp-Name` (the URI or the prompt's name) on modern servers, as `tools/call` does. That's the whole interface: anything an app needs beyond MCP and sign-in, such as the Chat app's instructions, belongs to the worker.

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
- **The SDK checks 2026-07-28 results more strictly.** It rejects list results (tools, resources, templates, prompts) and `resources/read` results that lack `ttlMs` and `cacheScope`, which that version requires; the Rust library accepts them. So a modern server that leaves them out lists its resources on Rust/WASM but not on the SDK, which says `Invalid result for resources/list`.
- **One fragile spot**: the SDK only says why it hid a tool through `console.warn`, so `sdk-client/mcp.js` overrides its internal `_excludeInvalidXMcpHeaderTools` to catch the reason. Check it when upgrading the SDK.

## Page and worker messages

| Message | Reply |
| --- | --- |
| `{type: 'connect-mcp', url, bearerToken?}` (`initialize-mcp` still works) | `mcp_server_connected {url, info}` or `mcp_server_error {url, action, error}` |
| `{type: 'list_tools', url, refresh?, bearerToken?}` | `tools_list {url, tools, rejected, ttlMs, fromCache}` or `mcp_server_error` |
| `{type: 'call_tool', call, bearerToken?, run?, source?}`, where `call` is `{serverUrl, toolName, args}` and `source` is `workbench` (the default) or `app`, for [apps you build](#apps-you-build) | `tool_result {result, run}` or `tool_result {error, errorKind, run}`, plus `run_recorded {run}` to every page |
| `{type: 'list_resources', url, bearerToken?}` (sent with `list_tools` when the server declares resources) | `resources_list {url, resources, resourceTemplates}` to every page, or `mcp_server_error` with action `list_resources`. A server without `resources/templates/list` gets an empty template list |
| `{type: 'list_prompts', url, bearerToken?}` (likewise, for prompts) | `prompts_list {url, prompts}` to every page, or `mcp_server_error` with action `list_prompts` |
| `{type: 'read_resource', url, uri, requestId, bearerToken?}` | `resource_read {url, requestId, result, durationMs}` or `{…, error, durationMs}`, to the sender only. Not a run |
| `{type: 'get_prompt', url, name, args, requestId, bearerToken?}` | `prompt_got {url, requestId, result, durationMs}` or `{…, error, durationMs}`, to the sender only. Not a run |
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

Every tool call becomes a run, whichever part of the app made it: `handleToolCall` in `sw.js` records it at its one success point and its one failure point (`recordRun`), in the `runs` store of `public/workbench/store.js`. Workbench calls have `source` `workbench` (or `collection` from Run all; runs saved before the rename say `sandbox`), calls from the apps you build `app`, the chat's model calls `chat` and tool calls found in its replies `reply`.

- **What the page sends:** `call_tool`'s `call.args` are the arguments to send, with `{{variables}}` already filled in by the page (`public/workbench/template.js`, which knows the tool's schema; an app fills in its screen's values the same way). `run` is `{id, args, requestId?, collectionRunId?, environmentName?}`: the page's id for the run, so it can wait for this answer; the arguments as written; the saved request and Run all it came from; and the environment whose variables it used.
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

## Apps you build

The app builder is in `public/apps/`, ES modules that `index.html` loads after the Workbench (`installApps`, which needs the Workbench's environments). An app runs in the page: its flow in `runner.js`, its screen in a sandboxed frame. Its calls go to the worker like the Workbench's, so the worker knows nothing about apps beyond a run's `source`. The builder's components (`components/`: rail, header, the canvas and its Inspector, and the Outline's Screen, Flow and Try it, with the editors they share: `rule-editor.js`, `html-source.js`, `call-editor.js` and `trace.js`) share the Apps state (`apps.js`) besides AppShell and the Workbench state, the way the Workbench's do. Its events are `list`, `shown`, `app` (`{part: 'screen' | 'flow' | 'layout' | 'name' | 'version', by}`), `view` (Canvas or Outline, kept in `localStorage` `appsView`), `select` (what's picked on the canvas), `answer` (a rule's last answer, for picking values from it), `restart` and `highlight`.

**An app**, as `store.js` keeps it in IndexedDB `mcp_apps`, keyed by `id`:

```js
{ id, name, description, version, createdAt, updatedAt, downloadedAt, serverNames?,
  screen: { kind: 'components', components: [{ id, type, width?, …props }], size? }
       or { kind: 'html', html, from: { serverUrl, toolName, args } | null, ask, size? },
  flow: [{ id, when: [{ element, event }], call: { serverUrl, toolName, args },
           then: [{ if: 'ok' | 'error', show, into, how: 'replace' | 'append' | 'html' }],
           position?: { x, y }, prompt? }] }
```

- Components are `title` and `text` (`text`), `textbox` (`label`, `placeholder`, `lines`, `value`), `button` (`label`), `output` (`label`, `placeholder`, and as a box `show` and `about`) and `part` (`label`, `html`, `from`, `ask`). Any but a title has a `width` (`full`, `two-thirds`, `half` or `third`), which a `wide` screen (`size`) lays out in rows. An id matches `[A-Za-z_][A-Za-z0-9_-]*` and isn't `text`, `structured`, `json`, `html`, `result` or `error`, the names a tool's answer brings to a rule (`elementIdProblem`). Only components get ids in the HTML they make (`componentsHtml`), besides a part's own elements, named `part.id`.
- A rule's `when` is a list of triggers, any of which starts it; an empty list means nothing starts it yet. Events are `click`, `enter`, `change` and `open`, whose element is `''` (`EVENTS_BY_KIND` says which elements have which). Rules saved with one trigger as an object are read as a list of one (`normalizeRule`).
- A call has the shape saved requests have, `{serverUrl, toolName, args}`, with arguments as written (`{{question}}` and all).
- `position` is where the rule's tool sits on the canvas; without one, the canvas places it beside what it's wired to (`placeRules`).
- `prompt` names the call's argument that also asks for what the rule's boxes show (below).
- `version` is the last download's number. A download makes a new one when `updatedAt` is after `downloadedAt`. `serverNames` are the names an imported app's DML gave its servers, for "Add it".

**Running it** (`runner.js`):

1. `frameDocument` makes the frame's document from the screen's HTML: its scripts, `<base>` and `<meta http-equiv>` removed; a Content-Security-Policy first in `<head>` (`default-src 'none'`, scripts only with the runtime's nonce, inline styles, `data:` and `blob:` images and media); and the runtime, `frameRuntime` injected as source, last in `<body>`. The frame is `sandbox="allow-scripts"`, so its origin is opaque: no storage, cookies or service worker, and no forms, pop-ups or top navigation. The runtime listens for clicks, Enter and changes on the whole document, in the capture phase, and reports the ones on elements the flow waits for, so the HTML's own listeners don't matter. It keeps links from navigating, and HTML it shows loses its scripts, frames, handlers and forms (a form's fields stay); inside a part, that HTML's ids and styles are named and scoped as the part's.
2. The frame and the page talk in `postMessage`s that carry the token this load of the frame was given (the page also checks `event.source`). The frame sends `ready {values}`, `event {element, event, values}`, `layout {height, rects}` and `open {url}` (a link clicked, which the page opens in a new tab if it's http or https, without itself as the opener: the sandbox can't open one); the page sends `config {config}`, `show {element, value, how, failed}`, `busy {elements, busy}` and `highlight {elements}`. `config` (`frameConfig`) is what the flow waits for (`watch`), which elements' values it reads (`read`) and which elements' places `layout` reports (`track`, every element with an id): `rects` are their boxes in the document, which the canvas puts its ports beside. A second `load` of the frame means it went to another page, and the app stops until Restart.
3. `AppRunner.fire` runs the rules for an event top to bottom (`rulesFor`), each seeing the event's values plus what the rules before it showed. `callArguments` fills `{{name}}` from the screen's values, then the active environment's variables, converting a whole `{{name}}` to the field's type with the tool's schema; a name that's neither fails the rule before any call. The call is `AppShell.runTool({…, sentArgs, source: 'app', show: false})`: the worker records a run with source `app`, the arguments as written in `args` and as sent in `sentArgs`. A rule whose call is still out doesn't start again.
4. `answerOf` turns the `tool_result` into `{ok, values: {text, structured, json, html, result, error}}`; `isError` and `input_required` results fail, with their text as the error. `json` (`jsonIn`) is the text as JSON, or the first ```` ```json ```` (or bare ```` ``` ````) block in it that reads as JSON, with line breaks and other control characters inside strings escaped first, as models write them. Each route for the outcome renders its `show` (`renderTemplate`: paths walk objects by key and arrays by index, objects show as JSON, a name with no value shows as nothing) and sends it to its element; a route into a box sends the box's drawing instead (below).
5. The runner tells its owner what happens: `onTrace` each step in words, `onLayout` the frame's `layout`, `onActivity` a rule's call starting (`{ruleId, phase: 'call', trigger}`) and ending (`{ruleId, phase: 'ok' | 'error', routes, durationMs}`, which the canvas lights wires with), and `onAnswer` each answer. The canvas and Try it each run the app in a frame of their own; whichever view is hidden stops its runner (`AppRunner.stop`) and empties itself, so an app's "when it opens" calls run once.

Edits apply at once and are saved 300 ms after the last one (`Apps.change`). A screen edit reloads the frame after a pause; a flow edit only sends the frame a new `config`. Only edits may call `change`: AppShell's `fillToolForm` announces the values it fills with an `input` event, so the call editor ignores that event and any write that changes nothing.

**The canvas** (`components/canvas.js`, with the flow as a graph in `graph.js`) draws the flow; it keeps nothing of its own but where each tool sits (`rule.position`). Ports are strings: `start`, `el:<id>`, `run:<rule>`, `arg:<rule>:<field>`, `ok:<rule>` and `err:<rule>`. `wiresOf(flow, elementIds)` lists the wires, each one part of a rule, with an id that says which: `t:<rule>:<i>` its *i*th trigger (from an element, or from Start for `open`), `a:<rule>:<field>:<element>` a `{{element}}` in a field, and `r:<rule>:<i>` its *i*th route (from Answer or Error). `canConnect` says which ports join (an element and a Run, Start and a Run, a field and an element, an element and an Answer or Error); `connect(flow, a, b)` returns the flow with the part added and what was made, or throws a `FlowError` saying why not; `disconnect(flow, wire, {required})` takes the part away (a field the tool requires is left empty, an optional one removed). Transforms are presets of a route's `show` and `how` (`TRANSFORMS`). The Inspector (`components/inspector.js`) shows what `Apps.select` picked: `{kind: 'element' | 'rule' | 'wire' | 'start', id, ruleId?, edit?}`, or the screen when nothing is, using the same rule editor as the Outline focused on the wire's part. Wiring and moving tools use pointer events on the canvas; the Library's items drag with HTML drag and drop (`application/x-mcp-app`) or add on a click. In Run, the overlay over the frame lets pointer events through to the screen, and the ports stop taking them.

**Parts** are HTML a model or a tool makes, among a screen's components. `sanitizePart` (`screen.js`, with a DOM, so in the page) keeps the body and its styles without scripts, frames, embeds, stylesheets, `on…` attributes or `javascript:` URLs, and unwraps forms; `componentHtml` then puts the part on the screen with `prefixIds` (every id, and `for`, `list`, `aria-*` references and `#` links, gets the part's id in front) and its CSS inside `@scope ([data-part="<id>"])`, with `html`, `body` and `:root` rules applied to the part and `#id` selectors renamed for the part's own ids (so `#f4f4f5` stays a color). `partElements` lists a part's elements without a DOM. Ask a model (`ask.js`) calls the Chat app's model, from `localStorage` `chatModel`: `askPrompt` says what to make (or, with the HTML there is now, what to change, keeping its ids), and `modelCall` puts it in the model's message field (in place of `{{message}}` if the field holds one) with an empty conversation. `htmlFromResult` takes the HTML from the answer, which is a run from the app like any other call.

**Boxes** (`boxes.js`) are outputs that take a piece of an answer by shape: an output with a `show` other than `text` (`number`, `list`, `table`, `bar`, `line`, `html`) or with an `about`, what goes in it (`isBox`). A rule fills a box with a route whose `show` is `{{json.<key>}}`, the key being the box's id with any dots as underscores (`answerKey`); wiring an Answer to a box on the canvas makes that route, and sets the rule's `prompt` to the tool's prompt-like field (`promptFieldOf`: `message`, `prompt`, `question`, …, else its first required text field). When the rule runs, `asksOf` lists its keys with each box's kind, `about` (else its label) and width, and `formatRequest` turns them into the request the runner adds to the prompt argument as sent (`sentArgs`; the arguments as written stay as they are): one JSON object in a ```` ```json ```` block with exactly those keys, each with what goes in it and its JSON shape, HTML boxes with their width in pixels, and null for a key with nothing. The answer's `{{json.<key>}}` (`templateValue`, the value itself for a lone `{{…}}`) goes to `renderBox(kind, value)`, which returns HTML for the box (charts as bars of flex columns or an SVG polyline, lists with http(s) links only, numbers as a value and a note, tables from rows or objects, HTML as it is) or a `problem` saying why the value doesn't fit, drawn in the box and in What happened. Strings lose Markdown footnote marks (`[^1]`), dates as chart labels shorten to "Aug 31", and the screen sanitizes the HTML as it does any HTML a route shows. Glean's chat follows the request (tried with the dashboard starter's: the five keys in one block, in about 35 seconds) and adds the conversation's details after the block, which `jsonIn` reads past. `dashboardApp` (`apps.js`) is the Dashboard starter, Project pulse.

*Why the frame isn't same-origin.* A part comes from our own tool call, so a same-origin frame, whose elements the page could take listeners from directly, looks simpler. But this origin holds servers with static tokens in `localStorage` and sign-ins in the worker's IndexedDB, and a same-origin frame, and any script in HTML a model or a tool returned, could read them. So the frame keeps an opaque origin, and the flow takes over what the HTML does in two steps: the builder changes the HTML before it goes in (no scripts or handlers, ids named after the part, styles scoped), and the runtime it injects listens at the top of the document for the events the flow waits for, by id. The flow gets a dashboard's buttons and fields, and nothing that came with the HTML runs.

**DML** (`dml.js`) is an app written as XML: `toDml` writes it and `fromDml` reads it, with errors that name the line. Neither needs a DOM, so the worker or Node can use them; `parseXml` reads elements, attributes, text, CDATA, comments and the XML declaration, and refuses a DOCTYPE.

| Element | Attributes | Inside |
| --- | --- | --- |
| `<app>` | `dml` (the DML version, 1), `id`, `name`, `version` | `<description>`, `<screen>`, `<servers>`, `<flow>` |
| `<screen>` | `src`: the HTML's file in the zip; `built-from="components"`; `size="wide"` for rows | components, or `<ask>` (what a model was asked), the `<from>` call that made the HTML and, in a DML file on its own, `<html>` (as CDATA) |
| `<title>`, `<text>` | `id` | their text |
| `<textbox>` | `id`, `label`, `placeholder`, `lines`, `value` | |
| `<button>` | `id`, `label` | |
| `<output>` | `id`, `label`, `placeholder`; as a box, `show` (`number`, `list`, `table`, `bar`, `line` or `html`) | as a box, what goes in it |
| any component but `<title>` | `width`: `two-thirds`, `half` or `third` (full when there's none) | |
| `<part>` | `id`, `label`, `src`: its HTML's file in the zip (`parts/<id>.html`) | `<ask>`, `<from>` and, in a DML file on its own, `<html>`, as for an HTML screen |
| `<from>`, `<call>` | `server`, `tool` | `<arg name="…">`: text as written, or JSON with `type="json"`; in a `<call>`, `role="prompt"` on the one its boxes ask in |
| `<servers>` | | `<server url="…" name="…">` for each server it calls, for people reading it and for Import |
| `<flow>` | | its `<when>`s, in order |
| `<when>` | its first trigger's `element` (none for `open`) and `event`, or neither when nothing starts it; `x` and `y`, where its tool sits | an `<or element event>` for each other trigger, a `<call>`, then its `<then>`s |
| `<then>` | `if` (`ok`, the default, or `error`), `into`, `how` (`replace`, the default, `append` or `html`) | what to show, a template |

A file in a newer DML version is refused with a message saying so. Rule ids aren't written; Import gives each rule a new one.

**The zip** (`zip.js`): `zip()` writes files stored, with UTF-8 names and CRC-32s; `unzip()` reads stored and deflated entries (`DecompressionStream('deflate-raw')`) and checks every CRC. A download holds `app.dml`, `index.html` (`screenHtml`), `parts/<id>.html` for each part, and `README.md` (`readmeFor`, which says the flow in words with `describeRule`). Import takes the zip's `app.dml` (or any `.dml` in it) with the files beside it, or a `.dml` file alone.

**Testing:** `tests/apps.test.mjs` (in `npm run test:unit`) round-trips DML and zips and checks the flow's helpers, the graph (wires, connecting, disconnecting, placing tools), parts and the screen's HTML, and the request to a model. The smoke test builds an app through the UI: first in the Outline, then on the canvas at 1440×1000 with real mouse drags between ports (`Input.dispatchMouseEvent`), with the mock's `chat` as a stand-in model that writes a ticket dashboard, and fills a dashboard's boxes from their request with made-up JSON in their shapes. Chrome runs a sandboxed frame in a process of its own, so the frame is a DevTools target of its own: the smoke test's `frameRun` evaluates in it through its own connection.

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
npm run test:browser -- --reference # the real UI in headless Chrome, on the default TypeScript SDK library
npm run test:browser:wasm -- --reference # the same on the Rust/WASM library
npm run test:unit                   # Pre-fill's test data, checked with Ajv against a dozen kinds of schema and real servers' descriptions, RFC 6570 URIs, and the app builder's DML, zips and flow
npm run test:rust                   # the Rust library's protocol logic
npm run bench -- --quick            # tool-call throughput of every library, in a few minutes
```

Pre-fill's test data comes from `public/workbench/prefill.js`, a pure function of the tool's schema and the environment's variables. Keep it deterministic (no randomness, so runs of the same values compare) and valid: a new keyword it handles gets a schema in `tests/prefill.test.mjs`, where every generated value is validated against its schema.

- `testData(schema, { variables, every })` fills the required fields, which is what the request pane does when a tool opens (and the resource and prompt panes when one is picked); `every` fills the optional ones too. `fieldTestData(schema, path, { variables })` fills one field, by the path the form names it with (`limit`, `filter.owner`), the way `every` would. That's Fill beside a field's name: `addFillButtons` and `fillField` in `public/workbench/util.js`, which find fields by the `data-field` that AppShell's `renderInputField` puts on each card.
- Values from descriptions are where Pre-fill most often goes wrong, since servers describe their tools for models: examples of what a person might ask, mappings ("this week" -> pw) and fields not to fill. A description's value has to follow a cue (examples, or a list of the values a field takes), be quoted with quotes that pair up or be one bare token that ends its phrase, and fit the field. A phrase only goes into a field that takes free text. When a server's description fills something that makes no sense, add it to the "prose in a description" test, shortened, before changing the rules.

After a rebuild, reload the page. Each load checks the worker's scripts, and the build files change with every build, so a new worker installs. The log shows "Installing the service worker with the MCP client library builds …" and then "Loaded the TypeScript SDK client (…)" with the new build time.

If the old build is still running, the new worker may be waiting: Chrome sometimes keeps it waiting despite `skipWaiting()`. Close the app's other tabs, or open DevTools → Application → Service workers and choose skipWaiting (or Unregister, then reload). Clear site data as well if saved servers or chat history get in the way.

## Debugging

- **Logs**: the dock's Log has entries from the page, the worker and the library. Choose Everything, or open Trace, to see each HTTP request and reply. The worker's own console is at `chrome://inspect/#service-workers`; debug entries show at DevTools' Verbose level. `python3 test_mcp_server.py --verbose` prints what arrives at the mock, headers included.
- **Which library is running**: Runtime in the top bar shows the library, its build and uptime; Check asks the worker for its health, and the log has the "Loaded the …" line.
- **Messages**: page-to-worker messages appear as debug entries ("Page sent list_tools"). DevTools → Network, with the worker's DevTools open, shows the worker's requests to MCP servers.
- **The library didn't load**: the log says why ("Couldn't load the TypeScript SDK client: …"), usually a missing build output. Run `npm run build`, then reload the MCP client from Runtime.
- **A message gets no answer**: check that the type matches a `case` in `sw.js` (the worker logs "Ignored a message of unknown type …") and that the page handles the reply's type.
