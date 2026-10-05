// Pre-fill's test data (public/workbench/prefill.js): generated values are valid for their schema,
// hints and staged variables come first, and a schema always gets the same values.
//
//   node --test tests/prefill.test.mjs    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { fieldTestData, matchingVariable, testData } from '../public/workbench/prefill.js';
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
    // Shortened from Glean's enterprise_search and meeting_lookup: two required fields and many
    // optional filters, described for a model rather than a person.
    'a search with many filters': object({
        query: { type: 'string', description: 'important keywords that help find relevant documents.' },
        after: { type: 'string', description: 'filter to documents updated after this date. value must be in "YYYY-MM-DD" format. ONLY when the user has mentioned a specific time frame (e.g. last week, past month)' },
        updated: { type: 'string', description: 'value can be one of ["today", "yesterday", "past_week"]. ONLY when the user has mentioned a time frame (e.g. last week)' },
        owner: { type: 'string', description: 'Value can be a person\'s name, "me" or "myteam". Do NOT use other team names' },
        num_results: { type: 'integer' },
        cursor: { type: 'string', description: 'pagination cursor from a previous search response.' },
        type: { type: 'string', enum: ['pull', 'spreadsheet', 'direct message'] },
        calendar_ids: { type: 'array', items: { type: 'string' }, description: 'Calendar IDs (e.g. a team calendar). Google IDs are emails like "c_abc123@group.calendar.google.com"; Outlook ones are like "AAMkAD...".' },
        peer: { type: 'string', description: "(optional) Email address of another person (e.g. 'What meetings does alice@company.com have today?', 'Show me Bob's calendar')." },
        participants: { type: 'array', items: { type: 'string' } },
    }, ['query', 'after']),
};

const day = daysAgo => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

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

test('only the required fields are filled, unless every field is asked for', () => {
    const schema = object({
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 },
        sort: { enum: ['asc', 'desc'], examples: ['desc'] },
        region: { type: 'string', description: 'Where to look, e.g. eu-west-1.' },
        fixed: { const: 'v2' },
        filter: object({ owner: { type: 'string' }, since: { type: 'string', format: 'date' } }, ['owner']),
    }, ['query', 'filter']);
    assert.deepEqual(testData(schema).values, { query: 'test', filter: { owner: 'modelcontextprotocol' } });
    assert.deepEqual(testData(schema, { variables: { limit: '3' } }).values, { query: 'test', filter: { owner: 'modelcontextprotocol' } });
    assert.deepEqual(testData(schema, { every: true }).values, {
        query: 'test', limit: 10, sort: 'desc', region: 'eu-west-1', fixed: 'v2', filter: { owner: 'modelcontextprotocol', since: day(7) },
    });
});

test('descriptions give examples and the values a field takes, as MCP servers write them', () => {
    const value = (key, description, prop = { type: 'string' }) => testData(object({ [key]: { ...prop, description } })).values[key];
    // Glean
    assert.equal(value('updated', 'filter to documents updated on or after this date, value can be one of ["today", "yesterday", "past_week"].'), 'today');
    assert.equal(value('owner', 'filter to documents created by this person. Value can be a person\'s name, "me" or "myteam". Do NOT use other team names, only "myteam" is supported'), 'me');
    assert.equal(value('freshness', 'Optional recency filter. Values:\n- "pd" (past day), "pw" (past week)\nMap the stated window to the closest value (e.g. "this week" -> pw).'), 'pd');
    assert.equal(value('extension', 'File extension to filter code files by. Accepts common extensions like "py", "js", "ts" etc.'), 'py');
    assert.equal(value('after', '(required) Inclusive start of the date range. Use keywords: "today", "yesterday". Or use YYYY-MM-DD for specific dates.'), 'today');
    assert.equal(value('start_date', 'Start date in YYYY-MM-DD format.\n\nExamples:\n- "2025-01-01" -> January 1, 2025'), '2025-01-01');
    assert.equal(value('query', 'Search query for people.\n\nExamples:\n- "John Smith" -> Find people named John Smith'), 'John Smith');
    assert.equal(value('mime_type', 'For file-backed types: the MIME type of the bytes (e.g. image/png).'), 'image/png');
    // Context7 and Hugging Face
    assert.equal(value('libraryName', "Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs'."), 'Next.js');
    assert.deepEqual(value('filters', 'Optional hub filter tags (e.g. ["text-generation"], ["language:en"]).', { type: 'array', items: { type: 'string' } }), ['text-generation']);
    assert.deepEqual(value('operations', 'Details to return. Defaults to ["overview"].', { type: 'array', items: { type: 'string', enum: ['overview', 'dataset_structure'] } }), ['overview']);
    assert.equal(value('limit', 'Row count. Defaults to 5 and is clamped to 1-100.', { type: 'integer' }), 5);
});

test("prose in a description isn't taken for a value", () => {
    const filled = (key, description, prop = { type: 'string' }) => testData(object({ [key]: { ...prop, description } }));
    const value = (...args) => filled(...args).values[args[0]];
    // A bare word with more words after it, and a quote that's an apostrophe.
    assert.equal(value('container', 'Scope the search to a container (e.g., a Google Drive folder, Confluence space).'), 'test');
    assert.equal(value('calendar', 'Which calendar (e.g. "what\'s on the team calendar this week").'), 'test');
    // A sentence for a field that doesn't take free text, a format, a shortened example, and a
    // value the description says not to use.
    assert.equal(value('peer', "Email address of another person (e.g. 'What meetings does alice@company.com have today?')."), 'test@example.com');
    assert.equal(value('after', 'value must be in "YYYY-MM-DD" format, when the user mentioned a time frame (e.g. last week).'), day(7));
    assert.equal(value('calendar_id', 'Outlook IDs are opaque strings like "AAMkAD...".'), '1');
    assert.equal(value('sort', 'Do not use values like "latest".'), 'test');
    assert.equal(filled('sort', 'Do not use values like "latest".').sources.sort, 'generated');
    // A closing quote isn't taken for an opening one.
    assert.equal(value('query', "Good: 'How to set up auth in Express.js' or 'React useEffect cleanup examples'. Bad: 'auth'."), 'test');
});

test("defaults and examples that say nothing aren't suggestions", () => {
    const { values, sources } = testData(object({
        query: { type: 'string', default: null },
        language: { type: 'string', default: null, description: 'The programming language of code snippets to retrieve. Eligible values: csharp javascript python' },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
        note: { type: 'string', examples: ['', 'remember the milk'] },
    }));
    assert.deepEqual(values, { query: 'test', language: 'python', tags: ['test'], note: 'remember the milk' });
    assert.deepEqual(sources, { query: 'generated', language: 'generated', tags: 'generated', note: 'example' });
});

test('what a description says a field holds comes before guesses from its name', () => {
    const { values } = testData(object({
        author: { type: 'string', description: 'Email address of the person who wrote it.' },
        peer: { type: 'string', description: '(optional) Email address of another person.' },
        after: { type: 'string', description: 'Only notes written on or after this day, as YYYY-MM-DD.' },
        before: { type: 'string', description: 'Only notes written before this day, as YYYY-MM-DD.' },
        since: { type: 'string', description: 'Only results updated since then (ISO 8601 timestamp).' },
        folder: { type: 'string', description: 'URL of the folder to search in.' },
        api_version: { type: 'string', description: 'The API version to use, as YYYY-MM-DD.' },
        data: { type: 'string', description: 'The replacement file bytes, base64-encoded.' },
        query: { type: 'string', description: 'Search terms, with dates written as YYYY-MM-DD.' },
        owner: { type: 'string', description: 'Who owns the repository.' },
        path: { type: 'string', description: 'Path to the file or directory.' },
    }));
    assert.deepEqual(values, {
        author: 'test@example.com',
        peer: 'test@example.com',
        after: day(7),
        before: day(0),
        since: `${day(7)}T00:00:00Z`,
        folder: 'https://example.com',
        api_version: day(0),
        data: 'dGVzdA==',
        query: 'test',
        owner: 'modelcontextprotocol',
        path: '/',
    });
});

test('optional pagination cursors stay empty, even with every field filled', () => {
    const schema = object({ query: { type: 'string' }, cursor: { type: 'string' }, page_token: { type: 'string' }, nextToken: { type: 'string' } }, ['query']);
    assert.deepEqual(testData(schema, { every: true }).values, { query: 'test' });
    assert.deepEqual(testData(object({ cursor: { type: 'string' } })).values, { cursor: 'test' });
});

test('one field at a time, nested ones too', () => {
    const schema = {
        type: 'object',
        properties: {
            query: { type: 'string' },
            limit: { type: 'integer', default: 10 },
            cursor: { type: 'string' },
            filter: object({ owner: { type: 'string' }, since: { type: 'string', format: 'date' } }, ['owner']),
        },
        required: ['query'],
    };
    assert.deepEqual(fieldTestData(schema, 'limit'), { value: 10, source: 'default' });
    assert.deepEqual(fieldTestData(schema, 'filter.since'), { value: day(7), source: 'generated' });
    assert.deepEqual(fieldTestData(schema, 'filter'), { value: { owner: 'modelcontextprotocol', since: day(7) }, source: 'generated' });
    assert.deepEqual(fieldTestData(schema, 'query', { variables: { Query: 'whisper' } }), { value: '{{Query}}', source: 'variable' });
    assert.equal(fieldTestData(schema, 'cursor'), null);
    assert.equal(fieldTestData(schema, 'nope'), null);
    assert.equal(fieldTestData(schema, 'filter.nope'), null);
    // The same value as filling every field gives it.
    const every = testData(schema, { every: true }).values;
    for (const key of Object.keys(every)) assert.deepEqual(fieldTestData(schema, key).value, every[key], key);
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
        num_results: { type: 'integer' },
        to: { type: 'string' },
        participants: { type: 'array', items: { type: 'string' } },
        question: { type: 'string' },
        subject: { type: 'string' },
        branch: { type: 'string' },
        file_path: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        weekday: { type: 'string' },
        update: { type: 'string' },
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
        num_results: 5,
        to: 'test@example.com',
        participants: ['test@example.com'],
        question: 'What is MCP?',
        subject: 'Hello from MCP Browser Client',
        branch: 'main',
        file_path: 'README.md',
        start_date: day(7),
        end_date: day(0),
        weekday: 'test',
        update: 'test',
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
