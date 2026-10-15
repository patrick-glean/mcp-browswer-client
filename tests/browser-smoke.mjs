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
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize as normalizePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromDml } from '../public/apps/dml.js';
import { RUN_HASH, unpackApp } from '../public/apps/link.js';
import { unzip } from '../public/apps/zip.js';
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

// Serves public/ the way `npm start` does, without the dependency, or another folder (`root`),
// such as a downloaded app's. Python's http.server resets connections when many requests arrive
// at once, as the page's and worker's modules do.
function serveApp(port, { root = join(ROOT, 'public'), label = 'app' } = {}) {
    const app = { label, output: '' };
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

// A small Chrome DevTools Protocol client for one page target, or (`type: 'iframe'`) one frame
// that runs in a process of its own, such as the client embedded in another site's page.
async function openPage(match = () => true, { type = 'page' } = {}) {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
        try {
            const targets = await (await fetch(`${HOST}:${PORTS.devtools}/json`)).json();
            target = targets.find(t => t.type === type && match(t));
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

// An app's screen runs in a sandboxed frame, which Chrome keeps in a process of its own, so it's a
// DevTools target of its own. This evaluates in each such frame (with `inPage`, only those of that
// tab) and returns the first answer that isn't empty (null when there's none). The canvas's stills
// of the screens the app isn't on (data-still) never answer: only the running app does.
async function frameRun(expression, { inPage = null } = {}) {
    const frames = (await (await fetch(`${HOST}:${PORTS.devtools}/json`)).json())
        .filter(target => target.type === 'iframe' && target.url === 'about:srcdoc' && target.webSocketDebuggerUrl && (!inPage || target.parentId === inPage.id));
    expression = `(document.documentElement.hasAttribute('data-still') ? null : (${expression}))`;
    for (const frame of frames) {
        const ws = new WebSocket(frame.webSocketDebuggerUrl);
        try {
            await new Promise((resolve, reject) => {
                setTimeout(() => reject(new Error('The frame never answered.')), 3000);
                ws.addEventListener('open', resolve, { once: true });
                ws.addEventListener('error', reject, { once: true });
            });
            // A frame that goes away while it's asked (the app reloaded it) never answers.
            const reply = await new Promise(resolve => {
                setTimeout(() => resolve(null), 5000);
                ws.addEventListener('close', () => resolve(null), { once: true });
                ws.addEventListener('message', event => {
                    const message = JSON.parse(event.data);
                    if (message.id === 1) resolve(message);
                });
                ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
            });
            const value = reply?.result?.result?.value;
            if (value !== undefined && value !== null && value !== false && value !== '') return value;
        } catch {
            // The frame went away while it was asked.
        } finally {
            ws.close();
        }
    }
    return null;
}

async function frameWaitFor(expression, ms = 15000, { inPage = null } = {}) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await frameRun(expression, { inPage });
        if (value) return value;
        await sleep(150);
    }
    return null;
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

// How many runs of a tool from a source the worker has recorded.
function runCount(toolName, source) {
    return `new Promise((resolve, reject) => {
        const open = indexedDB.open('mcp_sandbox');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            if (!open.result.objectStoreNames.contains('runs')) return resolve(0);
            const all = open.result.transaction('runs').objectStore('runs').getAll();
            all.onsuccess = () => resolve(all.result.filter(run => run.toolName === ${JSON.stringify(toolName)} && run.source === ${JSON.stringify(source)}).length);
        };
    })`;
}

// The newest run of a tool from a source (app, reply, workbench…), as the worker recorded it.
function latestRun(toolName, source) {
    return `new Promise((resolve, reject) => {
        const open = indexedDB.open('mcp_sandbox');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const all = open.result.transaction('runs').objectStore('runs').getAll();
            all.onsuccess = () => resolve(all.result.filter(run => run.toolName === ${JSON.stringify(toolName)} && run.source === ${JSON.stringify(source)})
                .sort((a, b) => b.startedAt - a.startedAt)[0] || null);
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
        // What the Chat app kept, before the Chat example replaced it, under its names old and
        // new, on the app's origin before the app first loads.
        await page.send('Page.navigate', { url: `${HOST}:${PORTS.app}/seed-old-chat-data` });
        await page.waitFor(`location.pathname === '/seed-old-chat-data' && document.readyState === 'complete'`);
        await page.run(`new Promise((resolve, reject) => {
            localStorage.setItem('chatModel', JSON.stringify({ serverUrl: 'http://127.0.0.1:9/', toolName: 'echo', args: { text: '{{message}}' }, messageField: 'text', conversationField: null }));
            localStorage.setItem('chatContext', JSON.stringify([{ id: 'context-1', name: 'Old context', text: 'Answer briefly.', timestamp: 1 }]));
            localStorage.setItem('lastChatConversation', 'smoke-old-conversation');
            localStorage.setItem('cbusTapConfig', JSON.stringify({ serverUrl: 'http://127.0.0.1:9/', toolName: 'echo', connectedStringArg: 'text' }));
            sessionStorage.setItem('chatConversation', 'smoke-old-conversation');
            const open = indexedDB.open('chat_contexts', 2);
            open.onupgradeneeded = () => {
                open.result.createObjectStore('conversations', { keyPath: 'conversationId' });
                open.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('conversationId', 'conversationId');
            };
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('messages', 'readwrite');
                tx.objectStore('messages').put({ id: '00000000-0001', text: 'A question from the Chat app', role: 'user', timestamp: 1, conversationId: 'smoke-old-conversation' });
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
        const cleanedUp = await page.waitFor(`(async () => {
            const kept = ['chatModel', 'chatContext', 'lastChatConversation', 'cbusTapConfig'].filter(key => localStorage.getItem(key) !== null);
            if (sessionStorage.getItem('chatConversation') !== null) kept.push('chatConversation');
            const databases = (await indexedDB.databases()).map(database => database.name);
            return kept.length === 0 && !databases.includes('chat_contexts') && !localStorage.getItem('appsModel') ? databases.join(', ') || 'no databases' : null;
        })()`, 10000);
        check("the Chat app's settings and stored conversations are gone, and its model isn't the builder's", !!cleanedUp, cleanedUp || 'still there');
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
        // What to type for Glean reads in full: a label, a placeholder that fits its field, the
        // endpoint's shape, and a link to the settings page where Glean shows it.
        const placeholderFits = `field => {
            const context = document.createElement('canvas').getContext('2d');
            const style = getComputedStyle(field);
            context.font = style.font;
            return context.measureText(field.placeholder).width <= field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        }`;
        const gleanField = await page.run(`(() => {
            const fits = ${placeholderFits};
            document.getElementById('guideBtn').click();
            const input = document.getElementById('gleanUrl');
            const hint = document.getElementById(input.getAttribute('aria-describedby'));
            const link = hint.querySelector('a');
            const guideSays = [input.labels[0]?.textContent, fits(input) ? 'its placeholder fits' : 'its placeholder is cut', hint.querySelector('.guide-example')?.textContent, link.href, link.target, link.rel];
            document.getElementById('closeGuide').click();
            ${showWorkbench};
            document.getElementById('addServerToggle').click();
            const add = document.getElementById('serverUrl');
            const addLink = document.getElementById(add.getAttribute('aria-describedby'))?.querySelector('a');
            const railSays = [fits(add) ? 'its placeholder fits' : 'its placeholder is cut', addLink?.href, addLink?.target];
            document.querySelector('#addServerForm [data-cancel-add]').click();
            return guideSays.join(' | ') + ' / ' + railSays.join(' | ');
        })()`);
        check("Glean's field in the Guide and + beside Servers say what to type in full, and link to where Glean shows the endpoint",
            gleanField === 'Work email or MCP endpoint | its placeholder fits | https://your-company-be.glean.com/mcp/default | https://app.glean.com/settings/connected-apps | _blank | noopener'
                + ' / its placeholder fits | https://app.glean.com/settings/connected-apps | _blank', gleanField);
        const loaded = await page.waitFor(`${entries}.some(e => e.source === 'worker' && e.message.startsWith(${JSON.stringify(`Loaded the ${CLIENT.label} (`)}))`, 5000);
        check('logs: the worker reports the client build it loaded', !!loaded);

        const targets = [
            { label: 'modern server', url: `${HOST}:${PORTS.modern}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket', 'search_notes', 'make_screen', 'chat', 'find_visit', 'check_in', 'call_front_desk'] },
            { label: 'modern server with SSE replies', url: `${HOST}:${PORTS.sse}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket', 'search_notes', 'make_screen', 'chat', 'find_visit', 'check_in', 'call_front_desk'] },
            { label: 'legacy server', url: `${HOST}:${PORTS.legacy}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'legacy server with SSE replies', url: `${HOST}:${PORTS.legacySse}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'dual-era server', url: `${HOST}:${PORTS.dual}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket', 'search_notes', 'make_screen', 'chat', 'find_visit', 'check_in', 'call_front_desk'] },
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

        // A demo server built in answers in the worker, through the library's own requests, at an
        // address no network answers.
        const deskUrl = 'https://frontdesk.demo.invalid/mcp';
        const builtIn = await addAndConnect(page, deskUrl, 'Front desk (demo)');
        const builtInTools = await toolNames(page, deskUrl);
        const builtInCall = await callTool(page, deskUrl, 'find_visit', { visitor: 'ada' });
        check('built-in demo server: connects in the worker as MCP 2026-07-28, lists its tools and answers a call',
            builtIn?.status === 'connected' && builtIn.era === 'modern' && builtIn.name === 'Front desk demo server'
                && builtInTools?.join(', ') === 'find_visit, check_in, call_front_desk' && !!builtInCall?.includes('Ada Lovelace of Analytical Engines is here to see Grace Hopper at 10:00'),
            `${JSON.stringify(builtIn)}; ${builtInTools}; ${builtInCall?.slice(0, 120)}`);

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
        check('inspector: the filter narrows the list and the count follows', inspector.filtered === 'echo_region (1 of 10)', inspector.filtered);
        check('inspector: Writes lists the tools that don\'t say they only read', inspector.writes === 'echo_region, ticket, check_in, call_front_desk', inspector.writes);
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
            report?.server === modernUrl && report.tools.length === 10 && report.hiddenTools[0]?.name === 'broken_header' && report.serverInfo?.name === 'Mock MCP Server',
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

        // Apps, with no app yet: the examples to start from, and the model they call, a chat tool
        // found among your servers (the mock's stand-in here) until you choose another.
        await page.run(`(() => {
            ${showWorkbench};
            ${serverRow(modernUrl)}.click();
            document.querySelector('[data-mode="apps"]').click();
        })()`);
        const start = await page.waitFor(`(() => {
            const start = document.getElementById('appsStart');
            const examples = [...start.querySelectorAll('[data-example] .apps-start-name')].map(name => name.textContent).join(', ');
            const rail = [...document.querySelectorAll('apps-rail [data-example]')].map(row => row.textContent.trim().replace(/\\s+/g, ' ')).join(' | ');
            const model = start.querySelector('.app-model-name')?.textContent;
            const shown = !start.hidden && document.getElementById('appBuilder').hidden && !document.getElementById('appsPage').hidden;
            return shown && model ? [examples, rail, model].join(' / ') : null;
        })()`, 10000);
        check('Apps: with no app yet, the page offers the examples and a blank app, the rail lists the examples, and the model is a chat tool it found',
            start === 'Chat, Project pulse, Front desk, New app / Chat agent loop | Project pulse dashboard | Front desk screens / chat on modern server, asked in message', start);
        await page.run(`(() => {
            const tool = document.querySelector('#appsStart [data-model-tool]');
            tool.value = 'echo';
            tool.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const chosenModel = await page.waitFor(`(() => {
            const name = document.querySelector('#appsStart .app-model-name')?.textContent;
            const saved = JSON.parse(localStorage.getItem('appsModel') || 'null');
            return name?.startsWith('echo') ? [name, saved?.messageField, document.querySelector('#appsStart [data-model-details] .app-note').textContent.trim()].join(' | ') : null;
        })()`, 5000);
        await page.run(`document.querySelector('#appsStart [data-model-found]').click()`);
        const foundAgain = await page.waitFor(`localStorage.getItem('appsModel') === null ? document.querySelector('#appsStart .app-model-name')?.textContent : null`, 5000);
        check('Apps: the Model menus choose another model, and Use the one found goes back to it',
            chosenModel === 'echo on modern server, asked in text | text | You chose it. Use the one found instead' && foundAgain === 'chat on modern server, asked in message',
            `${chosenModel}; ${foundAgain}`);

        {
            // Building an app: New app starts a screen and a flow that work. The screen runs in a
            // sandboxed frame, and the flow calls tools through the worker, as recorded runs.
            await page.run(`(() => {
                ${showWorkbench};
                ${serverRow(modernUrl)}.click();
                document.querySelector('[data-mode="apps"]').click();
                document.getElementById('newAppBtn').click();
            })()`);
            const onCanvas = await page.waitFor(`(() => {
                const wires = [...document.querySelectorAll('app-canvas [data-wire]')].map(wire => wire.dataset.wire.split(':')[0]);
                const picked = document.querySelector('app-inspector .app-inspector-kind')?.textContent;
                return !document.getElementById('appBuilder').hidden && wires.length === 4 && picked ? wires.join(',') + ' | ' + picked : null;
            })()`, 10000);
            check('Apps: a new app opens on the canvas, its screen wired to its tool, and the Inspector shows the screen',
                onCanvas === 't,a,r,r | Screen', onCanvas);
            // These checks use the Outline, which shows the screen and the rules as cards.
            await page.run(`document.querySelector('app-header [data-app-view-choice="outline"]').click()`);
            const starter = await page.waitFor(`(() => {
                const sentence = document.querySelector('app-flow .app-rule-sentence')?.textContent;
                return !document.getElementById('appBuilder').hidden && document.getElementById('appsStart').hidden && sentence ? sentence : null;
            })()`, 5000);
            check('Apps: New app starts with a rule that sends its text box to a tool and the answer to its output',
                starter === 'When run is clicked, call echo on modern server with text = {{input}}; if it works, put {{text}} into output; if it fails, put {{error}} into output.', starter);
            const screen = await frameWaitFor(`document.getElementById('run') && document.getElementById('output') ? document.body.innerText.replace(/\\s+/g, ' ').trim() : null`);
            check('Apps: the screen runs in a frame of its own', /^New app Input Run Output/.test(screen || ''), screen);
            const sandbox = await page.run(`document.querySelector('app-try iframe').getAttribute('sandbox')`);
            const confined = await frameRun(`Promise.all([
                fetch(${JSON.stringify(modernUrl)}).then(() => 'fetched', () => 'no network'),
                new Promise(resolve => { try { resolve(String(localStorage.length)); } catch { resolve('no storage'); } }),
            ]).then(results => results.join(', '))`);
            check('Apps: the screen\'s frame can\'t reach the network or the app\'s storage', sandbox === 'allow-scripts' && confined === 'no network, no storage', `${sandbox}: ${confined}`);
            // Types into the screen and clicks, once the frame has loaded with both (and its runtime).
            const typeAndClick = async (field, text, button) => {
                const ids = [field, button].map(id => `!!document.getElementById(${JSON.stringify(id)})`).join(' && ');
                await frameWaitFor(`document.readyState === 'complete' && ${ids}`);
                return frameRun(`(() => {
                    document.getElementById(${JSON.stringify(field)}).value = ${JSON.stringify(text)};
                    document.getElementById(${JSON.stringify(button)}).click();
                    return true;
                })()`);
            };
            await typeAndClick('input', 'hello from an app', 'run');
            const answered = await frameWaitFor(`document.getElementById('output').textContent === 'Echo: hello from an app' && !document.getElementById('output').dataset.state`);
            const whatHappened = await page.waitFor(`(() => {
                const lines = [...document.querySelectorAll('app-try .app-trace-text')].map(line => line.textContent.trim());
                return lines.some(line => line === 'Put “Echo: hello from an app” into output') ? lines.join(' | ') : null;
            })()`, 5000);
            check('Apps: clicking the button calls the tool, puts its answer in the output and says what happened',
                !!answered && /^run was clicked \| Calling echo on modern server with \{"text":"hello from an app"\} \| echo answered in \d+ ms: Echo: hello from an app Open in the Workbench \| Put/.test(whatHappened || ''), whatHappened);
            const appRun = await page.waitFor(`new Promise((resolve, reject) => {
                const open = indexedDB.open('mcp_sandbox');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const all = open.result.transaction('runs').objectStore('runs').getAll();
                    all.onsuccess = () => {
                        const [run] = all.result.filter(run => run.source === 'app').sort((a, b) => b.startedAt - a.startedAt);
                        resolve(run ? JSON.stringify({ args: run.args, sentArgs: run.sentArgs, outcome: run.outcome }) : null);
                    };
                };
            })`, 5000);
            check('Apps: the call is a run from the app, with its arguments as written and as sent',
                appRun === JSON.stringify({ args: { text: '{{input}}' }, sentArgs: { text: 'hello from an app' }, outcome: 'ok' }), appRun);
            // Open in the Workbench, beside the answer, opens the call there: filled in with what the
            // app sent, since {{input}} is the app's and no variable, and what came back, with Sent.
            await page.run(`document.querySelector('app-try [data-trace] [data-open-run]').click()`);
            const openedCall = await page.waitFor(`(() => {
                const note = document.querySelector('#requestPane .wb-request-note')?.textContent || '';
                if (document.body.dataset.mode !== 'workbench' || !note.startsWith('Opened')) return null;
                return [document.querySelector('#requestPane .wb-crumb-tool')?.textContent, document.querySelector('#requestForm [name="text"]')?.value,
                    document.querySelectorAll('#requestForm .wb-resolved.text-error').length + ' errors', note,
                    document.querySelector('#responsePane .run-summary')?.textContent.includes('From history · App') ? 'from history' : 'not from history'].join(' | ');
            })()`, 5000);
            await page.run(`document.querySelector('#responsePane [data-response-tab="sent"]').click()`);
            const sentShown = await page.waitFor(`(() => {
                const sent = [...document.querySelectorAll('#responsePane .wb-sent dt')].map(name => name.textContent.trim() + ' = ' + name.nextElementSibling.textContent);
                return sent.length ? document.querySelector('#responsePane .wb-sent-head').textContent + ' ' + sent.join(', ') : null;
            })()`, 5000);
            check("Apps: Open in the Workbench, beside an answer in What happened, opens the call with what the app sent, ready to run again, and what came back",
                openedCall === "echo | hello from an app | 0 errors | Opened the app's call, with what it sent: the app filled in {{input}}. Run sends it again. | from history"
                    && sentShown === 'What the app sent to echo: text = hello from an app',
                `${openedCall}; ${sentShown}`);
            await page.run(`document.querySelector('[data-mode="apps"]').click()`);
            await page.run(`(() => {
                const show = document.querySelector('app-flow [data-route="0"] [data-route-show]');
                show.value = 'You said {{input}}, and it said {{text}}';
                show.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await typeAndClick('input', 'hi', 'run');
            const templated = await frameWaitFor(`(() => { const text = document.getElementById('output').textContent; return text.startsWith('You said') ? text : null; })()`);
            check('Apps: what a rule shows can mix the answer with values from the screen', templated === 'You said hi, and it said Echo: hi', templated);
            await page.run(`(() => {
                const field = document.querySelector('app-flow [data-rule-call] [name="text"]');
                field.value = '{{nowhere}}';
                field.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await frameRun(`(document.getElementById('run').click(), true)`);
            const failed = await frameWaitFor(`(() => { const output = document.getElementById('output'); return output.dataset.state === 'error' ? output.textContent : null; })()`);
            check('Apps: a rule that can\'t make its call says why, through its "if it fails" route',
                failed === "Didn't call echo: {{nowhere}} isn't an element on the screen or a variable in Default.", failed);
            await page.run(`(() => {
                const field = document.querySelector('app-flow [data-rule-call] [name="text"]');
                field.value = '{{input}}';
                field.dispatchEvent(new Event('input', { bubbles: true }));
                const id = document.querySelector('app-screen [data-component="input"] [data-component-id]');
                id.value = 'question';
                id.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
            const renamed = await page.waitFor(`(() => {
                const field = document.querySelector('app-flow [data-rule-call] [name="text"]');
                const show = document.querySelector('app-flow [data-route="0"] [data-route-show]');
                return document.querySelector('app-screen [data-component="question"]') && field?.value === '{{question}}' ? show.value : null;
            })()`, 5000);
            check('Apps: renaming a component takes the flow with it', renamed === 'You said {{question}}, and it said {{text}}', renamed);

            // A screen a tool made: the mock's make_screen returns a page (with a script that mustn't run).
            await page.run(`document.querySelector('app-screen [data-screen-kind="html"]').click()`);
            await page.waitFor(`!!document.querySelector('app-screen [data-source="tool"]')`, 5000);
            await page.run(`document.querySelector('app-screen [data-source="tool"]').click()`);
            await page.waitFor(`!!document.querySelector('app-screen [data-call-server]')`, 5000);
            await page.run(`(() => {
                const server = document.querySelector('app-screen [data-call-server]');
                server.value = ${JSON.stringify(modernUrl)};
                server.dispatchEvent(new Event('change', { bubbles: true }));
                const tool = document.querySelector('app-screen [data-call-tool]');
                tool.value = 'make_screen';
                tool.dispatchEvent(new Event('change', { bubbles: true }));
                document.querySelector('app-screen [data-get-html]').click();
            })()`);
            const found = await page.waitFor(`(() => {
                const text = document.querySelector('app-screen [data-found]')?.textContent || '';
                return /question/.test(text) && /answer/.test(text) ? text.replace(/\\s+/g, ' ') : null;
            })()`, 10000);
            check('Apps: a screen can be the HTML a tool returns, and the builder lists its elements', found === '3 elements with ids the flow can use: question field, ask button, answer output', found);
            const problems = await page.waitFor(`document.querySelector('app-flow [data-problems]:not([hidden])')?.textContent || null`, 5000);
            check('Apps: a rule says when the screen no longer has what it uses', problems === "run isn't on the screen.output isn't on the screen.", problems);
            await page.run(`(() => {
                const when = document.querySelector('app-flow [data-when-element]');
                when.value = 'ask';
                when.dispatchEvent(new Event('change', { bubbles: true }));
                for (const into of document.querySelectorAll('app-flow [data-route-into]')) {
                    into.value = 'answer';
                    into.dispatchEvent(new Event('change', { bubbles: true }));
                }
            })()`);
            const quiet = await frameWaitFor(`document.getElementById('ask') && document.getElementById('answer') ? document.getElementById('answer').textContent || 'empty' : null`);
            check('Apps: the HTML a tool returns runs without its own scripts', quiet === 'empty', quiet);
            await typeAndClick('question', 'a tool made this', 'ask');
            const toolScreen = await frameWaitFor(`(() => { const text = document.getElementById('answer')?.textContent; return text?.startsWith('You said') ? text : null; })()`);
            check('Apps: the flow works the same on a screen a tool made', toolScreen === 'You said a tool made this, and it said Echo: a tool made this', toolScreen);

            // Download is a zip of a folder that runs the app once it's served: the flow as DML, the
            // screen as HTML and a README, beside the client's own files, whose index.html names the
            // app. Importing it brings the app back.
            const appDownloads = mkdtempSync(join(tmpdir(), 'mcp-smoke-app-'));
            await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: appDownloads });
            await page.run(`document.getElementById('downloadAppBtn').click()`);
            let zipName;
            for (let i = 0; i < 100 && !zipName; i++) {
                zipName = readdirSync(appDownloads).find(name => name.endsWith('.zip'));
                if (!zipName) await sleep(100);
            }
            const zipped = zipName ? await unzip(readFileSync(join(appDownloads, zipName))) : new Map();
            const zippedText = name => (zipped.has(`new-app-v1/${name}`) ? new TextDecoder().decode(zipped.get(`new-app-v1/${name}`)) : '');
            let fromZip;
            try {
                fromZip = fromDml(zippedText('app.dml'), { files: { 'screen.html': zippedText('screen.html') } }).app;
            } catch (error) {
                fromZip = { error: error.message };
            }
            const zippedNames = [...zipped.keys()];
            const clientList = JSON.parse(readFileSync(join(ROOT, 'public', 'client-files.json'), 'utf8')).files;
            const leftOut = clientList.filter(file => !zipped.has(`new-app-v1/${file}`));
            const named = zippedText('index.html').match(/<meta name="mcp-app" content="app\.dml" data-name="New app" data-run="([^"]+)" data-root="([^"]+)">/);
            check('Apps: Download saves a zip of a folder: the flow as DML, the screen as HTML and a README, with the client that runs it, whose page names the app',
                zipName === 'new-app-v1.zip' && zippedNames.every(name => name.startsWith('new-app-v1/')) && zippedNames.slice(0, 3).join(', ') === 'new-app-v1/app.dml, new-app-v1/screen.html, new-app-v1/README.md'
                    && !leftOut.length && zippedNames.length === clientList.length + 3 && !zipped.has('new-app-v1/sdk_client.js.map')
                    && named?.[2] === `${HOST}:${PORTS.app}/` && named[1].startsWith(`${HOST}:${PORTS.app}/${RUN_HASH}`)
                    && fromZip.version === 1 && fromZip.screen?.kind === 'html' && fromZip.screen.from?.toolName === 'make_screen'
                    && /<input id="question"/.test(zippedText('screen.html')) && fromZip.flow?.[0]?.when?.[0]?.element === 'ask'
                    && zippedText('README.md').includes('1. When `ask` is clicked, call echo on modern server with text = {{question}}; if it works, put “You said {{question}}, and it said {{text}}” into `answer`')
                    && zippedText('README.md').includes('## Run it\n\nServe this folder and open its address.')
                    && zippedText('README.md').includes(`a link that runs version 1 in MCP Browser Client at ${HOST}:${PORTS.app}/. For a page that runs it from a double-click, Share in the builder has embed.html.`),
                `${zipName}: ${zippedNames.length} files, ${zippedNames.slice(0, 3).join(', ')}…${leftOut.length ? `; without ${leftOut.join(', ')}` : ''}; ${named ? named[2] : 'no <meta> naming the app'}${fromZip.error ? `; ${fromZip.error}` : ''}`);

            // Served, the folder runs its app.dml. At its own address the client has none of this
            // one's servers, so the app's bar offers to add the one it calls; once added, it answers.
            const unzipped = join(appDownloads, 'unzipped');
            for (const [name, data] of zipped) {
                mkdirSync(dirname(join(unzipped, name)), { recursive: true });
                writeFileSync(join(unzipped, name), data);
            }
            const folderPort = await freePort();
            serveApp(folderPort, { root: unzipped, label: 'download' });
            await page.send('Target.createTarget', { url: `${HOST}:${folderPort}/new-app-v1/?client=${CLIENT_NAME}` });
            const served = await openPage(target => target.url.startsWith(`${HOST}:${folderPort}/`));
            const servedShown = await served.waitFor(`(() => {
                const preview = document.querySelector('app-preview');
                const notes = preview?.querySelector('[data-launch-notes]');
                if (!preview || preview.hidden || !preview.querySelector('iframe') || !notes || notes.hidden) return null;
                return [document.title, preview.querySelector('[data-launch-actions]')?.textContent.trim(), notes.innerText.replace(/\\s+/g, ' ').trim()].join(' | ');
            })()`, 20000);
            await served.run(`document.querySelector('app-preview [data-add-server-for-app]')?.click()`);
            await served.waitFor(`Object.values(appShell.servers).some(server => server.status === 'connected' && server.tools?.some(tool => tool.name === 'echo'))`, 15000);
            await frameWaitFor(`document.readyState === 'complete' && !!document.getElementById('ask')`, 10000, { inPage: served });
            await frameRun(`(() => {
                document.getElementById('question').value = 'from the folder';
                document.getElementById('ask').click();
                return true;
            })()`, { inPage: served });
            const servedAnswered = await frameWaitFor(`document.getElementById('answer')?.textContent || null`, 10000, { inPage: served });
            await closeTab(served);
            check("Apps: the download's folder, served, runs its app.dml; at its own address it offers to add the server the app calls, and once added the app answers",
                servedShown === `New app | Open in the builder | It calls modern server (${HOST}:${PORTS.modern}/), which isn't one of your servers. Add it`
                    && servedAnswered === 'You said from the folder, and it said Echo: from the folder',
                `${servedShown}; ${servedAnswered}`);

            // Opened as a file, the page can't run, and says to serve the folder; its link runs the
            // app, as it is in the zip, in the client it came from.
            let linked;
            try {
                linked = fromDml(await unpackApp(named?.[1].split(RUN_HASH)[1] || '')).app;
            } catch (error) {
                linked = { error: error.message };
            }
            await page.send('Target.createTarget', { url: `file://${join(unzipped, 'new-app-v1', 'index.html')}` });
            const asFile = await openPage(target => target.url.startsWith('file://'));
            const fileNotice = await asFile.waitFor(`(() => {
                const notice = document.getElementById('fromFile');
                // The notice shows as it's parsed, before the rest of the page is.
                if (document.readyState === 'loading' || !notice || notice.hidden) return null;
                const link = notice.querySelector('[data-from-file-link]');
                return [notice.querySelector('[data-from-file-title]').textContent, getComputedStyle(document.querySelector('.wb-app')).display, link.textContent.trim(), link.getAttribute('href') === ${JSON.stringify(named?.[1] || '')} ? 'the link in the page' : link.getAttribute('href')].join(' | ');
            })()`, 10000);
            await asFile.run(`document.querySelector('[data-from-file-link]').click()`);
            asFile.close();
            const fromDisk = await openPage(target => target.url.startsWith(`${HOST}:${PORTS.app}/${RUN_HASH}`));
            const diskShown = await fromDisk.waitFor(`(() => {
                const preview = document.querySelector('app-preview');
                if (!preview || preview.hidden || !preview.querySelector('iframe')) return null;
                return [document.title, preview.querySelector('[data-launch-actions]')?.textContent.trim()].join(' | ');
            })()`, 15000);
            await frameWaitFor(`document.readyState === 'complete' && !!document.getElementById('ask')`, 10000, { inPage: fromDisk });
            await frameRun(`(() => {
                document.getElementById('question').value = 'from the download';
                document.getElementById('ask').click();
                return true;
            })()`, { inPage: fromDisk });
            const diskAnswered = await frameWaitFor(`document.getElementById('answer')?.textContent || null`, 10000, { inPage: fromDisk });
            await closeTab(fromDisk);
            await page.send('Page.bringToFront');
            check("Apps: the folder's page, opened as a file, says to serve the folder, and its link runs the app as it is in the zip in the client it came from",
                fileNotice === 'New app runs from a web address | none | Run New app there | the link in the page'
                    && linked.screen?.html === fromZip.screen?.html && linked.flow?.[0]?.call?.toolName === 'echo'
                    && diskShown === 'New app | Open in the builder' && diskAnswered === 'You said from the download, and it said Echo: from the download',
                `${fileNotice}; ${linked.error || ''}; ${diskShown}; ${diskAnswered}`);
            const firstVersion = await page.waitFor(`(() => {
                const version = document.getElementById('appVersion')?.textContent || '';
                return version.startsWith('Version 1, downloaded') ? version + ' | ' + document.getElementById('downloadAppBtn').textContent.trim() : null;
            })()`, 5000);
            check('Apps: a download is version 1', firstVersion === 'Version 1, downloaded just now | Download v1', firstVersion);
            await page.run(`(() => {
                document.querySelector('app-header .app-more-menu').open = true;
                const remove = document.getElementById('deleteAppBtn');
                remove.click();
                remove.click();
            })()`);
            const deleted = await page.waitFor(`!document.getElementById('appsStart').hidden && !document.querySelector('apps-rail #appList [data-show-app]')`, 5000);
            const { root } = (await page.send('DOM.getDocument', { depth: -1 })).result;
            const { nodeId } = (await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#importAppInput' })).result;
            await page.send('DOM.setFileInputFiles', { nodeId, files: [join(appDownloads, zipName || 'missing.zip')] });
            const imported = await page.waitFor(`(() => {
                const shown = !document.getElementById('appBuilder').hidden && document.getElementById('appName')?.value === 'New app';
                return shown ? document.querySelector('app-flow .app-rule-sentence')?.textContent : null;
            })()`, 10000);
            await sleep(500);
            const importedVersion = await page.run(`document.getElementById('appVersion').textContent + ' | ' + document.getElementById('downloadAppBtn').textContent.trim()`);
            check('Apps: Delete removes the app, and importing its zip brings it back as version 1, unchanged',
                !!deleted && /^When ask is clicked, call echo on modern server with text = \{\{question\}\}/.test(imported || '')
                    && importedVersion === 'Version 1, downloaded just now | Download v1', `${imported}; ${importedVersion}`);
            await typeAndClick('question', 'after the import', 'ask');
            const reimported = await frameWaitFor(`document.getElementById('answer')?.textContent === 'You said after the import, and it said Echo: after the import'`);
            await page.run(`(() => {
                const description = document.getElementById('appDescription');
                description.value = 'Asks the mock';
                description.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            const next = await page.run(`document.getElementById('downloadAppBtn').textContent.trim() + ' | ' + document.querySelector('apps-rail [aria-current="true"]').textContent.trim().replace(/\\s+/g, ' ')`);
            const lastSteps = await page.run(`[...document.querySelectorAll('app-try .app-trace-text')].slice(-4).map(line => line.textContent.trim()).join(' | ')`);
            check('Apps: the imported app runs as before, and a change makes the next download version 2',
                !!reimported && next === 'Download v2 | New app v1', `${next}; ${reimported ? '' : `the screen shows "${await frameRun(`document.getElementById('answer')?.textContent || 'nothing'`)}" after ${lastSteps}`}`);
            rmSync(appDownloads, { recursive: true, force: true });
        }
        {
            // An example asks before it adds a copy: Cancel adds nothing, and Add a copy adds it.
            const appRows = `document.querySelectorAll('#appList [data-show-app]').length`;
            const rowsBefore = await page.run(appRows);
            const askedToAdd = async () => {
                await page.run(`document.querySelector('apps-rail [data-example="chat"]').click()`);
                return page.waitFor(`(() => {
                    const dialog = document.querySelector('apps-add-dialog dialog');
                    return dialog?.open ? [dialog.querySelector('h2').textContent, [...dialog.querySelectorAll('button')].map(button => button.textContent.trim()).join(', '),
                        'focus on ' + document.activeElement?.textContent.trim()].join(' | ') : null;
                })()`, 5000);
            };
            const offered = await askedToAdd();
            await page.run(`document.querySelector('apps-add-dialog [data-cancel]').click()`);
            const cancelled = await page.run(`(document.querySelector('apps-add-dialog dialog').open ? 'still open' : 'closed') + ', ' + ${appRows} + ' apps'`);
            await askedToAdd();
            await page.run(`document.querySelector('apps-add-dialog [data-add-copy]').click()`);
            check('Apps: an example asks before it adds a copy under Your apps: Cancel adds nothing, and Add a copy adds it',
                offered === 'Add a copy of Chat? | Cancel, Add a copy | focus on Add a copy' && cancelled === `closed, ${rowsBefore} apps`, `${offered}; ${cancelled}`);

            // The Chat example: an app like any other, whose one rule sends the message and the
            // conversation so far to the model. The mock's chat says what it was sent and how many
            // earlier messages came with it, and writes a tool call when asked to call a tool.
            const chatShown = await page.waitFor(`(() => {
                const current = document.querySelector('apps-rail [aria-current="true"] .wb-row-label')?.textContent;
                return document.getElementById('appName')?.value === 'Chat' && !document.getElementById('appBuilder').hidden ? current : null;
            })()`, 10000);
            const chatScreen = await frameWaitFor(`document.getElementById('send') && document.getElementById('conversation')?.classList.contains('box-conversation') ? document.body.innerText.replace(/\\s+/g, ' ').trim() : null`);
            check('Apps: Chat, under Examples, makes an app under Your apps: a conversation, a message field and Send',
                chatShown === 'Chat' && chatScreen === "Chat A conversation with chat on modern server, which can call your servers' tools. Each message goes with the conversation so far. Conversation Message Send",
                `${chatShown}; ${chatScreen}`);
            const conversation = `[...document.querySelectorAll('#conversation .entry')].map(entry => entry.dataset.role + ': ' + entry.textContent)`;
            const say = async text => {
                await frameWaitFor(`document.readyState === 'complete' && !!document.getElementById('message') && !document.getElementById('send').disabled`);
                await frameRun(`(() => {
                    document.getElementById('message').value = ${JSON.stringify(text)};
                    document.getElementById('send').click();
                    return true;
                })()`);
            };
            const entriesAfter = count => frameWaitFor(`(() => {
                const shown = ${conversation};
                return shown.length >= ${count} && !document.getElementById('send').disabled ? shown : null;
            })()`);
            await say('hello from the chat example');
            const first = await entriesAfter(2);
            const cleared = await frameRun(`document.getElementById('message').value === '' ? 'cleared' : 'not cleared'`);
            await say('and again');
            const second = await entriesAfter(4);
            check("Apps: Chat puts the message in the conversation as it's sent and clears the field, then the answer; the next one goes with the conversation so far",
                first?.join(' | ') === 'you: hello from the chat example | reply: You said: hello from the chat example' && cleared === 'cleared'
                    && second?.slice(2).join(' | ') === 'you: and again | reply: You said: and again (2 earlier messages came with it.)',
                `${first?.join(' | ')}; ${cleared}; ${second?.slice(2).join(' | ')}`);
            const sent = await page.run(`${latestRun('chat', 'app')}.then(run => run && JSON.stringify({ args: run.args, sentArgs: run.sentArgs }))`);
            const { args: chatArgs, sentArgs: chatSent } = JSON.parse(sent || '{}');
            check("Apps: the model gets the conversation so far as a list, and the message after its instructions and your servers' tools",
                JSON.stringify(chatArgs) === JSON.stringify({ message: '{{message}}', history: '{{conversation}}' })
                    && JSON.stringify(chatSent?.history) === JSON.stringify(['User: hello from the chat example', 'Assistant: You said: hello from the chat example'])
                    && /^You're the assistant in a chat app built with MCP Browser Client: answer briefly and plainly\./.test(chatSent?.message || '')
                    && (chatSent?.message || '').includes('\n\nYou can call the tools listed below.')
                    && (chatSent?.message || '').includes(`"url":${JSON.stringify(modernUrl)}`)
                    && (chatSent?.message || '').endsWith('```\n\nand again'),
                `${JSON.stringify(chatArgs)}; ${JSON.stringify(chatSent?.history)}; ${(chatSent?.message || '').slice(0, 80)}…${(chatSent?.message || '').slice(-30)}`);

            // A tool call in the model's answer runs, from the page, as a run from a reply, and its
            // result joins the conversation. Three run in 10 seconds; the fourth is skipped.
            await say('call echo with hello from the model');
            const called = await entriesAfter(7);
            const replyRun = await page.waitFor(`${latestRun('echo', 'reply')}.then(run => run && JSON.stringify({ sentArgs: run.sentArgs, outcome: run.outcome }))`, 5000);
            check("Apps: a tool call in the model's answer runs as a run from a reply, and its result joins the conversation",
                called?.[4] === 'you: call echo with hello from the model' && /^reply: I'll ask echo\.\n\n```json\n\{"jsonrpc": "2\.0", "method": "echo"/.test(called?.[5] || '')
                    && called?.[6] === 'tool: echo: Echo: hello from the model' && replyRun === JSON.stringify({ sentArgs: { text: 'hello from the model' }, outcome: 'ok' }),
                `${called?.slice(4).join(' | ')}; ${replyRun}`);
            for (const n of [2, 3, 4]) {
                await say(`call echo with call ${n}`);
                await entriesAfter(7 + n * 3 - 3);
            }
            const limited = await frameRun(`${conversation}.slice(-1)[0]`);
            const toolResults = await frameRun(`${conversation}.filter(entry => entry.startsWith('tool: echo')).length`);
            check("Apps: an answer's tool calls run at most three in 10 seconds, and the conversation says when one was skipped",
                limited === "error: Skipped echo: an answer's tool calls run at most 3 in 10 seconds." && toolResults === 3, `${limited}; ${toolResults} results`);

            // Preview: the app as it is when it's launched, over the whole window and from the start,
            // with nothing of the builder running; at a phone's width; and Escape ends it, pressed on
            // the app's screen or off it, back in the view it came from (the Outline, here).
            const editView = await page.run(`localStorage.getItem('appsView')`);
            const builderFrame = `document.querySelector(${JSON.stringify(editView === 'outline' ? 'app-try iframe' : 'app-canvas iframe')})`;
            await page.run(`document.getElementById('previewAppBtn').click()`);
            const previewShown = await page.waitFor(`(() => {
                const preview = document.querySelector('app-preview');
                const frame = preview?.querySelector('iframe');
                if (!preview || preview.hidden || !frame) return null;
                const box = frame.getBoundingClientRect();
                const whole = Math.abs(box.width - document.documentElement.clientWidth) <= 1 && Math.abs(box.bottom - window.innerHeight) <= 1;
                const builderFrames = document.querySelectorAll('app-canvas iframe, app-try iframe').length;
                return [whole ? 'the whole window' : 'not the whole window', builderFrames + ' builder frames',
                    document.activeElement?.matches('[data-exit-preview]') ? 'Exit focused' : 'focus elsewhere', 'view kept ' + localStorage.getItem('appsView')].join(', ');
            })()`, 5000);
            const launched = await frameWaitFor(`document.readyState === 'complete' && document.getElementById('conversation') ? String(document.querySelectorAll('#conversation .entry').length) : null`);
            check('Apps: Preview shows the app over the whole window, started again, with nothing of the builder running',
                previewShown === `the whole window, 0 builder frames, Exit focused, view kept ${editView}` && launched === '0', `${previewShown}; ${launched} entries`);
            await say('hello from the preview');
            const used = await entriesAfter(2);
            const told = await page.waitFor(`(() => {
                const text = document.querySelector('app-preview [data-preview-status]')?.textContent || '';
                return /answered/.test(text) ? text : null;
            })()`, 5000);
            check('Apps: in Preview the app works as it does when launched, and the bar says what it did',
                used?.join(' | ') === 'you: hello from the preview | reply: You said: hello from the preview' && /^chat answered in \d+ ms$/.test(told || ''),
                `${used?.join(' | ')}; ${told}`);
            await page.run(`document.querySelector('app-preview [data-device="phone"]').click()`);
            const phone = await frameWaitFor(`(() => {
                if (window.innerWidth !== 390) return null;
                const stacked = document.getElementById('send').getBoundingClientRect().top >= document.getElementById('message').getBoundingClientRect().bottom;
                return document.querySelectorAll('#conversation .entry').length + ' entries at ' + window.innerWidth + ' px, ' + (stacked ? 'Send under the message' : 'Send beside the message');
            })()`);
            check("Apps: Preview at a phone's width gives the app 390 pixels, where what shares a row stacks, and keeps what it shows",
                phone === '2 entries at 390 px, Send under the message', phone);
            await frameRun(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
            const backFromScreen = await page.waitFor(`document.querySelector('app-preview').hidden && ${builderFrame} && document.activeElement?.id === 'previewAppBtn' ? 'back, Preview focused' : null`, 5000);
            await page.run(`document.getElementById('previewAppBtn').click()`);
            await page.waitFor(`!document.querySelector('app-preview').hidden && !!document.querySelector('app-preview iframe')`, 5000);
            for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            const backFromPage = await page.waitFor(`document.querySelector('app-preview').hidden && ${builderFrame} ? 'back' : null`, 5000);
            check("Apps: Escape ends Preview, pressed on the app's screen or off it, and the builder runs the app again where Preview came from",
                backFromScreen === 'back, Preview focused' && backFromPage === 'back', `${backFromScreen}; ${backFromPage}`);
        }
        {
            // The canvas: the app's screen running with a port beside each element, Start, a node for
            // each rule's tool, and wires between them, each one part of a rule. These checks build
            // onto a new app with real mouse drags, at a size where all of it shows.
            await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
            // An example you've added before offers your copy instead of another one.
            await page.run(`[...document.querySelectorAll('apps-rail [data-show-app]')].find(row => row.querySelector('.wb-row-label').textContent === 'New app').click()`);
            await page.waitFor(`document.getElementById('appName')?.value === 'New app'`, 5000);
            const appsBefore = await page.run(`document.querySelectorAll('#appList [data-show-app]').length`);
            await page.run(`document.querySelector('apps-rail [data-example="chat"]').click()`);
            const offeredCopy = await page.waitFor(`(() => {
                const dialog = document.querySelector('apps-add-dialog dialog');
                return dialog?.open && dialog.querySelector('[data-open-copy]') ? [dialog.querySelector('.apps-dialog-have').textContent, [...dialog.querySelectorAll('button')].map(button => button.textContent.trim()).join(', '),
                    'focus on ' + document.activeElement?.textContent.trim()].join(' | ') : null;
            })()`, 5000);
            await page.run(`document.querySelector('apps-add-dialog [data-open-copy]').click()`);
            const openedCopy = await page.waitFor(`document.getElementById('appName')?.value === 'Chat' ? 'Chat, ' + document.querySelectorAll('#appList [data-show-app]').length + ' apps' : null`, 5000);
            check('Apps: an example you have a copy of offers to open it instead of adding another',
                /^You have a copy already: Chat, added (just now|\d+ s ago|\d+ min ago)\. \| Cancel, Add another copy, Open Chat \| focus on Open Chat$/.test(offeredCopy || '') && openedCopy === `Chat, ${appsBefore} apps`,
                `${offeredCopy}; ${openedCopy}`);

            // Ask a model asks the model found among your servers: here the mock's stand-in, chat.
            await page.run(`document.getElementById('newAppBtn').click()`);
            await page.waitFor(`document.getElementById('appName')?.value === 'New app 2' && !!document.querySelector('app-header [data-app-view-choice="canvas"]')`, 5000);
            await page.run(`document.querySelector('app-header [data-app-view-choice="canvas"]').click()`);
            await page.waitFor(`document.querySelectorAll('app-canvas [data-wire]').length === 4`, 10000);

            const port = name => `document.querySelector('app-canvas [data-port="${name}"]')`;
            const fromLibrary = async item => {
                await page.run(`document.querySelector('app-canvas [data-toggle-library]').click()`);
                await page.waitFor(`!!document.querySelector('app-canvas [data-library]:not([hidden]) ${item}')`, 5000);
                await page.run(`document.querySelector('app-canvas [data-library] ${item}').click()`);
            };
            // Drags from one port to another as a person would, with both in view. Each end is a port's
            // name, or a selector for something else to press or release on.
            const drag = async (from, to) => {
                const selector = end => (end.includes(' ') ? end : `app-canvas [data-port="${end}"]`);
                const points = await page.run(`(() => {
                    const ends = () => [${JSON.stringify(selector(from))}, ${JSON.stringify(selector(to))}].map(found => document.querySelector(found)?.getBoundingClientRect());
                    const scroller = document.querySelector('app-canvas [data-canvas-scroll]');
                    scroller.scrollIntoView({ block: 'nearest' });
                    let [a, b] = ends();
                    if (!a || !b) return null;
                    const box = scroller.getBoundingClientRect();
                    scroller.scrollTop += (a.top + b.top) / 2 - (box.top + box.height / 2);
                    scroller.scrollLeft += (a.left + b.left) / 2 - (box.left + box.width / 2);
                    [a, b] = ends();
                    return [a.left + a.width / 2, a.top + a.height / 2, b.left + b.width / 2, b.top + b.height / 2];
                })()`);
                if (!points) return;
                const [x1, y1, x2, y2] = points;
                await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
                await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
                for (let step = 1; step <= 6; step++) {
                    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * step) / 6, y: y1 + ((y2 - y1) * step) / 6, button: 'left', buttons: 1 });
                }
                await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
            };

            // The Library adds an output and a tool; dragging wires the tool between them.
            await fromLibrary('[data-library-item="component"][data-type="output"]');
            await page.waitFor(`!!${port('el:output2')}`, 10000);
            await fromLibrary(`[data-library-item="tool"][data-server="${modernUrl}"][data-tool="count"]`);
            const countRule = await page.waitFor(`(() => {
                const nodes = document.querySelectorAll('app-canvas [data-node]');
                return nodes.length === 2 ? nodes[1].dataset.node : null;
            })()`, 5000);
            await drag('el:run', `run:${countRule}`);
            const triggered = await page.waitFor(`!!document.querySelector('app-canvas [data-wire="t:${countRule}:0"]')`, 5000);
            await drag(`ok:${countRule}`, 'el:output2');
            const wired = await page.waitFor(`document.querySelector('app-canvas [data-wire="r:${countRule}:0"]') ? document.querySelector('app-inspector .app-rule-sentence')?.textContent || null : null`, 5000);
            check('Apps: on the canvas, dragging from a button to a tool\'s Run, and from its Answer to an output, wires them into its rule',
                !!triggered && wired === 'When run is clicked, call count on modern server with n = 3; if it works, put {{text}} into output2.', wired);
            await drag('el:input', 'el:output2');
            const refused = await page.waitFor(`(() => {
                const hint = document.querySelector('app-canvas [data-canvas-hint]');
                return hint.classList.contains('text-error') ? hint.textContent : null;
            })()`, 3000);
            check('Apps: two parts of the screen don\'t wire to each other, and the canvas says why',
                refused === "Two parts of the screen don't connect to each other: connect them through a tool.", refused);

            // Screens and tools look different: a screen's bar is blue with a monitor, a tool's head
            // violet with a tool icon. Pins that start or fill a tool are rings, and those things
            // come out of and land on are solid; a tool shows them under In and Out, and says where
            // each of its outputs goes. A key says so.
            const looks = await page.run(`(() => {
                // A color mixed in CSS comes back as color(srgb r g b), each from 0 to 1.
                const hue = element => {
                    const color = getComputedStyle(element).backgroundColor;
                    const [r, g, b] = color.match(/[\\d.]+/g).map(Number).map(value => (color.startsWith('color(') ? value * 255 : value));
                    return b > r && b > g ? (r > g ? 'violet' : 'blue') : 'neither';
                };
                const node = document.querySelector('app-canvas [data-node="${countRule}"]');
                const bar = document.querySelector('app-canvas [data-card-bar]');
                const blank = getComputedStyle(node).backgroundColor;
                const pin = port => (getComputedStyle(document.querySelector('app-canvas [data-port^="' + port + '"]')).backgroundColor === blank ? 'ring' : 'solid');
                return [
                    'screen ' + hue(bar) + (bar.querySelector('.icon-monitor') ? ' with a monitor' : ''),
                    'tool ' + hue(node.querySelector('.app-node-head')) + (node.querySelector('.app-node-head .icon-tool') ? ' with a tool' : ''),
                    [...node.querySelectorAll('.app-node-caption span')].map(caption => caption.textContent).join(' and '),
                    ['run:', 'arg:', 'sent:', 'ok:', 'err:', 'el:run', 'el:input', 'el:output2'].map(port => port.replace(':', '') + ' ' + pin(port)).join(', '),
                    // Which edge each of count's ports has a pin on: Answer's wire goes back to the screen on its left.
                    ['run', 'sent', 'ok', 'err'].map(port => port + ' ' + [...node.querySelectorAll('[data-port^="' + port + ':"]')].filter(found => found.offsetParent).map(found => found.dataset.side + (found.getBoundingClientRect().left > node.getBoundingClientRect().left + node.offsetWidth / 2 ? ' edge' : '')).join(' and ')).join(', '),
                    [...node.querySelectorAll('[data-out]')].map(row => row.dataset.out + ' ' + row.querySelector('.app-node-where').textContent).join(', '),
                    document.querySelector('app-canvas .app-canvas-key').innerText.replace(/\\s+/g, ' ').trim(),
                ].join(' | ');
            })()`);
            check("Apps: a screen is blue and a tool violet; pins into a tool are rings on its left and those out of it solid on its right, a wire back to the screen leaving from one on the left, under In and Out, each output says where it goes, and a key says so",
                looks === 'screen blue with a monitor | tool violet with a tool | In and Out | run ring, arg ring, sent solid, ok solid, err solid, elrun ring, elinput ring, eloutput2 solid | run left, sent right edge, ok right edge and left, err right edge | sent —, ok → output2, error — | Screen Tool In: starts a tool, fills a field Out: what comes out of a tool Point at a pin to see its wires.',
                looks);

            // Pointing at a pin lights up its wires and the pins at their other ends, and the rest dim.
            const answerPin = JSON.parse(await page.run(`(() => {
                const pin = document.querySelector('app-canvas [data-port="ok:${countRule}"]');
                pin.scrollIntoView({ block: 'center', inline: 'center' });
                const box = pin.getBoundingClientRect();
                return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
            })()`));
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: answerPin.x, y: answerPin.y });
            const lit = await page.waitFor(`(() => {
                const canvas = document.querySelector('app-canvas');
                if (!canvas.classList.contains('app-pointing')) return null;
                return [...new Set([...canvas.querySelectorAll('.app-hot')].map(element => element.dataset.port || (element.dataset.pill ? 'pill ' + element.dataset.pill : 'wire ' + element.dataset.wire)))].sort().join(', ');
            })()`, 3000);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
            const unlit = await page.waitFor(`!document.querySelector('app-canvas').classList.contains('app-pointing') && !document.querySelector('app-canvas .app-hot') ? 'nothing lit' : null`, 3000);
            check('Apps: pointing at a pin lights its wire, its transform and the pin at the other end, and the other wires dim until it leaves',
                lit === `el:output2, ok:${countRule}, pill r:${countRule}:0, wire r:${countRule}:0` && unlit === 'nothing lit', `${lit}; ${unlit}`);

            // A drag ends with the browser's own click where it's let go, which mustn't pick what's
            // there; a click right after it, on something else, still picks.
            await drag('el:input', 'el:output2');
            const afterDrag = await page.run(`(() => {
                const canvas = document.querySelector('app-canvas');
                const before = JSON.stringify(canvas.apps.selection);
                document.querySelector('app-canvas [data-node="${countRule}"] [data-node-status]').click();
                return before + ' then ' + JSON.stringify(canvas.apps.selection);
            })()`);
            check("Apps: the click a drag on the canvas ends with picks nothing, and a click right after it still picks what it's on",
                afterDrag === `{"kind":"wire","id":"r:${countRule}:0","ruleId":"${countRule}"} then {"kind":"rule","id":"${countRule}"}`, afterDrag);

            // The Inspector: what's picked heads it, in its color, and stays as the rest scrolls; the
            // rest is in sections that open and close, say what's in them while closed and stay as
            // they're left. A wire opens only its part, and picking it doesn't scroll the page.
            const folds = `[...document.querySelectorAll('app-inspector [data-fold]')].filter(fold => !fold.hidden).map(fold => fold.dataset.fold.split('.')[1] + (fold.open ? '+' : '-')).join(' ')`;
            const pageScroll = `(() => { let total = 0; for (let box = document.querySelector('app-inspector').parentElement; box; box = box.parentElement) total += box.scrollTop; return total; })()`;
            await page.run(`document.querySelector('app-canvas [data-node="${countRule}"] [data-node-status]').click()`);
            const toolPicked = await page.waitFor(`(() => {
                const head = document.querySelector('app-inspector .app-inspector-head');
                return head?.dataset.tone === 'tool' && getComputedStyle(head).position === 'sticky'
                    ? ['.app-inspector-kind', '.app-inspector-title', '.app-inspector-sub'].map(part => head.querySelector(part)?.textContent).join(' ') + ' | ' + ${folds} : null;
            })()`, 5000) ?? await page.run(`(() => {
                const head = document.querySelector('app-inspector .app-inspector-head');
                return 'picked ' + JSON.stringify(document.querySelector('app-canvas').apps.selection) + ', head ' + head?.dataset.tone + ' ' + (head && getComputedStyle(head).position) + ' ' + head?.textContent.replace(/\\s+/g, ' ').trim();
            })()`);
            await page.run(`document.querySelector('app-inspector [data-fold="rule.call"] > summary').click()`);
            const callClosed = await page.waitFor(`(() => {
                const call = document.querySelector('app-inspector [data-fold="rule.call"]');
                return call && !call.open ? call.querySelector('.app-fold-digest').textContent + ' | ' + localStorage.getItem('appsInspectorFolds') : null;
            })()`, 3000);
            await page.run(`document.querySelector('app-canvas [data-node]:not([data-node="${countRule}"]) [data-node-status]').click()`);
            const otherTool = await page.waitFor(`document.querySelector('app-inspector .app-inspector-title')?.textContent === 'echo' ? ${folds} : null`, 3000);
            const scrollBefore = await page.run(pageScroll);
            await page.run(`document.querySelector('app-canvas [data-pill="r:${countRule}:0"]').click()`);
            const wirePart = await page.waitFor(`(() => {
                const head = document.querySelector('app-inspector .app-inspector-head');
                return head?.dataset.tone === 'answer' ? [head.querySelector('.app-inspector-kind').textContent, ${folds}, document.querySelector('app-inspector .app-ends').innerText.replace(/\\s+/g, ' ').trim()].join(' | ') : null;
            })()`, 3000);
            const scrollAfter = await page.run(pageScroll);
            await page.run(`document.querySelector('app-inspector [data-fold="rule.when"] > summary').click()`);
            await page.run(`document.querySelector('app-inspector .app-end[data-select-rule]').click()`);
            const backToTool = await page.waitFor(`document.querySelector('app-inspector .app-inspector-title')?.textContent === 'count' ? ${folds} + ' | ' + localStorage.getItem('appsInspectorFolds') : null`, 3000);
            await page.run(`document.querySelector('app-inspector [data-fold="rule.call"] > summary').click()`);
            check("Apps: the Inspector heads with what's picked, in its color; its sections open and close, say what's in them closed, and stay as they're left; a wire opens only its part, its ends a click away, without scrolling the page",
                toolPicked === 'Tool count on modern server | when+ call+ then+' && callClosed === 'count on modern server | {"rule.call":false}' && otherTool === 'when+ call- then+'
                    && wirePart === 'Where the answer goes | when- call- then+ | count → output2' && scrollAfter === scrollBefore && backToTool === 'when+ call- then+ | {"rule.call":false}',
                `${toolPicked}; ${callClosed}; ${otherTool}; ${wirePart}; scrolled ${scrollBefore} → ${scrollAfter}; ${backToTool}`);

            // Run: the screen takes clicks, and both tools wired to the button answer.
            await page.run(`document.querySelector('app-canvas [data-canvas-mode="run"]').click()`);
            await frameWaitFor(`document.readyState === 'complete' && !!document.getElementById('output2')`);
            await frameRun(`(() => {
                document.getElementById('input').value = 'from the canvas';
                document.getElementById('run').click();
                return true;
            })()`);
            const ran = await frameWaitFor(`(() => {
                const shown = ['output', 'output2'].map(id => document.getElementById(id)?.textContent).join(' | ');
                return shown === 'Echo: from the canvas | Counted to 3' ? shown : null;
            })()`);
            const answered = await page.waitFor(`(() => {
                const statuses = [...document.querySelectorAll('app-canvas [data-node-status]')].map(status => status.textContent);
                return statuses.length === 2 && statuses.every(text => /^✓ Answered in \\d+ ms$/.test(text)) ? statuses.join(' | ') : null;
            })()`, 5000);
            check('Apps: in Run, one click starts both tools, each answer goes where its wire goes, and each tool says it answered',
                !!ran && !!answered, `${ran}; ${answered}`);

            // A transform on the answer's wire says what of it shows: one value, picked from the last
            // answer, with words around it.
            const pill = `document.querySelector('app-canvas [data-pill="r:${countRule}:0"]')`;
            await page.run(`${pill}.click()`);
            await page.waitFor(`!!document.querySelector('app-inspector [data-route="0"].app-focus')`, 5000);
            await fromLibrary('[data-library-item="transform"][data-transform="value"]');
            const valuePill = await page.waitFor(`${pill}?.textContent === 'structured' ? 'structured' : null`, 5000);
            // Picked again, the wire's value has no cursor in it, so the value picked takes its place.
            await page.run(`${pill}.click()`);
            const pick = `document.querySelector('app-inspector [data-picks] [data-insert-show="{{structured.counted}}"]')`;
            await page.waitFor(`!!${pick} && !document.querySelector('app-inspector [data-route-show]:focus')`, 5000);
            await page.run(`${pick}.click()`);
            const pickedShow = await page.run(`document.querySelector('app-inspector [data-route="0"] [data-route-show]').value`);
            await page.run(`(() => {
                const show = document.querySelector('app-inspector [data-route="0"] [data-route-show]');
                show.value = 'Counted ' + show.value + ' steps';
                show.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await frameRun(`(document.getElementById('run').click(), true)`);
            const transformed = await frameWaitFor(`document.getElementById('output2')?.textContent === 'Counted 3 steps'`);
            check('Apps: a transform shows one value of the answer, picked from its last answer, with words around it',
                valuePill === 'structured' && pickedShow === '{{structured.counted}}' && !!transformed, `${valuePill}; ${pickedShow}; ${transformed ? 'shown' : 'not shown'}`);

            // Start begins the app: wired to a tool's Run, it calls the tool when the app opens.
            await page.run(`document.querySelector('app-canvas [data-canvas-mode="design"]').click()`);
            await drag('start', `run:${countRule}`);
            const started = await page.waitFor(`document.querySelector('app-canvas [data-wire="t:${countRule}:1"]') ? document.querySelector('app-inspector .app-inspector-title')?.textContent : null`, 5000);
            await frameRun(`(document.body.dataset.before = 'restart', true)`);
            await page.run(`document.querySelector('app-canvas [data-restart]').click()`);
            const opened = await frameWaitFor(`(() => {
                if (document.body.dataset.before) return null;
                const shown = ['output', 'output2'].map(id => document.getElementById(id)?.textContent || 'empty').join(' | ');
                return shown === 'empty | Counted 3 steps' ? shown : null;
            })()`);
            check('Apps: Start wired to a tool\'s Run calls it when the app opens, and Restart opens it again',
                started === 'Start → count' && opened === 'empty | Counted 3 steps', `${started}; ${opened}`);

            // A part of the screen a model makes: the model writes a ticket dashboard, which runs
            // without its script, handlers or form, its ids named after the part.
            await fromLibrary('[data-library-item="component"][data-type="part"]');
            await page.waitFor(`!!document.querySelector('app-inspector [data-part-source] [data-ask]')`, 5000);
            await page.run(`(() => {
                const ask = document.querySelector('app-inspector [data-ask]');
                ask.value = 'a ticket dashboard';
                ask.dispatchEvent(new Event('input', { bubbles: true }));
                document.querySelector('app-inspector [data-make]').click();
            })()`);
            const made = await page.waitFor(`(() => {
                const found = document.querySelector('app-inspector [data-found]')?.textContent || '';
                return /part\\.refresh/.test(found) ? found.replace(/\\s+/g, ' ') : null;
            })()`, 15000);
            const dashboard = await frameWaitFor(`(() => {
                const refresh = document.getElementById('part.refresh');
                if (!refresh) return null;
                const details = document.getElementById('part.details');
                return [details.textContent || 'empty', refresh.getAttribute('onclick') ?? 'no handler', document.querySelector('form') ? 'a form' : 'no form', getComputedStyle(details).backgroundColor].join(', ');
            })()`);
            check('Apps: a part of the screen can be HTML a model makes, styled by its own CSS, and its elements are the flow\'s to wire',
                /^7 elements with ids the flow can use: part\.open .*part\.search field, part\.refresh button, .*part\.details output$/.test(made || '') && dashboard === 'empty, no handler, no form, rgb(244, 244, 245)',
                `${made}; ${dashboard}`);
            await fromLibrary(`[data-library-item="tool"][data-server="${modernUrl}"][data-tool="ticket"]`);
            const ticketRule = await page.waitFor(`(() => {
                const nodes = document.querySelectorAll('app-canvas [data-node]');
                return nodes.length === 3 && ${port('el:part.refresh')} ? nodes[2].dataset.node : null;
            })()`, 5000);
            // From the label beside a port to the words on a tool's row, which wire like the ports do.
            await drag('app-canvas [data-gutter-row="part.refresh"] .app-gutter-label', `app-canvas [data-node="${ticketRule}"] .app-node-run .app-node-name`);
            const byLabel = await page.waitFor(`document.querySelector('app-canvas [data-wire="t:${ticketRule}:0"]') ? 'wired, ' + (getSelection().toString() ? 'with text selected' : 'nothing selected') : null`, 5000);
            await drag(`ok:${ticketRule}`, 'el:part.details');
            const ticketWired = await page.waitFor(`document.querySelector('app-canvas [data-wire="t:${ticketRule}:0"]') && document.querySelector('app-canvas [data-wire="r:${ticketRule}:0"]') ? document.querySelector('app-inspector .app-rule-sentence')?.textContent || null : null`, 5000);
            check('Apps: a wire also starts from the label beside a port and ends on the words of a tool\'s row, without selecting text',
                byLabel === 'wired, nothing selected', byLabel);
            await page.run(`document.querySelector('app-canvas [data-canvas-mode="run"]').click()`);
            await frameRun(`(document.getElementById('part.refresh').click(), true)`);
            const ticketShown = await frameWaitFor(`(() => {
                const text = document.getElementById('part.details')?.textContent || '';
                return /^T-\\d+$/.test(text) ? text : null;
            })()`);
            check('Apps: a part\'s button and output wire to a tool like any other, and the answer shows inside the part',
                ticketWired === 'When part.refresh is clicked, call ticket on modern server; if it works, put {{text}} into part.details.' && !!ticketShown,
                `${ticketWired}; ${ticketShown}`);

            // Tidy up puts every tool beside what it's wired to. The download keeps where each one sits,
            // Start, the part's HTML (in parts/) and what the model was asked.
            await page.run(`document.querySelector('app-canvas [data-tidy]').click()`);
            const appDownloads = mkdtempSync(join(tmpdir(), 'mcp-smoke-canvas-'));
            await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: appDownloads });
            await page.run(`document.getElementById('downloadAppBtn').click()`);
            let zipName;
            for (let i = 0; i < 50 && !zipName; i++) {
                zipName = readdirSync(appDownloads).find(name => name.endsWith('.zip'));
                if (!zipName) await sleep(100);
            }
            const zipped = zipName ? await unzip(readFileSync(join(appDownloads, zipName))) : new Map();
            const zippedText = name => (zipped.has(`new-app-2-v1/${name}`) ? new TextDecoder().decode(zipped.get(`new-app-2-v1/${name}`)) : '');
            let fromZip;
            try {
                fromZip = fromDml(zippedText('app.dml'), { files: { 'screen.html': zippedText('screen.html'), 'parts/part.html': zippedText('parts/part.html') } }).app;
            } catch (error) {
                fromZip = { error: error.message };
            }
            const part = fromZip.screen?.components?.find(component => component.type === 'part');
            const counting = fromZip.flow?.find(rule => rule.call?.toolName === 'count');
            check('Apps: the download keeps the part\'s HTML in parts/, what the model was asked, Start, and where each tool sits',
                zipName === 'new-app-2-v1.zip' && [...zipped.keys()].slice(0, 4).join(', ') === 'new-app-2-v1/app.dml, new-app-2-v1/screen.html, new-app-2-v1/parts/part.html, new-app-2-v1/README.md'
                    && part?.ask === 'a ticket dashboard' && part.from?.toolName === 'chat' && /id="refresh"/.test(part.html)
                    && /id="part\.refresh"/.test(zippedText('screen.html'))
                    && counting?.when?.map(candidate => candidate.event).join(', ') === 'click, open'
                    && fromZip.flow.length === 3 && fromZip.flow.every(rule => Number.isFinite(rule.position?.x) && Number.isFinite(rule.position?.y))
                    && zippedText('README.md').includes('- `parts/part.html`: the part `part`, made by a model asked for "a ticket dashboard".'),
                `${zipName}: ${[...zipped.keys()].slice(0, 4).join(', ')}${fromZip.error ? `; ${fromZip.error}` : ''}`);
            rmSync(appDownloads, { recursive: true, force: true });

            // A part with a grid of keys and long ids, as a model writes a calculator: the keys fill
            // their grid as its CSS says, the screen's own buttons' place in its layout staying out of
            // it, and beside the screen each name fits, or past the room there is, shows in full
            // when pointed at.
            await fromLibrary('[data-library-item="component"][data-type="part"]');
            await page.waitFor(`!!document.querySelector('app-inspector [data-part-source] [data-html]')`, 5000);
            await page.run(`(() => {
                const html = document.querySelector('app-inspector [data-html]');
                html.value = ${JSON.stringify('<style>.keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; } .keys button { padding: 10px 0; border-radius: 6px; }</style>\n<div class="keys"><button id="seven">7</button><button id="eight">8</button><button id="nine">9</button><button id="multiply-by">×</button></div>\n<output id="running-total-of-the-calculations">0</output>')};
                html.dispatchEvent(new Event('input', { bubbles: true }));
                html.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
            const keys = await frameWaitFor(`(() => {
                const grid = document.querySelector('[data-part="part2"] .keys');
                const widths = [...(grid?.children || [])].map(key => key.getBoundingClientRect().width);
                if (widths.length !== 4) return null;
                return Math.abs(widths.reduce((sum, width) => sum + width, 0) + 18 - grid.getBoundingClientRect().width) < 2 ? 'fill their grid' : widths.map(Math.round).join(', ') + ' px wide';
            })()`);
            const longName = `document.querySelector('app-canvas [data-gutter-row="part2.running-total-of-the-calculations"] .app-gutter-label')`;
            const names = await page.waitFor(`(() => {
                const labels = [...document.querySelectorAll('app-canvas .app-gutter-label')];
                if (!labels.some(label => label.textContent === '.multiply-by') || !${longName}) return null;
                const cut = labels.filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent);
                return cut.join(', ') + ' cut, in a gutter ' + document.querySelector('app-canvas [data-gutter]').offsetWidth + ' px wide';
            })()`, 10000);
            const pointAt = await page.run(`(() => {
                ${longName}.scrollIntoView({ block: 'center', inline: 'center' });
                const box = ${longName}.getBoundingClientRect();
                return [box.right - 4, box.top + box.height / 2];
            })()`);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointAt[0], y: pointAt[1] });
            const pointedAt = await page.waitFor(`${longName}.scrollWidth <= ${longName}.clientWidth + 1 ? 'in full' : null`, 3000);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
            check("Apps: a part's keys fill their grid, each name beside the screen fits, and one too long for the room there shows in full when pointed at",
                keys === 'fill their grid' && names === '.running-total-of-the-calculations cut, in a gutter 220 px wide' && pointedAt === 'in full',
                `${keys}; ${names}; ${pointedAt}`);

            // A dashboard: boxes that say what they show and what goes in them ask one tool for
            // their pieces of its answer, in its prompt. Project pulse, under Examples, calls the
            // model, the mock's chat, which answers the boxes with made-up JSON in their shapes.
            const latestPrompt = `${latestRun('chat', 'app')}.then(run => run?.sentArgs?.message || '')`;
            // It calls the model as it opens, so adding it asks whether to, each time it opens: yes.
            await page.run(`document.querySelector('apps-rail [data-example="dashboard"]').click()`);
            const runOnOpenOffered = await page.waitFor(`(() => {
                const check = document.querySelector('apps-add-dialog dialog[open] [data-run-on-open]');
                return check ? check.closest('label').textContent.trim() + ' | ' + (check.checked ? 'checked' : 'not checked') : null;
            })()`, 5000);
            await page.run(`document.querySelector('apps-add-dialog [data-add-copy]').click()`);
            const pulse = await frameWaitFor(`(() => {
                const box = id => document.getElementById(id);
                if (!box('docs')?.querySelector('a.item-title')) return null;
                return [box('summary').textContent.trim().slice(0, 9), box('health').querySelector('.kpi-value')?.textContent,
                    box('activity').querySelectorAll('.chart-fill').length, box('risks').querySelectorAll('li').length,
                    [...box('docs').querySelectorAll('a.item-title')].map(link => link.getAttribute('href')).join(' ')].join(' | ');
            })()`);
            check('Apps: a dashboard opens and fills each box from one answer, drawn as the box says: text, a number, a bar chart and lists',
                pulse === 'On track: | On track | 6 | 3 | https://example.com/docs/design https://example.com/docs/launch https://example.com/docs/weekly'
                    && runOnOpenOffered === 'Run what it calls as it opens (chat on modern server) each time you open it | checked', `${runOnOpenOffered}; ${pulse}`);
            const asked = await page.waitFor(`${latestPrompt}.then(prompt => prompt.includes('"docs" (list)') ? prompt : null)`, 5000);
            check('Apps: the boxes add to the prompt what each needs, from what it says goes in it, as one JSON object',
                /^What's the latest on MCP Browser Client\? Use what you find in our documents, messages and tickets\.\n\nThis answer fills the boxes on an app's screen\. Answer with one JSON object in a ```json block/.test(asked || '')
                    && (asked || '').includes('\n- "activity" (bar chart): Updates about the project per week, the last 6 weeks, oldest first, each labeled by the day its week starts. As {"labels": [string], "values": [number]}.\n')
                    && /\nUse null for a key you have nothing for\.$/.test(asked || ''),
                (asked || 'nothing sent').slice(0, 160));

            // Saying a box shows something else changes what the prompt asks for, and how it's drawn.
            const restart = async () => {
                await frameRun(`(document.body.dataset.before = 'restart', true)`);
                await page.run(`document.querySelector('app-canvas [data-restart]').click()`);
            };
            await page.waitFor(`!!document.querySelector('app-canvas [data-element-box="activity"]')`, 5000);
            await page.run(`document.querySelector('app-canvas [data-element-box="activity"]').click()`);
            await page.waitFor(`!!document.querySelector('app-inspector [data-inspect-prop="show"]')`, 5000);
            await page.run(`(() => {
                const show = document.querySelector('app-inspector [data-inspect-prop="show"]');
                show.value = 'line';
                show.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            const lineNote = await page.run(`document.querySelector('app-inspector [data-box-note]')?.textContent || ''`);
            await frameWaitFor(`!!document.querySelector('#activity.box-line')`);
            await restart();
            const line = await frameWaitFor(`!document.body.dataset.before && document.querySelector('#activity polyline') ? document.querySelector('#activity polyline').getAttribute('points').split(' ').length : null`);
            const lineAsked = await page.waitFor(`${latestPrompt}.then(prompt => prompt.includes('"activity" (line chart)') ? 'line chart' : null)`, 5000);
            check('Apps: a box that shows a line chart instead asks for one, and draws its six points as a line',
                line === 6 && lineAsked === 'line chart' && lineNote.includes('as a line chart'), `${line} points; ${lineAsked}; ${lineNote}`);

            // An HTML box from the Library, wired to the tool's Answer, asks for HTML to fit it.
            await fromLibrary('[data-library-item="box"][data-show="html"]');
            await page.waitFor(`!!${port('el:panel')}`, 10000);
            const pulseRule = await page.run(`document.querySelector('app-canvas [data-node]').dataset.node`);
            await drag(`ok:${pulseRule}`, 'el:panel');
            const panelWire = await page.waitFor(`document.querySelector('app-canvas [data-pill="r:${pulseRule}:6"]')?.textContent === 'panel' ? document.querySelector('app-canvas [data-canvas-hint]').textContent : null`, 5000);
            await frameWaitFor(`!!document.querySelector('#panel.box-html')`);
            await restart();
            const banner = await frameWaitFor(`!document.body.dataset.before && document.querySelector('#panel .banner') ? document.querySelector('#panel .banner').textContent : null`);
            const htmlAsked = await page.waitFor(`${latestPrompt}.then(prompt => (prompt.match(/^- "panel" \\(HTML\\): .*$/m) || [])[0] || null)`, 5000);
            check('Apps: an HTML box wired to the Answer asks for HTML to fit its width, and shows it',
                panelWire === 'Connected: panel asks chat for HTML, in message.' && banner === 'On track. The beta starts once the API review is done.'
                    && htmlAsked === '- "panel" (HTML): HTML. As a string of HTML for a box about 1030 px wide: no scripts, nothing from the network, inline styles only.',
                `${panelWire}; ${banner}; ${htmlAsked}`);

            // A link in a box opens in a tab of its own, through the page: the screen can't open one.
            await page.run(`document.querySelector('app-canvas [data-canvas-mode="run"]').click()`);
            await frameRun(`(document.querySelector('#docs a.item-title').click(), true)`);
            const linked = await page.waitFor(`[...document.querySelectorAll('app-canvas .app-trace-text')].map(line => line.textContent.trim()).find(line => line.startsWith('Opened')) || null`, 5000);
            check('Apps: a link in a box opens in a new tab', linked === 'Opened https://example.com/docs/design', linked);

            // Asking nowhere sends the question alone, and boxes say the answer had nothing for them.
            await page.run(`document.querySelector('app-canvas [data-canvas-mode="design"]').click()`);
            await page.run(`document.querySelector('app-canvas [data-node="${pulseRule}"] [data-node-status]').click()`);
            await page.waitFor(`!!document.querySelector('app-inspector [data-prompt-row]:not([hidden]) [data-prompt-field]')`, 5000);
            await page.run(`(() => {
                const field = document.querySelector('app-inspector [data-prompt-field]');
                field.value = '';
                field.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
            await restart();
            const notJson = await frameWaitFor(`!document.body.dataset.before && document.getElementById('summary')?.dataset.state === 'error' ? document.getElementById('summary').textContent : null`);
            check('Apps: without the boxes\' request, the answer isn\'t JSON, and the boxes say so',
                notJson === "The answer wasn't JSON, so it has nothing for this.", notJson);

            // Opening an app that calls a tool as it opens asks, when nobody has said, whether to run
            // it each time; nothing runs until then, and the answer is kept. Start's Inspector shows
            // it and changes it. The link opened above is a tab in front of this one.
            await page.send('Page.bringToFront');
            const pulseId = await page.run(`localStorage.getItem('appsShown')`);
            const choiceOf = `(JSON.parse(localStorage.getItem('appsRunOnOpen') || '{}')[${JSON.stringify(pulseId)}] || 'none')`;
            const startChoices = `[...document.querySelectorAll('app-inspector [data-run-on-open-choice]')].map(chip => chip.textContent + (chip.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(', ')`;
            const chooseOnStart = async choice => {
                await page.run(`document.querySelector('app-canvas [data-start]').click()`);
                const shown = await page.waitFor(`document.querySelector('app-inspector [data-run-on-open-choice]') ? ${startChoices} : null`, 5000);
                await page.run(`document.querySelector('app-inspector [data-run-on-open-choice="${choice}"]').click()`);
                return shown;
            };
            const reopen = async () => {
                await page.run(`[...document.querySelectorAll('apps-rail [data-show-app]')].find(row => row.querySelector('.wb-row-label').textContent === 'Chat').click()`);
                await page.waitFor(`document.getElementById('appName')?.value === 'Chat'`, 5000);
                await page.run(`document.querySelector('apps-rail [data-show-app="${pulseId}"]').click()`);
                await page.waitFor(`document.getElementById('appName')?.value === 'Project pulse'`, 5000);
            };
            const canvasTrace = `[...document.querySelectorAll('app-canvas .app-trace-text')].map(line => line.textContent.trim()).join(' | ')`;
            const pulseRuns = runCount('chat', 'app');
            const choiceAdded = await page.run(choiceOf);
            const startShown = await chooseOnStart('');
            const startAsks = await page.waitFor(`${startChoices}.includes('Ask*') ? ${startChoices} + ' | ' + ${choiceOf} : null`, 5000);
            const runsBefore = await page.run(pulseRuns);
            await reopen();
            const asking = await page.waitFor(`(() => { const ask = document.querySelector('app-open-ask'); return ask && !ask.hidden ? ask.innerText.replace(/\\s+/g, ' ').trim() : null; })()`, 5000);
            await sleep(1500);
            const runsWhileAsking = await page.run(pulseRuns);
            const heldNote = await page.run(canvasTrace);
            await page.run(`document.querySelector('app-open-ask [data-answer-run-on-open="no"]').click()`);
            const saidNo = await page.waitFor(`document.querySelector('app-open-ask').hidden ? ${choiceOf} : null`, 5000);
            await reopen();
            await sleep(1500);
            const quietly = await page.run(`(document.querySelector('app-open-ask').hidden ? 'no question' : 'asked') + ' | ' + ${canvasTrace}`);
            const runsAfterNo = await page.run(pulseRuns);
            check("Apps: an app that calls a tool as it opens asks whether to run it each time, and runs nothing until you answer; Don't run it is kept, and it opens without calling it",
                choiceAdded === 'yes' && startShown === "Ask, Run it*, Don't run it" && startAsks === "Ask*, Run it, Don't run it | none"
                    && asking === "Project pulse calls chat on modern server as it opens. Run that each time you open it? The answer is kept for this app; Start, on the canvas, changes it. Run it each time Don't run it"
                    && runsWhileAsking === runsBefore && heldNote === "What Start calls (chat on modern server) hasn't run: say above whether to run it when you open this app."
                    && saidNo === 'no' && quietly === "no question | What Start calls (chat on modern server) didn't run as the app opened, as you chose for this app. Restart runs it."
                    && runsAfterNo === runsBefore,
                `${choiceAdded}; ${startShown}; ${startAsks}; ${asking}; ${runsBefore} → ${runsWhileAsking} → ${runsAfterNo} runs; ${heldNote}; ${saidNo}; ${quietly}`);
            const startSaysNo = await chooseOnStart('');
            await reopen();
            await page.waitFor(`!document.querySelector('app-open-ask').hidden`, 5000);
            await page.run(`document.querySelector('app-open-ask [data-answer-run-on-open="yes"]').click()`);
            const ranNow = await page.waitFor(`${pulseRuns}.then(count => count > ${runsBefore} ? count - ${runsBefore} + ' run' : null)`, 10000);
            const ranNote = await page.waitFor(`(() => { const trace = ${canvasTrace}; return trace.includes('chat answered') ? trace.split(' | ').slice(1, 3).join(' | ') : null; })()`, 10000);
            const saidYes = await page.run(`(document.querySelector('app-open-ask').hidden ? 'no question' : 'asked') + ', ' + ${choiceOf}`);
            check('Apps: Run it each time runs what Start calls now, and keeps the answer; Start\'s Inspector showed the one before',
                startSaysNo === "Ask, Run it, Don't run it*" && ranNow === '1 run' && ranNote === 'Ran what Start calls, as it will each time you open Project pulse. | The app opened' && saidYes === 'no question, yes',
                `${startSaysNo}; ${ranNow}; ${ranNote}; ${saidYes}`);

            // Launch: the app on its own in a new tab, which runs what Start calls as it starts, as
            // Preview does, though opening it in the builder wouldn't now.
            await chooseOnStart('no');
            const runsBeforeLaunch = await page.run(pulseRuns);
            await page.send('Runtime.evaluate', { expression: `document.getElementById('launchAppBtn').click()`, userGesture: true });
            const launchedTab = await openPage(target => target.url === `${HOST}:${PORTS.app}/?app=${pulseId}`);
            const launchedApp = await launchedTab.waitFor(`(() => {
                const preview = document.querySelector('app-preview');
                const frame = preview?.querySelector('iframe');
                if (!preview || preview.hidden || !frame || !/answered/.test(preview.querySelector('[data-preview-status]').textContent)) return null;
                const box = frame.getBoundingClientRect();
                const whole = Math.abs(box.width - document.documentElement.clientWidth) <= 1 && Math.abs(box.bottom - window.innerHeight) <= 1;
                const builder = ['.wb-topbar', 'apps-rail', 'app-header', 'wb-dock'].filter(selector => getComputedStyle(document.querySelector(selector)).display !== 'none');
                return [document.title, whole ? 'the whole window' : 'not the whole window', builder.length ? builder.join(' ') + ' showing' : 'nothing of the builder',
                    preview.querySelector('[data-launch-actions]').textContent.trim(), preview.querySelector('[data-launch-notes]').hidden ? 'no notes' : 'notes'].join(' | ');
            })()`, 15000);
            await launchedTab.run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            await sleep(300);
            const stillLaunched = await launchedTab.run(`document.querySelector('app-preview').hidden ? 'gone' : 'still there'`);
            const runsLaunched = await page.run(pulseRuns);
            await closeTab(launchedTab);
            await page.send('Page.bringToFront');
            check("Apps: Launch opens the app on its own in a new tab, the whole window with nothing of the builder, running what Start calls as it starts; Escape keeps it",
                launchedApp === 'Project pulse | the whole window | nothing of the builder | Open in the builder | no notes' && stillLaunched === 'still there' && runsLaunched === runsBeforeLaunch + 1,
                `${launchedApp}; ${stillLaunched}; ${runsBeforeLaunch} → ${runsLaunched} runs`);

            // A link that runs it carries the app itself: in a browser with nothing of it, the app
            // runs from the link, offers to add the server it calls, asks before calling what Start
            // calls, and joins that browser's apps once added.
            await page.run(`navigator.clipboard.writeText = text => { window.copiedLink = text; return Promise.resolve(); }`);
            await page.run(`(() => { document.querySelector('app-header .app-more-menu').open = true; document.getElementById('copyAppLinkBtn').click(); })()`);
            const copiedLink = await page.waitFor(`window.copiedLink || null`, 5000);
            const copiedSaid = await page.waitFor(`document.getElementById('wbStatus')?.textContent.startsWith('Copied a link') ? document.getElementById('wbStatus').textContent : null`, 5000);
            const elsewhere = await otherBrowser();
            const linkedApp = await elsewhere.open(copiedLink || 'about:blank');
            const linkNotes = `document.querySelector('app-preview [data-launch-notes]')?.innerText.replace(/\\s+/g, ' ').trim()`;
            const linkFirst = await linkedApp.waitFor(`(() => {
                const preview = document.querySelector('app-preview');
                if (!preview || preview.hidden || !preview.querySelector('[data-answer-run-on-open]')) return null;
                return [document.title, preview.querySelector('[data-launch-actions]').textContent.trim(), ${linkNotes}].join(' | ');
            })()`, 20000);
            const linkRuns = runCount('chat', 'app');
            await sleep(500);
            const linkRunsFirst = await linkedApp.run(linkRuns);
            await linkedApp.run(`document.querySelector('app-preview [data-add-server-for-app]').click()`);
            const serverAdded = await linkedApp.waitFor(`appShell.servers[${JSON.stringify(modernUrl)}]?.status === 'connected' && appShell.servers[${JSON.stringify(modernUrl)}].tools?.length ? appShell.servers[${JSON.stringify(modernUrl)}].alias + ' | ' + ${linkNotes} : null`, 15000);
            await linkedApp.run(`document.querySelector('app-preview [data-answer-run-on-open="yes"]').click()`);
            const linkRan = await linkedApp.waitFor(`(() => { const status = document.querySelector('app-preview [data-preview-status]').textContent; return /answered/.test(status) ? status.replace(/\\d+ ms/, 'N ms') : null; })()`, 15000);
            const linkRunsAfter = await linkedApp.run(linkRuns);
            await linkedApp.run(`document.querySelector('app-preview [data-keep-app]').click()`);
            const linkKept = await linkedApp.waitFor(`(() => {
                const actions = document.querySelector('app-preview [data-launch-actions]').textContent.trim();
                if (actions !== 'Open in the builder') return null;
                return new Promise(resolve => {
                    const open = indexedDB.open('mcp_apps');
                    open.onsuccess = () => {
                        const all = open.result.transaction('apps').objectStore('apps').getAll();
                        all.onsuccess = () => resolve(actions + ' | ' + all.result.map(app => app.id === ${JSON.stringify(pulseId)} ? app.name : 'another').join(', '));
                    };
                });
            })()`, 5000);
            await elsewhere.close();
            check('Apps: a link that runs the app carries it: in a browser with nothing of it, it offers to add the server it calls, asks before calling what Start calls, runs, and joins that browser\'s apps once added',
                (copiedLink || '').startsWith(`${HOST}:${PORTS.app}/${RUN_HASH}`) && copiedSaid === 'Copied a link that runs Project pulse as it is now. Whoever opens it runs it in their browser, on their own servers, and can add it to their apps.'
                    && linkFirst === `Project pulse | Add to Your apps | This app came in a link. It calls your servers, signed in as you, and each call is in History. It calls modern server (${modernUrl}), which isn't one of your servers. Add it Project pulse calls chat on modern server as it opens. Run that each time you open it? The answer is kept for this app, in this browser. Run it each time Don't run it`
                    && linkRunsFirst === 0 && serverAdded === "modern server | This app came in a link. It calls your servers, signed in as you, and each call is in History. Project pulse calls chat on modern server as it opens. Run that each time you open it? The answer is kept for this app, in this browser. Run it each time Don't run it"
                    && linkRan === 'chat answered in N ms' && linkRunsAfter === 1 && linkKept === 'Open in the builder | Project pulse',
                `${(copiedLink || 'nothing copied').slice(0, 40)}…; ${copiedSaid}; ${linkFirst}; ${linkRunsFirst} runs; ${serverAdded}; ${linkRan}; ${linkRunsAfter} runs; ${linkKept}`);

            // Front desk, under Examples: a visitor kiosk over four screens, which the canvas lays out
            // as a storyboard, a card for each screen in the order people go through them and an
            // arrow for each way from one to the next. The app runs on the card of the screen it's
            // on; the other cards show theirs as they are before anyone uses them. The link opened
            // above is a tab in front of this one, where the canvas couldn't draw its wires.
            await page.send('Page.bringToFront');
            await page.run(`document.querySelector('apps-rail [data-example="frontdesk"]').click()`);
            await page.waitFor(`!!document.querySelector('apps-add-dialog dialog[open] [data-add-copy]')`, 5000);
            await page.run(`document.querySelector('apps-add-dialog [data-add-copy]').click()`);
            const cardsAt = `Object.fromEntries([...document.querySelectorAll('app-canvas [data-card]')].map(card => [card.dataset.card, { x: parseFloat(card.style.getPropertyValue('--x')), y: parseFloat(card.style.getPropertyValue('--y')) }]))`;
            const player = `document.querySelector('app-canvas [data-player]')`;
            const deskCanvas = `(() => {
                const at = ${cardsAt};
                if (Object.keys(at).join(' ') !== 'welcome confirm done notfound') return Object.keys(at).join(' ');
                const order = at.welcome.x < at.confirm.x && at.confirm.x === at.notfound.x && at.confirm.y < at.notfound.y && at.notfound.x < at.done.x ? 'in the order people go through them' : JSON.stringify(at);
                const gutters = [...document.querySelectorAll('app-canvas [data-gutter]')].map(gutter => gutter.dataset.gutter + ': ' + [...gutter.querySelectorAll('[data-gutter-row]')].map(row => row.dataset.gutterRow).join(' ')).join(' | ');
                const ways = document.querySelectorAll('app-canvas .app-wire-transition').length + ' ways between screens';
                return [order, gutters, ways, 'the app on ' + ${player}.dataset.on, document.querySelectorAll('app-canvas [data-still]').length + ' stills'].join(' / ');
            })()`;
            const deskOpened = 'in the order people go through them / welcome: title intro visitor host find | confirm: visit yes notme | done: badge next | notfound: missing retry desk / 4 ways between screens / the app on welcome / 4 stills';
            const deskShown = await page.waitFor(`document.getElementById('appName')?.value === 'Front desk' && ${deskCanvas} === ${JSON.stringify(deskOpened)} ? 'shown' : null`, 10000)
                && await page.run(deskCanvas);
            const firstScreen = await frameWaitFor(`(() => {
                const screens = [...document.querySelectorAll('[data-screen]')];
                return screens.length === 4 ? screens.map(screen => screen.id + (screen.hidden ? '' : '*')).join(' ') : null;
            })()`);
            check("Apps: Front desk, under Examples, has four screens, each a card on the canvas in the order people go through them, with an arrow for each way between them, and runs on the first",
                deskShown === deskOpened && firstScreen === 'welcome* confirm done notfound', `${deskShown || await page.run(deskCanvas)}; ${firstScreen}`);
            const deskLooks = await page.run(`[
                [...document.querySelectorAll('app-canvas [data-card-bar]')].map(bar => bar.querySelector('.app-screen-name').textContent + (bar.querySelector('.icon-monitor') ? '' : ' (no monitor)') + ' ' + (bar.querySelector('.app-screen-opens, .app-screen-kind')?.textContent || '')).join(', '),
                ...[...document.querySelectorAll('app-canvas [data-node]')].map(node => node.querySelector('.app-node-title').textContent + ': ' + [...node.querySelectorAll('[data-out]')].map(row => [...row.querySelector('.app-node-where').childNodes]
                    .map(part => (part.nodeType === Node.ELEMENT_NODE && part.matches('.app-node-screen') && part.querySelector('.icon-monitor') ? '▭' : '') + part.textContent).join('')).join(' / ')),
            ].join(' | ')`);
            check("Apps: each of Front desk's cards says it's a screen (the first that it opens there), and each tool's outputs say where they go, a screen by its name with a screen's icon",
                deskLooks === 'Welcome Opens here, Confirm Screen, Checked in Screen, Not found Screen | find_visit: — / → visit, ▭Confirm / → missing, ▭Not found | check_in: — / → badge, ▭Checked in / → visit | call_front_desk: — / → missing / → missing',
                deskLooks);

            // Picking a card picks its screen and shows the app there; a button that goes to a
            // screen has an arrow into its card.
            await page.run(`document.querySelector('app-canvas [data-card-bar="confirm"]').click()`);
            const confirmShown = await frameWaitFor(`!document.getElementById('confirm').hidden && document.getElementById('welcome').hidden ? 'confirm' : null`);
            const confirmPicked = await page.waitFor(`(() => {
                const title = document.querySelector('app-inspector .app-inspector-title')?.textContent;
                const ways = [...document.querySelectorAll('app-inspector .app-connections')].at(-1)?.textContent.replace(/\\s+/g, ' ').trim();
                return ${player}.dataset.on === 'confirm' && document.querySelector('app-canvas [data-go-wire="notme"]') && title === 'confirm' ? ['the app on confirm', ways].join(' / ') : null;
            })()`, 5000);
            check("Apps: picking a screen's card picks it and shows the app there, the Inspector says how people get there, and a button that goes to a screen has an arrow into its card",
                confirmShown === 'confirm' && confirmPicked === 'the app on confirm / ← When find_visit works', `${confirmShown}; ${confirmPicked}`);

            // Dragging a button to a screen's ● makes it go there; its menu in the Inspector changes it.
            await page.waitFor(`!!${port('el:next')}`, 5000);
            await drag('el:next', 'el:confirm');
            const goneTo = await page.waitFor(`document.querySelector('app-canvas [data-go-wire="next"]') ? document.querySelector('app-canvas [data-canvas-hint]').textContent : null`, 5000);
            await page.run(`(() => {
                const go = document.querySelector('app-inspector [data-inspect-prop="go"]');
                go.value = 'start';
                go.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            const startsOver = await page.waitFor(`!document.querySelector('app-canvas [data-go-wire="next"]') && document.querySelector('app-canvas [data-gutter-row="next"] .app-gutter-label')?.textContent === 'next ⟲' ? 'next ⟲' : null`, 5000);
            check("Apps: dragging a button to a screen's ● makes it go there, and its When clicked, goes to menu puts it back",
                goneTo === "Connected: next goes to Confirm (confirm) when it's clicked." && startsOver === 'next ⟲', `${goneTo}; ${startsOver}`);

            // The Library adds a screen as a card right of the others, and shows the app there;
            // what's added then goes on it.
            await fromLibrary('[data-library-item="component"][data-type="screen"]');
            const screenAdded = await page.waitFor(`(() => {
                const at = ${cardsAt};
                const others = Object.entries(at).filter(([id]) => id !== 'screen5');
                return at.screen5 && others.length === 4 && others.every(([, card]) => card.x < at.screen5.x) && ${player}.dataset.on === 'screen5'
                    ? 'screen5, right of the others: ' + document.querySelector('app-canvas [data-canvas-hint]').textContent : null;
            })()`, 5000);
            const emptyScreen = await frameWaitFor(`document.getElementById('screen5') && !document.getElementById('screen5').hidden ? document.getElementById('screen5').children.length + ' on it' : null`);
            await fromLibrary('[data-library-item="component"][data-type="button"]');
            const onIt = await frameWaitFor(`document.querySelector('#screen5 > button')?.id || null`);
            await page.run(`document.querySelector('app-canvas [data-card-bar="screen5"]').click()`);
            await page.waitFor(`document.querySelector('app-inspector .app-inspector-title')?.textContent === 'screen5'`, 5000);
            const screenContents = await page.run(`document.querySelector('app-inspector .app-connections')?.textContent.replace(/\\s+/g, ' ').trim()`);
            const remove = `document.querySelector('app-inspector [data-remove-component]')`;
            await page.run(`${remove}.click()`);
            const confirming = await page.run(`${remove}.textContent`);
            await page.run(`${remove}.click()`);
            const screensLeft = await page.waitFor(`!document.querySelector('app-canvas [data-gutter-row="button"]') && Object.keys(${cardsAt}).length === 4 ? Object.keys(${cardsAt}).join(' ') : null`, 5000);
            check('Apps: the Library adds a screen as a card right of the others and shows the app there, a component added then goes on it, and deleting the screen, on a second click, takes that along',
                screenAdded === "screen5, right of the others: Added screen5. Add components to it from the Library, and wire a button or a tool's Answer to its ● to go there."
                    && emptyScreen === '0 on it' && onIt === 'button' && screenContents === 'Button button: Button' && confirming === 'Click again to confirm' && screensLeft === 'welcome confirm done notfound',
                `${screenAdded}; ${emptyScreen}; ${onIt}; ${screenContents}; ${confirming}; ${screensLeft}`);

            // A card moves by its title and stays where it's put, with the others where they were;
            // Tidy up puts the screens back in order. The zoom and the scroll stay for the app too.
            const storedCards = `new Promise((resolve, reject) => {
                const open = indexedDB.open('mcp_apps');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const all = open.result.transaction('apps').objectStore('apps').getAll();
                    all.onsuccess = () => {
                        const desk = all.result.find(app => app.id === localStorage.getItem('appsShown'));
                        resolve(desk ? JSON.stringify(Object.fromEntries(desk.screen.components.filter(component => component.type === 'screen').map(screen => [screen.id, screen.position || null]))) : null);
                    };
                };
            })`;
            const shownBefore = JSON.parse(await page.run(`JSON.stringify(${cardsAt})`));
            const zoom = await page.run(`parseFloat(document.querySelector('app-canvas [data-zoom-reset]').textContent) / 100`);
            const bar = JSON.parse(await page.run(`(() => {
                const bar = document.querySelector('app-canvas [data-card-bar="confirm"]');
                bar.scrollIntoView({ block: 'center', inline: 'center' });
                const box = bar.getBoundingClientRect();
                return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
            })()`));
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bar.x, y: bar.y });
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bar.x, y: bar.y, button: 'left', buttons: 1, clickCount: 1 });
            for (let step = 1; step <= 6; step++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bar.x + 10 * step, y: bar.y + 15 * step, button: 'left', buttons: 1 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bar.x + 60, y: bar.y + 90, button: 'left', buttons: 0, clickCount: 1 });
            const kept = await page.waitFor(`${storedCards}.then(text => {
                const kept = JSON.parse(text || '{}');
                return kept.confirm && kept.welcome ? text : null;
            })`, 5000);
            const keptCards = JSON.parse(kept || '{}');
            const movedRight = keptCards.confirm && Math.abs(keptCards.confirm.x - shownBefore.confirm.x - 60 / zoom) <= 2 && Math.abs(keptCards.confirm.y - shownBefore.confirm.y - 90 / zoom) <= 2;
            const othersStayed = ['welcome', 'done', 'notfound'].every(id => keptCards[id]?.x === shownBefore[id].x && keptCards[id]?.y === shownBefore[id].y);
            await page.run(`document.querySelector('app-canvas [data-tidy]').click()`);
            const tidied = await page.waitFor(`${storedCards}.then(text => {
                const kept = JSON.parse(text || '{}');
                return kept.confirm && kept.confirm.x === kept.notfound.x && kept.confirm.y < kept.notfound.y && kept.welcome.x < kept.confirm.x ? 'back in order' : null;
            })`, 5000);
            await page.run(`document.querySelector('app-canvas [data-zoom-step="-1"]').click()`);
            const zoomKept = await page.waitFor(`(() => {
                const shown = document.querySelector('app-canvas [data-zoom-reset]').textContent;
                const view = JSON.parse(localStorage.getItem('appsCanvasViews') || '{}')[localStorage.getItem('appsShown')];
                return view && Math.round(view.zoom * 100) + '%' === shown && parseFloat(shown) / 100 < ${zoom} ? 'zoomed out to ' + shown + ', and kept' : null;
            })()`, 5000);
            check('Apps: a card moves by its title and stays where it\'s put with the others where they were, Tidy up puts the screens back in order, and the zoom stays for the app',
                movedRight && othersStayed && tidied === 'back in order' && !!zoomKept, `${kept}; ${tidied}; ${zoomKept}`);

            // In Run, a click on a card the app isn't on takes it there, and the app moves to the card
            // of the screen it goes to.
            await page.run(`document.querySelector('app-canvas [data-card-bar="done"]').click()`);
            await page.waitFor(`${player}.dataset.on === 'done'`, 5000);
            await page.run(`document.querySelector('app-canvas [data-canvas-mode="run"]').click()`);
            // Picking a card may scroll the canvas to it, smoothly: the click waits for that to end.
            const scrolled = `(() => { const scroller = document.querySelector('app-canvas [data-canvas-scroll]'); return scroller.scrollLeft + ',' + scroller.scrollTop; })()`;
            for (let last = null, tries = 0; tries < 20; tries++) {
                await sleep(150);
                const now = await page.run(scrolled);
                if (now === last) break;
                last = now;
            }
            const welcomeBody = JSON.parse(await page.run(`(() => {
                const body = document.querySelector('app-canvas [data-card="welcome"] .app-screen-body');
                body.scrollIntoView({ block: 'center', inline: 'center' });
                const box = body.getBoundingClientRect();
                return JSON.stringify({ x: box.left + box.width / 2, y: box.top + Math.min(40, box.height / 2) });
            })()`));
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
                await page.send('Input.dispatchMouseEvent', { type, x: welcomeBody.x, y: welcomeBody.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
            }
            const broughtBack = await page.waitFor(`${player}.dataset.on === 'welcome' ? 'the app on welcome' : null`, 5000);
            await frameWaitFor(`!document.getElementById('welcome').hidden && !document.getElementById('find').disabled`);
            await frameRun(`(() => {
                document.getElementById('visitor').value = 'ada';
                document.getElementById('find').click();
                return true;
            })()`);
            const followed = await page.waitFor(`${player}.dataset.on === 'confirm' && document.querySelector('app-canvas [data-card="confirm"]').hasAttribute('data-live') ? 'the app on confirm' : null`, 10000);
            const visitShown = await frameWaitFor(`!document.getElementById('confirm').hidden ? document.getElementById('visit').textContent.split('\\n')[0] : null`);
            await page.run(`document.querySelector('app-canvas [data-canvas-mode="design"]').click()`);
            check('Apps: in Run, a click on another screen\'s card takes the app there, and when the app goes to another screen, it moves to that screen\'s card',
                broughtBack === 'the app on welcome' && followed === 'the app on confirm' && visitShown === 'Ada Lovelace, Analytical Engines', `${broughtBack}; ${followed}; ${visitShown}`);

            // The Outline lists each screen with what's on it set in under it.
            await page.run(`document.querySelector('app-header [data-app-view-choice="outline"]').click()`);
            const outlined = await page.waitFor(`(() => {
                const rows = [...document.querySelectorAll('app-screen .app-component')];
                const goes = document.querySelector('app-screen [data-component="notme"] [data-prop="go"]');
                if (!rows.length || !goes) return null;
                return [rows.filter(row => row.classList.contains('app-component-screen')).map(row => row.dataset.component).join(' '),
                    rows.filter(row => row.classList.contains('app-component-on-screen')).length + ' set in', goes.selectedOptions[0]?.textContent].join(' / ');
            })()`, 5000);
            await page.run(`document.querySelector('app-header [data-app-view-choice="canvas"]').click()`);
            check("Apps: the Outline lists each screen with what's on it set in under it, and a button's menu of where it goes",
                outlined === 'welcome confirm done notfound / 12 set in / The “Welcome” screen', outlined);

            // In Preview, at a tablet's width, as a visitor uses it.
            await page.run(`document.getElementById('previewAppBtn').click()`);
            await page.waitFor(`!document.querySelector('app-preview').hidden && !!document.querySelector('app-preview iframe')`, 5000);
            await page.run(`document.querySelector('app-preview [data-device="tablet"]').click()`);
            const showing = `[...document.querySelectorAll('[data-screen]')].find(screen => !screen.hidden)?.id`;
            const barScreen = `document.querySelector('app-preview [data-preview-screen]')?.textContent`;
            const tap = id => frameRun(`(document.getElementById(${JSON.stringify(id)}).click(), true)`);
            const findVisit = async name => {
                await frameWaitFor(`document.readyState === 'complete' && ${showing} === 'welcome' && !document.getElementById('find').disabled`);
                await frameRun(`(() => {
                    document.getElementById('visitor').value = ${JSON.stringify(name)};
                    document.getElementById('find').click();
                    return true;
                })()`);
            };
            await findVisit('ada');
            const visit = await frameWaitFor(`${showing} === 'confirm' ? document.getElementById('visit').textContent : null`);
            const onConfirm = await page.waitFor(`${barScreen} === 'Confirm' ? 'Confirm' : null`, 5000);
            await tap('yes');
            const badge = await frameWaitFor(`${showing} === 'done' ? document.getElementById('badge').textContent : null`);
            const onDone = await page.waitFor(`${barScreen} === 'Checked in' ? 'Checked in' : null`, 5000);
            const checkedIn = await page.waitFor(`${latestRun('check_in', 'app')}.then(run => run?.sentArgs?.visitor || null)`, 5000);
            await frameRun(`(document.body.dataset.before = 'start over', true)`);
            await tap('next');
            const over = await frameWaitFor(`!document.body.dataset.before && ${showing} === 'welcome' ? 'Welcome, name ' + (document.getElementById('visitor').value || 'empty') : null`);
            check('Apps: in Preview, Front desk finds the visit and goes to Confirm with it, Yes checks you in and goes to Checked in, and Done starts over',
                visit === 'Ada Lovelace, Analytical Engines\nHere to see Grace Hopper at 10:00, in Babbage, 3rd floor' && onConfirm === 'Confirm'
                    && /^Welcome, Ada\. Your badge is V-\d+\. Grace Hopper knows you're here and will meet you in the lobby, then take you to Babbage, 3rd floor\.$/.test(badge || '')
                    && onDone === 'Checked in' && checkedIn === 'ada' && over === 'Welcome, name empty',
                `${JSON.stringify(visit)}; ${onConfirm}; ${badge}; ${onDone}; ${checkedIn}; ${over}`);
            await findVisit('Bob');
            const notFound = await frameWaitFor(`${showing} === 'notfound' ? document.getElementById('missing').textContent : null`);
            await tap('desk');
            const helped = await frameWaitFor(`/on the way/.test(document.getElementById('missing').textContent) ? document.getElementById('missing').textContent : null`);
            await tap('retry');
            const retried = await frameWaitFor(`${showing} === 'welcome' ? 'Welcome, name ' + document.getElementById('visitor').value : null`);
            await findVisit('Ada');
            await frameWaitFor(`${showing} === 'confirm'`);
            await tap('notme');
            const notMe = await frameWaitFor(`${showing} === 'welcome' ? 'Welcome' : null`);
            check("Apps: a visit it can't find goes to Not found with why, where the front desk can be called; Try again goes back with the name still typed, and Not me goes to Welcome",
                notFound === "There's no visit today for “Bob”. Check the spelling, or call the front desk and someone will come and help."
                    && helped === 'Someone from the front desk is on the way, Bob. Please take a seat.' && retried === 'Welcome, name Bob' && notMe === 'Welcome',
                `${notFound}; ${helped}; ${retried}; ${notMe}`);
            await page.run(`document.querySelector('app-preview [data-device="desktop"]').click()`);
            await page.run(`document.querySelector('app-preview [data-exit-preview]').click()`);
            await page.waitFor(`document.querySelector('app-preview').hidden`, 5000);

            // Share: an embed of the app is an iframe of the client at its address, in its embed
            // mode. The address is this page's unless set, which the dialog checks answers.
            await page.run(`document.getElementById('shareAppBtn').click()`);
            const shareShown = await page.waitFor(`(() => {
                const dialog = document.querySelector('apps-share-dialog dialog');
                const note = dialog?.querySelector('[data-address-note]')?.textContent || '';
                const code = dialog?.querySelector('[data-embed-code]')?.value || '';
                return dialog?.open && code && !note.startsWith('Checking')
                    ? [dialog.querySelector('h2').textContent, code.replace(/#run=[\\w-]+/, '#run=…'), dialog.querySelector('[data-client-address]').value, note].join(' | ') : null;
            })()`, 10000);
            check("Apps: Share offers the app's embed code, an iframe of the client at its address in its embed mode; the address is this page's, which answers, and is on this computer",
                shareShown === `Share Front desk | <iframe src="${HOST}:${PORTS.app}/?embed#run=…" title="Front desk" width="100%" height="640" style="border: 0"></iframe> | ${HOST}:${PORTS.app}/ | MCP Browser Client answers there. That address is on this computer, so what you share runs only here; to share it, use one others reach, such as the public client.`,
                shareShown);

            // embed.html, opened as a file, runs the app in the client in an iframe: in its embed
            // mode, with storage of its own (none of the builder's servers), and a way to open it
            // on its own.
            const embedDownloads = mkdtempSync(join(tmpdir(), 'mcp-smoke-embed-'));
            await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: embedDownloads });
            await page.run(`document.querySelector('apps-share-dialog [data-download-embed]').click()`);
            let embedFile;
            for (let i = 0; i < 50 && !embedFile; i++) {
                embedFile = readdirSync(embedDownloads).find(name => name.endsWith('.html'));
                if (!embedFile) await sleep(100);
            }
            await page.send('Target.createTarget', { url: `file://${join(embedDownloads, embedFile || 'missing.html')}` });
            const embedded = await openPage(target => target.url.startsWith(`${HOST}:${PORTS.app}/?embed${RUN_HASH}`), { type: 'iframe' });
            const embedShown = await embedded.waitFor(`(() => {
                const preview = document.querySelector('app-preview');
                if (!document.body.classList.contains('embedded') || !preview?.querySelector('iframe') || !Object.keys(appShell.servers).length) return null;
                const own = preview.querySelector('[data-launch-actions] a');
                if (!own) return null;
                return [document.title, own.textContent.trim(), own.getAttribute('href').replace(/#run=[\\w-]+/, '#run=…'), own.target, Object.keys(appShell.servers).join(' ')].join(' | ');
            })()`, 20000);
            await frameWaitFor(`document.readyState === 'complete' && !!document.getElementById('visitor')`, 10000, { inPage: embedded });
            await frameRun(`(() => {
                document.getElementById('visitor').value = 'ada';
                document.getElementById('find').click();
                return true;
            })()`, { inPage: embedded });
            const embedFound = await frameWaitFor(`(() => { const visit = document.getElementById('visit'); return visit?.offsetParent ? visit.textContent.split('\\n')[0] : null; })()`, 10000, { inPage: embedded });
            embedded.close();
            await closeTab(await openPage(target => target.url.startsWith('file://')));
            await page.send('Page.bringToFront');
            check("Apps: embed.html, opened as a file, runs the app in the client in its embed mode, with storage of its own and a link to open it on its own",
                embedFile === 'front-desk-embed.html'
                    && embedShown === `Front desk | Open on its own | ${HOST}:${PORTS.app}/#run=… | _blank | https://frontdesk.demo.invalid/mcp`
                    && embedFound === 'Ada Lovelace, Analytical Engines',
                `${embedFile}; ${embedShown}; ${embedFound}`);

            // Another client address is the one embeds and links use (normalized: http for one on
            // this computer, the folder of its page); this page's sets it back.
            await page.run(`navigator.clipboard.writeText = text => { window.copiedLink = text; return Promise.resolve(); }`);
            await page.run(`(() => {
                const field = document.querySelector('apps-share-dialog [data-client-address]');
                field.value = 'localhost:${PORTS.app}/index.html';
                field.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
            const otherAddress = await page.waitFor(`(() => {
                const dialog = document.querySelector('apps-share-dialog dialog');
                const note = dialog.querySelector('[data-address-note]').textContent;
                return note.startsWith('Checking') ? null : [dialog.querySelector('[data-client-address]').value, dialog.querySelector('[data-embed-code]').value.match(/src="([^#]+)#/)?.[1], note.split('.')[0]].join(' | ');
            })()`, 10000);
            await page.run(`document.querySelector('apps-share-dialog [data-copy-link]').click()`);
            const linkThere = await page.waitFor(`window.copiedLink?.startsWith('http://localhost:${PORTS.app}/${RUN_HASH}') ? 'http://localhost:${PORTS.app}/${RUN_HASH}…' : null`, 5000);
            await page.run(`document.querySelector('apps-share-dialog [data-use-address="${HOST}:${PORTS.app}/"]').click()`);
            const setBack = await page.waitFor(`document.querySelector('apps-share-dialog [data-client-address]').value === '${HOST}:${PORTS.app}/' ? 'kept ' + localStorage.getItem('appsClientAddress') : null`, 5000);
            await page.run(`document.querySelector('apps-share-dialog [data-close]').click()`);
            rmSync(embedDownloads, { recursive: true, force: true });
            check("Apps: the client's address, set to another, is the one embeds and links use; this page's sets it back",
                otherAddress === `http://localhost:${PORTS.app}/ | http://localhost:${PORTS.app}/?embed | Couldn't check it: this page can't reach it, or isn't let read it`
                    && linkThere === `http://localhost:${PORTS.app}/${RUN_HASH}…` && setBack === 'kept null',
                `${otherAddress}; ${linkThere}; ${setBack}`);

            // Front desk came with its demo server, built in. The mock server has the same tools,
            // so the Inspector's Servers it calls offers it in its place, and not the servers without
            // them; choosing it moves every rule, and the next check-in goes there.
            const deskRun = await page.run(`${latestRun('check_in', 'app')}.then(run => run?.serverUrl || null)`);
            await page.run(`document.querySelector('app-canvas').apps.select(null)`);
            const offered = await page.waitFor(`(() => {
                const use = document.querySelector('app-inspector [data-server-use]');
                const select = use?.querySelector('[data-call-instead]');
                if (!select) return null;
                const options = [...select.options].slice(1);
                return JSON.stringify({ calls: use.dataset.serverUse, tools: use.querySelector('.app-server-use-tools').textContent, badge: use.querySelector('.badge')?.textContent,
                    can: options.filter(option => !option.disabled).map(option => option.value), cannot: options.filter(option => option.disabled).map(option => option.textContent) });
            })()`, 5000);
            const { calls, tools: called, badge: builtInBadge, can = [], cannot = [] } = JSON.parse(offered || '{}');
            await page.run(`(() => {
                const select = document.querySelector('app-inspector [data-call-instead]');
                select.value = ${JSON.stringify(modernUrl)};
                select.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
            const moved = await page.waitFor(`(() => {
                const urls = [...new Set(document.querySelector('app-canvas').apps.app.flow.map(rule => rule.call.serverUrl))];
                return urls.join(' ') === ${JSON.stringify(modernUrl)} ? document.querySelector('app-inspector [data-server-use]')?.dataset.serverUse : null;
            })()`, 5000);
            await page.run(`document.getElementById('previewAppBtn').click()`);
            await page.waitFor(`!document.querySelector('app-preview').hidden && !!document.querySelector('app-preview iframe')`, 5000);
            await findVisit('ada');
            await frameWaitFor(`${showing} === 'confirm'`);
            await tap('yes');
            await frameWaitFor(`${showing} === 'done'`);
            const mockRun = await page.waitFor(`${latestRun('check_in', 'app')}.then(run => run?.serverUrl === ${JSON.stringify(modernUrl)} ? run.serverUrl : null)`, 5000);
            await page.run(`document.querySelector('app-preview [data-exit-preview]').click()`);
            await page.waitFor(`document.querySelector('app-preview').hidden`, 5000);
            check("Apps: Front desk runs on its demo server, built in, and can call the mock server instead, which has the same tools; servers without them say what's missing",
                deskRun === deskUrl && calls === deskUrl && called === 'find_visit, check_in, call_front_desk' && builtInBadge === 'Demo, built in'
                    && can.includes(modernUrl) && !can.includes(`${HOST}:${PORTS.legacy}/`) && cannot.some(text => text.endsWith(': it has no find_visit'))
                    && moved === modernUrl && mockRun === modernUrl,
                `${deskRun}; ${offered}; ${moved}; ${mockRun}`);

            // Each of Your apps has a ⋯ menu, always there on the app shown: its Delete takes an app
            // that isn't shown, on a second click, and what this browser kept for it, and the
            // shown one stays.
            const rowOf = name => `[...document.querySelectorAll('#appList .apps-row')].find(row => row.querySelector('.wb-row-label').textContent === ${JSON.stringify(name)})`;
            const goneId = await page.run(`${rowOf('New app')}.querySelector('[data-show-app]').dataset.showApp`);
            const rowsBeforeDelete = await page.run(`document.querySelectorAll('#appList .apps-row').length`);
            await page.run(`(() => {
                const views = JSON.parse(localStorage.getItem('appsCanvasViews') || '{}');
                localStorage.setItem('appsCanvasViews', JSON.stringify({ ...views, [${JSON.stringify(goneId)}]: { zoom: 0.5, left: 0, top: 0 } }));
                document.querySelector('app-canvas').apps.setRunOnOpen('no', ${JSON.stringify(goneId)});
            })()`);
            const shownMenu = await page.run(`getComputedStyle(document.querySelector('#appList .apps-row:has([aria-current="true"]) .apps-row-menu')).opacity`);
            await page.run(`(() => {
                const row = ${rowOf('New app')};
                row.querySelector('details').open = true;
                row.querySelector('[data-delete-app]').click();
            })()`);
            const confirmingRow = await page.run(`${rowOf('New app')}.querySelector('[data-delete-app]').textContent + ', menu ' + (${rowOf('New app')}.querySelector('details').open ? 'open' : 'closed')`);
            await page.run(`${rowOf('New app')}.querySelector('[data-delete-app]').click()`);
            const afterRowDelete = await page.waitFor(`!${rowOf('New app')} ? [document.getElementById('appName').value + ' shown', document.querySelectorAll('#appList .apps-row').length + ' apps',
                JSON.parse(localStorage.getItem('appsCanvasViews') || '{}')[${JSON.stringify(goneId)}] ? 'its view kept' : 'its view forgotten',
                JSON.parse(localStorage.getItem('appsRunOnOpen') || '{}')[${JSON.stringify(goneId)}] ? 'its answer kept' : 'its answer forgotten'].join(', ') : null`, 5000);
            check("Apps: each of Your apps has a ⋯ menu, always there on the one shown, whose Delete takes another app on a second click, with what was kept for it",
                shownMenu === '1' && confirmingRow === 'Click again to confirm, menu open' && afterRowDelete === `Front desk shown, ${rowsBeforeDelete - 1} apps, its view forgotten, its answer forgotten`,
                `${shownMenu}; ${confirmingRow}; ${afterRowDelete}`);
            await page.send('Emulation.clearDeviceMetricsOverride');
        }
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
        check("history: every call is in the dock's Runs, the apps', their models' tool calls and Run all's included",
            ['app', 'collection', 'reply', 'workbench'].every(source => (historySources || '').includes(source)), historySources);
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

        // The Chat example's model is told about every server and its tools, the token server's
        // too, but never a token.
        await page.run(`(() => {
            document.querySelector('[data-mode="apps"]').click();
            [...document.querySelectorAll('apps-rail [data-show-app]')].find(row => row.querySelector('.wb-row-label').textContent === 'Chat').click();
        })()`);
        await frameWaitFor(`document.readyState === 'complete' && !!document.getElementById('message') && !document.getElementById('send').disabled`);
        const askedBefore = await page.run(`${latestRun('chat', 'app')}.then(run => run?.id || 'none')`);
        await frameRun(`(() => {
            document.getElementById('message').value = 'Which tools can you use?';
            document.getElementById('send').click();
            return true;
        })()`);
        const toldModel = await page.waitFor(`${latestRun('chat', 'app')}.then(run => run && run.id !== ${JSON.stringify(askedBefore)} ? JSON.stringify(run.sentArgs) : null)`, 10000);
        check("Apps: the Chat example's model is told about your servers and their tools, never their tokens",
            !!toldModel && toldModel.includes(tokenUrl) && toldModel.includes('echo_region') && !toldModel.includes(TOKEN),
            toldModel ? `${toldModel.length} characters sent` : 'no call');
        await page.run(showWorkbench);

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
        check('Glean by email: a lookup the browser blocks falls back to pasting the endpoint, from Glean\'s settings',
            /Paste your MCP endpoint instead, from Third party apps and MCP in Glean's settings\.$/.test(blockedLookup || ''), blockedLookup);
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
