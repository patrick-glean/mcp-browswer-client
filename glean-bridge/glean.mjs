// Glean, as the bridge reads it: Glean's own MCP server (https://<company>-be.glean.com/mcp/default),
// called from Node with a user-scoped API token that has the MCP scope, so Glean answers with what
// that person may see. Its search finds the artifacts their team made (app "artifacts", owner
// "myteam"), and read_document reads one. Both answer in text written for models: search in
// Markdown, a section per result, and read_document with a listing of the document, then its
// content. The parsers here turn those into the artifacts and content the tools give
// (public/demo-servers/artifacts.js), and read structuredContent instead when Glean sends it.

import { artifactId, typeOf } from '../public/demo-servers/artifacts.js';

export class GleanError extends Error {}

const PROTOCOL = '2025-06-18';
const SEARCH_GOAL = "Show my team's newest Glean artifacts in a carousel";
const READ_GOAL = "Show one of my team's Glean artifacts in a carousel";

// The JSON-RPC reply to request `id` in a response: JSON, or an SSE stream with it in a data event.
async function replyIn(response, id) {
    const body = await response.text();
    if ((response.headers.get('Content-Type') || '').includes('text/event-stream')) {
        for (const event of body.split(/\r?\n\r?\n/)) {
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            let message = null;
            try {
                message = data ? JSON.parse(data) : null;
            } catch {
                // Not a message.
            }
            if (message?.id === id && ('result' in message || 'error' in message)) return message;
        }
        throw new GleanError("Glean's MCP server ended its stream without an answer.");
    }
    try {
        return JSON.parse(body);
    } catch {
        throw new GleanError(`Glean's MCP server answered with something that isn't JSON: ${body.slice(0, 120)}`);
    }
}

// A client of one MCP server over Streamable HTTP, with the 2025 handshake: initialize once, then
// tools/call in that session, starting another when the server has forgotten it. The token goes
// only in the Authorization header, and never into an error.
export function mcpClient(url, { token = '', fetch = globalThis.fetch, timeoutMs = 30_000, clientInfo = { name: 'glean-artifacts-bridge', version: '0.1.0' } } = {}) {
    let session = null;
    let nextId = 1;

    async function post(message, { sessionId = null, version = null } = {}) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        if (version) headers['MCP-Protocol-Version'] = version;
        let response;
        try {
            response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            throw new GleanError(`The bridge couldn't reach Glean's MCP server at ${url}: ${error.cause?.code || error.message}`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new GleanError(`Glean turned the bridge's token away (HTTP ${response.status}). GLEAN_API_TOKEN needs to be a user-scoped token with the MCP scope, from this Glean.`);
        }
        if (response.status === 404 && sessionId) return { gone: true };
        if (!response.ok) throw new GleanError(`Glean's MCP server answered HTTP ${response.status}.`);
        if (!('id' in message)) return {};
        return { reply: await replyIn(response, message.id), sessionId: response.headers.get('Mcp-Session-Id') };
    }

    async function open() {
        const { reply, sessionId } = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo } });
        if (reply.error) throw new GleanError(`Glean's MCP server didn't start a session: ${reply.error.message}`);
        const version = reply.result?.protocolVersion || PROTOCOL;
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId, version });
        return { sessionId, version };
    }

    async function request(method, params, failed) {
        for (let attempt = 0; attempt < 2; attempt++) {
            session ??= open().catch(error => {
                session = null;
                throw error;
            });
            const sent = await post({ jsonrpc: '2.0', id: nextId++, method, params }, await session);
            if (sent.gone) {
                session = null;
                continue;
            }
            if (sent.reply.error) throw new GleanError(`${failed}: ${sent.reply.error.message}`);
            return sent.reply.result;
        }
        throw new GleanError("Glean's MCP server forgot the bridge's session twice in a row.");
    }

    return {
        // A tool's CallToolResult. A JSON-RPC error throws; a result marked isError is returned.
        callTool: (name, args) => request('tools/call', { name, arguments: args }, `Glean's ${name} failed`),
        listTools: async () => (await request('tools/list', {}, "Glean's MCP server didn't list its tools"))?.tools || [],
    };
}

const textsOf = result => (Array.isArray(result?.content) ? result.content : [])
    .filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text);

const isoOf = value => {
    const time = Date.parse(String(value ?? '').trim());
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

// A file's name as a title: "release_notes/release_notes.html" is "Release notes", and "Q4 plan.md"
// is "Q4 plan".
export function titleOf(name) {
    let title = String(name ?? '').trim().split('/').pop().replace(/\.(md|markdown|html?|txt)$/i, '');
    if (!/\s/.test(title)) title = title.replace(/[_-]+/g, ' ');
    title = title.replace(/\s+/g, ' ').trim();
    return title ? title[0].toUpperCase() + title.slice(1) : 'Untitled';
}

// A department as Glean's filters write it ("418 developer experience"), as people say it.
export const departmentOf = value => String(value ?? '').trim().replace(/^\d+\s+/, '').replace(/\b\w/g, char => char.toUpperCase());

// What an artifact is, from the start of its content: its first line of prose, without Markdown.
export function summaryOf(snippet, title = '') {
    const lines = String(snippet ?? '').split('\n').map(line => line.trim())
        .filter(line => line && !/^#{1,6}\s/.test(line) && !line.startsWith('|') && line.toLowerCase() !== String(title).toLowerCase());
    const prose = lines.find(line => line.split(/\s+/).length >= 8) ?? lines[0] ?? '';
    const clean = prose.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();
    if (clean.length <= 220) return clean;
    const cut = clean.slice(0, 220);
    const sentence = cut.match(/^(.{80,}[.!?])\s/)?.[1];
    return sentence || `${cut.replace(/\s+\S*$/, '')}…`;
}

const snippetText = snippets => (Array.isArray(snippets) ? snippets : [snippets]).map(item => (typeof item === 'string' ? item : item?.text ?? item?.snippet ?? '')).join('\n');
const nameOf = person => (typeof person === 'string' ? person : person?.name ?? person?.displayName ?? '');

// One result of search's structuredContent, in whatever shape Glean names its fields.
function fromDocument(document) {
    const url = document?.url || document?.link;
    if (!url) return null;
    const title = titleOf(document.title || document.name || url);
    return {
        id: document.artifactId || artifactId(url),
        title,
        type: typeOf(document.docType || document.type || document.matchingFilters?.type),
        author: nameOf(document.owner) || nameOf(document.author) || nameOf(document.createdBy),
        department: departmentOf(document.department || document.matchingFilters?.department),
        createdAt: isoOf(document.createTime || document.createdAt),
        updatedAt: isoOf(document.updateTime || document.updatedAt),
        version: Number(document.version) || undefined,
        url,
        summary: summaryOf(snippetText(document.snippets ?? document.snippet ?? ''), title),
    };
}

// One "## N. title" section of search's Markdown: the title, a line of Source, Updated, Created and
// Owner, the matching filters (type, department, version…), the Link, and the snippet as a quote.
function fromSection(section) {
    const body = section.split(/\n---[ \t]*(?:\n|$)/)[0];
    const name = body.match(/^## \d+\.\s+(.+)$/m)?.[1];
    const url = body.match(/\*\*Link:\*\*\s*(\S+)/)?.[1];
    if (!name || !url) return null;
    const field = label => body.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([^•\\n]+)`))?.[1]?.trim();
    const filters = {};
    for (const [, key, value] of body.matchAll(/^- ([a-z_]+):(.+)$/gim)) filters[key.toLowerCase()] ??= value.trim();
    const snippet = body.split('\n').filter(line => line.startsWith('>')).map(line => line.replace(/^>\s?/, '')).join('\n');
    const named = titleOf(name);
    const title = snippet.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(line => line.toLowerCase() === named.toLowerCase()) || named;
    return {
        id: artifactId(url),
        title,
        type: typeOf(filters.type),
        author: field('Owner') || '',
        department: departmentOf(filters.department),
        createdAt: isoOf(field('Created')),
        updatedAt: isoOf(field('Updated')),
        version: Number(filters.version) || undefined,
        url,
        summary: summaryOf(snippet, title),
    };
}

// The artifacts in a reply of Glean's search, in its order, each once: from its structuredContent
// when it has documents, else from the Markdown it writes.
export function artifactsFromSearch(result) {
    const documents = result?.structuredContent?.documents ?? result?.structuredContent?.results;
    const found = Array.isArray(documents) && documents.length
        ? documents.map(fromDocument)
        : textsOf(result).join('\n').split(/\n(?=## \d+\. )/).slice(1).map(fromSection);
    const seen = new Set();
    return found.filter(artifact => artifact && !seen.has(artifact.id) && seen.add(artifact.id));
}

const formatOf = (type, text, mimeType = '') => {
    if (/html/i.test(mimeType) || type === 'html' || /^\s*<(!doctype|html|head|body|main|div|section|style)\b/i.test(text)) return 'html';
    if (type === 'message' || type === 'email' || /^text\/plain/i.test(mimeType)) return 'text';
    return 'markdown';
};

// The listing read_document starts with: "documents[1]:", then indented "  - key: value" lines, a
// value in quotes when it needs them (snippets, url). Its first document's fields, and the line
// after the listing, where the content starts.
function listingIn(lines) {
    const fields = {};
    if (!/^documents\[\d+\]/.test(lines[0] || '')) return { fields, end: 0 };
    let at = 1;
    let documents = 0;
    for (; at < lines.length && /^\s+\S/.test(lines[at]); at++) {
        const match = lines[at].match(/^\s+(-\s+)?([A-Za-z_][\w.]*)(?:\[\d+\])?(?:\{[^}]*\})?:(?:\s(.*))?$/);
        if (!match) continue;
        if (match[1]) documents++;
        if (documents > 1) continue;
        const value = (match[3] ?? '').trim();
        try {
            fields[match[2]] = value.startsWith('"') ? JSON.parse(value) : value;
        } catch {
            fields[match[2]] = value.replace(/^"|"$/g, '');
        }
    }
    return { fields, end: at };
}

// What read_document gives of one artifact: its content, as an embedded resource, as
// structuredContent's richDocumentData, or as the text after the listing (Glean's own
// invocation ID taken off its end), else the listing's snippets. Null when there's none.
export function contentFromRead(result, type) {
    for (const item of Array.isArray(result?.content) ? result.content : []) {
        if (item?.type === 'resource' && typeof item.resource?.text === 'string' && item.resource.text.trim()) {
            return { format: formatOf(type, item.resource.text, item.resource.mimeType), text: item.resource.text };
        }
    }
    const document = result?.structuredContent?.documents?.[0];
    const rich = document?.richDocumentData?.content;
    if (typeof rich === 'string' && rich.trim()) return { format: formatOf(type, rich), text: rich };
    const lines = textsOf(result).join('\n').split('\n');
    const { fields, end } = listingIn(lines);
    const after = lines.slice(end).join('\n').replace(/\n*glean_invocation_id:\s*\S+\s*$/, '').trim();
    const text = after || (typeof fields.content === 'string' ? fields.content : '') || (typeof fields.snippets === 'string' ? fields.snippets : '') || snippetText(document?.snippets ?? '');
    return text.trim() ? { format: formatOf(type || typeOf(fields.docType), text), text } : null;
}

// The team's name, when every artifact listed is from one department; else none, and the tools
// say "your team".
const teamOf = artifacts => {
    const departments = new Set(artifacts.map(artifact => artifact.department).filter(Boolean));
    return departments.size === 1 ? [...departments][0] : '';
};

// What Glean's MCP servers have called their search and read tools; the bridge uses the first one
// the server lists, unless it's told which.
const SEARCH_TOOLS = ['search', 'enterprise_search', 'glean_search'];
const READ_TOOLS = ['read_document', 'read_documents', 'glean_read_document'];

// The bridge's source: the newest artifacts that the token's team made, from Glean, each list kept
// for `listMs` and each artifact's content for `readMs`. `owner` is search's owner filter ("myteam",
// "me" or a person's name) and `filters` its dynamic_search_result_filters, such as
// "department:418 developer experience". `team` names the team when the results don't.
// `searchTool` and `readTool` name Glean's tools, when the server's aren't ones the bridge knows.
export function gleanSource({ client, owner = 'myteam', filters = '', team = '', searchTool = '', readTool = '', listMs = 60_000, readMs = 300_000, now = () => Date.now() }) {
    const lists = new Map();
    const reads = new Map();
    let listed = null;
    const toolFor = async (what, named, known) => {
        if (named) return named;
        listed ??= client.listTools().then(tools => new Set(tools.map(tool => tool.name))).catch(error => {
            listed = null;
            throw error;
        });
        const names = await listed;
        const found = known.find(name => names.has(name));
        if (!found) throw new GleanError(`Glean's MCP server has no ${what} tool the bridge knows (${known.join(', ')}): set GLEAN_${what.toUpperCase()}_TOOL to its name.`);
        return found;
    };
    const kept = (cache, key, ms, make) => {
        const entry = cache.get(key);
        if (entry && now() - entry.at < ms) return entry.value;
        const value = make().catch(error => {
            cache.delete(key);
            throw error;
        });
        cache.set(key, { at: now(), value });
        return value;
    };
    const failure = (tool, result) => new GleanError(`Glean's ${tool} failed: ${textsOf(result).join(' ').trim().slice(0, 300) || 'it gave no reason'}`);
    return {
        name: 'glean',
        label: 'from Glean',
        list: ({ count = 12 } = {}) => kept(lists, count, listMs, async () => {
            const tool = await toolFor('search', searchTool, SEARCH_TOOLS);
            const args = { query: '*', app: 'artifacts', owner, num_results: count, sort_by_recency: true, _user_goal: SEARCH_GOAL };
            if (filters) args.dynamic_search_result_filters = filters;
            const result = await client.callTool(tool, args);
            if (result?.isError) throw failure(tool, result);
            const artifacts = artifactsFromSearch(result).slice(0, count);
            return { team: team || teamOf(artifacts), artifacts };
        }),
        read: artifact => kept(reads, artifact.id, readMs, async () => {
            const tool = await toolFor('read', readTool, READ_TOOLS);
            const result = await client.callTool(tool, { urls: [artifact.url], _user_goal: READ_GOAL, user_requested_latest_version: false });
            if (result?.isError) throw failure(tool, result);
            return contentFromRead(result, artifact.type);
        }),
    };
}
