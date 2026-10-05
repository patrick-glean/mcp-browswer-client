// An MCP server that answers from memory, inside the benchmark's service worker, so a call to it
// costs the client's own work and nothing else: no network, no server. It answers like
// test_mcp_server.py's echo tool, in either era and either framing:
//
//   http://memory.mcp-bench.invalid/{modern|legacy}/{json|sse}/
//
// Its own work is kept small and the same for both clients: the echo text is sliced out of the
// request instead of parsing it, which works because the benchmark's text needs no escaping.

const ORIGIN = 'http://memory.mcp-bench.invalid';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const SERVER_INFO = { name: 'In-memory MCP server', version: '1.0.0' };
const ECHO = {
    name: 'echo',
    title: 'Echo',
    description: 'Echoes the text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
};
// Requests bigger than this are tool calls carrying the benchmark's text, read without parsing.
const PARSED_LIMIT = 8_192;

export const memoryUrl = (era, framing) => `${ORIGIN}/${era}/${framing}/`;

// Answers requests to ORIGIN in this worker; everything else goes to the network as before.
export function installMemoryServer() {
    if (self.fetch.memoryServer) return;
    const networkFetch = self.fetch;
    const fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
        if (!url?.startsWith(ORIGIN)) return networkFetch.call(self, input, init);
        return Promise.resolve(answer(new URL(url), init ?? {}));
    };
    fetch.memoryServer = true;
    self.fetch = fetch;
}

function answer(url, init) {
    const [, era, framing] = url.pathname.split('/');
    if ((init.method || 'GET').toUpperCase() !== 'POST') return new Response(null, { status: 405 });
    const body = typeof init.body === 'string' ? init.body : '';
    if (body.length > PARSED_LIMIT) return echoUnparsed(body, era, framing);

    const message = JSON.parse(body);
    if (!('id' in message)) return new Response(null, { status: 202 });
    const modern = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== undefined;
    if (era === 'legacy' && modern) {
        // What a 2025-era server says to a request that skipped initialize.
        return reply('json', 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
    }
    const respond = (result, headers) => reply(framing, 200, { jsonrpc: '2.0', id: message.id, result }, headers);
    const complete = modern ? { resultType: 'complete' } : {};
    switch (message.method) {
        case 'initialize':
            if (era === 'modern') {
                return reply('json', 400, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: `This server only supports MCP ${MODERN_VERSION}`, data: { supported: [MODERN_VERSION], requested: message.params?.protocolVersion } } });
            }
            return respond({ protocolVersion: LEGACY_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO }, { 'Mcp-Session-Id': 'memory-session' });
        case 'server/discover':
            return respond({ ...complete, supportedVersions: [MODERN_VERSION], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }, ttlMs: 60_000, cacheScope: 'public' });
        case 'tools/list':
            return respond({ ...complete, tools: [ECHO], ...(modern ? { ttlMs: 30_000, cacheScope: 'public' } : {}) });
        case 'tools/call':
            return respond({ ...complete, content: [{ type: 'text', text: `Echo: ${message.params?.arguments?.text ?? ''}` }] });
        default:
            return reply('json', modern ? 404 : 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
}

// A big echo call. The WASM client writes the id first and the SDK writes it last.
function echoUnparsed(body, era, framing) {
    const id = /^\{\s*"id"\s*:\s*(-?\d+|"[^"]*")/.exec(body)?.[1] ?? /"id"\s*:\s*(-?\d+|"[^"]*")\s*}\s*$/.exec(body.slice(-128))?.[1];
    const start = body.indexOf('"text":"') + '"text":"'.length;
    const text = body.slice(start, body.indexOf('"', start));
    const complete = era === 'modern' ? '"resultType":"complete",' : '';
    return reply(framing, 200, `{"jsonrpc":"2.0","id":${id},"result":{${complete}"content":[{"type":"text","text":"Echo: ${text}"}]}}`);
}

// Bodies here are ASCII, so their length is their size in bytes.
function reply(framing, status, message, headers = {}) {
    const json = typeof message === 'string' ? message : JSON.stringify(message);
    if (framing === 'sse' && status === 200) {
        return new Response(`event: message\ndata: ${json}\n\n`, { status, headers: { 'Content-Type': 'text/event-stream', ...headers } });
    }
    return new Response(json, { status, headers: { 'Content-Type': 'application/json', 'Content-Length': String(json.length), ...headers } });
}
