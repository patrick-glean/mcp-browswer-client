# The Glean bridge

A small MCP server that shows a team's Glean artifacts in other pages. It has the two tools the Team artifacts example calls, `list_team_artifacts` and `get_artifact`, and reads the artifacts from Glean's own MCP server with a Glean token it holds, so the people who see a page with the carousel in it don't sign in to anything. Without a token it serves the demo's made-up team, as the client's built-in Glean artifacts (demo) server does.

It's Node 22 or later, with no dependencies: `server.mjs` serves the tools, which are the client's own (`public/demo-servers/artifacts.js`), and `glean.mjs` is its client of Glean's MCP server and the parsers for Glean's replies.

## Run it

```bash
npm run start:bridge
# The Glean artifacts bridge is serving the demo's made-up team at http://127.0.0.1:8095/mcp
```

For your team's artifacts, give it Glean's MCP server and a token:

```bash
export GLEAN_MCP_URL=https://your-company-be.glean.com/mcp/default
read -rsp 'Glean API token: ' GLEAN_API_TOKEN && export GLEAN_API_TOKEN
npm run start:bridge
```

- **`GLEAN_MCP_URL`** is your MCP server's endpoint. Glean shows it under Your settings, then Third party apps and MCP: on "Connect to your AI apps with Glean MCP", pick the server (Default Tools is `mcp/default`) and copy its Endpoint.
- **`GLEAN_API_TOKEN`** is a user-scoped client API token with the `MCP` scope, which a Glean admin creates. It's what [Glean's MCP security guide](https://docs.glean.com/administration/platform/mcp/security) calls the fallback for hosts that can't sign in with OAuth, as a server that answers people who never sign in can't. Every tool runs as that user, so the bridge lists the artifacts that user's team made and can see. `read -s`, above, keeps it out of your shell's history; a secret manager does too. The bridge sends it only to `GLEAN_MCP_URL`, in the Authorization header, and never logs it or puts it in an error.

Then point the app at it. In the client, add `http://127.0.0.1:8095/mcp`, open Team artifacts and choose it under Call instead in Servers it calls (it has the same tools as the demo server), and copy the embed code again from Share. Since the bridge isn't a demo server, an embed of the app asks once, in each browser, to add it and to run what Start calls.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `GLEAN_MCP_URL`, `GLEAN_API_TOKEN` | not set: the demo's team | Glean's MCP server and the token it's called with. Set both or neither |
| `ARTIFACTS_OWNER` | `myteam` | Whose artifacts: search's owner filter, `myteam` for the token user's team, `me` for theirs only, or a person's name |
| `ARTIFACTS_FILTERS` | none | More of search's filters (`dynamic_search_result_filters`), such as `department:418 developer experience`, to narrow what it shows |
| `ARTIFACTS_TEAM` | the department of what it lists, when they share one | The team's name in the heading: "Built by Developer Experience" |
| `GLEAN_SEARCH_TOOL`, `GLEAN_READ_TOOL` | the first of `search`, `enterprise_search` and `glean_search`, and of `read_document` and its older names, that the server lists | The names of Glean's search and read tools, for a server whose names the bridge doesn't know |
| `ALLOWED_ORIGINS` | `https://patrick-glean.github.io,http://127.0.0.1:*,http://localhost:*` | The pages whose calls it answers, as the client's address (where the iframe's client is, not the page around it). `host:*` is any port; `*` is any page |
| `PORT`, `HOST` | `8095`, `127.0.0.1` | Where it listens. It serves MCP at `/mcp` |

A request from a page that isn't allowed gets 403. A browser asks first when a public page (`https://patrick-glean.github.io`) calls an address on your computer, and the bridge says yes (`Access-Control-Allow-Private-Network`), so the public client can use a bridge on `127.0.0.1`.

## What it does with Glean

For the list, it calls Glean's `search` with `query: "*"`, `app: "artifacts"`, `owner: "myteam"`, `sort_by_recency: true` and `num_results` the app's limit (12, at most 24), and reads each result's title, owner, dates, type, department, version, link and snippet. To show one, it calls `read_document` with its link and takes the content: a page's HTML, a document's Markdown, a message's text. It keeps a list for a minute and an artifact's content for five, so stepping through the carousel doesn't search again each time. It uses the Streamable HTTP transport with the 2025 handshake, the way Glean's server answers, and starts a new session when Glean forgets one.

Both tools answer only with what's in the team's list: `get_artifact` takes an ID or a place in that list, and an ID that isn't in it is an error. Their HTML leaves out scripts and anything from the network, and the client's screen would allow neither anyway, so a page that draws itself with scripts shows as a poster with Open in Glean. When Glean doesn't send an artifact's content, its slide is a stand-in that says so, and the reason stays in the bridge.

Glean's search answers in Markdown written for models (a section per result), and `read_document` in a listing of the document and then its content, so that's what `glean.mjs` reads, with `structuredContent` first when Glean sends it. Its tests (`tests/glean-artifacts.test.mjs`) run the bridge end to end against a fake Glean server that answers in those formats. If Glean changes how it writes them, the parsers are where to look.

## Why a bridge, and not Glean's MCP server itself

The carousel could call Glean's MCP server directly, as the client does from `http://127.0.0.1:8888` (see [Glean](../README.md#glean)), but not from an embed in somebody's page:

- **Who may call it.** Glean's server answers browsers only from the addresses on its CORS allowlist: Glean's own and `http://127.0.0.1:8888`. A page anywhere else can't reach it at all.
- **Who signs in.** Glean signs in each person with OAuth, and a sign-in can't finish inside an embed, which a browser gives storage of its own. Everyone who opened the page would also need Glean access of their own to see the team's artifacts.
- **What it answers.** Glean's search returns Markdown written for a model to read, which a screen's templates can't lay out, and it has no tool that lists a team's artifacts as such. The bridge turns that into data (`structuredContent`) and HTML to show.
- **What it shows.** The bridge decides what a page may show, the newest artifacts of one team and their previews, without scripts, and nothing else of what the token can see.

The cost is the token: whoever can open a page the bridge answers sees what that user can see of the team's artifacts, newest first, so pick the user and the filters with that in mind, keep `ALLOWED_ORIGINS` to your pages, and put the bridge behind your own sign-in and HTTPS if it's anywhere but your computer. Requests from outside a browser (curl) don't send an Origin, so `ALLOWED_ORIGINS` doesn't stop them; only where it listens and what's in front of it do.
