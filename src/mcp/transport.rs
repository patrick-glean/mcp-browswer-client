//! Streamable HTTP over the browser's `fetch()`: one POST per message, answered by either a
//! JSON body or a request-scoped SSE stream.

use super::sse::{SseEvent, SseParser};
use super::types::{rpc_error, ErrorKind, McpError};
use crate::http::{self, fetch_error, js_internal, loggable_body, shorten};
use crate::logging::{self, Level};
use js_sys::{Reflect, Uint8Array};
use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

/// What came back for one POST.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HttpReply {
    pub status: u16,
    pub session_id: Option<String>,
    pub www_authenticate: Option<String>,
    /// The JSON-RPC message answering the request, when the body carried one.
    pub message: Option<Value>,
    /// The start of a body that wasn't JSON, for error messages.
    pub body_excerpt: Option<String>,
    /// The reply was an SSE stream rather than a JSON body.
    pub streamed: bool,
}

/// POSTs one JSON-RPC message. Transport failures (unreachable, CORS, timeout) are errors;
/// every HTTP status comes back as a reply for the caller to interpret. Each exchange is
/// logged at debug level, without the bearer token.
pub async fn post(url: &str, headers: &[(String, String)], body: &Value, timeout_ms: i32) -> Result<HttpReply, McpError> {
    let body_text = body.to_string();
    let request = describe_request(body);
    let detail = json!({ "headers": loggable_headers(headers), "body": loggable_body(body, &body_text) });
    logging::emit(Level::Debug, url, &format!("→ {request}"), Some(&detail));

    let started = js_sys::Date::now();
    let result = exchange(url, headers, &body_text, body.get("id"), timeout_ms).await;
    let elapsed = (js_sys::Date::now() - started).round();
    match &result {
        Ok(reply) => logging::emit(
            Level::Debug,
            url,
            &format!("← {} for {request} in {elapsed} ms", describe_reply(reply)),
            reply_detail(reply).as_ref(),
        ),
        Err(err) => logging::debug(url, &format!("✕ {request} after {elapsed} ms: {}", err.message)),
    }
    result
}

async fn exchange(
    url: &str,
    headers: &[(String, String)],
    body: &str,
    request_id: Option<&Value>,
    timeout_ms: i32,
) -> Result<HttpReply, McpError> {
    let mut all_headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json, text/event-stream".to_string()),
    ];
    all_headers.extend(headers.iter().cloned());
    // The timeout is held until the body is fully read, so a stalled SSE stream is aborted as well.
    let http::Started { response, timeout: _timeout } = http::start("POST", url, &all_headers, Some(body), timeout_ms).await?;

    let status = response.status();
    let response_headers = response.headers();
    let header = |name: &str| response_headers.get(name).ok().flatten();
    let content_type = header("content-type").unwrap_or_default().to_ascii_lowercase();
    let mut reply = HttpReply {
        status,
        session_id: header("mcp-session-id"),
        www_authenticate: header("www-authenticate"),
        ..HttpReply::default()
    };

    if status == 202 || status == 204 {
        return Ok(reply);
    }
    if content_type.starts_with("text/event-stream") {
        reply.streamed = true;
        reply.message = read_sse(&response, request_id, url, timeout_ms).await?;
    } else {
        let text = http::read_text(&response, url, timeout_ms).await?;
        match serde_json::from_str::<Value>(&text) {
            Ok(message) => reply.message = Some(message),
            Err(_) => reply.body_excerpt = excerpt(&text),
        }
    }
    Ok(reply)
}

/// "tools/call echo (id 7)": the method, what it addresses and the request id.
fn describe_request(body: &Value) -> String {
    let mut text = body.get("method").and_then(Value::as_str).unwrap_or("message").to_string();
    let target = body.pointer("/params/name").or_else(|| body.pointer("/params/uri"));
    if let Some(target) = target.and_then(Value::as_str) {
        text.push_str(&format!(" {target}"));
    }
    if let Some(cursor) = body.pointer("/params/cursor").and_then(Value::as_str) {
        text.push_str(&format!(" from cursor {cursor}"));
    }
    if let Some(id) = body.get("id") {
        text.push_str(&format!(" (id {id})"));
    }
    text
}

/// "HTTP 400, JSON-RPC error -32000: Bad Request": enough to see why a reply was handled the
/// way it was.
pub fn describe_reply(reply: &HttpReply) -> String {
    let mut text = format!("HTTP {}", reply.status);
    if reply.streamed {
        text.push_str(" (SSE)");
    }
    if let Some(error) = reply.message.as_ref().and_then(rpc_error) {
        text.push_str(&format!(", JSON-RPC error {}", error.code));
        if !error.message.is_empty() {
            text.push_str(&format!(": {}", shorten(&error.message, 160)));
        }
    } else if let Some(body) = &reply.body_excerpt {
        text.push_str(&format!(": {}", shorten(body, 160)));
    }
    text
}

/// Request headers as the trace shows them: the bearer token never appears, and session IDs,
/// which can stand in for credentials, are shortened.
fn loggable_headers(headers: &[(String, String)]) -> Value {
    let mut shown = Map::new();
    for (name, value) in headers {
        let value = if name.eq_ignore_ascii_case("authorization") {
            "[redacted]".to_string()
        } else if name.eq_ignore_ascii_case("mcp-session-id") {
            shorten(value, 8)
        } else {
            value.clone()
        };
        shown.insert(name.clone(), Value::String(value));
    }
    Value::Object(shown)
}

fn reply_detail(reply: &HttpReply) -> Option<Value> {
    let mut detail = Map::new();
    if let Some(id) = &reply.session_id {
        detail.insert("sessionId".into(), Value::String(shorten(id, 8)));
    }
    if let Some(message) = &reply.message {
        detail.insert("body".into(), loggable_body(message, &message.to_string()));
    } else if let Some(body) = &reply.body_excerpt {
        detail.insert("body".into(), Value::String(body.clone()));
    }
    (!detail.is_empty()).then_some(Value::Object(detail))
}

/// Turns a reply into the JSON-RPC `result`, or an error the UI can explain.
pub fn interpret_reply(reply: &HttpReply) -> Result<Value, McpError> {
    if reply.status == 401 {
        return Err(http_error(reply));
    }
    if let Some(message) = &reply.message {
        if let Some(error) = rpc_error(message) {
            return Err(McpError::from_rpc(error, reply.status));
        }
        if let Some(result) = message.get("result") {
            if (200..300).contains(&reply.status) {
                return Ok(result.clone());
            }
        }
    }
    Err(http_error(reply))
}

pub fn http_error(reply: &HttpReply) -> McpError {
    let status = reply.status;
    let (kind, message) = match status {
        401 => (
            ErrorKind::AuthRequired,
            "The server needs you to sign in (HTTP 401). Choose Sign in in the server details, or set a static token there if the server uses one.".to_string(),
        ),
        403 => (
            ErrorKind::Http,
            "The server refused the request (HTTP 403). It may not allow requests from this site's origin.".to_string(),
        ),
        404 => (
            ErrorKind::Http,
            "No MCP endpoint at this URL (HTTP 404). Check the address; MCP endpoints often end in /mcp.".to_string(),
        ),
        405 => (
            ErrorKind::Http,
            "This URL doesn't accept MCP requests (HTTP 405). Check the address; MCP endpoints often end in /mcp.".to_string(),
        ),
        200..=299 => (ErrorKind::InvalidResponse, "The server's reply wasn't a JSON-RPC response.".to_string()),
        _ => (ErrorKind::Http, format!("The server returned HTTP {status}.")),
    };
    let message = match &reply.body_excerpt {
        Some(body) if !(200..300).contains(&status) && status != 401 => format!("{message} Response: {body}"),
        _ => message,
    };
    let err = McpError::new(kind, message).with_status(status);
    // Sign-in needs the challenge's resource_metadata and scope; browsers only show the header
    // when the server exposes it through CORS.
    match &reply.www_authenticate {
        Some(challenge) if status == 401 || status == 403 => err.with_data(json!({ "wwwAuthenticate": challenge })),
        _ => err,
    }
}

/// True when a message is the response to `request_id`. Error responses without an id
/// (such as parse errors) count as the answer too.
pub fn is_response_to(message: &Value, request_id: Option<&Value>) -> bool {
    let is_response = message.get("method").is_none() && (message.get("result").is_some() || message.get("error").is_some());
    is_response
        && match message.get("id") {
            None | Some(Value::Null) => true,
            Some(id) => request_id.map_or(true, |want| want == id),
        }
}

async fn read_sse(response: &web_sys::Response, request_id: Option<&Value>, url: &str, timeout_ms: i32) -> Result<Option<Value>, McpError> {
    let Some(stream) = response.body() else { return Ok(None) };
    let reader = web_sys::ReadableStreamDefaultReader::new(&stream).map_err(js_internal)?;
    let mut parser = SseParser::new();
    let mut unmatched_response = None;
    loop {
        let chunk = JsFuture::from(reader.read())
            .await
            .map_err(|e| fetch_error(&e, url, timeout_ms))?;
        let done = Reflect::get(&chunk, &JsValue::from_str("done"))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let events = if done {
            parser.finish()
        } else {
            let value = Reflect::get(&chunk, &JsValue::from_str("value")).map_err(js_internal)?;
            parser.push(&Uint8Array::new(&value).to_vec())
        };
        for event in events {
            let Some(message) = sse_message(url, &event) else { continue };
            if is_response_to(&message, request_id) {
                // The request is answered; drop the rest of the stream.
                let _ = reader.cancel();
                return Ok(Some(message));
            }
            if message.get("method").is_none() {
                unmatched_response = Some(message);
            } else {
                log_server_message(url, &message);
            }
        }
        if done {
            return Ok(unmatched_response);
        }
    }
}

fn sse_message(url: &str, event: &SseEvent) -> Option<Value> {
    if event.event != "message" || event.data.trim().is_empty() {
        return None;
    }
    match serde_json::from_str(&event.data) {
        Ok(message) => Some(message),
        Err(e) => {
            logging::warn(url, &format!("Ignoring an SSE event that isn't JSON: {e}"));
            None
        }
    }
}

/// Requests and notifications the server sends while a reply streams in. Its log messages
/// keep their level; everything else is traced.
fn log_server_message(url: &str, message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    if message.get("id").is_some() {
        logging::warn(url, &format!("The server sent a {method} request, which this client can't answer yet"));
    } else if method == "notifications/message" {
        let (level, text) = server_log_entry(&params);
        logging::emit(level, url, &text, None);
    } else {
        logging::emit(Level::Debug, url, &format!("The server sent {method}"), Some(&params));
    }
}

/// Maps an MCP `notifications/message` (syslog levels, any JSON `data`) to a log entry.
fn server_log_entry(params: &Value) -> (Level, String) {
    let level = match params.get("level").and_then(Value::as_str) {
        Some("debug") => Level::Debug,
        Some("info" | "notice") | None => Level::Info,
        Some("warning") => Level::Warn,
        Some(_) => Level::Error,
    };
    let data = match params.get("data") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    let logger = params.get("logger").and_then(Value::as_str).map(|name| format!(" ({name})")).unwrap_or_default();
    (level, format!("Server log{logger}: {data}"))
}

fn excerpt(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| shorten(text, 300))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply(status: u16, message: Option<Value>) -> HttpReply {
        HttpReply { status, message, ..HttpReply::default() }
    }

    #[test]
    fn matches_responses_to_their_request() {
        let id = json!(7);
        assert!(is_response_to(&json!({ "jsonrpc": "2.0", "id": 7, "result": {} }), Some(&id)));
        assert!(!is_response_to(&json!({ "jsonrpc": "2.0", "id": 8, "result": {} }), Some(&id)));
        assert!(is_response_to(&json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700 } }), Some(&id)));
        assert!(!is_response_to(&json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": {} }), Some(&id)));
        assert!(!is_response_to(&json!({ "jsonrpc": "2.0", "id": 7, "method": "sampling/createMessage" }), Some(&id)));
    }

    #[test]
    fn returns_the_result_of_a_successful_reply() {
        let ok = reply(200, Some(json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } })));
        assert_eq!(interpret_reply(&ok).unwrap(), json!({ "tools": [] }));
    }

    #[test]
    fn surfaces_json_rpc_errors_with_their_code() {
        let err = interpret_reply(&reply(400, Some(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32020, "message": "Header mismatch" } })))).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Protocol);
        assert_eq!(err.code, Some(-32020));
        assert_eq!(err.status, Some(400));
        assert_eq!(err.message, "Header mismatch");
    }

    #[test]
    fn explains_http_failures() {
        assert_eq!(interpret_reply(&reply(401, None)).unwrap_err().kind, ErrorKind::AuthRequired);
        let not_found = interpret_reply(&reply(404, None)).unwrap_err();
        assert!(not_found.message.contains("/mcp"));
        assert_eq!(not_found.status, Some(404));
        assert_eq!(interpret_reply(&reply(200, None)).unwrap_err().kind, ErrorKind::InvalidResponse);
        let mut html = reply(500, None);
        html.body_excerpt = Some("<h1>Internal Server Error</h1>".into());
        let server_error = interpret_reply(&html).unwrap_err();
        assert_eq!(server_error.kind, ErrorKind::Http);
        assert!(server_error.message.contains("HTTP 500") && server_error.message.contains("Internal Server Error"));
    }

    #[test]
    fn a_json_rpc_error_on_a_401_is_still_an_auth_error() {
        let err = interpret_reply(&reply(401, Some(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32001, "message": "Unauthorized" } })))).unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthRequired);
        assert!(err.message.contains("Sign in"));
    }

    #[test]
    fn a_401_carries_the_challenge_for_sign_in() {
        let mut challenged = reply(401, None);
        challenged.www_authenticate = Some(r#"Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource""#.into());
        let err = interpret_reply(&challenged).unwrap_err();
        assert_eq!(err.data, Some(json!({ "wwwAuthenticate": r#"Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource""# })));
        assert_eq!(interpret_reply(&reply(401, None)).unwrap_err().data, None);
    }

    #[test]
    fn shortens_long_bodies() {
        assert_eq!(excerpt("   "), None);
        let long = "x".repeat(400);
        let short = excerpt(&long).unwrap();
        assert_eq!(short.chars().count(), 301);
        assert!(short.ends_with('…'));
    }

    #[test]
    fn describes_requests_by_method_target_and_id() {
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "echo", "arguments": {} } });
        assert_eq!(describe_request(&call), "tools/call echo (id 7)");
        let read = json!({ "jsonrpc": "2.0", "id": 8, "method": "resources/read", "params": { "uri": "file:///a.txt" } });
        assert_eq!(describe_request(&read), "resources/read file:///a.txt (id 8)");
        let page = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": { "cursor": "2" } });
        assert_eq!(describe_request(&page), "tools/list from cursor 2 (id 9)");
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(describe_request(&initialized), "notifications/initialized");
    }

    #[test]
    fn describes_replies_with_their_status_and_error() {
        let mut no_session = reply(400, Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32000, "message": "Bad Request: No valid session ID provided" } })));
        assert_eq!(describe_reply(&no_session), "HTTP 400, JSON-RPC error -32000: Bad Request: No valid session ID provided");
        no_session.streamed = true;
        assert!(describe_reply(&no_session).starts_with("HTTP 400 (SSE), JSON-RPC error"));
        let mut html = reply(404, None);
        html.body_excerpt = Some("<h1>Not Found</h1>".into());
        assert_eq!(describe_reply(&html), "HTTP 404: <h1>Not Found</h1>");
        assert_eq!(describe_reply(&reply(202, None)), "HTTP 202");
    }

    #[test]
    fn the_trace_never_shows_the_bearer_token() {
        let headers = vec![
            ("Authorization".to_string(), "Bearer s3cret-token".to_string()),
            ("Mcp-Session-Id".to_string(), "0123456789abcdef".to_string()),
            ("Mcp-Method".to_string(), "tools/call".to_string()),
        ];
        let shown = loggable_headers(&headers);
        assert_eq!(shown["Authorization"], "[redacted]");
        assert_eq!(shown["Mcp-Session-Id"], "01234567…");
        assert_eq!(shown["Mcp-Method"], "tools/call");
        assert!(!shown.to_string().contains("s3cret"));
    }

    #[test]
    fn keeps_the_level_of_server_log_messages() {
        let (level, text) = server_log_entry(&json!({ "level": "warning", "logger": "db", "data": "Slow query" }));
        assert_eq!((level, text.as_str()), (Level::Warn, "Server log (db): Slow query"));
        assert_eq!(server_log_entry(&json!({ "level": "critical", "data": { "code": 5 } })), (Level::Error, "Server log: {\"code\":5}".to_string()));
        assert_eq!(server_log_entry(&json!({ "level": "notice", "data": "hi" })).0, Level::Info);
        assert_eq!(server_log_entry(&json!({ "level": "debug", "data": "hi" })).0, Level::Debug);
    }
}
