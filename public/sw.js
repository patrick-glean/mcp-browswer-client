let wasmInstance = null;
let wasmModule = null;
let isRunning = true;
let uptimeInterval = null;
let isDebugMode = true;
let isInitializing = false;
let cbusQueue = [];

// --- TAP Config Storage ---
let currentTapConfig = {};

const VERSION = '1.0.0';
const BUILD_TIME = new Date().toISOString();

import { handleOp, initDB, openDB } from './chatStorage.js';
import { debugLog } from './logger.js';
import {
    checkWasm,
    initializeWasm,
    reloadWasm,
    unloadWasm,
    startUptimeCounter,
    stopUptimeCounter,
    getWasmInstance,
    setDebugMode as setWasmDebugMode,
    setBroadcast as setWasmBroadcast
} from './wasm.js';

// Set up broadcast for wasm.js
setWasmBroadcast(broadcastToClients);

// Broadcast WASM status to all clients
function broadcastWasmStatus(wasmState) {

    const statusMessage = {
        jsonrpc: '2.0',
        method: 'wasm_status',
        params: {
            status: {
                healthy: wasmState.healthy,
                uptime: wasmState.uptime || 0
            },
            metadata: {
                timestamp: new Date().toISOString(),
                metadataVersion: wasmState.metadata || 'unknown',
                buildInfo: wasmState.buildInfo || 'unknown'
            }
        }
    };
    broadcastToClients(statusMessage);
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
            wasmInstance = getWasmInstance();
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
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: 'MCP message handling failed', data: { error: error.message } });
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

// --- Engram NAT Table ---
const engramNAT = new Map(); // engramId -> clientId

// --- UUIDv7 generator (browser-compatible, minimal) ---
function uuidv7() {
    // UUIDv7: 48 bits unix timestamp ms, 74 bits random
    const now = Date.now();
    const unixTs = now;
    const tsHex = unixTs.toString(16).padStart(12, '0'); // 48 bits = 12 hex chars
    // 74 bits random = 19 hex chars (but UUID is 36 chars with dashes)
    const rand = crypto.getRandomValues(new Uint8Array(10));
    let randHex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
    randHex = randHex.padEnd(20, '0');
    // Compose UUIDv7: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
    // Use timestamp for first 12 hex, then version, then random
    const uuid = [
        tsHex.slice(0, 8),
        tsHex.slice(8, 12),
        '7' + randHex.slice(0, 3),
        (8 + (rand[3] & 0x3)).toString(16) + randHex.slice(3, 6),
        randHex.slice(6, 18)
    ].join('-');
    return uuid;
}

// --- DRY helper for engram message persistence ---
async function persistEngramMessage(msg) {
    if (!msg.engramId) return;
    const storedMsg = {
        ...msg,
        id: uuidv7(),
        timestamp: msg.timestamp || Date.now(),
    };
    const db = await (await initDB(), openDB());
    const convStore = db.transaction('conversations', 'readonly').objectStore('conversations');
    const getReq = convStore.get(storedMsg.engramId);
    const exists = await new Promise(resolve => {
        getReq.onsuccess = () => resolve(!!getReq.result);
        getReq.onerror = () => resolve(false);
    });
    if (!exists) {
        await handleOp('store', storedMsg.engramId, {
            meta: { created: Date.now(), engramId: storedMsg.engramId },
            messages: [storedMsg]
        });
    } else {
        await handleOp('append', storedMsg.engramId, { message: storedMsg });
    }
}

// Handle messages from clients
self.addEventListener('message', async (event) => {
    const message = event.data;
    // --- TOP LEVEL EVENT LOGGING ---
    const logObj = debugLog({
        source: 'ServiceWorker',
        type: 'log',
        level: 'DEBUG',
        message: '[SW] Top-level event received',
        data: message
    });
    // Broadcast log to clients
    broadcastToClients(logObj);
    
    // Handle MCP messages
    if (message.jsonrpc === '2.0') {
        const response = await mcpHandler.handleMessage(JSON.stringify(message));
        event.source.postMessage(JSON.parse(response));
        return;
    }

    wasmInstance = getWasmInstance();

    // Handle legacy messages
    switch (message.type) {
        case 'check-wasm':
        case 'check_wasm':
            const wasmState = await checkWasm(message.checkId);
            broadcastWasmStatus(wasmState);
            break;
        case 'initialize-wasm':
            await initializeWasm();
            break;
        case 'initialize-mcp':
            if (!wasmInstance) {
                broadcastToClients({
                    type: 'log',
                    content: {
                        level: 'ERROR',
                        message: 'Cannot initialize MCP server: WASM module not loaded',
                        timestamp: new Date().toISOString()
                    }
                });
                break;
            }
            try {
                const result = await wasmInstance.initialize_mcp_server(message.url);
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'Raw MCP initialization result', data: { result } });
                const parsedResult = JSON.parse(result);
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'Parsed MCP initialization result', data: { 
                    status: parsedResult.status,
                    message: parsedResult.message,
                    has_server_info: !!parsedResult.server_info,
                    server_info: parsedResult.server_info
                } });
                broadcastToClients({
                    type: 'log',
                    content: {
                        level: parsedResult.status === 'success' ? 'INFO' : 'ERROR',
                        message: parsedResult.message,
                        timestamp: new Date().toISOString()
                    }
                });
                if (parsedResult.status === 'success') {
                    broadcastToClients({
                        type: 'mcp_server_initialized',
                        server: parsedResult.server_info
                    });
                }
            } catch (error) {
                broadcastToClients({
                    type: 'log',
                    content: {
                        level: 'ERROR',
                        message: `Failed to initialize MCP server: ${error.message}`,
                        timestamp: new Date().toISOString()
                    }
                });
            }
            break;
        case 'get-server-info':
            if (!wasmInstance) {
                broadcastToClients({
                    type: 'log',
                    content: {
                        level: 'ERROR',
                        message: 'Cannot get server info: WASM module not loaded',
                        timestamp: new Date().toISOString()
                    }
                });
                break;
            }
            try {
                const result = await wasmInstance.get_server_info();
                const parsedResult = JSON.parse(result);
                broadcastToClients({
                    type: 'server_info',
                    info: parsedResult
                });
            } catch (error) {
                broadcastToClients({
                    type: 'log',
                    content: {
                        level: 'ERROR',
                        message: `Failed to get server info: ${error.message}`,
                        timestamp: new Date().toISOString()
                    }
                });
            }
            break;
        case 'set-debug-mode':
            isDebugMode = message.enabled;
            mcpHandler.setDebugMode(isDebugMode);
            if (wasmInstance && typeof wasmInstance.set_debug_mode === 'function') {
                wasmInstance.set_debug_mode(isDebugMode);
            }
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
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Stopping service worker..." });
            isRunning = false;
            stopUptimeCounter();
            unloadWasm();
            break;
        case 'add_memory_event':
            if (wasmInstance && message && message.text) {
                try {
                    await wasmInstance.add_memory_event(message.text);
                    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Memory event added", data: { text: message.text } });
                } catch (error) {
                    debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: "Failed to add memory event", data: { 
                        error: error.message,
                        stack: error.stack
                    } });
                }
            }
            break;
        case 'clear_memory_events':
            if (wasmInstance) {
                try {
                    await wasmInstance.clear_memory_events();
                    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Memory events cleared" });
                } catch (error) {
                    debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: "Failed to clear memory events", data: { 
                        error: error.message,
                        stack: error.stack
                    } });
                }
            }
            break;
        case 'list_tools':
            if (!wasmInstance) {
                throw new Error('WASM module not initialized');
            }
            try {
                const url = message.url || get_server_url();
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: '[SW] [list_tools] Received URL:', data: url });
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'Listing tools from', data: url });
                // Let the WASM module handle the MCP protocol
                const result = await wasmInstance.list_tools(url);
                const parsedResult = JSON.parse(result);
                if (parsedResult.error) {
                    throw new Error(`Failed to list tools: ${parsedResult.error.message}`);
                }
                broadcastToClients({
                    type: 'tools_list',
                    tools: parsedResult.result.tools,
                    url // include the url for UI sync
                });
            } catch (error) {
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: 'Error listing tools:', data: error });
                broadcastToClients({
                    type: 'log',
                    content: {
                        level: 'ERROR',
                        message: `Failed to list tools: ${error.message}`,
                        timestamp: new Date().toISOString()
                    }
                });
            }
            break;
        case 'call_tool':
            if (!wasmInstance) {
                // Send error to the correct client if possible
                if (message.engramId && message.requestId && event.source && event.source.id) {
                    engramNAT.set(message.engramId, event.source.id);
                    sendToEngramClient(message.engramId, {
                        type: 'tool_result',
                        error: 'WASM module not loaded',
                        engramId: message.engramId,
                        requestId: message.requestId
                    });
                } else {
                    broadcastToClients({
                        type: 'tool_result',
                        error: 'WASM module not loaded'
                    });
                }
                break;
            }
            try {
                // Store engramId -> clientId mapping
                if (message.engramId && event.source && event.source.id) {
                    engramNAT.set(message.engramId, event.source.id);
                }
                let toolArgs = { ...message.args };
                let connectedStringArg = null;
                let connectedArrayArg = null;
                // Try to get tap config from message or currentTapConfig
                let tapConfig = message.tapConfig || currentTapConfig || {};
                if (message.connectedStringArg) {
                    connectedStringArg = message.connectedStringArg;
                } else if (tapConfig.connectedStringArg) {
                    connectedStringArg = tapConfig.connectedStringArg;
                }
                if (message.connectedArrayArg) {
                    connectedArrayArg = message.connectedArrayArg;
                } else if (tapConfig.connectedArrayArg) {
                    connectedArrayArg = tapConfig.connectedArrayArg;
                }
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'CBus Tap config used in call_tool', data: tapConfig });
                if (connectedStringArg || connectedArrayArg) {
                    const { messages: engramMessages = [] } = await handleOp('load', message.engramId, null) || {};
                    if (engramMessages.length === 1) {
                        if (connectedStringArg) toolArgs[connectedStringArg] = engramMessages[0].text;
                        if (connectedArrayArg) toolArgs[connectedArrayArg] = [];
                    } else if (engramMessages.length > 1) {
                        if (connectedStringArg) {
                            let template = toolArgs[connectedStringArg];
                            const latestMsg = engramMessages[engramMessages.length - 1].text;
                            if (typeof template === 'string' && template.includes('{{cbus_message}}')) {
                                toolArgs[connectedStringArg] = template.replace(/{{cbus_message}}/g, latestMsg);
                            } else if (typeof template === 'string' && template.length > 0) {
                                toolArgs[connectedStringArg] = template;
                            } else {
                                toolArgs[connectedStringArg] = latestMsg;
                            }
                        }
                        if (connectedArrayArg) toolArgs[connectedArrayArg] = engramMessages.slice(0, -1);
                    }
                }
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'CBus Tap: About to call tool', data: {
                    serverUrl: tapConfig.serverUrl,
                    toolName: tapConfig.toolName,
                    toolArgs,
                    requestId: message.requestId
                } });
                const result = await wasmInstance.call_tool(
                    tapConfig.serverUrl || message.url,
                    tapConfig.toolName || message.toolName,
                    toolArgs
                );
                const parsedResult = JSON.parse(result);
                if (message.engramId && message.requestId) {
                    sendToEngramClient(message.engramId, {
                        type: 'tool_result',
                        result: parsedResult,
                        engramId: message.engramId,
                        requestId: message.requestId
                    });
                } else {
                    broadcastToClients({
                        type: 'tool_result',
                        result: parsedResult
                    });
                }
                // --- Echo tool response to CBus queue ---
                const cbusMsg = {
                    text: extractToolResponseText(parsedResult),
                    role: 'tool',
                    timestamp: Date.now(),
                    engramId: message.engramId || null
                };
                cbusQueue.push(cbusMsg);
                if (cbusQueue.length > 1000) cbusQueue.shift();
                broadcastToClients({
                    type: 'cbus_message',
                    message: cbusMsg
                });
                // --- Persist tool message ---
                await persistEngramMessage(cbusMsg);
            } catch (error) {
                if (message.engramId && message.requestId) {
                    sendToEngramClient(message.engramId, {
                        type: 'tool_result',
                        error: error.message || String(error),
                        engramId: message.engramId,
                        requestId: message.requestId
                    });
                } else {
                    broadcastToClients({
                        type: 'tool_result',
                        error: error.message || String(error)
                    });
                }
            }
            break;
        case 'get_bootrom':
            if (!wasmInstance) {
                event.source.postMessage({
                    type: 'bootrom',
                    error: 'WASM module not loaded'
                });
                break;
            }
            try {
                const bootromJson = wasmInstance.get_bootrom();
                const bootrom = JSON.parse(bootromJson);
                event.source.postMessage({
                    type: 'bootrom',
                    bootrom
                });
            } catch (error) {
                event.source.postMessage({
                    type: 'bootrom',
                    error: error.message
                });
            }
            break;
        case 'cbus_message':
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'REMOVE ---- CBus Tap: cbus_message', data: message });
            break;
        case 'cbus_send_message':
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'REMOVE ---- CBus Tap: cbus_send_message', data: message });
            if (message && message.text) {
                const msg = {
                    text: message.text,
                    role: message.role || 'user',
                    timestamp: Date.now(),
                    engramId: message.engramId || null
                };
                cbusQueue.push(msg);
                if (cbusQueue.length > 1000) cbusQueue.shift();
                broadcastToClients({
                    type: 'cbus_message',
                    message: msg
                });
                // --- Persist user message ---
                await persistEngramMessage(msg);

                // --- After persisting, trigger tool call if CBus Tap is configured ---
                try {
                    const tapConfig = currentTapConfig || {};
                    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'CBus Tap config used in cbus_send_message', data: tapConfig });
                    if (tapConfig.serverUrl && tapConfig.toolName && (tapConfig.connectedStringArg || tapConfig.connectedArrayArg)) {
                        // Load full engram history
                        const { messages: engramMessages = [] } = await handleOp('load', msg.engramId, null) || {};
                        let toolArgs = { ...(tapConfig.args || {}) };
                        if (tapConfig.connectedStringArg) {
                            let template = toolArgs[tapConfig.connectedStringArg];
                            const latestMsg = engramMessages[engramMessages.length - 1]?.text || '';
                            if (typeof template === 'string' && template.includes('{{cbus_message}}')) {
                                toolArgs[tapConfig.connectedStringArg] = template.replace(/{{cbus_message}}/g, latestMsg);
                            } else if (typeof template === 'string' && template.length > 0) {
                                toolArgs[tapConfig.connectedStringArg] = template;
                            } else {
                                toolArgs[tapConfig.connectedStringArg] = latestMsg;
                            }
                        }
                        if (tapConfig.connectedArrayArg) {
                            toolArgs[tapConfig.connectedArrayArg] = engramMessages.slice(0, -1);
                        }
                        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'CBus Tap: About to call tool (auto)', data: {
                            serverUrl: tapConfig.serverUrl,
                            toolName: tapConfig.toolName,
                            toolArgs
                        } });
                        await wasmInstance.call_tool(
                            tapConfig.serverUrl,
                            tapConfig.toolName,
                            toolArgs
                        );
                    }
                } catch (err) {
                    debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: 'CBus Tap tool call failed', data: { error: err.message } });
                }
            } else {
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'REMOVE ---- CBus Tap: No text in cbus_send_message' });
            }
            break;
        case 'cbus_subscribe':
            if (event.source) {
                event.source.postMessage({
                    type: 'cbus_queue',
                    queue: cbusQueue
                });
            }
            break;
        case 'set_tap_config':
            currentTapConfig = message.tapConfig || {};
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'Received TAP config from client', data: currentTapConfig });
            return;
        default:
            console.warn('Unknown message type:', message.type);
    }
});

// --- Send to engram client helper ---
function sendToEngramClient(engramId, message) {
    const clientId = engramNAT.get(engramId);
    if (clientId) {
        self.clients.get(clientId).then(client => {
            if (client) {
                client.postMessage(message);
            }
        });
    } else {
        // Fallback: broadcast if mapping missing
        broadcastToClients(message);
    }
}

// Initialize on install
self.addEventListener('install', event => {
    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Service worker installing..." });
    event.waitUntil(initializeWasm());
    event.waitUntil(initDB());
});

// Handle activation
self.addEventListener('activate', event => {
    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Service worker activating..." });
    event.waitUntil(clients.claim());
});


// Check MCP server health
async function checkMcp() {
    wasmInstance = getWasmInstance();
    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Checking MCP server health..." });
    if (!wasmInstance) {
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Cannot check MCP: WASM module not loaded" });
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
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "Executing MCP server health check..." });
        const result = await wasmInstance.check_mcp_server();
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: "MCP server health check result", data: { result } });
        
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
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: "MCP server health check failed", data: { 
            error: error.message,
            stack: error.stack
        } });
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

// self.addEventListener('fetch', event => {
//     console.log(`Service Worker v${VERSION} handling fetch: ${event.request.url}`);
//     event.respondWith(
//         fetch(event.request)
//             .catch(() => {
//                 return new Response('Service Worker is offline');
//             })
//     );
// });

// Helper to extract text from tool response
function extractToolResponseText(parsedResult) {
    if (parsedResult && parsedResult.result && Array.isArray(parsedResult.result.content)) {
        return parsedResult.result.content.map(c => c.text || '').join('\n');
    } else if (parsedResult && Array.isArray(parsedResult.content)) {
        return parsedResult.content.map(c => c.text || '').join('\n');
    } else if (Array.isArray(parsedResult)) {
        return parsedResult.map(c => c.text || '').join('\n');
    } else if (parsedResult && parsedResult.text) {
        return parsedResult.text;
    }
    return '[No content]';
}
