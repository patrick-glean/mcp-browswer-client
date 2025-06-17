let wasmInstance = null;
let wasmModule = null;
let isRunning = true;
let uptimeInterval = null;
let isDebugMode = true;
let isInitializing = false;

// --- TAP Config Storage ---
let currentTapConfig = {};

// --- Memory/Imprints Store ---
let currentImprints = [];

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


// Add this near the top of sw.js
async function initialWasmBroadcast() {
    const wasmState = await checkWasm();
    broadcastWasmStatus(wasmState);
}


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

// --- MCP Servers Index ---
const mcpServersIndex = {};

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
                // Update mcpServersIndex to match client structure
                if (!mcpServersIndex[url]) mcpServersIndex[url] = { url };
                mcpServersIndex[url].tools = parsedResult.result.tools;
                broadcastToClients({
                    type: 'tools_list',
                    tools: parsedResult.result.tools,
                    url,
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
                const errorMsg = {
                    type: 'tool_result',
                    error: 'WASM module not loaded',
                    engramId: message.engramId || null,
                    requestId: message.requestId || null,
                    source: 'console'
                };
                if (message.engramId && message.requestId && event.source && event.source.id) {
                    engramNAT.set(message.engramId, event.source.id);
                    sendToEngramClient(message.engramId, errorMsg);
                } else if (event?.source) {
                    event.source.postMessage(errorMsg);
                } else {
                    broadcastToClients(errorMsg);
                }
                break;
            }
            // Only use message.tapConfig if present, do NOT fall back to currentTapConfig
            await handleToolCall({ source: 'console', tapConfig: message.tapConfig, message, event, memory: currentImprints });
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
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'ERROR', message: 'This should not happen in service worker: cbus_message', data: message });
            break;
        case 'cbus_send_message':
            if (message && message.text) {
                const msg = {
                    text: message.text,
                    role: message.role || 'user',
                    timestamp: Date.now(),
                    engramId: message.engramId || null
                };
                broadcastToClients({
                    type: 'cbus_message',
                    message: msg
                });
                // --- Persist user message ---
                await persistEngramMessage(msg);

                // --- After persisting, trigger tool call if CBus Tap is configured ---
                try {
                    const tapConfig = currentTapConfig || {};
                    if (tapConfig.serverUrl && tapConfig.toolName && (tapConfig.connectedStringArg || tapConfig.connectedArrayArg)) {
                        // Load full engram history
                        const { messages: engramMessages = [] } = await handleOp('load', msg.engramId, null) || {};
                        await handleToolCall({ source: 'tap', tapConfig, message: msg, engramMessages, memory: currentImprints });
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
                // Load the engram's messages from IndexedDB
                let engramId = message?.engramId;
                if (!engramId && event.source) {
                    // Try to get engramId from NAT table if available
                    // (Optional: you may want to pass engramId explicitly from the client)
                }
                if (engramId) {
                    const { messages = [] } = await handleOp('load', engramId, null) || {};
                    event.source.postMessage({
                        type: 'cbus_queue',
                        queue: messages
                    });
                } else {
                    // If no engramId, send empty queue
                    event.source.postMessage({
                        type: 'cbus_queue',
                        queue: []
                    });
                }
            }
            break;
        case 'set_tap_config':
            currentTapConfig = message.tapConfig || {};
            debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: 'Received TAP config from client', data: currentTapConfig });
            return;
        case 'update_memory':
            if (Array.isArray(message.imprints)) {
                currentImprints = message.imprints;
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: '[SW] Updated memory/imprints', data: { count: currentImprints.length, imprints: currentImprints } });
            }
            break;
        case 'init_mcp_servers_index':
            if (message.servers && typeof message.servers === 'object') {
                Object.assign(mcpServersIndex, message.servers);
                debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: '[SW] Initialized mcpServersIndex from client', data: { keys: Object.keys(mcpServersIndex) } });
            }
            break;
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
    event.waitUntil(initialWasmBroadcast());
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

// --- JSON-RPC Extraction Helper ---
/**
 * Extracts all JSON-RPC objects from code blocks in a text blob (handles escaped quotes).
 * Returns an array of parsed JSON objects.
 */
function extractJsonRpcCalls(text) {
    const results = [];
    if (!text || typeof text !== 'string') return results;
    // Regex to match ```json ... ``` or ``` ... ```
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        let code = match[1].trim();
        // Try to unescape if needed (handles double-escaped quotes)
        try {
            // Try as-is
            let obj = JSON.parse(code);
            if (obj && obj.jsonrpc === '2.0' && typeof obj.method === 'string') {
                results.push(obj);
                continue;
            }
        } catch (e) {}
        try {
            // Try unescaping quotes (for escaped JSON in markdown)
            let unescaped = code.replace(/\\"/g, '"');
            let obj = JSON.parse(unescaped);
            if (obj && obj.jsonrpc === '2.0' && typeof obj.method === 'string') {
                results.push(obj);
            }
        } catch (e) {}
    }
    return results;
}

// --- Tool Call Dispatch Helper ---
async function maybeCallExtractedTool(jsonRpcObj, engramId, tapConfig) {
    // Prevent tool loop: don't call back to the tap target
    if (tapConfig && tapConfig.toolName && jsonRpcObj.method === tapConfig.toolName) {
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: '[SW] Skipping tool call to avoid loop', data: { method: jsonRpcObj.method } });
        return;
    }
    // Only handle tool calls (method should match a known tool)
    // You can add more business logic here
    if (jsonRpcObj && jsonRpcObj.method && jsonRpcObj.jsonrpc === '2.0') {
        // Dispatch as a tool call
        // You may want to map method to a server/tool here
        // For now, just log and broadcast
        debugLog({ source: 'ServiceWorker', type: 'log', level: 'INFO', message: '[SW] Dispatching extracted tool call', data: jsonRpcObj });
        // TODO: Actually dispatch tool call (e.g., call handleToolCall or similar)
        // Example: await handleToolCall({ source: 'extracted', tapConfig: null, message: { ...jsonRpcObj, engramId }, event: null, engramMessages: null, memory: null });
        // For now, just broadcast to clients for visibility
        broadcastToClients({ type: 'extracted_tool_call', engramId, toolCall: jsonRpcObj });
    }
}

// --- Unified Tool Call Handler ---
/**
 * Handles all tool calls, routing results to the correct output.
 * @param {Object} opts - Options for the tool call.
 * @param {'tap'|'console'} opts.source - Source of the tool call.
 * @param {Object} opts.tapConfig - Tap config (if any).
 * @param {Object} opts.message - The original message triggering the call.
 * @param {Object} opts.event - The event (for client routing).
 * @param {Array} [opts.engramMessages] - Engram history (if any).
 * @param {Array} [opts.memory] - Memory/imprints (if any).
 */
async function handleToolCall({ source, tapConfig, message, event, engramMessages, memory }) {
    // Use only tapConfig for all tool call parameters
    const toolArgs = { ...(tapConfig.args || {}) };
    const connectedStringArg = tapConfig.connectedStringArg;
    const connectedArrayArg = tapConfig.connectedArrayArg;
    if ((connectedStringArg || connectedArrayArg) && message.engramId) {
        if (!engramMessages) {
            const loaded = await handleOp('load', message.engramId, null) || {};
            engramMessages = loaded.messages || [];
        }

        // Hardened memory injection
        if (Array.isArray(memory) && memory.length > 0) {
            // Insert all imprints except the first (bootrom) as memory messages
            for (const imprint of memory.slice(1)) {
                if (imprint && typeof imprint.text === 'string' && imprint.text.trim()) {
                    engramMessages.unshift({ text: imprint.text, role: 'memory', timestamp: Date.now() });
                }
            }

            // insert a json encoded servers list
            engramMessages.unshift({ text: JSON.stringify(mcpServersIndex), role: 'memory', timestamp: Date.now() });


            // Insert bootrom if it exists and has text
            const bootrom = memory[0];
            if (bootrom && typeof bootrom.text === 'string' && bootrom.text.trim()) {
                engramMessages.unshift({ text: bootrom.text, role: 'memory', timestamp: Date.now() });
            }
        }

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
            if (connectedArrayArg) toolArgs[connectedArrayArg] = engramMessages.slice(0, -1).map(msg => msg.text);
        }
    }
    debugLog({ source: 'ServiceWorker', type: 'log', level: 'DEBUG', message: '[handleToolCall] Calling tool', data: { tapConfig, toolArgs, requestId: message.requestId, source } });
    let result;
    try {
        result = await wasmInstance.call_tool(
            tapConfig.serverUrl,
            tapConfig.toolName,
            toolArgs
        );
    } catch (err) {
        const errorMsg = {
            type: 'tool_result',
            error: err.message || String(err),
            source,
            engramId: message.engramId || null,
            requestId: message.requestId || null
        };
        if (message.engramId && message.requestId) {
            sendToEngramClient(message.engramId, errorMsg);
        } else if (event?.source) {
            event.source.postMessage(errorMsg);
        } else {
            broadcastToClients(errorMsg);
        }
        return;
    }
    let parsedResult;
    try {
        parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
    } catch (e) {
        parsedResult = { text: '[Tool returned invalid JSON]' };
    }
    // --- Extract and dispatch tool calls from tool output ---
    let toolText = extractToolResponseText(parsedResult);
    let extractedCalls = extractJsonRpcCalls(toolText);
    if (Array.isArray(extractedCalls) && extractedCalls.length > 0) {
        for (const call of extractedCalls) {
            await maybeCallExtractedTool(call, message.engramId || null, tapConfig);
        }
    }
    // For tap/auto, also create a cbus_message and persist
    if (source === 'tap') {
        const toolMsg = {
            text: toolText,
            role: 'tool',
            timestamp: Date.now(),
            engramId: message.engramId || null
        };
        // Only send cbus_message to the correct client/engram
        if (message.engramId && message.requestId) {
            sendToEngramClient(message.engramId, { type: 'cbus_message', message: toolMsg });
        } else if (event?.source) {
            event.source.postMessage({ type: 'cbus_message', message: toolMsg });
        } else {
            broadcastToClients({ type: 'cbus_message', message: toolMsg });
        }
        await persistEngramMessage(toolMsg);
    }
    // Route tool_result strictly
    const resultMsg = {
        type: 'tool_result',
        result: parsedResult,
        source,
        engramId: message.engramId || null,
        requestId: message.requestId || null
    };
    if (message.engramId && message.requestId) {
        sendToEngramClient(message.engramId, resultMsg);
    } else if (event?.source) {
        event.source.postMessage(resultMsg);
    } else {
        broadcastToClients(resultMsg);
    }
}
