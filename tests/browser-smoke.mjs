#!/usr/bin/env node
// Browser smoke test: loads the app in headless Chrome and drives the real UI against mock MCP
// servers (modern, streaming, legacy, dual-era) and, with --reference, a server built on the
// official Python SDK.
//
//   node tests/browser-smoke.mjs [--reference]
//
// Needs Node 22+, Google Chrome (or CHROME_PATH), python3, and for --reference the venv that
// setup.sh creates. Exits non-zero if any check fails.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WITH_REFERENCE = process.argv.includes('--reference');
const HOST = 'http://127.0.0.1';
const PORTS = { app: 18080, modern: 18081, sse: 18082, legacy: 18083, legacySse: 18084, dual: 18085, reference: 18086, devtools: 19222 };
const PYTHON = process.env.PYTHON || 'python3';
const CHROME = process.env.CHROME_PATH || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].find(existsSync);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
const results = [];

function start(name, command, args) {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    child.label = name;
    child.output = '';
    child.stdout.on('data', data => { child.output += data; });
    child.stderr.on('data', data => { child.output += data; });
    children.push(child);
    return child;
}

function stopAll() {
    for (const child of children) child.kill();
}
process.on('exit', stopAll);
process.on('SIGINT', () => process.exit(130));

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

function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// A small Chrome DevTools Protocol client for one page target.
async function openPage() {
    let targets;
    for (let i = 0; i < 100 && !targets; i++) {
        try {
            targets = await (await fetch(`${HOST}:${PORTS.devtools}/json`)).json();
        } catch {
            await sleep(100);
        }
    }
    if (!targets) throw new Error('Chrome did not start');
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const exceptions = [];
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        } else if (message.method === 'Runtime.exceptionThrown') {
            const details = message.params.exceptionDetails;
            exceptions.push(details.exception?.description ?? details.text);
        }
    });
    const send = (method, params = {}) => new Promise(resolve => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
    });
    const run = async expression => {
        const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (reply.result?.exceptionDetails) {
            throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluation failed');
        }
        return reply.result?.result?.value;
    };
    const waitFor = async (expression, ms = 15000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const value = await run(expression);
            if (value) return value;
            await sleep(150);
        }
        return null;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('ServiceWorker.enable');
    return { send, run, waitFor, exceptions, close: () => ws.close() };
}

// UI helpers: everything goes through the same buttons and forms a person would use.
async function addAndConnect(page, url, alias) {
    await page.run(`(() => {
        document.getElementById('mcpTabBtn').click();
        document.getElementById('serverUrl').value = ${JSON.stringify(url)};
        document.getElementById('serverAlias').value = ${JSON.stringify(alias)};
        document.getElementById('addServerBtn').click();
        document.getElementById('initProtocol').click();
    })()`);
    return page.waitFor(`(() => {
        const s = chatShell.servers[${JSON.stringify(url)}];
        return s && ['connected', 'failed'].includes(s.status)
            ? { status: s.status, era: s.era, version: s.protocolVersion, name: s.name, error: s.lastError }
            : null;
    })()`);
}

async function toolNames(page, url) {
    const names = await page.waitFor(`(() => {
        const tools = chatShell.servers[${JSON.stringify(url)}]?.tools || [];
        return tools.length ? tools.map(t => t.name) : null;
    })()`);
    return names || [];
}

async function callTool(page, url, tool, values) {
    await page.run(`(() => {
        document.getElementById('mcpTabBtn').click();
        const item = [...document.querySelectorAll('.server-name')].find(el => el.title === ${JSON.stringify(url)});
        item.closest('.server-item').click();
        const toolItem = [...document.querySelectorAll('#toolsList .tool-item')].find(el => el.textContent === ${JSON.stringify(tool)});
        toolItem.click();
        for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
            document.querySelector('#toolCard [name="' + name + '"]').value = value;
        }
        document.getElementById('toolResultCard').innerHTML = '';
        document.querySelector('#toolCard form').requestSubmit();
    })()`);
    return page.waitFor(`(() => {
        const text = document.getElementById('toolResultCard').innerText.trim();
        return text ? text.replace(/\\s+/g, ' ') : null;
    })()`, 20000);
}

async function main() {
    if (!CHROME) throw new Error('Google Chrome not found; set CHROME_PATH');
    const referencePython = join(ROOT, 'venv', 'bin', 'python');
    if (WITH_REFERENCE && !existsSync(referencePython)) {
        throw new Error('--reference needs the venv: run ./setup.sh or npm run setup:python');
    }

    start('app', PYTHON, ['-m', 'http.server', String(PORTS.app), '--bind', '127.0.0.1', '--directory', 'public']);
    start('modern', PYTHON, ['test_mcp_server.py', '--mode', 'modern', '--port', String(PORTS.modern)]);
    start('modern+sse', PYTHON, ['test_mcp_server.py', '--mode', 'modern', '--sse', '--port', String(PORTS.sse)]);
    start('legacy', PYTHON, ['test_mcp_server.py', '--mode', 'legacy', '--port', String(PORTS.legacy)]);
    start('legacy+sse', PYTHON, ['test_mcp_server.py', '--mode', 'legacy', '--sse', '--port', String(PORTS.legacySse)]);
    start('dual', PYTHON, ['test_mcp_server.py', '--mode', 'dual', '--port', String(PORTS.dual)]);
    if (WITH_REFERENCE) {
        start('reference', referencePython, ['tests/reference_server.py', '--port', String(PORTS.reference)]);
    }
    for (const port of Object.entries(PORTS).filter(([name]) => name !== 'devtools' && (WITH_REFERENCE || name !== 'reference')).map(([, p]) => p)) {
        await waitForHttp(`${HOST}:${port}/`);
    }

    const profile = mkdtempSync(join(tmpdir(), 'mcp-smoke-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profile}`, `--remote-debugging-port=${PORTS.devtools}`, 'about:blank',
    ], { stdio: 'ignore' });
    children.push(chrome);

    let page;
    try {
        page = await openPage();
        await page.send('Page.navigate', { url: `${HOST}:${PORTS.app}/` });
        const healthy = await page.waitFor(`
            document.getElementById('sw-status').classList.contains('healthy') &&
            document.getElementById('wasm-status').classList.contains('healthy') &&
            !!chatShell.serviceWorker`);
        check('app loads with the service worker and WASM running', !!healthy);

        const targets = [
            { label: 'modern server', url: `${HOST}:${PORTS.modern}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count'] },
            { label: 'modern server with SSE replies', url: `${HOST}:${PORTS.sse}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count'] },
            { label: 'legacy server', url: `${HOST}:${PORTS.legacy}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'legacy server with SSE replies', url: `${HOST}:${PORTS.legacySse}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'dual-era server', url: `${HOST}:${PORTS.dual}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count'] },
        ];
        if (WITH_REFERENCE) {
            targets.push({ label: 'official Python SDK server', url: `${HOST}:${PORTS.reference}/mcp`, era: 'modern', version: '2026-07-28', tools: ['echo', 'add'] });
        }

        for (const target of targets) {
            const connection = await addAndConnect(page, target.url, target.label);
            check(`${target.label}: connects as ${target.era} ${target.version}`,
                connection?.status === 'connected' && connection.era === target.era && connection.version === target.version,
                JSON.stringify(connection));
            const names = await toolNames(page, target.url);
            check(`${target.label}: lists ${target.tools.join(', ')}`,
                target.tools.every(t => names.includes(t)) && names.length === target.tools.length, names.join(', '));
            const echo = await callTool(page, target.url, 'echo', { text: `smoke ${target.era}` });
            check(`${target.label}: calls echo`, !!echo?.includes(`Echo: smoke ${target.era}`), echo);
        }

        const modernUrl = `${HOST}:${PORTS.modern}/`;
        const region = await callTool(page, modernUrl, 'echo_region', { region: 'Zürich', text: 'hi' });
        check('modern server: mirrors x-mcp-header parameters into Mcp-Param headers',
            !!region?.includes('Echo from Zürich: hi'), region);
        const counted = await callTool(page, `${HOST}:${PORTS.sse}/`, 'count', { n: 3 });
        check('modern server with SSE replies: reads a streamed reply', !!counted?.includes('Counted to 3'), counted);

        const picker = await page.waitFor(`[...document.getElementById('chatToolSelect').options].map(o => o.value).join(',') || null`);
        check('console tool picker is populated', !!picker, picker);

        await page.send('ServiceWorker.stopAllWorkers');
        await sleep(300);
        const afterRestart = await callTool(page, modernUrl, 'echo', { text: 'after restart' });
        check('calls still work after the browser stops the service worker', !!afterRestart?.includes('Echo: after restart'), afterRestart);

        const unreachable = await addAndConnect(page, `${HOST}:18099/`, 'nothing here');
        check('an unreachable server fails with an explanation',
            unreachable?.status === 'failed' && /Couldn't reach/.test(unreachable.error || ''), unreachable?.error);

        if (WITH_REFERENCE) {
            const wrongPath = await addAndConnect(page, `${HOST}:${PORTS.reference}/`, 'wrong path');
            check('a URL without an MCP endpoint points at /mcp',
                wrongPath?.status === 'failed' && /\/mcp/.test(wrongPath.error || ''), wrongPath?.error);
        }

        check('no uncaught page errors', page.exceptions.length === 0, page.exceptions.join(' | '));
    } finally {
        page?.close();
        chrome.kill();
        await sleep(300);
        rmSync(profile, { recursive: true, force: true });
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        for (const child of children.filter(c => c.label)) {
            console.log(`\n--- ${child.label} output ---\n${child.output.trim().split('\n').slice(-15).join('\n')}`);
        }
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(stopAll);
