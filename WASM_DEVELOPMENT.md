# WASM Development Rules

## Adding New WASM Functionality

When adding new functionality to the WASM module, follow these steps in order:

1. **Rust Implementation** (`src/lib.rs`):
   ```rust
   #[wasm_bindgen]
   pub fn my_new_function() -> Result<String, JsValue> {
       // Implementation
       Ok("result".to_string())
   }
   ```

2. **Service Worker Integration** (`public/sw.js`):
   - Add function to `wasmInstance` handling
   - Add appropriate debug logging
   - Add error handling
   ```javascript
   // In the message handler:
   case 'my_new_function':
       if (!wasmInstance) {
           throw new Error('WASM module not initialized');
       }
       try {
           const result = await wasmInstance.my_new_function();
           broadcastToClients({
               type: 'my_new_function_result',
               result: result
           });
       } catch (error) {
           debugLog('My new function failed', { error: error.message });
       }
       break;
   ```

3. **Client-Side Integration** (`public/index.html`):
   - Add UI elements if needed
   - Add message handling
   - Add status updates
   ```javascript
   // In handleServiceWorkerMessage:
   case 'my_new_function_result':
       // Handle the result
       this.updateUIWithResult(message.result);
       break;
   ```

## Message Flow Pattern

1. **Client to Service Worker**:
   ```javascript
   // In index.html
   this.serviceWorker.postMessage({
       type: 'my_new_function',
       params: { /* any parameters */ }
   });
   ```

2. **Service Worker to WASM**:
   ```javascript
   // In sw.js
   const result = await wasmInstance.my_new_function();
   ```

3. **WASM to Service Worker**:
   ```rust
   // In lib.rs
   #[wasm_bindgen]
   pub fn my_new_function() -> Result<String, JsValue> {
       Ok("result".to_string())
   }
   ```

4. **Service Worker to Client**:
   ```javascript
   // In sw.js
   broadcastToClients({
       type: 'my_new_function_result',
       result: result
   });
   ```

## Status Updates Pattern

1. **Service Worker Status Broadcast**:
   ```javascript
   // In sw.js
   broadcastToClients({
       type: 'status_update',
       status: {
           healthy: true,
           metadata: {
               version: wasmInstance.get_version(),
               buildInfo: wasmInstance.get_compiled_info()
           }
       }
   });
   ```

2. **Client Status Handling**:
   ```javascript
   // In index.html
   case 'status_update':
       this.updateStatus(message.status);
       break;
   ```

## Error Handling Pattern

1. **WASM Level**:
   ```rust
   // In lib.rs
   #[wasm_bindgen]
   pub fn my_function() -> Result<String, JsValue> {
       if error_condition {
           return Err(JsValue::from_str("Error message"));
       }
       Ok("success".to_string())
   }
   ```

2. **Service Worker Level**:
   ```javascript
   // In sw.js
   try {
       const result = await wasmInstance.my_function();
       // Handle success
   } catch (error) {
       debugLog('Function failed', { error: error.message });
       broadcastToClients({
           type: 'error',
           message: error.message
       });
   }
   ```

3. **Client Level**:
   ```javascript
   // In index.html
   case 'error':
       this.log({
           level: 'ERROR',
           message: message.message,
           timestamp: new Date().toISOString()
       });
       break;
   ```

## Testing New Functionality

1. **Build and Test**:
   ```bash
   ./wasm-build.sh
   ```

2. **Clear Service Worker**:
   - Open Chrome DevTools
   - Go to Application tab
   - Click Service Workers
   - Click Unregister
   - Check "Bypass for network"

3. **Clear Cache**:
   - In DevTools Application tab
   - Click Clear storage
   - Click Clear site data

4. **Hard Refresh**:
   - Hold Shift and click refresh
   - Or use Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows)

## Debugging Tips

1. **Service Worker Logs**:
   - Check Chrome DevTools Console
   - Look for `[SW v1.0.0]` prefixed messages

2. **WASM Status**:
   - Monitor the status indicators in the UI
   - Check the uptime counter
   - Verify build info is displayed

3. **Message Flow**:
   - Use Chrome DevTools Network tab
   - Check "Disable cache"
   - Monitor message passing

## Common Issues

1. **WASM Not Initialized**:
   - Check service worker registration
   - Verify WASM module loading
   - Check for initialization errors

2. **Message Not Received**:
   - Verify message type matches
   - Check service worker is active
   - Ensure proper error handling

3. **Status Not Updated**:
   - Verify broadcast is called
   - Check client message handling
   - Ensure UI update functions exist 