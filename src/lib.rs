//! WASM exports for the service worker: the MCP client plus a few runtime helpers.
//! MCP calls take and return JSON strings; failures reject with a JSON `McpError`.

use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use wasm_bindgen::prelude::*;

mod error;
mod http;
mod logging;
pub mod mcp;
pub mod oauth;

use error::McpError;

include!("build_info.rs");

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const METADATA_VERSION: &str = "1.0.0";

static UPTIME: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct ModuleMetadata {
    version: &'static str,
    last_health_check: u64,
}

#[wasm_bindgen]
pub fn get_timestamp() -> u64 {
    js_sys::Date::now() as u64
}

#[wasm_bindgen]
pub fn get_uptime() -> u64 {
    UPTIME.load(Ordering::Relaxed)
}

#[wasm_bindgen]
pub fn increment_uptime() {
    UPTIME.fetch_add(1, Ordering::Relaxed);
}

#[wasm_bindgen]
pub fn get_version() -> String {
    format!("v{VERSION}")
}

#[wasm_bindgen]
pub fn get_compiled_info() -> String {
    format!("v{} built {} ({})", VERSION, BUILD_DATETIME, &BUILD_HASH[..8])
}

/// Sends the module's log entries to `logger` instead of the console. It's called with one
/// JSON string per entry: `{level, server, message, detail?}`.
#[wasm_bindgen]
pub fn set_logger(logger: js_sys::Function) {
    logging::set_logger(logger);
}

#[wasm_bindgen]
pub fn get_metadata() -> String {
    let metadata = ModuleMetadata { version: METADATA_VERSION, last_health_check: get_timestamp() };
    serde_json::to_string(&metadata).unwrap_or_default()
}

/// Detects the server's protocol era and returns what it reported about itself:
/// `{url, era, protocolVersion, serverInfo, capabilities, instructions}`.
#[wasm_bindgen]
pub async fn connect(url: String, options: String) -> Result<String, JsValue> {
    let result = match mcp::Options::parse(&options) {
        Ok(opts) => mcp::connect(url.trim(), &opts).await,
        Err(err) => Err(err),
    };
    to_js(result)
}

/// Returns `{tools, rejected, ttlMs, cacheScope, fromCache}`. Pass `{"refresh": true}` in
/// `options` to skip the cache.
#[wasm_bindgen]
pub async fn list_tools(url: String, options: String) -> Result<String, JsValue> {
    let result = match mcp::Options::parse(&options) {
        Ok(opts) => mcp::list_tools(url.trim(), &opts).await,
        Err(err) => Err(err),
    };
    to_js(result)
}

/// Calls a tool with JSON-encoded arguments and returns the JSON-RPC `result`.
#[wasm_bindgen]
pub async fn call_tool(url: String, name: String, args: String, options: String) -> Result<String, JsValue> {
    let result = match (mcp::Options::parse(&options), parse_args(&args)) {
        (Ok(opts), Ok(args)) => mcp::call_tool(url.trim(), &name, args, &opts).await,
        (Err(err), _) | (_, Err(err)) => Err(err),
    };
    to_js(result)
}

/// Returns `{resources}`, every page of the server's resource list.
#[wasm_bindgen]
pub async fn list_resources(url: String, options: String) -> Result<String, JsValue> {
    let result = match mcp::Options::parse(&options) {
        Ok(opts) => mcp::list_resources(url.trim(), &opts).await,
        Err(err) => Err(err),
    };
    to_js(result)
}

/// Returns `{resourceTemplates}`, every page of the server's resource template list.
#[wasm_bindgen]
pub async fn list_resource_templates(url: String, options: String) -> Result<String, JsValue> {
    let result = match mcp::Options::parse(&options) {
        Ok(opts) => mcp::list_resource_templates(url.trim(), &opts).await,
        Err(err) => Err(err),
    };
    to_js(result)
}

/// Reads a resource and returns the JSON-RPC `result`, `{contents}`.
#[wasm_bindgen]
pub async fn read_resource(url: String, uri: String, options: String) -> Result<String, JsValue> {
    let result = match mcp::Options::parse(&options) {
        Ok(opts) => mcp::read_resource(url.trim(), &uri, &opts).await,
        Err(err) => Err(err),
    };
    to_js(result)
}

/// Returns `{prompts}`, every page of the server's prompt list.
#[wasm_bindgen]
pub async fn list_prompts(url: String, options: String) -> Result<String, JsValue> {
    let result = match mcp::Options::parse(&options) {
        Ok(opts) => mcp::list_prompts(url.trim(), &opts).await,
        Err(err) => Err(err),
    };
    to_js(result)
}

/// Gets a prompt with JSON-encoded arguments and returns the JSON-RPC `result`,
/// `{description?, messages}`.
#[wasm_bindgen]
pub async fn get_prompt(url: String, name: String, args: String, options: String) -> Result<String, JsValue> {
    let result = match (mcp::Options::parse(&options), parse_args(&args)) {
        (Ok(opts), Ok(args)) => mcp::get_prompt(url.trim(), &name, args, &opts).await,
        (Err(err), _) | (_, Err(err)) => Err(err),
    };
    to_js(result)
}

#[wasm_bindgen]
pub fn forget_server(url: &str) {
    mcp::forget(url.trim());
}

/// Starts signing in to a server that needs OAuth: discovery, client registration if needed,
/// and the URL to open. `options` is `{redirectUri, applicationType, clients, wwwAuthenticate?}`;
/// returns `{authorizationUrl, pending, client, newClient, authServer, scope}`.
#[wasm_bindgen]
pub async fn auth_begin(server_url: String, options: String) -> Result<String, JsValue> {
    let result = match parse::<oauth::BeginOptions>(&options, "sign-in options") {
        Ok(opts) => oauth::begin(server_url.trim(), opts).await.and_then(|begin| to_value(&begin)),
        Err(err) => Err(err),
    };
    to_js(result)
}

/// Finishes a sign-in with the callback's `{code, state, iss, error, errorDescription}` and
/// returns the tokens to store.
#[wasm_bindgen]
pub async fn auth_finish(pending: String, callback: String) -> Result<String, JsValue> {
    let parsed = (parse::<oauth::Pending>(&pending, "sign-in record"), parse::<oauth::Callback>(&callback, "sign-in response"));
    let result = match parsed {
        (Ok(pending), Ok(callback)) => oauth::finish(pending, callback).await.and_then(|tokens| to_value(&tokens)),
        (Err(err), _) | (_, Err(err)) => Err(err),
    };
    to_js(result)
}

/// Refreshes stored tokens. Rejects with kind `auth_required` when the user has to sign in again.
#[wasm_bindgen]
pub async fn auth_refresh(tokens: String) -> Result<String, JsValue> {
    let result = match parse::<oauth::Tokens>(&tokens, "tokens") {
        Ok(tokens) => oauth::refresh(tokens).await.and_then(|tokens| to_value(&tokens)),
        Err(err) => Err(err),
    };
    to_js(result)
}

fn parse<T: serde::de::DeserializeOwned>(json: &str, what: &str) -> Result<T, McpError> {
    serde_json::from_str(json).map_err(|e| McpError::internal(format!("Invalid {what}: {e}")))
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, McpError> {
    serde_json::to_value(value).map_err(|e| McpError::internal(e.to_string()))
}

fn parse_args(args: &str) -> Result<Value, McpError> {
    if args.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(args).map_err(|e| McpError::internal(format!("The tool arguments aren't valid JSON: {e}")))
}

fn to_js(result: Result<Value, McpError>) -> Result<String, JsValue> {
    result.map(|value| value.to_string()).map_err(|err| JsValue::from_str(&err.to_json()))
}
