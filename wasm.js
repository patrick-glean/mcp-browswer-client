import { log, logger } from './logger.js';

let wasmInstance = null;
let initPromise = null;
let uptimeInterval = null;

let broadcastToClients = () => {};

export function setBroadcast(fn) {
    broadcastToClients = fn;
}

export function getWasmInstance() {
    return wasmInstance;
}

// Check WASM module health
export async function checkWasm() {
    try {
        if (!wasmInstance) {
            // WASM not initialized: try to initialize and re-check
            await initializeWasm();
            if (!wasmInstance) throw new Error('WASM module not initialized after reload');
        }

        const uptime = await wasmInstance.get_uptime();
        const metadata = wasmInstance.get_metadata();
        const buildInfo = wasmInstance.get_compiled_info();

        return { healthy: true, uptime: uptime, metadata: metadata, buildInfo: buildInfo }
    } catch (error) {
        logger.error(`WASM health check failed: ${error.message}`);
        return { healthy: false };
    }
}

// Initialize WASM module
export async function initializeWasm() {
    if (wasmInstance) {
        return true;
    }
    if (!initPromise) {
        initPromise = loadWasm().finally(() => { initPromise = null; });
    }
    return initPromise;
}

// Browsers stop idle service workers and restart them for the next event,
// discarding module state, so handlers cannot rely on install-time loading.
export async function ensureWasm() {
    if (!wasmInstance) {
        await initializeWasm();
    }
    return wasmInstance;
}

// The module logs through here once it's loaded: one JSON entry {level, server, message, detail?}.
function forwardWasmLog(json) {
    try {
        const { level, server, message, detail } = JSON.parse(json);
        log(level, message, { source: 'wasm', server: server || undefined, detail });
    } catch {
        logger.warn(`Unreadable log entry from the WASM module: ${json}`);
    }
}

// no-cache revalidates with the server, so a rebuilt module is picked up on the next load
// instead of whenever the HTTP cache expires.
async function fetchFresh(path, what) {
    const response = await self.fetch(path, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`Couldn't fetch the ${what} (${path}): HTTP ${response.status} ${response.statusText}`);
    }
    return response;
}

async function loadWasm() {
    try {
        logger.debug('Loading the WASM module');
        const basePath = self.location.pathname.replace(/\/[^\/]*$/, '/');
        const bindingsText = await (await fetchFresh(`${basePath}mcp_browser_client.js`, 'WASM bindings')).text();

        // The no-modules bindings expect a window; point them at the worker's global scope.
        const patchedBindingsText = bindingsText
            .replace(/^let wasm_bindgen;/, 'self.wasm_bindgen = undefined;')
            .replace(/window\./g, 'self.');
        eval(patchedBindingsText);

        const wasmBytes = await (await fetchFresh(`${basePath}mcp_browser_client_bg.wasm`, 'WASM module')).arrayBuffer();
        const wasmSizeKB = (wasmBytes.byteLength / 1024).toFixed(2);
        await self.wasm_bindgen(wasmBytes);

        // All exported functions are now on self.wasm_bindgen
        wasmInstance = self.wasm_bindgen;
        if (typeof wasmInstance.set_logger === 'function') {
            wasmInstance.set_logger(forwardWasmLog);
        }

        const buildInfo = wasmInstance.get_compiled_info();
        broadcastToClients({
            type: 'wasm_initialized',
            size: wasmSizeKB,
            buildInfo: buildInfo
        });
        logger.info(`Loaded the WASM module (${wasmSizeKB} KB, ${buildInfo})`);

        startUptimeCounter();
        return true;
    } catch (error) {
        logger.error(`Couldn't load the WASM module: ${error.message}`);
        return false;
    }
}

// Unload WASM module
export function unloadWasm() {
    if (wasmInstance) {
        stopUptimeCounter();
        wasmInstance = null;
        logger.info('Unloaded the WASM module');
    }
}

// Start uptime counter
export function startUptimeCounter() {
    stopUptimeCounter(); // Clear any existing interval
    uptimeInterval = setInterval(() => {
        if (wasmInstance) {
            try {
                wasmInstance.increment_uptime();
            } catch (error) {
                logger.error(`Couldn't update the WASM uptime: ${error.message}`);
            }
        }
    }, 1000);
}

// Stop uptime counter
export function stopUptimeCounter() {
    if (uptimeInterval) {
        clearInterval(uptimeInterval);
        uptimeInterval = null;
    }
}

// Reload WASM module
export async function reloadWasm() {
    logger.info('Reloading the WASM module');
    try {
        unloadWasm();
        const success = await initializeWasm();
        if (!success) {
            broadcastToClients({
                type: 'wasm_status',
                healthy: false
            });
        }
    } catch (error) {
        logger.error(`Couldn't reload the WASM module: ${error.message}`);
        broadcastToClients({
            type: 'wasm_status',
            healthy: false
        });
    }
}
