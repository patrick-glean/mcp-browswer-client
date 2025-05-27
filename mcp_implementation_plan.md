# MCP Implementation Plan for Service Worker

## Phase 1: Core Protocol Implementation

### 1. JSON-RPC Message Handler
```typescript
interface MCPMessage {
    jsonrpc: "2.0";
    id?: string | number;
    method?: string;
    params?: any;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}
```

### 2. Protocol Version Support
- Implement version negotiation during initialization
- Support latest version: "2025-03-26"
- Add version compatibility checks

### 3. Logging System Integration
- Implement log levels (debug, info, warning, error)
- Add structured logging
- Support debug mode toggle
- Log message format:
```typescript
interface LogMessage {
    level: "debug" | "info" | "warning" | "error";
    message: string;
    timestamp: string;
    metadata?: any;
}
```

### 4. Memory Events System
- Track memory events with timestamps
- Support event clearing
- Event format:
```typescript
interface MemoryEvent {
    text: string;
    timestamp: string;
    metadata?: any;
}
```

## Implementation Details

### 1. Service Worker Modifications

#### Message Handler
```javascript
self.addEventListener('message', async event => {
    const message = event.data;
    
    // Handle MCP protocol messages
    if (message.jsonrpc === "2.0") {
        switch (message.method) {
            case "initialize":
                await handleInitialize(message);
                break;
            case "logging/setLevel":
                await handleSetLogLevel(message);
                break;
            case "memory/addEvent":
                await handleAddMemoryEvent(message);
                break;
            case "memory/clearEvents":
                await handleClearMemoryEvents(message);
                break;
        }
    }
});
```

#### Logging System
```javascript
const logLevels = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3
};

function log(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const logMessage = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
            level,
            message,
            timestamp,
            metadata
        }
    };
    broadcastToClients(logMessage);
}
```

#### Memory Events
```javascript
let memoryEvents = [];

async function addMemoryEvent(text, metadata = {}) {
    const event = {
        text,
        timestamp: new Date().toISOString(),
        metadata
    };
    memoryEvents.push(event);
    broadcastToClients({
        jsonrpc: "2.0",
        method: "notifications/memory/event",
        params: event
    });
}

function clearMemoryEvents() {
    memoryEvents = [];
    broadcastToClients({
        jsonrpc: "2.0",
        method: "notifications/memory/cleared"
    });
}
```

### 2. Client-Side Integration

#### Message Handler
```javascript
navigator.serviceWorker.addEventListener('message', event => {
    const message = event.data;
    
    if (message.jsonrpc === "2.0") {
        switch (message.method) {
            case "notifications/message":
                handleLogMessage(message.params);
                break;
            case "notifications/memory/event":
                handleMemoryEvent(message.params);
                break;
            case "notifications/memory/cleared":
                handleMemoryCleared();
                break;
        }
    }
});
```

## Testing Plan

### 1. Protocol Tests
- Test JSON-RPC message handling
- Verify version negotiation
- Check error handling

### 2. Logging Tests
- Test different log levels
- Verify debug mode toggle
- Check log message formatting

### 3. Memory Event Tests
- Test event addition
- Verify event clearing
- Check event history

## Next Steps

1. Implement basic JSON-RPC message handler in service worker
2. Add logging system with level support
3. Implement memory events system
4. Update client-side code to handle new message types
5. Add tests for new functionality
6. Document API and usage

## Integration with Existing Code

The new MCP implementation will integrate with our existing service worker code:

1. Extend the current message handling system
2. Add MCP-specific message types
3. Maintain backward compatibility
4. Use existing broadcast mechanism
5. Leverage current debug mode support 