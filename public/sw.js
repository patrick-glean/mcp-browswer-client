let wasmInstance = null;
let isRunning = true;

// --- TAP Config Storage ---
let currentTapConfig = {};

// --- Memory/Imprints Store ---
let currentImprints = [];

// --- MCP Servers Index ---
const mcpServersIndex = {};

// --- Tool Call Circuit Breaker ---
const toolCallHistory = {}; // { engramId: [timestamps] }

import * as authStore from './authStore.js';
import { WASM_SHA256 } from './build.js';
import { handleOp, initDB, openDB } from './chatStorage.js';
import { formatDuration, logger, setLogSink } from './logger.js';
import {
    checkWasm,
    ensureWasm,
    initializeWasm,
    reloadWasm,
    unloadWasm,
    stopUptimeCounter,
    getWasmInstance,
    setBroadcast as setWasmBroadcast
} from './wasm.js';

// Set up broadcast for wasm.js
setWasmBroadcast(broadcastToClients);
setLogSink(entry => broadcastToClients({ type: 'log', content: entry }));

self.addEventListener('error', event => {
    logger.error(`Uncaught error in the service worker: ${event.message}`, { detail: { file: event.filename, line: event.lineno } });
});
self.addEventListener('unhandledrejection', event => {
    logger.error(`Unhandled promise rejection in the service worker: ${event.reason?.message || event.reason}`);
});


// Add this near the top of sw.js
async function initialWasmBroadcast() {
    const wasmState = await checkWasm();
    broadcastWasmStatus(wasmState);
}


// Broadcast WASM status to all clients
function broadcastWasmStatus(wasmState) {

    const statusMessage = {
        jsonrpc: '2.0',
        method: 'wasm_status',
        params: {
            status: {
                healthy: wasmState.healthy,
                uptime: wasmState.uptime || 0
            },
            metadata: {
                timestamp: new Date().toISOString(),
                metadataVersion: wasmState.metadata || 'unknown',
                buildInfo: wasmState.buildInfo || 'unknown'
            }
        }
    };
    broadcastToClients(statusMessage);
}


// --- MCP client helpers ---

// --- Sign-in (OAuth) ---

// Authorization servers send the browser back to this page, next to the worker.
const REDIRECT_URI = new URL('oauth-callback.html', self.registration.scope).href;
// The MCP spec asks clients served from a loopback address to register as native apps.
const APPLICATION_TYPE = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(self.registration.scope).hostname) ? 'native' : 'web';
// Tokens this close to expiring are refreshed before use.
const REFRESH_MARGIN_MS = 60_000;

// A static token, from the message or the server list the page last sent.
function staticToken(url, message = {}) {
    return message.bearerToken ?? mcpServersIndex[url]?.bearerToken;
}

// Options for the WASM MCP client. A static token wins; otherwise the server's OAuth token.
async function mcpOptions(url, message = {}, extra = {}) {
    const bearerToken = staticToken(url, message) || await oauthAccessToken(url);
    return JSON.stringify({ ...(bearerToken ? { bearerToken } : {}), ...extra });
}

// Runs an MCP call with the server's credentials. When the server turns down an OAuth token,
// it's refreshed once and the call retried.
async function withAuth(url, message, extra, call) {
    try {
        return await call(await mcpOptions(url, message, extra));
    } catch (error) {
        if (mcpError(error).kind !== 'auth_required' || staticToken(url, message)) throw error;
        const held = await authStore.getTokens(url);
        if (!held?.refreshToken) throw error;
        logger.info('The server turned down the access token; refreshing it and trying again', { server: url });
        const accessToken = await oauthAccessToken(url, { force: true });
        if (!accessToken || accessToken === held.accessToken) throw error;
        return call(JSON.stringify({ bearerToken: accessToken, ...extra }));
    }
}

// The stored access token for a server, refreshed first when it's about to expire (or when
// `force` is set). Refreshes for one server run one at a time, since refresh tokens rotate.
async function oauthAccessToken(url, { force = false } = {}) {
    const tokens = await authStore.getTokens(url);
    if (!tokens) return undefined;
    const expiring = tokens.expiresAt && tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if (!force && !expiring) return tokens.accessToken;
    const usable = tokens.expiresAt ? tokens.expiresAt > Date.now() : true;
    if (!tokens.refreshToken) return usable && !force ? tokens.accessToken : undefined;
    if (!refreshes.has(url)) {
        refreshes.set(url, refreshTokens(url, tokens).finally(() => refreshes.delete(url)));
    }
    const fresh = await refreshes.get(url);
    return fresh ? fresh.accessToken : usable && !force ? tokens.accessToken : undefined;
}

const refreshes = new Map();

async function refreshTokens(url, tokens) {
    try {
        const fresh = JSON.parse(await wasmInstance.auth_refresh(JSON.stringify(tokens)));
        await authStore.putTokens(fresh);
        broadcastToClients({ type: 'auth_status', url, status: authStatus(fresh) });
        return fresh;
    } catch (error) {
        const failure = mcpError(error);
        logger.warn(`Couldn't refresh the access token: ${failure.message}`, { server: url, detail: errorDetail(failure) });
        if (failure.kind === 'auth_required') {
            await authStore.deleteTokens(url);
            broadcastToClients({ type: 'auth_status', url, status: authStatus(null) });
        }
        return null;
    }
}

// What pages may know about a sign-in: never the tokens themselves.
function authStatus(tokens) {
    if (!tokens) return { signedIn: false };
    return {
        signedIn: true,
        issuer: tokens.issuer,
        scope: tokens.scope || null,
        expiresAt: tokens.expiresAt || null,
        refreshable: !!tokens.refreshToken,
        clientId: tokens.clientId
    };
}

// WASM MCP calls reject with a JSON McpError: {kind, message, status?, code?, data?}.
function mcpError(error) {
    if (typeof error === 'string') {
        try {
            return JSON.parse(error);
        } catch {
            return { kind: 'internal', message: error };
        }
    }
    return { kind: 'internal', message: error?.message || String(error) };
}

function broadcastMcpError(url, action, error, started) {
    broadcastToClients({ type: 'mcp_server_error', url, action, error });
    const what = action === 'list_tools' ? 'Listing tools' : 'Connecting';
    const after = started === undefined ? '' : ` after ${formatDuration(performance.now() - started)}`;
    logger.error(`${what} failed${after}: ${error.message}`, { server: url, detail: errorDetail(error) });
}

// An McpError's fields other than the message, which the log line already shows.
function errorDetail({ kind, status, code, data }) {
    const detail = Object.fromEntries(Object.entries({ kind, status, code, data }).filter(([, value]) => value !== undefined));
    return Object.keys(detail).length ? detail : undefined;
}

function describeServer(url, info) {
    const name = info?.serverInfo?.name;
    if (!name) return url;
    return info.serverInfo.version ? `${name} ${info.serverInfo.version}` : name;
}

// Where a tool call came from, as the trace describes it.
const CALL_ORIGINS = { console: 'the page', tap: 'a chat message', extracted: 'tool output' };

function listNames(names, max = 8) {
    if (names.length <= max) return names.join(', ');
    return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

// What a page message is about, for the trace. Payloads stay out of the log: they can be large
// (the server list) or carry bearer tokens.
function describeMessage({ url, refresh, tapConfig }) {
    const detail = {};
    if (url) detail.url = url;
    if (tapConfig?.serverUrl) detail.server = tapConfig.serverUrl;
    if (tapConfig?.toolName) detail.tool = tapConfig.toolName;
    if (refresh) detail.refresh = true;
    return Object.keys(detail).length ? detail : undefined;
}

// --- Engram NAT Table ---
const engramNAT = new Map(); // engramId -> clientId

// --- UUIDv7 generator (browser-compatible, minimal) ---
function uuidv7() {
    // UUIDv7: 48 bits unix timestamp ms, 74 bits random
    const now = Date.now();
    const unixTs = now;
    const tsHex = unixTs.toString(16).padStart(12, '0'); // 48 bits = 12 hex chars
    // 74 bits random = 19 hex chars (but UUID is 36 chars with dashes)
    const rand = crypto.getRandomValues(new Uint8Array(10));
    let randHex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
    randHex = randHex.padEnd(20, '0');
    // Compose UUIDv7: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
    // Use timestamp for first 12 hex, then version, then random
    const uuid = [
        tsHex.slice(0, 8),
        tsHex.slice(8, 12),
        '7' + randHex.slice(0, 3),
        (8 + (rand[3] & 0x3)).toString(16) + randHex.slice(3, 6),
        randHex.slice(6, 18)
    ].join('-');
    return uuid;
}

// --- DRY helper for engram message persistence ---
async function persistEngramMessage(msg) {
    if (!msg.engramId) return;
    const storedMsg = {
        ...msg,
        id: uuidv7(),
        timestamp: msg.timestamp || Date.now(),
    };
    const db = await (await initDB(), openDB());
    const convStore = db.transaction('conversations', 'readonly').objectStore('conversations');
    const getReq = convStore.get(storedMsg.engramId);
    const exists = await new Promise(resolve => {
        getReq.onsuccess = () => resolve(!!getReq.result);
        getReq.onerror = () => resolve(false);
    });
    if (!exists) {
        await handleOp('store', storedMsg.engramId, {
            meta: { created: Date.now(), engramId: storedMsg.engramId },
            messages: [storedMsg]
        });
    } else {
        await handleOp('append', storedMsg.engramId, { message: storedMsg });
    }
}




function shouldBreakCircuit(engramId) {
    const now = Date.now();
    if (!engramId) return false;
    if (!toolCallHistory[engramId]) toolCallHistory[engramId] = [];
    // Keep only timestamps from the last 10 seconds
    toolCallHistory[engramId] = toolCallHistory[engramId].filter(ts => now - ts < 10000);
    if (toolCallHistory[engramId].length >= 3) return true; // max 3 calls per 10s
    toolCallHistory[engramId].push(now);
    return false;
}

// Handle messages from clients. waitUntil keeps the worker alive until the handler finishes,
// so a long MCP call isn't cut off when the browser would otherwise stop an idle worker.
self.addEventListener('message', (event) => {
    event.waitUntil(handleClientMessage(event));
});

async function handleClientMessage(event) {
    const message = event.data;
    logger.debug(`Page sent ${message.type}`, { detail: describeMessage(message) });

    const managesWasmLifecycle = ['unload_wasm', 'reload_wasm', 'stop'].includes(message.type);
    wasmInstance = managesWasmLifecycle ? getWasmInstance() : await ensureWasm();

    // Handle legacy messages
    switch (message.type) {
        case 'check-wasm':
        case 'check_wasm':
            const wasmState = await checkWasm(message.checkId);
            broadcastWasmStatus(wasmState);
            break;
        case 'initialize-wasm':
            await initializeWasm();
            break;
        // 'initialize-mcp' is the pre-2026 name for connecting; there's no handshake anymore
        // unless the server turns out to be a legacy one.
        case 'connect-mcp':
        case 'initialize-mcp': {
            const url = message.url;
            if (!wasmInstance) {
                broadcastMcpError(url, 'connect', { kind: 'internal', message: 'The WASM module is not loaded.' });
                break;
            }
            logger.info('Connecting', { server: url });
            const started = performance.now();
            try {
                const info = JSON.parse(await withAuth(url, message, {}, options => wasmInstance.connect(url, options)));
                broadcastToClients({ type: 'mcp_server_connected', url, info });
                logger.info(
                    `Connected to ${describeServer(url, info)} in ${formatDuration(performance.now() - started)}: MCP ${info.protocolVersion} (${info.era})`,
                    { server: url, detail: { serverInfo: info.serverInfo, capabilities: info.capabilities, instructions: info.instructions } }
                );
            } catch (error) {
                broadcastMcpError(url, 'connect', mcpError(error), started);
            }
            break;
        }
        case 'forget-mcp':
            if (message.url) {
                wasmInstance?.forget_server(message.url);
                delete mcpServersIndex[message.url];
                logger.debug('Forgot the connection', { server: message.url });
            }
            break;
        case 'auth-start': {
            const url = message.url;
            try {
                const options = {
                    redirectUri: REDIRECT_URI,
                    applicationType: APPLICATION_TYPE,
                    clients: await authStore.listClients(),
                    wwwAuthenticate: message.wwwAuthenticate || undefined
                };
                const begin = JSON.parse(await wasmInstance.auth_begin(url, JSON.stringify(options)));
                if (begin.newClient) await authStore.putClient(begin.client);
                await authStore.putPending(begin.pending);
                event.source?.postMessage({ type: 'auth_redirect', url, authorizationUrl: begin.authorizationUrl, issuer: begin.authServer.issuer });
            } catch (error) {
                const failure = mcpError(error);
                logger.error(`Couldn't start signing in: ${failure.message}`, { server: url, detail: errorDetail(failure) });
                event.source?.postMessage({ type: 'auth_error', url, error: failure });
            }
            break;
        }
        case 'auth-callback': {
            // The query string the authorization server sent the browser back with, from
            // oauth-callback.html or pasted into a page after signing in from another browser.
            const query = new URLSearchParams(message.query || '');
            const params = {};
            for (const [name, key] of [['code', 'code'], ['state', 'state'], ['iss', 'iss'], ['error', 'error'], ['error_description', 'errorDescription']]) {
                if (query.has(name)) params[key] = query.get(name);
            }
            const pending = await authStore.takePending(params.state);
            if (!pending) {
                const failure = { kind: 'auth_failed', message: "This sign-in response doesn't match a sign-in in progress in this browser; it may have expired or been used already." };
                logger.error(failure.message);
                event.source?.postMessage({ type: 'auth_callback_done', ok: false, unknownState: true, error: failure });
                break;
            }
            const url = pending.serverUrl;
            try {
                const tokens = JSON.parse(await wasmInstance.auth_finish(JSON.stringify(pending), JSON.stringify(params)));
                await authStore.putTokens(tokens);
                // A connection made before signing in shouldn't outlive it.
                wasmInstance.forget_server(url);
                event.source?.postMessage({ type: 'auth_callback_done', ok: true, url });
                broadcastToClients({ type: 'auth_complete', url, status: authStatus(tokens) });
            } catch (error) {
                const failure = mcpError(error);
                logger.error(`Sign-in failed: ${failure.message}`, { server: url, detail: errorDetail(failure) });
                event.source?.postMessage({ type: 'auth_callback_done', ok: false, url, error: failure });
                broadcastToClients({ type: 'auth_error', url, error: failure });
            }
            break;
        }
        case 'auth-status':
            event.source?.postMessage({ type: 'auth_status', url: message.url, status: authStatus(await authStore.getTokens(message.url)) });
            break;
        case 'auth-signout': {
            const url = message.url;
            const tokens = await authStore.getTokens(url);
            await authStore.deleteTokens(url);
            if (message.forgetClient && tokens) {
                await authStore.deleteClient(tokens.issuer, REDIRECT_URI);
            }
            wasmInstance?.forget_server(url);
            logger.info(message.forgetClient && tokens ? `Signed out, and forgot this client's registration with ${tokens.issuer}` : 'Signed out', { server: url });
            broadcastToClients({ type: 'auth_status', url, status: authStatus(null) });
            break;
        }
        case 'unload_wasm':
            unloadWasm();
            break;
        case 'reload_wasm':
            await reloadWasm();
            break;
        case 'stop':
            logger.info('Stopping the service worker');
            isRunning = false;
            stopUptimeCounter();
            unloadWasm();
            break;
        case 'add_memory_event':
            if (wasmInstance && message && message.text) {
                try {
                    await wasmInstance.add_memory_event(message.text);
                } catch (error) {
                    logger.error(`Couldn't add a memory event: ${error.message}`);
                }
            }
            break;
        case 'clear_memory_events':
            if (wasmInstance) {
                try {
                    await wasmInstance.clear_memory_events();
                } catch (error) {
                    logger.error(`Couldn't clear memory events: ${error.message}`);
                }
            }
            break;
        case 'list_tools': {
            const url = message.url;
            if (!wasmInstance) {
                broadcastMcpError(url, 'list_tools', { kind: 'internal', message: 'The WASM module is not loaded.' });
                break;
            }
            const started = performance.now();
            try {
                const listing = JSON.parse(await withAuth(url, message, { refresh: !!message.refresh }, options => wasmInstance.list_tools(url, options)));
                if (!mcpServersIndex[url]) mcpServersIndex[url] = { url };
                mcpServersIndex[url].tools = listing.tools;
                broadcastToClients({
                    type: 'tools_list',
                    url,
                    tools: listing.tools,
                    rejected: listing.rejected,
                    ttlMs: listing.ttlMs,
                    fromCache: listing.fromCache
                });
                const names = listing.tools.map(tool => tool.name);
                const count = `${names.length} tool${names.length === 1 ? '' : 's'}`;
                const how = listing.fromCache ? 'from the cache' : `in ${formatDuration(performance.now() - started)}`;
                logger.info(`Listed ${count} ${how}${names.length ? `: ${listNames(names)}` : ''}`, {
                    server: url,
                    detail: { ttlMs: listing.ttlMs, cacheScope: listing.cacheScope, hidden: listing.rejected }
                });
            } catch (error) {
                broadcastMcpError(url, 'list_tools', mcpError(error), started);
            }
            break;
        }
        case 'call_tool':
            if (!wasmInstance) {
                // Send error to the correct client if possible
                const errorMsg = {
                    type: 'tool_result',
                    error: 'WASM module not loaded',
                    engramId: message.engramId || null,
                    requestId: message.requestId || null,
                    source: 'console'
                };
                if (message.engramId && message.requestId && event.source && event.source.id) {
                    engramNAT.set(message.engramId, event.source.id);
                    sendToEngramClient(message.engramId, errorMsg);
                } else if (event?.source) {
                    event.source.postMessage(errorMsg);
                } else {
                    broadcastToClients(errorMsg);
                }
                break;
            }
            // Only use message.tapConfig if present, do NOT fall back to currentTapConfig
            await handleToolCall({ source: 'console', tapConfig: message.tapConfig, message, event, memory: currentImprints });
            break;
        case 'get_bootrom':
            if (!wasmInstance) {
                event.source.postMessage({
                    type: 'bootrom',
                    error: 'WASM module not loaded'
                });
                break;
            }
            try {
                const bootromJson = wasmInstance.get_bootrom();
                const bootrom = JSON.parse(bootromJson);
                event.source.postMessage({
                    type: 'bootrom',
                    bootrom
                });
            } catch (error) {
                event.source.postMessage({
                    type: 'bootrom',
                    error: error.message
                });
            }
            break;
        case 'cbus_message':
            logger.error('Pages send cbus_send_message; cbus_message only goes from the worker to pages');
            break;
        case 'cbus_send_message':
            if (message && message.text) {
                const msg = {
                    text: message.text,
                    role: message.role || 'user',
                    timestamp: Date.now(),
                    engramId: message.engramId || null
                };
                broadcastToClients({
                    type: 'cbus_message',
                    message: msg
                });
                // --- Persist user message ---
                await persistEngramMessage(msg);

                // --- After persisting, trigger tool call if CBus Tap is configured ---
                try {
                    const tapConfig = currentTapConfig || {};
                    if (tapConfig.serverUrl && tapConfig.toolName && (tapConfig.connectedStringArg || tapConfig.connectedArrayArg)) {
                        // Load full engram history
                        const { messages: engramMessages = [] } = await handleOp('load', msg.engramId, null) || {};
                        await handleToolCall({ source: 'tap', tapConfig, message: msg, engramMessages, memory: currentImprints });
                    }
                } catch (err) {
                    logger.error(`The chat's tool call failed: ${err.message}`, { server: currentTapConfig?.serverUrl });
                }
            } else {
                logger.debug('Ignored a chat message without text');
            }
            break;
        case 'cbus_subscribe':
            if (event.source) {
                // Load the engram's messages from IndexedDB
                let engramId = message?.engramId;
                if (!engramId && event.source) {
                    // Try to get engramId from NAT table if available
                    // (Optional: you may want to pass engramId explicitly from the client)
                }
                if (engramId) {
                    const { messages = [] } = await handleOp('load', engramId, null) || {};
                    event.source.postMessage({
                        type: 'cbus_queue',
                        queue: messages
                    });
                } else {
                    // If no engramId, send empty queue
                    event.source.postMessage({
                        type: 'cbus_queue',
                        queue: []
                    });
                }
            }
            break;
        case 'set_tap_config':
            currentTapConfig = message.tapConfig || {};
            logger.debug('The chat now sends messages to a tool', {
                server: currentTapConfig.serverUrl,
                detail: { tool: currentTapConfig.toolName, messageField: currentTapConfig.connectedStringArg, historyField: currentTapConfig.connectedArrayArg }
            });
            return;
        case 'update_memory':
            if (Array.isArray(message.imprints)) {
                currentImprints = message.imprints;
                logger.debug(`Updated memory: ${currentImprints.length} imprint${currentImprints.length === 1 ? '' : 's'}`);
            }
            break;
        case 'init_mcp_servers_index':
            if (message.servers && typeof message.servers === 'object') {
                Object.assign(mcpServersIndex, message.servers);
                logger.debug(`The page registered ${Object.keys(message.servers).length} server(s)`);
            }
            break;
        case 'extracted_tool_call': {
            // message.toolCall (the JSON-RPC object), message.engramId, message.tapConfig
            const toolCall = message.toolCall;
            const engramId = message.engramId || null;
            await maybeCallExtractedTool(toolCall, engramId);
            break;
        }
        default:
            logger.warn(`Ignored a message of unknown type ${message.type}`);
    }
}

// --- Send to engram client helper ---
function sendToEngramClient(engramId, message) {
    const clientId = engramNAT.get(engramId);
    if (clientId) {
        self.clients.get(clientId).then(client => {
            if (client) {
                client.postMessage(message);
            }
        });
    } else {
        // Fallback: broadcast if mapping missing
        broadcastToClients(message);
    }
}

// Initialize on install. A new version takes over as soon as it's installed instead of waiting
// for every tab to close.
self.addEventListener('install', event => {
    logger.info(`Installing the service worker for WASM build ${WASM_SHA256.slice(0, 12)}`);
    self.skipWaiting();
    event.waitUntil(initializeWasm());
    event.waitUntil(initDB());
});

// Handle activation
self.addEventListener('activate', event => {
    logger.debug('Activating');
    event.waitUntil(clients.claim());
    event.waitUntil(initialWasmBroadcast());
});


// Broadcast message to all clients. Uncontrolled pages count too: a page isn't controlled until
// the worker activates, and it should still see what happened while the worker installed.
function broadcastToClients(message) {
    if (!isRunning) return;
    
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(client => {
            client.postMessage(message);
        });
    });
}

// self.addEventListener('fetch', event => {
//     console.log(`Service Worker v${VERSION} handling fetch: ${event.request.url}`);
//     event.respondWith(
//         fetch(event.request)
//             .catch(() => {
//                 return new Response('Service Worker is offline');
//             })
//     );
// });

// Helper to extract text from tool response
function extractToolResponseText(parsedResult) {
    if (parsedResult?.resultType === 'input_required') {
        return 'The tool asked for more input, which this client does not support yet.';
    }
    if (parsedResult && parsedResult.result && Array.isArray(parsedResult.result.content)) {
        return parsedResult.result.content.map(c => c.text || '').join('\n');
    } else if (parsedResult && Array.isArray(parsedResult.content)) {
        return parsedResult.content.map(c => c.text || '').join('\n');
    } else if (Array.isArray(parsedResult)) {
        return parsedResult.map(c => c.text || '').join('\n');
    } else if (parsedResult && parsedResult.text) {
        return parsedResult.text;
    }
    return '[No content]';
}

// --- JSON-RPC Extraction Helper ---
/**
 * Extracts all JSON-RPC objects from code blocks in a text blob (handles escaped quotes).
 * Returns an array of parsed JSON objects.
 */
function extractJsonRpcCalls(text) {
    const results = [];
    if (!text || typeof text !== 'string') return results;
    // Regex to match ```json ... ``` or ``` ... ```
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        let code = match[1].trim();
        // Try to unescape if needed (handles double-escaped quotes)
        try {
            // Try as-is
            let obj = JSON.parse(code);
            if (obj && obj.jsonrpc === '2.0' && typeof obj.method === 'string') {
                results.push(obj);
                continue;
            }
        } catch (e) {}
        try {
            // Try unescaping quotes (for escaped JSON in markdown)
            let unescaped = code.replace(/\\"/g, '"');
            let obj = JSON.parse(unescaped);
            if (obj && obj.jsonrpc === '2.0' && typeof obj.method === 'string') {
                results.push(obj);
            }
        } catch (e) {}
    }
    return results;
}

// --- Tool Call Dispatch Helper ---
async function maybeCallExtractedTool(toolCall, engramId) {
    // Circuit breaker: prevent rapid-fire loops
    if (shouldBreakCircuit(engramId)) {
        logger.warn('Skipped a tool call from tool output: more than 3 in 10 seconds', { detail: { engramId } });
        broadcastToClients({
            type: 'tool_result',
            error: 'Circuit breaker: too many tool calls in a short period',
            engramId,
            source: 'extracted'
        });
        return;
    }
    if (toolCall && toolCall.method && toolCall.jsonrpc === '2.0') {
        // Find the tool and server
        const found = findToolAndServerByMethod(toolCall.method);
        if (!found) {
            logger.error(`Tool output asked for ${toolCall.method}, which no connected server offers`);
            broadcastToClients({
                type: 'tool_result',
                error: `Tool not found: ${toolCall.method}`,
                engramId,
                source: 'extracted'
            });
            return;
        }
        const { serverUrl, tool } = found;
        // Extract args from toolCall.params
        const args = toolCall.params || {};
        const tapConfig = { ...buildTapConfigForTool(serverUrl, tool), args };

        try {
            logger.info(`Tool output asked for ${tool.name}; calling it`, { server: serverUrl });
            await handleToolCall({
                source: 'extracted',
                tapConfig,
                message: { ...toolCall, engramId },
                event: null,
                engramMessages: null,
                memory: null
            });
        } catch (err) {
            logger.error(`Couldn't run the tool call from tool output: ${err.message}`, { server: serverUrl, detail: { toolCall } });
            broadcastToClients({
                type: 'tool_result',
                error: err.message,
                engramId,
                source: 'extracted'
            });
        }
    } else {
        logger.error('extracted_tool_call carried no JSON-RPC tool call', { detail: { toolCall } });
    }
}

// --- Unified Tool Call Handler ---
/**
 * Handles all tool calls, routing results to the correct output.
 * @param {Object} opts - Options for the tool call.
 * @param {'tap'|'console'} opts.source - Source of the tool call.
 * @param {Object} opts.tapConfig - Tap config (if any).
 * @param {Object} opts.message - The original message triggering the call.
 * @param {Object} opts.event - The event (for client routing).
 * @param {Array} [opts.engramMessages] - Engram history (if any).
 * @param {Array} [opts.memory] - Memory/imprints (if any).
 */
async function handleToolCall({ source, tapConfig, message, event, engramMessages, memory }) {
    // Use only tapConfig for all tool call parameters
    const toolArgs = { ...(tapConfig.args || {}) };
    const connectedStringArg = tapConfig.connectedStringArg;
    const connectedArrayArg = tapConfig.connectedArrayArg;
    if ((connectedStringArg || connectedArrayArg) && message.engramId) {
        if (!engramMessages) {
            const loaded = await handleOp('load', message.engramId, null) || {};
            engramMessages = loaded.messages || [];
        }

        // Hardened memory injection
        if (Array.isArray(memory) && memory.length > 0) {
            // Insert all imprints except the first (bootrom) as memory messages
            for (const imprint of memory.slice(1)) {
                if (imprint && typeof imprint.text === 'string' && imprint.text.trim()) {
                    engramMessages.unshift({ text: imprint.text, role: 'memory', timestamp: Date.now() });
                }
            }

            // insert a json encoded servers list
            engramMessages.unshift({ text: JSON.stringify(mcpServersIndex), role: 'memory', timestamp: Date.now() });


            // Insert bootrom if it exists and has text
            const bootrom = memory[0];
            if (bootrom && typeof bootrom.text === 'string' && bootrom.text.trim()) {
                engramMessages.unshift({ text: bootrom.text, role: 'memory', timestamp: Date.now() });
            }
        }

        if (engramMessages.length === 1) {
            if (connectedStringArg) toolArgs[connectedStringArg] = engramMessages[0].text;
            if (connectedArrayArg) toolArgs[connectedArrayArg] = [];
        } else if (engramMessages.length > 1) {
            if (connectedStringArg) {
                let template = toolArgs[connectedStringArg];
                const latestMsg = engramMessages[engramMessages.length - 1].text;
                if (typeof template === 'string' && template.includes('{{cbus_message}}')) {
                    toolArgs[connectedStringArg] = template.replace(/{{cbus_message}}/g, latestMsg);
                } else if (typeof template === 'string' && template.length > 0) {
                    toolArgs[connectedStringArg] = template;
                } else {
                    toolArgs[connectedStringArg] = latestMsg;
                }
            }
            if (connectedArrayArg) toolArgs[connectedArrayArg] = engramMessages.slice(0, -1).map(msg => msg.text);
        }
    }
    const server = tapConfig.serverUrl;
    const tool = tapConfig.toolName;
    logger.debug(`Calling ${tool}`, { server, detail: { from: CALL_ORIGINS[source] || source, arguments: Object.keys(toolArgs) } });
    const started = performance.now();
    let result;
    try {
        // Only calls the page asked for directly may bring a token; calls started from chat or
        // from tool output use the one the page registered for the server.
        result = await withAuth(server, source === 'console' ? message : {}, {}, options =>
            wasmInstance.call_tool(server, tool, JSON.stringify(toolArgs), options)
        );
    } catch (err) {
        const error = mcpError(err);
        logger.error(`${tool} failed after ${formatDuration(performance.now() - started)}: ${error.message}`, { server, detail: errorDetail(error) });
        const errorMsg = {
            type: 'tool_result',
            error: error.message,
            errorKind: error.kind,
            source,
            engramId: message.engramId || null,
            requestId: message.requestId || null
        };
        if (message.engramId && message.requestId) {
            sendToEngramClient(message.engramId, errorMsg);
        } else if (event?.source) {
            event.source.postMessage(errorMsg);
        } else {
            broadcastToClients(errorMsg);
        }
        return;
    }
    let parsedResult;
    try {
        parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
    } catch (e) {
        parsedResult = { text: '[Tool returned invalid JSON]' };
    }
    let toolText = extractToolResponseText(parsedResult);
    const took = formatDuration(performance.now() - started);
    if (parsedResult?.resultType === 'input_required') {
        logger.warn(`${tool} asked for more input after ${took} (input_required), which this client can't provide yet`, { server });
    } else if (parsedResult?.isError) {
        logger.warn(`${tool} reported an error after ${took}: ${toolText.slice(0, 200)}`, { server });
    } else {
        logger.info(`${tool} returned in ${took}`, { server });
    }
    // For tap/auto, also create a cbus_message and persist
    if (source === 'tap' || source === 'extracted') {
        const toolMsg = {
            text: toolText,
            role: 'tool',
            timestamp: Date.now(),
            engramId: message.engramId || null
        };
        // Only send cbus_message to the correct client/engram
        if (message.engramId && message.requestId) {
            sendToEngramClient(message.engramId, { type: 'cbus_message', message: toolMsg });
        } else if (event?.source) {
            event.source.postMessage({ type: 'cbus_message', message: toolMsg });
        } else {
            broadcastToClients({ type: 'cbus_message', message: toolMsg });
        }
        await persistEngramMessage(toolMsg);
    }
    // Route tool_result strictly
    const resultMsg = {
        type: 'tool_result',
        result: parsedResult,
        source,
        engramId: message.engramId || null,
        requestId: message.requestId || null
    };
    if (message.engramId && message.requestId) {
        sendToEngramClient(message.engramId, resultMsg);
    } else if (event?.source) {
        event.source.postMessage(resultMsg);
    } else {
        broadcastToClients(resultMsg);
    }

    // --- Extract and dispatch tool calls from tool output ---
    let extractedCalls = extractJsonRpcCalls(toolText);
    if (Array.isArray(extractedCalls) && extractedCalls.length > 0) {
        for (const call of extractedCalls) {
            await maybeCallExtractedTool(call, message.engramId || null);
        }
    }
}

// --- Tool/Server Lookup Helper ---
function findToolAndServerByMethod(method) {
    for (const [url, server] of Object.entries(mcpServersIndex)) {
        if (server.tools && Array.isArray(server.tools)) {
            const tool = server.tools.find(t => t.name === method);
            if (tool) {
                return { serverUrl: url, tool };
            }
        }
    }
    return null;
}

// --- TapConfig Builder ---
function buildTapConfigForTool(serverUrl, tool) {
    return {
        serverUrl,
        toolName: tool.name,
        // Optionally: add connectedStringArg, connectedArrayArg, etc.
    };
}
