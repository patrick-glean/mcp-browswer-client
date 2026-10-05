// The TypeScript SDK client, one of the MCP client libraries the service worker can run (listed in
// public/mcp-clients.js). sdk-client/build.mjs builds it into public/sdk_client.js, which sets
// self.mcpSdkClient when evaluated. It has the interface every library has (DEVELOPMENT.md), with
// MCP and sign-in done by @modelcontextprotocol/client: MCP and sign-in calls take and return JSON
// strings and reject with a JSON McpError, {kind, message, status?, code?, data?}.

import { McpError, internal } from './errors.js';
import { setLogger } from './log.js';
import * as mcp from './mcp.js';
import * as oauth from './oauth.js';

// The SDK's own client, for public/bench/ to measure without this adapter.
export { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const VERSION = __CLIENT_VERSION__;
const METADATA_VERSION = '1.0.0';

let uptime = 0;

function parse(json, what) {
    try {
        return JSON.parse(json);
    } catch (error) {
        throw internal(`Invalid ${what}: ${error.message}`);
    }
}

function options(json) {
    const opts = json?.trim() ? parse(json, 'options') : {};
    const token = typeof opts.bearerToken === 'string' ? opts.bearerToken.trim() : '';
    return { bearerToken: token || undefined, refresh: !!opts.refresh };
}

function toolArguments(json) {
    if (!json?.trim()) return {};
    try {
        return JSON.parse(json) ?? {};
    } catch (error) {
        throw internal(`The tool arguments aren't valid JSON: ${error.message}`);
    }
}

function exported(operation) {
    return async (...args) => {
        try {
            return JSON.stringify(await operation(...args));
        } catch (error) {
            throw JSON.stringify(error instanceof McpError ? error : internal(error?.message || String(error)));
        }
    };
}

/** Detects the server's protocol era and returns {url, era, protocolVersion, serverInfo, capabilities, instructions}. */
export const connect = exported((url, json) => mcp.connect(url.trim(), options(json)));

/** Returns {tools, rejected, ttlMs, cacheScope, fromCache}. Pass {"refresh": true} to skip the cache. */
export const list_tools = exported((url, json) => mcp.listTools(url.trim(), options(json)));

/** Calls a tool with JSON-encoded arguments and returns its result. */
export const call_tool = exported((url, name, args, json) => mcp.callTool(url.trim(), name, toolArguments(args), options(json)));

/** call_tool without the JSON strings of the shared interface: arguments, result and error are objects. */
export async function call_tool_object(url, name, args = {}, { bearerToken } = {}) {
    try {
        return await mcp.callTool(url.trim(), name, args, { bearerToken, refresh: false });
    } catch (error) {
        throw error instanceof McpError ? error : internal(error?.message || String(error));
    }
}

export function forget_server(url) {
    mcp.forget(url.trim());
}

/** Drops every connection, as loading a fresh instance of the WASM module does. */
export function reset() {
    mcp.forgetAll();
}

/** Starts signing in: {redirectUri, applicationType, clients, wwwAuthenticate?} → {authorizationUrl, pending, client, newClient, authServer, scope}. */
export const auth_begin = exported((url, json) => oauth.begin(url.trim(), parse(json, 'sign-in options')));

/** Finishes a sign-in with the callback's {code, state, iss, error, errorDescription} and returns the tokens to store. */
export const auth_finish = exported((pending, callback) => oauth.finish(parse(pending, 'sign-in record'), parse(callback, 'sign-in response')));

/** Refreshes stored tokens. Rejects with kind auth_required when the user has to sign in again. */
export const auth_refresh = exported(tokens => oauth.refresh(parse(tokens, 'tokens')));

/** Sends log entries, {level, server, message, detail?}, to `logger` instead of the console. */
export function set_logger(logger) {
    setLogger(logger);
}

export function get_version() {
    return `v${VERSION}`;
}

export function get_compiled_info() {
    return `v${VERSION} built ${__BUILD_TIME__} (${__SOURCE_HASH__.slice(0, 8)}) on @modelcontextprotocol/client ${__SDK_VERSION__}`;
}

export function get_timestamp() {
    return Date.now();
}

export function get_uptime() {
    return uptime;
}

export function increment_uptime() {
    uptime += 1;
}

export function get_metadata() {
    return JSON.stringify({ version: METADATA_VERSION, last_health_check: Date.now() });
}
