// The server guide (public/server-template/README.md) as the site renders it
// (public/server-template/markdown.js): its links lead somewhere, its tables have every cell,
// and no Markdown is left over. The same checks keep it right on GitHub, which splits table
// cells the same way.
//
//   node --test tests/server-guide.test.mjs    (npm run test:unit)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inline, renderMarkdown, slug, tableCells, textOf } from '../public/server-template/markdown.js';

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
