//! Per-server connection state for the life of the WASM instance. Every access is a short
//! synchronous borrow: callers copy state out, await, then write back, so no borrow is ever
//! held across an `.await`.

use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Era {
    Modern,
    Legacy,
}

impl Era {
    pub fn as_str(self) -> &'static str {
        match self {
            Era::Modern => "modern",
            Era::Legacy => "legacy",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Connection {
    pub era: Era,
    pub version: String,
    pub session_id: Option<String>,
    pub capabilities: Value,
    pub server_info: Option<Value>,
    pub instructions: Option<String>,
    pub tools: Option<ToolCache>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCache {
    pub tools: Vec<Value>,
    pub rejected: Vec<Value>,
    pub ttl_ms: Option<u64>,
    pub cache_scope: Option<String>,
    pub fetched_at: f64,
}

impl ToolCache {
    /// Fresh only while the server's `ttlMs` allows; a list without one is always refetched.
    pub fn is_fresh(&self, now: f64) -> bool {
        self.ttl_ms.is_some_and(|ttl| now - self.fetched_at < ttl as f64)
    }

    pub fn find(&self, name: &str) -> Option<&Value> {
        self.tools.iter().find(|tool| tool_name(tool) == Some(name))
    }

    pub fn is_rejected(&self, name: &str) -> bool {
        self.rejected.iter().any(|tool| tool_name(tool) == Some(name))
    }
}

fn tool_name(tool: &Value) -> Option<&str> {
    tool.get("name").and_then(Value::as_str)
}

thread_local! {
    static CONNECTIONS: RefCell<HashMap<String, Connection>> = RefCell::new(HashMap::new());
}

pub fn get(url: &str) -> Option<Connection> {
    CONNECTIONS.with(|c| c.borrow().get(url).cloned())
}

pub fn put(url: &str, connection: Connection) {
    CONNECTIONS.with(|c| {
        c.borrow_mut().insert(url.to_string(), connection);
    });
}

pub fn set_tools(url: &str, tools: ToolCache) {
    CONNECTIONS.with(|c| {
        if let Some(connection) = c.borrow_mut().get_mut(url) {
            connection.tools = Some(tools);
        }
    });
}

pub fn remove(url: &str) {
    CONNECTIONS.with(|c| {
        c.borrow_mut().remove(url);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cache(ttl_ms: Option<u64>) -> ToolCache {
        ToolCache {
            tools: vec![json!({ "name": "echo" })],
            rejected: vec![json!({ "name": "broken", "reason": "bad header" })],
            ttl_ms,
            cache_scope: None,
            fetched_at: 1_000.0,
        }
    }

    #[test]
    fn a_tool_list_stays_fresh_for_its_ttl() {
        assert!(cache(Some(500)).is_fresh(1_499.0));
        assert!(!cache(Some(500)).is_fresh(1_500.0));
        assert!(!cache(Some(0)).is_fresh(1_000.0));
        assert!(!cache(None).is_fresh(1_000.0));
    }

    #[test]
    fn looks_up_listed_and_rejected_tools() {
        let tools = cache(None);
        assert!(tools.find("echo").is_some());
        assert!(tools.find("broken").is_none());
        assert!(tools.is_rejected("broken"));
        assert!(!tools.is_rejected("echo"));
    }

    #[test]
    fn stores_and_forgets_connections() {
        let connection = Connection {
            era: Era::Legacy,
            version: "2025-11-25".into(),
            session_id: Some("s1".into()),
            capabilities: json!({}),
            server_info: None,
            instructions: None,
            tools: None,
        };
        put("http://a", connection.clone());
        set_tools("http://a", cache(None));
        set_tools("http://unknown", cache(None));
        assert_eq!(get("http://a").unwrap().tools, Some(cache(None)));
        assert!(get("http://unknown").is_none());
        remove("http://a");
        assert!(get("http://a").is_none());
    }
}
