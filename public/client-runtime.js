// The MCP client library this service worker runs: whichever the page last asked for (set_client),
// from the list in mcp-clients.js. The choice is kept in Cache Storage, so a worker the browser
// restarts loads the same one.
import { MCP_CLIENTS, loadMcpClient } from './mcp-clients.js';
import { log, logger } from './logger.js';

const SETTINGS_CACHE = 'mcp-client-settings';
const CHOICE_KEY = '/settings/client';
const DEFAULT_CLIENT = MCP_CLIENTS.wasm;

let instance = null;
// The library `instance` is, and the one to run: they differ while a switch is under way.
let current = null;
let wanted = null;
let loading = null;
let uptimeInterval = null;

let broadcastToClients = () => {};

export function setBroadcast(fn) {
    broadcastToClients = fn;
}

export function getClient() {
    return instance;
}

async function storedChoice() {
    try {
        const response = await (await caches.open(SETTINGS_CACHE)).match(CHOICE_KEY);
        return MCP_CLIENTS[(await response?.text())?.trim()] ?? DEFAULT_CLIENT;
    } catch {
        return DEFAULT_CLIENT;
    }
}

export async function checkClient() {
    try {
        if (!instance) {
            // Not loaded: try to load it and check again.
            await loadClient();
            if (!instance) throw new Error(`The ${(wanted ?? DEFAULT_CLIENT).label} didn't load`);
        }

        const uptime = await instance.get_uptime();
        const metadata = instance.get_metadata();
        const buildInfo = instance.get_compiled_info();

        return { healthy: true, uptime: uptime, metadata: metadata, buildInfo: buildInfo }
    } catch (error) {
        logger.error(`MCP client health check failed: ${error.message}`);
        return { healthy: false };
    }
}

export async function loadClient() {
    if (instance && (!wanted || wanted === current)) return true;
    if (!loading) {
        loading = (async () => {
            wanted ??= await storedChoice();
            if (instance) unloadClient();
            return load(wanted);
        })().finally(() => { loading = null; });
    }
    const loaded = await loading;
    // Asked for another library while this one loaded.
    if (loaded && wanted !== current) return loadClient();
    return loaded;
}

// Browsers stop idle service workers and restart them for the next event,
// discarding module state, so handlers cannot rely on install-time loading.
export async function ensureClient() {
    if (!instance) {
        await loadClient();
    }
    return instance;
}

// Runs `name` from now on and remembers it. If another library is loaded it's dropped at once, so
// every request after this one goes to the new one.
export function setClient(name) {
    const next = MCP_CLIENTS[name];
    if (!next) return Promise.reject(new Error(`There's no MCP client library called ${name}`));
    wanted = next;
    const saved = caches.open(SETTINGS_CACHE).then(cache => cache.put(CHOICE_KEY, new Response(next.name))).catch(error => {
        logger.warn(`Couldn't remember the choice of the ${next.label}: ${error.message}`);
    });
    if (current === next && instance) return saved.then(() => true);
    if (instance && !loading) unloadClient();
    return Promise.all([saved, loadClient()]).then(([, loaded]) => loaded);
}

// The library logs through here once it's loaded: one entry {level, server, message, detail?}, as
// JSON from the WASM module and as an object from the SDK one.
function forwardClientLog(entry, source) {
    try {
        const { level, server, message, detail } = typeof entry === 'string' ? JSON.parse(entry) : entry;
        log(level, message, { source: source.logSource, server: server || undefined, detail });
    } catch {
        logger.warn(`Unreadable log entry from the ${source.label}: ${entry}`);
    }
}

async function load(target) {
    try {
        logger.debug(`Loading the ${target.label}`);
        const loaded = await loadMcpClient(target.name);
        loaded.module.set_logger?.(entry => forwardClientLog(entry, target));
        instance = loaded.module;
        current = target;

        const sizeKB = (loaded.bytes / 1024).toFixed(2);
        const buildInfo = instance.get_compiled_info();
        broadcastToClients({
            type: 'client_loaded',
            size: sizeKB,
            buildInfo: buildInfo,
            client: target.name
        });
        logger.info(`Loaded the ${target.label} (${sizeKB} KB, ${buildInfo})`);

        startUptimeCounter();
        return true;
    } catch (error) {
        logger.error(`Couldn't load the ${target.label}: ${error.message}`);
        return false;
    }
}

export function unloadClient() {
    if (instance) {
        stopUptimeCounter();
        // The SDK client's connections hold open requests; the WASM module's go with the instance.
        instance.reset?.();
        instance = null;
        logger.info(`Unloaded the ${current.label}`);
        current = null;
    }
}

export function startUptimeCounter() {
    stopUptimeCounter();
    uptimeInterval = setInterval(() => {
        if (instance) {
            try {
                instance.increment_uptime();
            } catch (error) {
                logger.error(`Couldn't update the MCP client's uptime: ${error.message}`);
            }
        }
    }, 1000);
}

export function stopUptimeCounter() {
    if (uptimeInterval) {
        clearInterval(uptimeInterval);
        uptimeInterval = null;
    }
}

export async function reloadClient() {
    logger.info('Reloading the MCP client');
    try {
        unloadClient();
        const success = await loadClient();
        if (!success) {
            broadcastToClients({
                type: 'client_status',
                healthy: false
            });
        }
    } catch (error) {
        logger.error(`Couldn't reload the MCP client: ${error.message}`);
        broadcastToClients({
            type: 'client_status',
            healthy: false
        });
    }
}
