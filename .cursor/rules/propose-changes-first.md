# Propose Changes First

## Description
AI must propose changes and get user approval before making them.

## Rule
When making code changes, the AI must:
1. Explain what changes it wants to make
2. Show the exact code changes
3. Wait for user approval
4. Only then make the changes

## Example
```typescript
// Instead of directly making changes, first propose:
"I want to add logging to track the MCP initialization response. Here are the changes I propose:

1. In sw.js, add debug logs:
```javascript
const result = await wasmInstance.initialize_mcp_server(message.url);
debugLog('Raw MCP initialization result', { result });
const parsedResult = JSON.parse(result);
debugLog('Parsed MCP initialization result', { 
    status: parsedResult.status,
    message: parsedResult.message,
    has_server_info: !!parsedResult.server_info,
    server_info: parsedResult.server_info
});
```

Would you like me to proceed with these changes?"
``` 