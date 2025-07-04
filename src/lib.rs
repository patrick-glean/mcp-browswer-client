use core::str;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering, AtomicBool};
use wasm_bindgen::prelude::*;
use serde::{Deserialize};
use serde_json::{self, json};
use js_sys::Date;
use web_sys;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen::JsCast;
use std::sync::LazyLock;
use std::collections::HashMap;
use serde_wasm_bindgen;

include!("build_info.rs");
include!("bootrom.rs");

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const METADATA_VERSION: &str = "1.0.0";
const DEFAULT_SERVER_URL: &str = "http://localhost:8081";

#[derive(Debug, Serialize, Deserialize, Clone)]
struct McpTool {
    name: String,
    description: String,
    version: String,
    parameters: Vec<ToolParameter>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolParameter {
    name: String,
    description: String,
    required: bool,
    #[serde(rename = "type")]
    param_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct McpServer {
    url: String,
    name: String,
    version: String,
    status: String,
    tools: Vec<McpTool>,
    last_health_check: u64,
    session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct McpServerRegistry {
    servers: HashMap<String, McpServer>,
    default_server: Option<String>,
}

static UPTIME: AtomicU64 = AtomicU64::new(0);
static SERVER_URL: LazyLock<std::sync::atomic::AtomicPtr<String>> = LazyLock::new(|| {
    std::sync::atomic::AtomicPtr::new(Box::into_raw(Box::new(String::from(DEFAULT_SERVER_URL))))
});

static SERVER_REGISTRY: LazyLock<std::sync::Mutex<McpServerRegistry>> = LazyLock::new(|| {
    std::sync::Mutex::new(McpServerRegistry {
        servers: HashMap::new(),
        default_server: None,
    })
});

static DEBUG_MODE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    method: String,
    params: Option<serde_json::Value>,
    id: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
    data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "UPPERCASE")]
enum LogLevel {
    DEBUG,
    INFO,
    ERROR,
}

#[derive(Debug, Serialize)]
struct LogEntry {
    timestamp: u64,
    level: LogLevel,
    message: String,
    module: &'static str,
}

impl LogEntry {
    fn new(level: LogLevel, message: String) -> Self {
        LogEntry {
            timestamp: get_timestamp(),
            level,
            message,
            module: "mcp_client",
        }
    }
}

#[derive(Serialize, Deserialize)]
struct MemoryEvent {
    timestamp: u64,
    text: String,
}

#[derive(Serialize, Deserialize)]
struct ModuleMetadata {
    version: String,
    memory_events: Vec<MemoryEvent>,
    last_health_check: u64,
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    
    #[wasm_bindgen(js_namespace = self)]
    fn fetch(url: &str, options: &JsValue) -> js_sys::Promise;
}

#[wasm_bindgen]
pub fn get_timestamp() -> u64 {
    Date::now() as u64
}

#[wasm_bindgen]
pub fn get_uptime() -> u64 {
    UPTIME.load(Ordering::Relaxed)
}

#[wasm_bindgen]
pub fn increment_uptime() {
    UPTIME.fetch_add(1, Ordering::Relaxed);
    // This was a per second uptime that should be enabled if in debug.
    // let uptime = UPTIME.load(Ordering::Relaxed);
    // info(&format!("WASM uptime: {} seconds", uptime));
}

fn log_with_level(level: LogLevel, message: String) {
    let entry = LogEntry::new(level, message);
    if let Ok(json) = serde_json::to_string(&entry) {
        log(&format!("[WASM] {}", json));
    }
}

fn debug(message: &str) {
    log_with_level(LogLevel::DEBUG, format!("[DEBUG] {}", message));
}

fn info(message: &str) {
    log_with_level(LogLevel::INFO, format!("[INFO] {}", message));
}

fn error(message: &str) {
    log_with_level(LogLevel::ERROR, format!("[ERROR] {}", message));
}

#[wasm_bindgen]
pub fn get_version() -> String {
    info(&format!("Getting version info: {}", VERSION));
    format!("v{}", VERSION)
}

#[wasm_bindgen]
pub fn set_server_url(url: &str) {
    let new_url = Box::new(String::from(url));
    let new_url_ptr = Box::into_raw(new_url);
    let old_url_ptr = SERVER_URL.swap(new_url_ptr, Ordering::SeqCst);
    // Convert the old pointer back to a String for logging
    let old_url = unsafe { Box::from_raw(old_url_ptr) };
    info(&format!("Updated server URL from {} to {}", old_url, url));
    // Don't drop the old_url since we're in a WASM context
    std::mem::forget(old_url);
    // No localStorage usage
}

#[wasm_bindgen]
pub fn get_server_url() -> String {
    let url_ptr = SERVER_URL.load(Ordering::SeqCst);
    let url = unsafe { &*url_ptr };
    url.clone()
}

#[wasm_bindgen]
pub async fn health_check() -> u32 {
    // Basic health check - just verify the module is loaded and functioning
    // Return 0 for healthy (module is loaded and working)
    info(&format!("WASM Module Version: {}", VERSION));
    0
}

// Add a separate MCP server health check
#[wasm_bindgen]
pub async fn check_mcp_server() -> u32 {
    let server_url = get_server_url();
    info(&format!("Attempting to connect to MCP server at {}", server_url));
    
    // Create proper JSON-RPC health check request
    let health_check_request = json!({
        "jsonrpc": "2.0",
        "method": "health_check",
        "params": {},
        "id": js_sys::Date::now() as u64
    });
    
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &health_check_request.to_string().into()).unwrap();
    js_sys::Reflect::set(&options, &"headers".into(), &js_sys::Object::new().into()).unwrap();
    
    // Set Content-Type header
    let headers = js_sys::Object::new();
    js_sys::Reflect::set(&headers, &"Content-Type".into(), &"application/json".into()).unwrap();
    js_sys::Reflect::set(&headers, &"Accept".into(), &"application/json".into()).unwrap();
    js_sys::Reflect::set(&options, &"headers".into(), &headers.into()).unwrap();
    
    let promise = fetch(&server_url, &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    let json = match JsFuture::from(resp.json().unwrap()).await {
                        Ok(val) => val,
                        Err(e) => {
                            error(&format!("Failed to parse JSON: {:?}", e));
                            return 1;
                        }
                    };
                    let text = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap_or_default();
                    debug(&format!("Received raw response: {}", text));
                    
                    // Parse the JSON-RPC response
                    if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(&text) {
                        if let Some(result) = response.result {
                            if let Some(status) = result.get("status") {
                                let status_str = status.as_str().unwrap_or_default();
                                debug(&format!("Parsed status: {}", status_str));
                                
                                if status_str.to_lowercase() == "healthy" {
                                    info("MCP server health check successful - server is healthy");
                                    return 0;
                                } else {
                                    error(&format!("MCP server health check failed - server reported status: {}", status_str));
                                    return 1;
                                }
                            }
                        }
                        if let Some(err) = response.error {
                            error(&format!("MCP server returned error: {} (code: {})", err.message, err.code));
                            return 1;
                        }
                    }
                    error("Failed to parse MCP server response as JSON-RPC");
                    1
                } else {
                    error("MCP server health check failed - received error response");
                    1
                }
            } else {
                error("Failed to cast JsValue to web_sys::Response");
                1
            }
        }
        Err(e) => {
            error(&format!("Failed to connect to MCP server: {:?}", e));
            error(&format!("Please ensure the MCP server is running at {}", server_url));
            1
        }
    }
}

#[wasm_bindgen]
pub async fn handle_message(message: &str) -> Result<JsValue, JsValue> {
    info("handle_message called");
    debug(&format!("Processing message: {}", message));
    
    let mut logs = Vec::new();
    let mut log_handler = |level: &str, message: &str| {
        logs.push(json!({
            "level": level,
            "message": message,
            "timestamp": js_sys::Date::now()
        }));
    };
    
    let result = match serde_json::from_str::<JsonRpcRequest>(message) {
        Ok(request) => {
            match request.method.as_str() {
                "health_check" => {
                    log_handler("INFO", "Processing MCP server health check request");
                    let response = check_mcp_server().await;
                    let status_str = if response == 0 { "healthy" } else { "unhealthy" };
                    log_handler("INFO", &format!("MCP server health check response: {}", status_str));
                    json!({
                        "jsonrpc": "2.0",
                        "id": request.id,
                        "result": {
                            "status": status_str,
                            "uptime": get_uptime(),
                            "version": VERSION
                        },
                        "logs": logs
                    })
                }
                _ => {
                    let error_msg = format!("Unknown method: {}", request.method);
                    log_handler("ERROR", &error_msg);
                    json!({
                        "jsonrpc": "2.0",
                        "id": request.id,
                        "error": {
                            "code": -32601,
                            "message": error_msg
                        },
                        "logs": logs
                    })
                }
            }
        }
        Err(e) => {
            let error_msg = format!("Failed to parse request: {}", e);
            log_handler("ERROR", &error_msg);
            json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": {
                    "code": -32700,
                    "message": error_msg
                },
                "logs": logs
            })
        }
    };
    
    Ok(JsValue::from_str(&result.to_string()))
}

#[wasm_bindgen]
pub fn get_metadata() -> String {
    let metadata = ModuleMetadata {
        version: METADATA_VERSION.to_string(),
        memory_events: Vec::new(),
        last_health_check: get_timestamp(),
    };
    
    serde_json::to_string(&metadata).unwrap_or_default()
}

// In-memory metadata for memory events
static mut MODULE_METADATA: Option<ModuleMetadata> = None;

#[wasm_bindgen]
pub fn add_memory_event(text: &str) {
    let event = MemoryEvent {
        timestamp: get_timestamp(),
        text: text.to_string(),
    };
    unsafe {
        let meta = MODULE_METADATA.get_or_insert(ModuleMetadata {
            version: METADATA_VERSION.to_string(),
            memory_events: Vec::new(),
            last_health_check: get_timestamp(),
        });
        meta.memory_events.push(event);
    }
}

#[wasm_bindgen]
pub fn clear_memory_events() -> Result<(), String> {
    unsafe {
        MODULE_METADATA = Some(ModuleMetadata {
            version: METADATA_VERSION.to_string(),
            memory_events: Vec::new(),
            last_health_check: get_timestamp(),
        });
    }
    Ok(())
}

#[wasm_bindgen]
pub async fn initialize_mcp_server(url: &str) -> Result<JsValue, JsValue> {
    info(&format!("Initializing MCP server at {}", url));
    
    let mut registry = SERVER_REGISTRY.lock().unwrap();
    
    // Create new server entry
    let server = McpServer {
        url: url.to_string(),
        name: format!("MCP Server at {}", url),
        version: "unknown".to_string(),
        status: "initializing".to_string(),
        tools: Vec::new(),
        last_health_check: get_timestamp(),
        session_id: None,
    };
    
    // Insert or update the server entry
    registry.servers.insert(url.to_string(), server);
    
    // If this is the first server, set it as default
    if registry.default_server.is_none() {
        registry.default_server = Some(url.to_string());
        info(&format!("Set {} as default server", url));
    }
    
    // Perform initial handshake
    match perform_server_handshake(url).await {
        Ok(server_info) => {
            let server = registry.servers.get_mut(url).unwrap();
            server.version = server_info.version.clone();
            server.status = "connected".to_string();
            server.tools = server_info.tools.clone();
            server.session_id = server_info.session_id.clone();
            
            info(&format!("Successfully initialized MCP server at {}", url));
            Ok(JsValue::from_str(&json!({
                "status": "success",
                "message": format!("Successfully initialized MCP server at {}", url),
                "server_info": server_info
            }).to_string()))
        }
        Err(e) => {
            let server = registry.servers.get_mut(url).unwrap();
            server.status = "failed".to_string();
            
            error(&format!("Failed to initialize MCP server at {}: {}", url, e));
            Err(JsValue::from_str(&json!({
                "status": "error",
                "message": format!("Failed to initialize MCP server: {}", e)
            }).to_string()))
        }
    }
}

async fn perform_server_handshake(url: &str) -> Result<McpServer, String> {
    info(&format!("Performing handshake with MCP server at {}", url));
    
    let handshake_request = json!({
        "jsonrpc": "2.0",
        "id": js_sys::Date::now() as u64,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {
                "sampling": {},
                "roots": []
            },
            "clientInfo": {
                "name": "mcp-browser-client",
                "version": VERSION
            }
        }
    });
    
    if DEBUG_MODE.load(Ordering::Relaxed) {
        debug(&format!("Sending handshake request: {}", handshake_request.to_string()));
    }
    
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &handshake_request.to_string().into()).unwrap();
    
    let headers = js_sys::Object::new();
    js_sys::Reflect::set(&headers, &"Content-Type".into(), &"application/json".into()).unwrap();
    js_sys::Reflect::set(&headers, &"Accept".into(), &"application/json, text/event-stream".into()).unwrap();
    js_sys::Reflect::set(&headers, &"Accept-Language".into(), &"*".into()).unwrap();
    js_sys::Reflect::set(&options, &"headers".into(), &headers.into()).unwrap();
    
    let promise = fetch(url, &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                let status = resp.status();
                let json = match JsFuture::from(resp.json().unwrap()).await {
                    Ok(val) => val,
                    Err(e) => {
                        error(&format!("Failed to parse JSON: {:?}", e));
                        return Err(format!("Server returned error response (status {}): {:?}", status, e));
                    }
                };
                let text = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap_or_default();
                if DEBUG_MODE.load(Ordering::Relaxed) {
                    debug(&format!("Received response (status {}): {}", status, text));
                }
                if resp.ok() {
                    // Get session ID from response headers
                    let session_id = resp.headers().get("mcp-session-id").ok().flatten();
                    
                    match serde_json::from_str::<JsonRpcResponse>(&text) {
                        Ok(response) => {
                            let name = response.result.as_ref()
                                .and_then(|v| v.get("serverInfo"))
                                .and_then(|v| v.get("name"))
                                .and_then(|v| v.as_str())
                                .map(|n| n.to_string())
                                .unwrap_or_else(|| "Unknown".to_string());

                            let version = response.result.as_ref()
                                .and_then(|v| v.get("serverInfo"))
                                .and_then(|v| v.get("version"))
                                .and_then(|v| v.as_str())
                                .map(|n| n.to_string())
                                .unwrap_or_else(|| "unknown".to_string());

                            let tools = response.result.as_ref()
                                .and_then(|v| v.get("capabilities"))
                                .and_then(|v| v.get("tools"))
                                .and_then(|v| v.as_object())
                                .map(|tools| tools.iter()
                                    .filter_map(|(name, info)| {
                                        Some(McpTool {
                                            name: name.clone(),
                                            description: info.get("description")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("")
                                                .to_string(),
                                            version: info.get("version")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("unknown")
                                                .to_string(),
                                            parameters: Vec::new(),
                                        })
                                    })
                                    .collect::<Vec<_>>())
                                .unwrap_or_default();

                            let server_info = McpServer {
                                url: url.to_string(),
                                name,
                                version,
                                status: "connected".to_string(),
                                tools,
                                last_health_check: get_timestamp(),
                                session_id: session_id.clone(),
                            };
                            
                            // Send initialized notification
                            if let Some(_session_id) = session_id {
                                let initialized_request = json!({
                                    "jsonrpc": "2.0",
                                    "method": "notifications/initialized"
                                });
                                
                                let initialized_request_str = initialized_request.to_string();
                                let headers = web_sys::Headers::new().unwrap();
                                headers.set("Content-Type", "application/json").unwrap();
                                if let Some(session_id) = &server_info.session_id {
                                    headers.set("mcp-session-id", session_id).unwrap();
                                }
                                js_sys::Reflect::set(&options, &"headers".into(), &headers.into()).unwrap();
                                js_sys::Reflect::set(&options, &"body".into(), &JsValue::from_str(&initialized_request_str)).unwrap();
                                
                                let _ = JsFuture::from(fetch(url, &options)).await;
                            }
                            
                            Ok(server_info)
                        }
                        Err(e) => Err(format!("Failed to parse handshake response: {}", e))
                    }
                } else {
                    Err(format!("Server returned error response (status {}): {}", status, text))
                }
            } else {
                Err("Failed to get response".to_string())
            }
        }
        Err(e) => Err(format!("Failed to connect to server: {:?}", e))
    }
}

#[wasm_bindgen]
pub fn get_server_info() -> Result<JsValue, JsValue> {
    let registry = SERVER_REGISTRY.lock().unwrap();
    Ok(JsValue::from_str(&json!({
        "servers": registry.servers,
        "default_server": registry.default_server
    }).to_string()))
}

#[wasm_bindgen]
pub async fn query_tools() -> Result<JsValue, JsValue> {
    info("Querying tools from MCP server");
    info("Tools button clicked, attempting to connect to server...");
    let server_url = get_server_url();
    let tools_request = json!({
        "jsonrpc": "2.0",
        "method": "tools/list",
        "params": {},
        "id": js_sys::Date::now() as u64
    });
    let options = js_sys::Object::new();
    let headers = web_sys::Headers::new().unwrap();
    headers.set("Content-Type", "application/json").unwrap();
    js_sys::Reflect::set(&options, &"headers".into(), &headers.into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &JsValue::from_str(&tools_request.to_string())).unwrap();
    let promise = fetch(&server_url, &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_str = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap_or_default();
                            debug(&format!("Received tools response: {}", json_str));
                            info(&format!("Raw response: {}", json_str));
                            if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(&json_str) {
                                if let Some(result) = response.result {
                                    if let Some(tools) = result.get("tools") {
                                        let tools_list = tools.as_array().unwrap();
                                        let tools_str = serde_json::to_string(&tools_list).unwrap();
                                        Ok(JsValue::from_str(&tools_str))
                                    } else {
                                        Err(JsValue::from_str("No tools found in response"))
                                    }
                                } else {
                                    Err(JsValue::from_str("No result in tools response"))
                                }
                            } else {
                                Err(JsValue::from_str("Failed to parse tools response"))
                            }
                        }
                        Err(e) => Err(JsValue::from_str(&format!("Failed to parse response: {:?}", e)))
                    }
                } else {
                    Err(JsValue::from_str("Server returned error response"))
                }
            } else {
                Err(JsValue::from_str("Failed to get response"))
            }
        }
        Err(e) => Err(JsValue::from_str(&format!("Failed to connect to server: {:?}", e)))
    }
}

#[wasm_bindgen]
pub async fn list_tools(url: &str) -> Result<JsValue, JsValue> {
    info(&format!("[list_tools] Called with url: {}", url));
    // Create JSON-RPC request for tool list
    let tools_request = json!({
        "jsonrpc": "2.0",
        "id": js_sys::Date::now() as u64,
        "method": "tools/list",
        "params": {
            "_meta": {
                "progressToken": js_sys::Date::now() as u64
            }
        }
    });
    debug(&format!("[list_tools] Sending tools list request: {}", tools_request.to_string()));
    let options = js_sys::Object::new();
    let headers = web_sys::Headers::new().unwrap();
    headers.set("Content-Type", "application/json").unwrap();
    if let Some(server) = SERVER_REGISTRY.lock().unwrap().servers.get(url) {
        if let Some(session_id) = &server.session_id {
            debug(&format!("[list_tools] Using session_id: {}", session_id));
            headers.set("mcp-session-id", session_id).unwrap();
        } else {
            debug("[list_tools] No session_id found for server");
        }
    } else {
        debug("[list_tools] No server found in registry for url");
    }
    js_sys::Reflect::set(&options, &"headers".into(), &headers.into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &JsValue::from_str(&tools_request.to_string())).unwrap();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    info(&format!("[list_tools] About to fetch tools from {}", url));
    let promise = fetch(url, &options);
    info(&format!("[list_tools] Fetch promise created for {}", url));
    match JsFuture::from(promise).await {
        Ok(response) => {
            info("[list_tools] Fetch completed, processing response...");
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    info("[list_tools] Response OK, parsing JSON...");
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_str = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap_or_default();
                            debug(&format!("[list_tools] Received tools response: {}", json_str));
                            if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(&json_str) {
                                if let Some(result) = response.result {
                                    info("[list_tools] Successfully parsed tools result");
                                    Ok(JsValue::from_str(&json!({
                                        "result": result
                                    }).to_string()))
                                } else if let Some(error) = response.error {
                                    info("[list_tools] Error in tools response");
                                    Ok(JsValue::from_str(&json!({
                                        "error": error
                                    }).to_string()))
                                } else {
                                    error("[list_tools] No result or error in response");
                                    Err(JsValue::from_str("No result or error in response"))
                                }
                            } else {
                                error("[list_tools] Failed to parse tools response");
                                Err(JsValue::from_str("Failed to parse tools response"))
                            }
                        }
                        Err(e) => {
                            error(&format!("[list_tools] Failed to parse response: {:?}", e));
                            Err(JsValue::from_str(&format!("Failed to parse response: {:?}", e)))
                        }
                    }
                } else {
                    error("[list_tools] Server returned error response");
                    Err(JsValue::from_str("Server returned error response"))
                }
            } else {
                error("[list_tools] Failed to get response");
                Err(JsValue::from_str("Failed to get response"))
            }
        }
        Err(e) => {
            error(&format!("[list_tools] Failed to connect to server: {:?}", e));
            Err(JsValue::from_str(&format!("Failed to connect to server: {:?}", e)))
        }
    }
}

#[wasm_bindgen]
pub fn get_compiled_info() -> String {
    format!("v{} built {} ({})", 
        VERSION,
        BUILD_DATETIME,
        &BUILD_HASH[..8]
    )
}

#[wasm_bindgen]
pub async fn call_tool(url: &str, tool_name: &str, args: JsValue) -> Result<JsValue, JsValue> {
    info(&format!("Calling tool '{}' on {}", tool_name, url));
    let args_value: serde_json::Value = serde_wasm_bindgen::from_value(args).map_err(|e| JsValue::from_str(&format!("Invalid args: {}", e)))?;
    let call_request = json!({
        "jsonrpc": "2.0",
        "id": js_sys::Date::now() as u64,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": args_value
        }
    });
    let options = js_sys::Object::new();
    let headers = web_sys::Headers::new().unwrap();
    headers.set("Content-Type", "application/json").unwrap();
    if let Some(server) = SERVER_REGISTRY.lock().unwrap().servers.get(url) {
        if let Some(session_id) = &server.session_id {
            headers.set("mcp-session-id", session_id).unwrap();
        }
    }
    js_sys::Reflect::set(&options, &"headers".into(), &headers.into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &JsValue::from_str(&call_request.to_string())).unwrap();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    let promise = fetch(url, &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    let status = resp.status();
                    let json = JsFuture::from(resp.json().unwrap()).await?;
                    let text = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap_or_default();
                    if DEBUG_MODE.load(Ordering::Relaxed) {
                        debug(&format!("Received response (status {}): {}", status, text));
                    }
                    match serde_json::from_str::<JsonRpcResponse>(&text) {
                        Ok(response) => {
                            let json_str = serde_json::to_string(&response.result).unwrap_or_default();
                            debug(&format!("Received tool call response: {}", json_str));
                            Ok(JsValue::from_str(&json_str))
                        }
                        Err(e) => Err(JsValue::from_str(&format!("Failed to parse response: {}", e)))
                    }
                } else {
                    Err(JsValue::from_str("Server returned error response"))
                }
            } else {
                Err(JsValue::from_str("Failed to get response"))
            }
        }
        Err(e) => Err(JsValue::from_str(&format!("Failed to connect to server: {:?}", e)))
    }
}

#[wasm_bindgen]
pub fn set_debug_mode(enabled: bool) {
    DEBUG_MODE.store(enabled, Ordering::Relaxed);
    log(&format!("set_debug_mode called: {}", enabled));
}

#[wasm_bindgen]
pub fn get_bootrom() -> String {
    let bootrom_event = serde_json::json!({
        "id": "bootrom",
        "name": "BOOTROM",
        "text": BOOTROM_DATA,
        "timestamp": 0u64
    });
    bootrom_event.to_string()
}
