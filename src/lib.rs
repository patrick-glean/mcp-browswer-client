use core::str;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use wasm_bindgen::prelude::*;
use serde::{Deserialize};
use serde_json;
use js_sys::Date;
use web_sys;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen::JsCast;
use std::sync::LazyLock;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const METADATA_VERSION: &str = "1.0.0";
const DEFAULT_SERVER_URL: &str = "http://localhost:8081";

static UPTIME: AtomicU64 = AtomicU64::new(0);
static SERVER_URL: LazyLock<std::sync::atomic::AtomicPtr<String>> = LazyLock::new(|| {
    std::sync::atomic::AtomicPtr::new(Box::into_raw(Box::new(String::from(DEFAULT_SERVER_URL))))
});

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
    
    #[wasm_bindgen(js_namespace = localStorage)]
    fn getItem(key: &str) -> Option<String>;
    
    #[wasm_bindgen(js_namespace = localStorage)]
    fn setItem(key: &str, value: &str);

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
    format!("MCP Client WASM v{}", VERSION)
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
}

#[wasm_bindgen]
pub fn get_server_url() -> String {
    let url_ptr = SERVER_URL.load(Ordering::SeqCst);
    let url = unsafe { &*url_ptr };
    url.clone()
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
    
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &"HEALTH_CHECK".into()).unwrap();
    
    let promise = fetch(&server_url, &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_obj = json.dyn_ref::<js_sys::Object>().unwrap();
                            let status = js_sys::Reflect::get(&json_obj, &"status".into()).unwrap();
                            let status_str = status.as_string().unwrap_or_default();
                            
                            if status_str == "healthy" {
                                info("MCP server health check successful - server is healthy");
                                0
                            } else {
                                error("MCP server health check failed - server reported unhealthy status");
                                1
                            }
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
pub async fn handle_message(message: &str) -> Result<String, String> {
    info("handle_message called");
    info(&format!("Processing message: {}", message));
    
    let server_url = get_server_url();
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &message.into()).unwrap();
    
    let promise = fetch(&server_url, &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_str = js_sys::JSON::stringify(&json).unwrap().as_string().unwrap();
                            info(&format!("Received response: {}", json_str));
                            Ok(json_str)
                        }
                        Err(e) => {
                            let error_msg = format!("Failed to parse response: {:?}", e);
                            error(&error_msg);
                            Err(error_msg)
                        }
                    }
                } else {
                    let error_msg = "Failed to send message - received error response".to_string();
                    error(&error_msg);
                    Err(error_msg)
                }
            } else {
                let error_msg = "Failed to cast JsValue to web_sys::Response".to_string();
                error(&error_msg);
                Err(error_msg)
            }
        }
        Err(e) => {
            let error_msg = format!("Failed to connect to MCP server: {:?}", e);
            error(&error_msg);
            Err(error_msg)
        }
    }
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
    setItem("mcp_module_metadata", &json);
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
    
    setItem("mcp_module_metadata", &json);
    Ok(())
}
