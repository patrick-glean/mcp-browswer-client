#!/usr/bin/env node
// The Glean artifacts bridge: an MCP server with list_team_artifacts and get_artifact
// (public/demo-servers/artifacts.js) over Glean's own MCP server, for apps that show a team's
// artifacts in other pages, such as the Team artifacts example's carousel. It holds a Glean token,
// so the pages that embed the app need no sign-in, and answers CORS for the pages it lists.
// Without a token it serves the demo's made-up team.
//
//   node glean-bridge/server.mjs
//   GLEAN_MCP_URL=https://<company>-be.glean.com/mcp/default GLEAN_API_TOKEN=… node glean-bridge/server.mjs
//
// glean-bridge/README.md has the rest of its settings, and what holding a token means.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { artifactsServer, demoSource } from '../public/demo-servers/artifacts.js';
import { gleanSource, mcpClient } from './glean.mjs';

const MAX_BODY = 1_000_000;
const DEFAULT_ORIGINS = 'https://patrick-glean.github.io,http://127.0.0.1:*,http://localhost:*';

// Whether a page at `origin` may call the bridge: one of `allowed`, where "*" is any page and
// "http://127.0.0.1:*" is that host at any port.
export function originAllowed(origin, allowed) {
    return allowed.some(pattern => {
        if (pattern === '*' || pattern === origin) return true;
        if (!pattern.endsWith(':*')) return false;
        const base = pattern.slice(0, -2);
        return origin === base || (origin.startsWith(`${base}:`) && /^\d+$/.test(origin.slice(base.length + 1)));
    });
}

// The source the settings ask for: Glean when there's an address and a token, else the demo's.
export function sourceFrom(env, { fetch } = {}) {
    if (!env.GLEAN_MCP_URL && !env.GLEAN_API_TOKEN) return demoSource();
    if (!env.GLEAN_MCP_URL || !env.GLEAN_API_TOKEN) {
        throw new Error('Set both GLEAN_MCP_URL and GLEAN_API_TOKEN to serve Glean, or neither to serve the demo.');
    }
    return gleanSource({
        client: mcpClient(env.GLEAN_MCP_URL, { token: env.GLEAN_API_TOKEN, fetch }),
        owner: env.ARTIFACTS_OWNER || 'myteam',
        filters: env.ARTIFACTS_FILTERS || '',
        team: env.ARTIFACTS_TEAM || '',
        searchTool: env.GLEAN_SEARCH_TOOL || '',
        readTool: env.GLEAN_READ_TOOL || '',
    });
}

const plain = (res, status, text) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);

// An HTTP request handler that serves the tools at /mcp. `log` hears of each tool call, by name.
export function bridgeHandler({ source, allowed, log = () => {} }) {
    const server = artifactsServer(source, {
        name: 'glean-artifacts-bridge',
        about: {
            title: source.name === 'glean' ? 'Glean artifacts' : 'Glean artifacts (demo data)',
            websiteUrl: 'https://github.com/patrick-glean/mcp-browswer-client/tree/main/glean-bridge',
        },
    });
    return async (req, res) => {
        const origin = req.headers.origin;
        if (origin) {
            if (!originAllowed(origin, allowed)) return plain(res, 403, `${origin} isn't one of the bridge's ALLOWED_ORIGINS.`);
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
            res.setHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
            if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
            res.setHeader('Access-Control-Max-Age', '600');
            return res.writeHead(204).end();
        }
        if (new URL(req.url || '/', 'http://bridge').pathname !== '/mcp') return plain(res, 404, 'The bridge serves MCP at /mcp.');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY) return plain(res, 413, 'That request is too big for the bridge.');
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const started = Date.now();
        let response;
        try {
            response = await server.answer({ method: req.method, headers, body });
        } catch (error) {
            log(`failed: ${error.message}`);
            return plain(res, 500, 'The bridge failed to answer that.');
        }
        const reply = Buffer.from(await response.arrayBuffer());
        try {
            const message = JSON.parse(body);
            if (message?.method === 'tools/call') {
                const failed = /"isError":true/.test(reply.toString('utf8'));
                log(`${message.params?.name} ${failed ? 'failed' : 'answered'} in ${Date.now() - started} ms`);
            }
        } catch {
            // Not JSON: the server has answered that already.
        }
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.writeHead(response.status).end(reply);
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const env = process.env;
    let source;
    try {
        source = sourceFrom(env);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(origin => origin.trim()).filter(Boolean);
    const port = Number(env.PORT || 8095);
    const host = env.HOST || '127.0.0.1';
    const log = line => console.log(`${new Date().toISOString()} ${line}`);
    createServer(bridgeHandler({ source, allowed, log })).listen(port, host, () => {
        console.log(`The Glean artifacts bridge is serving ${source.name === 'glean' ? `your team's artifacts from ${new URL(env.GLEAN_MCP_URL).host}` : "the demo's made-up team"} at http://${host}:${port}/mcp`);
        console.log(`Pages it answers: ${allowed.join(', ')}`);
    });
}
