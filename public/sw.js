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

// Broadcast WASM status to all clients
function broadcastWasmStatus(healthy, uptime = null, metadata = null) {
    const statusMessage = {
        jsonrpc: '2.0',
        method: 'wasm_status',
        params: {
            status: {
                healthy: healthy,
                uptime: uptime || 0
            },
            metadata: metadata || {
                timestamp: new Date().toISOString(),
                version: wasmInstance ? wasmInstance.get_version() : 'unknown'
            }
        }
    };
    broadcastToClients(statusMessage);
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
        
        // Log the WASM module size
        const wasmSize = wasmBytes.byteLength;
        const wasmSizeKB = (wasmSize / 1024).toFixed(2);
        debugLog(`WASM module size: ${wasmSizeKB} KB`);
        
        // Initialize WASM module with correct call
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
        
        // Broadcast initial status
        broadcastWasmStatus(true);
        
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
        
        // Broadcast error status
        broadcastWasmStatus(false);
        
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
        
        // Broadcast unloaded status
        broadcastWasmStatus(false);
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
                const uptime = Number(wasmInstance.get_uptime());
                const currentTime = Date.now();
                
                // Log uptime based on mode:
                // - Debug mode: every second
                // - Normal mode: every minute
                const logInterval = isDebugMode ? 1000 : 60000;
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
                
                // Update UI counter based on mode:
                // - Debug mode: every second
                // - Normal mode: every minute
                if (isDebugMode || currentTime - lastLogTime >= 60000) {
                    broadcastToClients({
                        type: 'uptime',
                        uptime: uptime
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

// MCP Message Handler class
class MCPMessageHandler {
    constructor() {
        this.debugMode = false;
    }

    setDebugMode(enabled) {
        this.debugMode = enabled;
    }

    async handleMessage(message) {
        try {
            if (!wasmInstance) {
                throw new Error('WASM module not initialized');
            }

            const response = await wasmInstance.handle_message(message);
            const parsedResponse = JSON.parse(response);
            
            // Forward WASM logs to UI
            if (parsedResponse.logs) {
                parsedResponse.logs.forEach(log => {
                    broadcastToClients({
                        type: 'log',
                        content: {
                            level: log.level || 'INFO',
                            message: log.message,
                            timestamp: log.timestamp || new Date().toISOString()
                        }
                    });
                });
            }
            
            // If this is a health check response, verify the status
            if (parsedResponse.result && parsedResponse.result.status) {
                const isHealthy = parsedResponse.result.status === 'healthy';
                broadcastToClients({
                    type: 'mcp_status',
                    healthy: isHealthy
                });
            }
            
            return response;
        } catch (error) {
            debugLog('MCP message handling failed', { error: error.message });
            return JSON.stringify({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: error.message
                }
            });
        }
    }
}

// Initialize MCP message handler
const mcpHandler = new MCPMessageHandler();
mcpHandler.setDebugMode(isDebugMode);

// Handle messages from clients
self.addEventListener('message', async (event) => {
    const message = event.data;
    
    // Handle MCP messages
    if (message.jsonrpc === '2.0') {
        const response = await mcpHandler.handleMessage(JSON.stringify(message));
        event.source.postMessage(JSON.parse(response));
        return;
    }

    // Handle legacy messages
    switch (message.type) {
        case 'check-wasm':
        case 'check_wasm':
            await checkWasm(message.checkId);
            break;
        case 'initialize-wasm':
            await initializeWasm();
            break;
        case 'set-debug-mode':
            isDebugMode = message.enabled;
            mcpHandler.setDebugMode(isDebugMode);
            break;
        case 'health_check':
            // Use proper JSON-RPC format for health check
            const healthCheckMessage = {
                jsonrpc: '2.0',
                method: 'health_check',
                params: {},
                id: Date.now()
            };
            const response = await mcpHandler.handleMessage(JSON.stringify(healthCheckMessage));
            const result = JSON.parse(response);
            if (result.error) {
                broadcastToClients({
                    type: 'mcp_status',
                    healthy: false
                });
            } else {
                broadcastToClients({
                    type: 'mcp_status',
                    healthy: result.result.status === 'healthy'
                });
            }
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
            if (wasmInstance && message && message.text) {
                try {
                    await wasmInstance.add_memory_event(message.text);
                    debugLog("Memory event added", { text: message.text });
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
        default:
            console.warn('Unknown message type:', message.type);
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

// Check WASM module health
async function checkWasm(checkId) {
    try {
        if (!wasmInstance) {
            throw new Error('WASM module not initialized');
        }

        // Use the basic health check that doesn't depend on MCP server
        const healthy = await wasmInstance.health_check();
        const uptime = await wasmInstance.get_uptime();
        
        // Broadcast status with current uptime
        // 0 means healthy in our WASM module
        broadcastWasmStatus(healthy === 0, uptime);

    } catch (error) {
        console.error('WASM module check failed:', error);
        broadcastWasmStatus(false);
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
        debugLog("Executing MCP server health check...");
        const result = await wasmInstance.check_mcp_server();
        debugLog("MCP server health check result", { result });
        
        // Parse the result to determine health status
        const isHealthy = result === 0; // 0 means healthy in our WASM module
        
        // Broadcast detailed log message
        broadcastToClients({
            type: 'log',
            content: {
                level: 'INFO',
                message: `MCP server health check completed: ${isHealthy ? 'healthy' : 'unhealthy'}`,
                timestamp: new Date().toISOString()
            }
        });
        
        // Broadcast status
        broadcastToClients({
            type: 'mcp_status',
            healthy: isHealthy
        });
    } catch (error) {
        debugLog("MCP server health check failed", { 
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
