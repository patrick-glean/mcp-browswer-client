// The app builder's pure parts (public/apps/): the flow's templates and arguments, the screen's
// HTML, the DML an app is written down in, the zip it downloads as, the examples it starts from,
// and the agent loop a rule runs when its model may call tools.
//
//   node --test "tests/*.test.mjs"    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { allowedCall, answerText, composePrompt, conversationFieldOf, REPLY_CALLS, serverWithTool, toolCallsIn, toolsForModel, TOOLS_INSTRUCTIONS } from '../public/apps/agent.js';
import { chatApp, dashboardApp, foundModel } from '../public/apps/apps.js';
import { askPrompt, modelArgs, modelCall } from '../public/apps/ask.js';
import { asksOf, formatRequest, isBox, isConversation, promptFieldOf, renderBox } from '../public/apps/boxes.js';
import { DmlError, fromDml, parseXml, serversOf, toDml } from '../public/apps/dml.js';
import {
    answerOf, callArguments, describeRule, elementIdProblem, FlowError, flowProblems, frameConfig, jsonIn, newRule, normalizeRule, renameInFlow,
    renderTemplate, routeSummary, rulesFor, templateValue, triggerIndex, triggersOf,
} from '../public/apps/flow.js';
import { canConnect, connect, disconnect, parsePort, placeRules, wiresOf } from '../public/apps/graph.js';
import { componentsHtml, elementsOfComponents, freeId, htmlFromResult, newComponent, partElements, prefixIds, scopeCss } from '../public/apps/screen.js';
import { crc32, unzip, zip } from '../public/apps/zip.js';

const MOCK = 'http://127.0.0.1:8081/';
const withoutRuleIds = app => ({ ...app, flow: app.flow.map(({ id, ...rule }) => rule) });
const DASH = '<style>\nbody { font: 14px sans-serif; }\n</style>\n<h2>Tickets</h2><label for="search">Find</label><input id="search" placeholder="Ticket"><button id="refresh" type="button">Refresh</button><ul id="list"><li>T-1 ]]&gt; &amp; more</li></ul>';

function sampleApp() {
    return {
        id: 'app-1',
        name: 'Ask & answer <test>',
        description: 'Line one\nline "two"\twith a tab',
        version: 3,
        screen: {
            kind: 'components',
            components: [
                { id: 'title', type: 'title', text: '  Ask the docs: <b>"quoted"</b> & more  ' },
                { id: 'note', type: 'text', text: 'Two\nlines, café ☕ and 🚀' },
                { id: 'question', type: 'textbox', label: 'Question', placeholder: 'e.g. "service worker"', lines: 1, value: '' },
                { id: 'details', type: 'textbox', label: 'Details', placeholder: '', lines: 4, value: 'first\nsecond' },
                { id: 'ask', type: 'button', label: 'Ask' },
                { id: 'answer', type: 'output', label: 'Answer', placeholder: 'It shows up here.' },
                { id: 'dash', type: 'part', label: 'Tickets', ask: 'a ticket dashboard', html: DASH, from: { serverUrl: MOCK, toolName: 'chat', args: { message: 'Write one part…' } } },
            ],
        },
        flow: [
            {
                id: 'rule-a',
                when: [{ element: 'ask', event: 'click' }, { element: 'question', event: 'enter' }],
                position: { x: 660, y: 96 },
                call: { serverUrl: MOCK, toolName: 'search_notes', args: { query: '{{question}}', limit: 5, include_archived: false, tags: ['a', 'b&c'], snippet: { length: 200 }, nothing: null } },
                then: [
                    { if: 'ok', show: 'Found: {{text}}', into: 'answer', how: 'replace' },
                    { if: 'ok', show: '', into: 'question', how: 'replace' },
                    { if: 'error', show: '{{error}}', into: 'answer', how: 'append' },
                ],
            },
            {
                id: 'rule-b',
                when: [{ element: '', event: 'open' }],
                call: { serverUrl: MOCK, toolName: 'echo', args: { text: 'hello <world> & "you"' } },
                then: [{ if: 'ok', show: '<em>{{text}}</em>', into: 'note', how: 'html' }],
            },
        ],
    };
}

test('an app built from components comes back the same from its DML', () => {
    const app = sampleApp();
    const dml = toDml(app, { serverNames: { [MOCK]: 'Mock server' } });
    assert.throws(() => fromDml(dml), /The part dash is in parts\/dash\.html, which isn't with this file/);
    const { app: back, servers } = fromDml(dml, { files: { 'parts/dash.html': DASH } });
    assert.deepEqual(withoutRuleIds(back), withoutRuleIds(app));
    assert.deepEqual(servers, [{ url: MOCK, name: 'Mock server' }]);
    assert.ok(back.flow.every(rule => /^rule-/.test(rule.id)), 'imported rules get ids');
    const alone = fromDml(toDml(app, { standalone: true }));
    assert.deepEqual(withoutRuleIds(alone.app), withoutRuleIds(app), 'on its own, the DML carries the part');
});

test('the DML reads like the flow it describes', () => {
    const dml = toDml(sampleApp());
    assert.match(dml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!--/);
    assert.match(dml, /<app dml="1" id="app-1" name="Ask &amp; answer &lt;test&gt;" version="3">/);
    assert.match(dml, /<screen src="index\.html" built-from="components">/);
    assert.match(dml, /<textbox id="details" label="Details" lines="4" value="first&#10;second"\/>/);
    assert.match(dml, /<when element="ask" event="click" x="660" y="96">\n {6}<or element="question" event="enter"\/>\n {6}<call server="http:\/\/127\.0\.0\.1:8081\/" tool="search_notes">/);
    assert.match(dml, /<part id="dash" label="Tickets" src="parts\/dash\.html">\n {6}<ask>a ticket dashboard<\/ask>\n {6}<from server="http:\/\/127\.0\.0\.1:8081\/" tool="chat">/);
    assert.match(dml, /<arg name="query">\{\{question\}\}<\/arg>/);
    assert.match(dml, /<arg name="limit" type="json">5<\/arg>/);
    assert.match(dml, /<then if="ok" into="answer">Found: \{\{text\}\}<\/then>/);
    assert.match(dml, /<then if="error" into="answer" how="append">\{\{error\}\}<\/then>/);
    assert.match(dml, /<when event="open">/);
});

test('an HTML screen travels as index.html in a zip, or inside the DML on its own', () => {
    const html = '<!DOCTYPE html>\n<html><body><input id="q"><button id="go">Go</button><div id="out"></div></body></html>\n';
    const app = {
        id: 'app-2', name: 'From a tool', description: '', version: 0,
        screen: { kind: 'html', html, from: { serverUrl: MOCK, toolName: 'make_screen', args: { title: 'Ask' } } },
        flow: [newRule({ element: 'go', serverUrl: MOCK, toolName: 'echo', args: { text: '{{q}}' }, into: 'out' })],
    };
    app.screen.ask = '';
    const inZip = toDml(app);
    assert.match(inZip, /<screen src="index\.html">\n {4}<from server="http:\/\/127\.0\.0\.1:8081\/" tool="make_screen">/);
    assert.doesNotMatch(inZip, /<html>/);
    assert.deepEqual(withoutRuleIds(fromDml(inZip, { files: { 'index.html': html } }).app), withoutRuleIds(app));
    assert.throws(() => fromDml(inZip), /The screen is in index\.html, which isn't with this file/);

    const alone = toDml(app, { standalone: true });
    assert.doesNotMatch(alone, /src=/);
    assert.match(alone, /<html><!\[CDATA\[<!DOCTYPE html>\n<html><body><input id="q">/, 'the HTML reads as HTML');
    assert.deepEqual(withoutRuleIds(fromDml(alone).app), withoutRuleIds(app));

    const awkward = { ...app, screen: { ...app.screen, html: '<p id="x">a ]]> b</p>', from: null, ask: 'make it awkward' } };
    assert.deepEqual(fromDml(toDml(awkward, { standalone: true })).app.screen, awkward.screen);
    const carriageReturns = { ...app, screen: { ...app.screen, html: '<p id="x">a\r\nb</p>', from: null, ask: '' } };
    assert.deepEqual(fromDml(toDml(carriageReturns, { standalone: true })).app.screen, carriageReturns.screen);
});

test('DML written by hand: CDATA, comments, single quotes and character references', () => {
    const { app } = fromDml(`<?xml version="1.0"?>
<!-- by hand -->
<app dml='1' name='Hand made'>
  <screen built-from="components">
    <title id="t"><![CDATA[a <b> & c]]></title>
    <!-- a comment between components -->
    <button id="b" label="Go &#x2192;"/>
    <output id="o" label="Out"/>
  </screen>
  <flow>
    <when element="b" event="click">
      <call server="${MOCK}" tool="echo"><arg name="text">line&#10;two &lt;3</arg></call>
      <then into="o">{{text}}</then>
    </when>
  </flow>
</app>`);
    assert.equal(app.id, null);
    assert.equal(app.screen.components[0].text, 'a <b> & c');
    assert.equal(app.screen.components[1].label, 'Go →');
    assert.equal(app.flow[0].call.args.text, 'line\ntwo <3');
    assert.deepEqual(app.flow[0].then, [{ if: 'ok', show: '{{text}}', into: 'o', how: 'replace' }]);
    const waiting = fromDml(`<app dml="1"><screen built-from="components"/><flow><when><call server="${MOCK}" tool="echo"/></when></flow></app>`).app;
    assert.deepEqual(waiting.flow[0].when, [], 'a <when> with no trigger waits for nothing yet');
});

test('broken DML says what is wrong and on which line', () => {
    const cases = [
        ['<app dml="1">\n  <screen built-from="components">\n  </scren>\n</app>', /^Line 3: <\/scren> can't close <screen> from line 2\./],
        ['<app dml="1" name="a & b"/>', /^Line 1: A & has to be written as &amp;\./],
        ['<app dml="2"><screen built-from="components"/><flow/></app>', /DML version 2, and this client reads version 1/],
        ['<!DOCTYPE app><app dml="1"/>', /can't have a DOCTYPE/],
        ['<flow/>', /starts with <app>, not <flow>/],
        ['<app dml="1">\n<screen built-from="components"/>\n<flow>\n<when element="x" event="hover"><call server="s" tool="t"/></when>\n</flow>\n</app>', /^Line 4: <when> needs event="…", one of click, enter, change, open\./],
        ['<app dml="1"><screen built-from="components"/><flow><when element="x" event="click"><then into="y"/></when></flow></app>', /<when> needs a <call>\./],
        ['<app dml="1"><screen built-from="components"><slider id="s"/></screen><flow/></app>', /<slider> isn't a component/],
        ['<app dml="1"><screen built-from="components"><button id="a"/><output id="a"/></screen><flow/></app>', /Two components are a/],
        ['<app dml="1"><screen built-from="components"/><flow><when element="x" event="click"><call server="s" tool="t"><arg name="n" type="json">{oops</arg></call></when></flow></app>', /n says type="json", but its value isn't JSON/],
        ['<app dml="1"><screen built-from="components"/>', /<app> is never closed/],
        ['<app dml="1"><screen built-from="components"/><flow><when element="a" event="click"><or event="change"/><call server="s" tool="t"/></when></flow></app>', /<or event="change"> needs element=/],
        ['<app dml="1"><screen built-from="components"/><flow><when element="a" event="click" x="10"><call server="s" tool="t"/></when></flow></app>', /x and y are numbers together/],
    ];
    for (const [dml, expected] of cases) {
        assert.throws(() => fromDml(dml), error => error instanceof DmlError && expected.test(error.message), String(expected));
    }
});

test('the XML reader keeps text exactly and skips whitespace between elements', () => {
    const root = parseXml('<a x="1&#9;2"\n  y="multi\nline">\n  <b>  keep  </b>\n</a>');
    assert.deepEqual(root.attrs, { x: '1\t2', y: 'multi line' });
    const [b] = root.children.filter(child => typeof child === 'object');
    assert.deepEqual(b.children, ['  keep  ']);
});

test('a zip of the files comes back the same, and its checksums are checked', async () => {
    const files = [
        { name: 'app.dml', data: toDml(sampleApp()) },
        { name: 'index.html', data: componentsHtml(sampleApp().screen.components) },
        { name: 'folder/README – notes.md', data: '# Notes ☕\n' },
    ];
    const bytes = zip(files, { date: new Date(2026, 9, 9, 16, 45, 30) });
    const back = await unzip(bytes);
    assert.deepEqual([...back.keys()], files.map(file => file.name));
    const decoder = new TextDecoder();
    for (const file of files) assert.equal(decoder.decode(back.get(file.name)), file.data);
    const damaged = bytes.slice();
    damaged[40] ^= 0xff;
    await assert.rejects(unzip(damaged), /damaged/);
    await assert.rejects(unzip(new TextEncoder().encode('not a zip at all')), /isn't a zip file/);
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a zip made by a zip tool, with deflated files, can be read', async () => {
    const text = 'deflated text '.repeat(50);
    const raw = new TextEncoder().encode(text);
    const packed = deflateRawSync(raw);
    const stored = zip([{ name: 'a.txt', data: raw }]);
    // Rewrite the stored entry as a deflated one: same headers, method 8, the compressed size.
    const name = new TextEncoder().encode('a.txt');
    const local = stored.slice(0, 30);
    const central = stored.slice(30 + name.length + raw.length, 30 + name.length + raw.length + 46);
    const lv = new DataView(local.buffer);
    const cv = new DataView(central.buffer);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, packed.length, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, packed.length, true);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, 1, true);
    end.setUint16(10, 1, true);
    end.setUint32(12, 46 + name.length, true);
    end.setUint32(16, 30 + name.length + packed.length, true);
    const bytes = new Uint8Array([...local, ...name, ...packed, ...central, ...name, ...new Uint8Array(end.buffer)]);
    const back = await unzip(bytes);
    assert.equal(new TextDecoder().decode(back.get('a.txt')), text);
});

test("a tool's answer gives its routes text, structured content, JSON and errors", () => {
    const ok = answerOf({ result: { content: [{ type: 'text', text: 'Counted to 3' }], structuredContent: { counted: 3 } } });
    assert.equal(ok.ok, true);
    assert.equal(ok.values.text, 'Counted to 3');
    assert.deepEqual(ok.values.structured, { counted: 3 });
    assert.equal(ok.values.error, '');

    const json = answerOf({ result: { content: [{ type: 'text', text: '{"items":[{"title":"First"}]}' }] } });
    assert.equal(renderTemplate('{{json.items.0.title}}', json.values).text, 'First');

    const toolError = answerOf({ result: { content: [{ type: 'text', text: 'limit is required' }], isError: true } });
    assert.deepEqual([toolError.ok, toolError.values.error], [false, 'limit is required']);
    const failed = answerOf({ error: "Couldn't reach the server", errorKind: 'network' });
    assert.deepEqual([failed.ok, failed.values.error], [false, "Couldn't reach the server"]);
    assert.equal(answerOf({ result: { resultType: 'input_required' } }).ok, false);
    assert.equal(answerOf({ result: { result: { content: [{ type: 'text', text: 'wrapped' }] } } }).values.text, 'wrapped');
});

test('templates fill in paths, show objects as JSON and list what had no value', () => {
    const values = { text: 'hi', structured: { counted: 3, list: [1, 2] }, question: 'why?', flag: false, nothing: null };
    assert.deepEqual(renderTemplate('{{question}} → {{text}} ({{structured.counted}}, {{flag}})', values), { text: 'why? → hi (3, false)', missing: [] });
    assert.equal(renderTemplate('{{structured.list}}', values).text, '[\n  1,\n  2\n]');
    assert.deepEqual(renderTemplate('[{{nothing}}][{{json.x}}][{{structured.list.5}}]', values), { text: '[][][]', missing: ['json.x', 'structured.list.5'] });
    assert.equal(renderTemplate('', values).text, '');
});

test("a call's arguments take the screen's values, then the environment's variables, in the field's type", () => {
    const schema = { type: 'object', properties: { text: { type: 'string' }, n: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } } };
    const call = { args: { text: '{{greeting}}, {{name}}!', n: '{{count}}', tags: ['{{name}}'] } };
    const { sentArgs, variablesUsed } = callArguments(call, { screen: { name: 'Ada', count: '3' }, variables: { greeting: 'Hello', name: 'not this one' }, schema });
    assert.deepEqual(sentArgs, { text: 'Hello, Ada!', n: 3, tags: ['Ada'] });
    assert.deepEqual(variablesUsed, ['greeting']);
    assert.throws(() => callArguments({ args: { text: '{{missing}}' } }, { environmentName: 'Default' }),
        /\{\{missing\}\} isn't an element on the screen or a variable in Default\./);
    assert.throws(() => callArguments(call, { screen: { name: 'Ada', count: 'many' }, variables: { greeting: 'Hi' }, schema }), /isn't a number/);
});

test('renaming an element takes the flow with it', () => {
    const [rule] = renameInFlow(sampleApp().flow, 'question', 'query');
    assert.equal(rule.call.args.query, '{{query}}');
    assert.equal(rule.then[1].into, 'query');
    const [, open] = renameInFlow(sampleApp().flow, 'note', 'intro');
    assert.equal(open.then[0].into, 'intro');
    const [asked] = renameInFlow(sampleApp().flow, 'ask', 'go');
    assert.equal(asked.when[0].element, 'go');
    const shown = renameInFlow([{ ...rule, then: [{ if: 'ok', show: 'You asked {{query}}: {{text}}', into: 'answer', how: 'replace' }] }], 'query', 'q');
    assert.equal(shown[0].then[0].show, 'You asked {{q}}: {{text}}');
});

test('element ids are checked, and new components get free ones', () => {
    assert.equal(elementIdProblem('question', []), null);
    assert.match(elementIdProblem('text', []), /what a tool's answer brings/);
    assert.match(elementIdProblem('2nd', []), /starts with a letter/);
    assert.match(elementIdProblem('ask', ['ask']), /already ask/);
    assert.equal(freeId('input', ['input', 'input2']), 'input3');
    const made = newComponent('textbox', ['input']);
    assert.deepEqual([made.id, made.type, made.lines, made.label], ['input2', 'textbox', 1, 'Text box 2']);
    assert.equal(newComponent('output', []).label, 'Output');
    assert.equal(newComponent('output', ['output']).label, 'Output 2');
    assert.equal(newComponent('button', ['button'], { label: 'Send' }).label, 'Send');
});

test("the screen's runtime watches what rules wait for and reads what they use", () => {
    const app = sampleApp();
    const ids = elementsOfComponents(app.screen.components).map(element => element.id);
    assert.deepEqual(frameConfig(app.flow, ids), { watch: [{ element: 'ask', event: 'click' }, { element: 'question', event: 'enter' }], read: ['question'], track: ids });
    assert.deepEqual(rulesFor(app.flow, 'ask', 'click').map(rule => rule.id), ['rule-a']);
    assert.deepEqual(rulesFor(app.flow, 'question', 'enter').map(rule => rule.id), ['rule-a']);
    assert.equal(triggerIndex(app.flow[0], 'question', 'enter'), 1);
    assert.deepEqual(rulesFor(app.flow, '', 'open').map(rule => rule.id), ['rule-b']);
    assert.deepEqual(triggersOf(normalizeRule({ when: { element: 'ask', event: 'click' } })), [{ element: 'ask', event: 'click' }], 'a rule saved with one trigger as an object still reads');
});

test('rules say what they do in a sentence, and what keeps them from running', () => {
    const app = sampleApp();
    assert.match(describeRule(app.flow[0]), /^When ask is clicked or question gets Enter, call search_notes/);
    assert.match(describeRule(newRule({ serverUrl: MOCK, toolName: 'echo' })), /^Once something starts it, call echo on/);
    const sentence = describeRule(app.flow[1], { serverName: () => 'Mock server' });
    assert.equal(sentence, 'When the app opens, call echo on Mock server with text = “hello <world> & "you"”; if it works, put “<em>{{text}}</em>” into note as HTML.');
    assert.equal(describeRule(app.flow[0]), 'When ask is clicked or question gets Enter, call search_notes on http://127.0.0.1:8081/ with query = {{question}}, limit = 5, include_archived = false, tags = ["a","b&c"], snippet = {"length":200}, nothing = null; if it works, put “Found: {{text}}” into answer; if it works, put nothing (clearing it) into question; if it fails, put {{error}} into answer after what it shows.');
    const elements = elementsOfComponents(app.screen.components);
    const servers = { [MOCK]: { tools: [{ name: 'echo' }] } };
    const problems = Object.fromEntries(flowProblems(app.flow, { elements, servers }));
    assert.deepEqual(problems['rule-a'], ["search_notes isn't one of this server's tools."]);
    assert.deepEqual(problems['rule-b'], []);
    const [[, blank]] = flowProblems([newRule()], { elements, servers });
    assert.deepEqual(blank, ['Nothing starts it yet: choose what it waits for.', 'Choose a server.', 'Choose where the answer goes.']);
    assert.deepEqual(serversOf(app), [MOCK]);
});

test('a screen built from components is HTML with the ids the flow uses, its text escaped', () => {
    const html = componentsHtml(sampleApp().screen.components, { title: 'A <title>' });
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>A &lt;title&gt;<\/title>/);
    assert.match(html, /<h1 id="title">  Ask the docs: &lt;b&gt;&quot;quoted&quot;&lt;\/b&gt; &amp; more  <\/h1>/);
    assert.match(html, /<input id="question" type="text" placeholder="e\.g\. &quot;service worker&quot;" autocomplete="off">/);
    assert.match(html, /<textarea id="details" rows="4">first\nsecond<\/textarea>/);
    assert.match(html, /<button id="ask" type="button">Ask<\/button>/);
    assert.match(html, /<h2 class="label">Answer<\/h2>\n {6}<div id="answer" class="output" aria-label="Answer" aria-live="polite" data-placeholder="It shows up here\."><\/div>/);
    assert.deepEqual([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]),
        ['title', 'note', 'question', 'details', 'ask', 'answer', 'dash', 'dash.search', 'dash.refresh', 'dash.list'], 'only components and the elements of parts have ids');
    assert.doesNotMatch(html, /<script|https?:\/\//, 'a built screen needs no scripts and loads nothing');
});

test("the HTML in a tool's answer is found wherever the tool put it", () => {
    const page = '<!DOCTYPE html><html><body><button id="go">Go</button></body></html>';
    assert.equal(htmlFromResult({ content: [{ type: 'resource', resource: { uri: 'mock://screen.html', mimeType: 'text/html', text: page } }] }), page);
    assert.equal(htmlFromResult({ content: [{ type: 'text', text: `Here is your screen:\n\n\`\`\`html\n${page}\n\`\`\`\nEnjoy.` }] }), page);
    assert.equal(htmlFromResult({ content: [{ type: 'text', text: `  ${page}  ` }] }), page);
    assert.equal(htmlFromResult({ structuredContent: { html: page } }), page);
    assert.equal(htmlFromResult({ content: [{ type: 'text', text: 'Echo: hello' }] }), null);
    assert.equal(htmlFromResult(null), null);
});

test('the canvas draws each part of a rule as a wire: triggers, fields fed by the screen, and routes', () => {
    const app = sampleApp();
    const ids = elementsOfComponents(app.screen.components).map(element => element.id);
    const wires = wiresOf(app.flow, ids).map(wire => `${wire.kind} ${wire.from} -> ${wire.to}`);
    assert.deepEqual(wires, [
        'trigger el:ask -> run:rule-a',
        'trigger el:question -> run:rule-a',
        'arg el:question -> arg:rule-a:query',
        'answer ok:rule-a -> el:answer',
        'answer ok:rule-a -> el:question',
        'error err:rule-a -> el:answer',
        'trigger start -> run:rule-b',
        'answer ok:rule-b -> el:note',
    ]);
    assert.deepEqual(wiresOf(app.flow, ['ask']).map(wire => wire.id), ['t:rule-a:0', 't:rule-b:0'], "wires to elements that aren't on the screen aren't drawn");
    assert.deepEqual(parsePort('arg:rule-a:snippet:length'), { kind: 'arg', ruleId: 'rule-a', arg: 'snippet:length' });
    assert.deepEqual(parsePort('el:dash.refresh'), { kind: 'el', element: 'dash.refresh' });
});

test('connecting ports adds the part of the rule the wire is, and says why two ports don\'t join', () => {
    const flow = [newRule({ serverUrl: MOCK, toolName: 'echo', into: null })];
    const id = flow[0].id;
    const kinds = { go: 'button', q: 'input', out: 'output' };
    const kindOf = element => kinds[element];
    let { flow: next, made } = connect(flow, 'el:go', `run:${id}`, { kindOf });
    assert.deepEqual([made.kind, triggersOf(next[0])], ['trigger', [{ element: 'go', event: 'click' }]]);
    ({ flow: next, made } = connect(next, `run:${id}`, 'el:q', { kindOf }));
    assert.deepEqual(triggersOf(next[0]).at(-1), { element: 'q', event: 'enter' }, "a field's wire waits for Enter");
    ({ flow: next, made } = connect(next, 'start', `run:${id}`, { kindOf }));
    assert.deepEqual(triggersOf(next[0]).at(-1), { element: '', event: 'open' });
    ({ flow: next, made } = connect(next, 'el:go', `run:${id}`, { kindOf }));
    assert.equal(made.kind, 'already');
    ({ flow: next } = connect(next, 'el:q', `arg:${id}:text`, { kindOf }));
    assert.deepEqual(next[0].call.args, { text: '{{q}}' });
    ({ flow: next } = connect(next, `ok:${id}`, 'el:out', { kindOf }));
    ({ flow: next } = connect(next, 'el:out', `err:${id}`, { kindOf }));
    assert.deepEqual(next[0].then, [
        { if: 'ok', show: '{{text}}', into: 'out', how: 'replace' },
        { if: 'error', show: '{{error}}', into: 'out', how: 'replace' },
    ]);
    assert.equal(canConnect('el:q', `arg:${id}:text`), true);
    assert.equal(canConnect('el:q', 'el:out'), false);
    assert.throws(() => connect(next, 'el:q', 'el:out', { kindOf }), error => error instanceof FlowError && /through a tool/.test(error.message));
    assert.throws(() => connect(next, 'start', 'el:out', { kindOf }), /Start connects to a tool's Run/);
    assert.throws(() => connect(next, `ok:${id}`, `run:${id}`, { kindOf }), /can't start another tool yet/);

    const wires = wiresOf(next, ['go', 'q', 'out']);
    const without = (kind, more = {}) => disconnect(next, wires.find(wire => wire.kind === kind && Object.entries(more).every(([key, value]) => wire[key] === value)), { required: ['text'] });
    assert.deepEqual(triggersOf(without('trigger', { element: 'q' })[0]).map(candidate => candidate.element), ['go', '']);
    assert.deepEqual(without('arg')[0].call.args, { text: '' }, 'a required field is left empty');
    assert.deepEqual(disconnect(next, wires.find(wire => wire.kind === 'arg'))[0].call.args, {}, 'an optional one is left out');
    assert.deepEqual(without('error')[0].then.map(route => route.if), ['ok']);
    const mixed = [{ ...next[0], call: { ...next[0].call, args: { text: 'Hi {{q}}!' } } }];
    assert.deepEqual(disconnect(mixed, wiresOf(mixed, ['q']).find(wire => wire.kind === 'arg'))[0].call.args, { text: 'Hi !' });
});

test('tools nobody placed go in a column beside what they use, clear of each other', () => {
    const rules = ['a', 'b', 'c', 'd'].map(id => ({ id, when: [] }));
    rules[3].position = { x: 600, y: 100 };
    const anchors = { a: 120, b: 90, c: null };
    const placed = placeRules(rules, { x: 600, top: 40, gap: 20, anchor: rule => anchors[rule.id], height: () => 100 });
    assert.deepEqual(Object.fromEntries(placed), { b: { x: 600, y: 220 }, a: { x: 600, y: 340 }, c: { x: 600, y: 460 } });
    const far = placeRules([{ id: 'e', when: [] }, { id: 'f', when: [], position: { x: 40, y: 0 } }], { x: 600, anchor: () => 0, height: () => 100 });
    assert.deepEqual(Object.fromEntries(far), { e: { x: 600, y: 0 } }, 'a tool placed in another column is no obstacle');
});

test('a part a tool made goes on the screen with its ids named after it, and its styles kept inside it', () => {
    const part = sampleApp().screen.components.find(component => component.type === 'part');
    assert.deepEqual(partElements(part).map(element => `${element.id} ${element.kind} ${element.label}`), [
        'dash.search input Find',
        'dash.refresh button Refresh',
        'dash.list output dash.list',
    ]);
    assert.equal(prefixIds('<a href="#top" id="go" aria-describedby="hint tip">x</a><label for="q">Q</label><input id="q" list="names" title="a > b">', 'p'),
        '<a href="#p.top" id="p.go" aria-describedby="p.hint p.tip">x</a><label for="p.q">Q</label><input id="p.q" list="p.names" title="a > b">');
    assert.equal(scopeCss('body { margin: 0 } html, :root { color: red } .body { x: y }', 'dash'),
        '@scope ([data-part="dash"]) {\n:scope { margin: 0 } :scope, :scope { color: red } .body { x: y }\n}');
    assert.equal(scopeCss('#details, .card > #open { background: #f4f4f5 } #other { color: #fff }', 'dash', ['details', 'open']),
        '@scope ([data-part="dash"]) {\n#dash\\.details, .card > #dash\\.open { background: #f4f4f5 } #other { color: #fff }\n}');
    const html = componentsHtml([part]);
    assert.match(html, /<section id="dash" class="part" data-part="dash" aria-label="Tickets">\n {6}<style>\n@scope \(\[data-part="dash"\]\) \{\n:scope \{ font: 14px sans-serif; \}\n\}\n {6}<\/style>\n<h2>Tickets<\/h2><label for="dash\.search">Find<\/label>/);
    assert.match(componentsHtml([{ ...part, html: '' }]), /<p class="part-empty">Tickets: nothing here yet\. Ask a model for it, or get it from a tool\.<\/p>/);
});

test('a part keeps its elements through a rename, and its answers can be HTML', () => {
    const app = sampleApp();
    const flow = [newRule({ element: 'dash.refresh', serverUrl: MOCK, toolName: 'ticket', args: { prefix: '{{dash.search}}' }, into: 'dash.list' })];
    const [renamed] = renameInFlow(flow, 'dash', 'board');
    assert.deepEqual([renamed.when[0].element, renamed.call.args.prefix, renamed.then[0].into], ['board.refresh', '{{board.search}}', 'board.list']);
    assert.deepEqual(callArguments(renamed.call, { screen: { 'board.search': 'T-' } }).sentArgs, { prefix: 'T-' });
    assert.equal(renderTemplate('Found {{board.search}}', { 'board.search': 'T-9' }).text, 'Found T-9');
    const page = '<!DOCTYPE html><p id="x">hi</p>';
    assert.equal(answerOf({ result: { content: [{ type: 'text', text: 'Here:' }, { type: 'resource', resource: { uri: 'u', mimeType: 'text/html', text: page } }] } }).values.html, page);
    assert.equal(answerOf({ result: { content: [{ type: 'text', text: 'no page' }] } }).values.html, '');
    assert.match(elementIdProblem('html', []), /what a tool's answer brings/);
    assert.deepEqual(serversOf(app), [MOCK]);
});

test("a transform's label is the value it takes, or the start of its template", () => {
    assert.equal(routeSummary({ if: 'ok', show: '{{text}}' }), 'text');
    assert.equal(routeSummary({ if: 'ok', show: '{{structured.counted}}' }), 'counted');
    assert.equal(routeSummary({ if: 'ok', show: '{{ json.items.0 }}' }), 'items.0');
    assert.equal(routeSummary({ if: 'ok', show: '{{structured.counted}} steps' }), '{counted} s…');
    assert.equal(routeSummary({ if: 'ok', show: '{{structured.counted}} steps' }, { max: 40 }), '{counted} steps');
    assert.equal(routeSummary({ if: 'ok', show: 'You said {{question}} and more' }), 'You said {q…');
    assert.equal(routeSummary({ if: 'ok', show: '' }), 'nothing');
});

test('asking a model sends it what to make, with the rules a screen needs', () => {
    const prompt = askPrompt('a ticket dashboard', { part: true });
    assert.match(prompt, /^Write one part of an app's screen, as an HTML fragment \(not a whole page\): a ticket dashboard\n\n/);
    assert.match(prompt, /an id of letters, digits, - or _/);
    assert.match(prompt, /No scripts and nothing from the network/);
    assert.doesNotMatch(prompt, /Change this HTML/);
    assert.match(askPrompt('add a total', { current: '<p id="n">1</p>' }), /^Write the screen of an app, as one HTML page: add a total\n\nChange this HTML to do that, keeping its ids:\n\n```html\n<p id="n">1<\/p>\n```/);
    const model = { serverUrl: MOCK, toolName: 'chat', messageField: 'message', conversationField: 'history' };
    assert.deepEqual(modelCall(model, 'make it'), { serverUrl: MOCK, toolName: 'chat', args: { message: 'make it', history: [] } });
    // Glean's chat wants the person's own words in _user_goal, a required text field.
    const schema = { properties: { message: { type: 'string' }, _user_goal: { type: 'string' }, n: { type: 'integer' } }, required: ['message', '_user_goal', 'n'] };
    assert.deepEqual(modelCall({ ...model, conversationField: null }, 'Write the screen…', { schema, goal: 'a ticket dashboard' }).args, { _user_goal: 'a ticket dashboard', message: 'Write the screen…' });
    assert.deepEqual(modelArgs(model, { prompt: '{{message}}', conversation: '{{conversation}}', schema, base: { n: 1, message: 'test' } }),
        { n: 1, _user_goal: '{{message}}', history: '{{conversation}}', message: '{{message}}' });
    assert.throws(() => modelCall(null, 'x'), /There is no model to ask yet\. Add a server with a chat tool \(Glean, or the mock\), or choose one under Model\./);
    assert.throws(() => modelCall({ ...model, messageField: null }, 'x'), /Choose the field of chat the request goes in, under Model\./);
});

// A dashboard's screen: boxes that say what they show, and one rule that asks for all of them.
function dashboard() {
    // Text and full width are what an output is when it doesn't say, so DML leaves them out.
    const box = (id, show, about, width) => ({ id, type: 'output', label: id[0].toUpperCase() + id.slice(1), placeholder: '', ...(show !== 'text' ? { show } : {}), about, ...(width ? { width } : {}) });
    return {
        id: 'app-dash',
        name: 'Pulse',
        description: '',
        version: 0,
        screen: {
            kind: 'components',
            size: 'wide',
            components: [
                { id: 'project', type: 'textbox', label: 'Project', placeholder: '', lines: 1, value: 'Atlas', width: 'two-thirds' },
                { id: 'refresh', type: 'button', label: 'Refresh', width: 'third' },
                box('summary', 'text', 'Where it stands, in 2 sentences'),
                box('health', 'number', 'On track, At risk or Off track', 'third'),
                box('activity', 'bar', 'Updates per week, the last 6 weeks', 'two-thirds'),
                box('docs', 'list', 'The 3 most useful documents', 'half'),
                box('banner', 'html', 'A status banner', 'half'),
                { id: 'plain', type: 'output', label: 'Plain', placeholder: '' },
            ],
        },
        flow: [{
            id: 'rule-pulse',
            when: [{ element: '', event: 'open' }, { element: 'refresh', event: 'click' }],
            call: { serverUrl: 'https://acme-be.glean.com/mcp/default', toolName: 'chat', args: { message: "What's the latest on {{project}}?", _user_goal: "What's the latest on {{project}}?" } },
            prompt: 'message',
            then: [
                ...['summary', 'health', 'activity', 'docs', 'banner'].map(id => ({ if: 'ok', show: `{{json.${id}}}`, into: id, how: 'replace' })),
                { if: 'ok', show: '{{text}}', into: 'plain', how: 'replace' },
                { if: 'error', show: '{{json.summary}}', into: 'summary', how: 'replace' },
            ],
        }],
    };
}

test("the JSON in a model's answer is read from its ```json block, whatever comes after it", () => {
    const glean = '```json\n{\n  "summary": "Going well.",\n  "activity": {"labels": ["Jul", "Aug"], "values": [1, 3]}\n}\n```\n\n---\nchatId: 1d85be3c\nmessages[3]:\n  -\n    ts: "2026-10-10"';
    assert.deepEqual(jsonIn(glean), { summary: 'Going well.', activity: { labels: ['Jul', 'Aug'], values: [1, 3] } });
    assert.deepEqual(jsonIn('{"a": 1}'), { a: 1 });
    assert.deepEqual(jsonIn('Here:\n```\n[1, 2]\n```'), [1, 2]);
    // Glean's chat breaks lines inside a string around a citation, which JSON doesn't allow.
    const cited = '```json\n{\n  "summary": "It works.  [^1]\n\n",\n  "note": "tab\there, \\"quoted\\""\n}\n```\n\n[^1]: [Notes](https://example.com/n)\n';
    assert.deepEqual(jsonIn(cited), { summary: 'It works.  [^1]\n\n', note: 'tab\there, "quoted"' });
    assert.equal(renderBox('text', jsonIn(cited).summary).html, '<p class="box-text">It works.</p>');
    assert.match(renderBox('bar', { labels: ['2026-08-31', '2026-09-07'], values: [0, 1] }).html, /<span title="Aug 31">Aug 31<\/span><span title="Sep 7">Sep 7<\/span>/);
    assert.equal(jsonIn('```json\n{not json}\n```'), null);
    assert.equal(jsonIn('No JSON here.'), null);
    assert.equal(answerOf({ result: { content: [{ type: 'text', text: glean }] } }).values.json.summary, 'Going well.');
    const values = { json: { docs: [{ title: 'A' }] }, project: 'Atlas' };
    assert.deepEqual(templateValue('{{json.docs}}', values), [{ title: 'A' }]);
    assert.equal(templateValue('On {{project}}', values), 'On Atlas');
    assert.equal(templateValue('{{json.nothing}}', values), undefined);
});

test("a rule's boxes ask for one JSON object, a key for each, in the shapes they show", () => {
    const app = dashboard();
    const elements = elementsOfComponents(app.screen.components);
    assert.deepEqual(elements.filter(isBox).map(element => element.id), ['summary', 'health', 'activity', 'docs', 'banner']);
    const asks = asksOf(app.flow[0], elements);
    assert.deepEqual(asks.map(({ key, kind, width }) => `${key} ${kind} ${width}`), ['summary text full', 'health number third', 'activity bar two-thirds', 'docs list half', 'banner html half']);
    const request = formatRequest(asks, { size: 'wide' });
    assert.equal(request.split('\n')[0], "This answer fills the boxes on an app's screen. Answer with one JSON object in a ```json block, and nothing else, with exactly these keys:");
    assert.match(request, /^- "summary" \(text\): Where it stands, in 2 sentences\. As a string\.$/m);
    assert.match(request, /^- "health" \(number\): On track, At risk or Off track\. As \{"value": number or short text, "note": string\}\.$/m);
    assert.match(request, /^- "activity" \(bar chart\): Updates per week, the last 6 weeks\. As \{"labels": \[string\], "values": \[number\]\}\.$/m);
    assert.match(request, /^- "banner" \(HTML\): A status banner\. As a string of HTML for a box about 520 px wide: no scripts, nothing from the network, inline styles only\.$/m);
    assert.match(request, /\nUse null for a key you have nothing for\.$/);
    assert.match(formatRequest(asks), /about 300 px wide/, 'a narrow screen has narrower boxes');
    assert.doesNotMatch(request, /"plain"/, "an answer's text isn't a key");
    assert.equal(promptFieldOf({ properties: { _user_goal: { type: 'string' }, message: { type: 'string' }, context: { type: 'array' } }, required: ['message', '_user_goal'] }), 'message');
    assert.equal(promptFieldOf({ properties: { topic: { type: 'string' }, n: { type: 'integer' } }, required: ['topic'] }), 'topic');
    assert.equal(promptFieldOf({ properties: { n: { type: 'integer' } } }), null);
    assert.match(describeRule(app.flow[0]), /, adding to message what its boxes show; if it works, put \{\{json\.summary\}\} into summary;/);
    const [problems] = flowProblems(app.flow, {
        elements,
        servers: { 'https://acme-be.glean.com/mcp/default': { tools: [{ name: 'chat', inputSchema: { type: 'object', properties: { question: { type: 'string' } } } }] } },
    });
    assert.deepEqual(problems[1], ['chat has no field message for its prompt.']);
});

test('each box draws its piece of the answer, and says when it doesn\'t fit', () => {
    assert.equal(renderBox('text', 'On track <now>').html, '<p class="box-text">On track &lt;now&gt;</p>');
    assert.equal(renderBox('number', { value: 'At risk', note: 'Two blockers' }).html, '<div class="kpi"><span class="kpi-value">At risk</span><span class="kpi-note">Two blockers</span></div>');
    assert.equal(renderBox('number', 12.345).html, '<div class="kpi"><span class="kpi-value">12.35</span></div>');
    const list = renderBox('list', [{ title: 'Design', url: 'https://example.com/d', detail: 'Why' }, { name: 'Notes', link: 'javascript:alert(1)' }, 'Just text']).html;
    assert.equal(list, '<ul class="items"><li><a class="item-title" href="https://example.com/d">Design</a><span class="item-detail">Why</span></li><li><span class="item-title">Notes</span></li><li><span class="item-title">Just text</span></li></ul>');
    assert.equal(renderBox('table', { columns: ['A', 'B'], rows: [[1, 'x']] }).html, '<table class="table"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>x</td></tr></tbody></table>');
    assert.match(renderBox('table', [{ who: 'Ada', status: 'done' }, { who: 'Alan' }]).html, /<thead><tr><th>who<\/th><th>status<\/th><\/tr><\/thead><tbody><tr><td>Ada<\/td><td>done<\/td><\/tr><tr><td>Alan<\/td><td><\/td><\/tr>/);
    const bars = renderBox('bar', { labels: ['Jul', 'Aug', 'Sep'], values: [2, '4', 1] }).html;
    assert.deepEqual([...bars.matchAll(/height: ([\d.]+)%/g)].map(match => Number(match[1])), [42.5, 85, 21.3]);
    assert.match(bars, /aria-label="Jul: 2, Aug: 4, Sep: 1"/);
    assert.match(renderBox('bar', [{ label: 'a', value: 1 }, { label: 'b', value: 3 }]).html, /<span title="b">b<\/span>/);
    assert.match(renderBox('bar', { Mon: 1, Tue: 2 }).html, /<span title="Tue">Tue<\/span>/);
    assert.match(renderBox('line', { labels: ['a', 'b', 'c'], values: [1, 3, 2] }).html, /<polyline points="0,95 50,5 100,50"\/>/);
    const weeks = Array.from({ length: 8 }, (_, index) => `Week ${index + 1}`);
    assert.deepEqual([...renderBox('line', { labels: weeks, values: [1, 2, 3, 4, 5, 6, 7, 8] }).html.matchAll(/<span title="[^"]+">([^<]*)<\/span>/g)].map(match => match[1]),
        ['Week 1', '', 'Week 3', '', 'Week 5', '', 'Week 7', ''], 'eight labels show every other one');
    assert.equal(renderBox('html', '<b>hi</b>').html, '<b>hi</b>');
    for (const [kind, value, problem] of [
        ['bar', 'twelve', 'A chart takes {"labels": [...], "values": [...]}.'],
        ['bar', { labels: ['a'], values: ['many'] }, 'A chart takes numbers in "values".'],
        ['list', { text: 'no items' }, 'A list takes [{"title": ..., "detail": ..., "url": ...}].'],
        ['number', { note: 'no value' }, 'A number takes {"value": ..., "note": ...}, or a number.'],
        ['table', 'rows?', 'A table takes {"columns": [...], "rows": [[...]]}.'],
        ['html', { html: 'x' }, 'An HTML box takes a string of HTML.'],
    ]) {
        assert.deepEqual(renderBox(kind, value), { html: `<p class="box-problem">${problem.replace(/"/g, '&quot;')}</p>`, problem }, `${kind}: ${JSON.stringify(value)}`);
    }
    assert.deepEqual(renderBox('list', null), { html: '<p class="box-none">Nothing for this.</p>', problem: null });
    assert.equal(renderBox('list', []).html, '<p class="box-none">Nothing for this.</p>');
});

test('a dashboard comes back the same from its DML, and its boxes ask in the prompt argument', () => {
    const app = dashboard();
    const dml = toDml(app);
    assert.match(dml, /<screen src="index.html" built-from="components" size="wide">/);
    assert.match(dml, /<output id="activity" label="Activity" show="bar" width="two-thirds">Updates per week, the last 6 weeks<\/output>/);
    assert.match(dml, /<output id="plain" label="Plain"\/>/);
    assert.match(dml, /<arg name="message" role="prompt">What's the latest on \{\{project\}\}\?<\/arg>/);
    assert.match(dml, /<button id="refresh" label="Refresh" width="third"\/>/);
    const back = fromDml(dml).app;
    assert.deepEqual(withoutRuleIds(back), withoutRuleIds(app));
    const html = componentsHtml(app.screen.components, { title: app.name, size: 'wide' });
    assert.match(html, /<main class="app app-wide">/);
    assert.match(html, /<div class="field w-two-thirds">/);
    assert.match(html, /<button id="refresh" type="button" class="w-third">Refresh<\/button>/);
    assert.match(html, /<div id="activity" class="output box box-bar"/);
    assert.match(html, /<div id="plain" class="output" /);
    const broken = (find, replace) => () => fromDml(dml.replace(find, replace));
    assert.throws(broken('show="bar"', 'show="pie"'), /show="pie" isn't one of text, number, list, table, bar, line, html, conversation\./);
    assert.throws(broken('width="third"', 'width="quarter"'), /width="quarter" isn't one of full, two-thirds, half, third\./);
    assert.throws(broken('size="wide"', 'size="huge"'), /size="huge" is narrow or wide\./);
    assert.throws(broken('role="prompt"', 'role="question"'), /role="question" isn't one an <arg> has/);
    assert.throws(broken('<arg name="_user_goal">', '<arg name="_user_goal" role="prompt">'), /Only one <arg> of a call is its prompt\./);
});

test('wiring an answer to a box gives it its key, and renaming the box takes the key along', () => {
    const app = dashboard();
    const rule = { ...app.flow[0], then: [] };
    const asked = ({ element, phase, rule: wired }) => (phase === 'ok' && wired.prompt ? `{{json.${element.replace(/\./g, '_')}}}` : null);
    const { flow } = connect([rule], 'ok:rule-pulse', 'el:docs', { defaultShow: asked });
    assert.deepEqual(flow[0].then, [{ if: 'ok', show: '{{json.docs}}', into: 'docs', how: 'replace' }]);
    assert.equal(connect([rule], 'err:rule-pulse', 'el:docs', { defaultShow: asked }).flow[0].then[0].show, '{{error}}');
    assert.equal(connect([{ ...rule, prompt: undefined }], 'ok:rule-pulse', 'el:docs', { defaultShow: asked }).flow[0].then[0].show, '{{text}}');
    const [renamed] = renameInFlow(app.flow, 'docs', 'reading');
    assert.deepEqual(renamed.then.find(route => route.into === 'reading'), { if: 'ok', show: '{{json.reading}}', into: 'reading', how: 'replace' });
    assert.equal(renamed.then.find(route => route.into === 'summary').show, '{{json.summary}}');
});

test('the Project pulse example asks the model: Glean when you have it, else a chat tool, unless you chose one', () => {
    const chat = { name: 'chat', inputSchema: { type: 'object', properties: { _user_goal: { type: 'string' }, message: { type: 'string' }, context: { type: 'array', items: { type: 'string' } } }, required: ['message', '_user_goal'] } };
    const workbench = { testDataFor: () => ({ args: { _user_goal: 'test', message: 'test' } }) };
    const glean = 'https://acme-be.glean.com/mcp/default';
    const servers = { [MOCK]: { url: MOCK, tools: [chat] }, [glean]: { url: glean, tools: [chat] } };
    assert.deepEqual(foundModel(servers), { serverUrl: glean, toolName: 'chat', messageField: 'message', conversationField: 'context' });
    assert.equal(foundModel({ [MOCK]: { url: MOCK, tools: [{ name: 'echo' }] } }), null);
    const fromGlean = dashboardApp({ shell: { servers }, workbench, model: foundModel(servers), name: 'Project pulse' });
    const [rule] = fromGlean.flow;
    assert.equal(fromGlean.screen.size, 'wide');
    assert.deepEqual({ serverUrl: rule.call.serverUrl, toolName: rule.call.toolName, prompt: rule.prompt }, { serverUrl: glean, toolName: 'chat', prompt: 'message' });
    assert.deepEqual(rule.call.args, { _user_goal: "What's the latest on {{project}}?", message: "What's the latest on {{project}}? Use what you find in our documents, messages and tickets." });
    assert.deepEqual(rule.when.map(trigger => trigger.event), ['open', 'click', 'enter']);
    const elements = elementsOfComponents(fromGlean.screen.components);
    assert.deepEqual(asksOf(rule, elements).map(ask => `${ask.key}:${ask.kind}`), ['summary:text', 'health:number', 'activity:bar', 'risks:list', 'docs:list']);
    assert.match(fromGlean.screen.components.find(component => component.id === 'intro').text, /from one question to Glean:/);
    const chosen = { serverUrl: MOCK, toolName: 'chat', messageField: 'message', conversationField: 'context' };
    const fromModel = dashboardApp({ shell: { servers: { [MOCK]: { url: MOCK, alias: 'Mock', tools: [chat] } } }, workbench, model: chosen, name: 'Project pulse' });
    assert.equal(fromModel.flow[0].call.serverUrl, MOCK);
    assert.deepEqual(fromModel.flow[0].call.args, rule.call.args, 'a dashboard sends no conversation');
    assert.match(fromModel.screen.components.find(component => component.id === 'intro').text, /from one question to chat on Mock:/);
    const nothing = dashboardApp({ shell: { servers: {} }, workbench, model: null, name: 'Project pulse' });
    assert.deepEqual([nothing.flow[0].call.toolName, nothing.flow[0].prompt], ['', undefined]);
    assert.match(nothing.screen.components.find(component => component.id === 'intro').text, /from one question to a model:/);
});

// The Chat example's rule, as chatApp() makes it for the mock's chat.
function chatExample() {
    const chat = { name: 'chat', inputSchema: { type: 'object', properties: { message: { type: 'string' }, history: { type: 'array', items: { type: 'string' } } }, required: ['message'] } };
    const servers = { [MOCK]: { url: MOCK, alias: 'Mock', status: 'connected', tools: [chat] } };
    return { servers, app: chatApp({ shell: { servers }, workbench: { testDataFor: () => ({ args: { message: 'test' } }) }, model: foundModel(servers), name: 'Chat' }) };
}

test('the Chat example is an app like any other: a conversation, a message and Send, and one rule to the model', () => {
    const { servers, app } = chatExample();
    const [rule] = app.flow;
    assert.deepEqual(rule.call, { serverUrl: MOCK, toolName: 'chat', args: { message: '{{message}}', history: '{{conversation}}' } });
    assert.deepEqual([rule.prompt, rule.tools], ['message', true]);
    assert.match(rule.instructions, /^You're the assistant in a chat app built with MCP Browser Client/);
    assert.equal(describeRule(rule, { serverName: () => 'Mock' }),
        "When send is clicked or message gets Enter, call chat on Mock with message = {{message}}, history = {{conversation}}, adding to message its instructions and your servers' tools; "
        + "as it's sent, put {{message}} into conversation after what it shows; as it's sent, put nothing (clearing it) into message; "
        + 'if it works, put {{text}} into conversation after what it shows; if it fails, put {{error}} into conversation after what it shows.');
    const elements = elementsOfComponents(app.screen.components);
    const ids = elements.map(element => element.id);
    assert.deepEqual(ids, ['title', 'intro', 'conversation', 'message', 'send']);
    assert.match(app.screen.components[1].text, /^A conversation with chat on Mock, which can call your servers' tools\./);
    const conversation = elements.find(element => element.id === 'conversation');
    assert.deepEqual([isConversation(conversation), isBox(conversation)], [true, false]);
    assert.deepEqual(asksOf(rule, elements), [], 'a conversation asks for nothing in the prompt');
    assert.deepEqual(frameConfig(app.flow, ids).read.sort(), ['conversation', 'message']);
    assert.deepEqual(flowProblems(app.flow, { elements, servers }), [[rule.id, []]]);
    assert.deepEqual(wiresOf(app.flow, ids).map(wire => `${wire.kind} ${wire.from.split(':')[0]} ${wire.to.replace(rule.id, 'rule')}`), [
        'trigger el run:rule',
        'trigger el run:rule',
        'arg el arg:rule:message',
        'arg el arg:rule:history',
        'sent sent el:conversation',
        'sent sent el:message',
        'answer ok el:conversation',
        'error err el:conversation',
    ]);
    assert.match(componentsHtml(app.screen.components), /<div id="conversation" class="output box box-conversation" aria-label="Conversation" aria-live="polite" data-placeholder="Say something to start\."><\/div>/);

    const glean = 'https://acme-be.glean.com/mcp/default';
    const gleanChat = { name: 'chat', inputSchema: { type: 'object', properties: { _user_goal: { type: 'string' }, message: { type: 'string' }, context: { type: 'array', items: { type: 'string' } } }, required: ['message', '_user_goal'] } };
    const gleanServers = { [glean]: { url: glean, tools: [gleanChat] } };
    const withGlean = chatApp({ shell: { servers: gleanServers }, workbench: null, model: foundModel(gleanServers), name: 'Chat' });
    assert.deepEqual(withGlean.flow[0].call.args, { _user_goal: '{{message}}', context: '{{conversation}}', message: '{{message}}' }, "Glean gets the person's own words as the goal, and the conversation as context");
    assert.match(withGlean.screen.components[1].text, /^A conversation with Glean,/);
});

test('the Chat example comes back the same from its DML: its instructions, tools="yes" and routes as it\'s sent', () => {
    const { app } = chatExample();
    const dml = toDml(app);
    assert.match(dml, /<output id="conversation" label="Conversation" placeholder="Say something to start\." show="conversation"\/>/);
    assert.match(dml, /<when element="send" event="click" tools="yes">\n {6}<or element="message" event="enter"\/>\n {6}<instructions>You're the assistant in a chat app/);
    assert.match(dml, /<arg name="message" role="prompt">\{\{message\}\}<\/arg>\n {8}<arg name="history">\{\{conversation\}\}<\/arg>/);
    assert.match(dml, /<then if="sent" into="conversation" how="append">\{\{message\}\}<\/then>\n {6}<then if="sent" into="message"><\/then>/);
    const back = fromDml(dml).app;
    assert.deepEqual(withoutRuleIds(back).flow, withoutRuleIds(app).flow);
    assert.equal(toDml(back), dml);
    const broken = (find, replace) => () => fromDml(dml.replace(find, replace));
    assert.throws(broken('tools="yes"', 'tools="no"'), /tools="no" is yes, or left out\./);
    assert.throws(broken('if="sent" into="message"', 'if="later" into="message"'), /if="later" has to be ok, error or sent\./);
    const [[, problems]] = flowProblems([{ ...app.flow[0], prompt: undefined }], { elements: elementsOfComponents(app.screen.components) });
    assert.ok(problems.includes('Choose the field its prompt goes in: its instructions and the tools go there.'), problems.join(' '));
});

test("a model that may call tools is told which there are, never a server's credentials, and its calls are read from its answer", () => {
    const echo = { name: 'echo', description: 'Echoes back the input text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
    const servers = {
        [MOCK]: { url: MOCK, alias: 'Mock', bearerToken: 'smoke-secret-token', status: 'connected', tools: [echo] },
        'https://idle.example/mcp': { url: 'https://idle.example/mcp', name: 'Idle', status: 'unknown', tools: [echo] },
        'https://empty.example/mcp': { url: 'https://empty.example/mcp', tools: [] },
    };
    assert.deepEqual(toolsForModel(servers), [
        { server: 'Mock', url: MOCK, tools: [echo] },
        { server: 'Idle', url: 'https://idle.example/mcp', tools: [echo] },
    ]);
    const prompt = composePrompt('  call echo with hi  ', { instructions: 'Be brief.', servers, request: 'Answer in JSON.' });
    assert.ok(prompt.startsWith(`Be brief.\n\n${TOOLS_INSTRUCTIONS}\n\nThe tools, by server:\n\n\`\`\`json\n[{"server":"Mock","url":"${MOCK}","tools":[{"name":"echo"`), prompt.slice(0, 200));
    assert.ok(prompt.endsWith('```\n\ncall echo with hi\n\nAnswer in JSON.'), prompt.slice(-80));
    assert.doesNotMatch(prompt, /smoke-secret-token|bearerToken/);
    assert.equal(composePrompt('hi'), 'hi');
    assert.equal(composePrompt(undefined, { instructions: '  Only these.  ' }), 'Only these.');

    const answer = 'Asking.\n\n```json\n{"jsonrpc": "2.0", "method": "echo", "params": {"text": "hi"}, "id": 1}\n```\n'
        + 'And:\n```\n{\\"jsonrpc\\": \\"2.0\\", \\"method\\": \\"count\\", \\"id\\": 2}\n```\n```json\n{"not": "a call"}\n```';
    assert.deepEqual(toolCallsIn(answer).map(call => [call.method, call.params]), [['echo', { text: 'hi' }], ['count', undefined]]);
    assert.deepEqual(toolCallsIn('No code here.'), []);
    // Glean's chat, asked with this prompt, writes the call, then the conversation's details.
    const fromGlean = '```json\n{"jsonrpc":"2.0","method":"ticket","params":{"prefix":"SUP-"},"id":1}\n```\n\n---\nchatId: 0d6c5e1f\nchatSessionTrackingToken: KiIS\nmessages[2]:\n  -\n    ts: "2026-10-10"';
    const answered = answerOf({ result: { content: [{ type: 'text', text: fromGlean }] } }).values.text;
    assert.equal(answered, '```json\n{"jsonrpc":"2.0","method":"ticket","params":{"prefix":"SUP-"},"id":1}\n```', 'an answer is shown and sent back without them');
    assert.deepEqual(toolCallsIn(answered), [{ jsonrpc: '2.0', method: 'ticket', params: { prefix: 'SUP-' }, id: 1 }]);
    assert.equal(answerText('Before\n\n---\n\nA rule, then more.'), 'Before\n\n---\n\nA rule, then more.', 'a rule in the answer itself stays');
    assert.equal(serverWithTool(servers, 'echo').server.url, MOCK, 'a connected server first');
    assert.equal(serverWithTool(servers, 'nothing'), null);

    let times = [];
    const allowed = [0, 1, 2, 3].map(n => {
        const next = allowedCall(times, 1_000 + n);
        times = next.times;
        return next.allowed;
    });
    assert.deepEqual(allowed, [true, true, true, false], 'three calls in 10 seconds, then none');
    assert.equal(allowedCall(times, 1_003 + REPLY_CALLS.withinMs).allowed, true, 'and after 10 seconds, again');

    assert.equal(conversationFieldOf({ properties: { message: { type: 'string' }, context: { type: 'array', items: { type: 'string' } } } }), 'context');
    assert.equal(conversationFieldOf({ properties: { history: { type: 'array' } } }), 'history');
    assert.equal(conversationFieldOf({ properties: { tags: { type: 'array', items: { type: 'string' } }, history: { type: 'string' } } }), null);
    assert.equal(conversationFieldOf(null), null);
});

test("a conversation's value is its entries, which a list field takes as they are and a text field a line each", () => {
    const history = ['User: hi', 'Assistant: You said: hi', 'Tool: echo: Echo: hi'];
    const schema = { type: 'object', properties: { history: { type: 'array', items: { type: 'string' } }, message: { type: 'string' }, note: { type: 'string' } } };
    const { sentArgs } = callArguments({ args: { history: '{{conversation}}', message: 'Before: {{conversation}}', note: '{{conversation}}' } }, { screen: { conversation: history }, schema });
    assert.deepEqual(sentArgs, { history, message: `Before: ${history.join('\n')}`, note: history.join('\n') });
    assert.deepEqual(callArguments({ args: { history: '{{conversation}}' } }, { screen: { conversation: [] }, schema }).sentArgs, { history: [] });
});

test("a Sent wire is a route as it's sent: what the call sends goes to the screen before there's an answer", () => {
    const { app } = chatExample();
    const rule = { ...app.flow[0], then: [] };
    const kindOf = id => ({ conversation: 'output', message: 'input' })[id];
    let { flow, made } = connect([rule], `sent:${rule.id}`, 'el:conversation', { kindOf, defaultShow: ({ phase }) => (phase === 'sent' ? '{{message}}' : null) });
    assert.equal(made.kind, 'route');
    assert.deepEqual(flow[0].then, [{ if: 'sent', show: '{{message}}', into: 'conversation', how: 'replace' }]);
    ({ flow } = connect(flow, 'el:message', `sent:${rule.id}`, { kindOf }));
    assert.deepEqual(flow[0].then[1], { if: 'sent', show: '', into: 'message', how: 'replace' }, 'without a default, a Sent wire clears what it goes to');
    assert.equal(connect(flow, `sent:${rule.id}`, 'el:message', { kindOf }).made.kind, 'already');
    ({ flow } = connect(flow, `ok:${rule.id}`, 'el:conversation', { kindOf }));
    assert.deepEqual(flow[0].then.map(route => route.if), ['sent', 'sent', 'ok'], 'an answer to the same place is a route of its own');
    assert.throws(() => connect(flow, `sent:${rule.id}`, `run:${rule.id}`, { kindOf }), /A tool's Sent goes to the screen/);
    assert.equal(routeSummary({ if: 'sent', show: '' }), 'nothing');
    assert.deepEqual(disconnect(flow, wiresOf(flow, ['conversation', 'message']).find(wire => wire.kind === 'sent' && wire.element === 'message'))[0].then.map(route => `${route.if} ${route.into}`), ['sent conversation', 'ok conversation']);
});
