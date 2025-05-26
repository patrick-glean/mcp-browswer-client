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
        debugLog('Initializing WASM module...');
        
        // Fetch the wasm-bindgen JS file
        const bindingsResponse = await fetch('/mcp_browser_client.js');
        debugLog('WASM bindings fetched successfully');
        const bindingsText = await bindingsResponse.text();
        
        // Replace 'let wasm_bindgen;' with 'self.wasm_bindgen = undefined;' so the IIFE assigns to self.wasm_bindgen
        const patchedBindingsText = bindingsText.replace(/^let wasm_bindgen;/, 'self.wasm_bindgen = undefined;');
        eval(patchedBindingsText);
        debugLog('WASM bindings loaded via eval');
        debugLog('typeof wasm_bindgen after eval', { type: typeof self.wasm_bindgen });
        debugLog('wasm_bindgen keys', { keys: Object.keys(self.wasm_bindgen || {}) });
        
        // Now load the WASM module
        const wasmResponse = await fetch('/mcp_browser_client_bg.wasm');
        debugLog('WASM module fetched successfully');
        const wasmBytes = await wasmResponse.arrayBuffer();
        debugLog(`WASM bytes loaded: ${JSON.stringify({ size: wasmBytes.byteLength })}`);
        
        // Try both .default and .init as initialization functions
        if (typeof self.wasm_bindgen.default === 'function') {
            await self.wasm_bindgen.default(wasmBytes);
            debugLog('WASM module instantiated successfully via wasm_bindgen.default');
        } else if (typeof self.wasm_bindgen.init === 'function') {
            await self.wasm_bindgen.init(wasmBytes);
            debugLog('WASM module instantiated successfully via wasm_bindgen.init');
        } else if (typeof self.wasm_bindgen === 'function') {
            await self.wasm_bindgen(wasmBytes);
            debugLog('WASM module instantiated successfully via wasm_bindgen (direct)');
        } else {
            throw new Error('No valid wasm_bindgen initialization function found');
        }
        
        // All exported functions are now on self.wasm_bindgen
        wasmInstance = self.wasm_bindgen;
        wasmModule = null; // Not used in this pattern
        
        // Start uptime counter
        startUptimeCounter();
        
        // Add initial memory event
        try {
            await wasmInstance.add_memory_event('WASM module initialized');
        } catch (e) {
            console.error('Error adding memory event:', e);
        }
        
        return true;
    } catch (error) {
        debugLog(`WASM initialization failed: ${JSON.stringify({ error: error.message, stack: error.stack })}`);
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
    
    let lastLogTime = 0;
    uptimeInterval = setInterval(() => {
        if (wasmInstance) {
            try {
                wasmInstance.increment_uptime();
                const uptime = wasmInstance.get_uptime();
                const currentTime = Date.now();
                
                // Only log to screen every 30 seconds
                if (currentTime - lastLogTime >= 30000) {
                    debugLog("Uptime updated", { uptime: uptime.toString() });
                    lastLogTime = currentTime;
                }
                
                // Always update the UI counter
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
    try {
        // First unload the existing instance
        unloadWasm();
        debugLog("Previous WASM instance unloaded");
        
        // Initialize new instance
        const success = await initializeWasm();
        if (success) {
            debugLog("WASM module reloaded successfully");
            broadcastToClients({
                type: 'log',
                content: {
                    level: 'INFO',
                    message: 'WASM module reloaded successfully',
                    timestamp: new Date().toISOString()
                }
            });
            broadcastToClients({
                type: 'wasm_status',
                healthy: true
            });
        } else {
            debugLog("Failed to reload WASM module");
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
        debugLog(`Error during WASM reload: ${JSON.stringify({ error: error.message, stack: error.stack })}`);
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

// Check WASM module status
async function checkWasm() {
    try {
        debugLog('Checking WASM module status...');
        if (!wasmInstance) {
            throw new Error('WASM module not initialized');
        }
        // Call a WASM function to verify the module is healthy
        const healthy = await wasmInstance.health_check();
        debugLog('WASM check result:', { healthy });
        return healthy;
    } catch (error) {
        debugLog('WASM check failed:', { error: error.message, stack: error.stack });
        console.error('WASM module check failed:', error.message);
        return false;
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
        const result = wasmInstance.health_check();
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

    const { type, data } = event.data;
    debugLog("Received message from client", { type, data });
    
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
        case 'add_memory_event':
            if (wasmInstance && data && data.text) {
                try {
                    await wasmInstance.add_memory_event(data.text);
                    debugLog("Memory event added", { text: data.text });
                } catch (error) {
                    debugLog("Failed to add memory event", { 
                        error: error.message,
                        stack: error.stack
                    });
                }
            }
            break;
        case 'clear_memory_events':
            if (wasmInstance) {
                try {
                    await wasmInstance.clear_memory_events();
                    debugLog("Memory events cleared");
                } catch (error) {
                    debugLog("Failed to clear memory events", { 
                        error: error.message,
                        stack: error.stack
                    });
                }
            }
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
