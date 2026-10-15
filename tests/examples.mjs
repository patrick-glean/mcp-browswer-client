#!/usr/bin/env node
// Runs each server in public/server-template/examples/ and checks that it describes itself as
// public/server-template/example.json does, read through the official TypeScript SDK client:
// the server's identity and instructions; each tool's title, description, hints, schemas and
// results; the resources, templates and prompts and what reading and getting them returns.
// What's compared is what MCP Browser Client shows, so SDKs may differ in the rest (the
// keywords they add to a schema, the order of a JSON object's keys). An example whose
// toolchain isn't installed is skipped.
//
//   node tests/examples.mjs [go typescript python ...]    (npm run test:examples)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { testData } from '../public/workbench/prefill.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = join(ROOT, 'public/server-template');
const replies = JSON.parse(readFileSync(join(FOLDER, 'example.json'), 'utf8'));
const VENV_PYTHON = join(ROOT, 'venv', 'bin', 'python');

// How to run each example: what it needs installed, how to get its dependencies, and how to
// start it. Each serves http://127.0.0.1:$PORT/mcp.
// `known` lists what an SDK can't declare, by where the difference shows, with the reason; those
// are reported but don't fail the check.
const EXAMPLES = {
    go: { needs: ['go', 'version'], run: ['go', ['run', '.']] },
    typescript: { needs: ['node', '--version'], setup: ['npm', ['install', '--no-audit', '--no-fund']], run: ['node', ['--experimental-strip-types', '--no-warnings', 'server.ts']] },
    python: {
        needs: [VENV_PYTHON, '-c', 'import mcp'],
        run: [VENV_PYTHON, ['server.py']],
        known: { 'inputSchema.additionalProperties': "MCPServer builds each tool's arguments model itself, and it accepts arguments the schema doesn't list" },
    },
    rust: { needs: ['cargo', '--version'], setup: ['cargo', ['build', '--quiet']], run: ['cargo', ['run', '--quiet']] },
    java: { needs: ['mvn', '--version'], setup: ['mvn', ['--quiet', '--batch-mode', 'package', '-DskipTests']], run: ['java', ['-jar', 'target/helpdesk.jar']] },
    csharp: { needs: ['dotnet', '--version'], setup: ['dotnet', ['build', '--nologo', '-v', 'q']], run: ['dotnet', ['run', '--no-build']] },
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const installed = ([command, ...args]) => {
    try {
        return spawnSync(command, args, { stdio: 'ignore', timeout: 60_000 }).status === 0;
    } catch {
        return false;
    }
};

// --- What's compared ---

const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
// JSON text compares as the value it holds, whatever its spacing and key order.
function asValue(text) {
    if (typeof text !== 'string') return text;
    try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object') return { json: value };
    } catch { /* plain text */ }
    return text;
}

const SCHEMA_KEYWORDS = ['type', 'description', 'enum', 'default', 'examples', 'format', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'uniqueItems'];

// A pattern as the regular expression it is: JavaScript writes / as \/ in a regex's source.
const keywords = (schema, names) => {
    const picked = pick(schema, names);
    if (typeof picked.pattern === 'string') picked.pattern = picked.pattern.replace(/\\\//g, '/');
    return picked;
};

function inputSchema(schema) {
    const properties = schema?.properties || {};
    return {
        order: Object.keys(properties),
        required: [...(schema?.required || [])].sort(),
        additionalProperties: schema?.additionalProperties === false ? false : 'allowed',
        properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, {
            ...keywords(property, SCHEMA_KEYWORDS),
            ...(property.items ? { items: keywords(property.items, ['type', 'pattern', 'enum']) } : {}),
        }])),
    };
}

function content(block) {
    if (!block) return block;
    const annotations = block.annotations ? { annotations: block.annotations } : {};
    switch (block.type) {
        case 'text': return { type: 'text', text: asValue(block.text), ...annotations };
        case 'image':
        case 'audio': return { type: block.type, mimeType: block.mimeType, data: block.data, ...annotations };
        case 'resource_link': return { ...pick(block, ['type', 'uri', 'name', 'title', 'description', 'mimeType']), ...annotations };
        case 'resource': return { type: 'resource', resource: { ...pick(block.resource, ['uri', 'mimeType', 'blob']), text: asValue(block.resource?.text) }, ...annotations };
        default: return block;
    }
}

const readContents = result => (result?.contents || []).map(item => ({ ...pick(item, ['uri', 'mimeType', 'blob']), text: asValue(item.text) }));
const bytesOf = result => (result?.contents || []).reduce((sum, item) => sum + (item.blob ? Buffer.from(item.blob, 'base64').length : Buffer.byteLength(item.text || '')), 0);
const argument = item => ({ name: item.name, description: item.description, required: !!item.required });

// What a server says about itself, in the terms the client shows it, from `get(method, key)`.
async function described(get) {
    const facts = {};
    const discover = await get('server/discover');
    facts.serverInfo = pick(discover.serverInfo, ['name', 'title', 'version', 'description', 'websiteUrl']);
    facts.icons = (discover.serverInfo?.icons || []).map(icon => pick(icon, ['src', 'mimeType', 'sizes', 'theme']));
    facts.instructions = discover.instructions;
    facts.capabilities = ['tools', 'resources', 'prompts'].filter(name => discover.capabilities?.[name]);
    const { tools } = await get('tools/list');
    facts.tools = Object.fromEntries(tools.map(tool => [tool.name, {
        title: tool.title,
        description: tool.description,
        annotations: pick(tool.annotations, ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']),
        inputSchema: inputSchema(tool.inputSchema),
        outputSchema: tool.outputSchema ? Object.keys(tool.outputSchema.properties || {}) : null,
    }]));
    facts.calls = {};
    for (const tool of tools) {
        const result = await get('tools/call', tool.name, testData(tool.inputSchema).values);
        facts.calls[tool.name] = { content: (result.content || []).map(content), structuredContent: result.structuredContent ?? null, isError: !!result.isError };
    }
    const { resources } = await get('resources/list');
    facts.resources = Object.fromEntries(resources.map(resource => [resource.uri, pick(resource, ['name', 'title', 'description', 'mimeType', 'annotations'])]));
    facts.reads = {};
    facts.sizes = {};
    for (const resource of resources) {
        const read = await get('resources/read', resource.uri);
        facts.reads[resource.uri] = readContents(read);
        facts.sizes[resource.uri] = resource.size === bytesOf(read) ? 'the size of what a read returns' : `${resource.size}, but a read returns ${bytesOf(read)} bytes`;
    }
    const { resourceTemplates } = await get('resources/templates/list');
    facts.templates = Object.fromEntries(resourceTemplates.map(template => [template.uriTemplate, pick(template, ['name', 'title', 'description', 'mimeType'])]));
    facts.reads['helpdesk://tickets/T-1042'] = readContents(await get('resources/read', 'helpdesk://tickets/T-1042'));
    const { prompts } = await get('prompts/list');
    facts.prompts = Object.fromEntries(prompts.map(prompt => [prompt.name, { ...pick(prompt, ['title', 'description']), arguments: (prompt.arguments || []).map(argument) }]));
    facts.gets = {};
    for (const prompt of prompts) {
        const args = Object.fromEntries((prompt.arguments || []).filter(item => item.required).map(item => [item.name, 'T-1042']));
        const result = await get('prompts/get', prompt.name, args);
        facts.gets[prompt.name] = { description: result.description, messages: (result.messages || []).map(message => ({ role: message.role, content: content(message.content) })) };
    }
    return facts;
}

// The template's replies, by method.
function fromTemplate(method, key) {
    if (method === 'server/discover') {
        const discover = replies[method];
        return { ...discover, serverInfo: discover._meta['io.modelcontextprotocol/serverInfo'] };
    }
    const reply = replies[method];
    return key === undefined ? reply : reply[key];
}

// A running server's replies, through the SDK client.
function fromServer(client) {
    const fresh = { cacheMode: 'refresh', timeout: 30_000 };
    return async (method, key, args) => {
        switch (method) {
            case 'server/discover': return {
                serverInfo: client.getServerVersion() ?? client.getDiscoverResult()?._meta?.['io.modelcontextprotocol/serverInfo'],
                instructions: client.getInstructions(),
                capabilities: client.getServerCapabilities(),
            };
            case 'tools/list': return client.listTools(undefined, fresh);
            case 'tools/call': return client.callTool({ name: key, arguments: args }, { timeout: 30_000 });
            case 'resources/list': return client.listResources(undefined, fresh);
            case 'resources/templates/list': return client.listResourceTemplates(undefined, fresh);
            case 'resources/read': return client.readResource({ uri: key }, fresh);
            case 'prompts/list': return client.listPrompts(undefined, fresh);
            case 'prompts/get': return client.getPrompt({ name: key, arguments: args }, { timeout: 30_000 });
            default: throw new Error(`no ${method}`);
        }
    };
}

// Whether a page can call the server, as a browser asks before sending MCP's headers. The
// headers have to be listed: a * in Access-Control-Allow-Headers doesn't cover Authorization.
const BROWSERS = 'a page on http://127.0.0.1:8080 may call it';
async function allowsBrowsers(url) {
    const origin = 'http://127.0.0.1:8080';
    const wanted = ['authorization', 'content-type', 'mcp-method', 'mcp-name', 'mcp-protocol-version'];
    const problems = [];
    const preflight = await fetch(url, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': wanted.join(',') },
    });
    const allowed = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase().split(/\s*,\s*/);
    if (!preflight.ok) problems.push(`the preflight got HTTP ${preflight.status}`);
    if (preflight.headers.get('access-control-allow-origin') !== origin) problems.push("the preflight doesn't allow the page's origin");
    const missing = wanted.filter(header => !allowed.includes(header));
    if (missing.length) problems.push(`the preflight doesn't allow ${missing.join(', ')}`);
    const reply = await fetch(url, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    await reply.text();
    if (reply.headers.get('access-control-allow-origin') !== origin) problems.push("a reply doesn't allow the page's origin");
    return problems.length ? problems.join('; ') : BROWSERS;
}

// Every place the server's facts differ from the template's, as "where: expected …, got …".
function differences(expected, actual, path = '') {
    if (isDeepStrictEqual(expected, actual)) return [];
    const objects = [expected, actual].every(value => value && typeof value === 'object' && !Array.isArray(value));
    if (!objects) return [`${path || '(all)'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
    return keys.flatMap(key => differences(expected[key], actual[key], path ? `${path}.${key}` : key));
}

async function check(name) {
    const example = EXAMPLES[name];
    const cwd = join(FOLDER, 'examples', name);
    if (!existsSync(cwd)) return { name, skipped: `there's no examples/${name}` };
    if (!installed(example.needs)) return { name, skipped: `${example.needs[0]} isn't installed` };
    if (example.setup) {
        const [command, args] = example.setup;
        const setup = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 900_000 });
        if (setup.status !== 0) return { name, failed: [`${command} ${args.join(' ')} failed: ${(setup.stderr || setup.stdout || '').trim().split('\n').slice(-12).join('\n')}`] };
    }
    const port = await freePort();
    const [command, args] = example.run;
    // In a process group of its own: `go run` and `cargo run` start the server as their child,
    // and stopping the group stops both.
    const child = spawn(command, args, { cwd, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const url = `http://127.0.0.1:${port}/mcp`;
    try {
        let client;
        for (let attempt = 0; attempt < 600 && !client; attempt++) {
            if (child.exitCode !== null) return { name, failed: [`it exited with ${child.exitCode}: ${output.trim().split('\n').slice(-12).join('\n')}`] };
            const candidate = new Client({ name: 'examples-check', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
            try {
                await candidate.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: 10_000 });
                client = candidate;
            } catch {
                await sleep(250);
            }
        }
        if (!client) return { name, failed: [`it didn't answer at ${url}: ${output.trim().split('\n').slice(-12).join('\n')}`] };
        const actual = { ...await described(fromServer(client)), browsers: await allowsBrowsers(url) };
        const expected = { ...await described(fromTemplate), browsers: BROWSERS };
        const era = `${client.getNegotiatedProtocolVersion()} (${client.getProtocolEra()})`;
        await client.close();
        const all = differences(expected, actual);
        const knownAt = Object.keys(example.known || {});
        const isKnown = line => knownAt.some(where => line.split(':')[0].includes(where));
        const known = knownAt.filter(where => all.some(line => line.split(':')[0].includes(where))).map(where => `${where}: ${example.known[where]}`);
        return { name, era, failed: all.filter(line => !isKnown(line)), known };
    } catch (error) {
        return { name, failed: [`${error.message}\n${output.trim().split('\n').slice(-12).join('\n')}`] };
    } finally {
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch { /* already gone */ }
    }
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(EXAMPLES);
let failures = 0;
for (const name of names) {
    if (!EXAMPLES[name]) throw new Error(`No example called ${name}; there are ${Object.keys(EXAMPLES).join(', ')}`);
    const result = await check(name);
    if (result.skipped) {
        console.log(`SKIP  ${name}: ${result.skipped}`);
    } else if (result.failed.length) {
        failures++;
        console.log(`FAIL  ${name}${result.era ? `, ${result.era}` : ''}: ${result.failed.length} differences from example.json`);
        for (const line of result.failed) console.log(`      ${line}`);
    } else {
        console.log(`PASS  ${name}, ${result.era}: describes itself as example.json does${result.known.length ? ', except where its SDK can\'t:' : ''}`);
    }
    for (const line of result.known || []) console.log(`      known: ${line}`);
}
process.exitCode = failures ? 1 : 0;
