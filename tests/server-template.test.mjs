// The server template (server-template/example.json): valid MCP 2026-07-28 replies, with every field
// the guide beside it recommends, input schemas Pre-fill fills with valid arguments, and results
// that match their output schemas.
//
//   node --test tests/server-template.test.mjs    (npm run test:unit)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { specTypeSchemas } from '@modelcontextprotocol/client';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { fieldTestData, testData } from '../public/workbench/prefill.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;
// Strict, so a misspelled keyword (minimun, exmaples) fails instead of being ignored.
const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));

const replies = JSON.parse(readFileSync(new URL('../server-template/example.json', import.meta.url), 'utf8'));
const discover = replies['server/discover'];
const serverInfo = discover._meta['io.modelcontextprotocol/serverInfo'];
const tools = replies['tools/list'].tools;
const resources = replies['resources/list'].resources;
const templates = replies['resources/templates/list'].resourceTemplates;
const prompts = replies['prompts/list'].prompts;

// The paths of fields in `sent` that parsing dropped or changed: ones the protocol doesn't define.
function dropped(sent, parsed, path = '') {
    if (sent === null || typeof sent !== 'object') return Object.is(sent, parsed) ? [] : [path || '(root)'];
    if (parsed === null || typeof parsed !== 'object') return [path || '(root)'];
    return Object.keys(sent).flatMap(key => dropped(sent[key], parsed[key], `${path}${Array.isArray(sent) ? `[${key}]` : `.${key}`}`));
}

function assertSpec(type, value, what) {
    const parsed = specTypeSchemas[type].safeParse(value);
    assert.ok(parsed.success, `${what} isn't a valid ${type}: ${parsed.error?.message}`);
    assert.deepEqual(dropped(value, parsed.data), [], `${what} has fields ${type} doesn't define`);
}

const each = (method, type) => Object.entries(replies[method]).map(([key, value]) => [type, value, `${method} ${key}`]);

test('every reply is valid MCP, with no field the protocol lacks', () => {
    const checks = [
        ['DiscoverResult', discover, 'server/discover'],
        ['Implementation', serverInfo, 'serverInfo'],
        ['ListToolsResult', replies['tools/list'], 'tools/list'],
        ['ListResourcesResult', replies['resources/list'], 'resources/list'],
        ['ListResourceTemplatesResult', replies['resources/templates/list'], 'resources/templates/list'],
        ['ListPromptsResult', replies['prompts/list'], 'prompts/list'],
        ...each('tools/call', 'CallToolResult'),
        ...each('resources/read', 'ReadResourceResult'),
        ...each('prompts/get', 'GetPromptResult'),
    ];
    for (const check of checks) assertSpec(...check);
    assert.deepEqual(Object.keys(replies).filter(key => !key.includes('/') && key !== '$comment'), [], 'keys other than methods');
});

test('every result says what kind it is, and lists and reads how long they may be cached, as 2026-07-28 requires', () => {
    const results = [
        ...['server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'].map(method => [method, replies[method]]),
        ...['tools/call', 'resources/read', 'prompts/get'].flatMap(method => Object.entries(replies[method]).map(([key, result]) => [`${method} ${key}`, result])),
    ];
    for (const [what, result] of results) assert.equal(result.resultType, 'complete', `${what} needs resultType`);
    const cacheable = results.filter(([what]) => /^(tools|resources|resources\/templates|prompts)\/list$|^resources\/read /.test(what));
    assert.equal(cacheable.length, 8);
    for (const [what, result] of cacheable) {
        assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs >= 0, `${what} needs ttlMs`);
        assert.ok(['public', 'private'].includes(result.cacheScope), `${what} needs cacheScope`);
    }
});

test('the server, its tools, resources and prompts are fully described', () => {
    for (const field of ['name', 'title', 'version', 'description', 'websiteUrl']) assert.ok(serverInfo[field], `serverInfo.${field}`);
    assert.ok(serverInfo.icons.some(icon => icon.theme === 'light') && serverInfo.icons.some(icon => icon.theme === 'dark'), 'icons for light and dark themes');
    assert.ok(discover.instructions.includes('\n'), 'instructions');
    for (const tool of tools) {
        assert.ok(tool.title && tool.title !== tool.name && tool.description, `${tool.name}: a title and a description`);
        for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
            assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name}: annotations.${hint}`);
        }
        for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
            assert.ok(prop.type && prop.description, `${tool.name}.${key}: a type and a description`);
        }
    }
    for (const item of [...resources, ...templates]) assert.ok(item.title && item.description && item.mimeType, `${item.name}: a title, description and mimeType`);
    for (const prompt of prompts) {
        assert.ok(prompt.title && prompt.description, `${prompt.name}: a title and a description`);
        for (const argument of prompt.arguments || []) assert.ok(argument.description, `${prompt.name}.${argument.name}: a description`);
    }
});

test('every result belongs to something the server lists, and each listed thing has one', () => {
    const names = items => items.map(item => item.name).sort();
    assert.deepEqual(Object.keys(replies['tools/call']).sort(), names(tools));
    assert.deepEqual(Object.keys(replies['prompts/get']).sort(), names(prompts));
    const fromTemplate = uri => templates.some(({ uriTemplate }) => new RegExp(`^${uriTemplate.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`).test(uri));
    for (const [uri, result] of Object.entries(replies['resources/read'])) {
        assert.ok(resources.some(resource => resource.uri === uri) || fromTemplate(uri), `${uri} is listed or comes from a template`);
        assert.ok(result.contents.every(item => item.uri === uri && item.mimeType), `${uri}: each item has its uri and a mimeType`);
    }
    for (const resource of resources) {
        const contents = replies['resources/read'][resource.uri]?.contents;
        assert.ok(contents, `${resource.uri} can be read`);
        const bytes = contents.reduce((sum, item) => sum + (item.blob ? Buffer.from(item.blob, 'base64').length : Buffer.byteLength(item.text)), 0);
        assert.equal(resource.size, bytes, `${resource.uri}: size is the size of what a read returns`);
    }
    const image = Object.values(replies['tools/call']).flatMap(result => result.content).find(item => item.type === 'image');
    assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG', 'the image result is a PNG');
});

test('input and output schemas compile, and structured results match them', () => {
    for (const tool of tools) {
        ajv.compile(tool.inputSchema);
        const result = replies['tools/call'][tool.name];
        if (!tool.outputSchema) {
            assert.equal(result.structuredContent, undefined, `${tool.name} returns structuredContent without an outputSchema`);
            continue;
        }
        const validate = ajv.compile(tool.outputSchema);
        assert.ok(validate(result.structuredContent), `${tool.name}: ${ajv.errorsText(validate.errors)}`);
        // The same JSON as text, for clients and models that only read text.
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${tool.name}: the text block is the structured content`);
    }
});

test("Pre-fill's test data from the schemas' examples and defaults passes every tool's input schema", () => {
    for (const tool of tools) {
        const validate = ajv.compile(tool.inputSchema);
        for (const every of [false, true]) {
            const { values } = testData(tool.inputSchema, { every });
            assert.ok(validate(values), `${tool.name}${every ? ', every field' : ''}: ${ajv.errorsText(validate.errors)} in ${JSON.stringify(values)}`);
        }
        for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
            const expected = prop.examples ? 'example' : Object.hasOwn(prop, 'default') ? 'default' : null;
            if (expected) assert.equal(fieldTestData(tool.inputSchema, key)?.source, expected, `${tool.name}.${key} is filled from its ${expected}`);
        }
    }
});

test("a prompt argument's description gives Pre-fill its value", () => {
    // The prompt pane makes each argument a string with its description, as here.
    const fill = argument => {
        const schema = { type: 'object', properties: { [argument.name]: { type: 'string', description: argument.description } } };
        return fieldTestData(schema, argument.name)?.value;
    };
    const [id, audience] = prompts.find(prompt => prompt.name === 'summarize_ticket').arguments;
    assert.equal(fill(id), 'T-1042');
    assert.equal(fill(audience), 'agent');
});
