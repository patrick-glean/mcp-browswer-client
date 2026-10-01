//! Initialization-based revisions (2025-03-26 through 2025-11-25): an `initialize` handshake,
//! then an optional `Mcp-Session-Id` and the negotiated version on every request.

use super::transport::{self, interpret_reply};
use super::types::*;
use crate::logging;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub version: String,
    pub session_id: Option<String>,
    pub capabilities: Value,
    pub server_info: Option<Value>,
    pub instructions: Option<String>,
}

pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": LEGACY_VERSIONS[0],
        "capabilities": {},
        "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION }
    })
}

/// Reads the server's answer to `initialize`. The server picks the version; 2024-11-05 is
/// accepted because some Streamable HTTP servers still report it.
pub fn parse_initialize(result: &Value, session_id: Option<String>) -> Result<Session, McpError> {
    let version = result
        .get("protocolVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| McpError::new(ErrorKind::InvalidResponse, "The server's initialize reply has no protocolVersion."))?;
    if !LEGACY_VERSIONS.contains(&version) && version != "2024-11-05" {
        return Err(McpError::new(
            ErrorKind::UnsupportedVersion,
            format!("The server chose protocol version {version}, which this client doesn't support."),
        ));
    }
    Ok(Session {
        version: version.to_string(),
        session_id,
        capabilities: result.get("capabilities").cloned().unwrap_or_else(|| json!({})),
        server_info: result.get("serverInfo").cloned(),
        instructions: result.get("instructions").and_then(Value::as_str).map(String::from),
    })
}

pub fn session_headers(version: &str, session_id: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![("MCP-Protocol-Version".to_string(), version.to_string())];
    if let Some(id) = session_id {
        headers.push(("Mcp-Session-Id".to_string(), id.to_string()));
    }
    headers
}

pub async fn initialize(url: &str, auth: &[(String, String)]) -> Result<Session, McpError> {
    let body = request_body(next_request_id(), "initialize", initialize_params());
    let reply = transport::post(url, auth, &body, CONNECT_TIMEOUT_MS).await?;
    let result = interpret_reply(&reply)?;
    let session = parse_initialize(&result, reply.session_id.clone())?;
    let sessions = if session.session_id.is_some() { "opened a session" } else { "doesn't use sessions" };
    logging::debug(url, &format!("The server chose MCP {} and {sessions}", session.version));

    let mut headers = auth.to_vec();
    headers.extend(session_headers(&session.version, session.session_id.as_deref()));
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    match transport::post(url, &headers, &initialized, CONNECT_TIMEOUT_MS).await {
        Ok(reply) if reply.status < 300 => {}
        Ok(reply) => logging::warn(url, &format!("notifications/initialized got HTTP {}", reply.status)),
        Err(err) => logging::warn(url, &format!("Couldn't send notifications/initialized: {}", err.message)),
    }
    Ok(session)
}

/// Adds advice to a failed legacy request when the likely cause is a session the browser
/// never saw: CORS hides `Mcp-Session-Id` unless the server lists it in
/// `Access-Control-Expose-Headers`.
pub fn explain_missing_session(mut err: McpError, had_session: bool) -> McpError {
    if !had_session && err.status == Some(400) {
        err.message.push_str(
            " If this server uses sessions, it must expose the Mcp-Session-Id header to browsers (Access-Control-Expose-Headers).",
        );
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_the_newest_legacy_version() {
        assert_eq!(initialize_params()["protocolVersion"], LEGACY_VERSIONS[0]);
        assert_eq!(initialize_params()["clientInfo"]["name"], CLIENT_NAME);
    }

    #[test]
    fn accepts_the_version_the_server_picks() {
        let result = json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": { "name": "Old", "version": "0.9" }
        });
        let session = parse_initialize(&result, Some("abc".into())).unwrap();
        assert_eq!(session.version, "2025-06-18");
        assert_eq!(session.session_id.as_deref(), Some("abc"));
        assert_eq!(session.server_info, Some(json!({ "name": "Old", "version": "0.9" })));
    }

    #[test]
    fn rejects_unknown_or_missing_versions() {
        assert_eq!(parse_initialize(&json!({ "protocolVersion": "1999-01-01" }), None).unwrap_err().kind, ErrorKind::UnsupportedVersion);
        assert_eq!(parse_initialize(&json!({}), None).unwrap_err().kind, ErrorKind::InvalidResponse);
    }

    #[test]
    fn sends_the_session_only_when_there_is_one() {
        assert_eq!(session_headers("2025-11-25", None), vec![("MCP-Protocol-Version".to_string(), "2025-11-25".to_string())]);
        assert_eq!(session_headers("2025-11-25", Some("s1"))[1], ("Mcp-Session-Id".to_string(), "s1".to_string()));
    }

    #[test]
    fn hints_at_cors_when_a_session_was_probably_hidden() {
        let err = McpError::new(ErrorKind::Protocol, "Bad Request: No valid session ID provided").with_status(400);
        assert!(explain_missing_session(err.clone(), false).message.contains("Access-Control-Expose-Headers"));
        assert_eq!(explain_missing_session(err.clone(), true), err);
    }
}
