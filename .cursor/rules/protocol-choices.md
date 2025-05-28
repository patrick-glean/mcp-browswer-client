# MCP Message Format Summary

Format depends on the transport layer:

## 1. JSON-RPC Format
- Used when transport is 'stdio', 'websocket', or other persistent streams.
- Suitable for bidirectional communication.
- Messages contain fields: jsonrpc, method, params, id, result, error.
- Example:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "clientInfo": { "name": "myClient" } }
}
```

## 2. HTTP Format
- Used when transport is 'http'.
- Suitable for stateless, one-off requests.
- Follows standard HTTP methods (GET, POST, etc.).
- Example:
```http
POST /mcp/initialize
{
  "clientInfo": { "name": "myClient" }
}
```

## Decision Rule
- If transport is a persistent stream → use JSON-RPC.
- If transport is stateless HTTP → use HTTP format.
