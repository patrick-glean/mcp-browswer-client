//! Structured console logging for the WASM module; it shows up in the service worker's console.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use wasm_bindgen::prelude::*;

static DEBUG_MODE: AtomicBool = AtomicBool::new(false);

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[derive(Serialize)]
#[serde(rename_all = "UPPERCASE")]
enum Level {
    Debug,
    Info,
    Warn,
}

#[derive(Serialize)]
struct Entry<'a> {
    timestamp: u64,
    level: Level,
    message: &'a str,
    module: &'static str,
}

fn emit(level: Level, message: &str) {
    let entry = Entry { timestamp: js_sys::Date::now() as u64, level, message, module: "mcp_client" };
    if let Ok(json) = serde_json::to_string(&entry) {
        log(&format!("[WASM] {json}"));
    }
}

pub fn set_debug(enabled: bool) {
    DEBUG_MODE.store(enabled, Ordering::Relaxed);
}

pub fn debug_enabled() -> bool {
    DEBUG_MODE.load(Ordering::Relaxed)
}

pub fn debug(message: &str) {
    if debug_enabled() {
        emit(Level::Debug, message);
    }
}

pub fn info(message: &str) {
    emit(Level::Info, message);
}

pub fn warn(message: &str) {
    emit(Level::Warn, message);
}
