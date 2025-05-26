let wasmInstance;
let debugMode = true;
let uptimeInterval;

function debugLog(message, data = null) {
  if (!debugMode) return;
  const timestamp = new Date().toISOString();
  const logMessage = data 
    ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}`
    : `[${timestamp}] ${message}`;
  
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage(`DEBUG: ${logMessage}`);
    });
  });
}

self.addEventListener("install", (event) => {
  debugLog("Service Worker installing...");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  debugLog("Service Worker activating...");
  event.waitUntil(self.clients.claim());
});

// Function to handle logging from WASM
function logFromWasm(ptr, len) {
  const memory = new Uint8Array(wasmInstance.exports.memory.buffer, ptr, len);
  const text = new TextDecoder().decode(memory);
  try {
    const logEntry = JSON.parse(text);
    debugLog("WASM Log", logEntry);
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage(`WASM_LOG: ${text}`);
      });
    });
  } catch (e) {
    debugLog("Error parsing WASM log", { error: e.message, text });
  }
}

// Function to provide timestamp to WASM
function getTimestamp() {
  return BigInt(Date.now());
}

function startUptimeCounter() {
  if (uptimeInterval) {
    clearInterval(uptimeInterval);
  }
  
  uptimeInterval = setInterval(() => {
    if (wasmInstance) {
      wasmInstance.exports.increment_uptime();
      const uptime = wasmInstance.exports.get_uptime();
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage(`UPTIME: ${uptime}`);
        });
      });
    }
  }, 1000);
}

async function initializeWasm() {
  if (!wasmInstance) {
    debugLog("Initializing WASM module...");
    try {
      const response = await fetch("/mcp_client_bg.wasm");
      const bytes = await response.arrayBuffer();
      debugLog("WASM binary loaded", { size: bytes.byteLength });
      
      const { instance } = await WebAssembly.instantiate(bytes, {
        env: {
          log_js: logFromWasm,
          get_timestamp_js: () => Number(Date.now())
        }
      });
      wasmInstance = instance;
      debugLog("WASM module initialized successfully");

      // Get version info
      const versionPtr = instance.exports.get_version();
      const versionMemory = new Uint8Array(instance.exports.memory.buffer, versionPtr);
      const nullIndex = versionMemory.indexOf(0);
      const versionText = new TextDecoder().decode(versionMemory.slice(0, nullIndex));
      debugLog("WASM Module Version", { version: versionText });

      // Start the uptime counter
      startUptimeCounter();
    } catch (error) {
      debugLog("WASM initialization failed", { error: error.message });
      throw error;
    }
  }
  return wasmInstance;
}

self.addEventListener("message", async (event) => {
  const client = event.source;
  const message = event.data;

  debugLog("Received message", { 
    type: message === "HEALTH_CHECK" ? "health_check" : "message",
    content: message 
  });

  try {
    const instance = await initializeWasm();

    if (message === "HEALTH_CHECK") {
      debugLog("Executing WASM health check...");
      const result = instance.exports.health_check();
      debugLog("Health check result", { success: result === 0 });
      
      if (result === 0) {
        client.postMessage("Health check completed successfully");
      } else {
        client.postMessage("Health check failed");
      }
      return;
    }

    debugLog("Processing message through WASM...");
    const encoder = new TextEncoder();
    const payload = encoder.encode(message);
    const ptr = instance.exports.alloc(payload.length);
    const memory = new Uint8Array(instance.exports.memory.buffer, ptr, payload.length);
    memory.set(payload);

    debugLog("Calling WASM handle_message", { 
      messageLength: payload.length,
      pointer: ptr 
    });

    const result = instance.exports.handle_message(ptr, payload.length);
    
    debugLog("Message processing result", { success: result === 0 });
    
    if (result === 0) {
      client.postMessage(`Message sent to MCP server: ${message}`);
    } else {
      client.postMessage(`Error processing message: ${message}`);
    }
  } catch (error) {
    debugLog("Error in message handling", { 
      error: error.message,
      stack: error.stack 
    });
    client.postMessage(`Error: ${error.message}`);
  }
});
