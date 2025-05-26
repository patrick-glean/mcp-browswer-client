use core::slice;
use core::str;
use std::net::TcpStream;
use std::io::{Write, Read};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

const VERSION: &str = env!("CARGO_PKG_VERSION");

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

#[no_mangle]
pub extern "C" fn get_timestamp() -> u64 {
    // This will be implemented in JavaScript
    // The JavaScript function returns a BigInt, which will be converted to u64 here
    get_timestamp_js() as u64
}

#[no_mangle]
pub extern "C" fn get_timestamp_js() -> i64 {
    // This will be implemented in JavaScript
    0
}

#[no_mangle]
pub extern "C" fn get_uptime() -> u64 {
    UPTIME.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn increment_uptime() {
    UPTIME.fetch_add(1, Ordering::Relaxed);
    let uptime = UPTIME.load(Ordering::Relaxed);
    info(&format!("WASM uptime: {} seconds", uptime));
}

fn log_with_level(level: LogLevel, message: &str) {
    let entry = LogEntry::new(level, message.to_string());
    let json = serde_json::to_string(&entry).unwrap_or_else(|_| format!("{{\"error\": \"Failed to serialize log entry\"}}"));
    let ptr = json.as_ptr();
    let len = json.len();
    log_js(ptr, len);
}

fn debug(message: &str) {
    log_with_level(LogLevel::DEBUG, message);
}

fn info(message: &str) {
    log_with_level(LogLevel::INFO, message);
}

fn error(message: &str) {
    log_with_level(LogLevel::ERROR, message);
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn get_version() -> *mut u8 {
    info(&format!("Getting version info: {}", VERSION));
    let version = format!("MCP Client WASM v{}", VERSION);
    let bytes = version.as_bytes();
    let ptr = alloc(bytes.len());
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
    }
    ptr
}

#[no_mangle]
pub extern "C" fn health_check() -> u32 {
    info("WASM health check initiated");
    debug(&format!("WASM Module Version: {}", VERSION));
    
    // Try to connect to MCP server
    if let Ok(mut stream) = TcpStream::connect("localhost:8081") {
        info("Connected to MCP server");
        if let Err(e) = stream.write_all(b"HEALTH_CHECK") {
            error(&format!("Error sending health check: {}", e));
            return 1;
        }
        debug("Health check request sent");

        // Read response
        let mut response = String::new();
        if let Err(e) = stream.read_to_string(&mut response) {
            error(&format!("Error reading health check response: {}", e));
            return 1;
        }

        info(&format!("Health check response: {}", response));
        0
    } else {
        error("Failed to connect to MCP server for health check");
        1
    }
}

#[no_mangle]
pub extern "C" fn handle_message(ptr: *const u8, len: usize) -> u32 {
    let input = unsafe { slice::from_raw_parts(ptr, len) };
    if let Ok(s) = str::from_utf8(input) {
        info(&format!("Processing message: {}", s));
        // Send message to MCP server
        if let Ok(mut stream) = TcpStream::connect("localhost:8081") {
            if let Err(e) = stream.write_all(s.as_bytes()) {
                error(&format!("Error sending message: {}", e));
                return 1;
            }

            // Read response
            let mut response = String::new();
            if let Err(e) = stream.read_to_string(&mut response) {
                error(&format!("Error reading response: {}", e));
                return 1;
            }

            info(&format!("Server response: {}", response));
        } else {
            error("Failed to connect to MCP server");
            return 1;
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn log_js(_ptr: *const u8, _len: usize) {
    // This function will be implemented in JavaScript
}
