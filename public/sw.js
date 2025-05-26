let wasmInstance = null;
let wasmModule = null;
let isRunning = true;
let uptimeInterval = null;

// Debug logging function
function debugLog(message, data = null) {
    if (!isRunning) return;
    const timestamp = new Date().toISOString();
    
    // Convert BigInt values to strings in the data object
    const safeData = data ? JSON.parse(JSON.stringify(data, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    )) : null;
    
    const logMessage = safeData 
        ? `[${timestamp}] ${message}: ${JSON.stringify(safeData, null, 2)}`
        : `[${timestamp}] ${message}`;
    
    broadcastToClients({
        type: 'log',
        content: {
            level: 'DEBUG',
            message: logMessage,
            timestamp: timestamp
        }
    });
}

// Initialize WASM module
async function initializeWasm() {
    try {
        debugLog("Initializing WASM module...");
        const response = await fetch('/mcp_client_bg.wasm');
        if (!response.ok) {
            throw new Error(`Failed to fetch WASM module: ${response.status} ${response.statusText}`);
        }
        debugLog("WASM module fetched successfully");
        
        const wasmBytes = await response.arrayBuffer();
        debugLog("WASM bytes loaded", { size: wasmBytes.byteLength });
        
        wasmModule = await WebAssembly.compile(wasmBytes);
        debugLog("WASM module compiled");
        
        wasmInstance = await WebAssembly.instantiate(wasmModule, {
            env: {
                log: (ptr, len) => {
                    const message = new TextDecoder().decode(new Uint8Array(wasmInstance.exports.memory.buffer, ptr, len));
                    try {
                        const logData = JSON.parse(message);
                        debugLog("WASM log received", logData);
                        broadcastToClients({
                            type: 'log',
                            content: logData
                        });
                    } catch (e) {
                        debugLog("Error parsing WASM log", { error: e.message, rawMessage: message });
                        broadcastToClients({
                            type: 'log',
                            content: {
                                level: 'ERROR',
                                message: `Failed to parse log message: ${message}`,
                                timestamp: new Date().toISOString()
                            }
                        });
                    }
                },
                get_timestamp: () => BigInt(Date.now())
            }
        });
        debugLog("WASM module instantiated", { 
            exports: Object.keys(wasmInstance.exports),
            memory: wasmInstance.exports.memory ? 'available' : 'unavailable'
        });

        // Start uptime counter after successful initialization
        startUptimeCounter();

        broadcastToClients({
            type: 'log',
            content: {
                level: 'INFO',
                message: 'WASM module initialized successfully',
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'wasm_status',
            healthy: true
        });
        return true;
    } catch (error) {
        debugLog("WASM initialization failed", { 
            error: error.message,
            stack: error.stack
        });
        broadcastToClients({
            type: 'log',
            content: {
                level: 'ERROR',
                message: `Failed to initialize WASM module: ${error.message}`,
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'wasm_status',
            healthy: false
        });
        return false;
    }
}

// Unload WASM module
function unloadWasm() {
    if (wasmInstance) {
        debugLog("Unloading WASM module...");
        // Stop uptime counter
        stopUptimeCounter();

        wasmInstance = null;
        wasmModule = null;
        debugLog("WASM module unloaded");
        broadcastToClients({
            type: 'log',
            content: {
                level: 'INFO',
                message: 'WASM module unloaded',
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'wasm_status',
            healthy: false
        });
    }
}

// Start uptime counter
function startUptimeCounter() {
    debugLog("Starting uptime counter");
    stopUptimeCounter(); // Clear any existing interval
    
    uptimeInterval = setInterval(() => {
        if (wasmInstance) {
            try {
                wasmInstance.exports.increment_uptime();
                const uptime = wasmInstance.exports.get_uptime();
                debugLog("Uptime updated", { uptime: uptime.toString() });
                broadcastToClients({
                    type: 'uptime',
                    uptime: Number(uptime)
                });
            } catch (error) {
                debugLog("Failed to update uptime", { 
                    error: error.message,
                    stack: error.stack
                });
                broadcastToClients({
                    type: 'log',
                    content: {
                        level: 'ERROR',
                        message: `Failed to update uptime: ${error.message}`,
                        timestamp: new Date().toISOString()
                    }
                });
            }
        }
    }, 1000);
}

// Stop uptime counter
function stopUptimeCounter() {
    debugLog("Stopping uptime counter");
    if (uptimeInterval) {
        clearInterval(uptimeInterval);
        uptimeInterval = null;
    }
    broadcastToClients({
        type: 'uptime',
        uptime: 0
    });
}

// Reload WASM module
async function reloadWasm() {
    debugLog("Reloading WASM module...");
    unloadWasm();
    await initializeWasm();
}

// Check WASM module status
function checkWasm() {
    debugLog("Checking WASM module status...");
    if (wasmInstance) {
        try {
            const versionPtr = wasmInstance.exports.get_version();
            const version = new TextDecoder().decode(new Uint8Array(wasmInstance.exports.memory.buffer, versionPtr, 50));
            const uptime = wasmInstance.exports.get_uptime();
            
            debugLog("WASM check successful", { 
                version, 
                uptime: uptime.toString() 
            });
            broadcastToClients({
                type: 'log',
                content: {
                    level: 'INFO',
                    message: `WASM module version: ${version}, uptime: ${uptime}s`,
                    timestamp: new Date().toISOString()
                }
            });
            broadcastToClients({
                type: 'wasm_status',
                healthy: true
            });
        } catch (error) {
            debugLog("WASM check failed", { 
                error: error.message,
                stack: error.stack
            });
            broadcastToClients({
                type: 'log',
                content: {
                    level: 'ERROR',
                    message: `WASM module check failed: ${error.message}`,
                    timestamp: new Date().toISOString()
                }
            });
            broadcastToClients({
                type: 'wasm_status',
                healthy: false
            });
        }
    } else {
        debugLog("WASM module not loaded");
        broadcastToClients({
            type: 'log',
            content: {
                level: 'ERROR',
                message: 'WASM module not loaded',
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'wasm_status',
            healthy: false
        });
    }
}

// Check MCP server health
async function checkMcp() {
    debugLog("Checking MCP server health...");
    if (!wasmInstance) {
        debugLog("Cannot check MCP: WASM module not loaded");
        broadcastToClients({
            type: 'log',
            content: {
                level: 'ERROR',
                message: 'Cannot check MCP server: WASM module not loaded',
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'mcp_status',
            healthy: false
        });
        return;
    }

    try {
        debugLog("Executing WASM health check...");
        const result = wasmInstance.exports.health_check();
        debugLog("Health check result", { result });
        
        broadcastToClients({
            type: 'log',
            content: {
                level: 'INFO',
                message: `MCP server health check result: ${result === 0 ? 'healthy' : 'unhealthy'}`,
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'mcp_status',
            healthy: result === 0
        });
    } catch (error) {
        debugLog("Health check failed", { 
            error: error.message,
            stack: error.stack
        });
        broadcastToClients({
            type: 'log',
            content: {
                level: 'ERROR',
                message: `MCP server health check failed: ${error.message}`,
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'mcp_status',
            healthy: false
        });
    }
}

// Broadcast message to all clients
function broadcastToClients(message) {
    if (!isRunning) return;
    
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage(message);
        });
    });
}

// Handle messages from clients
self.addEventListener('message', async event => {
    if (!isRunning) return;

    const { type } = event.data;
    debugLog("Received message from client", { type });
    
    switch (type) {
        case 'check_wasm':
            checkWasm();
            break;
        case 'health_check':
            await checkMcp();
            break;
        case 'unload_wasm':
            unloadWasm();
            break;
        case 'reload_wasm':
            await reloadWasm();
            break;
        case 'stop':
            debugLog("Stopping service worker...");
            isRunning = false;
            stopUptimeCounter();
            unloadWasm();
            break;
    }
});

// Initialize on install
self.addEventListener('install', event => {
    debugLog("Service worker installing...");
    event.waitUntil(initializeWasm());
});

// Handle activation
self.addEventListener('activate', event => {
    debugLog("Service worker activating...");
    event.waitUntil(clients.claim());
});
