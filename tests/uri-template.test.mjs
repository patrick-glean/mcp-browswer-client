// Resource templates' URIs (public/workbench/uri-template.js), against RFC 6570's examples.
//
//   node --test tests/    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandTemplate, templateVariables } from '../public/workbench/uri-template.js';

const values = { var: 'value', hello: 'Hello World!', path: '/foo/bar', x: '1024', y: '768', empty: '' };

test('each operator expands as RFC 6570 says', () => {
    const cases = [
        ['{var}', 'value'],
        ['{hello}', 'Hello%20World%21'],
        ['{+hello}', 'Hello%20World!'],
        ['{+path}/here', '/foo/bar/here'],
        ['{#path}', '#/foo/bar'],
        ['map?{x,y}', 'map?1024,768'],
        ['X{.var}', 'X.value'],
        ['{/var,x}/here', '/value/1024/here'],
        ['{;x,y}', ';x=1024;y=768'],
        ['{?x,y}', '?x=1024&y=768'],
        ['?fixed=yes{&x}', '?fixed=yes&x=1024'],
        ['{var:3}', 'val'],
    ];
    for (const [template, expected] of cases) assert.equal(expandTemplate(template, values), expected, template);
});

test('variables without a value are left out', () => {
    assert.equal(expandTemplate('{?x,missing,empty}', values), '?x=1024');
    assert.equal(expandTemplate('mock://notes/{id}', {}), 'mock://notes/');
});

test('a template names its variables once each, in order', () => {
    assert.deepEqual(templateVariables('repo://{owner}/{repo}/issues{/number}{?state,owner}'), ['owner', 'repo', 'number', 'state']);
    assert.deepEqual(templateVariables('mock://readme'), []);
});
