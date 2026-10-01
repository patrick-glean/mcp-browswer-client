//! The error type every export rejects with; it crosses into JavaScript as JSON.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// fetch() rejected: the server is down, CORS blocked the request, or the browser's
    /// local network permission was denied.
    Network,
    Timeout,
    /// The server wants a (new) sign-in or token.
    AuthRequired,
    /// Signing in failed: discovery, registration, the authorization response or the token
    /// exchange went wrong.
    AuthFailed,
    Http,
    Protocol,
    UnsupportedVersion,
    InvalidResponse,
    Internal,
}

/// An error the UI can explain.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl McpError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        McpError { kind, message: message.into(), status: None, code: None, data: None }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            json!({ "kind": "internal", "message": self.message }).to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_for_javascript() {
        let json: Value = serde_json::from_str(&McpError::new(ErrorKind::AuthRequired, "Sign in").with_status(401).to_json()).unwrap();
        assert_eq!(json, json!({ "kind": "auth_required", "message": "Sign in", "status": 401 }));
        let failed: Value = serde_json::from_str(&McpError::new(ErrorKind::AuthFailed, "No").to_json()).unwrap();
        assert_eq!(failed["kind"], "auth_failed");
    }
}
