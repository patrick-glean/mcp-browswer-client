import { debugLog } from './logger.js';

let wasmInstance = null;
let wasmModule = null;
let isDebugMode = true;
let isInitializing = false;
let uptimeInterval = null;

let broadcastToClients = () => {};

export function setBroadcast(fn) {
    broadcastToClients = fn;
}

export function getWasmInstance() {
    return wasmInstance;
}

export function setDebugMode(enabled) {
    isDebugMode = enabled;
    if (wasmInstance && typeof wasmInstance.set_debug_mode === 'function') {
        wasmInstance.set_debug_mode(isDebugMode);
    }
}

// Check WASM module health
export async function checkWasm() {
    try {
        if (!wasmInstance) {
            // WASM not initialized: try to initialize and re-check
            await initializeWasm();
            if (!wasmInstance) throw new Error('WASM module not initialized after reload');
        }
        // Use the basic health check that doesn't depend on MCP server
        const healthy = await wasmInstance.health_check();
        const uptime = await wasmInstance.get_uptime();
        const metadata = wasmInstance.get_metadata();
        const buildInfo = wasmInstance.get_compiled_info();

        // Broadcast status with current uptime
        // 0 means healthy in our WASM module
        return { healthy: 0, uptime: uptime, metadata: metadata, buildInfo: buildInfo }
    } catch (error) {
        console.error('WASM module check failed:', error);
        return false;
    }
}


// MOVED FROM sw.js
// Initialize WASM module
export async function initializeWasm() {
    if (isInitializing) {
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'WASM initialization already in progress, skipping...' });
        return false;
    }
    if (wasmInstance) {
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'WASM module already initialized, skipping...' });
        return true;
    }
    
    isInitializing = true;
    try {
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'Initializing WASM module...' });
        
        // Determine base path for relative fetches
        const basePath = self.location.pathname.replace(/\/[^\/]*$/, '/');
        // Fetch the wasm-bindgen JS file
        const bindingsResponse = await self.fetch(`${basePath}mcp_browser_client.js`);
        if (!bindingsResponse.ok) {
            throw new Error(`Failed to fetch WASM bindings: ${bindingsResponse.status} ${bindingsResponse.statusText}`);
        }
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'WASM bindings fetched successfully' });
        const bindingsText = await bindingsResponse.text();
        
        // Replace window references with self
        const patchedBindingsText = bindingsText
            .replace(/^let wasm_bindgen;/, 'self.wasm_bindgen = undefined;')
            .replace(/window\./g, 'self.');
        eval(patchedBindingsText);
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'WASM bindings loaded via eval' });
        
        // Now load the WASM module
        const wasmResponse = await self.fetch(`${basePath}mcp_browser_client_bg.wasm`);
        if (!wasmResponse.ok) {
            throw new Error(`Failed to fetch WASM module: ${wasmResponse.status} ${wasmResponse.statusText}`);
        }
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'WASM module fetched successfully' });
        const wasmBytes = await wasmResponse.arrayBuffer();
        
        // Log the WASM module size
        const wasmSize = wasmBytes.byteLength;
        const wasmSizeKB = (wasmSize / 1024).toFixed(2);
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: `WASM module size: ${wasmSizeKB} KB` });
        
        // Initialize WASM module with correct call
        await self.wasm_bindgen(wasmBytes);
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'WASM module instantiated successfully' });
        
        // All exported functions are now on self.wasm_bindgen
        wasmInstance = self.wasm_bindgen;
        wasmModule = null; // Not used in this pattern
        
        // Get build info and version
        const buildInfo = wasmInstance.get_compiled_info();
        
        // Broadcast initialization
        broadcastToClients({
            type: 'wasm_initialized',
            size: wasmSizeKB,
            buildInfo: buildInfo
        });
        
        // Broadcast status with metadata
        // (Note: broadcastWasmStatus should be handled in sw.js)
        // broadcastWasmStatus(true, 0, {
        //     timestamp: new Date().toISOString(),
        //     version: version,
        //     buildInfo: buildInfo
        // });
        
        // Start uptime counter
        startUptimeCounter();
        
        // Add initial memory event - only if we're in a window context
        if (typeof window !== 'undefined') {
            try {
                await wasmInstance.add_memory_event(`WASM module initialized (${wasmSizeKB} KB)`);
            } catch (e) {
                console.error('Error adding memory event:', e);
            }
        }
        
        // Broadcast success
        broadcastToClients({
            type: 'log',
            content: {
                level: 'INFO',
                message: `WASM module initialized successfully (${wasmSizeKB} KB)`,
                timestamp: new Date().toISOString()
            }
        });
        
        // (Note: broadcastWasmStatus should be handled in sw.js)
        // broadcastWasmStatus(true);
        
        if (wasmInstance && typeof wasmInstance.set_debug_mode === 'function') {
            wasmInstance.set_debug_mode(isDebugMode);
        }
        
        // Set the WASM server URL to match localStorage (or default)
        let url = 'http://localhost:8081';
        try {
            url = (await self.clients.matchAll({type: 'window'}))[0]?.url;
            // Try to get from localStorage if available
            if (typeof self.localStorage !== 'undefined' && self.localStorage.getItem) {
                const stored = self.localStorage.getItem('mcpServerUrl');
                if (stored) url = stored;
            }
        } catch (e) {
            // fallback to default
        }
        if (wasmInstance && typeof wasmInstance.set_server_url === 'function') {
            wasmInstance.set_server_url(url);
        }
        
        return true;
    } catch (error) {
        const errorMessage = `WASM initialization failed: ${error.message}`;
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: errorMessage });
        broadcastToClients({
            type: 'log',
            content: {
                level: 'ERROR',
                message: errorMessage,
                timestamp: new Date().toISOString()
            }
        });
        
        // (Note: broadcastWasmStatus should be handled in sw.js)
        // broadcastWasmStatus(false);
        
        return false;
    } finally {
        isInitializing = false;
    }
}

// MOVED FROM sw.js
// Unload WASM module
export function unloadWasm() {
    if (wasmInstance) {
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Unloading WASM module..." });
        // Stop uptime counter
        stopUptimeCounter();

        wasmInstance = null;
        wasmModule = null;
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "WASM module unloaded" });
        broadcastToClients({
            type: 'log',
            content: {
                level: 'INFO',
                message: 'WASM module unloaded',
                timestamp: new Date().toISOString()
            }
        });
        
        // (Note: broadcastWasmStatus should be handled in sw.js)
        // broadcastWasmStatus(false);
    }
}

// MOVED FROM sw.js
// Start uptime counter
export function startUptimeCounter() {
    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Starting uptime counter" });
    stopUptimeCounter(); // Clear any existing interval
    
    let lastLogTime = 0;
    uptimeInterval = setInterval(() => {
        if (wasmInstance) {
            try {
                wasmInstance.increment_uptime();
                const uptime = Number(wasmInstance.get_uptime());
                const currentTime = Date.now();
                
                // Log uptime based on mode:
                // - Debug mode: every second
                // - Normal mode: every minute
                const logInterval = 60000;
                if (currentTime - lastLogTime >= logInterval) {
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = uptime % 60;
                    const formattedUptime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    const logMessage = isDebugMode ? "Uptime updated" : "Uptime check";
                    broadcastToClients({
                        type: 'log',
                        content: {
                            level: isDebugMode ? 'DEBUG' : 'INFO',
                            message: `${logMessage}: ${formattedUptime}`,
                            timestamp: new Date().toISOString()
                        }
                    });
                    lastLogTime = currentTime;
                }
                
                if (isDebugMode && currentTime - lastLogTime >= 60000) {
                    broadcastToClients({
                        type: 'uptime',
                        uptime: uptime
                    });
                }
            } catch (error) {
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: "Failed to update uptime", data: { 
                    error: error.message,
                    stack: error.stack
                } });
            }
        }
    }, 1000);
}

// MOVED FROM sw.js
// Stop uptime counter
export function stopUptimeCounter() {
    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Stopping uptime counter" });
    if (uptimeInterval) {
        clearInterval(uptimeInterval);
        uptimeInterval = null;
    }
}

// MOVED FROM sw.js
// Reload WASM module
export async function reloadWasm() {
    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Reloading WASM module..." });
    try {
        // First unload the existing instance
        unloadWasm();
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Previous WASM instance unloaded" });
        
        // Initialize new instance
        const success = await initializeWasm();
        if (success) {
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "WASM module reloaded successfully" });
            // Get fresh metadata
            const buildInfo = wasmInstance.get_compiled_info();
            
            // Broadcast success with metadata
            broadcastToClients({
                type: 'log',
                content: {
                    level: 'INFO',
                    message: 'WASM module reloaded successfully',
                    timestamp: new Date().toISOString()
                }
            });
            
            // (Note: broadcastWasmStatus should be handled in sw.js)
            // broadcastWasmStatus(true, 0, {
            //     timestamp: new Date().toISOString(),
            //     version: version,
            //     buildInfo: buildInfo
            // });
        } else {
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: 'Failed to reload WASM module' });
            broadcastToClients({
                type: 'log',
                content: {
                    level: 'ERROR',
                    message: 'Failed to reload WASM module',
                    timestamp: new Date().toISOString()
                }
            });
            broadcastToClients({
                type: 'wasm_status',
                healthy: false
            });
        }
    } catch (error) {
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: `Error during WASM reload: ${JSON.stringify({ error: error.message, stack: error.stack })}` });
        broadcastToClients({
            type: 'log',
            content: {
                level: 'ERROR',
                message: `Error during WASM reload: ${error.message}`,
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'wasm_status',
            healthy: false
        });
    }
} 