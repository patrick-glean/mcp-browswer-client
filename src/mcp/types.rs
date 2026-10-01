//! Protocol constants and JSON-RPC helpers shared by the MCP client.

pub use crate::error::{ErrorKind, McpError};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

/// The newest protocol revision; it carries version and capabilities in every request.
pub const MODERN_VERSION: &str = "2026-07-28";
/// Every modern revision this client speaks, newest first.
pub const MODERN_VERSIONS: &[&str] = &[MODERN_VERSION];
/// Initialization-based revisions this client falls back to, newest first.
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

pub const CLIENT_NAME: &str = "mcp-browser-client";
pub const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const HEADER_MISMATCH: i64 = -32020;
pub const MISSING_REQUIRED_CLIENT_CAPABILITY: i64 = -32021;
pub const UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;
pub const METHOD_NOT_FOUND: i64 = -32601;

pub const CONNECT_TIMEOUT_MS: i32 = 20_000;
pub const LIST_TIMEOUT_MS: i32 = 30_000;
pub const CALL_TIMEOUT_MS: i32 = 120_000;

impl McpError {
    pub fn from_rpc(error: RpcError, status: u16) -> Self {
        let kind = if error.code == UNSUPPORTED_PROTOCOL_VERSION {
            ErrorKind::UnsupportedVersion
        } else {
            ErrorKind::Protocol
        };
        let message = if error.message.is_empty() {
            format!("The server returned JSON-RPC error {}.", error.code)
        } else {
            error.message
        };
        McpError { kind, message, status: Some(status), code: Some(error.code), data: error.data }
    }
}

/// A JSON-RPC error object from a server reply.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

pub fn rpc_error(message: &Value) -> Option<RpcError> {
    let error = message.get("error")?;
    Some(RpcError {
        code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
        message: error.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
        data: error.get("data").cloned(),
    })
}

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

pub fn next_request_id() -> u64 {
    NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn request_body(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_error_reads_code_message_and_data() {
        let reply = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "code": -32022, "message": "Unsupported protocol version", "data": { "supported": ["2026-07-28"] } }
        });
        let error = rpc_error(&reply).unwrap();
        assert_eq!(error.code, UNSUPPORTED_PROTOCOL_VERSION);
        assert_eq!(error.message, "Unsupported protocol version");
        assert_eq!(error.data, Some(json!({ "supported": ["2026-07-28"] })));
        assert!(rpc_error(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} })).is_none());
    }

    #[test]
    fn unsupported_version_errors_get_their_own_kind() {
        let error = McpError::from_rpc(
            RpcError { code: UNSUPPORTED_PROTOCOL_VERSION, message: String::new(), data: None },
            400,
        );
        assert_eq!(error.kind, ErrorKind::UnsupportedVersion);
        assert_eq!(error.status, Some(400));
        assert!(error.message.contains("-32022"));
    }
}
