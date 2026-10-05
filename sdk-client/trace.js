// The fetch() every request goes through. Each exchange is traced at debug level, as the dock's
// Trace shows it, without credentials. MCP requests are described by the JSON-RPC message they
// carry, and the connection hears about every message and reply: the SDK decides things (such as
// falling back to the 2025 handshake) without saying why.
//
// Bodies too big to log whole are never parsed here: the SDK parses them once, and the trace says
// what it can from their first and last bytes.

import * as log from './log.js';

const MAX_LOGGED_BODY = 4_000;

// Fields that carry credentials in OAuth requests and replies.
const SECRET_FIELDS = new Set([
    'code',
    'code_verifier',
    'access_token',
    'refresh_token',
    'id_token',
    'client_secret',
    'registration_access_token',
]);

// Marks the TypeError fetch() rejects with, so the failure can still be recognized once the SDK
// has wrapped it. The error itself is rethrown unchanged: the SDK reads a TypeError as CORS.
export const NETWORK_FAILURE = Symbol('network failure');

export function shorten(text, max) {
    if (text.length <= max) return text;
    // Don't cut a surrogate pair in half.
    const cut = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
    return `${text.slice(0, cut)}…`;
}

const elapsed = started => Math.round(performance.now() - started);

function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url ?? String(input);
}

function markNetworkFailure(error) {
    if (error instanceof TypeError) {
        try {
            error[NETWORK_FAILURE] = true;
        } catch {
            // A frozen error can't be marked; it's still a TypeError.
        }
    }
    return error;
}

// The message itself when it's small enough to pretty-print in the page's log, otherwise the
// start of its text.
function loggableBody(value, text) {
    return text.length <= MAX_LOGGED_BODY ? value : shorten(text, MAX_LOGGED_BODY);
}

// Request headers as the trace shows them: the bearer token never appears, and session IDs,
// which can stand in for credentials, are shortened.
function loggableHeaders(headers) {
    const shown = {};
    for (const [name, value] of new Headers(headers ?? undefined)) {
        if (name === 'authorization') shown[name] = '[redacted]';
        else if (name === 'mcp-session-id') shown[name] = shorten(value, 8);
        else shown[name] = value;
    }
    return shown;
}

// `value` with every credential field replaced, at any depth.
export function redactJson(value) {
    if (Array.isArray(value)) return value.map(redactJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) =>
            [key, SECRET_FIELDS.has(key.toLowerCase()) && item !== null ? '[redacted]' : redactJson(item)]));
    }
    return value;
}

function redactForm(params) {
    const shown = {};
    for (const [name, value] of params) shown[name] = SECRET_FIELDS.has(name.toLowerCase()) ? '[redacted]' : value;
    return shown;
}

// "tools/call echo (id 7)": the method, what it addresses and the request id.
export function describeRequest(message) {
    if (Array.isArray(message)) return `a batch of ${message.length} messages`;
    if (!message || typeof message !== 'object') return 'message';
    let text = typeof message.method === 'string' ? message.method : 'message';
    const target = message.params?.name ?? message.params?.uri;
    if (typeof target === 'string') text += ` ${target}`;
    if (typeof message.params?.cursor === 'string') text += ` from cursor ${message.params.cursor}`;
    if ('id' in message) text += ` (id ${JSON.stringify(message.id)})`;
    return text;
}

// The method, tool name and id of a request too big to parse just for the trace. The SDK writes
// the method and params first and the id last.
function peekRequest(text) {
    const head = text.slice(0, 512);
    const method = /"method"\s*:\s*"([^"\\]+)"/.exec(head)?.[1];
    const name = /"name"\s*:\s*"([^"\\]*)"/.exec(head)?.[1];
    const id = /"id"\s*:\s*(-?\d+|"[^"\\]*")\s*}\s*$/.exec(text.slice(-128))?.[1];
    const message = {};
    if (method) message.method = method;
    if (name !== undefined) message.params = { name };
    if (id !== undefined) message.id = JSON.parse(id);
    return message;
}

// "HTTP 400, JSON-RPC error -32000: Bad Request": enough to see why a reply was handled the way
// it was.
export function describeReply(reply) {
    let text = `HTTP ${reply.status}`;
    if (reply.streamed) text += ' (SSE)';
    const error = reply.message?.error;
    if (error && typeof error === 'object') {
        text += `, JSON-RPC error ${error.code ?? 0}`;
        if (error.message) text += `: ${shorten(String(error.message), 160)}`;
    } else if (reply.excerpt) {
        text += `: ${shorten(reply.excerpt, 160)}`;
    }
    return text;
}

function replyDetail(reply) {
    const detail = {};
    if (reply.sessionId) detail.sessionId = shorten(reply.sessionId, 8);
    if (reply.message) detail.body = loggableBody(reply.message, JSON.stringify(reply.message));
    else if (reply.body) detail.body = reply.body;
    else if (reply.excerpt) detail.body = reply.excerpt;
    if (reply.bytes) detail.bytes = reply.bytes;
    return Object.keys(detail).length ? detail : undefined;
}

const isEventStream = response => (response.headers.get('content-type') || '').toLowerCase().startsWith('text/event-stream');

// Error responses without an id (such as parse errors) count as the answer too.
function isResponseTo(message, id) {
    if (!message || typeof message !== 'object' || 'method' in message) return false;
    if (!('result' in message) && !('error' in message)) return false;
    return message.id === undefined || message.id === null || id === undefined || message.id === id;
}

const SERVER_LOG_LEVELS = { debug: 'debug', info: 'info', notice: 'info', warning: 'warn' };

// Requests and notifications the server sends while a reply streams in. Its log messages keep
// their level; everything else is traced. The SDK answers the requests.
function logServerMessage(server, message) {
    const method = typeof message?.method === 'string' ? message.method : '';
    const params = message?.params ?? undefined;
    if (message && 'id' in message) {
        log.debug(server, `The server sent a ${method} request`, params);
    } else if (method === 'notifications/message') {
        const level = params?.level === undefined ? 'info' : SERVER_LOG_LEVELS[params.level] ?? 'error';
        const data = params?.data === undefined ? '' : typeof params.data === 'string' ? params.data : JSON.stringify(params.data);
        const logger = typeof params?.logger === 'string' ? ` (${params.logger})` : '';
        log.emit(level, server, `Server log${logger}: ${data}`);
    } else {
        log.debug(server, `The server sent ${method}`, params);
    }
}

// Reads a request's SSE reply as it streams past on its way to the SDK, and calls onAnswer once
// with the response to the request: the message, or the start of its text when it's too big to
// log whole. Lines ending in a lone CR aren't split; the SDK parses the stream itself.
function eventStreamReader(requestId, server, onAnswer) {
    const decoder = new TextDecoder();
    let partial = '';
    let event = '';
    let data = [];
    let unmatched = null;
    let answered = false;
    const dispatch = () => {
        const payload = data.join('\n');
        const type = event || 'message';
        event = '';
        data = [];
        if (type !== 'message' || !payload.trim()) return null;
        if (payload.length > MAX_LOGGED_BODY) return shorten(payload, MAX_LOGGED_BODY);
        let parsed;
        try {
            parsed = JSON.parse(payload);
        } catch (error) {
            log.warn(server, `Ignoring an SSE event that isn't JSON: ${error.message}`);
            return null;
        }
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            if (isResponseTo(message, requestId)) return message;
            if (message && typeof message === 'object' && !('method' in message)) unmatched = message;
            else logServerMessage(server, message);
        }
        return null;
    };
    const handle = line => {
        if (line === '') return dispatch();
        if (line.startsWith(':')) return null;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        return null;
    };
    const answer = found => {
        answered = true;
        onAnswer(found);
    };
    const feed = (text, done) => {
        if (answered) return;
        let from = 0;
        for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', from)) {
            let line = partial + text.slice(from, end);
            partial = '';
            if (line.endsWith('\r')) line = line.slice(0, -1);
            from = end + 1;
            const found = handle(line);
            if (found) return answer(found);
        }
        partial += text.slice(from);
        if (done) answer((partial && handle(partial.replace(/\r$/, ''))) || dispatch() || unmatched);
    };
    return new TransformStream({
        transform(chunk, controller) {
            controller.enqueue(chunk);
            if (!answered) feed(decoder.decode(chunk, { stream: true }), false);
        },
        flush() {
            feed(decoder.decode(), true);
        },
    });
}

const blankReply = response => ({
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    challenge: response.headers.get('www-authenticate'),
    streamed: false,
    message: null,
    body: null,
    excerpt: null,
    bytes: null,
});

// What came back for one POST with an SSE reply, once the response to the request has streamed
// past: the SDK reads the response's body through eventStreamReader.
function readStreamedReply(response, message, server) {
    const reply = { ...blankReply(response), streamed: true };
    return new Promise(resolve => {
        const reader = eventStreamReader(message && !Array.isArray(message) ? message.id : undefined, server, answer => {
            if (typeof answer === 'string') reply.body = answer;
            else reply.message = answer;
            resolve(reply);
        });
        Object.defineProperty(response, 'body', { value: response.body.pipeThrough(reader) });
    });
}

// What came back for one POST with a whole body. The body is read once, here, and the response
// hands the SDK the same text (and the same parsed JSON), so nothing is read or parsed twice.
async function readWholeReply(response, message) {
    const reply = blankReply(response);
    if (response.status === 202 || response.status === 204) return reply;
    const text = await response.text();
    let parsed;
    // A big successful reply is the SDK's to parse; the trace shows its start.
    if (response.ok && text.length > MAX_LOGGED_BODY) {
        reply.body = shorten(text, MAX_LOGGED_BODY);
        reply.bytes = text.length;
    } else {
        try {
            parsed = JSON.parse(text);
            const id = message && !Array.isArray(message) ? message.id : undefined;
            reply.message = Array.isArray(parsed) ? parsed.find(item => isResponseTo(item, id)) ?? null : parsed;
        } catch {
            reply.excerpt = text.trim() ? shorten(text.trim(), 300) : null;
        }
    }
    Object.defineProperties(response, {
        text: { value: async () => text },
        json: { value: async () => (parsed === undefined ? JSON.parse(text) : parsed) },
    });
    return reply;
}

// fetch() for one MCP server's endpoint. `observer` hears about every JSON-RPC message sent
// (sending), every reply (replied) and every request that got no reply the browser could read
// (failed).
export function endpointFetch(observer) {
    const server = observer.server;
    return async (input, init = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        if (method !== 'POST') return exchange(server, input, init);
        const text = typeof init.body === 'string' ? init.body : '';
        let message;
        if (text.length > MAX_LOGGED_BODY) {
            message = peekRequest(text);
        } else {
            try {
                message = JSON.parse(text);
            } catch {
                message = undefined;
            }
        }
        const request = describeRequest(message);
        observer.sending(message);
        const body = text.length > MAX_LOGGED_BODY ? shorten(text, MAX_LOGGED_BODY) : message ?? text;
        log.debug(server, `→ ${request}`, { headers: loggableHeaders(init.headers), body });
        const started = performance.now();
        let response;
        try {
            response = await fetch(input, init);
        } catch (error) {
            log.debug(server, `✕ ${request} after ${elapsed(started)} ms: ${error?.message || error}`);
            observer.failed(message, error);
            throw markNetworkFailure(error);
        }
        // A streamed reply is traced as it arrives. Anything else is read before the SDK sees it,
        // so the observer knows about it first.
        const streamed = response.ok && isEventStream(response);
        const traced = (streamed ? readStreamedReply(response, message, server) : readWholeReply(response, message)).then(
            reply => {
                log.debug(server, `← ${describeReply(reply)} for ${request} in ${elapsed(started)} ms`, replyDetail(reply));
                observer.replied(message, reply);
            },
            error => log.debug(server, `✕ ${request} after ${elapsed(started)} ms: ${error?.message || error}`),
        );
        if (!streamed) await traced;
        return response;
    };
}

function requestDetail(init) {
    const detail = { headers: loggableHeaders(init.headers) };
    const body = init.body;
    if (body instanceof URLSearchParams) {
        detail.form = redactForm(body);
    } else if (typeof body === 'string' && body) {
        try {
            detail.body = loggableBody(redactJson(JSON.parse(body)), body);
        } catch {
            detail.form = redactForm(new URLSearchParams(body));
        }
    }
    return detail;
}

function responseDetail(text) {
    try {
        return { body: loggableBody(redactJson(JSON.parse(text)), text) };
    } catch {
        return text.trim() ? { body: shorten(text.trim(), 300) } : undefined;
    }
}

// A request that isn't a JSON-RPC POST: the SDK's GET stream and session DELETE, and the
// OAuth endpoints (with `readBody`). `onReply` sees each response before the caller does.
async function exchange(server, input, init, { readBody = false, onReply } = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const url = requestUrl(input);
    const label = `${method} ${url}`;
    log.debug(server, `→ ${label}`, requestDetail(init));
    const started = performance.now();
    let response;
    try {
        response = await fetch(input, init);
    } catch (error) {
        log.debug(server, `✕ ${label} after ${elapsed(started)} ms: ${error?.message || error}`);
        throw markNetworkFailure(error);
    }
    const detail = readBody && !isEventStream(response) ? responseDetail(await response.clone().text().catch(() => '')) : undefined;
    log.debug(server, `← HTTP ${response.status} for ${label} in ${elapsed(started)} ms`, detail);
    onReply?.(url, response);
    return response;
}

// fetch() for the requests signing in to `server` makes. `found` records where the metadata
// documents were, which the SDK doesn't report.
export function signInFetch(server) {
    const found = {};
    const onReply = (url, response) => {
        if (!response.ok) return;
        const path = new URL(url).pathname;
        if (path.includes('/.well-known/oauth-protected-resource')) found.resourceMetadata = url;
        else if (path.includes('/.well-known/oauth-authorization-server') || path.includes('/.well-known/openid-configuration')) found.authServerMetadata = url;
    };
    return { fetch: (input, init = {}) => exchange(server, input, init, { readBody: true, onReply }), found };
}
