//! The browser's `fetch()` for every request the client makes: the abort timeout, what a failed
//! fetch means, and plain JSON or form requests (the OAuth endpoints) with a debug trace that
//! never shows credentials.

use crate::error::{ErrorKind, McpError};
use crate::logging::{self, Level};
use js_sys::{Promise, Reflect};
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

/// Longer bodies are cut short in the debug trace.
pub const MAX_LOGGED_BODY: usize = 4_000;

/// Fields that carry credentials in OAuth requests and replies.
const SECRET_FIELDS: &[&str] = &[
    "code",
    "code_verifier",
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "registration_access_token",
];

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = self, js_name = fetch)]
    fn fetch_with_options(url: &str, options: &JsValue) -> Promise;
    #[wasm_bindgen(js_namespace = self, js_name = setTimeout)]
    fn set_timeout(handler: &js_sys::Function, ms: i32) -> JsValue;
    #[wasm_bindgen(js_namespace = self, js_name = clearTimeout)]
    fn clear_timeout(handle: &JsValue);
}

/// A response whose body hasn't been read yet. Hold on to `timeout` until it has: dropping it
/// cancels the abort, so a body that stalls would never time out.
pub struct Started {
    pub response: web_sys::Response,
    pub timeout: Timeout,
}

/// Starts a request that's aborted if it hasn't finished after `timeout_ms`.
pub async fn start(method: &str, url: &str, headers: &[(String, String)], body: Option<&str>, timeout_ms: i32) -> Result<Started, McpError> {
    let js_headers = web_sys::Headers::new().map_err(js_internal)?;
    for (name, value) in headers {
        js_headers
            .set(name, value)
            .map_err(|e| McpError::internal(format!("Couldn't set header {name}: {}", js_message(&e))))?;
    }
    let controller = web_sys::AbortController::new().map_err(js_internal)?;
    let options = js_sys::Object::new();
    set(&options, "method", &JsValue::from_str(method))?;
    set(&options, "headers", &js_headers)?;
    if let Some(body) = body {
        set(&options, "body", &JsValue::from_str(body))?;
    }
    set(&options, "signal", &controller.signal())?;

    let timeout = Timeout::start(&controller, timeout_ms);
    let response = JsFuture::from(fetch_with_options(url, &options))
        .await
        .map_err(|e| fetch_error(&e, url, timeout_ms))?;
    let response = response
        .dyn_into::<web_sys::Response>()
        .map_err(|_| McpError::internal("fetch() didn't return a Response"))?;
    Ok(Started { response, timeout })
}

pub async fn read_text(response: &web_sys::Response, url: &str, timeout_ms: i32) -> Result<String, McpError> {
    let promise = response.text().map_err(js_internal)?;
    let text = JsFuture::from(promise).await.map_err(|e| fetch_error(&e, url, timeout_ms))?;
    Ok(text.as_string().unwrap_or_default())
}

/// A request to an endpoint that isn't an MCP server, such as an OAuth authorization server.
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Body>,
}

pub enum Body {
    Json(Value),
    Form(Vec<(String, String)>),
}

impl Request {
    pub fn get(url: impl Into<String>) -> Self {
        Request { method: "GET", url: url.into(), headers: Vec::new(), body: None }
    }

    pub fn post_json(url: impl Into<String>, body: Value) -> Self {
        Request { method: "POST", url: url.into(), headers: Vec::new(), body: Some(Body::Json(body)) }
    }

    pub fn post_form(url: impl Into<String>, fields: Vec<(String, String)>) -> Self {
        Request { method: "POST", url: url.into(), headers: Vec::new(), body: Some(Body::Form(fields)) }
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }
}

pub struct Response {
    pub status: u16,
    pub json: Option<Value>,
    pub text: String,
}

/// Sends `request` and reads the whole reply. Each exchange is traced at debug level under
/// `server`, the MCP server it's for, with credentials removed.
pub async fn send(request: &Request, server: &str, timeout_ms: i32) -> Result<Response, McpError> {
    let label = format!("{} {}", request.method, request.url);
    let mut headers = request.headers.clone();
    headers.push(("Accept".into(), "application/json".into()));
    let body = match &request.body {
        Some(Body::Json(value)) => {
            headers.push(("Content-Type".into(), "application/json".into()));
            Some(value.to_string())
        }
        Some(Body::Form(fields)) => {
            headers.push(("Content-Type".into(), "application/x-www-form-urlencoded".into()));
            Some(form_encode(fields))
        }
        None => None,
    };
    logging::emit(Level::Debug, server, &format!("→ {label}"), Some(&request_detail(request, &headers)));

    let started_at = js_sys::Date::now();
    let result = async {
        let started = start(request.method, &request.url, &headers, body.as_deref(), timeout_ms).await?;
        let status = started.response.status();
        let text = read_text(&started.response, &request.url, timeout_ms).await?;
        Ok::<_, McpError>(Response { status, json: serde_json::from_str(&text).ok(), text })
    }
    .await;
    let elapsed = (js_sys::Date::now() - started_at).round();
    match &result {
        Ok(response) => logging::emit(
            Level::Debug,
            server,
            &format!("← HTTP {} for {label} in {elapsed} ms", response.status),
            Some(&response_detail(response)),
        ),
        Err(err) => logging::debug(server, &format!("✕ {label} after {elapsed} ms: {}", err.message)),
    }
    result
}

fn request_detail(request: &Request, headers: &[(String, String)]) -> Value {
    let mut detail = Map::new();
    detail.insert("headers".into(), redact_headers(headers));
    match &request.body {
        Some(Body::Json(value)) => {
            detail.insert("body".into(), loggable_body(&redact_json(value), &value.to_string()));
        }
        Some(Body::Form(fields)) => {
            detail.insert("form".into(), redact_form(fields));
        }
        None => {}
    }
    Value::Object(detail)
}

fn response_detail(response: &Response) -> Value {
    let body = match &response.json {
        Some(json) => loggable_body(&redact_json(json), &response.text),
        None => Value::String(shorten(response.text.trim(), 300)),
    };
    serde_json::json!({ "body": body })
}

/// The `Authorization` header as "[redacted]"; everything else as sent.
pub fn redact_headers(headers: &[(String, String)]) -> Value {
    let mut shown = Map::new();
    for (name, value) in headers {
        let value = if name.eq_ignore_ascii_case("authorization") { "[redacted]".to_string() } else { value.clone() };
        shown.insert(name.clone(), Value::String(value));
    }
    Value::Object(shown)
}

/// `value` with every credential field replaced, at any depth.
pub fn redact_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let item = if is_secret(key) && !item.is_null() { Value::String("[redacted]".into()) } else { redact_json(item) };
                    (key.clone(), item)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(redact_json).collect()),
        other => other.clone(),
    }
}

pub fn redact_form(fields: &[(String, String)]) -> Value {
    let mut shown = Map::new();
    for (name, value) in fields {
        let value = if is_secret(name) { "[redacted]".to_string() } else { value.clone() };
        shown.insert(name.clone(), Value::String(value));
    }
    Value::Object(shown)
}

fn is_secret(name: &str) -> bool {
    SECRET_FIELDS.iter().any(|secret| secret.eq_ignore_ascii_case(name))
}

/// The message itself when it's small enough to pretty-print in the Logs tab, otherwise the
/// start of its text.
pub fn loggable_body(message: &Value, text: &str) -> Value {
    if text.len() <= MAX_LOGGED_BODY {
        message.clone()
    } else {
        Value::String(shorten(text, MAX_LOGGED_BODY))
    }
}

pub fn shorten(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

/// Percent-encodes a query or form value, keeping only RFC 3986's unreserved characters.
pub fn encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub fn form_encode(fields: &[(String, String)]) -> String {
    fields
        .iter()
        .map(|(name, value)| format!("{}={}", encode_component(name), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn fetch_error(error: &JsValue, url: &str, timeout_ms: i32) -> McpError {
    let name = Reflect::get(error, &JsValue::from_str("name")).ok().and_then(|v| v.as_string());
    if name.as_deref() == Some("AbortError") {
        return McpError::new(ErrorKind::Timeout, format!("{url} didn't answer within {} seconds.", timeout_ms / 1000));
    }
    McpError::new(
        ErrorKind::Network,
        format!(
            "Couldn't reach {url}. The server may be down, or the browser blocked the request: the server must allow this site through CORS, and localhost servers need the browser's local network permission. ({})",
            js_message(error)
        ),
    )
}

pub fn js_internal(error: JsValue) -> McpError {
    McpError::internal(js_message(&error))
}

pub fn js_message(value: &JsValue) -> String {
    if let Some(text) = value.as_string() {
        return text;
    }
    Reflect::get(value, &JsValue::from_str("message"))
        .ok()
        .and_then(|m| m.as_string())
        .unwrap_or_else(|| format!("{value:?}"))
}

fn set(target: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), McpError> {
    Reflect::set(target, &JsValue::from_str(key), value).map(|_| ()).map_err(js_internal)
}

/// Aborts the request when the timer fires; dropping it cancels the timer.
pub struct Timeout {
    handle: JsValue,
    _callback: Closure<dyn FnMut()>,
}

impl Timeout {
    fn start(controller: &web_sys::AbortController, ms: i32) -> Self {
        let controller = controller.clone();
        let callback = Closure::<dyn FnMut()>::new(move || controller.abort());
        let handle = set_timeout(callback.as_ref().unchecked_ref(), ms);
        Timeout { handle, _callback: callback }
    }
}

impl Drop for Timeout {
    fn drop(&mut self) {
        clear_timeout(&self.handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shortens_text_on_character_boundaries() {
        assert_eq!(shorten("Zürich", 3), "Zür…");
        assert_eq!(shorten("Zürich", 6), "Zürich");
    }

    #[test]
    fn logs_small_bodies_whole_and_cuts_large_ones() {
        let small = json!({ "jsonrpc": "2.0", "id": 1, "result": {} });
        assert_eq!(loggable_body(&small, &small.to_string()), small);
        let large = json!({ "text": "x".repeat(MAX_LOGGED_BODY) });
        let cut = loggable_body(&large, &large.to_string());
        assert!(cut.as_str().is_some_and(|text| text.ends_with('…') && text.chars().count() == MAX_LOGGED_BODY + 1));
    }

    #[test]
    fn the_trace_never_shows_credentials() {
        let reply = json!({
            "access_token": "at-123",
            "refresh_token": "rt-456",
            "token_type": "Bearer",
            "nested": [{ "client_secret": "cs-789" }],
            "id_token": null
        });
        let shown = redact_json(&reply);
        assert_eq!(shown["access_token"], "[redacted]");
        assert_eq!(shown["nested"][0]["client_secret"], "[redacted]");
        assert_eq!(shown["token_type"], "Bearer");
        assert_eq!(shown["id_token"], Value::Null);
        let form = redact_form(&[
            ("grant_type".into(), "authorization_code".into()),
            ("code".into(), "c-1".into()),
            ("code_verifier".into(), "v-2".into()),
            ("client_id".into(), "client-3".into()),
        ]);
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["client_id"], "client-3");
        let headers = redact_headers(&[("Authorization".into(), "Basic abc".into()), ("Accept".into(), "application/json".into())]);
        let all = format!("{shown}{form}{headers}");
        for secret in ["at-123", "rt-456", "cs-789", "c-1", "v-2", "Basic abc"] {
            assert!(!all.contains(secret), "{secret} leaked into the trace");
        }
    }

    #[test]
    fn encodes_form_and_query_values() {
        assert_eq!(encode_component("a b&c=d/é~"), "a%20b%26c%3Dd%2F%C3%A9~");
        assert_eq!(
            form_encode(&[("grant_type".into(), "refresh_token".into()), ("resource".into(), "https://x.test/mcp".into())]),
            "grant_type=refresh_token&resource=https%3A%2F%2Fx.test%2Fmcp"
        );
    }
}
