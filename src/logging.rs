//! Structured logging for the WASM module. The service worker registers a logger that shows
//! each entry in every open page's Logs tab; until it does, entries go to the console.

use serde::Serialize;
use serde_json::Value;
use std::cell::RefCell;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Serialize)]
struct Entry<'a> {
    level: Level,
    server: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a Value>,
}

thread_local! {
    static LOGGER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

pub fn set_logger(logger: js_sys::Function) {
    LOGGER.with(|slot| *slot.borrow_mut() = Some(logger));
}

/// Logs one entry about `server`, the URL of the MCP server it concerns.
pub fn emit(level: Level, server: &str, message: &str, detail: Option<&Value>) {
    if let Ok(json) = serde_json::to_string(&Entry { level, server, message, detail }) {
        write(&json);
    }
}

pub fn debug(server: &str, message: &str) {
    emit(Level::Debug, server, message, None);
}

pub fn info(server: &str, message: &str) {
    emit(Level::Info, server, message, None);
}

pub fn warn(server: &str, message: &str) {
    emit(Level::Warn, server, message, None);
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

#[cfg(target_arch = "wasm32")]
fn write(json: &str) {
    // Cloned out of the cell so a logger that calls back into the module can't hit a borrow.
    let logger = LOGGER.with(|slot| slot.borrow().clone());
    match logger {
        Some(logger) => {
            let _ = logger.call1(&wasm_bindgen::JsValue::NULL, &wasm_bindgen::JsValue::from_str(json));
        }
        None => console_log(&format!("[WASM] {json}")),
    }
}

// Native unit tests have no JavaScript to log to.
#[cfg(not(target_arch = "wasm32"))]
fn write(_json: &str) {}
