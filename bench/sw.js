// The benchmark's service worker (scope /bench/, driven by bench/index.html). Every MCP client
// library runs in this one worker, and each run calls call_tool directly, as the app's sw.js does:
// it measures the client layer, the library's own work plus the HTTP exchange, without the page,
// the run history or the log.

import { loadMcpClient } from '../mcp-clients.js';
import { installMemoryServer } from './memory-server.js';

installMemoryServer();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// How each variant opens a server and calls echo on it, and which library from mcp-clients.js it
// uses. The app's worker talks to every library through the same interface, JSON strings in and
// out. 'sdk-objects' is the SDK client without those strings, as a worker built for the SDK alone
// would call it, and 'sdk-bare' is the SDK's own Client with none of the app's adapter: no trace,
// no error explanations.
const VARIANTS = {
    wasm: { client: 'wasm', open: viaStrings },
    sdk: { client: 'sdk', open: viaStrings },
    'sdk-objects': { client: 'sdk', open: viaObjects },
    'sdk-bare': { client: 'sdk', open: bare },
};

// Connects and lists the tools, as the app does before calling one.
async function viaStrings(client, url) {
    client.forget_server(url);
    await client.connect(url, '{}');
    await client.list_tools(url, '{}');
    return {
        call: async args => JSON.parse(await client.call_tool(url, 'echo', JSON.stringify(args), '{}')),
        close: () => client.forget_server(url),
    };
}

async function viaObjects(client, url) {
    const opened = await viaStrings(client, url);
    return { ...opened, call: args => client.call_tool_object(url, 'echo', args) };
}

async function bare({ Client, StreamableHTTPClientTransport }, url) {
    const client = new Client({ name: 'mcp-browser-client', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    await client.listTools();
    return {
        call: args => client.callTool({ name: 'echo', arguments: args }),
        close: () => client.close(),
    };
}

const libraries = new Map();

// Each library is loaded once per worker. Its log goes nowhere: each still builds every entry,
// which is its own cost; forwarding entries to pages is the app's, the same for all of them.
function library(name) {
    if (!libraries.has(name)) {
        libraries.set(name, loadMcpClient(name).then(loaded => {
            loaded.module.set_logger(() => {});
            return loaded;
        }));
    }
    return libraries.get(name);
}

self.addEventListener('message', event => {
    const [port] = event.ports;
    event.waitUntil(handle(event.data).then(
        result => port.postMessage({ result }),
        error => port.postMessage({ error: describe(error) }),
    ));
});

// Both clients reject with a JSON McpError string.
function describe(error) {
    if (typeof error === 'string') {
        try {
            return JSON.parse(error).message;
        } catch {
            return error;
        }
    }
    return error?.message ?? String(error);
}

async function handle(request) {
    switch (request.type) {
        case 'info':
            return { crossOriginIsolated: self.crossOriginIsolated, timerResolutionMs: timerResolution(), userAgent: navigator.userAgent };
        case 'run':
            return run(request);
        case 'cold':
            return cold(request);
        default:
            throw new Error(`Unknown request ${request.type}`);
    }
}

// The smallest step performance.now() takes: 5 µs when the worker is cross-origin isolated,
// 100 µs otherwise.
function timerResolution() {
    let smallest = Infinity;
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        let next = start;
        while (next === start) next = performance.now();
        smallest = Math.min(smallest, next - start);
    }
    return smallest;
}

// Runs `count` tasks, `concurrency` at a time: each lane starts another as soon as one finishes.
async function drive(count, concurrency, task) {
    let next = 0;
    const lane = async () => {
        while (next < count) await task(next++);
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
}

// Connects afresh, warms up, then makes `calls` echo calls with `bytes` of text, `concurrency`
// in flight, checking every result.
async function run({ variant, url, bytes, calls, concurrency, warmup }) {
    const { open, client: name } = VARIANTS[variant];
    const { module } = await library(name);
    const openStarted = performance.now();
    const server = await open(module, url);
    const connectMs = performance.now() - openStarted;

    const args = { text: 'x'.repeat(bytes) };
    const expected = 'Echo: '.length + bytes;
    const once = async () => {
        const result = await server.call(args);
        const text = result?.content?.[0]?.text;
        if (text?.length !== expected) throw new Error(`echo returned ${JSON.stringify(result).slice(0, 200)}`);
    };
    const latencies = new Float64Array(calls);
    let started;
    try {
        await drive(warmup, Math.min(concurrency, warmup), once);
        started = performance.now();
        await drive(calls, concurrency, async i => {
            const callStarted = performance.now();
            await once();
            latencies[i] = performance.now() - callStarted;
        });
    } finally {
        await server.close();
    }
    const elapsedMs = performance.now() - started;

    latencies.sort();
    const at = quantile => latencies[Math.min(calls - 1, Math.floor(quantile * calls))];
    return {
        variant, url, bytes, calls, concurrency, connectMs, elapsedMs,
        callsPerSecond: (calls * 1000) / elapsedMs,
        usPerCall: (elapsedMs * 1000) / calls,
        p50: at(0.5), p95: at(0.95), p99: at(0.99), max: latencies[calls - 1],
    };
}

// What a worker the browser just started pays before its first answers, through the app's
// interface (variant 'wasm' or 'sdk'): loading the library, connecting, and the first calls,
// before the JIT has seen them. The first call goes out without listing the tools first.
async function cold({ variant, url }) {
    const workerAgeMs = performance.now();
    const name = VARIANTS[variant].client;
    const fresh = !libraries.has(name);
    const loaded = await library(name);
    const client = loaded.module;
    const call = async () => JSON.parse(await client.call_tool(url, 'echo', JSON.stringify({ text: 'cold start' }), '{}'));
    let started = performance.now();
    await client.connect(url, '{}');
    const connectMs = performance.now() - started;
    started = performance.now();
    await call();
    const firstCallMs = performance.now() - started;
    started = performance.now();
    await call();
    const secondCallMs = performance.now() - started;
    client.forget_server(url);
    return { variant, fresh, workerAgeMs, loadMs: loaded.loadMs, bytes: loaded.bytes, connectMs, firstCallMs, secondCallMs };
}
