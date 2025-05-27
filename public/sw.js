let wasmInstance = null;
let wasmModule = null;
let isRunning = true;
let uptimeInterval = null;
let isDebugMode = false;

// Debug logging function
function debugLog(message, data = null) {
    if (!isRunning) return;
    
    const timestamp = new Date().toISOString();
    
    // Convert BigInt values to strings in the data object
    const safeData = data ? JSON.parse(JSON.stringify(data, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    )) : null;
    
    const logMessage = safeData 
        ? `[SW] [${timestamp}] ${message}: ${JSON.stringify(safeData, null, 2)}`
        : `[SW] [${timestamp}] ${message}`;
    
    // Always log errors and important messages
    const isImportant = message.includes('WASM') || message.includes('Error') || message.includes('Failed');
    
    if (isImportant || isDebugMode) {
        broadcastToClients({
            type: 'log',
            content: {
                level: isDebugMode ? 'DEBUG' : 'INFO',
                message: logMessage,
                timestamp: timestamp
            }
        });
    }
}

// Initialize WASM module
async function initializeWasm() {
    try {
        debugLog('Initializing WASM module...');
        
        // Fetch the wasm-bindgen JS file
        const bindingsResponse = await self.fetch('/mcp_browser_client.js');
        if (!bindingsResponse.ok) {
            throw new Error(`Failed to fetch WASM bindings: ${bindingsResponse.status} ${bindingsResponse.statusText}`);
        }
        debugLog('WASM bindings fetched successfully');
        const bindingsText = await bindingsResponse.text();
        
        // Replace window references with self
        const patchedBindingsText = bindingsText
            .replace(/^let wasm_bindgen;/, 'self.wasm_bindgen = undefined;')
            .replace(/window\./g, 'self.');
        eval(patchedBindingsText);
        debugLog('WASM bindings loaded via eval');
        
        // Now load the WASM module
        const wasmResponse = await self.fetch('/mcp_browser_client_bg.wasm');
        if (!wasmResponse.ok) {
            throw new Error(`Failed to fetch WASM module: ${wasmResponse.status} ${wasmResponse.statusText}`);
        }
        debugLog('WASM module fetched successfully');
        const wasmBytes = await wasmResponse.arrayBuffer();
        
        // Initialize WASM module with new format
        await self.wasm_bindgen(wasmBytes);
        debugLog('WASM module instantiated successfully');
        
        // All exported functions are now on self.wasm_bindgen
        wasmInstance = self.wasm_bindgen;
        wasmModule = null; // Not used in this pattern
        
        // Start uptime counter
        startUptimeCounter();
        
        // Add initial memory event - only if we're in a window context
        if (typeof window !== 'undefined') {
            try {
                await wasmInstance.add_memory_event('WASM module initialized');
            } catch (e) {
                console.error('Error adding memory event:', e);
            }
        }
        
        // Broadcast success
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
        const errorMessage = `WASM initialization failed: ${error.message}`;
        debugLog(errorMessage);
        broadcastToClients({
            type: 'log',
            content: {
                level: 'ERROR',
                message: errorMessage,
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
    
    let lastLogTime = 0;
    uptimeInterval = setInterval(() => {
        if (wasmInstance) {
            try {
                wasmInstance.increment_uptime();
                const uptime = wasmInstance.get_uptime();
                const currentTime = Date.now();
                
                // Log uptime based on mode:
                // - Debug mode: every second
                // - Normal mode: every minute
                const logInterval = isDebugMode ? 1000 : 60000;
                if (currentTime - lastLogTime >= logInterval) {
                    const logMessage = isDebugMode ? "Uptime updated" : "Uptime check";
                    broadcastToClients({
                        type: 'log',
                        content: {
                            level: isDebugMode ? 'DEBUG' : 'INFO',
                            message: `${logMessage}: ${uptime.toString()} seconds`,
                            timestamp: new Date().toISOString()
                        }
                    });
                    lastLogTime = currentTime;
                }
                
                // Update UI counter based on mode:
                // - Debug mode: every second
                // - Normal mode: every minute
                if (isDebugMode || currentTime - lastLogTime >= 60000) {
                    broadcastToClients({
                        type: 'uptime',
                        uptime: Number(uptime)
                    });
                }
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
async function checkWasm(checkId) {
    try {
        if (!wasmInstance) {
            throw new Error('WASM module not initialized');
        }
        // Call a WASM function to verify the module is healthy
        const healthy = await wasmInstance.health_check();
        const uptime = await wasmInstance.get_uptime();
        
        // Single broadcast with all the information
        broadcastToClients({
            type: 'wasm_status',
            healthy: healthy === 0, // 0 means healthy in our WASM module
            uptime: Number(uptime),
            checkId: checkId,
            metadata: {
                timestamp: new Date().toISOString(),
                version: wasmInstance.get_version()
            }
        });
        
        return healthy === 0;
    } catch (error) {
        debugLog('WASM check failed:', { error: error.message, stack: error.stack, checkId });
        console.error('WASM module check failed:', error.message);
        broadcastToClients({
            type: 'wasm_status',
            healthy: false,
            uptime: 0,
            checkId: checkId,
            metadata: {
                timestamp: new Date().toISOString(),
                version: 'unknown'
            }
        });
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
        const result = await wasmInstance.health_check();
        debugLog("Health check result", { result });
        
        // Parse the result to determine health status
        const isHealthy = result === 0; // 0 means healthy in our WASM module
        
        broadcastToClients({
            type: 'log',
            content: {
                level: 'INFO',
                message: `MCP server health check result: ${isHealthy ? 'healthy' : 'unhealthy'}`,
                timestamp: new Date().toISOString()
            }
        });
        broadcastToClients({
            type: 'mcp_status',
            healthy: isHealthy
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

    const { type, data = {} } = event.data;  // Provide default empty object for data
    debugLog("Received message from client", { type, data });
    
    switch (type) {
        case 'set_debug_mode':
            isDebugMode = data.enabled;
            debugLog("Debug mode updated", { enabled: isDebugMode });
            break;
        case 'check_wasm':
            // Only check if WASM is initialized
            if (!wasmInstance) {
                debugLog("WASM not initialized yet, initializing...", { checkId: data?.checkId });
                await initializeWasm();
            }
            checkWasm(data?.checkId);  // Use optional chaining
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
