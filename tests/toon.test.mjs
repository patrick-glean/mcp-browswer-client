// The TOON decoder (public/apps/toon.js), which reads the listing Glean's MCP server puts before
// what it found: the forms the spec has, and the slips that have to fail rather than change the data.
//
//   node --test "tests/*.test.mjs"    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeToon } from '../public/apps/toon.js';

test('TOON: objects, nested ones, and values as JSON has them', () => {
    assert.deepEqual(decodeToon('name: Ada Lovelace\nage: 36\nscore: -1.5e2\nactive: true\nleft: null\nid: "42"\nnote: "a: b, \\"c\\"\\n\\td\\u00e9"\nversion: 05'), {
        name: 'Ada Lovelace', age: 36, score: -150, active: true, left: null, id: '42', note: 'a: b, "c"\n\tdé', version: '05',
    });
    assert.deepEqual(decodeToon('user:\n  name: Ada\n  address:\n    city: London\nempty:\ntags: []'), { user: { name: 'Ada', address: { city: 'London' } }, empty: {}, tags: [] });
    assert.deepEqual(decodeToon('"my key": 1\nuser.name: 2\ntitle: Plan: draft, v2'), { 'my key': 1, 'user.name': 2, title: 'Plan: draft, v2' }, 'a dotted key is one key; a value runs to the end of the line');
    assert.deepEqual(decodeToon('\uFEFFa: 1\r\n\r\n# a comment\r\nb: 2\r\n'), { a: 1, b: 2 }, 'a byte-order mark, CRLF, blank lines and comments');
    assert.deepEqual(decodeToon(''), {});
    assert.deepEqual(decodeToon('hello'), 'hello', 'a document of one value is that value');
    assert.equal(Object.getPrototypeOf(decodeToon('__proto__: 1')), Object.prototype, 'a key named __proto__ is just a key');
    assert.deepEqual(Object.keys(decodeToon('__proto__: 1')), ['__proto__']);
});

test('TOON: arrays inline, as tables and as lists, at the root too', () => {
    assert.deepEqual(decodeToon('tags[3]: a,"b,c", d \nnums[2|]: 1|2\ntabbed[2\t]: x\ty\nnone[0]:'), { tags: ['a', 'b,c', 'd'], nums: [1, 2], tabbed: ['x', 'y'], none: [] });
    assert.deepEqual(decodeToon('users[2]{id,name}:\n  1,Ada\n  2,"Lovelace, Ada"\ncount: 2'), { users: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lovelace, Ada' }], count: 2 }, 'a field after the rows ends them');
    assert.deepEqual(decodeToon('items[4]:\n  - 1\n  - a: 1\n    b[2]: x,y\n  - [2]: 3,4\n  -'), { items: [1, { a: 1, b: ['x', 'y'] }, [3, 4], {}] });
    assert.deepEqual(decodeToon('items[1]:\n  - tags[2]:\n      - x\n      - y\n    name: n\n  '), { items: [{ tags: ['x', 'y'], name: 'n' }] }, "what an item's first field opens is a level below its other fields");
    assert.deepEqual(decodeToon('items[1]:\n  - rows[2]{a}:\n      1\n      2\n    after: true'), { items: [{ rows: [{ a: 1 }, { a: 2 }], after: true }] });
    assert.deepEqual(decodeToon('pairs[2]:\n  - [2]: 1,2\n  - []'), { pairs: [[1, 2], []] });
    assert.deepEqual(decodeToon('[2]: a,b'), ['a', 'b']);
    assert.deepEqual(decodeToon('[2]{x}:\n  1\n  2'), [{ x: 1 }, { x: 2 }]);
    assert.deepEqual(decodeToon('[]'), []);
});

test("TOON: Glean's listing of what it read, and the call's ID", () => {
    const listing = 'documents[1]:\n  - artifactId: 0f3a\n    docType: PAPER\n    glean_doc_id: ARTIFACTS_paper_0f3a\n    snippets[1]: "# Plan\\n\\n| Step | Who |\\n| --- | --- |\\n| Ship | [Ada](https://example.com) |"\n    title: Plan.md\n    url: "https://app.glean.com/library/0f3a"';
    assert.deepEqual(decodeToon(`${listing}\nglean_invocation_id: 0d0e6a3c-2b0e-4d6e-9a59-7f1d3c2b1a00`), {
        documents: [{ artifactId: '0f3a', docType: 'PAPER', glean_doc_id: 'ARTIFACTS_paper_0f3a', snippets: ['# Plan\n\n| Step | Who |\n| --- | --- |\n| Ship | [Ada](https://example.com) |'], title: 'Plan.md', url: 'https://app.glean.com/library/0f3a' }],
        glean_invocation_id: '0d0e6a3c-2b0e-4d6e-9a59-7f1d3c2b1a00',
    });
    assert.deepEqual(decodeToon('documents[2]{isAiGenerated}:\n  true\n  false'), { documents: [{ isAiGenerated: true }, { isAiGenerated: false }] }, 'the table after its search results');
});

test("TOON: what would change the data throws, as do the forms it doesn't read", () => {
    const fails = (text, message) => assert.throws(() => decodeToon(text), SyntaxError, message);
    fails('tags[3]: a,b', 'an inline count that is off');
    fails('users[2]{id,name}:\n  1,Ada', 'a table short of rows');
    fails('users[1]{id,name}:\n  1', 'a row short of cells');
    fails('items[1]:\n  - a\n  - b', 'a list with an item too many');
    fails('a:\n   b: 1', 'an indent of three spaces');
    fails('a:\n\tb: 1', 'a tab for an indent');
    fails('a:\n    b: 1', 'a level skipped');
    fails('a: "x\\q"', "an escape TOON doesn't have");
    fails('a: "\\ud83d"', 'a surrogate escape');
    fails('a: "open', 'a string without its closing quote');
    fails('a: "x" y', 'text after a closing quote');
    fails('a: 1\na: 2', 'a key given twice');
    fails('- a', 'a list item outside a list');
    fails('a: 1\nloose', 'a value without a key');
    fails('a [2]: 1,2', 'a space before the [');
    fails('a[02]: 1,2', 'a count with a leading zero');
    fails('[2]: a,b\nc: 1', 'more after a root array');
    fails('people[2:]{name}:\n  ada: Ada\n  bob: Bob', 'a keyed table');
    fails('rows[1]{a,b{c}}:\n  1,2', 'nested fields');
    fails('  a: 1', 'a first line indented');
});
