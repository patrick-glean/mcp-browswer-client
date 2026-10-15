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

/// What this client tells a server about itself: its name and version, plus whichever of the
/// optional fields (`title`, `description`, `websiteUrl`, `icons`) the service worker passed for
/// that server.
pub fn client_info(extra: Option<&Value>) -> Value {
    let mut info = serde_json::Map::new();
    info.insert("name".into(), json!(CLIENT_NAME));
    info.insert("version".into(), json!(CLIENT_VERSION));
    if let Some(extra) = extra {
        for key in ["title", "description", "websiteUrl"] {
            if let Some(text) = extra.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()) {
                info.insert(key.into(), json!(text));
            }
        }
        if let Some(icons) = extra.get("icons").filter(|icons| icons.as_array().is_some_and(|list| !list.is_empty())) {
            info.insert("icons".into(), icons.clone());
        }
    }
    Value::Object(info)
}

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
    fn introduces_the_client_with_only_the_fields_it_was_given() {
        assert_eq!(client_info(None), json!({ "name": CLIENT_NAME, "version": CLIENT_VERSION }));
        let extra = json!({
            "title": "MCP Browser Client",
            "description": "",
            "websiteUrl": "https://example.com/",
            "icons": [{ "src": "https://example.com/icon.svg" }],
            "name": "someone-else",
        });
        assert_eq!(
            client_info(Some(&extra)),
            json!({
                "name": CLIENT_NAME,
                "version": CLIENT_VERSION,
                "title": "MCP Browser Client",
                "websiteUrl": "https://example.com/",
                "icons": [{ "src": "https://example.com/icon.svg" }],
            })
        );
        assert_eq!(client_info(Some(&json!({ "icons": [] }))), client_info(None));
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
