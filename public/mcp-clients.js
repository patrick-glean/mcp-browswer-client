// The MCP client libraries a service worker can run, and how to load each one. Every library
// exports the same functions (connect, list_tools, call_tool, auth_begin, ...; see DEVELOPMENT.md),
// so the worker uses whichever it loaded and switches between them while it runs.
//
//   wasm  the Rust client in src/, built by wasm-build.sh into mcp_browser_client_bg.wasm
//   sdk   sdk-client/ on @modelcontextprotocol/client, built by sdk-client/build.mjs into sdk_client.js
//
// Adding a library means a loader here; the Runtime menu, the smoke test (--client=) and the
// benchmark read this list. Service workers can't import() modules on demand, so each library is
// fetched and evaluated the first time it's used. build.js and build-sdk.js change with every build
// of their library, and importing them makes a rebuild count as a worker update.

import { WASM_SHA256 } from './build.js';
import { SDK_SHA256 } from './build-sdk.js';

// `logSource` is the source its log entries show in the log.
export const MCP_CLIENTS = {
    wasm: { name: 'wasm', label: 'Rust/WASM client', logSource: 'wasm', build: WASM_SHA256 },
    sdk: { name: 'sdk', label: 'TypeScript SDK client', logSource: 'sdk', build: SDK_SHA256 },
};

// no-cache revalidates with the server, so a rebuilt library is picked up on the next load instead
// of whenever the HTTP cache expires.
async function fetchFresh(file, what) {
    const url = new URL(file, import.meta.url);
    const response = await self.fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`Couldn't fetch the ${what} (${url.pathname}): HTTP ${response.status} ${response.statusText}`);
    }
    return response;
}

async function loadWasm() {
    const bindingsText = await (await fetchFresh('mcp_browser_client.js', 'WASM bindings')).text();
    // The no-modules bindings expect a window; point them at the worker's global scope.
    const patchedBindingsText = bindingsText
        .replace(/^let wasm_bindgen;/, 'self.wasm_bindgen = undefined;')
        .replace(/window\./g, 'self.');
    eval(patchedBindingsText);
    const wasmBytes = await (await fetchFresh('mcp_browser_client_bg.wasm', 'WASM module')).arrayBuffer();
    await self.wasm_bindgen(wasmBytes);
    // All exported functions are now on self.wasm_bindgen.
    return { module: self.wasm_bindgen, bytes: wasmBytes.byteLength };
}

async function loadSdk() {
    const response = await fetchFresh('sdk_client.js', 'TypeScript SDK client');
    const source = new Uint8Array(await response.arrayBuffer());
    // Evaluated in the worker's global scope, where the bundle sets self.mcpSdkClient.
    (0, eval)(`${new TextDecoder().decode(source)}\n//# sourceURL=${response.url}`);
    return { module: self.mcpSdkClient, bytes: source.byteLength };
}

const LOADERS = { wasm: loadWasm, sdk: loadSdk };

// Loads a fresh instance of a library: {name, label, logSource, build, module, bytes, loadMs}.
export async function loadMcpClient(name) {
    const client = MCP_CLIENTS[name];
    if (!client) throw new Error(`There's no MCP client library called ${name}; use ${Object.keys(MCP_CLIENTS).join(' or ')}`);
    const started = performance.now();
    const { module, bytes } = await LOADERS[name]();
    return { ...client, module, bytes, loadMs: performance.now() - started };
}
