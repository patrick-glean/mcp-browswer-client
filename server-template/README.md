# Describing your MCP server

MCP Browser Client shows people, and the models in its apps, what a server says about itself. Each name, title, description, annotation and schema a server sends ends up somewhere: in the Workbench, where people inspect the server and call its tools; in what the Chat app's model is told; or in the test data Pre-fill makes. A server that describes itself well is one people can use without reading its code, and one a model picks the right tool from.

This folder is for people building a server this client connects to, and for the coding agents helping them:

- **This guide**: each descriptive field MCP 2026-07-28 has, where this client shows it, and what to put in it.
- **[`example.json`](example.json)**: the replies of a well-described server, Example Helpdesk, keyed by method: `server/discover`, each list, and a result for each of its tools, resources and prompts. Copy its shapes; `npm run test:unit` checks that it's valid MCP and follows this guide.

To see how replies look in the client, serve them with the mock server and connect to it:

```bash
python3 test_mcp_server.py --replies server-template/example.json
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
| `serverInfo.name` | The server's name in the rail, at the start of the server bar and in Go to, unless the person named it themselves; the log (`Connected to example-helpdesk 1.4.0`) | A short, stable identifier, such as `example-helpdesk`. People see it, so keep it readable |
| `serverInfo.title` | The server bar, after the protocol (`Example Helpdesk 1.4.0`), and Info's Server row (`Example Helpdesk 1.4.0 (example-helpdesk)`) | The name people know the product by |
| `serverInfo.version` | After the title, and in the log | The server's release |
| `serverInfo.websiteUrl` | Info, as a link (`http` and `https` only) | Where people learn about the server and get help |
| `serverInfo.description` | Not shown yet; the Chat app's model gets it | One sentence on what the server is for |
| `serverInfo.icons` | Not shown yet | Each with a `src` (an `https` URL on your own domain, or a `data:` URI), `mimeType` and `sizes`; a version for light and dark backgrounds, marked with `theme` |
| `instructions` | Info, under "Instructions from the server", as plain text with its line breaks; the Chat app's model gets them | How the tools fit together: which to use for what and in what order, conventions (ID formats, time zones), limits, and what not to do without asking |
| `capabilities` | Info, a badge each, with the flags set to `true` | Declare `tools`, `resources` and `prompts` when you have them: the client only lists resources and prompts, and only opens their tabs, when they're declared |

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

Every 2026-07-28 request carries `_meta["io.modelcontextprotocol/clientInfo"]`, `{"name": "mcp-browser-client", "version": "0.1.0"}`, and empty client capabilities; the 2025 `initialize` handshake sends the same. The client can't answer sampling, elicitation or roots requests, and shows an `input_required` result as Needs input, so a tool has to work without them. It registers for sign-in as "MCP Browser Client".

From a web page, requests also need CORS: the server has to allow the page's origin and the 2026-07-28 headers. See [MCP Support](../README.md#mcp-support) for the list.

## A checklist

- [ ] `serverInfo` has a `name`, `title`, `version`, `description`, `websiteUrl` and `icons`.
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
