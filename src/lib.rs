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

const VERSION: &str = env!("CARGO_PKG_VERSION");
const METADATA_VERSION: &str = "1.0.0";

static UPTIME: AtomicU64 = AtomicU64::new(0);

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
pub async fn health_check() -> u32 {
    info("WASM health check initiated");
    debug(&format!("WASM Module Version: {}", VERSION));
    
    // Try to connect to MCP server using fetch
    info("Attempting to connect to MCP server at localhost:8081");
    
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &"HEALTH_CHECK".into()).unwrap();
    
    let promise = fetch("http://localhost:8081", &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    // Try to parse the response body
                    match JsFuture::from(resp.json().unwrap()).await {
                        Ok(json) => {
                            let json_obj = json.dyn_ref::<js_sys::Object>().unwrap();
                            let status = js_sys::Reflect::get(&json_obj, &"status".into()).unwrap();
                            let status_str = status.as_string().unwrap_or_default();
                            
                            if status_str == "healthy" {
                                info("Health check successful - server is healthy");
                                0
                            } else {
                                error("Health check failed - server reported unhealthy status");
                                1
                            }
                        }
                        Err(e) => {
                            error(&format!("Failed to parse health check response: {:?}", e));
                            1
                        }
                    }
                } else {
                    error("Health check failed - received error response");
                    1
                }
            } else {
                error("Failed to cast JsValue to web_sys::Response");
                1
            }
        }
        Err(e) => {
            error(&format!("Failed to connect to MCP server: {:?}", e));
            error("Please ensure the MCP server is running on localhost:8081");
            1
        }
    }
}

#[wasm_bindgen]
pub async fn handle_message(message: &str) -> u32 {
    info("handle_message called");
    info(&format!("Processing message: {}", message));
    
    let options = js_sys::Object::new();
    js_sys::Reflect::set(&options, &"method".into(), &"POST".into()).unwrap();
    js_sys::Reflect::set(&options, &"body".into(), &message.into()).unwrap();
    
    let promise = fetch("http://localhost:8081", &options);
    match JsFuture::from(promise).await {
        Ok(response) => {
            let resp: Option<web_sys::Response> = response.dyn_ref::<web_sys::Response>().cloned();
            if let Some(resp) = resp {
                if resp.ok() {
                    info("Message sent successfully");
                    0
                } else {
                    error("Failed to send message");
                    1
                }
            } else {
                error("Failed to cast JsValue to web_sys::Response");
                1
            }
        }
        Err(e) => {
            error(&format!("Failed to connect to MCP server: {:?}", e));
            1
        }
    }
}

#[wasm_bindgen]
pub fn get_metadata() -> Result<String, String> {
    let metadata = match getItem("mcp_module_metadata") {
        Some(json) => {
            match serde_json::from_str::<ModuleMetadata>(&json) {
                Ok(mut meta) => {
                    // Update last health check time
                    meta.last_health_check = get_timestamp();
                    meta
                },
                Err(_) => ModuleMetadata {
                    version: METADATA_VERSION.to_string(),
                    memory_events: Vec::new(),
                    last_health_check: get_timestamp(),
                }
            }
        },
        None => ModuleMetadata {
            version: METADATA_VERSION.to_string(),
            memory_events: Vec::new(),
            last_health_check: get_timestamp(),
        }
    };
    
    serde_json::to_string(&metadata).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub fn add_memory_event(text: &str) -> Result<(), JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("No window found"))?;
    
    // Try to get localStorage, but don't fail if it's not available
    if let Ok(Some(local_storage)) = window.local_storage() {
        let events = local_storage.get_item("memory_events")
            .unwrap_or_else(|_| None)
            .unwrap_or_else(|| "[]".to_string());
        
        let mut events: Vec<MemoryEvent> = serde_json::from_str(&events)
            .unwrap_or_else(|_| Vec::new());
        
        events.push(MemoryEvent {
            text: text.to_string(),
            timestamp: js_sys::Date::now() as u64,
        });
        
        let events_str = serde_json::to_string(&events)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize events: {}", e)))?;
        
        local_storage.set_item("memory_events", &events_str)
            .map_err(|e| JsValue::from_str(&format!("Failed to save events: {:?}", e)))?;
    }
    
    Ok(())
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
