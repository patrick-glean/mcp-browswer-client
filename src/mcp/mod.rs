//! MCP client for Streamable HTTP servers: the 2026-07-28 protocol, falling back to the
//! initialization-based revisions for servers that haven't upgraded.

pub mod headers;
pub mod legacy;
pub mod modern;
pub mod registry;
pub mod sse;
pub mod transport;
pub mod types;

use crate::logging;
use modern::Probe;
use registry::{Connection, Era, ToolCache};
use serde::Deserialize;
use serde_json::{json, Value};
use types::*;

const MAX_TOOL_PAGES: usize = 100;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub bearer_token: Option<String>,
    /// Refetch cached data (the tool list) instead of reusing it.
    pub refresh: bool,
}

impl Options {
    pub fn parse(json: &str) -> Result<Options, McpError> {
        if json.trim().is_empty() {
            return Ok(Options::default());
        }
        serde_json::from_str(json).map_err(|e| McpError::internal(format!("Invalid options: {e}")))
    }

    fn auth_headers(&self) -> Vec<(String, String)> {
        match self.bearer_token.as_deref().map(str::trim) {
            Some(token) if !token.is_empty() => vec![("Authorization".to_string(), format!("Bearer {token}"))],
            _ => Vec::new(),
        }
    }
}

/// Works out which era the server speaks and remembers it for later requests.
pub async fn connect(url: &str, opts: &Options) -> Result<Value, McpError> {
    let connection = establish(url, opts).await?;
    registry::put(url, connection.clone());
    Ok(connection_info(url, &connection))
}

pub fn forget(url: &str) {
    registry::remove(url);
}

/// Lists the server's tools, following `nextCursor` and reusing a list whose `ttlMs` hasn't
/// run out. Tools with invalid `x-mcp-header` annotations are left out and reported instead.
pub async fn list_tools(url: &str, opts: &Options) -> Result<Value, McpError> {
    let connection = connection_for(url, opts).await?;
    if !opts.refresh {
        if let Some(cache) = connection.tools.filter(|cache| cache.is_fresh(js_sys::Date::now())) {
            return Ok(tool_listing(&cache, true));
        }
    }
    let cache = fetch_tools(url, opts).await?;
    Ok(tool_listing(&cache, false))
}

/// Calls a tool. On modern servers, parameters the tool marks with `x-mcp-header` are also
/// sent as `Mcp-Param-*` headers; a `HeaderMismatch` means the tool's schema changed, so the
/// list is refetched and the call retried once.
pub async fn call_tool(url: &str, name: &str, args: Value, opts: &Options) -> Result<Value, McpError> {
    let connection = connection_for(url, opts).await?;
    let args = if args.is_null() { json!({}) } else { args };
    let params = json!({ "name": name, "arguments": args });
    let result = match connection.era {
        Era::Legacy => request(url, opts, "tools/call", params, &[], CALL_TIMEOUT_MS).await?,
        Era::Modern => {
            let headers = param_headers(url, name, &params["arguments"], opts, false).await?;
            match request(url, opts, "tools/call", params.clone(), &headers, CALL_TIMEOUT_MS).await {
                Err(err) if err.code == Some(HEADER_MISMATCH) => {
                    logging::info(&format!("{url} rejected the headers for {name}; refreshing its tool list"));
                    let headers = param_headers(url, name, &params["arguments"], opts, true).await?;
                    request(url, opts, "tools/call", params, &headers, CALL_TIMEOUT_MS).await?
                }
                other => other?,
            }
        }
    };
    check_result_type(result)
}

async fn fetch_tools(url: &str, opts: &Options) -> Result<ToolCache, McpError> {
    let mut tools = Vec::new();
    let mut rejected = Vec::new();
    let mut cursor: Option<String> = None;
    let mut ttl_ms = None;
    let mut cache_scope = None;
    for page in 0..MAX_TOOL_PAGES {
        let params = match &cursor {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let result = request(url, opts, "tools/list", params, &[], LIST_TIMEOUT_MS).await?;
        if page == 0 {
            ttl_ms = result.get("ttlMs").and_then(Value::as_u64);
            cache_scope = result.get("cacheScope").and_then(Value::as_str).map(String::from);
        }
        for tool in result.get("tools").and_then(Value::as_array).into_iter().flatten() {
            match headers::validate_tool(tool) {
                Ok(()) => tools.push(tool.clone()),
                Err(reason) => {
                    let name = tool.get("name").cloned().unwrap_or(Value::Null);
                    logging::warn(&format!("Hiding tool {name} from {url}: {reason}"));
                    rejected.push(json!({ "name": name, "reason": reason }));
                }
            }
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|next| !next.is_empty())
            .map(String::from);
        if cursor.is_none() {
            break;
        }
    }
    if cursor.is_some() {
        logging::warn(&format!("Stopped listing tools from {url} after {MAX_TOOL_PAGES} pages"));
    }
    let cache = ToolCache { tools, rejected, ttl_ms, cache_scope, fetched_at: js_sys::Date::now() };
    registry::set_tools(url, cache.clone());
    Ok(cache)
}

async fn param_headers(url: &str, name: &str, args: &Value, opts: &Options, refresh: bool) -> Result<Vec<(String, String)>, McpError> {
    let cached = if refresh { None } else { registry::get(url).and_then(|c| c.tools) };
    let cache = match cached {
        Some(cache) => cache,
        None => fetch_tools(url, opts).await?,
    };
    if cache.is_rejected(name) {
        return Err(McpError::new(
            ErrorKind::Protocol,
            format!("The server's definition of {name} has an invalid x-mcp-header annotation, so this client won't call it."),
        ));
    }
    let Some(schema) = cache.find(name).and_then(|tool| tool.get("inputSchema")) else {
        return Ok(Vec::new());
    };
    let params = headers::header_params(schema).unwrap_or_default();
    Ok(headers::param_header_values(&params, args))
}

fn tool_listing(cache: &ToolCache, from_cache: bool) -> Value {
    json!({
        "tools": cache.tools,
        "rejected": cache.rejected,
        "ttlMs": cache.ttl_ms,
        "cacheScope": cache.cache_scope,
        "fromCache": from_cache,
    })
}

/// Servers from before 2026-07-28 omit `resultType`, which means the result is complete.
/// `input_required` passes through so the UI can say the tool needs input it can't give yet.
fn check_result_type(result: Value) -> Result<Value, McpError> {
    match result.get("resultType").and_then(Value::as_str) {
        None | Some("complete") | Some("input_required") => Ok(result),
        Some(other) => Err(McpError::new(
            ErrorKind::InvalidResponse,
            format!("The server returned an unknown resultType \"{other}\"."),
        )),
    }
}

async fn establish(url: &str, opts: &Options) -> Result<Connection, McpError> {
    let auth = opts.auth_headers();
    let mut version = MODERN_VERSION.to_string();
    let mut probe = modern::discover(url, &version, &auth).await?;
    if let Probe::Retry(next) = probe {
        version = next;
        probe = modern::discover(url, &version, &auth).await?;
    }
    let connection = match probe {
        Probe::Modern(result) => {
            let discovery = modern::parse_discovery(&result);
            Connection {
                era: Era::Modern,
                version,
                session_id: None,
                capabilities: discovery.capabilities,
                server_info: discovery.server_info,
                instructions: discovery.instructions,
                tools: None,
            }
        }
        Probe::Legacy => {
            let session = legacy::initialize(url, &auth).await?;
            Connection {
                era: Era::Legacy,
                version: session.version,
                session_id: session.session_id,
                capabilities: session.capabilities,
                server_info: session.server_info,
                instructions: session.instructions,
                tools: None,
            }
        }
        Probe::Retry(_) => {
            return Err(McpError::new(
                ErrorKind::UnsupportedVersion,
                "The server rejected every protocol version this client supports.",
            ))
        }
        Probe::Failed(err) => return Err(err),
    };
    logging::info(&format!("Connected to {url}: {} ({})", connection.version, connection.era.as_str()));
    Ok(connection)
}

pub fn connection_info(url: &str, connection: &Connection) -> Value {
    json!({
        "url": url,
        "era": connection.era.as_str(),
        "protocolVersion": connection.version,
        "serverInfo": connection.server_info,
        "capabilities": connection.capabilities,
        "instructions": connection.instructions,
    })
}

/// The remembered connection, or a new one. After a service worker restart the registry is
/// empty, so the first request reconnects on its own.
async fn connection_for(url: &str, opts: &Options) -> Result<Connection, McpError> {
    if let Some(connection) = registry::get(url) {
        return Ok(connection);
    }
    let connection = establish(url, opts).await?;
    registry::put(url, connection.clone());
    Ok(connection)
}

/// Sends one request in whichever era the server speaks. An expired legacy session (404)
/// or a modern server that stopped accepting our version gets one reconnect and retry.
async fn request(
    url: &str,
    opts: &Options,
    method: &str,
    params: Value,
    extra_headers: &[(String, String)],
    timeout_ms: i32,
) -> Result<Value, McpError> {
    let connection = connection_for(url, opts).await?;
    match send(url, &connection, opts, method, params.clone(), extra_headers, timeout_ms).await {
        Err(err) if needs_reconnect(&connection, &err) => {
            logging::info(&format!("Reconnecting to {url}: {}", err.message));
            registry::remove(url);
            let connection = connection_for(url, opts).await?;
            send(url, &connection, opts, method, params, extra_headers, timeout_ms).await
        }
        other => other,
    }
}

fn needs_reconnect(connection: &Connection, err: &McpError) -> bool {
    match connection.era {
        Era::Legacy => connection.session_id.is_some() && err.status == Some(404),
        Era::Modern => err.code == Some(UNSUPPORTED_PROTOCOL_VERSION),
    }
}

async fn send(
    url: &str,
    connection: &Connection,
    opts: &Options,
    method: &str,
    params: Value,
    extra_headers: &[(String, String)],
    timeout_ms: i32,
) -> Result<Value, McpError> {
    let mut headers = opts.auth_headers();
    let body = match connection.era {
        Era::Modern => {
            headers.extend(modern::request_headers(method, &connection.version, &params));
            headers.extend(extra_headers.iter().cloned());
            request_body(next_request_id(), method, modern::with_meta(params, &connection.version))
        }
        Era::Legacy => {
            headers.extend(legacy::session_headers(&connection.version, connection.session_id.as_deref()));
            request_body(next_request_id(), method, params)
        }
    };
    let reply = transport::post(url, &headers, &body, timeout_ms).await?;
    transport::interpret_reply(&reply).map_err(|err| match connection.era {
        Era::Legacy => legacy::explain_missing_session(err, connection.session_id.is_some()),
        Era::Modern => err,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(era: Era, session_id: Option<&str>) -> Connection {
        Connection {
            era,
            version: MODERN_VERSION.into(),
            session_id: session_id.map(String::from),
            capabilities: json!({ "tools": {} }),
            server_info: Some(json!({ "name": "Mock", "version": "1.0.0" })),
            instructions: None,
            tools: None,
        }
    }

    #[test]
    fn parses_options_from_the_service_worker() {
        let opts = Options::parse(r#"{"bearerToken":" abc ","refresh":true}"#).unwrap();
        assert!(opts.refresh);
        assert_eq!(opts.auth_headers(), vec![("Authorization".to_string(), "Bearer abc".to_string())]);
        assert!(Options::parse("").unwrap().auth_headers().is_empty());
        assert!(Options::parse(r#"{"bearerToken":"  "}"#).unwrap().auth_headers().is_empty());
        assert!(Options::parse("not json").is_err());
    }

    #[test]
    fn reconnects_only_for_expired_sessions_or_dropped_versions() {
        let expired = McpError::new(ErrorKind::Http, "gone").with_status(404);
        assert!(needs_reconnect(&connection(Era::Legacy, Some("s1")), &expired));
        assert!(!needs_reconnect(&connection(Era::Legacy, None), &expired));
        assert!(!needs_reconnect(&connection(Era::Modern, None), &expired));

        let mut dropped = McpError::new(ErrorKind::UnsupportedVersion, "no").with_status(400);
        dropped.code = Some(UNSUPPORTED_PROTOCOL_VERSION);
        assert!(needs_reconnect(&connection(Era::Modern, None), &dropped));
        assert!(!needs_reconnect(&connection(Era::Legacy, Some("s1")), &dropped));
    }

    #[test]
    fn accepts_known_result_types_only() {
        assert!(check_result_type(json!({ "content": [] })).is_ok());
        assert!(check_result_type(json!({ "resultType": "complete", "content": [] })).is_ok());
        assert!(check_result_type(json!({ "resultType": "input_required", "inputRequests": {} })).is_ok());
        assert_eq!(check_result_type(json!({ "resultType": "later" })).unwrap_err().kind, ErrorKind::InvalidResponse);
    }

    #[test]
    fn reports_tool_listings_with_cache_details() {
        let cache = ToolCache {
            tools: vec![json!({ "name": "echo" })],
            rejected: vec![json!({ "name": "broken", "reason": "bad" })],
            ttl_ms: Some(30_000),
            cache_scope: Some("public".into()),
            fetched_at: 0.0,
        };
        let listing = tool_listing(&cache, true);
        assert_eq!(listing["tools"][0]["name"], "echo");
        assert_eq!(listing["rejected"][0]["name"], "broken");
        assert_eq!(listing["ttlMs"], 30_000);
        assert_eq!(listing["cacheScope"], "public");
        assert_eq!(listing["fromCache"], true);
    }

    #[test]
    fn describes_the_connection_for_the_ui() {
        let info = connection_info("http://localhost:8081", &connection(Era::Modern, None));
        assert_eq!(info["era"], "modern");
        assert_eq!(info["protocolVersion"], MODERN_VERSION);
        assert_eq!(info["serverInfo"]["name"], "Mock");
        assert_eq!(info["capabilities"], json!({ "tools": {} }));
    }
}
