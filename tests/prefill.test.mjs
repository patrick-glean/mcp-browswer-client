// Pre-fill's test data (public/workbench/prefill.js): generated values are valid for their schema,
// hints and staged variables come first, and a schema always gets the same values.
//
//   node --test tests/prefill.test.mjs    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { matchingVariable, testData } from '../public/workbench/prefill.js';
import { resolveArguments } from '../public/workbench/template.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

// Tool input schemas like the ones MCP servers publish, from plain to awkward.
const SCHEMAS = {
    'a search with limits': object({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query']),
    formats: object({
        email: { type: 'string', format: 'email' },
        homepage: { type: 'string', format: 'uri' },
        when: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
        id: { type: 'string', format: 'uuid' },
        address: { type: 'string', format: 'ipv4' },
    }),
    patterns: object({
        code: { type: 'string', pattern: '^[A-Z]{3}-\\d{2}$' },
        slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
        day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        scheme: { type: 'string', pattern: '^https?://' },
        hex: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    }),
    lengths: object({ long: { type: 'string', minLength: 12 }, short: { type: 'string', maxLength: 2 } }),
    numbers: object({
        minutes: { type: 'integer', minimum: 15, maximum: 120, multipleOf: 15 },
        ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
        negative: { type: 'integer', maximum: -5 },
        page: { type: 'integer', minimum: 1 },
    }),
    'enums and consts': object({ mode: { enum: ['fast', 'thorough'] }, maybe: { enum: [null, 'yes'] }, fixed: { const: 'v2' }, flag: { type: 'boolean' } }),
    arrays: object({
        tags: { type: 'array', items: { type: 'string' }, minItems: 2, uniqueItems: true },
        emails: { type: 'array', items: { type: 'string', format: 'email' } },
        pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] },
        choices: { type: 'array', items: { enum: ['a', 'b', 'c'] }, minItems: 3, uniqueItems: true },
    }),
    'nested objects': object({ filter: object({ owner: { type: 'string' }, since: { type: 'string', format: 'date' } }, ['owner']), options: { type: 'object' } }),
    'refs and combinators': {
        type: 'object',
        $defs: { repo: object({ owner: { type: 'string' }, name: { type: 'string', minLength: 1 } }) },
        properties: {
            repo: { $ref: '#/$defs/repo' },
            either: { anyOf: [{ type: 'null' }, { type: 'string', format: 'email' }] },
            both: { allOf: [object({ a: { type: 'string' } }), object({ b: { type: 'integer', minimum: 3 } })] },
        },
        required: ['repo', 'either', 'both'],
    },
    'one of two fields': { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string', format: 'uri' } }, anyOf: [{ required: ['id'] }, { required: ['url'] }] },
    recursive: {
        type: 'object',
        $defs: { node: object({ name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } }, ['name']) },
        properties: { tree: { $ref: '#/$defs/node' } },
        required: ['tree'],
    },
    'nullable types': object({ note: { type: ['string', 'null'] }, count: { type: ['null', 'integer'], minimum: 2 } }),
};

const problems = (schema, values) => {
    const validate = ajv.compile(schema);
    return validate(values) ? null : ajv.errorsText(validate.errors);
};

for (const [name, schema] of Object.entries(SCHEMAS)) {
    test(`${name}: the test data is valid for the schema`, () => {
        const { values } = testData(schema);
        assert.equal(problems(schema, values), null, JSON.stringify(values));
    });
    test(`${name}: also with every field filled`, () => {
        const { values } = testData(schema, { every: true });
        assert.equal(problems(schema, values), null, JSON.stringify(values));
    });
}

test('hints come first: const, staged variables, defaults, examples, then examples in descriptions', () => {
    const schema = object({
        fixed: { type: 'string', const: 'x' },
        repoName: { type: 'string', description: 'GitHub repository: owner/repo (e.g. "facebook/react")' },
        libraryName: { type: 'string', description: "Library name to search for, e.g. 'react'" },
        limit: { type: 'integer', default: 7 },
        text: { type: 'string', examples: ['hello'] },
        tokens: { type: 'integer', description: 'How many to return, e.g. 25.' },
        region: { type: 'string', description: 'A region, for example `eu-west-1`', pattern: '^[a-z]{2}-[a-z]+-\\d$' },
        slug: { type: 'string', description: "e.g. 'Not A Slug!'", pattern: '^[a-z-]+$' },
    });
    const { values, sources } = testData(schema, { variables: { repo_name: 'modelcontextprotocol/servers' } });
    assert.deepEqual(values, {
        fixed: 'x',
        repoName: '{{repo_name}}',
        libraryName: 'react',
        limit: 7,
        text: 'hello',
        tokens: 25,
        region: 'eu-west-1',
        slug: 'test',
    });
    assert.deepEqual(sources, {
        fixed: 'const',
        repoName: 'variable',
        libraryName: 'description',
        limit: 'default',
        text: 'example',
        tokens: 'description',
        region: 'description',
        slug: 'generated',
    });
});

test('optional fields stay empty unless the schema suggests a value or every field is asked for', () => {
    const schema = SCHEMAS['a search with limits'];
    assert.deepEqual(testData(schema).values, { query: 'test' });
    assert.deepEqual(testData(schema, { every: true }).values, { query: 'test', limit: 5 });
});

test('staged variables are used ignoring case, dashes and underscores, and resolve to valid values', () => {
    const schema = SCHEMAS['a search with limits'];
    const variables = { Query: 'whisper', LIMIT: '10' };
    const { values } = testData(schema, { variables, every: true });
    assert.deepEqual(values, { query: '{{Query}}', limit: '{{LIMIT}}' });
    assert.equal(problems(schema, resolveArguments(values, variables, schema)), null);
});

test('a variable with the exact name wins over ones named alike', () => {
    assert.equal(matchingVariable('repoName', { repo_name: 'a', repoName: 'b' }), 'repoName');
    assert.equal(matchingVariable('repo-name', { RepoName: 'a' }), 'RepoName');
    assert.equal(matchingVariable('query', { q: 'a' }), null);
});

test('common field names get plausible values', () => {
    const { values } = testData(object({
        email: { type: 'string' },
        url: { type: 'string' },
        query: { type: 'string' },
        owner: { type: 'string' },
        repo: { type: 'string' },
        language: { type: 'string' },
        userId: { type: 'string' },
        valid: { type: 'string' },
        limit: { type: 'integer', maximum: 3 },
    }));
    assert.deepEqual(values, {
        email: 'test@example.com',
        url: 'https://example.com',
        query: 'test',
        owner: 'modelcontextprotocol',
        repo: 'modelcontextprotocol',
        language: 'en',
        userId: '1',
        valid: 'test',
        limit: 3,
    });
});

test('patterns get a value that matches them', () => {
    const { values } = testData(SCHEMAS.patterns);
    assert.equal(values.code, 'AAA-11');
    assert.equal(values.slug, 'test');
    assert.match(values.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(values.scheme, 'https://');
    assert.equal(values.hex, '#000000');
});

test('the same schema always gets the same values', () => {
    for (const schema of Object.values(SCHEMAS)) {
        assert.deepEqual(testData(schema, { every: true }), testData(schema, { every: true }));
    }
});
