# MCP Implementation Rules and Progress

## Overview
This file tracks the implementation of the Model Context Protocol (MCP) in our service worker. The implementation is broken down into phases, with specific rules and requirements for each component. We are using the rust-mcp-schema as a reference implementation.

## Phase 1: Core Protocol Implementation

### 1. JSON-RPC Message Handler
**Status**: Not Started
**Priority**: High
**Rules**:
- All messages must follow JSON-RPC 2.0 specification
- Must support request/response pattern
- Must handle error cases according to spec
- Must maintain backward compatibility with existing message types
- Must implement message type separation (ClientMessage vs ServerMessage)

**Implementation Checklist**:
- [ ] Define MCPMessage interface based on rust-mcp-schema
- [ ] Implement message validation
- [ ] Add error handling
- [ ] Update existing message handlers
- [ ] Add tests for message handling
- [ ] Implement message type separation

**Reference Implementation**:
```typescript
// Based on rust-mcp-schema implementation
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

// Message type separation
type ClientMessage = Request | Notification;
type ServerMessage = Response | Notification;
```

### 2. Protocol Version Support
**Status**: Not Started
**Priority**: High
**Rules**:
- Must support version "2025-03-26"
- Must implement version negotiation
- Must handle version compatibility
- Must support protocol version constants

**Implementation Checklist**:
- [ ] Add version constants (LATEST_PROTOCOL_VERSION)
- [ ] Implement version negotiation
- [ ] Add compatibility checks
- [ ] Update initialization flow
- [ ] Add version tests

**Reference Implementation**:
```typescript
const LATEST_PROTOCOL_VERSION = "2025-03-26";
const JSONRPC_VERSION = "2.0";
```

### 3. Logging System
**Status**: Partially Implemented
**Priority**: High
**Rules**:
- Must support all MCP log levels
- Must maintain structured logging
- Must support debug mode
- Must preserve existing logging functionality
- Must implement log level hierarchy

**Implementation Checklist**:
- [x] Basic logging structure
- [x] Debug mode support
- [ ] Add all MCP log levels (debug to emergency)
- [ ] Implement structured logging
- [ ] Add log level tests
- [ ] Update existing log calls

**Reference Implementation**:
```typescript
type LoggingLevel = 
    | "debug"
    | "info"
    | "notice"
    | "warning"
    | "error"
    | "critical"
    | "alert"
    | "emergency";
```

### 4. Memory Events
**Status**: Partially Implemented
**Priority**: High
**Rules**:
- Must track events with timestamps
- Must support event clearing
- Must maintain event history
- Must preserve existing memory event functionality
- Must implement event metadata support

**Implementation Checklist**:
- [x] Basic event tracking
- [x] Event clearing
- [ ] Add structured event format
- [ ] Implement event history
- [ ] Add event tests
- [ ] Update existing event handling

**Reference Implementation**:
```typescript
interface MemoryEvent {
    text: string;
    timestamp: string;
    metadata?: {
        [key: string]: unknown;
    };
}
```

## Integration Rules

### Service Worker Integration
**Rules**:
- Must maintain existing functionality
- Must handle both MCP and legacy messages
- Must preserve current broadcast mechanism
- Must support existing debug mode
- Must implement message type separation

### Client Integration
**Rules**:
- Must handle both MCP and legacy messages
- Must maintain current UI updates
- Must preserve existing event handling
- Must support debug mode toggle
- Must implement proper message routing

## Testing Requirements

### Protocol Tests
- [ ] Message validation
- [ ] Error handling
- [ ] Version negotiation
- [ ] Backward compatibility
- [ ] Message type separation

### Logging Tests
- [ ] Log level handling
- [ ] Debug mode
- [ ] Message formatting
- [ ] Client display
- [ ] Log level hierarchy

### Memory Event Tests
- [ ] Event tracking
- [ ] Event clearing
- [ ] History management
- [ ] Client updates
- [ ] Metadata handling

## Progress Tracking

### Current Phase
- Phase 1: Core Protocol Implementation
- Status: In Progress
- Next Steps: Implement JSON-RPC Message Handler with message type separation

### Completed Items
- Basic logging structure
- Debug mode support
- Basic memory event tracking
- Event clearing functionality

### Pending Items
- JSON-RPC message handler with type separation
- Protocol version support
- Enhanced logging system
- Structured memory events
- Message routing implementation

## Notes
- All new implementations must maintain backward compatibility
- Existing functionality should not be broken
- Debug mode must work with both old and new implementations
- Performance impact should be monitored
- Reference implementation: rust-mcp-schema
- Must implement proper message type separation (ClientMessage vs ServerMessage) 