// The demo servers built into MCP Browser Client (public/demo-servers/): MCP servers that answer in
// the page's service worker. They speak both protocol eras through the fetch() the MCP client
// library makes, the front desk's tools answer as the mock server's do, the demo model reads the
// prompts the app's rules write, and Glean (demo) answers in the shapes Glean's tools do.
//
//   node --test "tests/*.test.mjs"    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composePrompt, toolCallsIn } from '../public/apps/agent.js';
import { answerText } from '../public/apps/agent.js';
import { chatApp, dashboardApp, demoModel, teamArtifactsApp } from '../public/apps/apps.js';
import { askPrompt } from '../public/apps/ask.js';
import { asksOf, formatRequest } from '../public/apps/boxes.js';
import { answerOf, documentOf, isHtmlDocument } from '../public/apps/flow.js';
import { elementsOfComponents } from '../public/apps/screen.js';
import { chatReply, saidIn, toolsIn } from '../public/demo-servers/demo-model.js';
import { DEMO_SERVERS, demoServerAt, installDemoServers } from '../public/demo-servers/index.js';
import { findVisit } from '../public/demo-servers/front-desk.js';
import { linkOf } from '../public/demo-servers/glean.js';
import { SAMPLE_ARTIFACTS } from '../public/demo-servers/glean-samples.js';
import { mcpServer } from '../public/demo-servers/mcp.js';

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const DESK = DEMO_SERVERS.frontdesk.url;
const MODEL = DEMO_SERVERS.model.url;
const GLEAN = DEMO_SERVERS.glean.url;

// A worker's global scope with the demo servers installed, whose network answers "network".
function worker() {
    const scope = { fetch: async input => new Response(`network: ${input}`) };
    installDemoServers(scope);
    return scope;
}

async function rpc(scope, url, message, headers = {}) {
    const response = await scope.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', ...message }) });
    const text = await response.text();
    return { status: response.status, session: response.headers.get('Mcp-Session-Id'), body: text ? JSON.parse(text) : null };
}

const call = (scope, url, name, args) => rpc(scope, url, { id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } }).then(reply => reply.body.result);

test('a demo server answers MCP 2026-07-28 without a session, and the 2025 handshake in one', async () => {
    const scope = worker();
    const discovered = await rpc(scope, DESK, { id: 1, method: 'server/discover', params: { _meta: META } });
    assert.equal(discovered.status, 200);
    assert.deepEqual(discovered.body.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    assert.deepEqual([discovered.body.result.resultType, discovered.body.result._meta['io.modelcontextprotocol/serverInfo'].name], ['complete', 'Front desk demo server']);
    const listed = await rpc(scope, DESK, { id: 2, method: 'tools/list', params: { _meta: META } });
    assert.deepEqual(listed.body.result.tools.map(tool => tool.name), ['find_visit', 'check_in', 'call_front_desk']);
    assert.ok(listed.body.result.tools.every(tool => !('call' in tool)), 'only the definitions are listed');
    assert.equal((await rpc(scope, DESK, { id: 3, method: 'tools/call', params: { name: 'nope', _meta: META } })).body.error.message, 'Unknown tool: nope');
    assert.equal((await rpc(scope, DESK, { id: 4, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' } } })).body.error.code, -32022);

    const initialized = await rpc(scope, DESK, { id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.deepEqual([initialized.body.result.protocolVersion, !!initialized.session], ['2025-06-18', true]);
    assert.equal((await rpc(scope, DESK, { method: 'notifications/initialized' }, { 'Mcp-Session-Id': initialized.session })).status, 202);
    const inSession = await rpc(scope, DESK, { id: 6, method: 'tools/list' }, { 'Mcp-Session-Id': initialized.session });
    assert.equal(inSession.body.result.tools.length, 3);
    assert.equal(inSession.body.result.resultType, undefined, '2025 results have no resultType');
    assert.equal((await rpc(scope, DESK, { id: 7, method: 'tools/list' })).status, 400, 'a 2025 request without a session is turned away');
    assert.equal((await rpc(scope, DESK, { id: 8, method: 'tools/list' }, { 'Mcp-Session-Id': 'gone' })).status, 404);
    assert.equal((await scope.fetch(DESK)).status, 405, 'no stream to open with GET');
});

test("installDemoServers answers only the demo servers' addresses, one instance of each for as long as the worker runs", async () => {
    const scope = worker();
    assert.equal(await (await scope.fetch('https://example.com/mcp')).text(), 'network: https://example.com/mcp');
    assert.equal(await (await scope.fetch('http://frontdesk.demo.invalid/mcp')).text(), 'network: http://frontdesk.demo.invalid/mcp', 'only https');
    const request = new Request(DESK, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: META } }) });
    assert.equal((await (await scope.fetch(request)).json()).result.resultType, 'complete', 'a Request works as well as a URL and init');
    const first = (await call(scope, DESK, 'check_in', { visitor: 'ada' })).structuredContent.badge;
    const second = (await call(scope, DESK, 'check_in', { visitor: 'kay' })).structuredContent.badge;
    assert.deepEqual([first, second], ['V-1001', 'V-1002'], 'the server keeps its state between calls');
    const before = scope.fetch;
    installDemoServers(scope);
    assert.equal(scope.fetch, before, 'installing twice changes nothing');
    assert.deepEqual([demoServerAt(MODEL)?.id, demoServerAt('https://example.com/'), Object.keys(DEMO_SERVERS)], ['model', null, ['frontdesk', 'model', 'glean']]);
});

test("the front desk's tools find today's visit by part of a name, check people in and call for help, as the mock server's do", async () => {
    assert.equal(findVisit('ada').visit.visitor, 'Ada Lovelace');
    assert.equal(findVisit('  k   johnson ').visit.visitor, 'Katherine Johnson');
    assert.equal(findVisit('Alan', 'dana').visit.visitor, 'Alan Turing');
    assert.equal(findVisit('Alan').why, "More than one visit today is for “Alan”. Type your full name, or who you're here to see.");
    assert.equal(findVisit('Katherine', 'Grace').why, "There's no visit today for “Katherine” to see “Grace”. Check the spelling, or call the front desk and someone will come and help.");
    assert.equal(findVisit(' ').why, 'Type your name first, as it is on your invitation.');
    const scope = worker();
    const found = await call(scope, DESK, 'find_visit', { visitor: 'ada' });
    assert.deepEqual(found.structuredContent, { visitor: 'Ada Lovelace', company: 'Analytical Engines', host: 'Grace Hopper', time: '10:00', room: 'Babbage, 3rd floor' });
    assert.equal(found.content[0].text, 'Ada Lovelace of Analytical Engines is here to see Grace Hopper at 10:00, in Babbage, 3rd floor.');
    assert.deepEqual(await call(scope, DESK, 'find_visit', { visitor: 'Bob' }), { resultType: 'complete', content: [{ type: 'text', text: "There's no visit today for “Bob”. Check the spelling, or call the front desk and someone will come and help." }], isError: true });
    assert.equal((await call(scope, DESK, 'check_in', { visitor: 'ada' })).content[0].text, "Welcome, Ada. Your badge is V-1001. Grace Hopper knows you're here and will meet you in the lobby, then take you to Babbage, 3rd floor.");
    assert.equal((await call(scope, DESK, 'call_front_desk', { visitor: ' Bob ' })).content[0].text, 'Someone from the front desk is on the way, Bob. Please take a seat.');
    assert.equal((await call(scope, DESK, 'call_front_desk', {})).content[0].text, 'Someone from the front desk is on the way. Please take a seat.');
});

test('a tool that throws fails as a tool, not as the server', async () => {
    const server = mcpServer({ name: 'Throws', tools: [{ name: 'boom', inputSchema: { type: 'object' }, call: () => { throw new Error('It broke.'); } }] });
    const response = await server.answer({ method: 'POST', headers: new Headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom', _meta: META } }) });
    assert.deepEqual((await response.json()).result, { resultType: 'complete', content: [{ type: 'text', text: 'It broke.' }], isError: true });
});

test('the demo model reads what the examples write: the Chat prompt with its tools, the dashboard\'s boxes, and a request for HTML', async () => {
    const desk = { url: DESK, alias: 'Front desk (demo)', tools: DEMO_SERVERS.frontdesk.tools };
    const prompt = composePrompt('call find_visit with Ada Lovelace', { instructions: 'Be brief.', servers: { [DESK]: desk } });
    assert.equal(saidIn(prompt), 'call find_visit with Ada Lovelace');
    assert.deepEqual(toolsIn(prompt).map(tool => tool.name), ['find_visit', 'check_in', 'call_front_desk']);
    const asked = chatReply(prompt);
    assert.deepEqual(toolCallsIn(asked), [{ jsonrpc: '2.0', method: 'find_visit', params: { visitor: 'Ada Lovelace' }, id: 1 }]);
    assert.equal(chatReply(composePrompt('call nothing_here', { servers: { [DESK]: desk } })), "I can't call nothing_here: it isn't one of the tools I was given.");
    assert.match(chatReply('hello'), /^You said: hello\n\nI'm the demo model, a stand-in that runs in this page/);
    assert.equal(chatReply('and again', ['User: hello', 'Assistant: You said: hello']), 'You said: and again (2 earlier messages came with it.)');

    const servers = {};
    const pulse = dashboardApp({ shell: { servers }, workbench: null, model: demoModel(), name: 'Project pulse' });
    const [rule] = pulse.flow;
    const request = formatRequest(asksOf(rule, elementsOfComponents(pulse.screen.components)), { size: 'wide' });
    const answer = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(chatReply(`What's the latest on Atlas?\n\n${request}`))[1]);
    assert.deepEqual(Object.keys(answer), ['summary', 'health', 'activity', 'risks', 'docs']);
    assert.match(answer.summary, /^On track: Atlas closed its design review/);
    assert.deepEqual([answer.health.value, answer.activity.values.length, answer.risks.length, answer.docs[0].url], ['On track', 6, 3, 'https://example.com/docs/design']);

    const page = chatReply(askPrompt('a ticket dashboard', { part: true }));
    assert.match(page, /^Here is a page for that\.\n\n```html\n<!DOCTYPE html>/);
    assert.ok(['id="search"', 'id="refresh"', 'id="details"'].every(id => page.includes(id)) && !/<script|onclick|<form/.test(page), 'its fields have ids, and it has no scripts, handlers or forms');
});

test('Chat and Project pulse on the demo model call its chat, before the server has even listed it', () => {
    const shell = { servers: { [MODEL]: { url: MODEL, alias: 'Demo model', tools: [] } } };
    const chat = chatApp({ shell, workbench: null, model: demoModel(), name: 'Chat' });
    assert.deepEqual([chat.flow[0].call.serverUrl, chat.flow[0].call.toolName, chat.flow[0].prompt], [MODEL, 'chat', 'message']);
    assert.deepEqual(chat.flow[0].call.args, { message: '{{message}}', history: '{{conversation}}' });
    assert.match(chat.screen.components[1].text, /^A conversation with the demo model, which can call your servers' tools\./);
    const pulse = dashboardApp({ shell, workbench: null, model: demoModel(), name: 'Project pulse' });
    assert.deepEqual([pulse.flow[0].call.toolName, pulse.flow[0].prompt], ['chat', 'message']);
    assert.match(pulse.screen.components[1].text, /from one question to the demo model:/);
});

test("Glean (demo) takes the fields Glean's tools take, and answers in their shapes: search in Markdown, read_document in three blocks", async () => {
    const scope = worker();
    assert.deepEqual(DEMO_SERVERS.glean.tools.map(tool => [tool.name, tool.inputSchema.required]), [['search', ['query', '_user_goal']], ['read_document', ['urls', '_user_goal']], ['chat', ['message', '_user_goal']]]);
    assert.deepEqual(Object.keys(DEMO_SERVERS.glean.tools[2].inputSchema.properties), ['message', 'context', '_user_goal'], "chat's conversation goes in context, as Glean's does");
    const found = await call(scope, GLEAN, 'search', { query: '*', app: 'artifacts', owner: 'myteam', sort_by_recency: true, _user_goal: 'Show my team’s newest artifacts' });
    assert.match(found.content[0].text, /^# Search results \(8 found\)\n/);
    assert.match(found.content[0].text, /\n## 1\. Build health\.html\n\*\*Source:\*\* artifacts • \*\*Type:\*\* html • \*\*Updated:\*\* \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ • /);
    const links = [...found.content[0].text.matchAll(/\*\*Link:\*\* (\S+)/g)].map(match => match[1]);
    assert.deepEqual(links, SAMPLE_ARTIFACTS.map(linkOf), 'newest first, each with its Library link');
    assert.ok(links.every(link => /^https:\/\/app\.glean\.com\/library\/[0-9a-f]{32}$/.test(link)));
    assert.match(found.content[1].text, /^glean_invocation_id: [0-9a-f-]{36}$/);
    const narrowed = await call(scope, GLEAN, 'search', { query: 'roadmap', owner: 'Grace', _user_goal: 'x' });
    assert.match(narrowed.content[0].text, /^# Search results \(1 found\)[\s\S]*Q1 platform roadmap\.md/);
    assert.match((await call(scope, GLEAN, 'search', { query: '*', app: 'gmail', _user_goal: 'x' })).content[0].text, /\(0 found\)/);

    const read = await call(scope, GLEAN, 'read_document', { urls: [links[1]], _user_goal: 'x' });
    assert.equal(read.content.length, 3);
    assert.match(read.content[0].text, /^documents\[1\]:\n  - artifactId: 7e2b9d41c0a54f6e8b3d1c9a5f7e2b64\n    docType: PAPER\n    glean_doc_id: ARTIFACTS_paper_7e2b9d41c0a54f6e8b3d1c9a5f7e2b64\n    snippets\[1\]: "[^"]+"\n    title: Q1 platform roadmap\.md\n    url: "https:\/\/app\.glean\.com\/library\/7e2b9d41c0a54f6e8b3d1c9a5f7e2b64"$/);
    assert.match(read.content[1].text, /^# Q1 platform roadmap\n/);
    assert.match(read.content[2].text, /^glean_invocation_id: /);
    assert.equal(documentOf(read), read.content[1].text.trim(), 'the document box gets the document alone');
    const page = documentOf(await call(scope, GLEAN, 'read_document', { urls: [`${links[0]}?source=carousel`], _user_goal: 'x' }));
    assert.ok(isHtmlDocument(page) && page.includes('<canvas id="chart"') && page.includes("fetch('https://ci.example.com/"), 'a page comes whole, its scripts too');
    const both = await call(scope, GLEAN, 'read_document', { urls: [links[1], links[3]], _user_goal: 'x' });
    assert.deepEqual([both.content.length, /^documents\[2\]:/.test(both.content[0].text)], [4, true]);
    const missing = await call(scope, GLEAN, 'read_document', { urls: ['https://app.glean.com/library/0000'], _user_goal: 'x' });
    assert.deepEqual(missing, { resultType: 'complete', content: [{ type: 'text', text: "The demo's made-up Glean has no document at https://app.glean.com/library/0000. Its documents are the ones search finds." }], isError: true });
    assert.equal((await call(scope, GLEAN, 'read_document', { urls: [''], _user_goal: 'x' })).isError, true);
});

test("Glean (demo)'s chat gives boxes that ask for links the team's newest papers and pages, and otherwise answers as the demo model", async () => {
    const scope = worker();
    const app = teamArtifactsApp({ shell: { servers: {} }, name: 'Team artifacts' });
    const [pick] = app.flow;
    const message = composePrompt(pick.call.args.message, { request: formatRequest(asksOf(pick, elementsOfComponents(app.screen.components)), { size: 'wide' }) });
    const answer = await call(scope, GLEAN, 'chat', { message, _user_goal: pick.call.args._user_goal });
    assert.match(answer.content[0].text, /^```json\n[\s\S]*\n```\n\n---\nchatId: [0-9a-f]{32}$/, "with the conversation's ID after the answer, as Glean's chat puts it");
    assert.match(answer.content[1].text, /^glean_invocation_id: /);
    const newest = SAMPLE_ARTIFACTS.filter(artifact => artifact.type === 'paper' || artifact.type === 'html').slice(0, 6);
    assert.deepEqual(newest.map(artifact => artifact.title), ['Build health', 'Q1 platform roadmap', 'Flaky test leaderboard', 'Incident review: remote cache outage', 'On-call handbook', 'Golden path: start a new service']);
    assert.deepEqual(answerOf({ result: answer }).values.json, Object.fromEntries(newest.map((artifact, index) => [`link${index + 1}`, linkOf(artifact)])));

    const mixed = formatRequest([{ key: 'top', kind: 'text', about: 'The link of the 3rd newest artifact' }, { key: 'health', kind: 'number', about: 'How the team is doing' }]);
    const both = answerOf({ result: await call(scope, GLEAN, 'chat', { message: `Our artifacts?\n\n${mixed}`, _user_goal: 'x' }) }).values.json;
    assert.deepEqual(both, { top: linkOf(newest[2]), health: { value: 'On track', note: 'Two open risks, neither blocking' } }, "other boxes get the demo model's made-up values");
    const listed = answerText((await call(scope, GLEAN, 'chat', { message: 'What artifacts has my team made lately?', _user_goal: 'x' })).content[0].text);
    assert.match(listed, /^Here is what Developer Experience, the demo's made-up team, made most recently, newest first:\n\n- \[Build health\]\(https:\/\/app\.glean\.com\/library\/4f8c2a19d7e64b0f9a3c5e7b1d2f6a80\): /);
    assert.equal(listed.split('\n- ').length - 1, 6);
    const hello = answerText((await call(scope, GLEAN, 'chat', { message: 'hello', context: ['User: hi'], _user_goal: 'x' })).content[0].text);
    assert.equal(hello, 'You said: hello (1 earlier message came with it.)');
});
