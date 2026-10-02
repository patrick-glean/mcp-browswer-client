#!/usr/bin/env node
// Browser smoke test: loads the app in headless Chrome and drives the real UI against mock MCP
// servers (modern, streaming, legacy, dual-era, strict CORS, token-protected, OAuth sign-in) and, with
// --reference, a server built on the official Python SDK. --public also connects to the public
// servers the in-app guide suggests, through the guide's own buttons (needs internet access).
//
//   node tests/browser-smoke.mjs [--reference] [--public]
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WITH_REFERENCE = process.argv.includes('--reference');
const WITH_PUBLIC = process.argv.includes('--public');
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
        const s = chatShell.servers[${JSON.stringify(url)}];
        return s && ['connected', 'failed'].includes(s.status)
            ? { status: s.status, era: s.era, version: s.protocolVersion, name: s.name, error: s.lastError }
            : null;
    })()`;
}

// Adding a server connects to it.
async function addAndConnect(page, url, alias, ms) {
    await page.run(`(() => {
        document.getElementById('mcpTabBtn').click();
        document.getElementById('serverUrl').value = ${JSON.stringify(url)};
        document.getElementById('serverAlias').value = ${JSON.stringify(alias)};
        document.getElementById('addServerBtn').click();
    })()`);
    return page.waitFor(connectionState(url), ms);
}

async function toolNames(page, url, ms) {
    const names = await page.waitFor(`(() => {
        const tools = chatShell.servers[${JSON.stringify(url)}]?.tools || [];
        return tools.length ? tools.map(t => t.name) : null;
    })()`, ms);
    return names || [];
}

async function callTool(page, url, tool, values, ms = 20000) {
    await page.run(`(() => {
        document.getElementById('mcpTabBtn').click();
        const item = [...document.querySelectorAll('.server-name')].find(el => el.title === ${JSON.stringify(url)});
        item.closest('.server-item').click();
        const toolItem = [...document.querySelectorAll('#toolsList .tool-item')].find(el => el.dataset.tool === ${JSON.stringify(tool)});
        toolItem.click();
        for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
            document.querySelector('#toolCard [name="' + name + '"]').value = value;
        }
        document.getElementById('toolResultCard').innerHTML = '';
        document.querySelector('#toolCard form').requestSubmit();
    })()`);
    return page.waitFor(`(() => {
        const card = document.getElementById('toolResultCard');
        const text = card.innerText.trim();
        return text && !card.querySelector('[data-pending]') ? text.replace(/\\s+/g, ' ') : null;
    })()`, ms);
}

// The Logs tab's entries, for checks that the right things were (and weren't) logged.
const entries = `chatShell.logPanel.entries`;

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
        await page.send('Page.navigate', { url: `${HOST}:${PORTS.app}/` });
        const healthy = await page.waitFor(`
            document.getElementById('sw-status').classList.contains('healthy') &&
            document.getElementById('wasm-status').classList.contains('healthy') &&
            !!chatShell.serviceWorker`);
        check('app loads with the service worker and WASM running', !!healthy);

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
        const loaded = await page.waitFor(`${entries}.some(e => e.source === 'worker' && /^Loaded the WASM module/.test(e.message))`, 5000);
        check('logs: the worker reports the WASM build it loaded', !!loaded);

        const targets = [
            { label: 'modern server', url: `${HOST}:${PORTS.modern}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket'] },
            { label: 'modern server with SSE replies', url: `${HOST}:${PORTS.sse}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket'] },
            { label: 'legacy server', url: `${HOST}:${PORTS.legacy}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'legacy server with SSE replies', url: `${HOST}:${PORTS.legacySse}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'dual-era server', url: `${HOST}:${PORTS.dual}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count', 'ticket'] },
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
            document.getElementById('mcpTabBtn').click();
            [...document.querySelectorAll('.server-name')].find(el => el.title === ${JSON.stringify(modernUrl)}).closest('.server-item').click();
            const item = name => document.querySelector('#toolsList .tool-item[data-tool="' + name + '"]');
            const badges = name => [...item(name).querySelectorAll('.badge')].map(b => b.textContent);
            const filter = document.getElementById('toolFilter');
            filter.value = 'region';
            filter.dispatchEvent(new Event('input'));
            const visible = [...document.querySelectorAll('#toolsList .tool-item')].filter(el => !el.hidden).map(el => el.dataset.tool);
            const count = document.getElementById('toolCount').textContent;
            filter.value = '';
            filter.dispatchEvent(new Event('input'));
            item('count').click();
            const hidden = document.getElementById('hiddenTools');
            const connection = document.getElementById('cardConnection');
            return {
                echo: [item('echo').querySelector('.tool-item-title')?.textContent, ...badges('echo')].join(', '),
                count: badges('count').join(', '),
                filtered: visible.join(', ') + ' (' + count + ')',
                schemas: [...document.querySelectorAll('#toolCard .tool-schema summary')].map(s => s.textContent).join(', '),
                hidden: hidden.hidden ? '' : hidden.innerText.replace(/\\s+/g, ' '),
                connection: connection.hidden ? '' : connection.innerText.replace(/\\s+/g, ' '),
            };
        })()`);
        check('inspector: tools show their titles and annotation badges',
            inspector.echo === 'Echo, read-only' && inspector.count === 'read-only, idempotent, structured output', `echo: ${inspector.echo}; count: ${inspector.count}`);
        check('inspector: the filter narrows the list and the count follows', inspector.filtered === 'echo_region (1 of 4)', inspector.filtered);
        check('inspector: a tool shows its input and output schemas and raw definition',
            inspector.schemas === 'Input schema, Output schema, Definition (raw JSON)', inspector.schemas);
        check('inspector: hidden tools are listed with the reason', /1 hidden tool/.test(inspector.hidden), inspector.hidden);
        check('inspector: the server card shows what the server said about itself',
            /Mock MCP Server 2\.0\.0/.test(inspector.connection) && /Capabilities tools/.test(inspector.connection), inspector.connection);
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
            report?.server === modernUrl && report.tools.length === 4 && report.hiddenTools[0]?.name === 'broken_header' && report.serverInfo?.name === 'Mock MCP Server',
            downloaded || 'no file');

        const picker = await page.waitFor(`[...document.getElementById('chatToolSelect').options].map(o => o.value).join(',') || null`);
        check('console tool picker is populated', !!picker, picker);

        // The README's chat walkthrough: pick a server and tool, target a field, send a message.
        await page.run(`(() => {
            document.getElementById('consoleTabBtn').click();
            const server = document.getElementById('chatServerSelect');
            server.value = ${JSON.stringify(modernUrl)};
            server.dispatchEvent(new Event('change'));
            const tool = document.getElementById('chatToolSelect');
            tool.value = 'echo';
            tool.dispatchEvent(new Event('change'));
        })()`);
        await page.waitFor(`!!document.querySelector('#chatToolConfigForm .assign-cbus-string[data-field="text"]')`, 5000);
        await page.run(`(() => {
            const box = document.querySelector('#chatToolConfigForm .assign-cbus-string[data-field="text"]');
            box.checked = true;
            box.dispatchEvent(new Event('change'));
            document.getElementById('chatUserInput').value = 'hello from the console';
            document.getElementById('chatSendBtn').disabled = false;
            document.getElementById('chatSendBtn').click();
        })()`);
        const chatted = await page.waitFor(`[...document.querySelectorAll('#chatMessages .chat-msg.tool')].some(m => m.textContent.includes('Echo: hello from the console'))`);
        check('the console sends a message through the chosen tool', !!chatted);

        const trace = await page.run(`${entries}.some(e => e.source === 'wasm' && e.level === 'debug' && e.message.startsWith('→ server/discover'))`);
        check('logs: the WASM client traces each HTTP request', trace);
        const why = await page.run(`${entries}.some(e => e.source === 'wasm' && e.server === ${JSON.stringify(`${HOST}:${PORTS.legacy}/`)} && /looks like a 2025-era server/.test(e.message))`);
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
            chatShell.log({ level: 'info', message: '<img id="log-probe" src="x">' });
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
        const secondReady = await secondTab.waitFor(`typeof chatShell !== 'undefined' && !!chatShell.serviceWorker`);
        const afterTab = await callTool(page, modernUrl, 'echo', { text: 'after a second tab' });
        const retried = await page.run(`${entries}.slice(${beforeTab}).some(e => e.server === ${JSON.stringify(modernUrl)} && e.message.startsWith('→ server/discover'))`);
        check('opening the app in a second tab keeps the first tab\'s connections',
            !!secondReady && !!afterTab?.includes('Echo: after a second tab') && !retried, afterTab);
        secondTab.close();

        // The sandbox: Pre-fill, variables, saved requests and collections, the history of every
        // call with what changed, and export and import. It reloads the page near the end.
        await page.waitFor(`!!chatShell.sandbox`, 10000);
        const openTool = (url, tool) => page.run(`(() => {
            document.getElementById('mcpTabBtn').click();
            document.querySelector('.view-switch-btn[data-view="tools"]').click();
            [...document.querySelectorAll('.server-name')].find(el => el.title === ${JSON.stringify(url)}).closest('.server-item').click();
            [...document.querySelectorAll('#toolsList .tool-item')].find(el => el.dataset.tool === ${JSON.stringify(tool)}).click();
        })()`);
        const field = name => `document.querySelector('#toolCard [name="${name}"]').value`;
        const setField = (name, value) => page.run(`(() => {
            const input = document.querySelector('#toolCard [name="${name}"]');
            input.value = ${JSON.stringify(value)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const prefillFrom = async source => {
            await page.run(`document.querySelector('#toolCard .prefill-menu').open = true`);
            await page.waitFor(`!!document.querySelector('#toolCard [data-prefill-source="${source}"]:not([disabled])')`, 5000);
            await page.run(`document.querySelector('#toolCard [data-prefill-source="${source}"]').click()`);
        };
        // The result card once the run is in, as text.
        const shownResult = `(() => {
            const card = document.getElementById('toolResultCard');
            const text = card.innerText.trim();
            return text && !card.querySelector('[data-pending]') ? text.replace(/\\s+/g, ' ') : null;
        })()`;
        const submitToolCard = async () => {
            await page.run(`(() => {
                document.getElementById('toolResultCard').innerHTML = '';
                document.querySelector('#toolCard form').requestSubmit();
            })()`);
            return page.waitFor(shownResult);
        };
        const showView = view => page.run(`document.querySelector('.view-switch-btn[data-view="${view}"]').click()`);
        const savedItem = name => `[...document.querySelectorAll('#savedList .saved-item')].find(li => li.querySelector('.saved-name')?.textContent === ${JSON.stringify(name)})`;
        const runSaved = async name => {
            await page.run(`(() => {
                document.getElementById('toolResultCard').innerHTML = '';
                ${savedItem(name)}.querySelector('[data-run-request]').click();
            })()`);
            return page.waitFor(`document.querySelector('#toolResultCard .run-summary') && ${shownResult}`);
        };

        await openTool(modernUrl, 'echo');
        await prefillFrom('schema');
        const echoFromSchema = await page.waitFor(`${field('text')} || null`, 5000);
        await openTool(modernUrl, 'count');
        await prefillFrom('schema');
        const countFromSchema = await page.waitFor(`${field('n')} || null`, 5000);
        check('pre-fill: From the schema fills in examples and defaults', echoFromSchema === 'hello' && countFromSchema === '3', `${echoFromSchema}, ${countFromSchema}`);

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
            document.getElementById('closeEnvEditor').click();
        })()`);
        await openTool(modernUrl, 'count');
        await prefillFrom('schema');
        const nFromVariable = await page.waitFor(`${field('n')} || null`, 5000);
        const nPreview = await page.waitFor(`(() => {
            const preview = document.querySelector('#toolCard .sends-preview');
            return preview.querySelector('pre').textContent.includes('"n": 2') && preview.querySelector('summary').textContent;
        })()`, 5000);
        const countedTo = await submitToolCard();
        check('variables: a number field takes {{n}} and sends it as a number',
            nFromVariable === '{{n}}' && /1 variable from Default/.test(nPreview || '') && !!countedTo?.includes('Counted to 2'), `${nFromVariable}; ${nPreview}; ${countedTo}`);

        await openTool(modernUrl, 'echo');
        await setField('text', '{{greeting}} world');
        const greetingPreview = await page.waitFor(`document.querySelector('#toolCard .sends-preview pre').textContent.includes('"hi world"')`, 5000);
        const greeted = await submitToolCard();
        check('variables: {{greeting}} world goes out as "hi world", as the preview showed', !!greetingPreview && !!greeted?.includes('Echo: hi world'), greeted);
        await setField('text', '{{nope}}');
        const unknownVariable = await submitToolCard();
        check('variables: an unknown variable stops the call and names itself', /\{\{nope\}\} isn't a variable/.test(unknownVariable || ''), unknownVariable);

        await openTool(modernUrl, 'echo');
        await page.run(`document.querySelector('#toolCard [data-prefill-best]').click()`);
        const lastSentText = await page.waitFor(`${field('text')} || null`, 5000);
        check('pre-fill: one click brings back what you last sent, variables and all', lastSentText === '{{greeting}} world', lastSentText);

        const saveAs = async (name, collection) => {
            await page.run(`document.querySelector('#toolCard [data-save-request]').click()`);
            await page.waitFor(`!!document.querySelector('#toolCard .save-request:not([hidden]) [data-save-name]')`, 5000);
            await page.run(`(() => {
                const panel = document.querySelector('#toolCard .save-request');
                panel.querySelector('[data-save-name]').value = ${JSON.stringify(name)};
                const select = panel.querySelector('[data-save-collection]');
                const existing = [...select.options].find(option => option.textContent === ${JSON.stringify(collection)});
                select.value = existing ? existing.value : '__new';
                select.dispatchEvent(new Event('change'));
                if (!existing) panel.querySelector('[data-save-new-collection]').value = ${JSON.stringify(collection)};
                panel.querySelector('[data-save-confirm]').click();
            })()`);
            return page.waitFor(`(() => {
                const note = document.querySelector('#toolCard .tool-toolbar-note').textContent;
                return note.startsWith('Saved as') ? note : null;
            })()`, 5000);
        };
        const savedGreeting = await saveAs('Greeting', 'Smoke');
        await openTool(modernUrl, 'ticket');
        await prefillFrom('schema');
        const savedTicket = await saveAs('Next ticket', 'Smoke');
        await showView('saved');
        const savedNames = await page.waitFor(`(() => {
            const names = [...document.querySelectorAll('#savedList .saved-group')].filter(group => group.querySelector('.saved-group-name')?.textContent === 'Smoke')
                .flatMap(group => [...group.querySelectorAll('.saved-name')].map(el => el.textContent));
            return names.length === 2 ? names.join(', ') : null;
        })()`, 5000);
        await page.run(`${savedItem('Greeting')}.querySelector('[data-open-request]').click()`);
        const reopened = await page.waitFor(`document.querySelector('#toolCard h3')?.textContent === 'echo' && ${field('text')}`, 5000);
        check('saved requests: saved into a collection and opened again',
            savedGreeting === 'Saved as Greeting.' && savedTicket === 'Saved as Next ticket.' && savedNames === 'Greeting, Next ticket' && reopened === '{{greeting}} world',
            `${savedNames}; ${reopened}`);
        await openTool(modernUrl, 'echo');
        await page.run(`document.querySelector('#toolCard .prefill-menu').open = true`);
        await page.waitFor(`[...document.querySelectorAll('#toolCard [data-prefill-source]')].some(item => item.textContent === 'Saved: Greeting')`, 5000);
        await page.run(`[...document.querySelectorAll('#toolCard [data-prefill-source]')].find(item => item.textContent === 'Saved: Greeting').click()`);
        const fromSavedMenu = await page.waitFor(`(() => {
            const note = document.querySelector('#toolCard .tool-toolbar-note').textContent;
            return /^Filled from Greeting/.test(note) ? ${field('text')} : null;
        })()`, 5000);
        check('pre-fill: the menu offers saved requests for the tool', fromSavedMenu === '{{greeting}} world', fromSavedMenu);
        await showView('saved');
        await page.waitFor(`!!${savedItem('Greeting')}`, 5000);

        await runSaved('Greeting');
        const greetingAgain = await runSaved('Greeting');
        check('Run again: a saved request whose result is the same says so', /Same as the last run/.test(greetingAgain || '') && !!greetingAgain?.includes('Echo: hi world'), greetingAgain);
        await runSaved('Next ticket');
        const ticketAgain = await runSaved('Next ticket');
        await page.run(`document.querySelector('#toolResultCard [data-show-changes]')?.click()`);
        const ticketDiff = await page.waitFor(`document.querySelector('#toolResultCard .run-diff:not([hidden]) .diff')?.innerText`, 5000);
        check('Run again: a changed result says so, and Show changes has the lines that differ',
            /Changed since the last run/.test(ticketAgain || '') && /^- .*"text": "T-\d+"/m.test(ticketDiff || '') && /^\+ .*"text": "T-\d+"/m.test(ticketDiff || ''),
            (ticketDiff || ticketAgain || '').replace(/\s+/g, ' ').slice(0, 160));

        await page.run(`[...document.querySelectorAll('#savedList .saved-group')].find(group => group.querySelector('.saved-group-name')?.textContent === 'Smoke').querySelector('[data-run-collection]').click()`);
        const collectionSummary = await page.waitFor(`[...document.querySelectorAll('#savedList .collection-run-summary')].map(el => el.textContent).find(text => text.startsWith('Ran ')) || null`, 20000);
        check('Run all: runs the collection and sums up what changed', collectionSummary === 'Ran 2: 1 same, 1 changed, 0 failed', collectionSummary);

        await showView('history');
        const historySources = await page.waitFor(`(() => {
            const items = [...document.querySelectorAll('#historyList .history-item')];
            return items.length ? [...new Set(items.map(item => item.dataset.source))].sort().join(', ') : null;
        })()`, 5000);
        check('history: every call is there, the chat\'s and Run all\'s included',
            ['chat', 'collection', 'sandbox'].every(source => (historySources || '').includes(source)), historySources);
        await page.run(`document.querySelector('#historyList .history-item').click()`);
        const openedRun = await page.waitFor(`(() => {
            const button = document.querySelector('#toolCard .call-tool-btn');
            return button?.textContent === 'Run again' && /From history/.test(document.getElementById('toolResultCard').innerText)
                ? document.querySelector('#toolCard h3').textContent + ' ' + ${field('prefix')} : null;
        })()`, 5000);
        check('history: an entry opens with its arguments and result, ready to run again', openedRun === 'ticket T-', openedRun);

        const historyCount = await page.run(`document.querySelectorAll('#historyList .history-item').length`);
        await page.send('Page.reload');
        await page.waitFor(`typeof chatShell !== 'undefined' && !!chatShell.sandbox && !!chatShell.serviceWorker`, 20000);
        await page.run(`document.getElementById('mcpTabBtn').click()`);
        await showView('history');
        const historyAfterReload = await page.waitFor(`document.querySelectorAll('#historyList .history-item').length || null`, 5000);
        check('history: kept after a reload', historyAfterReload === historyCount, `${historyAfterReload} of ${historyCount} runs`);

        const exportFolder = mkdtempSync(join(tmpdir(), 'mcp-smoke-export-'));
        await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: exportFolder });
        await showView('saved');
        await page.waitFor(`!!${savedItem('Greeting')}`, 5000);
        await page.run(`document.getElementById('exportSandboxBtn').click()`);
        let exportFile;
        for (let i = 0; i < 50 && !exportFile; i++) {
            exportFile = readdirSync(exportFolder).find(name => name.endsWith('.json'));
            if (!exportFile) await sleep(100);
        }
        const exported = exportFile ? JSON.parse(readFileSync(join(exportFolder, exportFile), 'utf8')) : null;
        await page.run(`${savedItem('Greeting')}.querySelector('[data-delete-request]').click()`);
        await page.waitFor(`!${savedItem('Greeting')}`, 5000);
        const { root } = (await page.send('DOM.getDocument')).result;
        const { nodeId } = (await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#importSandboxInput' })).result;
        await page.send('DOM.setFileInputFiles', { nodeId, files: [join(exportFolder, exportFile || 'missing.json')] });
        const imported = await page.waitFor(`/^Imported/.test(document.getElementById('sandboxStatus').textContent) && !!${savedItem('Greeting')} && document.getElementById('sandboxStatus').textContent`, 5000);
        rmSync(exportFolder, { recursive: true, force: true });
        check('export and import: an export brings back a deleted request',
            exported?.requests?.length === 2 && exported.environments?.[0]?.variables?.greeting === 'hi' && /^Imported 2 saved requests, 1 collection and 1 environment/.test(imported || ''),
            imported || exportFile || 'no export');

        await showView('history');
        await page.run(`(() => {
            const clear = document.getElementById('clearHistoryBtn');
            clear.click();
            clear.click();
        })()`);
        const cleared = await page.waitFor(`/No calls yet/.test(document.getElementById('historyList').textContent)`, 5000);
        check('history: Clear history empties it', !!cleared);
        await showView('tools');

        const tokenUrl = `${HOST}:${PORTS.token}/`;
        const locked = await addAndConnect(page, tokenUrl, 'needs a token');
        check('a server that needs a token says so', locked?.status === 'failed' && /sign in|static token/i.test(locked.error || ''), locked?.error);
        await page.run(`(() => {
            const input = document.getElementById('cardServerToken');
            input.value = ${JSON.stringify(TOKEN)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await page.waitFor(`chatShell.servers[${JSON.stringify(tokenUrl)}]?.bearerToken === ${JSON.stringify(TOKEN)}`, 5000);
        await page.run(`document.getElementById('initProtocol').click()`);
        const unlocked = await page.waitFor(connectionState(tokenUrl));
        check('with a bearer token it connects', unlocked?.status === 'connected', JSON.stringify(unlocked));
        const withToken = await callTool(page, tokenUrl, 'echo', { text: 'with a token' });
        check('with a bearer token tools can be called', !!withToken?.includes('Echo: with a token'), withToken);
        const leaked = await page.run(`JSON.stringify(${entries}).includes(${JSON.stringify(TOKEN)})`);
        check('logs: the bearer token never appears', !leaked);

        // Sign-in (OAuth), as with Glean: the 401's challenge is unreadable, so the client finds
        // the protected resource metadata at its well-known address.
        const oauthUrl = `${HOST}:${PORTS.oauth}/`;
        const needsSignIn = await addAndConnect(page, oauthUrl, 'OAuth mock');
        const offered = await page.run(`!document.getElementById('cardAuth').hidden && !document.getElementById('signInBtn').hidden`);
        check('a server that needs sign-in says so and offers Sign in',
            needsSignIn?.status === 'failed' && /sign in/i.test(needsSignIn.error || '') && offered, needsSignIn?.error);
        const signedIn = await signIn(page, `chatShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`);
        check('signing in through the pop-up window connects', !!signedIn,
            signedIn ? '' : await page.run(`chatShell.servers[${JSON.stringify(oauthUrl)}]?.lastError`));
        const shown = await page.run(`(() => {
            const visible = [...document.querySelectorAll('#cardAuth button')].filter(b => b.offsetParent).map(b => b.textContent);
            return document.getElementById('cardAuthStatus').textContent + ' [' + visible.join(', ') + ']';
        })()`);
        check('the server card says who you signed in with and offers only Sign out',
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
            const s = chatShell.servers[${JSON.stringify(oauthUrl)}];
            return s?.status === 'failed' ? s.lastError : null;
        })()`);
        check('signing out forgets the tokens, and the server asks for sign-in again', !!forgotten && /sign in/i.test(signedOut || ''), signedOut);

        const noExpiryUrl = `${HOST}:${PORTS.oauthNoExpiry}/`;
        await addAndConnect(page, noExpiryUrl, 'OAuth mock, no expires_in');
        await signIn(page, `chatShell.servers[${JSON.stringify(noExpiryUrl)}]?.status === 'connected'`);
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
            const error = chatShell.servers[${JSON.stringify(wrongIssUrl)}]?.lastError || '';
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
        const foundAndSignedIn = await lookUp('someone@oauth-mock.test', `chatShell.servers[${JSON.stringify(gleanUrl)}]?.status === 'connected'`);
        const filled = await page.run(`document.getElementById('gleanUrl').value + ' | ' + document.getElementById('gleanStatus').textContent`);
        check('Glean by email: the lookup finds the server, and sign-in connects to its default MCP server',
            !!foundAndSignedIn && filled.startsWith(`${gleanUrl} | oauth-mock.test uses the Glean at ${HOST}:${PORTS.oauth}/`), filled);
        check('Glean by email: the lookup sends the email the way Glean\'s sign-in page does',
            lookups.length === 3 && lookups.every(asked => asked.isGleanApp === 'true' && /@/.test(asked.email)), JSON.stringify(lookups));
        const emailLogged = await page.run(`JSON.stringify(${entries}).includes('someone@')`);
        check('Glean by email: logs name the domain, not the email address', !emailLogged);
        await page.send('Fetch.disable');
        await page.run(`document.getElementById('closeGuide').click()`);

        // Browsers without pop-ups (embedded ones, or a strict blocker): the card offers to
        // continue in this tab, or to open the copied link in another tab or browser.
        const signInWithoutPopup = async () => {
            await page.run(`(() => {
                window.realOpen ??= window.open;
                window.open = () => null;
                [...document.querySelectorAll('.server-name')].find(el => el.title === ${JSON.stringify(oauthUrl)}).closest('.server-item').click();
                if (!document.getElementById('signOutBtn').hidden) document.getElementById('signOutBtn').click();
            })()`);
            await page.waitFor(`!document.getElementById('signInBtn').hidden`, 5000);
            await page.send('Runtime.evaluate', { expression: `document.getElementById('signInBtn').click()`, userGesture: true });
            return page.waitFor(`!document.getElementById('cardAuthElsewhere').hidden && chatShell.signingIn?.authorizationUrl`);
        };
        const link = await signInWithoutPopup();
        const noPopupStatus = await page.run(`document.getElementById('cardAuthStatus').textContent`);
        check('without a pop-up, the card offers to continue in this tab or copy the link',
            !!link && /didn't open a pop-up window/.test(noPopupStatus), noPopupStatus);
        await page.send('Runtime.evaluate', { expression: `window.realOpen(${JSON.stringify(link)}, '_blank', 'noopener')`, userGesture: true });
        const fromTab = await page.waitFor(`chatShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`);
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
            document.querySelector('#cardAuthElsewhere details').open = true;
            document.getElementById('authCallbackUrl').value = ${JSON.stringify(address)};
            document.getElementById('finishSignInBtn').click();
            const error = document.getElementById('authPasteError');
            return error.hidden ? '' : error.textContent;
        })()`);
        const wrongPaste = await pasteInto('https://example.com/callback?state=abc');
        check('pasting an address that isn\'t the callback is turned away', /isn't the address sign-in sends you back to/.test(wrongPaste), wrongPaste);
        await pasteInto(landed || '');
        const pastedBack = await page.waitFor(`chatShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`);
        check('pasting the address from the other browser here finishes signing in', !!pastedBack,
            pastedBack ? '' : await page.run(`document.getElementById('authPasteError').textContent || chatShell.servers[${JSON.stringify(oauthUrl)}]?.lastError`));

        // This reloads the page, so it comes last among the checks that use the page's state.
        await signInWithoutPopup();
        await page.run(`document.getElementById('continueHereBtn').click()`);
        await sleep(500);
        const cameBack = await page.waitFor(`typeof chatShell !== 'undefined' && location.search === '' &&
            chatShell.servers[${JSON.stringify(oauthUrl)}]?.status === 'connected'`, 20000);
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
        const sandboxDump = await page.run(`new Promise((resolve, reject) => {
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
        const storedRuns = JSON.parse(sandboxDump || '{}').runs || [];
        check('the sandbox store has the calls but never a token',
            storedRuns.some(run => run.serverUrl === tokenUrl) && storedRuns.some(run => run.serverUrl === oauthUrl)
                && !sandboxDump.includes(TOKEN) && secrets.every(secret => !sandboxDump.includes(secret)),
            `${storedRuns.length} runs`);

        check('no uncaught page errors', page.exceptions.length === 0, page.exceptions.join(' | '));
    } finally {
        if (page && results.some(r => !r.ok)) {
            // The client's own Logs tab usually says what went wrong.
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
