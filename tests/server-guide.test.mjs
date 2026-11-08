// The server guide (public/server-template/README.md) as the site renders it (public/markdown.js):
// its links lead somewhere, its tables have every cell, and no Markdown is left over. The same
// checks keep it right on GitHub, which splits table cells the same way. And the renderer itself,
// which also draws the documents an app's screen shows.
//
//   node --test tests/server-guide.test.mjs    (npm run test:unit)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inline, renderMarkdown, slug, tableCells, textOf } from '../public/markdown.js';

const FOLDER = new URL('../public/server-template/', import.meta.url);
const guide = readFileSync(new URL('README.md', FOLDER), 'utf8');

test('slugs are the anchors GitHub gives headings', () => {
    assert.equal(slug('What every 2026-07-28 result carries'), 'what-every-2026-07-28-result-carries');
    assert.equal(slug('A model for the Chat app'), 'a-model-for-the-chat-app');
    assert.equal(slug("What the client tells your server"), 'what-the-client-tells-your-server');
    assert.equal(slug('Tools, resources & prompts'), 'tools-resources--prompts');
});

test('inline Markdown: code first, then links, bold and italics, with HTML escaped', () => {
    assert.equal(inline('Use `a | b` and **bold `x`**'), 'Use <code>a | b</code> and <strong>bold <code>x</code></strong>');
    assert.equal(inline('[`example.json`](example.json)'), '<a href="example.json"><code>example.json</code></a>');
    assert.equal(inline('<img src=x onerror=alert(1)> *em*'), '&lt;img src=x onerror=alert(1)&gt; <em>em</em>');
    assert.equal(inline('snake_case stays, and so does `*`'), 'snake_case stays, and so does <code>*</code>');
    assert.equal(textOf(inline('`serverInfo.title`')), 'serverInfo.title');
});

test('inline Markdown: images as links, bare addresses, strikethrough, underscores and <br>', () => {
    assert.equal(inline('![The chart](https://example.com/c.png)'), '<a href="https://example.com/c.png" class="md-image">The chart</a>');
    assert.equal(inline('See https://example.com/a_b, then (https://example.com/x).'), 'See <a href="https://example.com/a_b">https://example.com/a_b</a>, then (<a href="https://example.com/x">https://example.com/x</a>).');
    assert.equal(inline('[https://example.com](https://example.com)'), '<a href="https://example.com">https://example.com</a>');
    assert.equal(inline('~~gone~~, _this_ and __that__, but not snake_case_names'), '<del>gone</del>, <em>this</em> and <strong>that</strong>, but not snake_case_names');
    assert.equal(inline('*a **b** c* and a<br>b <br/> c'), '<em>a <strong>b</strong> c</em> and a<br>b <br> c');
    assert.equal(inline('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
});

test('blocks: rules, nested lists, numbered lists that carry on after a blank line, and headings without anchors', () => {
    assert.equal(renderMarkdown('a\n\n---\n\n* * *').html, '<p>a</p>\n<hr>\n<hr>');
    assert.equal(renderMarkdown('- one\n  - one a\n    - deeper\n  - one b\n- two').html,
        '<ul><li>one<ul><li>one a<ul><li>deeper</li></ul></li><li>one b</li></ul></li><li>two</li></ul>');
    assert.equal(renderMarkdown('1. first\n\n2. second\n\n   more about it\n\nAfter.').html, '<ol><li>first</li><li>second more about it</li></ol>\n<p>After.</p>');
    assert.equal(renderMarkdown('3. three\n4. four').html, '<ol start="3"><li>three</li><li>four</li></ol>');
    assert.equal(renderMarkdown('- [x] done\n  - [ ] part').html, '<ul><li class="md-task"><input type="checkbox" disabled checked> done<ul><li class="md-task"><input type="checkbox" disabled> part</li></ul></li></ul>');
    const { html, headings } = renderMarkdown('# Plan\n## Plan', { anchors: false });
    assert.equal(html, '<h1>Plan</h1>\n<h2>Plan</h2>');
    assert.deepEqual(headings.map(heading => heading.text), ['Plan', 'Plan']);
    assert.equal(renderMarkdown('# Plan').html, '<h1 id="plan">Plan</h1>');
});

test('tables split their cells on every unescaped pipe, as GitHub does', () => {
    assert.deepEqual(tableCells('| a | `b` | c \\| d |'), ['a', '`b`', 'c \\| d']);
    const { html } = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done\n- [ ] not yet');
    assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
    assert.match(html, /<li class="md-task"><input type="checkbox" disabled checked> done<\/li>/);
});

test("the guide's links all lead somewhere: its own sections, or files in the repo", () => {
    const links = [];
    const { headings } = renderMarkdown(guide, { link: href => { links.push(href); return { href }; } });
    const ids = new Set(headings.map(heading => heading.id));
    assert.ok(links.length >= 4, `${links.length} links`);
    for (const href of links) {
        if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
        if (href.startsWith('#')) {
            assert.ok(ids.has(href.slice(1)), `no heading for ${href}`);
            continue;
        }
        const [path, anchor] = href.split('#');
        const file = new URL(path, FOLDER);
        assert.ok(existsSync(fileURLToPath(file)), `${href} doesn't exist`);
        if (anchor && path.endsWith('.md')) {
            const other = renderMarkdown(readFileSync(file, 'utf8')).headings.map(heading => heading.id);
            assert.ok(other.includes(anchor), `${path} has no heading #${anchor}`);
        }
    }
});

test("the guide's tables have every cell, and no Markdown is left over once it's rendered", () => {
    const lines = guide.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        if (!/^\|.*\|$/.test(lines[i]) || !/^\|\s*-{3,}/.test(lines[i + 1])) continue;
        const columns = tableCells(lines[i]).length;
        for (let row = i + 2; row < lines.length && /^\|.*\|$/.test(lines[row]); row++) {
            assert.equal(tableCells(lines[row]).length, columns, `line ${row + 1} has ${tableCells(lines[row]).length} cells, its table ${columns}`);
        }
    }
    const { html, headings } = renderMarkdown(guide);
    assert.equal(headings[0].level, 1);
    assert.ok(html.includes('<table>') && html.includes('<pre class="md-code" data-language="json">') && html.includes('class="md-task"'));
    const text = textOf(html.replace(/<code>[\s\S]*?<\/code>/g, ''));
    for (const leftover of ['**', '](', '```', '| ---']) assert.ok(!text.includes(leftover), `"${leftover}" left in the rendered guide`);
});
