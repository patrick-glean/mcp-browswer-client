let wasmInstance;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Function to handle logging from WASM
function logFromWasm(ptr, len) {
  const memory = new Uint8Array(wasmInstance.exports.memory.buffer, ptr, len);
  const text = new TextDecoder().decode(memory);
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage(`WASM Log: ${text}`);
    });
  });
}

self.addEventListener("message", async (event) => {
  const client = event.source;

  if (!wasmInstance) {
    const response = await fetch("/mcp_client_bg.wasm");
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: {
        log_js: logFromWasm
      }
    });
    wasmInstance = instance;
  }

  const text = event.data;
  const encoder = new TextEncoder();
  const payload = encoder.encode(text);
  const ptr = wasmInstance.exports.alloc(payload.length);
  const memory = new Uint8Array(wasmInstance.exports.memory.buffer, ptr, payload.length);
  memory.set(payload);

  const result = wasmInstance.exports.handle_message(ptr, payload.length);
  
  if (result === 0) {
    client.postMessage(`Message sent to MCP server: ${text}`);
  } else {
    client.postMessage(`Error processing message: ${text}`);
  }
});
