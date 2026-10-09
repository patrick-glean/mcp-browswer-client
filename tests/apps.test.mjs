// The app builder's pure parts (public/apps/): the flow's templates and arguments, the screen's
// HTML, the DML an app is written down in, and the zip it downloads as.
//
//   node --test "tests/*.test.mjs"    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { DmlError, fromDml, parseXml, serversOf, toDml } from '../public/apps/dml.js';
import {
    answerOf, callArguments, describeRule, elementIdProblem, flowProblems, frameConfig, newRule, renameInFlow, renderTemplate, rulesFor,
} from '../public/apps/flow.js';
import { componentsHtml, elementsOfComponents, freeId, htmlFromResult, newComponent } from '../public/apps/screen.js';
import { crc32, unzip, zip } from '../public/apps/zip.js';

const MOCK = 'http://127.0.0.1:8081/';
const withoutRuleIds = app => ({ ...app, flow: app.flow.map(({ id, ...rule }) => rule) });

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
            ],
        },
        flow: [
            {
                id: 'rule-a',
                when: { element: 'ask', event: 'click' },
                call: { serverUrl: MOCK, toolName: 'search_notes', args: { query: '{{question}}', limit: 5, include_archived: false, tags: ['a', 'b&c'], snippet: { length: 200 }, nothing: null } },
                then: [
                    { if: 'ok', show: 'Found: {{text}}', into: 'answer', how: 'replace' },
                    { if: 'ok', show: '', into: 'question', how: 'replace' },
                    { if: 'error', show: '{{error}}', into: 'answer', how: 'append' },
                ],
            },
            {
                id: 'rule-b',
                when: { element: '', event: 'open' },
                call: { serverUrl: MOCK, toolName: 'echo', args: { text: 'hello <world> & "you"' } },
                then: [{ if: 'ok', show: '<em>{{text}}</em>', into: 'note', how: 'html' }],
            },
        ],
    };
}

test('an app built from components comes back the same from its DML', () => {
    const app = sampleApp();
    const dml = toDml(app, { serverNames: { [MOCK]: 'Mock server' } });
    const { app: back, servers } = fromDml(dml);
    assert.deepEqual(withoutRuleIds(back), withoutRuleIds(app));
    assert.deepEqual(servers, [{ url: MOCK, name: 'Mock server' }]);
    assert.ok(back.flow.every(rule => /^rule-/.test(rule.id)), 'imported rules get ids');
});

test('the DML reads like the flow it describes', () => {
    const dml = toDml(sampleApp());
    assert.match(dml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!--/);
    assert.match(dml, /<app dml="1" id="app-1" name="Ask &amp; answer &lt;test&gt;" version="3">/);
    assert.match(dml, /<screen src="index\.html" built-from="components">/);
    assert.match(dml, /<textbox id="details" label="Details" lines="4" value="first&#10;second"\/>/);
    assert.match(dml, /<when element="ask" event="click">\n {6}<call server="http:\/\/127\.0\.0\.1:8081\/" tool="search_notes">/);
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
    const inZip = toDml(app);
    assert.match(inZip, /<screen src="index\.html">\n {4}<from server="http:\/\/127\.0\.0\.1:8081\/" tool="make_screen">/);
    assert.doesNotMatch(inZip, /<html>/);
    assert.deepEqual(withoutRuleIds(fromDml(inZip, { files: { 'index.html': html } }).app), withoutRuleIds(app));
    assert.throws(() => fromDml(inZip), /The screen is in index\.html, which isn't with this file/);

    const alone = toDml(app, { standalone: true });
    assert.doesNotMatch(alone, /src=/);
    assert.match(alone, /<html>&lt;!DOCTYPE html&gt;/);
    assert.deepEqual(withoutRuleIds(fromDml(alone).app), withoutRuleIds(app));
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
    assert.equal(asked.when.element, 'go');
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
    assert.deepEqual([made.id, made.type, made.lines], ['input2', 'textbox', 1]);
});

test("the screen's runtime watches what rules wait for and reads what they use", () => {
    const app = sampleApp();
    const ids = elementsOfComponents(app.screen.components).map(element => element.id);
    assert.deepEqual(frameConfig(app.flow, ids), { watch: [{ element: 'ask', event: 'click' }], read: ['question'] });
    assert.deepEqual(rulesFor(app.flow, 'ask', 'click').map(rule => rule.id), ['rule-a']);
    assert.deepEqual(rulesFor(app.flow, '', 'open').map(rule => rule.id), ['rule-b']);
});

test('rules say what they do in a sentence, and what keeps them from running', () => {
    const app = sampleApp();
    const sentence = describeRule(app.flow[1], { serverName: () => 'Mock server' });
    assert.equal(sentence, 'When the app opens, call echo on Mock server with text = “hello <world> & "you"”; if it works, put “<em>{{text}}</em>” into note as HTML.');
    assert.equal(describeRule(app.flow[0]), 'When ask is clicked, call search_notes on http://127.0.0.1:8081/ with query = {{question}}, limit = 5, include_archived = false, tags = ["a","b&c"], snippet = {"length":200}, nothing = null; if it works, put “Found: {{text}}” into answer; if it works, put nothing (clearing it) into question; if it fails, put {{error}} into answer after what it shows.');
    const elements = elementsOfComponents(app.screen.components);
    const servers = { [MOCK]: { tools: [{ name: 'echo' }] } };
    const problems = Object.fromEntries(flowProblems(app.flow, { elements, servers }));
    assert.deepEqual(problems['rule-a'], ["search_notes isn't one of this server's tools."]);
    assert.deepEqual(problems['rule-b'], []);
    const [[, blank]] = flowProblems([newRule()], { elements, servers });
    assert.deepEqual(blank, ['Choose what it waits for.', 'Choose a server.', 'Choose where the answer goes.']);
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
    assert.deepEqual([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]), ['title', 'note', 'question', 'details', 'ask', 'answer'], 'only components have ids');
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
