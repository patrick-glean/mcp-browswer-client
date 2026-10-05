let mcpClient = null;
let isRunning = true;

// The Chat app's model, {serverUrl, toolName, args, messageField, conversationField}
// (set_chat_model), and the context the page added, [{id, name, text, timestamp}]
// (set_chat_context).
let chatModel = {};
let chatContext = [];

// --- MCP Servers Index ---
const mcpServersIndex = {};

// When each conversation's replies last asked for tool calls: { conversationId: [timestamps] }
const replyCallTimes = {};

import * as authStore from './authStore.js';
import { CHAT_INSTRUCTIONS } from './chat-instructions.js';
import { loadConversation, openDB, saveMessage } from './chatStorage.js';
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

// A static token, from the message or the server list the page last sent.
function staticToken(url, message = {}) {
    return message.bearerToken ?? mcpServersIndex[url]?.bearerToken;
}

// Options for the MCP client. A static token wins; otherwise the server's OAuth token.
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
const CALL_ORIGINS = { workbench: 'the page', chat: 'a chat message', reply: 'a tool call in a reply' };

const METHOD_NOT_FOUND = -32601;
const counted = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`;

function listNames(names, max = 8) {
    if (names.length <= max) return names.join(', ');
    return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

// What a page message is about, for the trace. Payloads stay out of the log: they can be large
// (the server list) or carry bearer tokens.
function describeMessage({ url, refresh, call, model }) {
    const detail = {};
    const target = call ?? model;
    if (url) detail.url = url;
    if (target?.serverUrl) detail.server = target.serverUrl;
    if (target?.toolName) detail.tool = target.toolName;
    if (refresh) detail.refresh = true;
    return Object.keys(detail).length ? detail : undefined;
}

async function saveChatMessage(message) {
    if (message.conversationId) await saveMessage(message);
}

// At most three tool calls from a conversation's replies every 10 seconds.
function shouldBreakCircuit(conversationId) {
    const now = Date.now();
    if (!conversationId) return false;
    const recent = (replyCallTimes[conversationId] ?? []).filter(time => now - time < 10000);
    replyCallTimes[conversationId] = recent;
    if (recent.length >= 3) return true;
    recent.push(now);
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
        case 'call_tool':
            if (!mcpClient) {
                // Not a call, so not in history, but the page waits on this run id.
                event.source?.postMessage({
                    type: 'tool_result',
                    error: 'The MCP client is not loaded',
                    run: message.run?.id ? { id: message.run.id, outcome: 'failed', changed: null } : null,
                    source: 'workbench'
                });
                break;
            }
            await handleToolCall({ source: 'workbench', call: message.call, message, event });
            break;
        case 'get_chat_instructions':
            event.source?.postMessage({ type: 'chat_instructions', instructions: CHAT_INSTRUCTIONS });
            break;
        case 'chat_message':
            logger.error('Pages send chat_send; chat_message only goes from the worker to pages');
            break;
        case 'chat_send':
            if (message.text) {
                const sent = {
                    text: message.text,
                    role: message.role || 'user',
                    timestamp: Date.now(),
                    conversationId: message.conversationId || null
                };
                broadcastToClients({ type: 'chat_message', message: sent });
                await saveChatMessage(sent);
                try {
                    if (chatModel.serverUrl && chatModel.toolName && (chatModel.messageField || chatModel.conversationField)) {
                        await handleToolCall({ source: 'chat', call: chatModel, message: sent });
                    }
                } catch (err) {
                    logger.error(`The chat's tool call failed: ${err.message}`, { server: chatModel.serverUrl });
                }
            } else {
                logger.debug('Ignored a chat message without text');
            }
            break;
        case 'get_chat_history': {
            const { messages } = await loadConversation(message.conversationId ?? null);
            event.source?.postMessage({ type: 'chat_history', conversationId: message.conversationId ?? null, messages });
            break;
        }
        case 'set_chat_model':
            chatModel = message.model || {};
            logger.debug('The chat now sends messages to a tool', {
                server: chatModel.serverUrl,
                detail: { tool: chatModel.toolName, messageField: chatModel.messageField, conversationField: chatModel.conversationField }
            });
            return;
        case 'set_chat_context':
            if (Array.isArray(message.context)) {
                chatContext = message.context;
                logger.debug(`The chat's context has ${chatContext.length} entr${chatContext.length === 1 ? 'y' : 'ies'}`);
            }
            break;
        case 'init_mcp_servers_index':
            if (message.servers && typeof message.servers === 'object') {
                Object.assign(mcpServersIndex, message.servers);
                logger.debug(`The page registered ${Object.keys(message.servers).length} server(s)`);
            }
            break;
        case 'reply_tool_call':
            await runReplyToolCall(message.toolCall, message.conversationId || null);
            break;
        default:
            logger.warn(`Ignored a message of unknown type ${message.type}`);
    }
}

// Chat messages go to every page; each shows the conversation it has open.
function sendChatMessage(message, event) {
    const update = { type: 'chat_message', message };
    if (event?.source) event.source.postMessage(update);
    else broadcastToClients(update);
}

// Initialize on install. A new version takes over as soon as it's installed instead of waiting
// for every tab to close.
self.addEventListener('install', event => {
    const builds = Object.values(MCP_CLIENTS).map(client => `${client.label} ${client.build.slice(0, 12)}`).join(', ');
    logger.info(`Installing the service worker with the MCP client library builds ${builds}`);
    self.skipWaiting();
    event.waitUntil(loadClient());
    event.waitUntil(openDB());
});

// Handle activation
self.addEventListener('activate', event => {
    logger.debug('Activating');
    event.waitUntil(clients.claim());
    event.waitUntil(initialClientBroadcast());
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

// A tool call a reply asked for: a JSON-RPC request whose method is a tool's name.
async function runReplyToolCall(toolCall, conversationId) {
    if (shouldBreakCircuit(conversationId)) {
        logger.warn('Skipped a tool call from a reply: more than 3 in 10 seconds', { detail: { conversationId } });
        broadcastToClients({
            type: 'tool_result',
            error: 'Circuit breaker: too many tool calls in a short period',
            conversationId,
            source: 'reply'
        });
        return;
    }
    if (toolCall && toolCall.method && toolCall.jsonrpc === '2.0') {
        const found = findToolAndServerByMethod(toolCall.method);
        if (!found) {
            logger.error(`A reply asked for ${toolCall.method}, which no connected server offers`);
            broadcastToClients({
                type: 'tool_result',
                error: `Tool not found: ${toolCall.method}`,
                conversationId,
                source: 'reply'
            });
            return;
        }
        const { serverUrl, tool } = found;
        const call = { serverUrl, toolName: tool.name, args: toolCall.params || {} };

        try {
            logger.info(`A reply asked for ${tool.name}; calling it`, { server: serverUrl });
            await handleToolCall({ source: 'reply', call, message: { ...toolCall, conversationId } });
        } catch (err) {
            logger.error(`Couldn't run the tool call from a reply: ${err.message}`, { server: serverUrl, detail: { toolCall } });
            broadcastToClients({
                type: 'tool_result',
                error: err.message,
                conversationId,
                source: 'reply'
            });
        }
    } else {
        logger.error('reply_tool_call carried no JSON-RPC tool call', { detail: { toolCall } });
    }
}

// {{message}} in a preset message field is replaced by the message ({{cbus_message}} is its old name).
const MESSAGE_PLACEHOLDER = /\{\{(?:message|cbus_message)\}\}/g;

// The chat model's arguments. Its message field gets the newest message, and its conversation field
// everything before it: how to ask for a tool call, the servers and their tools to choose from, the
// context the page added, then the conversation so far.
async function modelArguments(model, conversationId) {
    const args = { ...(model.args || {}) };
    const { messageField, conversationField } = model;
    if (!conversationId || !(messageField || conversationField)) return args;
    const { messages } = await loadConversation(conversationId);
    const context = chatContext.map(entry => entry?.text).filter(text => typeof text === 'string' && text.trim());
    const texts = [CHAT_INSTRUCTIONS, JSON.stringify(serversForModel()), ...context, ...messages.map(message => message.text)];
    const newest = texts.at(-1);
    if (messageField) {
        const preset = args[messageField];
        if (typeof preset === 'string' && preset.match(MESSAGE_PLACEHOLDER)) args[messageField] = preset.replace(MESSAGE_PLACEHOLDER, () => newest);
        else if (typeof preset !== 'string' || !preset) args[messageField] = newest;
    }
    if (conversationField) args[conversationField] = texts.slice(0, -1);
    return args;
}

// Every tool call goes through here, whichever part of the app asked for it (`source`: workbench,
// chat or reply). `call` is {serverUrl, toolName, args}; for the chat, the model with its fields.
async function handleToolCall({ source, call, message, event }) {
    const toolArgs = source === 'chat' ? await modelArguments(call, message.conversationId) : { ...(call.args || {}) };
    const server = call.serverUrl;
    const tool = call.toolName;
    logger.debug(`Calling ${tool}`, { server, detail: { from: CALL_ORIGINS[source] || source, arguments: Object.keys(toolArgs) } });
    const startedAt = Date.now();
    const started = performance.now();
    const attempt = { source, message, serverUrl: server, toolName: tool, toolArgs, startedAt };
    const reply = update => (event?.source ? event.source.postMessage(update) : broadcastToClients(update));
    let result;
    try {
        // Only calls the page asked for directly may bring a token; calls started from chat or
        // from a reply use the one the page registered for the server.
        result = await withAuth(server, source === 'workbench' ? message : {}, {}, options =>
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
            source,
            conversationId: message.conversationId || null
        });
        return;
    }
    let parsedResult;
    try {
        parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
    } catch (e) {
        parsedResult = { text: '[Tool returned invalid JSON]' };
    }
    let toolText = extractToolResponseText(parsedResult);
    const durationMs = performance.now() - started;
    const took = formatDuration(durationMs);
    if (parsedResult?.resultType === 'input_required') {
        logger.warn(`${tool} asked for more input after ${took} (input_required), which this client can't provide yet`, { server });
    } else if (parsedResult?.isError) {
        logger.warn(`${tool} reported an error after ${took}: ${toolText.slice(0, 200)}`, { server });
    } else {
        logger.info(`${tool} returned in ${took}`, { server });
    }
    // The chat's model and the tools its replies call answer in the conversation.
    if (source === 'chat' || source === 'reply') {
        const answer = { text: toolText, role: 'tool', timestamp: Date.now(), conversationId: message.conversationId || null };
        sendChatMessage(answer, event);
        await saveChatMessage(answer);
    }
    const run = await recordRun(attempt, { outcome: parsedResult?.isError ? 'tool_error' : 'ok', result: parsedResult, durationMs });
    reply({
        type: 'tool_result',
        result: parsedResult,
        run,
        source,
        conversationId: message.conversationId || null
    });

    for (const toolCall of extractJsonRpcCalls(toolText)) {
        await runReplyToolCall(toolCall, message.conversationId || null);
    }
}

// --- Run history: every tool call becomes a run, whichever part of the client made it ---

// Saves the call and compares its result with the last run of the same request. Pages asking for
// a call send `run` details: the arguments as written (with {{variables}}), the saved request it
// came from and the environment. History failing must never fail the call, so errors only log.
// Sources are handleToolCall's: workbench (collection for Run all), chat and reply.
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

// --- Tool/Server Lookup Helper ---
// The server list as the page registered it, minus static tokens: the model's tool may be on any
// server, and a token only ever goes to the server it's for.
function serversForModel() {
    return Object.fromEntries(Object.entries(mcpServersIndex).map(([url, { bearerToken, ...server }]) => [url, server]));
}

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
