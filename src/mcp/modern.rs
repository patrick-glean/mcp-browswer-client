//! The 2026-07-28 ("modern") protocol: per-request `_meta`, mirrored headers and `server/discover`.

use super::headers::encode_header_value;
use super::transport::{self, describe_reply, http_error, HttpReply};
use super::types::*;
use crate::logging;
use serde_json::{json, Map, Value};

/// Adds the per-request protocol fields to `params`, keeping any `_meta` entries already there.
pub fn with_meta(params: Value, version: &str) -> Value {
    let mut params = match params {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let meta = params.entry("_meta").or_insert_with(|| json!({}));
    if !meta.is_object() {
        *meta = json!({});
    }
    if let Some(meta) = meta.as_object_mut() {
        meta.insert("io.modelcontextprotocol/protocolVersion".into(), json!(version));
        meta.insert(
            "io.modelcontextprotocol/clientInfo".into(),
            json!({ "name": CLIENT_NAME, "version": CLIENT_VERSION }),
        );
        meta.insert("io.modelcontextprotocol/clientCapabilities".into(), json!({}));
    }
    Value::Object(params)
}

/// The headers Streamable HTTP mirrors from the body: version, method and, for the three
/// name-addressed methods, the tool/prompt name or resource URI.
pub fn request_headers(method: &str, version: &str, params: &Value) -> Vec<(String, String)> {
    let mut headers = vec![
        ("MCP-Protocol-Version".to_string(), version.to_string()),
        ("Mcp-Method".to_string(), method.to_string()),
    ];
    let name = match method {
        "tools/call" | "prompts/get" => params.get("name"),
        "resources/read" => params.get("uri"),
        _ => None,
    };
    if let Some(name) = name.and_then(Value::as_str) {
        headers.push(("Mcp-Name".to_string(), encode_header_value(name)));
    }
    headers
}

/// What a `server/discover` probe says about the server.
#[derive(Debug, Clone, PartialEq)]
pub enum Probe {
    Modern(Value),
    /// A modern server that doesn't support the version we sent but supports this one.
    Retry(String),
    Legacy,
    Failed(McpError),
}

/// Decides the server's era from the reply to a modern request: a recognized modern error
/// means "modern, adjust and retry"; any other 4xx (or a non-modern JSON-RPC error) means legacy.
pub fn classify_probe(reply: &HttpReply, sent_version: &str) -> Probe {
    let status = reply.status;
    if let Some(message) = &reply.message {
        if let Some(result) = message.get("result") {
            if (200..300).contains(&status) {
                return Probe::Modern(result.clone());
            }
        }
        if let Some(error) = rpc_error(message) {
            match error.code {
                UNSUPPORTED_PROTOCOL_VERSION => return retry_or_fail(error, status, sent_version),
                HEADER_MISMATCH | MISSING_REQUIRED_CLIENT_CAPABILITY => {
                    return Probe::Failed(McpError::from_rpc(error, status));
                }
                // Modern servers answer unknown methods with 404 + -32601. Every modern server
                // must implement server/discover, but one that doesn't is still modern.
                METHOD_NOT_FOUND if status == 404 => return Probe::Modern(json!({})),
                _ => {}
            }
        }
    }
    match status {
        401 | 403 => Probe::Failed(http_error(reply)),
        200..=499 => Probe::Legacy,
        _ => Probe::Failed(http_error(reply)),
    }
}

fn retry_or_fail(error: RpcError, status: u16, sent_version: &str) -> Probe {
    let supported: Vec<String> = error
        .data
        .as_ref()
        .and_then(|d| d.get("supported"))
        .and_then(Value::as_array)
        .map(|versions| versions.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();
    if let Some(version) = MODERN_VERSIONS
        .iter()
        .find(|v| **v != sent_version && supported.iter().any(|s| s == *v))
    {
        return Probe::Retry(version.to_string());
    }
    if supported.iter().any(|s| LEGACY_VERSIONS.contains(&s.as_str())) {
        return Probe::Legacy;
    }
    let mut err = McpError::from_rpc(error, status);
    err.message = format!(
        "The server supports protocol versions {}, and this client supports {}.",
        if supported.is_empty() { "(none listed)".to_string() } else { supported.join(", ") },
        MODERN_VERSIONS.iter().chain(LEGACY_VERSIONS).copied().collect::<Vec<_>>().join(", ")
    );
    Probe::Failed(err)
}

/// What a modern server told us about itself.
#[derive(Debug, Clone, PartialEq)]
pub struct Discovery {
    pub capabilities: Value,
    pub server_info: Option<Value>,
    pub instructions: Option<String>,
}

pub fn parse_discovery(result: &Value) -> Discovery {
    Discovery {
        capabilities: result.get("capabilities").cloned().unwrap_or_else(|| json!({})),
        server_info: result
            .get("_meta")
            .and_then(|m| m.get("io.modelcontextprotocol/serverInfo"))
            .cloned(),
        instructions: result.get("instructions").and_then(Value::as_str).map(String::from),
    }
}

pub async fn discover(url: &str, version: &str, auth: &[(String, String)]) -> Result<Probe, McpError> {
    let params = with_meta(json!({}), version);
    let mut headers = auth.to_vec();
    headers.extend(request_headers("server/discover", version, &params));
    let body = request_body(next_request_id(), "server/discover", params);
    let reply = transport::post(url, &headers, &body, CONNECT_TIMEOUT_MS).await?;
    let probe = classify_probe(&reply, version);
    match &probe {
        Probe::Legacy => logging::info(
            url,
            &format!(
                "server/discover got {}, so this looks like a 2025-era server; falling back to the initialize handshake",
                describe_reply(&reply)
            ),
        ),
        Probe::Retry(next) => logging::info(url, &format!("The server doesn't accept MCP {version}; retrying with {next}")),
        Probe::Modern(_) | Probe::Failed(_) => {}
    }
    Ok(probe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, message: Option<Value>) -> HttpReply {
        HttpReply { status, message, ..HttpReply::default() }
    }

    fn error(code: i64, data: Value) -> Option<Value> {
        Some(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": code, "message": "x", "data": data } }))
    }

    #[test]
    fn adds_protocol_fields_and_keeps_existing_meta() {
        let params = with_meta(json!({ "name": "echo", "_meta": { "progressToken": 5 } }), MODERN_VERSION);
        assert_eq!(params["name"], "echo");
        assert_eq!(params["_meta"]["progressToken"], 5);
        assert_eq!(params["_meta"]["io.modelcontextprotocol/protocolVersion"], MODERN_VERSION);
        assert_eq!(params["_meta"]["io.modelcontextprotocol/clientInfo"]["name"], CLIENT_NAME);
        assert_eq!(params["_meta"]["io.modelcontextprotocol/clientCapabilities"], json!({}));
        assert!(with_meta(Value::Null, MODERN_VERSION)["_meta"].is_object());
    }

    #[test]
    fn mirrors_method_and_name_into_headers() {
        let call = request_headers("tools/call", MODERN_VERSION, &json!({ "name": "get_weather" }));
        assert_eq!(
            call,
            vec![
                ("MCP-Protocol-Version".to_string(), MODERN_VERSION.to_string()),
                ("Mcp-Method".to_string(), "tools/call".to_string()),
                ("Mcp-Name".to_string(), "get_weather".to_string()),
            ]
        );
        let read = request_headers("resources/read", MODERN_VERSION, &json!({ "uri": "file:///a b.txt" }));
        assert_eq!(read[2], ("Mcp-Name".to_string(), "file:///a b.txt".to_string()));
        assert_eq!(request_headers("tools/list", MODERN_VERSION, &json!({})).len(), 2);
    }

    #[test]
    fn a_discover_result_means_modern() {
        let result = json!({ "resultType": "complete", "supportedVersions": [MODERN_VERSION], "capabilities": { "tools": {} } });
        let probe = classify_probe(&reply(200, Some(json!({ "jsonrpc": "2.0", "id": 1, "result": result.clone() }))), MODERN_VERSION);
        assert_eq!(probe, Probe::Modern(result));
    }

    #[test]
    fn modern_errors_never_fall_back() {
        let mismatch = classify_probe(&reply(400, error(HEADER_MISMATCH, json!(null))), MODERN_VERSION);
        assert!(matches!(mismatch, Probe::Failed(e) if e.code == Some(HEADER_MISMATCH)));
        let capability = classify_probe(&reply(400, error(MISSING_REQUIRED_CLIENT_CAPABILITY, json!(null))), MODERN_VERSION);
        assert!(matches!(capability, Probe::Failed(_)));
        let no_discover = classify_probe(&reply(404, error(METHOD_NOT_FOUND, json!(null))), MODERN_VERSION);
        assert_eq!(no_discover, Probe::Modern(json!({})));
    }

    #[test]
    fn unsupported_version_retries_falls_back_or_fails() {
        let retry = classify_probe(
            &reply(400, error(UNSUPPORTED_PROTOCOL_VERSION, json!({ "supported": [MODERN_VERSION, "2025-11-25"] }))),
            "2099-01-01",
        );
        assert_eq!(retry, Probe::Retry(MODERN_VERSION.to_string()));
        let legacy_only = classify_probe(&reply(400, error(UNSUPPORTED_PROTOCOL_VERSION, json!({ "supported": ["2025-11-25"] }))), MODERN_VERSION);
        assert_eq!(legacy_only, Probe::Legacy);
        let future_only = classify_probe(&reply(400, error(UNSUPPORTED_PROTOCOL_VERSION, json!({ "supported": ["2027-01-01"] }))), MODERN_VERSION);
        match future_only {
            Probe::Failed(e) => {
                assert_eq!(e.kind, ErrorKind::UnsupportedVersion);
                assert!(e.message.contains("2027-01-01"));
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn anything_else_in_the_4xx_range_is_legacy() {
        // A 2025-era server rejecting a request that has no session.
        let no_session = Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32000, "message": "Bad Request: No valid session ID provided" } }));
        assert_eq!(classify_probe(&reply(400, no_session), MODERN_VERSION), Probe::Legacy);
        assert_eq!(classify_probe(&reply(400, None), MODERN_VERSION), Probe::Legacy);
        assert_eq!(classify_probe(&reply(404, None), MODERN_VERSION), Probe::Legacy);
        assert_eq!(classify_probe(&reply(405, None), MODERN_VERSION), Probe::Legacy);
        // A legacy server without session enforcement answers unknown methods with a 200.
        assert_eq!(classify_probe(&reply(200, error(METHOD_NOT_FOUND, json!(null))), MODERN_VERSION), Probe::Legacy);
    }

    #[test]
    fn auth_and_server_errors_fail_the_probe() {
        assert!(matches!(classify_probe(&reply(401, None), MODERN_VERSION), Probe::Failed(e) if e.kind == ErrorKind::AuthRequired));
        assert!(matches!(classify_probe(&reply(403, None), MODERN_VERSION), Probe::Failed(e) if e.status == Some(403)));
        assert!(matches!(classify_probe(&reply(502, None), MODERN_VERSION), Probe::Failed(e) if e.kind == ErrorKind::Http));
    }

    #[test]
    fn reads_server_identity_from_discovery() {
        let discovery = parse_discovery(&json!({
            "capabilities": { "tools": {} },
            "instructions": "Use the echo tool.",
            "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "Example", "version": "1.0.0" } }
        }));
        assert_eq!(discovery.capabilities, json!({ "tools": {} }));
        assert_eq!(discovery.server_info, Some(json!({ "name": "Example", "version": "1.0.0" })));
        assert_eq!(discovery.instructions.as_deref(), Some("Use the echo tool."));
    }
}
