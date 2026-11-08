// An MCP server that answers in the page's service worker, without a network: what the built-in
// demo servers are made of. It speaks Streamable HTTP as a real server does, in both eras, so the
// MCP client library talks to it the way it talks to any server: MCP 2026-07-28 requests with no
// session (server/discover, tools/list, tools/call), and the 2025 handshake (initialize, then
// requests in its session) for a client that falls back to it. It answers in JSON, never SSE.

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED = [MODERN_VERSION, ...LEGACY_VERSIONS];

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

function reply(status, message, headers = {}) {
    if (message === null) return new Response(null, { status, headers });
    return new Response(JSON.stringify(message), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// A server from its name and tools: [{ ...definition, call(args, state) }], where `call` returns
// a CallToolResult ({ content, structuredContent?, isError? }) and may throw to fail. `state` is
// the server's own, for as long as the worker runs.
export function mcpServer({ name, version = '1.0.0', instructions = '', tools }) {
    const serverInfo = { name, version };
    const capabilities = { tools: {} };
    const definitions = tools.map(({ call, ...definition }) => definition);
    const calls = new Map(tools.map(tool => [tool.name, tool.call]));
    const sessions = new Set();
    const state = {};

    function dispatch({ id, method, params }, modern) {
        const result = value => reply(200, { jsonrpc: '2.0', id, result: { ...(modern ? { resultType: 'complete' } : {}), ...value } });
        if (method === 'server/discover' && modern) {
            return result({ supportedVersions: SUPPORTED, capabilities, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }, ...(instructions ? { instructions } : {}), ttlMs: 60_000, cacheScope: 'public' });
        }
        if (method === 'ping') return result({});
        if (method === 'tools/list') return result({ tools: definitions, ...(modern ? { ttlMs: 30_000, cacheScope: 'public' } : {}) });
        if (method === 'tools/call') {
            const call = calls.get(params.name);
            if (!call) return reply(200, rpcError(id, -32602, `Unknown tool: ${params.name}`));
            try {
                return result(call(params.arguments || {}, state));
            } catch (error) {
                return result({ content: [{ type: 'text', text: error.message }], isError: true });
            }
        }
        return reply(modern ? 404 : 200, rpcError(id, -32601, `Method not found: ${method}`));
    }

    // One HTTP request to the server: its method, headers (a Headers) and body (text).
    function answer({ method = 'GET', headers = new Headers(), body = '' }) {
        if (method === 'DELETE') {
            sessions.delete(headers.get('Mcp-Session-Id'));
            return reply(204, null);
        }
        if (method !== 'POST') return reply(405, null, { Allow: 'POST, DELETE' });
        let message;
        try {
            message = JSON.parse(body);
        } catch {
            return reply(400, rpcError(null, -32700, 'Parse error'));
        }
        if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return reply(400, rpcError(null, -32600, 'Invalid JSON-RPC request'));
        if (!('id' in message)) return reply(202, null);
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        if (message.method === 'initialize') {
            const protocolVersion = LEGACY_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LEGACY_VERSIONS[0];
            const session = crypto.randomUUID();
            sessions.add(session);
            return reply(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion, capabilities, serverInfo, ...(instructions ? { instructions } : {}) } }, { 'Mcp-Session-Id': session });
        }
        const version = params._meta?.['io.modelcontextprotocol/protocolVersion'];
        if (version !== undefined) {
            if (version !== MODERN_VERSION) return reply(400, rpcError(message.id, -32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: version }));
            return dispatch({ ...message, params }, true);
        }
        const session = headers.get('Mcp-Session-Id');
        if (!session) return reply(400, rpcError(null, -32000, 'Bad Request: No valid session ID provided'));
        if (!sessions.has(session)) return reply(404, rpcError(null, -32001, 'Session not found'));
        return dispatch({ ...message, params }, false);
    }

    return { serverInfo, tools: definitions, answer };
}
