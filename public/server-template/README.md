# Describing your MCP server

MCP Browser Client shows people, and the models in its apps, what a server says about itself. Each name, title, description, annotation and schema a server sends ends up somewhere: in the Workbench, where people inspect the server and call its tools; in what the Chat app's model is told; or in the test data Pre-fill makes. A server that describes itself well is one people can use without reading its code, and one a model picks the right tool from.

This folder is for people building a server this client connects to, and for the coding agents helping them. It's also [a page on the site](https://patrick-glean.github.io/mcp-browswer-client/server-template/), rendered from this file:

- **This guide**: each descriptive field MCP 2026-07-28 has, where this client shows it, and what to put in it.
- **[`example.json`](example.json)**: the replies of a well-described server, Example Helpdesk, keyed by method: `server/discover`, each list, and a result for each of its tools, resources and prompts. Copy its shapes; `npm run test:unit` checks that it's valid MCP and follows this guide.
- **[The same server on the official SDKs](#the-same-server-on-the-official-sdks)**: Example Helpdesk in Go, TypeScript, Python, Rust, Java and C#, each checked against `example.json`.

To see how replies look in the client, serve them with the mock server and connect to it:

```bash
python3 test_mcp_server.py --replies public/server-template/example.json
```

Add `http://127.0.0.1:8081` with + beside Servers, or from the [deployed client](https://patrick-glean.github.io/mcp-browswer-client/) after adding `--allow-origin https://patrick-glean.github.io`. Write your own server's replies in the same shape to preview them before the server exists. The mock returns the file's result for a tool whatever the arguments, except that missing required arguments come back as a tool error, and in its default `--mode dual` it answers 2025 clients from the same file.

## Who reads what

| Reader | What it gets |
| --- | --- |
| People, in the Workbench | Names, titles, descriptions and annotations in the lists, the server bar and Info; a form for each tool, built from its input schema; results drawn by content type |
| The Chat app's model, when its tool has a conversation field | Every server you've added as JSON, minus static tokens: its `serverInfo`, `instructions` and `capabilities`, and every tool, resource, template and prompt as listed. Then the text of each tool result |
| Pre-fill | Each input schema's `const`, `default`, `examples`, `enum`, `format`, `pattern`, lengths and ranges, and values a description gives |

Descriptions reach both people and models, so write them for both: say what a thing does and when to use it, in plain sentences.

## The server

A 2026-07-28 server describes itself in its `server/discover` result: `serverInfo` in `_meta["io.modelcontextprotocol/serverInfo"]`, with `capabilities` and `instructions` beside it. A 2025 server puts the same fields in its `initialize` result, with `serverInfo` at the top level.

| Field | Where this client shows it | What to put in it |
| --- | --- | --- |
| `serverInfo.title` | The server's name in the rail, the server bar, Go to and the Chat app, unless the person gave it one of their own; Info's Title row | The name people know the product by: `Example Helpdesk` |
| `serverInfo.name` | Info's Name row, and after the title in the server bar (`example-helpdesk 1.4.0`); the server's name in the lists when it has no title; the log (`Connected to example-helpdesk 1.4.0`) | A short, stable identifier, such as `example-helpdesk` |
| `serverInfo.version` | The server bar, Info and the log | The server's release |
| `serverInfo.description` | Info's Description row, line breaks kept; the Chat app's model gets it | One or two sentences on what the server is for |
| `serverInfo.websiteUrl` | Info, as a link (`http` and `https` only) | Where people learn about the server and get help |
| `serverInfo.icons` | Info lists each icon with its type, sizes and theme, drawn when it's safe to (below), and the one for the page's theme sits beside the server's name at the top. An icon it won't draw is listed with the reason | A `data:` URI, or an `https` URL on the server's own origin, with its `mimeType` and `sizes`; one for light and one for dark backgrounds, marked with `theme` |
| `instructions` | Info, under "Instructions from the server", as plain text with its line breaks; the Chat app's model gets them | How the tools fit together: which to use for what and in what order, conventions (ID formats, time zones), limits, and what not to do without asking |
| `capabilities` | Info, a badge each, with the flags set to `true` | Declare `tools`, `resources` and `prompts` when you have them: the client only lists resources and prompts, and only opens their tabs, when they're declared |

Info also has all of it as JSON, as the server sent it. As the protocol's security considerations ask, Info draws an icon only when it's an `https` URL on the same origin as the server, or a `data:` URI of PNG, JPEG, WebP or SVG whose content really is that type, and loads it in an `<img>` without a referrer, which keeps SVG scripts from running.

## Tools

| Field | Where this client shows it | What to put in it |
| --- | --- | --- |
| `name` | Each row of the tool list, in monospace; the request pane's path, Go to, saved requests and runs. With 13 or more tools, the list is grouped by the nouns names share (`list_pull_requests` goes under `pull request`) | A verb and what it acts on: `search_tickets`, `get_ticket`. The Chat app runs a model's call on the first server it finds with that tool name, so prefer specific names to `search` or `get` |
| `title` | The request pane's heading; the row's tooltip, with the description. `annotations.title` is the fallback | Words a person would use: "Search tickets" |
| `description` | Under the heading (three lines, then More), in the row's tooltip and matched by the filter; the Chat app's model gets it | What it does, when to use it rather than another tool, what it returns, and its limits |
| `annotations.readOnlyHint` | `ro` on the row, a read-only badge, and the Read-only filter. A tool without it is `?` on the row and counts under Writes | `true` for tools that change nothing |
| `annotations.destructiveHint` | `del` on the row and a destructive badge, for a tool that isn't read-only | `true` when a call can delete or overwrite |
| `annotations.idempotentHint` | An idempotent badge | `true` when calling again with the same arguments changes nothing more |
| `annotations.openWorldHint` | `web` on the row, an open world badge, and the Reaches out filter | `true` when it reaches outside your service, such as the web; `false` when it doesn't |
| `inputSchema` | The request pane's form (see [Input schemas](#input-schemas)), and the Schema tab | Describe every property |
| `outputSchema` | A structured output badge, and the Schema tab | For tools that return data: see [Results](#results) |
| `_meta["io.modelcontextprotocol/ui"]` or `_meta.ui.resourceUri` | `app` on the row and badge (MCP Apps); the client doesn't draw the UI yet | |
| `icons`, `execution` | Not used yet | |

Set all four hints on every tool, as `example.json` does. The protocol's defaults assume the worst: a tool that leaves its hints out may write, may destroy and reaches the outside world, and this client marks it `?`. Hints are what the server claims: this client shows them, but they don't stop a call.

A tool with an invalid `x-mcp-header` annotation (on a parameter that isn't a string, integer or boolean, outside `properties`, or with a name that isn't a valid header) is hidden, and listed after the others with the reason.

### Input schemas

The request pane builds a form from `inputSchema.properties`: required properties first, marked `*`, then the others, each in the order the schema lists them, so list them in the order a person fills them in (the Rust/WASM library sorts them by name). With more than three fields, at least one of them required, the optional ones fold away under "N optional fields". Each field is labelled with its property's name and type, with its `description` beneath (a property's `title` isn't shown).

| Property | Field |
| --- | --- |
| `"type": "string"` | A text box |
| `enum` | A list to choose from |
| `"type": "boolean"` | `true` or `false`, to choose from |
| `"type": "integer"` or `"number"` | A number box |
| `"type": "object"` with `properties` | Its own fields, nested |
| `"type": "array"` of strings, numbers, booleans or an `enum` | A list, with Add item |
| Anything else, such as an array of objects | JSON text |

A list of types, such as `["integer", "null"]`, counts as its first type other than `null`. A property without `type` gets a text box and its value is sent as text, so give every property a `type` and its `enum` directly. That includes optional ones: the Python SDK, for one, writes a parameter typed `int | None` or `Literal[…] | None` as `anyOf` with `null`, which sends the number as text and loses the list to choose from. Leave an optional property out of `required` instead of making it nullable. Empty optional fields aren't sent.

**Pre-fill.** Opening a tool fills its required fields with test data, and Fill beside a field's name fills that one. A field's test data is the first of: its `const`; a variable named like it in the person's environment; its `default`, unless that's `null` or empty; its first `examples` entry; a value its description gives after a cue ("such as T-1042", `one of "open" or "pending"`); and otherwise a value made to fit its `format`, `pattern`, `minLength` and `maxLength`, `minimum` and `maximum`, `multipleOf` and `enum`. So:

- Give `examples` for IDs and free text (`"examples": ["T-1042"]`): they're what a person would type, and Pre-fill uses the first. A description's example only counts when a cue introduces it and it's a value, not prose.
- Use `enum` for closed sets, `format` for shaped strings (`date`, `date-time`, `email`, `uri`, `uuid`), and `minimum`, `maximum` and `default` for numbers.
- End the names of pagination cursors in `cursor`, `pageToken`, `nextToken` or `continuationToken`: Pre-fill leaves optional ones empty, since only an earlier response has one.

### Results

The response pane's Result tab draws each content block of a `tools/call` result in order:

| Content block | Shown as |
| --- | --- |
| `text` | Its text, line breaks kept. Text that is a JSON object or array is indented. Markdown isn't rendered |
| `image` | The image, from base64 `data` with an `image/*` `mimeType` |
| `audio` | A player, from base64 `data` with an `audio/*` `mimeType` |
| `resource_link` | Its `title` (or `name`, or `uri`) and `description`. An `http` or `https` URI is a link that opens in a new tab; other URIs are shown as text |
| `resource` (embedded) | Its `uri`, then its `text` as written. A `blob` is named by its `mimeType`, not shown |
| Anything else | The block's JSON |

- **`structuredContent`** shows under "Structured content", open when there are no content blocks. A tool that declares an `outputSchema` must return `structuredContent` that matches it: the TypeScript SDK library, the client's default, fails the call when it's missing or doesn't match (unless `isError` is `true`). Return the same JSON as a `text` block too, as the protocol recommends: older clients and the Chat app's model only read text.
- **`isError: true`** marks the result Tool error. Use it for failures a person or model can fix, such as a wrong argument or a ticket that doesn't exist, with a `text` block saying what to change. Keep JSON-RPC errors for requests the server can't handle at all.
- **`_meta`** isn't drawn in the Result tab (the JSON tab has the whole result), and runs are compared without it. Put request IDs, timings and other values that change on every call there, so a saved request run again shows Same rather than Changed.
- **The Chat app's model** gets the text of the `text` blocks, one per line, and nothing of the other blocks.
- **JSON-RPC requests in code blocks run.** The client scans the text of every result, wherever the call came from, and runs each JSON-RPC request in a code block (`{"jsonrpc": "2.0", "method": "<tool name>", "params": {…}}`) as a tool call: that's how the Chat app's model calls tools. Don't put example calls in results.

## Resources and templates

| Field | Where this client shows it | What to put in it |
| --- | --- | --- |
| `uri` | Under the label in the Resources tab, and in the pane | A stable, readable address: `helpdesk://guides/getting-started` |
| `name` | The pane's path, and the label when there's no title | A short identifier |
| `title` | The label in the Resources tab, and the pane's heading | Words a person would use |
| `description` | The row's tooltip, and the pane | What's in it, and when to read it |
| `mimeType` | A badge, and how a read is shown (below) | Always, on the resource and on each item a read returns |
| `size`, `annotations` (`audience`, `priority`, `lastModified`), `icons` | Not shown yet; the Chat app's model gets them | |
| `uriTemplate` | A field for each variable (RFC 6570, such as `{id}` or `{+path}`), with the URI they make shown below | Variables named for what they hold. A variable has no schema, so say what it looks like in the template's description: "id is the ticket's ID, such as T-1042" |

`resources/read` returns `contents`, each item with its `uri`, `mimeType` and either `text` or a base64 `blob`. Text is shown as written, indented when the `mimeType` mentions `json` or the text is a JSON object or array. A `blob` with an `image/*` or `audio/*` type is shown or played, and every `blob` gets its size and a Download link, named after the URI's last segment.

## Prompts

| Field | Where this client shows it | What to put in it |
| --- | --- | --- |
| `name` | Each row of the Prompts tab, in monospace, with how many arguments it takes | A verb and what it acts on: `summarize_ticket` |
| `title` | The pane's heading, and the row's tooltip | Words a person would use |
| `description` | The pane, and the row's tooltip | What the prompt is for |
| `arguments` | A text field each, required ones first and filled with test data, each with its `description` beneath | A description with an example after a cue, "The ticket to summarize, such as T-1042": arguments have no schema, so that's where Pre-fill finds a value |

`prompts/get` returns a `description`, shown above the messages, and `messages`, each shown with its `role` and its content drawn like a tool result's.

## What every 2026-07-28 result carries

- **`resultType`**: `"complete"` for an answer. The TypeScript SDK library rejects a 2026-07-28 result without it (`missing required resultType`); only results from 2025 servers may leave it out.
- **`ttlMs` and `cacheScope`**, on every list result and every `resources/read` result: how many milliseconds a client may reuse it, and `public` when it's the same for everyone or `private` when it mustn't be shared across sign-ins. The TypeScript SDK library rejects a list without them.
- The client reuses a tool list for its `ttlMs`, until Refresh in the server bar, and lists resources, templates and prompts afresh each time. It follows `nextCursor` through every page, up to 100.

## A model for the Chat app

The Chat app's model is an MCP tool, on any server. To offer one, give its input schema a `"type": "string"` property for the newest message and a `"type": "array"` property, of strings, for the conversation: the person ticks "Your message goes here" and "The conversation goes here" on them. The conversation starts with the client's instructions for calling tools, then the server list as JSON and any context the person added, then the messages so far. Answer with the reply as `text`. A JSON-RPC request in a code block of the reply, `{"jsonrpc": "2.0", "method": "<tool name>", "params": {…}}`, runs as a tool call (at most three every 10 seconds in a conversation), and its result joins the conversation.

## What the client tells your server

Every 2026-07-28 request carries `_meta["io.modelcontextprotocol/clientInfo"]` and empty client capabilities; the 2025 `initialize` handshake sends the same. By default `clientInfo` is bare, `{"name": "mcp-browser-client", "version": "0.1.0"}`. The person can choose, server by server, to also send a `title`, `description`, `websiteUrl` and `icons` from the client's Settings, so a server should work with the bare form and may show the others when they're there:

```json
{
  "name": "mcp-browser-client",
  "title": "MCP Browser Client",
  "version": "0.1.0",
  "description": "A browser-based MCP client for testing servers and client libraries: a Workbench to call their tools by hand, and an agent loop over them.",
  "websiteUrl": "https://patrick-glean.github.io/mcp-browswer-client/",
  "icons": [{ "src": "https://patrick-glean.github.io/mcp-browswer-client/favicon.svg", "mimeType": "image/svg+xml", "sizes": ["any"] }]
}
```

The client can't answer sampling, elicitation or roots requests, and shows an `input_required` result as Needs input, so a tool has to work without them. It registers for sign-in as "MCP Browser Client".

From a web page, requests also need CORS: the server has to allow the page's origin and the 2026-07-28 headers. See [MCP Support](../../README.md#mcp-support) for the list.

## The same server on the official SDKs

Each of these is Example Helpdesk on one of the official SDKs, with every field `example.json` has: the server's identity, icons and instructions; each tool's title, description, hints, input schema and output schema; its results; the resources, the template and the prompts; and cache hints where the SDK takes them. Each serves Streamable HTTP at `http://127.0.0.1:8090/mcp` (`PORT` picks another port) and lets this client's pages through CORS. All but Java speak 2026-07-28 and answer 2025 clients too; the Java SDK speaks up to 2025-11-25, so clients connect to it with the initialize handshake. Run one and add its address with + beside Servers.

| Language | SDK | Server | Run it, in its folder |
| --- | --- | --- | --- |
| Go | [go-sdk](https://github.com/modelcontextprotocol/go-sdk) 1.8.0 | [`main.go`](examples/go/main.go) | `go run .` |
| TypeScript | [@modelcontextprotocol/server](https://www.npmjs.com/package/@modelcontextprotocol/server) 2.3.1 | [`server.ts`](examples/typescript/server.ts) | `npm install && npm start` |
| Python | [mcp](https://pypi.org/project/mcp/) 2.3.0 | [`server.py`](examples/python/server.py) | `pip install -r requirements.txt && python server.py` |
| Rust | [rmcp](https://crates.io/crates/rmcp) 3.5.1 | [`main.rs`](examples/rust/src/main.rs) | `cargo run` |
| Java | [io.modelcontextprotocol.sdk:mcp](https://central.sonatype.com/artifact/io.modelcontextprotocol.sdk/mcp) 2.0.1 | [`HelpdeskServer.java`](examples/java/src/main/java/com/example/helpdesk/HelpdeskServer.java) | `mvn package && java -jar target/helpdesk.jar` |
| C# | [ModelContextProtocol.AspNetCore](https://www.nuget.org/packages/ModelContextProtocol.AspNetCore) 2.2.0 | [`Program.cs`](examples/csharp/Program.cs) | `dotnet run` |

`npm run test:examples` runs each one whose toolchain is installed and checks, through the official TypeScript SDK client, that it describes itself as `example.json` does (the fields above, as this client shows them) and that a page may call it. Change `example.json` and the examples that no longer match fail.

What each SDK needs to describe a server well:

- **Go.** `jsonschema` struct tags give each field its description, fields without `omitempty` are required, and properties keep their field order. Add enums, examples, formats, patterns, ranges and defaults to the schema `jsonschema.For` infers. Go infers a slice as `["null", "array"]`, so set it to `array`. `DestructiveHint` and `OpenWorldHint` are pointers: set them, or they're left out and read as `true`. Declare `Capabilities`, or the SDK adds `listChanged` and `logging`, and use `SetCacheable` for the lists' cache hints.
- **TypeScript.** Zod's `.describe()` writes descriptions and `.meta()` adds the keywords Zod has no method for (examples, `format`, `uniqueItems`). `z.strictObject` gives `additionalProperties: false`. `z.email()` adds a long `pattern` as well as `format: "email"`, so use `.meta({ format: 'email' })` to send the format alone. Cache hints go in the server's `cacheHints` and each resource's `cacheHint`.
- **Python.** `Annotated[..., Field(...)]` describes each argument. Write an optional argument as `X | SkipJsonSchema[None] = None`, with a `json_schema_extra` that drops the `default: null`, so it shows as its own type rather than `anyOf` with null. Return `Annotated[CallToolResult, Model]` to send your own content blocks and still declare and check an output schema. `MCPServer` can't set a resource's `size` or a prompt result's own description, so the example's subclass adds them. It can't send `additionalProperties: false` at all.
- **Rust.** Doc comments are descriptions, and `#[schemars(...)]` adds lengths, ranges, patterns, formats and examples. `#[schemars(inline)]` keeps enums out of `$defs`, `#[serde(deny_unknown_fields)]` gives `additionalProperties: false`, and serde_json's `preserve_order` feature keeps properties in declared order. One schemars `transform` makes an `Option` field optional rather than nullable and drops Rust's integer formats.
- **Java.** `Tool.builder().inputSchema(mapper, json)` takes the schema as written, so every keyword is exactly as you send it. The SDK speaks MCP up to 2025-11-25, so this client connects with the initialize handshake, and it serves through a servlet; the example runs it on embedded Jetty.
- **C#.** The handlers return the protocol's own objects, with each tool's schemas as JSON, and `TimeToLive` and `CacheScope` on the results. `lastModified` is a `DateTimeOffset`, written as `+00:00` rather than `Z`.

## A checklist

- [ ] `serverInfo` has a `name`, `title`, `version`, `description`, `websiteUrl` and `icons`, the icons as `data:` URIs or on the server's own `https` origin.
- [ ] `instructions` say how the tools fit together, and what not to do without asking.
- [ ] `capabilities` declare `tools`, `resources` and `prompts`, for each one the server has.
- [ ] Every tool has a `title`, a `description` and all four annotation hints.
- [ ] Every input property has a `type` and a `description`; IDs and free text have `examples`; closed sets are `enum`s; dates, emails and URLs have a `format`; numbers have a range, and a `default` when one makes sense.
- [ ] Tools that return data declare an `outputSchema`, and return matching `structuredContent` with the same JSON as text.
- [ ] Failures a caller can fix come back as `isError` results that say what to change.
- [ ] Values that change on every call, such as request IDs and timings, are in `_meta`.
- [ ] Every resource and template has a `title`, `description` and `mimeType`; template descriptions say what each variable holds.
- [ ] Every prompt argument has a description with an example.
- [ ] Every result has `resultType`, and lists and reads carry `ttlMs` and `cacheScope`.

SDKs take these fields when you define the server, its tools, resources and prompts: the Python SDK's `MCPServer(name, title=…, description=…, version=…, website_url=…, icons=…, instructions=…)` and `@server.tool(title=…, annotations=ToolAnnotations(…))`, for example. To check what yours sends, connect to it, open Info and each tool, and choose Download the server report from the ⋯ menu in the server bar: it has the server's details and full tool list as JSON, as the server sent them.
