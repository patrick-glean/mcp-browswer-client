use core::str;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use wasm_bindgen::prelude::*;
use serde::{Deserialize};
use serde_json::{self, json};
use js_sys::Date;
use web_sys;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen::JsCast;
use std::sync::LazyLock;
use std::collections::HashMap;

include!("build_info.rs");

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
    
    #[wasm_bindgen(js_namespace = localStorage, catch)]
    fn getItem(key: &str) -> Result<Option<String>, JsValue>;
    
    #[wasm_bindgen(js_namespace = localStorage, catch)]
    fn setItem(key: &str, value: &str) -> Result<(), JsValue>;

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
    
    // Try to set in localStorage, but don't fail if it's not available
    if let Err(e) = setItem("mcp_server_url", url) {
        debug(&format!("Failed to set server URL in localStorage: {:?}", e));
    }
}

#[wasm_bindgen]
pub fn get_server_url() -> String {
    match getItem("mcp_server_url") {
        Ok(Some(url)) => url,
        _ => {
            let url_ptr = SERVER_URL.load(Ordering::SeqCst);
            let url = unsafe { &*url_ptr };
            url.clone()
        }
    }
}

#[wasm_bindgen]
pub async fn health_check() -> u32 {
    info("WASM health check initiated");
    debug(&format!("WASM Module Version: {}", VERSION));
    
    // Basic health check - just verify the module is loaded and functioning
    // Return 0 for healthy (module is loaded and working)
    info("WASM module health check passed");
    0
}

// Add a separate MCP server health check
#[wasm_bindgen]
pub async fn check_mcp_server() -> u32 {
    info("MCP server health check initiated");
    debug(&format!("WASM Module Version: {}", VERSION));
    
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
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_str = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap();
                            debug(&format!("Received raw response: {}", json_str));
                            
                            // Parse the JSON-RPC response
                            if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(&json_str) {
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
                        }
                        Err(e) => {
                            error(&format!("Failed to parse MCP server health check response: {:?}", e));
                            1
                        }
                    }
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

#[wasm_bindgen]
pub fn add_memory_event(text: &str) {
    let event = MemoryEvent {
        timestamp: get_timestamp(),
        text: text.to_string(),
    };
    
    let mut metadata: ModuleMetadata = serde_json::from_str(&get_metadata()).unwrap_or(ModuleMetadata {
        version: METADATA_VERSION.to_string(),
        memory_events: Vec::new(),
        last_health_check: get_timestamp(),
    });
    
    metadata.memory_events.push(event);
    let json = serde_json::to_string(&metadata).unwrap_or_default();
    if let Err(e) = setItem("mcp_module_metadata", &json) {
        debug(&format!("Failed to set memory event in localStorage: {:?}", e));
    }
}

#[wasm_bindgen]
pub fn clear_memory_events() -> Result<(), String> {
    let metadata = ModuleMetadata {
        version: METADATA_VERSION.to_string(),
        memory_events: Vec::new(),
        last_health_check: get_timestamp(),
    };
    
    let json = serde_json::to_string(&metadata)
        .map_err(|e| e.to_string())?;
    
    if let Err(e) = setItem("mcp_module_metadata", &json) {
        debug(&format!("Failed to clear memory events in localStorage: {:?}", e));
    }
    Ok(())
}

#[wasm_bindgen]
pub async fn initialize_mcp_server(url: &str) -> Result<JsValue, JsValue> {
    info(&format!("Initializing MCP server at {}", url));
    
    let mut registry = SERVER_REGISTRY.lock().unwrap();
    
    // Check if server already exists
    if registry.servers.contains_key(url) {
        info(&format!("Server {} already registered", url));
        return Ok(JsValue::from_str(&json!({
            "status": "already_registered",
            "message": format!("Server {} is already registered", url)
        }).to_string()));
    }
    
    // Create new server entry
    let server = McpServer {
        url: url.to_string(),
        name: format!("MCP Server at {}", url),
        version: "unknown".to_string(),
        status: "initializing".to_string(),
        tools: Vec::new(),
        last_health_check: get_timestamp(),
    };
    
    // Add to registry
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
        "method": "initialize",
        "params": {
            "client_version": VERSION,
            "protocolVersion": "2025-03-26",
            "capabilities": ["tools"]
        },
        "id": js_sys::Date::now() as u64
    });
    
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &handshake_request.to_string().into()).unwrap();
    
    let headers = js_sys::Object::new();
    js_sys::Reflect::set(&headers, &"Content-Type".into(), &"application/json".into()).unwrap();
    js_sys::Reflect::set(&headers, &"Accept".into(), &"application/json".into()).unwrap();
    js_sys::Reflect::set(&options, &"headers".into(), &headers.into()).unwrap();
    
    let promise = fetch(url, &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_str = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap();
                            debug(&format!("Received handshake response: {}", json_str));
                            
                            // Parse the response and extract server info
                            if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(&json_str) {
                                if let Some(result) = response.result {
                                    let server_info = McpServer {
                                        url: url.to_string(),
                                        name: result.get("serverInfo")
                                            .and_then(|v| v.get("name"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Unknown")
                                            .to_string(),
                                        version: result.get("serverInfo")
                                            .and_then(|v| v.get("version"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown")
                                            .to_string(),
                                        status: "connected".to_string(),
                                        tools: result.get("tools")
                                            .and_then(|v| v.as_array())
                                            .map(|tools| tools.iter()
                                                .filter_map(|t| serde_json::from_value(t.clone()).ok())
                                                .collect())
                                            .unwrap_or_default(),
                                        last_health_check: get_timestamp(),
                                    };
                                    
                                    Ok(server_info)
                                } else {
                                    Err("No result in handshake response".to_string())
                                }
                            } else {
                                Err("Failed to parse handshake response".to_string())
                            }
                        }
                        Err(e) => Err(format!("Failed to parse response: {:?}", e))
                    }
                } else {
                    Err("Server returned error response".to_string())
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
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &tools_request.to_string().into()).unwrap();
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
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_str = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap();
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
pub fn get_compiled_info() -> String {
    format!("v{} built {} ({})", 
        VERSION,
        BUILD_DATETIME,
        &BUILD_HASH[..8]
    )
}
