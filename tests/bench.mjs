#!/usr/bin/env node
// Tool-call load test of the MCP client libraries, Rust/WASM and the TypeScript SDK, in headless
// Chrome against test_mcp_server.py:
//
//   1. The client layer: public/bench/ calls call_tool in a service worker, against three mock
//      servers over HTTP (modern JSON, modern SSE, legacy) and against an in-memory server that
//      leaves only the clients' own work.
//   2. Cold start: the first calls in a service worker the browser just started.
//   3. The whole app: tool calls sent from the page through the app's own worker, run history
//      and all.
//
// Prints the results as tables and saves them as JSON.
//
//   node tests/bench.mjs [--quick] [--rounds=N]     (npm run bench)
//
// Needs Node 22+, Google Chrome (or CHROME_PATH) and python3.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, extname, join, normalize as normalizePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const ROUNDS = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.slice('--rounds='.length)) || (QUICK ? 1 : 3);
const HOST = 'http://127.0.0.1';
// Chosen per run (see freePorts), so the benchmark can't collide with anything else listening.
const PORTS = {};
const PYTHON = process.env.PYTHON || 'python3';
const CHROME = process.env.CHROME_PATH || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].find(existsSync);

// With HTTP/1.0's connection per request, tens of thousands of calls in a few seconds leave Chrome
// unable to connect for a while; keep-alive is also what most servers do.
const SERVERS = [
    { label: 'modern, JSON', port: 'modern', flags: ['--mode', 'modern', '--keep-alive'] },
    { label: 'modern, SSE', port: 'sse', flags: ['--mode', 'modern', '--sse', '--keep-alive'] },
    { label: 'legacy, JSON', port: 'legacy', flags: ['--mode', 'legacy', '--keep-alive'] },
];
const CLIENT_LABELS = { wasm: 'Rust/WASM', sdk: 'TypeScript SDK' };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
process.on('exit', () => children.forEach(child => child.kill()));
process.on('SIGINT', () => process.exit(130));

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
};

// Serves public/ without caching. The benchmark's pages and worker are cross-origin isolated, which
// gives them 5 µs timers instead of 100 µs ones.
function serveApp(port) {
    const root = join(ROOT, 'public');
    const server = createHttpServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, HOST).pathname);
        let file = normalizePath(join(root, pathname));
        try {
            if (!file.startsWith(root)) throw new Error('outside public/');
            if (statSync(file).isDirectory()) file = join(file, 'index.html');
            const headers = { 'Content-Type': MIME_TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
            if (pathname.startsWith('/bench/')) {
                headers['Cross-Origin-Opener-Policy'] = 'same-origin';
                headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
            }
            response.writeHead(200, headers);
            createReadStream(file).on('error', () => response.destroy()).pipe(response);
        } catch {
            response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        }
    });
    children.push({ kill: () => server.close() });
    server.listen(port, '127.0.0.1');
}

function startMock({ flags, port }) {
    // Its per-request lines aren't read, so they don't go through a pipe that could fill up.
    const child = spawn(PYTHON, ['test_mcp_server.py', '--port', String(PORTS[port]), ...flags], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    children.push(child);
}

// One free port for each name, all held open until every one is chosen so none repeats.
async function freePorts(names) {
    const servers = await Promise.all(names.map(() => new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    })));
    names.forEach((name, i) => { PORTS[name] = servers[i].address().port; });
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}

async function waitForHttp(url, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try {
            await fetch(url, { method: 'OPTIONS' });
            return;
        } catch {
            await sleep(100);
        }
    }
    throw new Error(`Nothing is listening at ${url}`);
}

// A small Chrome DevTools Protocol client for the one page.
async function openPage() {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
        try {
            target = (await (await fetch(`${HOST}:${PORTS.devtools}/json`)).json()).find(t => t.type === 'page');
        } catch {
            // Chrome is still starting.
        }
        if (!target) await sleep(100);
    }
    if (!target) throw new Error('No Chrome page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        } else if (message.method === 'Runtime.consoleAPICalled') {
            // Only the benchmark's own progress lines; the app's pages log every message.
            const text = message.params.args.map(arg => arg.value ?? arg.description).join(' ');
            if (text.startsWith('[bench] ')) console.log(`  ${text.slice('[bench] '.length)}`);
        }
    });
    const send = (method, params = {}) => new Promise(resolve => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
    });
    const run = async expression => {
        const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluation failed');
        return reply.result?.result?.value;
    };
    const waitFor = async (expression, ms = 20000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const value = await run(expression).catch(() => null);
            if (value) return value;
            await sleep(150);
        }
        throw new Error(`Timed out waiting for ${expression}`);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('ServiceWorker.enable');
    return { send, run, waitFor, close: () => ws.close() };
}

// Tool calls sent from the app's page through its own service worker, the way the Workbench sends
// them: each is recorded in the run history and announced to the page. Runs in the page.
async function callsThroughTheApp({ url, calls, concurrency, warmup }) {
    const worker = navigator.serviceWorker.controller;
    const waiting = new Map();
    const listen = event => {
        const message = event.data;
        const id = message?.run?.id;
        if (message?.type === 'tool_result' && waiting.has(id)) {
            waiting.get(id)(message);
            waiting.delete(id);
        }
    };
    navigator.serviceWorker.addEventListener('message', listen);
    const args = { text: 'x'.repeat(64) };
    const once = () => new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        waiting.set(id, message => (message.result?.content?.[0]?.text?.startsWith('Echo: ') ? resolve() : reject(new Error(message.error || 'no echo'))));
        worker.postMessage({ type: 'call_tool', call: { serverUrl: url, toolName: 'echo', args }, run: { id } });
    });
    const drive = async (count, lanes, task) => {
        let next = 0;
        await Promise.all(Array.from({ length: lanes }, async () => {
            while (next < count) await task(next++);
        }));
    };
    try {
        await drive(warmup, 1, once);
        const latencies = new Float64Array(calls);
        const started = performance.now();
        await drive(calls, concurrency, async i => {
            const callStarted = performance.now();
            await once();
            latencies[i] = performance.now() - callStarted;
        });
        const elapsedMs = performance.now() - started;
        latencies.sort();
        const at = quantile => latencies[Math.min(calls - 1, Math.floor(quantile * calls))];
        return { calls, concurrency, elapsedMs, callsPerSecond: (calls * 1000) / elapsedMs, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
    } finally {
        navigator.serviceWorker.removeEventListener('message', listen);
    }
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function main() {
    if (!CHROME) throw new Error('Google Chrome not found; set CHROME_PATH');
    const suite = await import(pathToFileURL(join(ROOT, 'public', 'bench', 'suite.js')));

    await freePorts(['app', 'modern', 'sse', 'legacy', 'devtools']);
    for (const server of SERVERS) server.url = `${HOST}:${PORTS[server.port]}/`;
    serveApp(PORTS.app);
    SERVERS.forEach(startMock);
    for (const port of [PORTS.app, PORTS.modern, PORTS.sse, PORTS.legacy]) await waitForHttp(`${HOST}:${port}/`);

    const profile = mkdtempSync(join(tmpdir(), 'mcp-bench-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-component-extensions-with-background-pages',
        `--user-data-dir=${profile}`, `--remote-debugging-port=${PORTS.devtools}`, 'about:blank',
    ], { stdio: 'ignore' });
    children.push(chrome);

    const report = { startedAt: new Date().toISOString(), quick: QUICK, rounds: ROUNDS };
    const out = [];
    let page;
    try {
        page = await openPage();
        const { Browser: browser } = await (await fetch(`${HOST}:${PORTS.devtools}/json/version`)).json();
        await page.send('Page.navigate', { url: `${HOST}:${PORTS.app}/bench/` });
        await page.waitFor(`typeof benchReady !== 'undefined'`);
        const info = await page.run(`Promise.race([benchReady, new Promise((_, reject) => setTimeout(() => reject(new Error("The benchmark's service worker didn't answer")), 30000))])`);
        report.environment = {
            browser, cpu: cpus()[0]?.model, cores: cpus().length, os: `${platform()} ${release()}`, node: process.version,
            crossOriginIsolated: info.crossOriginIsolated, timerResolutionMs: info.timerResolutionMs,
            server: 'test_mcp_server.py --keep-alive (Python ThreadingHTTPServer, HTTP/1.1)',
        };
        console.log(`${browser} on ${report.environment.cpu}, ${report.environment.cores} cores; timers ${suite.formatMs(info.timerResolutionMs)}`);

        console.log(`\nThe client layer (${ROUNDS} round${ROUNDS === 1 ? '' : 's'} of each run):`);
        const config = { servers: SERVERS.map(({ label, url }) => ({ label, url })), memory: true, quick: QUICK, rounds: ROUNDS };
        report.clientLayer = await page.run(`bench.runSuite(${JSON.stringify(config)}, ({ done, total, run, variant, sample }) => {
            if (sample.error || done % 9 === 0 || done === total) console.log('[bench]', done + '/' + total, variant, run.target.label, bench.formatBytes(run.bytes),
                run.concurrency + ' in flight', sample.error ? 'FAILED: ' + sample.error : bench.formatRate(sample.callsPerSecond));
        })`);
        out.push(...suite.tables(report.clientLayer).map(suite.markdown));

        // Each sample needs a worker the browser just started.
        console.log('\nCold start:');
        const coldRounds = Math.max(3, ROUNDS * 2 - 1);
        report.coldStart = [];
        for (let round = 0; round < coldRounds; round++) {
            for (const variant of round % 2 ? ['sdk', 'wasm'] : ['wasm', 'sdk']) {
                await page.send('ServiceWorker.stopAllWorkers');
                await sleep(300);
                const sample = await page.run(`bench.send(${JSON.stringify({ type: 'cold', variant, url: SERVERS[0].url })})`);
                if (!sample.fresh) throw new Error(`The ${variant} client was already loaded; the worker didn't restart`);
                report.coldStart.push(sample);
            }
        }
        console.log(`  ${report.coldStart.length} fresh workers`);
        const coldRows = ['wasm', 'sdk'].map(variant => {
            const samples = report.coldStart.filter(sample => sample.variant === variant);
            const m = key => suite.formatMs(median(samples.map(sample => sample[key])));
            return [CLIENT_LABELS[variant], `${Math.round(samples[0].bytes / 1024)} KB`, m('loadMs'), m('connectMs'), m('firstCallMs'), m('secondCallMs')];
        });
        out.push(suite.markdown({
            title: 'Cold start: the first calls in a service worker the browser just started',
            note: `Medians of ${coldRounds} fresh workers each, against the modern JSON mock. Loading is fetching, compiling and starting the client.`,
            headers: ['Client', 'Size', 'Load', 'Connect', 'First call', 'Second call'],
            rows: coldRows,
        }));

        // Libraries are switched the way a person would, with the Runtime menu's select.
        console.log('\nThrough the whole app:');
        const appCalls = QUICK ? 100 : 400;
        report.app = [];
        await page.send('Page.navigate', { url: `${HOST}:${PORTS.app}/` });
        await page.waitFor(`typeof appShell !== 'undefined' && !!appShell.serviceWorker && !!navigator.serviceWorker.controller`);
        await sleep(1000);
        for (let round = 0; round < ROUNDS; round++) {
            for (const client of round % 2 ? ['sdk', 'wasm'] : ['wasm', 'sdk']) {
                const switched = await page.run(`new Promise(resolve => {
                    const listen = event => {
                        if (event.data?.type !== 'client_set' || event.data.client !== ${JSON.stringify(client)}) return;
                        navigator.serviceWorker.removeEventListener('message', listen);
                        resolve(event.data.loaded);
                    };
                    navigator.serviceWorker.addEventListener('message', listen);
                    const select = document.getElementById('clientSelect');
                    select.value = ${JSON.stringify(client)};
                    select.dispatchEvent(new Event('change'));
                })`);
                if (!switched) throw new Error(`The app couldn't switch to the ${client} client`);
                for (const concurrency of [1, 6]) {
                    const sample = await page.run(`(${callsThroughTheApp})(${JSON.stringify({ url: SERVERS[0].url, calls: appCalls, concurrency, warmup: 20 })})`);
                    report.app.push({ client, ...sample });
                    console.log(`  ${CLIENT_LABELS[client]}, ${concurrency} in flight: ${suite.formatRate(sample.callsPerSecond)}`);
                }
            }
        }
        const appRows = [1, 6].map(concurrency => {
            const pick = client => {
                const samples = report.app.filter(sample => sample.client === client && sample.concurrency === concurrency);
                return [...samples].sort((a, b) => a.callsPerSecond - b.callsPerSecond)[Math.floor(samples.length / 2)];
            };
            const [wasm, sdk] = [pick('wasm'), pick('sdk')];
            const cell = sample => `${suite.formatRate(sample.callsPerSecond)} · ${suite.formatMs(sample.p50)}`;
            return [`modern, JSON`, '64 B', String(concurrency), cell(wasm), cell(sdk), suite.speedup(wasm, sdk)];
        });
        out.push(suite.markdown({
            title: 'Through the whole app: page → service worker → client → mock server → run history → page',
            note: `Calls per second · median time per call; the median of ${ROUNDS} round${ROUNDS === 1 ? '' : 's'} of ${appCalls} calls.`,
            headers: ['Server', 'Payload', 'In flight', 'Rust/WASM', 'TypeScript SDK', 'WASM ÷ SDK'],
            rows: appRows,
        }));
    } finally {
        page?.close();
        chrome.kill();
        await sleep(500);
        rmSync(profile, { recursive: true, force: true });
    }

    const file = join(tmpdir(), `mcp-bench-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n${out.join('\n\n')}\n\nAll of it, with every round: ${file}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => children.forEach(child => child.kill()));
