// MCP over Streamable HTTP, with the SDK's Client doing the protocol: era negotiation and the
// 2025 fallback, the _meta envelope, mirrored headers, sessions, SSE replies, pagination and the
// tool-list cache. This file keeps one Client per server URL and turns what it does into the
// errors and log lines the service worker shows.

import {
    Client,
    ProtocolError,
    SUPPORTED_PROTOCOL_VERSIONS,
    SdkError,
    SdkErrorCode,
    StreamableHTTPClientTransport,
    UnauthorizedError,
    UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/client';
import { McpError } from './errors.js';
import * as log from './log.js';
import { NETWORK_FAILURE, describeReply, endpointFetch, shorten } from './trace.js';

const CLIENT_INFO = { name: 'mcp-browser-client', version: __CLIENT_VERSION__ };

const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_LIST_PAGES = 100;

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

// What one server's traffic showed: the reasons behind the SDK's choices, which it doesn't
// report, and the challenge on a 401, which its UnauthorizedError doesn't carry.
class Wire {
    constructor(server) {
        this.server = server;
        this.counts = new Map();
        this.probe = null;
        this.blockedProbe = null;
        this.sentInitialize = false;
        this.challenge = null;
    }

    sent(method) {
        return this.counts.get(method) ?? 0;
    }

    sending(message) {
        const method = message?.method;
        if (typeof method !== 'string') return;
        this.counts.set(method, this.sent(method) + 1);
        if (method === 'server/discover') {
            const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
            if (this.probe?.reply?.message?.error?.code === UNSUPPORTED_PROTOCOL_VERSION && this.probe.version !== version) {
                log.info(this.server, `The server doesn't accept MCP ${this.probe.version}; retrying with ${version}`);
            }
            this.probe = { version };
        } else if (method === 'initialize') {
            this.sentInitialize = true;
            if (this.probe?.blocked) {
                log.info(this.server, 'server/discover got no reply the browser could read, which is also what happens when CORS rejects the 2026-07-28 headers; trying the 2025 initialize handshake');
            } else if (this.probe?.reply) {
                log.info(this.server, `server/discover got ${describeReply(this.probe.reply)}, so this looks like a 2025-era server; falling back to the initialize handshake`);
            }
            this.probe = null;
        }
    }

    replied(message, reply) {
        if (reply.status === 401 || reply.status === 403) this.challenge = reply.challenge || null;
        if (message?.method === 'server/discover' && this.probe) this.probe.reply = reply;
        if (message?.method === 'tools/call' && reply.message?.error?.code === HEADER_MISMATCH) {
            log.info(this.server, `The server rejected the headers for ${message.params?.name}; refreshing its tool list and retrying`);
        }
    }

    failed(message, error) {
        if (message?.method === 'server/discover' && error instanceof TypeError) {
            this.blockedProbe = error;
            if (this.probe) this.probe.blocked = true;
        }
    }
}

// The SDK leaves tools with invalid x-mcp-header declarations out of every list it fetches and
// says why only on the console, from _excludeInvalidXMcpHeaderTools. That runs synchronously, so
// the reasons are read off the console during the call, for the Workbench's hidden tools.
const EXCLUSION = /^\[mcp-sdk\] excluding tool '([^]*)' from tools\/list: invalid x-mcp-header declaration — ([^]*)$/;

class BrowserClient extends Client {
    constructor(server) {
        super(CLIENT_INFO, {
            versionNegotiation: { mode: 'auto', probe: { timeoutMs: CONNECT_TIMEOUT_MS } },
            // input_required results go to the page, which says the client can't answer them yet.
            inputRequired: { autoFulfill: false },
        });
        this.server = server;
        this.hiddenTools = [];
    }

    _excludeInvalidXMcpHeaderTools(result) {
        const listed = result.tools;
        const reasons = new Map();
        const consoleWarn = console.warn;
        console.warn = (message, ...rest) => {
            const match = EXCLUSION.exec(String(message));
            if (match) reasons.set(match[1], match[2]);
            else consoleWarn.call(console, message, ...rest);
        };
        try {
            super._excludeInvalidXMcpHeaderTools(result);
        } finally {
            console.warn = consoleWarn;
        }
        const kept = new Set(result.tools);
        this.hiddenTools = listed.filter(tool => !kept.has(tool)).map(tool => ({
            name: tool.name ?? null,
            reason: reasons.get(tool.name) ?? 'invalid x-mcp-header declaration',
        }));
        for (const { name, reason } of this.hiddenTools) log.warn(this.server, `Hiding tool ${name ?? '(unnamed)'}: ${reason}`);
    }
}

class Connection {
    constructor(url, wire, credentials, { client, transport }) {
        Object.assign(this, { url, wire, credentials, client, transport });
        this.busy = 0;
        this.retired = false;
    }

    get era() {
        return this.client.getProtocolEra();
    }

    // Closing aborts requests in flight, so a connection still in use closes once they're done.
    retire() {
        this.retired = true;
        if (!this.busy) this.close();
    }

    close() {
        this.client.close().catch(() => {});
    }

    info() {
        return {
            url: this.url,
            era: this.era,
            protocolVersion: this.client.getNegotiatedProtocolVersion() ?? null,
            serverInfo: this.client.getServerVersion() ?? this.client.getDiscoverResult()?._meta?.['io.modelcontextprotocol/serverInfo'] ?? null,
            capabilities: this.client.getServerCapabilities() ?? {},
            instructions: this.client.getInstructions() ?? null,
        };
    }
}

const connections = new Map();
const establishing = new Map();

async function attach(url, wire, credentials, prior) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        fetch: endpointFetch(wire),
        // Read before every request, so a refreshed or newly set token is used at once.
        authProvider: { token: async () => credentials.token || undefined },
    });
    const client = new BrowserClient(url);
    client.onerror = error => log.debug(url, `The SDK reported: ${error?.message || error}`);
    try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, ...(prior ? { prior } : {}) });
    } catch (error) {
        await client.close().catch(() => {});
        throw error;
    }
    return new Connection(url, wire, credentials, { client, transport });
}

// Connects in whichever era the server speaks.
async function establish(url, token) {
    const wire = new Wire(url);
    const credentials = { token };
    let connection;
    try {
        connection = await attach(url, wire, credentials);
    } catch (error) {
        if (!wire.blockedProbe) throw explain(error, url, wire);
        const probeFailure = unreachable(url, wire.blockedProbe);
        if (wire.sentInitialize) throw afterBlockedProbe(url, probeFailure, explain(error, url, wire));
        // The SDK falls back on its own only where `window` and `document` exist, so in a service
        // worker it reports the blocked probe as a failed connection.
        log.debug(url, 'The SDK gave up after the blocked server/discover (it only falls back to initialize in pages, not workers); connecting again with prior: legacy');
        try {
            connection = await attach(url, wire, credentials, { kind: 'legacy' });
        } catch (handshakeError) {
            throw afterBlockedProbe(url, probeFailure, explain(handshakeError, url, wire));
        }
    }
    if (connection.era === 'legacy') {
        const sessions = connection.transport.sessionId ? 'opened a session' : "doesn't use sessions";
        log.debug(url, `The server chose MCP ${connection.client.getNegotiatedProtocolVersion()} and ${sessions}`);
    }
    return connection;
}

// The connection for `url`, made if there isn't one. After the browser restarts the service
// worker there are none, so the first request reconnects on its own.
async function connectionFor(url, token) {
    let connection = connections.get(url);
    if (!connection) {
        if (!establishing.has(url)) {
            const made = establish(url, token)
                .then(connection => {
                    connections.set(url, connection);
                    return connection;
                })
                .finally(() => establishing.delete(url));
            establishing.set(url, made);
        }
        connection = await establishing.get(url);
    }
    connection.credentials.token = token;
    return connection;
}

// Runs `operation` on the server's connection. An expired legacy session (HTTP 404) or a modern
// server that stopped accepting the negotiated version gets one reconnect and retry.
async function withConnection(url, opts, timeoutMs, operation) {
    for (let attempt = 0; ; attempt++) {
        const connection = await connectionFor(url, opts.bearerToken);
        connection.busy++;
        try {
            return await operation(connection);
        } catch (error) {
            const failure = withSessionHint(explain(error, url, connection.wire, timeoutMs), connection);
            if (attempt > 0 || !needsReconnect(connection, failure)) throw failure;
            log.info(url, `Reconnecting: ${failure.message}`);
            forget(url);
        } finally {
            connection.busy--;
            if (connection.retired && !connection.busy) connection.close();
        }
    }
}

function needsReconnect(connection, failure) {
    if (connection.era === 'legacy') return !!connection.transport.sessionId && failure.status === 404;
    return failure.code === UNSUPPORTED_PROTOCOL_VERSION;
}

// Returns {url, era, protocolVersion, serverInfo, capabilities, instructions}.
export async function connect(url, opts) {
    const connection = await establish(url, opts.bearerToken);
    const previous = connections.get(url);
    connections.set(url, connection);
    if (previous && previous !== connection) previous.retire();
    return connection.info();
}

// Returns {tools, rejected, ttlMs, cacheScope, fromCache}. The SDK serves a list whose ttlMs
// hasn't run out from its cache; `refresh` skips it.
export function listTools(url, opts) {
    return withConnection(url, opts, LIST_TIMEOUT_MS, async connection => {
        const before = connection.wire.sent('tools/list');
        const listing = await connection.client.listTools(undefined, { cacheMode: opts.refresh ? 'refresh' : 'use', timeout: LIST_TIMEOUT_MS });
        return {
            tools: listing.tools,
            rejected: connection.client.hiddenTools,
            ttlMs: typeof listing.ttlMs === 'number' ? listing.ttlMs : null,
            cacheScope: listing.cacheScope ?? null,
            fromCache: connection.wire.sent('tools/list') === before,
        };
    });
}

export function callTool(url, name, args, opts) {
    return withConnection(url, opts, CALL_TIMEOUT_MS, connection =>
        connection.client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS, allowInputRequired: true }));
}

// Resources and prompts are fetched fresh every time, as the Rust client does.
const FRESH_LIST = { cacheMode: 'refresh', timeout: LIST_TIMEOUT_MS };

// Every page of a list, following nextCursor.
async function everyPage(url, method, key, listPage) {
    const items = [];
    let cursor;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await listPage(cursor ? { cursor } : undefined);
        items.push(...(result[key] || []));
        cursor = result.nextCursor || undefined;
        if (!cursor) return items;
    }
    log.warn(url, `Stopped after ${MAX_LIST_PAGES} pages of ${method}`);
    return items;
}

// Returns {resources}.
export function listResources(url, opts) {
    return withConnection(url, opts, LIST_TIMEOUT_MS, async connection => ({
        resources: await everyPage(url, 'resources/list', 'resources', params => connection.client.listResources(params, FRESH_LIST)),
    }));
}

// Returns {resourceTemplates}.
export function listResourceTemplates(url, opts) {
    return withConnection(url, opts, LIST_TIMEOUT_MS, async connection => ({
        resourceTemplates: await everyPage(url, 'resources/templates/list', 'resourceTemplates', params => connection.client.listResourceTemplates(params, FRESH_LIST)),
    }));
}

// Returns the result, {contents}.
export function readResource(url, uri, opts) {
    return withConnection(url, opts, CALL_TIMEOUT_MS, connection =>
        connection.client.readResource({ uri }, { cacheMode: 'refresh', timeout: CALL_TIMEOUT_MS }));
}

// Returns {prompts}.
export function listPrompts(url, opts) {
    return withConnection(url, opts, LIST_TIMEOUT_MS, async connection => ({
        prompts: await everyPage(url, 'prompts/list', 'prompts', params => connection.client.listPrompts(params, FRESH_LIST)),
    }));
}

// Returns the result, {description?, messages}.
export function getPrompt(url, name, args, opts) {
    return withConnection(url, opts, CALL_TIMEOUT_MS, connection =>
        connection.client.getPrompt({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS }));
}

export function forget(url) {
    const connection = connections.get(url);
    connections.delete(url);
    connection?.retire();
}

export function forgetAll() {
    for (const url of [...connections.keys()]) forget(url);
}

function unreachable(url, error) {
    return new McpError(
        'network',
        `Couldn't reach ${url}. The server may be down, or the browser blocked the request: the server must allow this site through CORS, and localhost servers need the browser's local network permission. (${error?.message || error})`,
    );
}

// Which error explains a failed connection when both the probe and the handshake failed.
function afterBlockedProbe(url, probeFailure, handshakeFailure) {
    if (handshakeFailure.kind === 'network') return probeFailure;
    // Reachable, and it wants 2026-07-28: the headers are what the browser blocked.
    if (handshakeFailure.kind === 'unsupported_version') {
        return new McpError(
            'network',
            `${url} answered the 2025 handshake by asking for MCP 2026-07-28, but the browser blocked the 2026-07-28 request. The server's CORS policy must allow the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers (and Mcp-Param-* headers for tools that use them).`,
        );
    }
    return handshakeFailure;
}

function signInNeeded(wire) {
    return new McpError('auth_required', "The server needs you to sign in (HTTP 401). Choose Sign in, or set a static token in the server's details if it uses one.", {
        status: 401,
        // Sign-in uses the challenge's resource_metadata and scope when the browser can read it.
        data: wire.challenge ? { wwwAuthenticate: wire.challenge } : undefined,
    });
}

function fromRpc({ code, message, data }, status) {
    const kind = code === UNSUPPORTED_PROTOCOL_VERSION ? 'unsupported_version' : 'protocol';
    return new McpError(kind, message || `The server returned JSON-RPC error ${code}.`, { status, code, data });
}

function rpcErrorIn(text) {
    try {
        const error = JSON.parse(text)?.error;
        if (error && typeof error === 'object' && typeof error.code === 'number') {
            return { code: error.code, message: typeof error.message === 'string' ? error.message : '', data: error.data };
        }
    } catch {
        // Not JSON.
    }
    return null;
}

function httpFailure(status, text, wire) {
    if (status === 401) return signInNeeded(wire);
    const rpc = rpcErrorIn(text);
    if (rpc) return fromRpc(rpc, status);
    const ok = status >= 200 && status < 300;
    let message;
    if (status === 403) message = "The server refused the request (HTTP 403). It may not allow requests from this site's origin.";
    else if (status === 404) message = 'No MCP endpoint at this URL (HTTP 404). Check the address; MCP endpoints often end in /mcp.';
    else if (status === 405) message = "This URL doesn't accept MCP requests (HTTP 405). Check the address; MCP endpoints often end in /mcp.";
    else if (ok) message = "The server's reply wasn't a JSON-RPC response.";
    else message = `The server returned HTTP ${status}.`;
    const excerpt = typeof text === 'string' && text.trim() ? shorten(text.trim(), 300) : null;
    if (excerpt && !ok) message += ` Response: ${excerpt}`;
    const data = status === 403 && wire.challenge ? { wwwAuthenticate: wire.challenge } : undefined;
    return new McpError(ok ? 'invalid_response' : 'http', message, { status, data });
}

// CORS hides Mcp-Session-Id from the browser unless the server exposes it, and a legacy server
// then rejects every request after initialize.
function withSessionHint(failure, connection) {
    if (connection.era === 'legacy' && !connection.transport.sessionId && failure.status === 400) {
        failure.message += ' If this server uses sessions, it must expose the Mcp-Session-Id header to browsers (Access-Control-Expose-Headers).';
    }
    return failure;
}

function causes(error) {
    const chain = [];
    for (let current = error; current && chain.length < 6 && !chain.includes(current); current = current.cause ?? current.data?.cause) {
        chain.push(current);
    }
    return chain;
}

// Turns what the SDK threw into an error the page can explain.
function explain(error, url, wire, timeoutMs = CONNECT_TIMEOUT_MS) {
    if (error instanceof McpError) return error;
    const offline = causes(error).find(cause => cause?.[NETWORK_FAILURE]);
    if (offline) return unreachable(url, offline);
    if (error instanceof UnauthorizedError) return signInNeeded(wire);
    if (error instanceof UnsupportedProtocolVersionError) {
        const supported = error.data?.supported ?? [];
        return new McpError(
            'unsupported_version',
            `The server supports protocol versions ${supported.length ? supported.join(', ') : '(none listed)'}, and this client supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
            { code: UNSUPPORTED_PROTOCOL_VERSION, data: error.data },
        );
    }
    if (error instanceof ProtocolError) return fromRpc({ code: error.code, message: error.message, data: error.data });
    if (error instanceof SdkError) {
        const data = error.data && typeof error.data === 'object' ? error.data : {};
        if (error.code === SdkErrorCode.RequestTimeout) {
            return new McpError('timeout', `${url} didn't answer within ${Math.round((data.timeout ?? timeoutMs) / 1000)} seconds.`);
        }
        if (typeof data.status === 'number') return httpFailure(data.status, data.text, wire);
        const cause = error.cause ?? data.cause;
        if (cause && cause !== error) {
            const explained = explain(cause, url, wire, timeoutMs);
            if (explained.kind !== 'internal') return explained;
        }
        if (error.code === SdkErrorCode.UnsupportedResultType) {
            return new McpError('invalid_response', `The server returned an unknown resultType ${JSON.stringify(data.resultType ?? null)}.`);
        }
        if (error.code === SdkErrorCode.InvalidResult || error.code === SdkErrorCode.ClientHttpUnexpectedContent) {
            return new McpError('invalid_response', `The server's reply isn't a valid MCP response: ${error.message}`);
        }
        return new McpError('protocol', error.message);
    }
    if (error instanceof SyntaxError) return new McpError('invalid_response', "The server's reply wasn't a JSON-RPC response.");
    return new McpError('internal', error?.message || String(error));
}
