#!/usr/bin/env node
// Browser smoke test: loads the app in headless Chrome and drives the real UI against mock MCP
// servers (modern, streaming, legacy, dual-era, strict CORS, token-protected) and, with
// --reference, a server built on the official Python SDK. --public also connects to the public
// servers the in-app guide suggests, through the guide's own buttons (needs internet access).
//
//   node tests/browser-smoke.mjs [--reference] [--public]
//
// Needs Node 22+, Google Chrome (or CHROME_PATH), python3, and for --reference the venv that
// setup.sh creates. Exits non-zero if any check fails.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WITH_REFERENCE = process.argv.includes('--reference');
const WITH_PUBLIC = process.argv.includes('--public');
const HOST = 'http://127.0.0.1';
const PORTS = {
    app: 18080, modern: 18081, sse: 18082, legacy: 18083, legacySse: 18084, dual: 18085, reference: 18086,
    strictLegacy: 18087, token: 18088, strictModern: 18089, devtools: 19222,
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
        const toolItem = [...document.querySelectorAll('#toolsList .tool-item')].find(el => el.textContent === ${JSON.stringify(tool)});
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

async function main() {
    if (!CHROME) throw new Error('Google Chrome not found; set CHROME_PATH');
    const referencePython = join(ROOT, 'venv', 'bin', 'python');
    if (WITH_REFERENCE && !existsSync(referencePython)) {
        throw new Error('--reference needs the venv: run ./setup.sh or npm run setup:python');
    }

    start('app', PYTHON, ['-m', 'http.server', String(PORTS.app), '--bind', '127.0.0.1', '--directory', 'public']);
    mock('modern', PORTS.modern, '--mode', 'modern');
    mock('modern+sse', PORTS.sse, '--mode', 'modern', '--sse');
    mock('legacy', PORTS.legacy, '--mode', 'legacy');
    mock('legacy+sse', PORTS.legacySse, '--mode', 'legacy', '--sse');
    mock('dual', PORTS.dual, '--mode', 'dual');
    mock('legacy+old CORS', PORTS.strictLegacy, '--mode', 'legacy', '--allow-headers', OLD_CORS_HEADERS);
    mock('token', PORTS.token, '--mode', 'modern', '--token', TOKEN);
    mock('modern+old CORS', PORTS.strictModern, '--mode', 'modern', '--allow-headers', OLD_CORS_HEADERS);
    if (WITH_REFERENCE) {
        start('reference', referencePython, ['tests/reference_server.py', '--port', String(PORTS.reference)]);
    }
    for (const [name, port] of Object.entries(PORTS)) {
        if (name === 'devtools' || (name === 'reference' && !WITH_REFERENCE)) continue;
        await waitForHttp(`${HOST}:${port}/`);
    }

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
            { label: 'modern server', url: `${HOST}:${PORTS.modern}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count'] },
            { label: 'modern server with SSE replies', url: `${HOST}:${PORTS.sse}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count'] },
            { label: 'legacy server', url: `${HOST}:${PORTS.legacy}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'legacy server with SSE replies', url: `${HOST}:${PORTS.legacySse}/`, era: 'legacy', version: '2025-11-25', tools: ['echo', 'count'] },
            { label: 'dual-era server', url: `${HOST}:${PORTS.dual}/`, era: 'modern', version: '2026-07-28', tools: ['echo', 'echo_region', 'count'] },
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

        const tokenUrl = `${HOST}:${PORTS.token}/`;
        const locked = await addAndConnect(page, tokenUrl, 'needs a token');
        check('a server that needs a token says so', locked?.status === 'failed' && /bearer token/i.test(locked.error || ''), locked?.error);
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
