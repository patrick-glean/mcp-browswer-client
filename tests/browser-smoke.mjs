#!/usr/bin/env node
// Browser smoke test: loads the app in headless Chrome and drives the real UI against mock MCP
// servers (modern, streaming, legacy, dual-era, strict CORS, token-protected, OAuth sign-in) and, with
// --reference, a server built on the official Python SDK. --public also connects to the public
// servers the in-app guide suggests, through the guide's own buttons (needs internet access).
// --client= picks the MCP client library the app runs on, a name from public/mcp-clients.js; without
// it, the app runs on its default library, as a first visit does.
//
//   node tests/browser-smoke.mjs [--client=sdk|wasm] [--reference] [--public]
//
// Needs Node 22+, Google Chrome (or CHROME_PATH), python3, and for --reference the venv that
// setup.sh creates. Exits non-zero if any check fails.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize as normalizePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLIENT, MCP_CLIENTS } from '../public/mcp-clients.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WITH_REFERENCE = process.argv.includes('--reference');
const WITH_PUBLIC = process.argv.includes('--public');
// The MCP client library under test.
const CLIENT_NAME = process.argv.find(arg => arg.startsWith('--client='))?.slice('--client='.length) ?? DEFAULT_CLIENT.name;
const CLIENT = MCP_CLIENTS[CLIENT_NAME];
if (!CLIENT) throw new Error(`--client must be ${Object.keys(MCP_CLIENTS).join(' or ')}, not ${CLIENT_NAME}`);
const HOST = 'http://127.0.0.1';
const PORTS = {
    app: 18080, modern: 18081, sse: 18082, legacy: 18083, legacySse: 18084, dual: 18085, reference: 18086,
    strictLegacy: 18087, token: 18088, strictModern: 18089, oauth: 18090, oauthWrongIss: 18091,
    oauthNoExpiry: 18092,
    // Chosen per run (see freePort), so a Chrome from an earlier run that's still exiting
    // can't answer for this one.
    devtools: null,
};
const TOKEN = 'smoke-secret-token';
// A CORS policy written before 2026-07-28: no Mcp-Method, Mcp-Name or Mcp-Param-* headers.
const OLD_CORS_HEADERS = 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version';
const PYTHON = process.env.PYTHON || 'python3';
const CHROME = process.env.CHROME_PATH || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].find(existsSync);

// The guide's public servers, with a call that should work without an account.
const PUBLIC_TARGETS = [
    { label: 'Hugging Face', url: 'https://huggingface.co/mcp', tool: 'hub_repo_search', args: { query: 'whisper', limit: '2' }, expect: /whisper/i },
    { label: 'Context7', url: 'https://mcp.context7.com/mcp', tool: 'resolve-library-id', args: { libraryName: 'react', query: 'hooks' }, expect: /react/i },
    { label: 'Microsoft Learn', url: 'https://learn.microsoft.com/api/mcp', tool: 'microsoft_docs_search', args: { query: 'service worker' }, expect: /worker/i },
    { label: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', tool: 'read_wiki_structure', args: { repoName: 'modelcontextprotocol/modelcontextprotocol' }, expect: /\w{4,}/ },
];

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

function mock(name, port, ...flags) {
    return start(name, PYTHON, ['test_mcp_server.py', '--port', String(port), ...flags]);
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
};

// Serves public/ the way `npm start` does, without the dependency. Python's http.server resets
// connections when many requests arrive at once, as the page's and worker's modules do.
function serveApp(port) {
    const root = join(ROOT, 'public');
    const app = { label: 'app', output: '' };
    const server = createHttpServer((request, response) => {
        let file = normalizePath(join(root, decodeURIComponent(new URL(request.url, HOST).pathname)));
        let status = 200;
        try {
            if (!file.startsWith(root)) throw new Error('outside public/');
            if (statSync(file).isDirectory()) file = join(file, 'index.html');
            response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            createReadStream(file).on('error', () => response.destroy()).pipe(response);
        } catch {
            status = 404;
            response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        }
        app.output += `${request.method} ${request.url} -> ${status}\n`;
    });
    app.kill = () => server.close();
    children.push(app);
    server.listen(port, '127.0.0.1');
}

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

// Chrome keeps writing to its profile while it shuts down, so wait for it before deleting that.
async function stopChrome(chrome) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return;
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    const force = setTimeout(() => chrome.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
}

// Chrome can still be saving its preferences as it exits, which puts a file back into the
// directory being removed. A profile left in the temp directory isn't a failed check.
async function removeProfile(profile) {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            rmSync(profile, { recursive: true, force: true });
            return;
        } catch {
            await sleep(300);
        }
    }
    notice('cleanup', `couldn't delete Chrome's profile, ${profile}`);
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

// Worth knowing but neither a pass nor a fail, such as what a third-party server offers.
function notice(name, detail) {
    console.log(`NOTE  ${name}  (${detail})`);
}

// A small Chrome DevTools Protocol client for one page target.
async function openPage(match = () => true) {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
        try {
            const targets = await (await fetch(`${HOST}:${PORTS.devtools}/json`)).json();
            target = targets.find(t => t.type === 'page' && match(t));
        } catch {
            // Chrome is still starting.
        }
        if (!target) await sleep(100);
    }
    if (!target) throw new Error('No matching Chrome page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const exceptions = [];
    const listeners = new Map();
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        } else if (message.method === 'Runtime.exceptionThrown') {
            const details = message.params.exceptionDetails;
            exceptions.push(details.exception?.description ?? details.text);
        } else if (listeners.has(message.method)) {
            listeners.get(message.method)(message.params);
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
    const on = (method, listener) => listeners.set(method, listener);
    return { id: target.id, send, run, waitFor, on, exceptions, close: () => ws.close() };
}

async function closeTab(page) {
    page.close();
    await fetch(`${HOST}:${PORTS.devtools}/json/close/${page.id}`).catch(() => {});
}

// A separate browser context: its own storage and no service worker, like signing in from Chrome
// while the client runs in a browser without pop-ups.
async function otherBrowser() {
    const { webSocketDebuggerUrl } = await (await fetch(`${HOST}:${PORTS.devtools}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
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
        }
    });
    const send = (method, params = {}, sessionId) => new Promise(resolve => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { browserContextId } = (await send('Target.createBrowserContext')).result;
    return {
        async open(url) {
            const { targetId } = (await send('Target.createTarget', { url, browserContextId })).result;
            const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })).result;
            const run = async expression =>
                (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
            const waitFor = async (expression, ms = 15000) => {
                const end = Date.now() + ms;
                while (Date.now() < end) {
                    const value = await run(expression);
                    if (value) return value;
                    await sleep(150);
                }
                return null;
            };
            return { run, waitFor };
        },
        async close() {
            await send('Target.disposeBrowserContext', { browserContextId });
            ws.close();
        },
    };
}

// UI helpers: everything goes through the same buttons and forms a person would use.
function connectionState(url) {
    return `(() => {
        const s = appShell.servers[${JSON.stringify(url)}];
        return s && ['connected', 'failed'].includes(s.status)
            ? { status: s.status, era: s.era, version: s.protocolVersion, name: s.name, error: s.lastError }
            : null;
    })()`;
}

// Page snippets for the Workbench's parts.
const showWorkbench = `document.querySelector('[data-mode="workbench"]').click()`;
const serverRow = url => `document.querySelector('#serverList .wb-server[data-url="' + CSS.escape(${JSON.stringify(url)}) + '"]')`;
const toolRow = tool => `document.querySelector('#toolList .wb-tool[data-tool="' + CSS.escape(${JSON.stringify(tool)}) + '"]')`;
// The response pane's text once the run is in.
const shownResult = `(() => {
    const pane = document.getElementById('responsePane');
    const text = pane.innerText.trim();
    return text && !pane.querySelector('[data-pending]') ? text.replace(/\\s+/g, ' ') : null;
})()`;

// Adding a server (with + beside Servers) connects to it.
async function addAndConnect(page, url, alias, ms) {
    await page.run(`(() => {
        ${showWorkbench};
        if (document.getElementById('addServerForm').hidden) document.getElementById('addServerToggle').click();
        document.getElementById('serverUrl').value = ${JSON.stringify(url)};
        document.getElementById('serverAlias').value = ${JSON.stringify(alias)};
        document.getElementById('addServerBtn').click();
    })()`);
    return page.waitFor(connectionState(url), ms);
}

async function toolNames(page, url, ms) {
    const names = await page.waitFor(`(() => {
        const tools = appShell.servers[${JSON.stringify(url)}]?.tools || [];
        return tools.length ? tools.map(t => t.name) : null;
    })()`, ms);
    return names || [];
}

// Picks the server and tool, fills in the fields and runs it, as a person would. The tool list
// comes a moment after the connection, so wait for the tool's row.
async function callTool(page, url, tool, values, ms = 20000) {
    await page.run(`(() => {
        ${showWorkbench};
        ${serverRow(url)}.click();
    })()`);
    await page.waitFor(`!!${toolRow(tool)}`, ms);
    await page.run(`(() => {
        ${toolRow(tool)}.click();
        for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
            document.querySelector('#requestForm [name="' + name + '"]').value = value;
        }
        document.getElementById('responsePane').innerHTML = '';
        document.getElementById('requestForm').requestSubmit();
    })()`);
    return page.waitFor(shownResult, ms);
}

// Opens a dock tab (clicking an open tab would collapse the dock).
const showDock = tab => `(() => {
    const button = document.querySelector('[data-dock-tab="${tab}"]');
    if (button.getAttribute('aria-selected') !== 'true') button.click();
})()`;

// The log's entries, for checks that the right things were (and weren't) logged.
const entries = `appShell.logPanel.entries`;

// Chooses Sign in on the selected server's card, as a click (pop-up windows need one), then waits
// for `until`. The mock approves at once, so the pop-up goes straight to the callback page.
async function signIn(page, until, ms = 20000) {
    await page.send('Runtime.evaluate', { expression: `document.getElementById('signInBtn').click()`, userGesture: true });
    return page.waitFor(until, ms);
}

// What the worker keeps in IndexedDB for a server's sign-in.
function storedTokens(url) {
    return `new Promise((resolve, reject) => {
        const open = indexedDB.open('mcp_auth');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const request = open.result.transaction('tokens').objectStore('tokens').get(${JSON.stringify(url)});
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        };
    })`;
}

async function main() {
    if (!CHROME) throw new Error('Google Chrome not found; set CHROME_PATH');
    const referencePython = join(ROOT, 'venv', 'bin', 'python');
    if (WITH_REFERENCE && !existsSync(referencePython)) {
        throw new Error('--reference needs the venv: run ./setup.sh or npm run setup:python');
    }

    serveApp(PORTS.app);
    mock('modern', PORTS.modern, '--mode', 'modern');
    mock('modern+sse', PORTS.sse, '--mode', 'modern', '--sse');
    mock('legacy', PORTS.legacy, '--mode', 'legacy');
    mock('legacy+sse', PORTS.legacySse, '--mode', 'legacy', '--sse');
    mock('dual', PORTS.dual, '--mode', 'dual');
    mock('legacy+old CORS', PORTS.strictLegacy, '--mode', 'legacy', '--allow-headers', OLD_CORS_HEADERS);
    mock('token', PORTS.token, '--mode', 'modern', '--token', TOKEN);
    mock('modern+old CORS', PORTS.strictModern, '--mode', 'modern', '--allow-headers', OLD_CORS_HEADERS);
    // Like Glean, this one doesn't let pages read WWW-Authenticate. Its tokens last 62 s, so two
    // seconds in they're inside the client's one-minute refresh margin.
    mock('oauth', PORTS.oauth, '--mode', 'modern', '--oauth', '--hide-www-authenticate', '--token-ttl', '62');
    mock('oauth+wrong iss', PORTS.oauthWrongIss, '--mode', 'modern', '--oauth', '--oauth-wrong-iss');
    mock('oauth+no expires_in', PORTS.oauthNoExpiry, '--mode', 'modern', '--oauth', '--token-ttl', '2', '--omit-expires-in');
    if (WITH_REFERENCE) {
        start('reference', referencePython, ['tests/reference_server.py', '--port', String(PORTS.reference)]);
    }
    for (const [name, port] of Object.entries(PORTS)) {
        if (name === 'devtools' || (name === 'reference' && !WITH_REFERENCE)) continue;
        await waitForHttp(`${HOST}:${port}/`);
    }

    PORTS.devtools = await freePort();
    const profile = mkdtempSync(join(tmpdir(), 'mcp-smoke-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        // A freshly started headless Chrome launches its built-in extensions' service workers
        // over the first seconds, and doing so can stop the app's worker mid-request.
        '--disable-extensions', '--disable-component-extensions-with-background-pages',
        `--user-data-dir=${profile}`, `--remote-debugging-port=${PORTS.devtools}`, 'about:blank',
    ], { stdio: 'ignore' });
    children.push(chrome);

    let page;
    try {
        page = await openPage();
        console.log(`Testing the app on the ${CLIENT.label}`);
        // Chat data as the app saved it before its agent loop's names changed (engramId, the
        // CBus tap, imprints), on the app's origin before the app first loads.
        await page.send('Page.navigate', { url: `${HOST}:${PORTS.app}/seed-old-chat-data` });
        await page.waitFor(`location.pathname === '/seed-old-chat-data' && document.readyState === 'complete'`);
        await page.run(`new Promise((resolve, reject) => {
            localStorage.setItem('lastEngramId', 'smoke-old-conversation');
            localStorage.setItem('cbusTapConfig', JSON.stringify({ serverUrl: 'http://127.0.0.1:9/', toolName: 'echo', args: { text: '{{cbus_message}}' }, connectedStringArg: 'text', connectedArrayArg: null }));
            localStorage.setItem('mcp_module_metadata', JSON.stringify({ version: '1.0.0', memory_events: [{ id: 'imprint-1', name: 'Old context', text: 'Answer briefly.', timestamp: 1 }], last_health_check: 1 }));
            const open = indexedDB.open('chat_contexts', 1);
            open.onupgradeneeded = () => {
                open.result.createObjectStore('conversations', { keyPath: 'engramId' });
                open.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('engramId', 'engramId');
            };
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction(['conversations', 'messages'], 'readwrite');
                tx.objectStore('conversations').put({ engramId: 'smoke-old-conversation', meta: { created: 1, engramId: 'smoke-old-conversation' } });
                tx.objectStore('messages').put({ id: '00000000-0001', text: 'A question from before the rename', role: 'user', timestamp: 1, engramId: 'smoke-old-conversation' });
                tx.objectStore('messages').put({ id: '00000000-0002', text: 'An answer from before the rename', role: 'tool', timestamp: 2, engramId: 'smoke-old-conversation' });
                tx.oncomplete = () => { db.close(); resolve(true); };
                tx.onerror = () => reject(tx.error);
            };
        })`);
        // The default library needs no ?client=: a first visit runs on it.
        await page.send('Page.navigate', { url: `${HOST}:${PORTS.app}/${CLIENT === DEFAULT_CLIENT ? '' : `?client=${CLIENT.name}`}` });
        // Until the navigation commits, the page is still the seed page, which has none of these.
        const healthy = await page.waitFor(`
            !!document.getElementById('sw-status')?.classList.contains('healthy') &&
            !!document.getElementById('client-status')?.classList.contains('healthy') &&
            typeof appShell !== 'undefined' && !!appShell.serviceWorker && !!appShell.workbench`);
        check('app loads with the service worker, the MCP client and the Workbench running', !!healthy);
        const carriedOver = await page.waitFor(`(() => {
            const shown = [...document.querySelectorAll('#chatMessages .chat-msg')].map(m => m.textContent);
            const model = JSON.parse(localStorage.getItem('chatModel') || 'null');
            const context = JSON.parse(localStorage.getItem('chatContext') || 'null');
            const leftOver = ['lastEngramId', 'cbusTapConfig', 'mcp_module_metadata'].filter(key => localStorage.getItem(key) !== null);
            return shown.includes('A question from before the rename') && shown.includes('An answer from before the rename')
                && localStorage.getItem('lastChatConversation') === 'smoke-old-conversation'
                && model?.messageField === 'text' && model.args?.text === '{{message}}' && !('connectedStringArg' in model)
                && context?.[0]?.name === 'Old context' && leftOver.length === 0 ? shown.length : null;
        })()`, 10000);
        check('Chat app: conversations and settings saved before the rename carry over', !!carriedOver, carriedOver ? `${carriedOver} messages shown` : 'not carried over');
        const frame = await page.run(`(() => {
            const areas = ['wb-rail', 'wb-server-bar', 'wb-tools', 'wb-request', 'wb-response', 'wb-dock']
                .filter(name => customElements.get(name) && document.querySelector(name)?.getBoundingClientRect().width > 0);
            return areas.join(', ');
        })()`);
        check('Workbench: every part of layout B is on the page', frame === 'wb-rail, wb-server-bar, wb-tools, wb-request, wb-response, wb-dock', frame);

        const firstVisit = await page.run(`!document.getElementById('guide').hidden`);
        check('the guide opens on the first visit', firstVisit);
        const guide = await page.run(`(() => {
            document.getElementById('closeGuide').click();
            const closed = document.getElementById('guide').hidden;
            document.getElementById('guideBtn').click();
            const reopened = !document.getElementById('guide').hidden;
            const servers = [...document.querySelectorAll('#guide [data-add-server]')].map(b => b.dataset.addServer);
            document.getElementById('closeGuide').click();
            return { closed, reopened, servers, command: document.getElementById('mockCommand').textContent };
        })()`);
        check('the guide closes, reopens from the header and offers servers to add',
            guide.closed && guide.reopened && guide.servers.length >= 5 && guide.command === 'python3 test_mcp_server.py',
            `${guide.servers.length} servers; ${guide.command}`);
        const loaded = await page.waitFor(`${entries}.some(e => e.source === 'worker' && e.message.startsWith(${JSON.stringify(`Loaded the ${CLIENT.label} (`)}))`, 5000);
        check('logs: the worker reports the client build it loaded', !!loaded);

        const targets = [
            { label: 'modern server', url: `${HOST}:${PORTS.modern}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket', 'search_notes'] },
            { label: 'modern server with SSE replies', url: `${HOST}:${PORTS.sse}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket', 'search_notes'] },
            { label: 'legacy server', url: `${HOST}:${PORTS.legacy}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'legacy server with SSE replies', url: `${HOST}:${PORTS.legacySse}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'dual-era server', url: `${HOST}:${PORTS.dual}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket', 'search_notes'] },
            { label: 'legacy server whose CORS policy predates 2026-07-28', url: `${HOST}:${PORTS.strictLegacy}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
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

        // The inspector views of the modern mock: echo has a title and annotations, count an output
        // schema, and broken_header is hidden.
        const inspector = await page.run(`(() => {
            ${showWorkbench};
            ${serverRow(modernUrl)}.click();
            const item = name => document.querySelector('#toolList .wb-tool[data-tool="' + name + '"]');
            // The request pane's title and badges for a tool.
            const described = name => {
                item(name).click();
                const pane = document.getElementById('requestPane');
                return [pane.querySelector('.wb-request-title').textContent, ...[...pane.querySelectorAll('.badge')].map(b => b.textContent)];
            };
            const filter = document.getElementById('toolFilter');
            filter.value = 'region';
            filter.dispatchEvent(new Event('input', { bubbles: true }));
            const visible = [...document.querySelectorAll('#toolList .wb-tool')].map(el => el.dataset.tool);
            const count = document.getElementById('toolCount').textContent;
            filter.value = '';
            filter.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('[data-hint-filter="writes"]').click();
            const writes = [...document.querySelectorAll('#toolList .wb-tool')].map(el => el.dataset.tool).join(', ');
            document.querySelector('[data-hint-filter="all"]').click();
            const hints = ['echo', 'echo_region', 'ticket'].map(name => name + ' ' + item(name).querySelector('.wb-hints').textContent).join('; ');
            const echo = described('echo').join(', ');
            const countBadges = described('count').slice(1).join(', ');
            const schemas = [...document.querySelectorAll('#requestPane .tool-schema summary')].map(s => s.textContent).join(', ');
            const hidden = document.getElementById('hiddenTools');
            document.getElementById('serverInfoBtn').click();
            const connection = document.getElementById('serverConnection')?.innerText.replace(/\\s+/g, ' ') || '';
            document.querySelector('wb-sheet [data-close-sheet]').click();
            return {
                echo, count: countBadges, schemas, hints, writes, connection,
                filtered: visible.join(', ') + ' (' + count + ')',
                hidden: hidden ? hidden.innerText.replace(/\\s+/g, ' ') : '',
            };
        })()`);
        check('inspector: a tool shows its title and annotation badges',
            inspector.echo === 'Echo, read-only' && inspector.count === 'read-only, idempotent, structured output', `echo: ${inspector.echo}; count: ${inspector.count}`);
        check('inspector: tool rows mark read-only, writing and undeclared tools', inspector.hints === 'echo ro; echo_region ?; ticket writes', inspector.hints);
        check('inspector: the filter narrows the list and the count follows', inspector.filtered === 'echo_region (1 of 5)', inspector.filtered);
        check('inspector: Writes lists the tools that don\'t say they only read', inspector.writes === 'echo_region, ticket', inspector.writes);
        check('inspector: a tool shows its input and output schemas and raw definition',
            inspector.schemas === 'Input schema, Output schema, Definition (raw JSON)', inspector.schemas);
        check('inspector: hidden tools are listed with the reason', /1 hidden tool/.test(inspector.hidden) && /broken_header/.test(inspector.hidden), inspector.hidden);
        check('inspector: Info shows what the server said about itself',
            /Mock MCP Server 2\.0\.0/.test(inspector.connection) && /Capabilities prompts resources tools/.test(inspector.connection), inspector.connection);
        // The mock has too few tools to be grouped, so the grouping is checked on GitHub's names.
        const groups = await page.run(`import('./workbench/components/tools.js').then(({ groupTools }) => {
            const names = ['get_me', 'list_issues', 'get_issue', 'create_issue', 'add_issue_comment', 'list_pull_requests', 'get_pull_request',
                'create_pull_request', 'merge_pull_request', 'list_branches', 'create_branch', 'search_code'];
            return groupTools(names.map(name => ({ name }))).map(([word, members]) => word + ' ' + members.length).join(', ');
        })`);
        check('inspector: big servers\' tools are grouped by what they work on', groups === 'branch 2, issue 4, pull request 4, other 2', groups);
        const downloads = mkdtempSync(join(tmpdir(), 'mcp-smoke-downloads-'));
        await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        await page.run(`document.getElementById('downloadToolsBtn').click()`);
        let downloaded;
        for (let i = 0; i < 50 && !downloaded; i++) {
            downloaded = readdirSync(downloads).find(name => name.endsWith('.json'));
            if (!downloaded) await sleep(100);
        }
        const report = downloaded ? JSON.parse(readFileSync(join(downloads, downloaded), 'utf8')) : null;
        rmSync(downloads, { recursive: true, force: true });
        check('inspector: Download saves the server details and tool list as JSON',
            report?.server === modernUrl && report.tools.length === 5 && report.hiddenTools[0]?.name === 'broken_header' && report.serverInfo?.name === 'Mock MCP Server',
            downloaded || 'no file');

        // Resources and prompts, in the tabs beside Tools. The mock lists two items a page.
        const showView = view => page.run(`document.querySelector('wb-tools [data-view="${view}"]').click()`);
        const shownContents = `(() => {
            const pane = document.getElementById('contentsPane');
            return pane.querySelector('.run-summary') ? pane.innerText.replace(/\\s+/g, ' ') : null;
        })()`;
        const setInput = (form, name, value) => `(() => {
            const input = document.querySelector('#${form} [name="${name}"]');
            input.value = ${JSON.stringify(value)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })();`;
        const readItem = async (kind, key, setup = '') => {
            await page.run(`(() => {
                document.getElementById('contentsPane').innerHTML = '';
                document.querySelector('#toolList [data-${kind}="${key}"]').click();
                ${setup}
                document.querySelector('#resourcePane [data-read]').click();
            })()`);
            return page.waitFor(shownContents, 10000);
        };
        const getPrompt = async (name, setup = '') => {
            await page.run(`(() => {
                document.getElementById('contentsPane').innerHTML = '';
                document.querySelector('#toolList [data-prompt="${name}"]').click();
                ${setup}
                document.querySelector('#promptPane [data-get]').click();
            })()`);
            return page.waitFor(shownContents, 10000);
        };
        await page.run(`${serverRow(modernUrl)}.click()`);
        await page.waitFor(`!document.querySelector('wb-tools [data-view="resources"]').disabled && !document.querySelector('wb-tools [data-view="prompts"]').disabled`, 5000);
        await showView('resources');
        const listed = await page.waitFor(`(() => {
            const rows = [...document.querySelectorAll('#toolList .wb-pick')].map(row => Object.entries(row.dataset)[0].join(':'));
            return rows.length === 4 ? rows.join(', ') + ' (' + document.querySelector('wb-tools [data-view="resources"] .wb-meta').textContent + ')' : null;
        })()`, 5000);
        check('resources: the Resources tab lists every page of resources, then the templates',
            listed === 'resource:mock://readme, resource:mock://config.json, resource:mock://pixel.png, template:mock://notes/{id} (4)', listed);
        const readme = await readItem('resource', 'mock://readme');
        check('resources: reading a text resource shows its text', /OK/.test(readme || '') && /# Mock MCP Server/.test(readme || ''), readme?.slice(0, 120));
        const pixel = await readItem('resource', 'mock://pixel.png');
        const pixelImage = await page.waitFor(`(() => {
            const image = document.querySelector('#contentsPane img.wb-content-image');
            return image?.complete && image.naturalWidth ? image.naturalWidth + 'x' + image.naturalHeight : null;
        })()`, 5000);
        check('resources: a binary resource shows as an image, with its size and a download',
            pixelImage === '1x1' && /70 bytes of image\/png · Download/.test(pixel || ''), `${pixelImage}; ${pixel?.slice(0, 120)}`);
        const note = await readItem('template', 'mock://notes/{id}', setInput('resourceForm', 'id', '42'));
        check('resources: a template\'s fields make the URI it reads', /mock:\/\/notes\/42/.test(note || '') && /Note 42/.test(note || ''), note?.slice(0, 120));
        const missing = await readItem('template', 'mock://notes/{id}', setInput('resourceForm', 'id', 'nope'));
        check('resources: one the server doesn\'t have comes back as its error', /Failed/.test(missing || '') && /Resource not found/.test(missing || ''), missing?.slice(0, 160));
        await showView('prompts');
        const greeting = await getPrompt('greet', setInput('promptForm', 'name', 'Ada') + setInput('promptForm', 'style', 'formal'));
        check('prompts: a prompt\'s arguments go to the server and its messages come back', /Write a formal greeting for Ada\./.test(greeting || ''), greeting?.slice(0, 120));
        const withoutName = await getPrompt('greet', setInput('promptForm', 'name', ''));
        check('prompts: a missing required argument comes back as the server\'s error', /Failed/.test(withoutName || '') && /needs the argument name/.test(withoutName || ''), withoutName?.slice(0, 160));
        const summary = await getPrompt('summarize_server');
        check('prompts: a message can carry a resource, which shows with its text',
            /mock:\/\/readme/.test(summary || '') && /# Mock MCP Server/.test(summary || '') && /Summarize what this server offers/.test(summary || ''), summary?.slice(0, 160));
        await page.run(`${serverRow(`${HOST}:${PORTS.legacy}/`)}.click()`);
        await page.waitFor(`!document.querySelector('wb-tools [data-view="resources"]').disabled`, 5000);
        await showView('resources');
        const legacyReadme = await readItem('resource', 'mock://readme');
        check('resources: a 2025-era server lists and reads them too', /# Mock MCP Server/.test(legacyReadme || ''), legacyReadme?.slice(0, 120));
        await page.run(`${serverRow(modernUrl)}.click()`);
        await showView('tools');
        const toolsBack = await page.run(`['requestPane', 'responsePane'].every(id => !document.getElementById(id).hidden)
            && ['resourcePane', 'promptPane', 'contentsPane'].every(id => document.getElementById(id).hidden)`);
        check('resources and prompts: back on Tools, the tool panes return', toolsBack);

        // Splitters, at a width where request and response sit side by side.
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        const toolsWidth = `Math.round(document.querySelector('wb-tools').getBoundingClientRect().width)`;
        const handle = await page.waitFor(`(() => {
            const box = document.querySelector('.wb-area-split-tools').getBoundingClientRect();
            return box.height ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
        })()`, 5000);
        const before = await page.run(toolsWidth);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y });
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 60, y: handle.y, button: 'left', buttons: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 60, y: handle.y, button: 'left', clickCount: 1 });
        const dragged = await page.run(toolsWidth);
        const kept = await page.run(`Math.round(JSON.parse(localStorage.getItem('workbenchPanes') || '{}').tools || 0)`);
        await page.run(`document.querySelector('.wb-area-split-tools').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
        const reset = await page.run(toolsWidth);
        await page.send('Emulation.clearDeviceMetricsOverride');
        check('splitters: dragging an edge resizes the pane beside it and keeps the size, and a double-click resets it',
            dragged === before + 60 && kept === dragged && reset === before, `${before} → ${dragged} (kept ${kept}) → ${reset}`);

        const picker = await page.waitFor(`[...document.getElementById('chatToolSelect').options].map(o => o.value).join(',') || null`);
        check('the Chat app\'s tool picker is populated', !!picker, picker);

        // The README's chat walkthrough: open Apps, pick a server and tool, tick the field your
        // message goes to, send a message.
        await page.run(`(() => {
            document.querySelector('[data-mode="apps"]').click();
            const server = document.getElementById('chatServerSelect');
            server.value = ${JSON.stringify(modernUrl)};
            server.dispatchEvent(new Event('change'));
            const tool = document.getElementById('chatToolSelect');
            tool.value = 'echo';
            tool.dispatchEvent(new Event('change'));
        })()`);
        await page.waitFor(`!!document.querySelector('#chatToolConfigForm .chat-message-field[data-field="text"]')`, 5000);
        await page.run(`(() => {
            const box = document.querySelector('#chatToolConfigForm .chat-message-field[data-field="text"]');
            box.checked = true;
            box.dispatchEvent(new Event('change'));
            document.getElementById('chatUserInput').value = 'hello from the console';
            document.getElementById('chatSendBtn').disabled = false;
            document.getElementById('chatSendBtn').click();
        })()`);
        const chatted = await page.waitFor(`[...document.querySelectorAll('#chatMessages .chat-msg.tool')].some(m => m.textContent.includes('Echo: hello from the console'))`);
        const appsShown = await page.run(`!document.getElementById('appsPage').hidden && document.getElementById('workbench').hidden`);
        check('the Chat app sends a message through the chosen tool', !!chatted && appsShown);
        await page.run(showWorkbench);

        const trace = await page.run(`${entries}.some(e => e.source === ${JSON.stringify(CLIENT.logSource)} && e.level === 'debug' && e.message.startsWith('→ server/discover'))`);
        check('logs: the MCP client traces each HTTP request', trace);
        const why = await page.run(`${entries}.some(e => e.source === ${JSON.stringify(CLIENT.logSource)} && e.server === ${JSON.stringify(`${HOST}:${PORTS.legacy}/`)} && /looks like a 2025-era server/.test(e.message))`);
        check('logs: the legacy fallback says why it happened', why);
        const cors = await page.run(`${entries}.some(e => e.server === ${JSON.stringify(`${HOST}:${PORTS.strictLegacy}/`)} && /CORS rejects the 2026-07-28 headers/.test(e.message))`);
        check('logs: the fallback after a blocked request says CORS may be why', cors);
        const timings = await page.run(`(() => {
            const worker = ${entries}.filter(e => e.source === 'worker' && e.level === 'info').map(e => e.message);
            return ['^Connected to .+ in \\\\d+ ms', '^Listed \\\\d+ tools? in \\\\d+ ms', '^echo returned in \\\\d+ ms']
                .every(pattern => worker.some(message => new RegExp(pattern).test(message)));
        })()`);
        check('logs: connects, listings and calls report how long they took', timings);
        const hidden = await page.run(`${entries}.some(e => e.level === 'warn' && /^Hiding tool broken_header/.test(e.message))`);
        check('logs: hidden tools are explained', hidden);
        const levels = await page.run(`(() => {
            const debugShown = () => document.querySelectorAll('#log-container .log-entry.level-debug').length;
            const select = document.getElementById('logLevel');
            const atInfo = debugShown();
            select.value = 'debug';
            select.dispatchEvent(new Event('change'));
            const atDebug = debugShown();
            select.value = 'info';
            select.dispatchEvent(new Event('change'));
            return { atInfo, atDebug };
        })()`);
        check('logs: Info hides the HTTP trace and Everything shows it', levels.atInfo === 0 && levels.atDebug > 0, JSON.stringify(levels));
        const escaped = await page.run(`(() => {
            appShell.log({ level: 'info', message: '<img id="log-probe" src="x">' });
            return !document.getElementById('log-probe') && document.getElementById('log-container').textContent.includes('<img id="log-probe"');
        })()`);
        check('logs: entries render as text, not HTML', escaped);

        await page.send('ServiceWorker.stopAllWorkers');
        await sleep(300);
        const afterRestart = await callTool(page, modernUrl, 'echo', { text: 'after restart' });
        check('calls still work after the browser stops the service worker', !!afterRestart?.includes('Echo: after restart'), afterRestart);

        // The pop-out only listens; registering the worker again would restart it and drop connections.
        const mark = await page.run(`${entries}.length`);
        await page.send('Runtime.evaluate', { expression: `document.getElementById('popoutLogsBtn').click()`, userGesture: true });
        const popout = await openPage(t => t.url.includes('logs=1'));
        const seeded = await popout.waitFor(`document.body.classList.contains('logs-only') && ${entries}.length`);
        check('the logs pop-out opens with the history so far', seeded > 0, `${seeded} entries`);
        const afterPopout = await callTool(page, modernUrl, 'echo', { text: 'after the pop-out' });
        const reconnected = await page.run(`${entries}.slice(${mark}).some(e => e.server === ${JSON.stringify(modernUrl)} && e.message.startsWith('→ server/discover'))`);
        check('opening the pop-out keeps the worker and its connections',
            !!afterPopout?.includes('Echo: after the pop-out') && !reconnected, afterPopout);
        const live = await popout.waitFor(`${entries}.some(e => /^echo returned in/.test(e.message))`, 5000);
        check('the pop-out shows new entries as they happen', !!live);
        popout.close();

        // Tabs share the worker, so loading the app in another tab mustn't replace it.
        const beforeTab = await page.run(`${entries}.length`);
        await page.send('Runtime.evaluate', { expression: `window.open(location.pathname + '?tab=2')`, userGesture: true });
        const secondTab = await openPage(t => t.url.includes('tab=2'));
        const secondReady = await secondTab.waitFor(`typeof appShell !== 'undefined' && !!appShell.serviceWorker`);
        const afterTab = await callTool(page, modernUrl, 'echo', { text: 'after a second tab' });
        const retried = await page.run(`${entries}.slice(${beforeTab}).some(e => e.server === ${JSON.stringify(modernUrl)} && e.message.startsWith('→ server/discover'))`);
        check('opening the app in a second tab keeps the first tab\'s connections',
            !!secondReady && !!afterTab?.includes('Echo: after a second tab') && !retried, afterTab);
        secondTab.close();

        // The Workbench: Pre-fill, variables, saved requests and collections, the history of every
        // call with what changed, and export and import. It reloads the page near the end.
        const openTool = (url, tool) => page.run(`(() => {
            ${showWorkbench};
            ${serverRow(url)}.click();
            ${toolRow(tool)}.click();
        })()`);
        const field = name => `document.querySelector('#requestForm [name="${name}"]').value`;
        const setField = (name, value) => page.run(`(() => {
            const input = document.querySelector('#requestForm [name="${name}"]');
            input.value = ${JSON.stringify(value)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const prefillFrom = async source => {
            await page.run(`document.querySelector('#requestPane .prefill-menu').open = true`);
            await page.waitFor(`!!document.querySelector('#requestPane [data-prefill-source="${source}"]:not([disabled])')`, 5000);
            await page.run(`document.querySelector('#requestPane [data-prefill-source="${source}"]').click()`);
        };
        const submitRequest = async () => {
            await page.run(`(() => {
                document.getElementById('responsePane').innerHTML = '';
                document.getElementById('requestForm').requestSubmit();
            })()`);
            return page.waitFor(shownResult);
        };
        const requestNote = `document.querySelector('#requestPane .wb-request-note').textContent`;
        const savedItem = name => `[...document.querySelectorAll('#savedList .saved-item')].find(li => li.querySelector('.saved-name')?.textContent === ${JSON.stringify(name)})`;
        const runSaved = async name => {
            await page.run(`(() => {
                document.getElementById('responsePane').innerHTML = '';
                ${savedItem(name)}.querySelector('[data-run-request]').click();
            })()`);
            return page.waitFor(`document.querySelector('#responsePane .run-summary') && ${shownResult}`);
        };
        const runRows = `[...document.querySelectorAll('#runsList tr[data-open-run]')]`;

        const fillBeside = path => page.run(`document.querySelector('#requestForm [data-fill-field="${path}"]').click()`);

        await openTool(modernUrl, 'echo');
        const echoOnOpen = await page.waitFor(`${field('text')} ? { text: ${field('text')}, note: ${requestNote} } : null`, 5000);
        await openTool(modernUrl, 'count');
        const countOnOpen = await page.waitFor(`${field('n')} || null`, 5000);
        check('pre-fill: opening a tool fills its required fields with the schema\'s examples and defaults',
            echoOnOpen?.text === 'hello' && echoOnOpen.note === 'Filled 1 required field: 1 from the schema.' && countOnOpen === '3',
            `${JSON.stringify(echoOnOpen)}, ${countOnOpen}`);

        await page.run(`(() => {
            document.getElementById('editEnvBtn').click();
            const rows = () => document.querySelectorAll('#envVariables .env-variable');
            const set = (row, name, value) => {
                row.querySelector('.env-variable-name').value = name;
                row.querySelector('.env-variable-value').value = value;
            };
            set(rows()[0], 'greeting', 'hi');
            document.getElementById('addVariableBtn').click();
            set(rows()[1], 'n', '2');
            document.getElementById('envVariables').dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('wb-sheet [data-close-sheet]').click();
        })()`);
        await openTool(modernUrl, 'count');
        await prefillFrom('schema');
        const nFromVariable = await page.waitFor(`${field('n')} || null`, 5000);
        const nPreview = await page.waitFor(`(() => {
            const preview = document.getElementById('sendsPreview');
            return preview.querySelector('pre').textContent.includes('"n": 2') && preview.querySelector('.wb-sends-head').textContent;
        })()`, 5000);
        const countedTo = await submitRequest();
        check('variables: a number field takes {{n}} and sends it as a number',
            nFromVariable === '{{n}}' && /1 variable from Default/.test(nPreview || '') && !!countedTo?.includes('Counted to 2'), `${nFromVariable}; ${nPreview}; ${countedTo}`);

        await openTool(modernUrl, 'echo');
        await setField('text', '{{greeting}} world');
        const greetingPreview = await page.waitFor(`document.querySelector('#sendsPreview pre').textContent.includes('"hi world"')`, 5000);
        const resolvedHint = await page.waitFor(`document.querySelector('#requestForm .wb-resolved')?.textContent`, 5000);
        const greeted = await submitRequest();
        check('variables: {{greeting}} world goes out as "hi world", as the preview showed', !!greetingPreview && !!greeted?.includes('Echo: hi world'), greeted);
        check('variables: the field shows what {{greeting}} world becomes', resolvedHint === '→ hi world · from Default', resolvedHint);
        await setField('text', '{{nope}}');
        const unknownVariable = await submitRequest();
        check('variables: an unknown variable stops the call and names itself', /\{\{nope\}\} isn't a variable/.test(unknownVariable || ''), unknownVariable);

        // Test data: echo_region suggests nothing for its required fields, so Pre-fill makes some.
        await openTool(modernUrl, 'echo_region');
        await prefillFrom('schema');
        const generatedFill = await page.waitFor(`(() => {
            const region = ${field('region')};
            const text = ${field('text')};
            return region && text ? { region, text, note: ${requestNote} } : null;
        })()`, 5000);
        const generatedRun = generatedFill && await submitRequest();
        check('pre-fill: test data fills required fields the schema suggests nothing for, and the call goes through',
            /2 with generated test data/.test(generatedFill?.note || '') && !!generatedRun?.includes(`Echo from ${generatedFill.region}: ${generatedFill.text}`),
            generatedFill ? `${generatedFill.note} ${generatedRun || ''}` : 'not filled');
        // Staged values become variables named like their fields, which fill those fields anywhere.
        await setField('region', 'Zürich');
        await prefillFrom('stage');
        const stagedNote = await page.waitFor(`${requestNote}.startsWith('Staged') ? ${requestNote} : null`, 5000);
        await openTool(modernUrl, 'echo');
        await prefillFrom('schema');
        const stagedText = await page.waitFor(`${field('text')} || null`, 5000);
        const stagedValue = await page.run(`appShell.workbench.variables.text`);
        check('pre-fill: staged values fill a field of the same name in another tool, ahead of its example',
            /^Staged region and text in Default/.test(stagedNote || '') && stagedText === '{{text}}' && stagedValue === generatedFill?.text,
            `${stagedNote}; ${stagedText}`);
        await page.run(`(() => {
            const { region, text, ...rest } = appShell.workbench.variables;
            appShell.workbench.editEnvironment({ name: appShell.workbench.environment.name, variables: rest });
        })()`);

        // search_notes has twenty fields, five of them required, described the way servers write
        // descriptions for models, and it turns away arguments a real server would.
        await openTool(modernUrl, 'search_notes');
        const notesOnOpen = await page.waitFor(`(() => {
            const form = document.getElementById('requestForm');
            const filled = [...form.querySelectorAll('[name]')].filter(input => input.value).map(input => input.name).sort();
            return filled.length ? {
                filled: filled.join(', '), note: ${requestNote}, folded: !form.querySelector('.wb-optional').open,
                fills: form.querySelectorAll('[data-fill-field]').length, cursorFill: !!form.querySelector('[data-fill-field="cursor"]'),
            } : null;
        })()`, 5000);
        check('pre-fill: opening a tool with many fields fills only the required ones, and offers Fill beside each of the others',
            notesOnOpen?.filled === 'after, author, before, limit, query' && notesOnOpen.note === 'Filled 5 required fields: 5 with generated test data.'
                && notesOnOpen.folded && notesOnOpen.fills === 21 && !notesOnOpen.cursorFill,
            JSON.stringify(notesOnOpen));
        await page.run(`document.querySelector('#requestForm .wb-optional').open = true`);
        await fillBeside('owner');
        await fillBeside('updated');
        const filledNote = await page.run(requestNote);
        await setField('region', 'eu-central-1');
        const notesRun = await submitRequest();
        const notesSent = JSON.parse(notesRun?.match(/Searched with (\{[^{}]*\})/)?.[1] || 'null');
        check('pre-fill: the server takes the test data, and gets the required fields plus the ones filled one by one',
            Object.keys(notesSent || {}).sort().join(', ') === 'after, author, before, limit, owner, query, region, updated'
                && notesSent.owner === 'me' && notesSent.updated === 'today' && notesSent.region === 'eu-central-1'
                && notesSent.author === 'test@example.com' && notesSent.after < notesSent.before && filledNote === 'Filled updated with "today" (from its description).',
            `${filledNote} ${(notesRun || '').slice(0, 240)}`);
        await prefillFrom('every');
        const everyNote = await page.waitFor(`${requestNote}.startsWith('Filled 19 fields') ? ${requestNote} : null`, 5000);
        const everyRun = await submitRequest();
        check('pre-fill: test data for every field leaves out the pagination cursor, and the server takes all of it',
            !!everyNote && /No notes match/.test(everyRun || '') && /"request_id"/.test(everyRun || '') && !/"cursor"/.test(everyRun || ''),
            `${everyNote}; ${(everyRun || '').slice(0, 200)}`);

        await openTool(modernUrl, 'echo');
        await page.run(`document.querySelector('#requestPane [data-prefill-best]').click()`);
        const lastSentText = await page.waitFor(`${requestNote}.startsWith('Filled from what you last sent') && ${field('text')}`, 5000);
        check('pre-fill: one click brings back what you last sent, variables and all', lastSentText === '{{greeting}} world', lastSentText);

        const saveAs = async (name, collection) => {
            await page.run(`document.querySelector('#requestPane [data-save-request]').click()`);
            await page.waitFor(`!!document.querySelector('#requestPane .save-request:not([hidden]) [data-save-name]')`, 5000);
            await page.run(`(() => {
                const panel = document.querySelector('#requestPane .save-request');
                panel.querySelector('[data-save-name]').value = ${JSON.stringify(name)};
                const select = panel.querySelector('[data-save-collection]');
                const existing = [...select.options].find(option => option.textContent === ${JSON.stringify(collection)});
                select.value = existing ? existing.value : '__new';
                select.dispatchEvent(new Event('change'));
                if (!existing) panel.querySelector('[data-save-new-collection]').value = ${JSON.stringify(collection)};
                panel.querySelector('[data-save-confirm]').click();
            })()`);
            return page.waitFor(`(() => {
                const note = ${requestNote};
                return note.startsWith('Saved as') ? note : null;
            })()`, 5000);
        };
        const savedGreeting = await saveAs('Greeting', 'Smoke');
        const crumb = await page.run(`document.querySelector('#requestPane .wb-crumb').innerText.replace(/\\s+/g, ' ')`);
        check('saved requests: the request pane says which saved request it shows', crumb.endsWith('echo › Greeting'), crumb);
        await openTool(modernUrl, 'ticket');
        const prefixOnOpen = await page.run(field('prefix'));
        await fillBeside('prefix');
        const prefixFilled = await page.waitFor(`${field('prefix')} ? { prefix: ${field('prefix')}, note: ${requestNote}, focused: document.activeElement?.name } : null`, 5000);
        check('pre-fill: an optional field stays empty until Fill beside it fills it, here with its default',
            prefixOnOpen === '' && prefixFilled?.prefix === 'T-' && prefixFilled.note === 'Filled prefix with "T-" (its default).' && prefixFilled.focused === 'prefix',
            `${JSON.stringify(prefixOnOpen)} then ${JSON.stringify(prefixFilled)}`);
        const savedTicket = await saveAs('Next ticket', 'Smoke');
        const savedNames = await page.waitFor(`(() => {
            const names = [...document.querySelectorAll('#savedList .saved-group')].filter(group => group.querySelector('.saved-group-name')?.textContent === 'Smoke')
                .flatMap(group => [...group.querySelectorAll('.saved-name')].map(el => el.textContent));
            return names.length === 2 ? names.join(', ') : null;
        })()`, 5000);
        await page.run(`${savedItem('Greeting')}.querySelector('[data-open-request]').click()`);
        const reopened = await page.waitFor(`document.querySelector('#requestPane .wb-crumb-tool')?.textContent === 'echo' && ${field('text')}`, 5000);
        check('saved requests: saved into a collection in the rail and opened again',
            savedGreeting === 'Saved as Greeting.' && savedTicket === 'Saved as Next ticket.' && savedNames === 'Greeting, Next ticket' && reopened === '{{greeting}} world',
            `${savedNames}; ${reopened}`);
        await openTool(modernUrl, 'echo');
        await page.run(`document.querySelector('#requestPane .prefill-menu').open = true`);
        await page.waitFor(`[...document.querySelectorAll('#requestPane [data-prefill-source]')].some(item => item.textContent === 'Saved: Greeting')`, 5000);
        await page.run(`[...document.querySelectorAll('#requestPane [data-prefill-source]')].find(item => item.textContent === 'Saved: Greeting').click()`);
        const fromSavedMenu = await page.waitFor(`(() => {
            const note = ${requestNote};
            return /^Filled from Greeting/.test(note) ? ${field('text')} : null;
        })()`, 5000);
        check('pre-fill: the menu offers saved requests for the tool', fromSavedMenu === '{{greeting}} world', fromSavedMenu);
        await page.waitFor(`!!${savedItem('Greeting')}`, 5000);

        await runSaved('Greeting');
        const greetingAgain = await runSaved('Greeting');
        check('Run again: a saved request whose result is the same says so', /Same as the last run/.test(greetingAgain || '') && !!greetingAgain?.includes('Echo: hi world'), greetingAgain);
        const verdictChip = await page.waitFor(`${savedItem('Greeting')}?.querySelector('.badge')?.textContent`, 5000);
        check('saved requests: the rail shows how the last run of each went', verdictChip === 'same', verdictChip);

        // Runtime's Library menu swaps the library in place, and results compare the same
        // whichever library returned them.
        const switchClient = name => page.run(`new Promise(resolve => {
            const listen = event => {
                if (event.data?.type !== 'client_set' || event.data.client !== ${JSON.stringify(name)}) return;
                navigator.serviceWorker.removeEventListener('message', listen);
                resolve(event.data.loaded);
            };
            navigator.serviceWorker.addEventListener('message', listen);
            const select = document.getElementById('clientSelect');
            select.value = ${JSON.stringify(name)};
            select.dispatchEvent(new Event('change'));
        })`);
        const other = Object.values(MCP_CLIENTS).find(client => client.name !== CLIENT.name);
        const switched = await switchClient(other.name);
        const greetingElsewhere = switched && await runSaved('Greeting');
        const lastLoaded = await page.run(`${entries}.filter(e => e.source === 'worker' && e.message.startsWith('Loaded the ')).at(-1)?.message`);
        check(`MCP client libraries: on the ${other.label}, a saved request's result is still the same`,
            !!switched && !!lastLoaded?.startsWith(`Loaded the ${other.label} (`) && /Same as the last run/.test(greetingElsewhere || ''),
            `${lastLoaded}; ${(greetingElsewhere || '').replace(/\s+/g, ' ').slice(0, 100)}`);
        check(`MCP client libraries: switching back to the ${CLIENT.label}`, !!await switchClient(CLIENT.name));
        await runSaved('Next ticket');
        const ticketAgain = await runSaved('Next ticket');
        await page.run(`document.querySelector('#responsePane [data-show-changes]')?.click()`);
        const ticketDiff = await page.waitFor(`document.querySelector('#responsePane .diff')?.innerText`, 5000);
        check('Run again: a changed result says so, and Changes has the lines that differ',
            /Changed since the last run/.test(ticketAgain || '') && /^- .*"text": "T-\d+"/m.test(ticketDiff || '') && /^\+ .*"text": "T-\d+"/m.test(ticketDiff || ''),
            (ticketDiff || ticketAgain || '').replace(/\s+/g, ' ').slice(0, 160));
        await page.run(`document.querySelector('#responsePane [data-response-tab="runs"]').click()`);
        const runsOfTicket = await page.waitFor(`document.querySelectorAll('#responsePane tr[data-open-run]').length || null`, 5000);
        check('Run again: the Runs tab lists every run of the saved request', runsOfTicket === 2, `${runsOfTicket} runs`);

        await page.run(`[...document.querySelectorAll('#savedList .saved-group')].find(group => group.querySelector('.saved-group-name')?.textContent === 'Smoke').querySelector('[data-run-collection]').click()`);
        const collectionSummary = await page.waitFor(`(() => {
            const text = document.querySelector('#responsePane .collection-run-summary')?.textContent || '';
            return text.startsWith('Ran ') ? text : null;
        })()`, 20000);
        const reportRows = await page.run(`document.querySelectorAll('#responsePane tr[data-open-run]').length`);
        check('Run all: runs the collection and sums up what changed', collectionSummary === 'Ran 2: 1 same, 1 changed, 0 failed' && reportRows === 2, `${collectionSummary}; ${reportRows} rows`);

        await page.run(showDock('runs'));
        const historySources = await page.waitFor(`(() => {
            const rows = ${runRows};
            return rows.length ? [...new Set(rows.map(row => row.dataset.source))].sort().join(', ') : null;
        })()`, 5000);
        check('history: every call is in the dock\'s Runs, the chat\'s and Run all\'s included',
            ['chat', 'collection', 'workbench'].every(source => (historySources || '').includes(source)), historySources);
        const recent = await page.run(`document.querySelectorAll('#recentRuns [data-open-run]').length`);
        check('history: the rail lists the most recent runs', recent === 6, `${recent} runs`);
        await page.run(`${runRows}[0].click()`);
        const openedRun = await page.waitFor(`(() => {
            return /From history/.test(document.getElementById('responsePane').innerText)
                ? document.querySelector('#requestPane .wb-crumb-tool').textContent + ' ' + ${field('prefix')} : null;
        })()`, 5000);
        check('history: a run opens with its arguments and result, ready to run again', openedRun === 'ticket T-', openedRun);

        const historyCount = await page.run(`${runRows}.length`);
        await page.send('Page.reload');
        await page.waitFor(`typeof appShell !== 'undefined' && !!appShell.workbench && !!appShell.serviceWorker`, 20000);
        await page.run(showDock('runs'));
        const historyAfterReload = await page.waitFor(`${runRows}.length || null`, 5000);
        check('history: kept after a reload', historyAfterReload === historyCount, `${historyAfterReload} of ${historyCount} runs`);

        // Keyboard: Go to (Ctrl+K) opens a tool, Ctrl+Enter runs it, Ctrl+S opens Save.
        const key = (key, extra = {}) => `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }))`;
        await page.run(key('k', { ctrlKey: true }));
        await page.waitFor(`!document.getElementById('palette').hidden && !!document.querySelector('#paletteResults [data-index]')`, 5000);
        await page.run(`(() => {
            const input = document.getElementById('paletteInput');
            input.value = 'echo_region';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        })()`);
        const wentTo = await page.waitFor(`document.getElementById('palette').hidden && document.querySelector('#requestPane .wb-crumb-tool')?.textContent`, 5000);
        check('keyboard: Go to finds a tool and opens it', wentTo === 'echo_region', wentTo);
        await page.run(`(() => {
            document.querySelector('#requestForm [name="region"]').value = 'Bern';
            document.querySelector('#requestForm [name="text"]').value = 'keys';
            document.getElementById('responsePane').innerHTML = '';
            ${key('Enter', { ctrlKey: true })};
        })()`);
        const keyed = await page.waitFor(shownResult, 10000);
        await page.run(key('s', { ctrlKey: true }));
        const saveOpened = await page.waitFor(`!!document.querySelector('#requestPane .save-request:not([hidden]) [data-save-name]')`, 5000);
        await page.run(`document.querySelector('#requestPane [data-save-cancel]').click()`);
        check('keyboard: Ctrl+Enter runs the request and Ctrl+S opens Save', !!keyed?.includes('Echo from Bern: keys') && !!saveOpened, keyed);

        // The dock collapses to its tabs and stays that way.
        await page.run(`document.getElementById('dockToggle').click()`);
        const collapsed = await page.run(`document.getElementById('dock').dataset.open === 'false' && document.getElementById('dockBody').offsetHeight === 0 && JSON.parse(localStorage.getItem('workbenchDock')).open === false`);
        await page.run(`document.getElementById('dockToggle').click()`);
        await page.run(showDock('trace'));
        const traced = await page.waitFor(`document.querySelectorAll('#traceList .log-entry').length || null`, 5000);
        check('dock: collapses and remembers it, and Trace lists the HTTP requests', collapsed && traced > 0, `${traced} trace entries`);

        const exportFolder = mkdtempSync(join(tmpdir(), 'mcp-smoke-export-'));
        await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: exportFolder });
        await page.waitFor(`!!${savedItem('Greeting')}`, 5000);
        await page.run(`document.getElementById('exportSavedBtn').click()`);
        let exportFile;
        for (let i = 0; i < 50 && !exportFile; i++) {
            exportFile = readdirSync(exportFolder).find(name => name.endsWith('.json'));
            if (!exportFile) await sleep(100);
        }
        const exported = exportFile ? JSON.parse(readFileSync(join(exportFolder, exportFile), 'utf8')) : null;
        await page.run(`${savedItem('Greeting')}.querySelector('[data-delete-request]').click()`);
        await page.waitFor(`!${savedItem('Greeting')}`, 5000);
        const { root } = (await page.send('DOM.getDocument')).result;
        const { nodeId } = (await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#importSavedInput' })).result;
        await page.send('DOM.setFileInputFiles', { nodeId, files: [join(exportFolder, exportFile || 'missing.json')] });
        const imported = await page.waitFor(`/^Imported/.test(document.getElementById('wbStatus').textContent) && !!${savedItem('Greeting')} && document.getElementById('wbStatus').textContent`, 5000);
        rmSync(exportFolder, { recursive: true, force: true });
        check('export and import: an export brings back a deleted request',
            exported?.format === 'mcp-workbench' && exported.requests?.length === 2 && exported.environments?.[0]?.variables?.greeting === 'hi' && /^Imported 2 saved requests, 1 collection and 1 environment/.test(imported || ''),
            imported || exportFile || 'no export');

        await page.run(showDock('runs'));
        await page.run(`(() => {
            const clear = document.getElementById('clearHistoryBtn');
            clear.click();
            clear.click();
        })()`);
        const cleared = await page.waitFor(`/No calls yet/.test(document.getElementById('runsList').textContent) && /No runs yet/.test(document.getElementById('recentRuns').textContent)`, 5000);
        check('history: Clear history empties it, in the dock and the rail', !!cleared);
        await page.run(showDock('log'));

        const tokenUrl = `${HOST}:${PORTS.token}/`;
        const locked = await addAndConnect(page, tokenUrl, 'needs a token');
        check('a server that needs a token says so', locked?.status === 'failed' && /sign in|static token/i.test(locked.error || ''), locked?.error);
        await page.run(`(() => {
            document.getElementById('serverInfoBtn').click();
            const input = document.getElementById('serverTokenField');
            input.value = ${JSON.stringify(TOKEN)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await page.waitFor(`appShell.servers[${JSON.stringify(tokenUrl)}]?.bearerToken === ${JSON.stringify(TOKEN)}`, 5000);
        await page.run(`(() => {
            document.querySelector('wb-sheet [data-close-sheet]').click();
            document.getElementById('initProtocol').click();
        })()`);
        const unlocked = await page.waitFor(connectionState(tokenUrl));
        check('with a bearer token it connects', unlocked?.status === 'connected', JSON.stringify(unlocked));
        const withToken = await callTool(page, tokenUrl, 'echo', { text: 'with a token' });
        check('with a bearer token tools can be called', !!withToken?.includes('Echo: with a token'), withToken);
        const leaked = await page.run(`JSON.stringify(${entries}).includes(${JSON.stringify(TOKEN)})`);
        check('logs: the bearer token never appears', !leaked);

        // A conversation field gets the instructions, the server list and the conversation so far:
        // the model is told about every server and its tools, but never their tokens.
        const modelRunId = await page.run(`new Promise(resolve => {
            const conversation = 'smoke-tool-choice';
            const listen = event => {
                if (event.data?.type !== 'tool_result' || event.data.conversationId !== conversation) return;
                navigator.serviceWorker.removeEventListener('message', listen);
                resolve(event.data.run?.id ?? null);
            };
            navigator.serviceWorker.addEventListener('message', listen);
            const worker = navigator.serviceWorker.controller;
            worker.postMessage({ type: 'set_chat_model', model: { serverUrl: ${JSON.stringify(tokenUrl)}, toolName: 'echo', messageField: 'text', conversationField: 'history', args: {} } });
            worker.postMessage({ type: 'chat_send', text: 'Which tools can you use?', conversationId: conversation });
        })`);
        const toldModel = modelRunId && await page.run(`new Promise((resolve, reject) => {
            const open = indexedDB.open('mcp_sandbox');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const get = open.result.transaction('runs').objectStore('runs').get(${JSON.stringify(modelRunId)});
                get.onsuccess = () => resolve(JSON.stringify(get.result?.sentArgs ?? null));
            };
        })`);
        check('Chat app: the model is told about the servers and their tools, never their tokens',
            !!toldModel && toldModel.includes(tokenUrl) && toldModel.includes('echo_region') && !toldModel.includes(TOKEN),
            modelRunId ? `${toldModel?.length} characters sent` : 'no answer');
        await page.run('sendChatModelToWorker()');

        // Sign-in (OAuth), as with Glean: the 401's challenge is unreadable, so the client finds
        // the protected resource metadata at its well-known address.
        const oauthUrl = `${HOST}:${PORTS.oauth}/`;
        const needsSignIn = await addAndConnect(page, oauthUrl, 'OAuth mock');
        const offered = await page.run(`!document.getElementById('authPanel').hidden && !document.getElementById('signInBtn').hidden
            && /Sign in/.test(${serverRow(`${HOST}:${PORTS.oauth}/`)}.textContent)`);
        check('a server that needs sign-in says so and offers Sign in',
            needsSignIn?.status === 'failed' && /sign in/i.test(needsSignIn.error || '') && offered, needsSignIn?.error);
        const signedIn = await signIn(page, `appShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`);
        check('signing in through the pop-up window connects', !!signedIn,
            signedIn ? '' : await page.run(`appShell.servers[${JSON.stringify(oauthUrl)}]?.lastError`));
        const shown = await page.run(`(() => {
            const visible = [...document.querySelectorAll('#authPanel button')].filter(b => b.offsetParent).map(b => b.textContent);
            return document.getElementById('authStatus').textContent + ' [' + visible.join(', ') + ']';
        })()`);
        check('the server bar says who you signed in with and offers only Sign out',
            shown.includes(`Signed in with 127.0.0.1:${PORTS.oauth}`) && shown.includes('renews automatically') && shown.endsWith('[Sign out]'), shown);
        const missingSteps = await page.run(`(() => {
            const said = ${entries}.filter(e => e.server === ${JSON.stringify(oauthUrl)} && e.level === 'info').map(e => e.message);
            return ['^Found the protected resource metadata at .+/\\\\.well-known/oauth-protected-resource', '^Registered with .+ \\\\(native app', '^Signed in with ']
                .filter(pattern => !said.some(message => new RegExp(pattern).test(message)));
        })()`);
        check('logs: discovery, registration and sign-in are reported', missingSteps.length === 0, missingSteps.join(' | '));
        const oauthTools = await toolNames(page, oauthUrl);
        const signedInEcho = await callTool(page, oauthUrl, 'echo', { text: 'signed in' });
        check('signed in, tools are listed and called', oauthTools.includes('echo') && !!signedInEcho?.includes('Echo: signed in'), signedInEcho);
        await sleep(2500);
        const beforeRefresh = await page.run(`${entries}.length`);
        const refreshedEcho = await callTool(page, oauthUrl, 'echo', { text: 'after a refresh' });
        const refreshed = await page.run(`${entries}.slice(${beforeRefresh}).some(e => e.server === ${JSON.stringify(oauthUrl)} && /^Refreshed the access token/.test(e.message))`);
        check('an access token about to expire is refreshed before use', refreshed && !!refreshedEcho?.includes('Echo: after a refresh'), refreshedEcho);
        const tokens = await page.run(storedTokens(oauthUrl));
        const secrets = [tokens?.accessToken, tokens?.refreshToken].filter(Boolean);
        const exposed = await page.run(`(() => {
            const places = [JSON.stringify(${entries}), localStorage.getItem('mcpServers') || '', document.body.innerHTML];
            return ${JSON.stringify(secrets)}.filter(secret => places.some(text => text.includes(secret))).length;
        })()`);
        const unredacted = await page.run(`${entries}.some(e => /"(access_token|refresh_token|code|code_verifier)":"(?!\\[redacted\\])/.test(JSON.stringify(e.detail ?? '')))`);
        check('tokens never reach the logs, the page or localStorage', secrets.length === 2 && exposed === 0 && !unredacted,
            `${secrets.length} tokens checked`);
        await page.run(`document.getElementById('signOutBtn').click()`);
        const forgotten = await page.waitFor(`${storedTokens(oauthUrl)}.then(tokens => !tokens)`, 5000);
        await page.waitFor(`!document.getElementById('signInBtn').hidden`, 5000);
        await page.run(`document.getElementById('initProtocol').click()`);
        const signedOut = await page.waitFor(`(() => {
            const s = appShell.servers[${JSON.stringify(oauthUrl)}];
            return s?.status === 'failed' ? s.lastError : null;
        })()`);
        check('signing out forgets the tokens, and the server asks for sign-in again', !!forgotten && /sign in/i.test(signedOut || ''), signedOut);

        const noExpiryUrl = `${HOST}:${PORTS.oauthNoExpiry}/`;
        await addAndConnect(page, noExpiryUrl, 'OAuth mock, no expires_in');
        await signIn(page, `appShell.servers[${JSON.stringify(noExpiryUrl)}]?.status === 'connected'`);
        await sleep(2500);
        const beforeRetry = await page.run(`${entries}.length`);
        const retriedEcho = await callTool(page, noExpiryUrl, 'echo', { text: 'after a retry' });
        const retriedAfterRefresh = await page.run(`(() => {
            const said = ${entries}.slice(${beforeRetry}).filter(e => e.server === ${JSON.stringify(noExpiryUrl)}).map(e => e.message);
            return said.some(m => /turned down the access token/.test(m)) && said.some(m => /^Refreshed the access token/.test(m));
        })()`);
        check('a turned-down access token is refreshed and the call retried', retriedAfterRefresh && !!retriedEcho?.includes('Echo: after a retry'), retriedEcho);

        const wrongIssUrl = `${HOST}:${PORTS.oauthWrongIss}/`;
        await addAndConnect(page, wrongIssUrl, 'OAuth mock, wrong issuer');
        const wrongIss = await signIn(page, `(() => {
            const error = appShell.servers[${JSON.stringify(wrongIssUrl)}]?.lastError || '';
            return /impostor/.test(error) ? error : null;
        })()`);
        const wrongIssStored = await page.run(storedTokens(wrongIssUrl));
        check('a sign-in response from the wrong issuer is rejected', !!wrongIss && !wrongIssStored, wrongIss);

        await page.send('Runtime.evaluate', { expression: `window.open('oauth-callback.html?code=forged&state=forged', 'forged-callback')`, userGesture: true });
        // Sign-in pop-ups close once they're done, so the only callback page left is this one.
        const forged = await openPage(t => t.url.includes('oauth-callback'));
        const forgedText = await forged.waitFor(`document.getElementById('callbackTitle').textContent === 'Sign-in failed' && document.getElementById('callbackDetail').textContent`, 10000);
        check('the callback page turns away a response with an unknown state', /doesn't match a sign-in in progress/.test(forgedText || ''), forgedText);
        forged.close();

        // The Guide's Glean field takes a work email: the page asks app.glean.com which deployment
        // it belongs to. That request is answered here: oauth-mock.test lives on the OAuth mock,
        // unknown.test gets Glean's central deployment (its answer for domains it doesn't know),
        // and blocked.test fails the way a CORS rejection does.
        const lookups = [];
        await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://app.glean.com/config/search*' }] });
        page.on('Fetch.requestPaused', async ({ requestId, request }) => {
            const cors = [
                { name: 'Access-Control-Allow-Origin', value: `${HOST}:${PORTS.app}` },
                { name: 'Access-Control-Allow-Headers', value: 'Content-Type' },
                { name: 'Access-Control-Allow-Methods', value: 'POST' },
            ];
            if (request.method === 'OPTIONS') {
                return page.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
            }
            const asked = JSON.parse(request.postData || '{}');
            lookups.push(asked);
            if (asked.email?.endsWith('@blocked.test')) return page.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
            const queryURL = asked.email?.endsWith('@oauth-mock.test') ? `${HOST}:${PORTS.oauth}/` : 'https://apps-be.glean.com/';
            const body = JSON.stringify({ search_config: { queryURL, isMultiTenant: false, centralURL: 'https://apps-be.glean.com/' } });
            return page.send('Fetch.fulfillRequest', {
                requestId, responseCode: 200, body: Buffer.from(body).toString('base64'),
                responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
            });
        });
        const lookUp = async (email, until) => {
            await page.run(`(() => {
                if (document.getElementById('guide').hidden) document.getElementById('guideBtn').click();
                document.getElementById('gleanUrl').value = ${JSON.stringify(email)};
            })()`);
            await page.send('Runtime.evaluate', { expression: `document.getElementById('gleanAddBtn').click()`, userGesture: true });
            return page.waitFor(until, 20000);
        };
        const gleanError = `(() => { const note = document.getElementById('gleanUrlError'); return note.hidden ? null : note.textContent; })()`;
        const unknown = await lookUp('someone@unknown.test', gleanError);
        check('Glean by email: a domain Glean doesn\'t know is reported', /doesn't know a deployment for unknown\.test/.test(unknown || ''), unknown);
        const blockedLookup = await lookUp('someone@blocked.test', gleanError);
        check('Glean by email: a lookup the browser blocks falls back to pasting the URL', /Paste your MCP server URL/.test(blockedLookup || ''), blockedLookup);
        const gleanUrl = `${HOST}:${PORTS.oauth}/mcp/default`;
        const foundAndSignedIn = await lookUp('someone@oauth-mock.test', `appShell.servers[${JSON.stringify(gleanUrl)}]?.status === 'connected'`);
        const filled = await page.run(`document.getElementById('gleanUrl').value + ' | ' + document.getElementById('gleanStatus').textContent`);
        check('Glean by email: the lookup finds the server, and sign-in connects to its default MCP server',
            !!foundAndSignedIn && filled.startsWith(`${gleanUrl} | oauth-mock.test uses the Glean at ${HOST}:${PORTS.oauth}/`), filled);
        check('Glean by email: the lookup sends the email the way Glean\'s sign-in page does',
            lookups.length === 3 && lookups.every(asked => asked.isGleanApp === 'true' && /@/.test(asked.email)), JSON.stringify(lookups));
        const emailLogged = await page.run(`JSON.stringify(${entries}).includes('someone@')`);
        check('Glean by email: logs name the domain, not the email address', !emailLogged);
        await page.send('Fetch.disable');
        await page.run(`document.getElementById('closeGuide').click()`);

        // Browsers without pop-ups (embedded ones, or a strict blocker): the server bar offers to
        // continue in this tab, or to open the copied link in another tab or browser.
        const signInWithoutPopup = async () => {
            await page.run(`(() => {
                window.realOpen ??= window.open;
                window.open = () => null;
                ${showWorkbench};
                ${serverRow(oauthUrl)}.click();
                if (!document.getElementById('signOutBtn').hidden) document.getElementById('signOutBtn').click();
            })()`);
            await page.waitFor(`!document.getElementById('signInBtn').hidden`, 5000);
            await page.send('Runtime.evaluate', { expression: `document.getElementById('signInBtn').click()`, userGesture: true });
            return page.waitFor(`!document.getElementById('authElsewhere').hidden && appShell.signingIn?.authorizationUrl`);
        };
        const link = await signInWithoutPopup();
        const noPopupStatus = await page.run(`document.getElementById('authStatus').textContent`);
        check('without a pop-up, the server bar offers to continue in this tab or copy the link',
            !!link && /didn't open a pop-up window/.test(noPopupStatus), noPopupStatus);
        await page.send('Runtime.evaluate', { expression: `window.realOpen(${JSON.stringify(link)}, '_blank', 'noopener')`, userGesture: true });
        const fromTab = await page.waitFor(`appShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`);
        const tab = await openPage(t => t.url.includes('oauth-callback'));
        const tabSays = await tab.waitFor(`document.getElementById('callbackTitle').textContent === 'Signed in' && document.getElementById('callbackDetail').textContent`, 10000);
        await closeTab(tab);
        check('the copied link signs in from another tab, and this one connects', !!fromTab && /close this tab/.test(tabSays || ''), tabSays);

        const secondLink = await signInWithoutPopup();
        const elsewhere = await otherBrowser();
        const there = await elsewhere.open(secondLink);
        const landed = await there.waitFor(`document.getElementById('callbackTitle')?.textContent === 'Finish signing in where you started' && document.getElementById('callbackAddress').value`);
        await elsewhere.close();
        check('in another browser, the callback page offers its address to take back',
            /oauth-callback\.html\?code=.+&state=/.test(landed || ''), (landed || 'nothing').replace(/code=[^&]+/, 'code=…'));
        const pasteInto = address => page.run(`(() => {
            document.querySelector('#authElsewhere details').open = true;
            document.getElementById('authCallbackUrl').value = ${JSON.stringify(address)};
            document.getElementById('finishSignInBtn').click();
            const error = document.getElementById('authPasteError');
            return error.hidden ? '' : error.textContent;
        })()`);
        const wrongPaste = await pasteInto('https://example.com/callback?state=abc');
        check('pasting an address that isn\'t the callback is turned away', /isn't the address sign-in sends you back to/.test(wrongPaste), wrongPaste);
        await pasteInto(landed || '');
        const pastedBack = await page.waitFor(`appShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`);
        check('pasting the address from the other browser here finishes signing in', !!pastedBack,
            pastedBack ? '' : await page.run(`document.getElementById('authPasteError').textContent || appShell.servers[${JSON.stringify(oauthUrl)}]?.lastError`));

        // This reloads the page, so it comes last among the checks that use the page's state.
        await signInWithoutPopup();
        await page.run(`document.getElementById('continueHereBtn').click()`);
        await sleep(500);
        const cameBack = await page.waitFor(`typeof appShell !== 'undefined' && location.search === '' &&
            appShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`, 20000);
        check('continuing in this tab signs in and comes back to the client, connected', !!cameBack,
            cameBack ? '' : await page.run(`location.href + ' ' + (document.getElementById('callbackDetail')?.textContent || '')`));

        const blocked = await addAndConnect(page, `${HOST}:${PORTS.strictModern}/`, 'modern, old CORS policy');
        check('a modern server whose CORS policy blocks the new headers is diagnosed',
            blocked?.status === 'failed' && /CORS policy must allow/.test(blocked.error || ''), blocked?.error);

        const unreachable = await addAndConnect(page, `${HOST}:18099/`, 'nothing here');
        check('an unreachable server fails with an explanation',
            unreachable?.status === 'failed' && /Couldn't reach/.test(unreachable.error || ''), unreachable?.error);

        if (WITH_REFERENCE) {
            const wrongPath = await addAndConnect(page, `${HOST}:${PORTS.reference}/`, 'wrong path');
            check('a URL without an MCP endpoint points at /mcp',
                wrongPath?.status === 'failed' && /\/mcp/.test(wrongPath.error || ''), wrongPath?.error);
        }

        if (WITH_PUBLIC) {
            for (const target of PUBLIC_TARGETS) {
                await page.run(`document.querySelector('#guide [data-add-server=${JSON.stringify(target.url)}]').click()`);
                const connection = await page.waitFor(connectionState(target.url), 30000);
                check(`${target.label} (public): connects from the guide`, connection?.status === 'connected',
                    connection ? `${connection.version} ${connection.era}${connection.error ? `: ${connection.error}` : ''}` : 'no answer');
                if (connection?.status !== 'connected') continue;
                const names = await toolNames(page, target.url, 30000);
                check(`${target.label} (public): lists ${target.tool}`, names.includes(target.tool), names.join(', '));
                const offers = await page.waitFor(`(() => {
                    const s = appShell.servers[${JSON.stringify(target.url)}];
                    const caps = s?.capabilities || {};
                    if ((caps.resources && !s.resources && !s.resourcesError) || (caps.prompts && !s.prompts && !s.promptsError)) return null;
                    const part = (declared, items, error, what) => error ? what + " couldn't be listed: " + error
                        : !declared && !items?.length ? 'no ' + what : items.length + ' ' + what;
                    return part(caps.resources, s.resources && [...s.resources, ...(s.resourceTemplates || [])], s.resourcesError, 'resources')
                        + '; ' + part(caps.prompts, s.prompts, s.promptsError, 'prompts');
                })()`, 30000);
                notice(`${target.label} (public): resources and prompts`, offers || 'still listing after 30 s');
                if (!names.includes(target.tool)) continue;
                const reply = await callTool(page, target.url, target.tool, target.args, 60000);
                check(`${target.label} (public): calls ${target.tool}`,
                    !!reply && target.expect.test(reply) && !reply.includes('The tool reported an error'), reply?.slice(0, 120));
            }
            // GitMCP's reply to server/discover has no CORS headers, so only the fallback reaches it.
            const gitmcp = await addAndConnect(page, 'https://gitmcp.io/docs', 'GitMCP', 45000);
            check('GitMCP (public): connects through the fallback for unreadable probes',
                gitmcp?.status === 'connected' && gitmcp.era === 'legacy', gitmcp ? `${gitmcp.version} ${gitmcp.era} ${gitmcp.error || ''}` : 'no answer');
        }

        // Calls made with a static token or after signing in are in history, without the tokens.
        const storeDump = await page.run(`new Promise((resolve, reject) => {
            const open = indexedDB.open('mcp_sandbox');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const names = ['runs', 'requests', 'environments'];
                const tx = open.result.transaction(names);
                const dump = {};
                for (const name of names) tx.objectStore(name).getAll().onsuccess = event => { dump[name] = event.target.result; };
                tx.oncomplete = () => resolve(JSON.stringify(dump));
            };
        })`);
        const storedRuns = JSON.parse(storeDump || '{}').runs || [];
        check('the Workbench store has the calls but never a token',
            storedRuns.some(run => run.serverUrl === tokenUrl) && storedRuns.some(run => run.serverUrl === oauthUrl)
                && !storeDump.includes(TOKEN) && secrets.every(secret => !storeDump.includes(secret)),
            `${storedRuns.length} runs`);

        check('no uncaught page errors', page.exceptions.length === 0, page.exceptions.join(' | '));
    } finally {
        if (page && results.some(r => !r.ok)) {
            // The client's own log usually says what went wrong.
            try {
                const log = await page.run(`JSON.stringify(${entries})`);
                const file = join(tmpdir(), `mcp-smoke-log-${Date.now()}.json`);
                writeFileSync(file, log);
                const lines = JSON.parse(log).filter(e => e.level !== 'debug').slice(-60).map(e =>
                    [e.time.slice(11, 23), e.level.toUpperCase().padEnd(5), e.source.padEnd(6), e.message, e.server ? `(${e.server})` : ''].join(' '));
                console.log(`\n--- the client's log (last 60 entries above debug; all of it is in ${file}) ---\n${lines.join('\n')}`);
            } catch (error) {
                console.log(`\n(couldn't read the client's log: ${error.message})`);
            }
        }
        page?.close();
        await stopChrome(chrome);
        await removeProfile(profile);
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
