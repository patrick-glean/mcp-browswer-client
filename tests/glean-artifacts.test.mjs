// The Team artifacts example and what it calls: the artifacts tools (public/demo-servers/artifacts.js)
// over the demo's made-up team, their previews, and the Glean bridge (glean-bridge/), over a fake
// Glean that answers as Glean's MCP server does. The fixtures are made up, in the shape of
// Glean's replies: search's Markdown, a section per result, and read_document's listing, then the
// content.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { artifactsApp, CAROUSEL_HTML, EXAMPLES, startCallsOnlyDemos } from '../public/apps/apps.js';
import { fromDml, toDml } from '../public/apps/dml.js';
import { flowProblems, frameConfig } from '../public/apps/flow.js';
import { RUN_HASH, unpackApp } from '../public/apps/link.js';
import { elementsOfComponents } from '../public/apps/screen.js';
import { SAMPLE_ARTIFACTS } from '../public/demo-servers/artifact-samples.js';
import { ago, artifactsServer, artifactTools, demoSource, htmlPreview, markdownHtml, slideHtml, stripHtml } from '../public/demo-servers/artifacts.js';
import { DEMO_SERVERS } from '../public/demo-servers/index.js';
import { artifactsFromSearch, contentFromRead, departmentOf, GleanError, gleanSource, mcpClient, summaryOf, titleOf } from '../glean-bridge/glean.mjs';
import { bridgeHandler, originAllowed, sourceFrom } from '../glean-bridge/server.mjs';
import { embedOf, exampleApp, PAGE } from '../scripts/example-page.mjs';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;
const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));

const NOW = Date.parse('2026-11-07T12:00:00Z');
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const tools = (source = demoSource({ now: () => NOW })) => Object.fromEntries(artifactTools(source, { now: () => NOW }).map(tool => [tool.name, tool]));
const htmlOf = result => result.content.find(item => item.type === 'resource')?.resource.text;

// --- The tools, over the made-up team ---

test("list_team_artifacts lists the team's newest, as data, as the same JSON in text, and as a strip of cards", async () => {
    const { list_team_artifacts: list } = tools();
    const result = await list.call({});
    const found = result.structuredContent;
    assert.equal(found.heading, 'Built by Developer Experience');
    assert.equal(found.summary, '9 artifacts, newest first · a made-up team, for the demo');
    assert.equal(found.total, 9);
    assert.equal(found.source, 'demo');
    assert.deepEqual(found.artifacts.map(artifact => artifact.kind), ['Dashboard', 'Document', 'Message', 'Guide', 'Document', 'Dashboard', 'Spreadsheet', 'Guide', 'Podcast']);
    assert.deepEqual(found.artifacts[0], {
        id: SAMPLE_ARTIFACTS[0].id,
        title: 'Build health, week 45',
        type: 'html',
        kind: 'Dashboard',
        author: 'Margaret Hamilton',
        version: 14,
        summary: SAMPLE_ARTIFACTS[0].summary,
        department: 'Developer Experience',
        createdAt: '2026-08-03T10:00:00.000Z',
        updatedAt: '2026-11-07T10:00:00.000Z',
        url: `https://glean.demo.invalid/library/${SAMPLE_ARTIFACTS[0].id}`,
    });
    assert.deepEqual(JSON.parse(result.content[0].text), found, 'the text is the same JSON, for clients that read only text');
    const validate = ajv.compile(list.outputSchema);
    assert.ok(validate(found), ajv.errorsText(validate.errors));
    const strip = htmlOf(result);
    assert.equal((strip.match(/<li data-at="/g) || []).length, 9);
    assert.match(strip, /<li data-at="1"><a href="https:\/\/glean\.demo\.invalid\/library\/4f8c2a19d7e64b0f9a3c5e7b1d2f6a80" title="Open “Build health, week 45” in Glean">/);
    assert.match(strip, /2 hours ago/);
    assert.equal((await list.call({ limit: 3 })).structuredContent.total, 3);
    assert.equal((await list.call({ limit: 99 })).structuredContent.total, 9, 'a limit past the most is the most');
});

test('get_artifact steps through the list from a place, wrapping at both ends, or finds one by its ID or address', async () => {
    const { get_artifact: get } = tools();
    const title = async args => {
        const result = await get.call(args);
        return result.isError ? result.content[0].text : `${result.structuredContent.position}/${result.structuredContent.total} ${result.structuredContent.artifact.title}`;
    };
    assert.equal(await title({}), '1/9 Build health, week 45');
    assert.equal(await title({ at: 2, step: 1 }), '3/9 Release notes: CLI 3.2');
    assert.equal(await title({ at: 1, step: -1 }), '9/9 DevEx weekly, episode 18', 'Previous from the first is the last');
    assert.equal(await title({ at: 9, step: 1 }), '1/9 Build health, week 45', 'Next from the last is the first');
    assert.equal(await title({ at: '4', step: 0 }), '4/9 On-call handbook', 'a place read off the screen as text');
    assert.equal(await title({ at: 'one' }), '1/9 Build health, week 45');
    assert.equal(await title({ at: 3, step: 1, limit: 3 }), '1/3 Build health, week 45');
    assert.equal(await title({ id: SAMPLE_ARTIFACTS[4].id }), '5/9 Incident review: remote cache outage');
    assert.equal(await title({ id: `https://app.glean.com/library/${SAMPLE_ARTIFACTS[4].id}` }), '5/9 Incident review: remote cache outage');
    assert.equal(await title({ id: 'nope' }), "nope isn't one of your team's 9 newest artifacts. list_team_artifacts lists them, with their IDs.");
    const empty = { name: 'demo', label: 'nobody', list: async () => ({ team: 'Nobody', artifacts: [] }), read: async () => null };
    assert.equal((await tools(empty).get_artifact.call({})).content[0].text, "Your team hasn't made any artifacts this server can show yet.");
});

test("get_artifact gives each one's content and a slide that matches its output schema, for every kind the team made", async () => {
    const { get_artifact: get } = tools();
    const validate = ajv.compile(get.outputSchema);
    for (let at = 1; at <= SAMPLE_ARTIFACTS.length; at++) {
        const result = await get.call({ at });
        const found = result.structuredContent;
        assert.ok(validate(found), `${at}: ${ajv.errorsText(validate.errors)}`);
        assert.deepEqual(JSON.parse(result.content[0].text), found);
        assert.deepEqual(found.content, SAMPLE_ARTIFACTS[at - 1].content ?? undefined);
        const slide = htmlOf(result);
        assert.match(slide, new RegExp(`<article class="ga-slide ga-${found.artifact.type}" aria-label="${at} of 9: `));
        assert.match(slide, /<a class="ga-open" href="https:\/\/glean\.demo\.invalid\/library\/[0-9a-f]{32}">Open in Glean/);
        assert.doesNotMatch(slide, /<script|\son[a-z]+=|javascript:/i, `${at} has nothing that runs`);
    }
    const podcast = htmlOf(await get.call({ at: 9 }));
    assert.match(podcast, /class="ga-poster"/);
    assert.match(podcast, /Play it in Glean\./);
});

test("a slide starts the strip with it and points it out there, and one Glean can't read is a stand-in", async () => {
    const artifact = (await demoSource({ now: () => NOW }).list({ count: 9 })).artifacts[5];
    const sixth = slideHtml(artifact, null, { at: 6, of: 9, now: NOW });
    assert.match(sixth, /\.ga-strip \[data-at="6"\] a \{ border-color/);
    assert.match(sixth, /\.ga-strip li \{ order: 1; \}\n\.ga-strip li:is\(\[data-at="6"\], \[data-at="7"\], \[data-at="8"\], \[data-at="9"\]\) \{ order: 0; \}/);
    assert.doesNotMatch(slideHtml(artifact, null, { at: 1, of: 9, now: NOW }), /li \{ order/, 'the first leaves the strip as it is');
    const failing = { ...demoSource({ now: () => NOW }), read: async () => { throw new GleanError('Glean is down'); } };
    const result = await tools(failing).get_artifact.call({ at: 2 });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.content, undefined);
    assert.match(htmlOf(result), /Glean didn&#39;t send what&#39;s in it just now, so this is a stand-in: open it in Glean to see it\./);
    assert.doesNotMatch(htmlOf(result), /Glean is down/, "the reason stays on the server's side");
});

test('the demo server describes itself fully and serves the tools over MCP, in both eras', async () => {
    const server = artifactsServer(demoSource({ now: () => NOW }), { now: () => NOW });
    const ask = async (method, params = {}, headers = {}) => (await (await server.answer({ method: 'POST', headers: new Headers(headers), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }) })).json()).result;
    const info = (await ask('server/discover'))._meta['io.modelcontextprotocol/serverInfo'];
    assert.deepEqual(Object.keys(info), ['name', 'version', 'title', 'description', 'icons']);
    assert.match(info.icons[0].src, /^data:image\/svg\+xml;base64,/);
    const { tools: listed } = await ask('tools/list');
    assert.deepEqual(listed.map(tool => tool.name), ['list_team_artifacts', 'get_artifact']);
    for (const tool of listed) {
        assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        for (const [name, property] of Object.entries(tool.inputSchema.properties)) assert.ok(property.type && property.description, `${tool.name}.${name}`);
        ajv.compile(tool.inputSchema);
    }
    assert.equal((await ask('tools/call', { name: 'get_artifact', arguments: { at: 3 } })).structuredContent.artifact.kind, 'Message');
    const old = await server.answer({ method: 'POST', headers: new Headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    assert.equal((await old.json()).result.serverInfo.title, 'Glean artifacts');
    assert.ok(DEMO_SERVERS.artifacts.tools.every(tool => !('call' in tool)), 'the registry lists definitions only');
});

// --- Previews ---

test("a page's preview keeps its look and leaves out what runs, loads or goes anywhere", () => {
    const page = htmlPreview(`<!DOCTYPE html><html><head><title>T</title><link rel="stylesheet" href="https://cdn.example/x.css">
<style>@import url(https://cdn.example/y.css); body { color: navy } :root { --x: 1 } h1 { font-size: 40px }</style><script>alert(1)</script></head>
<body onload="steal()"><h1 onclick="x()">Build health</h1><p>Every pipeline in the monorepo, every morning: pass rates, build times and the flakiest tests.</p><img src="https://cdn.example/a.png"><img src="data:image/png;base64,AA==" srcset="https://cdn.example/b.png 2x">
<a href="javascript:alert(1)">bad</a><iframe src="https://example.com"></iframe><form action="https://example.com"><input name="q"></form></body></html>`);
    assert.doesNotMatch(page.html, /<script|onload|onclick|<iframe|<link|https:\/\/cdn|javascript:|<form|srcset|<title/i, page.html);
    assert.match(page.html, /<h1>Build health<\/h1>/);
    assert.match(page.html, /<img src="data:image\/png;base64,AA==">/);
    assert.match(page.html, /<input name="q">/);
    assert.equal(page.css, '@scope (.ga-page) {\n:scope { color: navy } :scope { --x: 1 } h1 { font-size: 40px }\n}');
    assert.equal(page.live, false);
    assert.equal(htmlPreview('<div id="app"></div><script src="app.js"></script>').live, true, 'a page that draws itself with scripts');
    assert.equal(htmlPreview(`<p>${'x'.repeat(400_001)}</p>`).tooBig, true);
});

test('Markdown becomes headings, lists, tables, quotes and code, with its HTML as text and only web links', () => {
    const html = markdownHtml('# Plan <b>now</b>\n\nIntro with **bold**, *italics*, `code` and [a link](https://example.com) and [no](javascript:alert(1)).\n\n- one\n- two\n\n1. first\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n\n```\n<raw>\n```');
    assert.equal(html, [
        '<h1>Plan &lt;b&gt;now&lt;/b&gt;</h1>',
        '<p>Intro with <strong>bold</strong>, <em>italics</em>, <code>code</code> and <a href="https://example.com">a link</a> and [no](javascript:alert(1)).</p>',
        '<ul><li>one</li><li>two</li></ul>',
        '<ol><li>first</li></ol>',
        '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
        '<blockquote><p>quoted</p></blockquote>',
        '<pre><code>&lt;raw&gt;</code></pre>',
    ].join('\n'));
});

test('when an artifact changed, as people say it', () => {
    const at = hours => new Date(NOW - hours * 3_600_000).toISOString();
    assert.deepEqual([0.01, 0.5, 2, 30, 50, 200, 400, 1000].map(hours => ago(at(hours), NOW)),
        ['just now', '30 minutes ago', '2 hours ago', 'yesterday', '2 days ago', 'last week', '2 weeks ago', 'on Sep 26']);
    assert.equal(ago('2025-03-01T00:00:00Z', NOW), 'on Mar 1, 2025');
    assert.equal(ago('', NOW), '');
    assert.equal(stripHtml([], { now: NOW }).includes('<ol class="ga-strip"'), true);
});

// --- Glean's replies, as the bridge reads them ---

const SEARCH = `# Search Results (3 found, more available)

_More results available. Call again with cursor="eyJ0ZXN0Ijp0cnVlfQ==" to fetch the next page._

## Search Notices

- This response contains artifacts which are documents generated by users within Glean via the artifact/canvas workflow.

---

## 1. Q1 platform roadmap.md
**Source:** artifacts • **Updated:** 2026-11-06T16:00:00Z • **Created:** 2026-10-26T09:00:00Z • **Owner:** Grace Hopper
**Matching filters:**
- app:artifacts
- department:418 developer experience
- documentcategory:AI_ARTIFACT
- language:ENGLISH
- type:paper
- version:6
**Link:** https://app.glean.com/library/7e2b9d41c0a54f6e8b3d1c9a5f7e2b64

> # Q1 platform roadmap
> | Field | Value | | ----- | ----- | | Status | Draft for review |
> Goals
> Where Developer Experience is putting its time from January to March, and what we're leaving for later. The [planning doc](https://example.com/plan) has the detail.

---

## 2. build_health/build_health.html
**Source:** artifacts • **Updated:** 2026-11-07T10:00:00Z • **Created:** 2026-08-03T10:00:00Z • **Owner:** Margaret Hamilton
**Matching filters:**
- app:artifacts
- collection:DevEx dashboards
- department:418 developer experience
- has:collection
- type:html
- version:14
**Link:** https://app.glean.com/library/4f8c2a19d7e64b0f9a3c5e7b1d2f6a80

> Build Health
> Engineering · Developer Experience
> # Build Health
> Pass rate, build times and flaky tests across every pipeline in the monorepo, refreshed each morning.

_~100% of document shown above._

---

## 3. devex-weekly-18
**Source:** artifacts • **Updated:** 2026-10-24T12:00:00Z • **Created:** 2026-10-24T12:00:00Z • **Owner:** Barbara Liskov
**Matching filters:**
- app:artifacts
- department:418 developer experience
- type:podcast
- version:1
**Link:** https://app.glean.com/library/d4a8c2e6f0b14d9a7c5e3f1b8d6a2c75

> Eighteen minutes on preview environments: what we built, what broke on the way, and what comes next.


---
documents[3]{isAiGenerated}:
  true
  true
  trueglean_invocation_id: 00000000-0000-4000-8000-000000000001`;

const ROADMAP = '# Q1 platform roadmap\n\nWhere Developer Experience is putting its time from January to March.\n\n## Goals\n\n- A preview environment for every pull request';
const readReply = (id, docType, content) => ({
    content: [
        { type: 'text', text: `documents[1]:\n  - artifactId: ${id}\n    docType: ${docType}\n    glean_doc_id: ARTIFACT_${id}\n    snippets[1]: "${content.slice(0, 40).replace(/\n/g, '\\n')}"\n    title: x\n    url: "https://app.glean.com/library/${id}"` },
        { type: 'text', text: content },
        { type: 'text', text: 'glean_invocation_id: 00000000-0000-4000-8000-000000000002' },
    ],
});

test("the bridge reads Glean's search: each section's title, owner, dates, type, department, version and link, and a summary from its snippet", () => {
    const found = artifactsFromSearch({ content: [{ type: 'text', text: SEARCH }] });
    assert.deepEqual(found, [
        {
            id: '7e2b9d41c0a54f6e8b3d1c9a5f7e2b64', title: 'Q1 platform roadmap', type: 'paper', author: 'Grace Hopper', department: 'Developer Experience',
            createdAt: '2026-10-26T09:00:00.000Z', updatedAt: '2026-11-06T16:00:00.000Z', version: 6, url: 'https://app.glean.com/library/7e2b9d41c0a54f6e8b3d1c9a5f7e2b64',
            summary: "Where Developer Experience is putting its time from January to March, and what we're leaving for later. The planning doc has the detail.",
        },
        {
            id: '4f8c2a19d7e64b0f9a3c5e7b1d2f6a80', title: 'Build Health', type: 'html', author: 'Margaret Hamilton', department: 'Developer Experience',
            createdAt: '2026-08-03T10:00:00.000Z', updatedAt: '2026-11-07T10:00:00.000Z', version: 14, url: 'https://app.glean.com/library/4f8c2a19d7e64b0f9a3c5e7b1d2f6a80',
            summary: 'Pass rate, build times and flaky tests across every pipeline in the monorepo, refreshed each morning.',
        },
        {
            id: 'd4a8c2e6f0b14d9a7c5e3f1b8d6a2c75', title: 'Devex weekly 18', type: 'podcast', author: 'Barbara Liskov', department: 'Developer Experience',
            createdAt: '2026-10-24T12:00:00.000Z', updatedAt: '2026-10-24T12:00:00.000Z', version: 1, url: 'https://app.glean.com/library/d4a8c2e6f0b14d9a7c5e3f1b8d6a2c75',
            summary: 'Eighteen minutes on preview environments: what we built, what broke on the way, and what comes next.',
        },
    ]);
    assert.deepEqual(artifactsFromSearch({ content: [{ type: 'text', text: '# Search Results (0 found)' }] }), []);
    const structured = artifactsFromSearch({ structuredContent: { documents: [{ url: 'https://app.glean.com/library/abc', title: 'Plan.md', docType: 'PAPER', owner: { name: 'Ada' }, updateTime: '2026-11-01T00:00:00Z', snippets: [{ text: 'A plan for the quarter, with goals and owners for each.' }] }] } });
    assert.deepEqual(structured.map(artifact => [artifact.id, artifact.title, artifact.type, artifact.author, artifact.summary]), [['abc', 'Plan', 'paper', 'Ada', 'A plan for the quarter, with goals and owners for each.']]);
});

test("the bridge reads read_document's content after its listing, else richDocumentData or a resource, without Glean's invocation ID", () => {
    assert.deepEqual(contentFromRead(readReply('7e2b', 'PAPER', ROADMAP), 'paper'), { format: 'markdown', text: ROADMAP });
    const page = '<!DOCTYPE html><html><body><h1>Build Health</h1></body></html>';
    assert.deepEqual(contentFromRead(readReply('4f8c', 'HTML', page), 'html'), { format: 'html', text: page });
    const joined = { content: [{ type: 'text', text: `documents[1]:\n  - artifactId: 7e2b\n    snippets[2]:\n      - "one"\n      - "two"\n    title: x\n${ROADMAP}glean_invocation_id: 0000` }] };
    assert.deepEqual(contentFromRead(joined, 'paper'), { format: 'markdown', text: ROADMAP }, 'one block, the ID stuck to its end');
    assert.deepEqual(contentFromRead({ structuredContent: { documents: [{ richDocumentData: { content: 'Shipped it.' } }] } }, 'message'), { format: 'text', text: 'Shipped it.' });
    assert.deepEqual(contentFromRead({ content: [{ type: 'resource', resource: { uri: 'x', mimeType: 'text/html', text: '<p>hi</p>' } }] }, 'other'), { format: 'html', text: '<p>hi</p>' });
    assert.deepEqual(contentFromRead({ content: [{ type: 'text', text: 'documents[1]:\n  - artifactId: 1\n    snippets[1]: "Only a snippet\\nof it"' }] }, 'paper'), { format: 'markdown', text: 'Only a snippet\nof it' });
    assert.equal(contentFromRead({ content: [] }, 'podcast'), null);
});

test('titles, departments and summaries as people read them', () => {
    assert.deepEqual(['release_notes/release_notes.html', 'Q4 plan.md', 'notes', '', 'a-b_c.txt'].map(titleOf), ['Release notes', 'Q4 plan', 'Notes', 'Untitled', 'A b c']);
    assert.equal(departmentOf('418 developer experience'), 'Developer Experience');
    assert.equal(summaryOf('# Title\n| a | b |\nShort line\nThis line has enough words in it to be the summary of it.', 'Title'), 'This line has enough words in it to be the summary of it.');
    const long = `${'Word '.repeat(30)}ends here. ${'More '.repeat(40)}`;
    assert.equal(summaryOf(long), `${'Word '.repeat(30)}ends here.`);
    assert.ok(summaryOf('word '.repeat(100)).endsWith('…'));
});

// --- The bridge's Glean client and source ---

// A fake of Glean's MCP server, over fetch: the 2025 handshake, a session, SSE replies, and the
// search and read_document tools. `calls` records what it was asked.
function fakeGlean({ token = 'test-token', sse = true } = {}) {
    const calls = [];
    let sessions = 0;
    const reply = (message, headers = {}) => new Response(sse ? `event: message\ndata: ${JSON.stringify(message)}\n\n` : JSON.stringify(message), {
        headers: { 'Content-Type': sse ? 'text/event-stream' : 'application/json', ...headers },
    });
    const fetch = async (url, init) => {
        const headers = new Headers(init.headers);
        if (headers.get('authorization') !== `Bearer ${token}`) return new Response('no', { status: 401 });
        const message = JSON.parse(init.body);
        calls.push({ method: message.method, session: headers.get('mcp-session-id'), version: headers.get('mcp-protocol-version'), name: message.params?.name, args: message.params?.arguments });
        if (message.method === 'initialize') return reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'glean', version: '1' } } }, { 'Mcp-Session-Id': `s${++sessions}` });
        if (!('id' in message)) return new Response(null, { status: 202 });
        if (headers.get('mcp-session-id') !== `s${sessions}`) return new Response('gone', { status: 404 });
        if (message.method === 'tools/list') return reply({ jsonrpc: '2.0', id: message.id, result: { tools: ['chat', 'search', 'read_document'].map(tool => ({ name: tool, inputSchema: { type: 'object' } })) } });
        const { name, arguments: args } = message.params;
        if (name === 'search') return reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: SEARCH }] } });
        if (name === 'read_document') {
            const id = args.urls[0].split('/').pop();
            if (id.startsWith('d4a8')) return reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Nothing to read.' }], isError: true } });
            return reply({ jsonrpc: '2.0', id: message.id, result: readReply(id, id.startsWith('7e2b') ? 'PAPER' : 'HTML', id.startsWith('7e2b') ? ROADMAP : '<h1>Build Health</h1><p>All green this week, every pipeline.</p>') });
        }
        return reply({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `no tool ${name}` } });
    };
    return { fetch, calls, forget: () => { sessions++; } };
}

test("the bridge's client starts one session, sends the token only as a header, reads SSE, and starts again when Glean forgets it", async () => {
    const glean = fakeGlean();
    const client = mcpClient('https://acme-be.glean.com/mcp/default', { token: 'test-token', fetch: glean.fetch });
    await client.callTool('search', { query: '*' });
    await client.callTool('search', { query: '*' });
    assert.deepEqual(glean.calls.map(call => `${call.method} ${call.session} ${call.version}`), [
        'initialize null null', 'notifications/initialized s1 2025-06-18', 'tools/call s1 2025-06-18', 'tools/call s1 2025-06-18',
    ]);
    glean.forget();
    await client.callTool('search', { query: '*' });
    assert.deepEqual(glean.calls.slice(4).map(call => `${call.method} ${call.session}`), ['tools/call s1', 'initialize null', 'notifications/initialized s3', 'tools/call s3']);
    await assert.rejects(client.callTool('nothing', {}), /Glean's nothing failed: no tool nothing/);
    const refused = mcpClient('https://acme-be.glean.com/mcp/default', { token: 'wrong-secret', fetch: glean.fetch });
    await assert.rejects(refused.callTool('search', {}), error => error instanceof GleanError && /turned the bridge's token away \(HTTP 401\)/.test(error.message) && !error.message.includes('wrong-secret'));
});

test("the bridge's source searches the team's artifacts newest first, reads each from its link, and keeps both a while", async () => {
    const glean = fakeGlean({ sse: false });
    let clock = 0;
    const source = gleanSource({ client: mcpClient('https://acme-be.glean.com/mcp/default', { token: 'test-token', fetch: glean.fetch }), now: () => clock });
    const listed = await source.list({ count: 12 });
    assert.equal(listed.team, 'Developer Experience');
    assert.deepEqual(listed.artifacts.map(artifact => artifact.title), ['Q1 platform roadmap', 'Build Health', 'Devex weekly 18']);
    const search = glean.calls.find(call => call.name === 'search');
    assert.deepEqual(search.args, { query: '*', app: 'artifacts', owner: 'myteam', num_results: 12, sort_by_recency: true, _user_goal: "Show my team's newest Glean artifacts in a carousel" });
    await source.list({ count: 12 });
    assert.equal(glean.calls.filter(call => call.name === 'search').length, 1, 'a list is kept for a minute');
    clock = 61_000;
    await source.list({ count: 12 });
    assert.equal(glean.calls.filter(call => call.name === 'search').length, 2);
    assert.deepEqual(await source.read(listed.artifacts[0]), { format: 'markdown', text: ROADMAP });
    await source.read(listed.artifacts[0]);
    assert.deepEqual(glean.calls.filter(call => call.name === 'read_document').map(call => call.args), [
        { urls: ['https://app.glean.com/library/7e2b9d41c0a54f6e8b3d1c9a5f7e2b64'], _user_goal: "Show one of my team's Glean artifacts in a carousel", user_requested_latest_version: false },
    ]);
    await assert.rejects(source.read(listed.artifacts[2]), /Glean's read_document failed: Nothing to read\./);
    assert.equal(glean.calls.filter(call => call.method === 'tools/list').length, 1, 'it asks which tools Glean has once');
    const older = { listTools: async () => [{ name: 'enterprise_search' }], callTool: async (name, args) => (glean.calls.push({ name, args }), { content: [{ type: 'text', text: SEARCH }] }) };
    const filtered = gleanSource({ client: older, owner: 'me', filters: 'department:418 developer experience', team: 'DevEx' });
    assert.equal((await filtered.list({ count: 2 })).team, 'DevEx');
    assert.deepEqual(glean.calls.at(-1), { name: 'enterprise_search', args: { query: '*', app: 'artifacts', owner: 'me', num_results: 2, sort_by_recency: true, _user_goal: "Show my team's newest Glean artifacts in a carousel", dynamic_search_result_filters: 'department:418 developer experience' } });
    await assert.rejects(filtered.read(listed.artifacts[0]), /has no read tool the bridge knows \(read_document, read_documents, glean_read_document\): set GLEAN_READ_TOOL to its name\./);
    const named = gleanSource({ client: { ...older, listTools: async () => [] }, searchTool: 'my_search' });
    await named.list({ count: 1 });
    assert.equal(glean.calls.at(-1).name, 'my_search');
});

// --- The bridge over HTTP ---

async function serving(handler) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

const rpc = (url, method, params = {}, headers = {}) => fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }),
});

test('which pages may call the bridge', () => {
    const allowed = ['https://patrick-glean.github.io', 'http://127.0.0.1:*'];
    assert.deepEqual(['https://patrick-glean.github.io', 'http://127.0.0.1:8080', 'http://127.0.0.1', 'http://127.0.0.1.evil.example', 'http://127.0.0.1:80x', 'https://evil.example'].map(origin => originAllowed(origin, allowed)),
        [true, true, true, false, false, false]);
    assert.equal(originAllowed('https://anything.example', ['*']), true);
    assert.equal(sourceFrom({}).name, 'demo');
    assert.throws(() => sourceFrom({ GLEAN_MCP_URL: 'https://acme-be.glean.com/mcp/default' }), /Set both GLEAN_MCP_URL and GLEAN_API_TOKEN/);
});

test('the bridge answers CORS for the pages it lists, refuses the rest, and serves the tools at /mcp', async () => {
    const lines = [];
    const bridge = await serving(bridgeHandler({ source: demoSource(), allowed: ['http://127.0.0.1:*'], log: line => lines.push(line) }));
    try {
        const preflight = await fetch(`${bridge.url}/mcp`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,mcp-protocol-version,mcp-method', 'Access-Control-Request-Private-Network': 'true' } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8080');
        assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type,mcp-protocol-version,mcp-method');
        assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
        assert.equal((await fetch(`${bridge.url}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
        assert.equal((await rpc(bridge.url, 'tools/list', {}, { Origin: 'https://evil.example' })).status, 403);
        assert.equal((await fetch(`${bridge.url}/other`)).status, 404);
        const listed = await rpc(bridge.url, 'tools/call', { name: 'list_team_artifacts', arguments: { limit: 2 } }, { Origin: 'http://127.0.0.1:8080' });
        assert.equal(listed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8080');
        assert.equal(listed.headers.get('access-control-expose-headers'), 'Mcp-Session-Id');
        assert.equal((await listed.json()).result.structuredContent.total, 2);
        const discover = await (await rpc(bridge.url, 'server/discover')).json();
        assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].title, 'Glean artifacts (demo data)');
        assert.match(lines[0], /^list_team_artifacts answered in \d+ ms$/);
    } finally {
        await bridge.close();
    }
});

test("the bridge serves a team's artifacts from Glean's MCP server, end to end over HTTP", async () => {
    const glean = fakeGlean();
    const fakeServer = await serving(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const response = await glean.fetch(req.url, { headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    });
    const bridge = await serving(bridgeHandler({ source: sourceFrom({ GLEAN_MCP_URL: `${fakeServer.url}/mcp/default`, GLEAN_API_TOKEN: 'test-token' }), allowed: ['*'] }));
    try {
        const call = async (name, args) => (await (await rpc(bridge.url, 'tools/call', { name, arguments: args })).json()).result;
        const listed = await call('list_team_artifacts', {});
        assert.equal(listed.structuredContent.heading, 'Built by Developer Experience');
        assert.equal(listed.structuredContent.summary, '3 artifacts, newest first · from Glean');
        assert.equal(listed.structuredContent.source, 'glean');
        assert.deepEqual(listed.structuredContent.artifacts.map(artifact => `${artifact.kind}: ${artifact.title}`), ['Document: Q1 platform roadmap', 'Page: Build Health', 'Podcast: Devex weekly 18']);
        const first = await call('get_artifact', { at: 1 });
        assert.deepEqual(first.structuredContent.content, { format: 'markdown', text: ROADMAP });
        assert.match(htmlOf(first), /<h1>Q1 platform roadmap<\/h1>/);
        const page = await call('get_artifact', { at: 1, step: 1 });
        assert.match(htmlOf(page), /<h1>Build Health<\/h1><p>All green this week, every pipeline\.<\/p>/);
        const podcast = await call('get_artifact', { at: 1, step: -1 });
        assert.equal(podcast.structuredContent.position, 3);
        assert.match(htmlOf(podcast), /Glean didn&#39;t send what&#39;s in it just now/);
        assert.equal(glean.calls.filter(call => call.name === 'search').length, 1, 'one search, kept for the calls after it');
    } finally {
        await bridge.close();
        await fakeServer.close();
    }
});

// --- The example, and the page with it in ---

test('the Team artifacts example: one part whose slide, counter and strip its four rules fill, on its own demo server', () => {
    const app = artifactsApp({ name: 'Team artifacts' });
    const elements = elementsOfComponents(app.screen.components);
    assert.deepEqual(elements.map(element => `${element.id} ${element.kind}`), [
        'carousel output', 'carousel.team output', 'carousel.summary output', 'carousel.prev button', 'carousel.counter output', 'carousel.total output', 'carousel.next button',
        'carousel.stage output', 'carousel.strip output',
    ].map(line => line.replace('carousel output', `carousel ${elements[0].kind}`)));
    const servers = { [DEMO_SERVERS.artifacts.url]: { tools: DEMO_SERVERS.artifacts.tools } };
    assert.deepEqual(flowProblems(app.flow, { elements, servers }).map(([, problems]) => problems), [[], [], [], []]);
    assert.deepEqual(app.flow.map(rule => `${rule.when.map(when => when.element || when.event).join()} ${rule.call.toolName} ${JSON.stringify(rule.call.args)}`), [
        'open get_artifact {"at":1,"limit":12}',
        'open list_team_artifacts {"limit":12}',
        'carousel.prev get_artifact {"at":"{{carousel.counter}}","step":-1,"limit":12}',
        'carousel.next get_artifact {"at":"{{carousel.counter}}","step":1,"limit":12}',
    ]);
    assert.deepEqual(frameConfig(app.flow, elements.map(element => element.id)).read, ['carousel.counter']);
    assert.equal(startCallsOnlyDemos(app), true, 'a link or an embed of it starts at once');
    assert.equal(EXAMPLES.artifacts.make, artifactsApp);
    assert.deepEqual(EXAMPLES.artifacts.servers, ['artifacts']);
    assert.equal(app.screen.components[0].html, CAROUSEL_HTML);
    const { app: back } = fromDml(toDml(app, { standalone: true }));
    assert.equal(back.screen.components[0].html, CAROUSEL_HTML, 'its HTML travels in its DML');
});

test('the example page embeds the example as it is now, with the client beside it', async () => {
    const page = readFileSync(PAGE, 'utf8');
    const iframe = page.match(/<!-- app -->\n\s*(<iframe[^\n]*)\n/)?.[1];
    assert.equal(iframe, await embedOf(), 'npm run build:example writes it again');
    const src = iframe.match(/src="([^"]+)"/)[1];
    assert.ok(src.startsWith(`../?embed${RUN_HASH}`));
    const { app } = fromDml(await unpackApp(src.slice(`../?embed${RUN_HASH}`.length)));
    const now = exampleApp();
    assert.deepEqual([app.name, app.screen.components[0].html, app.flow.map(rule => rule.call)], [now.name, now.screen.components[0].html, now.flow.map(rule => rule.call)]);
    assert.doesNotMatch(page, /<script/i, 'the page itself runs nothing');
});
