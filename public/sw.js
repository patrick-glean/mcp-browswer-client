let mcpClient = null;
let isRunning = true;

import * as authStore from './authStore.js';
import { MCP_CLIENTS } from './mcp-clients.js';
import { formatDuration, logger, setLogSink } from './logger.js';
import { canonicalJson, compareKeyFor, comparedValue, sha256, stored } from './workbench/runs.js';
import { addRun, latestRun } from './workbench/store.js';
import {
    checkClient,
    ensureClient,
    loadClient,
    reloadClient,
    setClient,
    unloadClient,
    stopUptimeCounter,
    getClient,
    setBroadcast as setClientBroadcast
} from './client-runtime.js';

setClientBroadcast(broadcastToClients);
setLogSink(entry => broadcastToClients({ type: 'log', content: entry }));

self.addEventListener('error', event => {
    logger.error(`Uncaught error in the service worker: ${event.message}`, { detail: { file: event.filename, line: event.lineno } });
});
self.addEventListener('unhandledrejection', event => {
    logger.error(`Unhandled promise rejection in the service worker: ${event.reason?.message || event.reason}`);
});


async function initialClientBroadcast() {
    const state = await checkClient();
    broadcastClientStatus(state);
}


// Tells every page whether the MCP client library is loaded and healthy.
function broadcastClientStatus(state) {

    const statusMessage = {
        jsonrpc: '2.0',
        method: 'client_status',
        params: {
            status: {
                healthy: state.healthy,
                uptime: state.uptime || 0
            },
            metadata: {
                timestamp: new Date().toISOString(),
                metadataVersion: state.metadata || 'unknown',
                buildInfo: state.buildInfo || 'unknown'
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

// A static token, which the page sends with each message for the server it's for.
const staticToken = (message = {}) => message.bearerToken;

// Options for the MCP client. A static token wins; otherwise the server's OAuth token.
async function mcpOptions(url, message = {}, extra = {}) {
    const bearerToken = staticToken(message) || await oauthAccessToken(url);
    return JSON.stringify({ ...(bearerToken ? { bearerToken } : {}), ...extra });
}

// Runs an MCP call with the server's credentials. When the server turns down an OAuth token,
// it's refreshed once and the call retried.
async function withAuth(url, message, extra, call) {
    try {
        return await call(await mcpOptions(url, message, extra));
    } catch (error) {
        if (mcpError(error).kind !== 'auth_required' || staticToken(message)) throw error;
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
        const fresh = JSON.parse(await mcpClient.auth_refresh(JSON.stringify(tokens)));
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

// MCP client calls reject with a JSON McpError: {kind, message, status?, code?, data?}.
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
    const what = { list_tools: 'Listing tools', list_resources: 'Listing resources', list_prompts: 'Listing prompts' }[action] || 'Connecting';
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

// Where a tool call came from, as the trace describes it. The sources are the runs' (see recordRun).
// Pages make every call: the Workbench's, and those of the apps you build, which run in the page,
// including the tool calls a model writes in its answer to an app.
const CALL_ORIGINS = { workbench: 'the page', app: 'an app', reply: "a tool call in a model's answer, from an app" };

const METHOD_NOT_FOUND = -32601;
const counted = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`;

function listNames(names, max = 8) {
    if (names.length <= max) return names.join(', ');
    return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

// What a page message is about, for the trace. Payloads stay out of the log: they can be large
// or carry bearer tokens.
function describeMessage({ url, refresh, call }) {
    const detail = {};
    if (url) detail.url = url;
    if (call?.serverUrl) detail.server = call.serverUrl;
    if (call?.toolName) detail.tool = call.toolName;
    if (refresh) detail.refresh = true;
    return Object.keys(detail).length ? detail : undefined;
}

// Handle messages from clients. waitUntil keeps the worker alive until the handler finishes,
// so a long MCP call isn't cut off when the browser would otherwise stop an idle worker.
self.addEventListener('message', (event) => {
    event.waitUntil(handleClientMessage(event));
});

async function handleClientMessage(event) {
    const message = event.data;
    logger.debug(`Page sent ${message.type}`, { detail: describeMessage(message) });

    const managesClientLifecycle = ['unload_client', 'reload_client', 'stop', 'set_client'].includes(message.type);
    mcpClient = managesClientLifecycle ? getClient() : await ensureClient();

    switch (message.type) {
        case 'check_client':
            broadcastClientStatus(await checkClient());
            break;
        // 'initialize-mcp' is the pre-2026 name for connecting; there's no handshake anymore
        // unless the server turns out to be a legacy one.
        case 'connect-mcp':
        case 'initialize-mcp': {
            const url = message.url;
            if (!mcpClient) {
                broadcastMcpError(url, 'connect', { kind: 'internal', message: 'The MCP client is not loaded.' });
                break;
            }
            logger.info('Connecting', { server: url });
            const started = performance.now();
            try {
                const info = JSON.parse(await withAuth(url, message, {}, options => mcpClient.connect(url, options)));
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
                mcpClient?.forget_server(message.url);
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
                const begin = JSON.parse(await mcpClient.auth_begin(url, JSON.stringify(options)));
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
                const tokens = JSON.parse(await mcpClient.auth_finish(JSON.stringify(pending), JSON.stringify(params)));
                await authStore.putTokens(tokens);
                // A connection made before signing in shouldn't outlive it.
                mcpClient.forget_server(url);
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
            mcpClient?.forget_server(url);
            logger.info(message.forgetClient && tokens ? `Signed out, and forgot this client's registration with ${tokens.issuer}` : 'Signed out', { server: url });
            broadcastToClients({ type: 'auth_status', url, status: authStatus(null) });
            break;
        }
        // Which MCP client library to run, a name from mcp-clients.js. Connections don't carry
        // over; the next request to each server connects again.
        case 'set_client': {
            let loaded = false;
            try {
                loaded = await setClient(message.client);
            } catch (error) {
                logger.error(error.message);
            }
            mcpClient = getClient();
            event.source?.postMessage({ type: 'client_set', client: message.client, loaded });
            if (!loaded) broadcastToClients({ type: 'client_status', healthy: false });
            break;
        }
        case 'unload_client':
            unloadClient();
            break;
        case 'reload_client':
            await reloadClient();
            break;
        case 'stop':
            logger.info('Stopping the service worker');
            isRunning = false;
            stopUptimeCounter();
            unloadClient();
            break;
        case 'list_tools': {
            const url = message.url;
            if (!mcpClient) {
                broadcastMcpError(url, 'list_tools', { kind: 'internal', message: 'The MCP client is not loaded.' });
                break;
            }
            const started = performance.now();
            try {
                const listing = JSON.parse(await withAuth(url, message, { refresh: !!message.refresh }, options => mcpClient.list_tools(url, options)));
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
        case 'list_resources': {
            const url = message.url;
            if (!mcpClient) {
                broadcastMcpError(url, 'list_resources', { kind: 'internal', message: 'The MCP client is not loaded.' });
                break;
            }
            const started = performance.now();
            try {
                const { resources = [] } = JSON.parse(await withAuth(url, message, {}, options => mcpClient.list_resources(url, options)));
                let resourceTemplates = [];
                try {
                    ({ resourceTemplates = [] } = JSON.parse(await withAuth(url, message, {}, options => mcpClient.list_resource_templates(url, options))));
                } catch (error) {
                    // Servers without templates may not have the method at all.
                    const failure = mcpError(error);
                    if (failure.code !== METHOD_NOT_FOUND) logger.warn(`Couldn't list resource templates: ${failure.message}`, { server: url, detail: errorDetail(failure) });
                }
                broadcastToClients({ type: 'resources_list', url, resources, resourceTemplates });
                const templates = resourceTemplates.length ? ` and ${counted(resourceTemplates.length, 'template')}` : '';
                logger.info(`Listed ${counted(resources.length, 'resource')}${templates} in ${formatDuration(performance.now() - started)}`, { server: url });
            } catch (error) {
                broadcastMcpError(url, 'list_resources', mcpError(error), started);
            }
            break;
        }
        case 'list_prompts': {
            const url = message.url;
            if (!mcpClient) {
                broadcastMcpError(url, 'list_prompts', { kind: 'internal', message: 'The MCP client is not loaded.' });
                break;
            }
            const started = performance.now();
            try {
                const { prompts = [] } = JSON.parse(await withAuth(url, message, {}, options => mcpClient.list_prompts(url, options)));
                broadcastToClients({ type: 'prompts_list', url, prompts });
                const names = prompts.map(prompt => prompt.name);
                logger.info(`Listed ${counted(names.length, 'prompt')} in ${formatDuration(performance.now() - started)}${names.length ? `: ${listNames(names)}` : ''}`, { server: url });
            } catch (error) {
                broadcastMcpError(url, 'list_prompts', mcpError(error), started);
            }
            break;
        }
        // A resource read or a prompt get the page asked for, answered to that page only. They
        // aren't tool calls, so they don't go into the run history.
        case 'read_resource':
        case 'get_prompt': {
            const { url, requestId } = message;
            const reading = message.type === 'read_resource';
            const what = reading ? message.uri : message.name;
            const reply = fields => event.source?.postMessage({ type: reading ? 'resource_read' : 'prompt_got', url, requestId, ...fields });
            if (!mcpClient) {
                reply({ error: { kind: 'internal', message: 'The MCP client is not loaded.' } });
                break;
            }
            const started = performance.now();
            try {
                const result = JSON.parse(await withAuth(url, message, {}, options => (reading
                    ? mcpClient.read_resource(url, message.uri, options)
                    : mcpClient.get_prompt(url, message.name, JSON.stringify(message.args || {}), options))));
                const durationMs = performance.now() - started;
                const size = reading ? counted(result.contents?.length ?? 0, 'item') : counted(result.messages?.length ?? 0, 'message');
                logger.info(`${reading ? 'Read' : 'Got the prompt'} ${what} in ${formatDuration(durationMs)}: ${size}`, { server: url });
                reply({ result, durationMs });
            } catch (error) {
                const failure = mcpError(error);
                const durationMs = performance.now() - started;
                logger.error(`Couldn't ${reading ? 'read' : 'get the prompt'} ${what}: ${failure.message}`, { server: url, detail: errorDetail(failure) });
                reply({ error: failure, durationMs });
            }
            break;
        }
        case 'call_tool': {
            const source = Object.hasOwn(CALL_ORIGINS, message.source) ? message.source : 'workbench';
            if (!mcpClient) {
                // Not a call, so not in history, but the page waits on this run id.
                event.source?.postMessage({
                    type: 'tool_result',
                    error: 'The MCP client is not loaded',
                    run: message.run?.id ? { id: message.run.id, outcome: 'failed', changed: null } : null,
                    source
                });
                break;
            }
            await handleToolCall({ source, call: message.call, message, event });
            break;
        }
        default:
            logger.warn(`Ignored a message of unknown type ${message.type}`);
    }
}

// Initialize on install. A new version takes over as soon as it's installed instead of waiting
// for every tab to close.
self.addEventListener('install', event => {
    const builds = Object.values(MCP_CLIENTS).map(client => `${client.label} ${client.build.slice(0, 12)}`).join(', ');
    logger.info(`Installing the service worker with the MCP client library builds ${builds}`);
    self.skipWaiting();
    event.waitUntil(loadClient());
});

// The conversations the Chat app kept, before the Chat example replaced it: apps keep theirs on
// their screens.
const OLD_CHAT_DATABASE = 'chat_contexts';

function deleteOldChatDatabase() {
    return new Promise(resolve => {
        const request = indexedDB.deleteDatabase(OLD_CHAT_DATABASE);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
}

// Handle activation
self.addEventListener('activate', event => {
    logger.debug('Activating');
    event.waitUntil(clients.claim());
    event.waitUntil(initialClientBroadcast());
    event.waitUntil(deleteOldChatDatabase());
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

// Every tool call goes through here, whichever part of the page asked for it (`source`: workbench,
// app or reply). `call` is {serverUrl, toolName, args}.
async function handleToolCall({ source, call, message, event }) {
    const toolArgs = { ...(call.args || {}) };
    const server = call.serverUrl;
    const tool = call.toolName;
    logger.debug(`Calling ${tool}`, { server, detail: { from: CALL_ORIGINS[source] || source, arguments: Object.keys(toolArgs) } });
    const startedAt = Date.now();
    const started = performance.now();
    const attempt = { source, message, serverUrl: server, toolName: tool, toolArgs, startedAt };
    const reply = update => (event?.source ? event.source.postMessage(update) : broadcastToClients(update));
    let result;
    try {
        result = await withAuth(server, message, {}, options =>
            mcpClient.call_tool(server, tool, JSON.stringify(toolArgs), options)
        );
    } catch (err) {
        const error = mcpError(err);
        logger.error(`${tool} failed after ${formatDuration(performance.now() - started)}: ${error.message}`, { server, detail: errorDetail(error) });
        const run = await recordRun(attempt, { outcome: 'failed', error, durationMs: performance.now() - started });
        reply({
            type: 'tool_result',
            error: error.message,
            errorKind: error.kind,
            run,
            source
        });
        return;
    }
    let parsedResult;
    try {
        parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
    } catch (e) {
        parsedResult = { text: '[Tool returned invalid JSON]' };
    }
    const toolText = extractToolResponseText(parsedResult);
    const durationMs = performance.now() - started;
    const took = formatDuration(durationMs);
    if (parsedResult?.resultType === 'input_required') {
        logger.warn(`${tool} asked for more input after ${took} (input_required), which this client can't provide yet`, { server });
    } else if (parsedResult?.isError) {
        logger.warn(`${tool} reported an error after ${took}: ${toolText.slice(0, 200)}`, { server });
    } else {
        logger.info(`${tool} returned in ${took}`, { server });
    }
    const run = await recordRun(attempt, { outcome: parsedResult?.isError ? 'tool_error' : 'ok', result: parsedResult, durationMs });
    reply({
        type: 'tool_result',
        result: parsedResult,
        run,
        source
    });
}

// --- Run history: every tool call becomes a run, whichever part of the client made it ---

// Saves the call and compares its result with the last run of the same request. Pages asking for
// a call send `run` details: the arguments as written (with {{variables}}), the saved request it
// came from and the environment. History failing must never fail the call, so errors only log.
// Sources are handleToolCall's: workbench (collection for Run all), app and reply. Runs from
// before the Chat example replaced the Chat app may say chat.
async function recordRun(attempt, { outcome, result = null, error = null, durationMs }) {
    const details = attempt.message?.run || {};
    const record = {
        id: details.id || crypto.randomUUID(),
        startedAt: attempt.startedAt,
        durationMs: Math.round(durationMs),
        source: attempt.source === 'workbench' && details.collectionRunId ? 'collection' : attempt.source,
        serverUrl: attempt.serverUrl,
        toolName: attempt.toolName,
        requestId: details.requestId || null,
        collectionRunId: details.collectionRunId || null,
        environmentName: details.environmentName || null,
        outcome,
        error: error?.message || null,
        errorKind: error?.kind || null,
        ...stored('args', details.args ?? attempt.toolArgs),
        ...stored('sentArgs', attempt.toolArgs),
        ...stored('result', result),
    };
    record.truncated = !!(record.argsText || record.sentArgsText || record.resultText);
    const summary = { id: record.id, startedAt: record.startedAt, durationMs: record.durationMs, outcome, changed: null, previousRunId: null };
    try {
        record.resultHash = await sha256(canonicalJson(comparedValue({ outcome, result, error: record.error, errorKind: record.errorKind })));
        record.compareKey = await compareKeyFor({ requestId: record.requestId, serverUrl: attempt.serverUrl, toolName: attempt.toolName, sentArgs: attempt.toolArgs });
        const previous = await latestRun(record.compareKey);
        record.previousRunId = previous?.id || null;
        record.changed = previous ? previous.resultHash !== record.resultHash : null;
        await addRun(record);
        Object.assign(summary, { changed: record.changed, previousRunId: record.previousRunId });
        broadcastToClients({
            type: 'run_recorded',
            run: { ...summary, source: record.source, serverUrl: record.serverUrl, toolName: record.toolName, requestId: record.requestId, errorKind: record.errorKind }
        });
    } catch (failure) {
        logger.warn(`Couldn't save the call to ${attempt.toolName} in the run history: ${failure.message}`, { server: attempt.serverUrl });
    }
    return summary;
}
