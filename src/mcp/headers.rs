//! Values mirrored into Streamable HTTP headers: `Mcp-Name` and `Mcp-Param-{Name}`.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{Map, Value};
use std::collections::HashSet;

const SENTINEL_PREFIX: &str = "=?base64?";
const SENTINEL_SUFFIX: &str = "?=";

/// Encodes a value for `Mcp-Name` or `Mcp-Param-*`, switching to the `=?base64?...?=` form
/// whenever the value isn't safe as a plain header value.
pub fn encode_header_value(value: &str) -> String {
    if is_plain_header_value(value) {
        value.to_string()
    } else {
        format!("{SENTINEL_PREFIX}{}{SENTINEL_SUFFIX}", STANDARD.encode(value.as_bytes()))
    }
}

fn is_plain_header_value(value: &str) -> bool {
    let visible_ascii = value.bytes().all(|b| b == b'\t' || (0x20..=0x7e).contains(&b));
    let trimmed = !value.starts_with([' ', '\t']) && !value.ends_with([' ', '\t']);
    let looks_encoded = value.starts_with(SENTINEL_PREFIX) && value.ends_with(SENTINEL_SUFFIX);
    visible_ascii && trimmed && !looks_encoded
}

/// RFC 9110 `token`, the syntax required of `x-mcp-header` names.
pub fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// A tool parameter the server wants mirrored into a `Mcp-Param-{header}` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderParam {
    pub header: String,
    pub path: Vec<String>,
}

/// Checks a tool definition from `tools/list`. Clients must hide tools whose `x-mcp-header`
/// annotations are invalid, so a bad tool doesn't take the rest of the list down with it.
pub fn validate_tool(tool: &Value) -> Result<(), String> {
    match tool.get("name").and_then(Value::as_str) {
        Some(name) if !name.is_empty() => {}
        _ => return Err("the tool has no name".to_string()),
    }
    match tool.get("inputSchema") {
        Some(schema) => header_params(schema).map(|_| ()),
        None => Ok(()),
    }
}

/// Collects the `x-mcp-header` annotations of an input schema, or explains why they're invalid.
pub fn header_params(input_schema: &Value) -> Result<Vec<HeaderParam>, String> {
    let mut params = Vec::new();
    collect(input_schema, &mut Vec::new(), Reach::Root, &mut params)?;
    let mut seen = HashSet::new();
    for param in &params {
        if !seen.insert(param.header.to_ascii_lowercase()) {
            return Err(format!("x-mcp-header \"{}\" is used more than once", param.header));
        }
    }
    Ok(params)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Reach {
    Root,
    /// Reached from the root through `properties` keys only, the one path headers may use.
    Property,
    Unreachable,
}

/// Keywords whose values are instance data rather than subschemas.
const DATA_KEYWORDS: &[&str] = &["enum", "const", "default", "examples"];

fn collect(schema: &Value, path: &mut Vec<String>, reach: Reach, out: &mut Vec<HeaderParam>) -> Result<(), String> {
    let obj = match schema {
        Value::Object(obj) => obj,
        Value::Array(items) => {
            for item in items {
                collect(item, path, Reach::Unreachable, out)?;
            }
            return Ok(());
        }
        _ => return Ok(()),
    };
    if let Some(annotation) = obj.get("x-mcp-header") {
        let name = annotation.as_str().ok_or("x-mcp-header must be a string")?;
        if reach != Reach::Property {
            return Err(format!("x-mcp-header \"{name}\" isn't on a parameter reachable through properties alone"));
        }
        if !is_token(name) {
            return Err(format!("x-mcp-header \"{name}\" isn't a valid header name"));
        }
        if !has_header_safe_type(obj) {
            return Err(format!("x-mcp-header \"{name}\" is on a parameter that isn't a string, integer or boolean"));
        }
        out.push(HeaderParam { header: name.to_string(), path: path.clone() });
    }
    for (key, value) in obj {
        match key.as_str() {
            "x-mcp-header" => {}
            "properties" => {
                let Some(props) = value.as_object() else { continue };
                let child_reach = if reach == Reach::Unreachable { Reach::Unreachable } else { Reach::Property };
                for (name, child) in props {
                    path.push(name.clone());
                    collect(child, path, child_reach, out)?;
                    path.pop();
                }
            }
            k if DATA_KEYWORDS.contains(&k) => {}
            _ => collect(value, path, Reach::Unreachable, out)?,
        }
    }
    Ok(())
}

fn has_header_safe_type(schema: &Map<String, Value>) -> bool {
    const ALLOWED: &[&str] = &["string", "integer", "boolean"];
    match schema.get("type") {
        Some(Value::String(t)) => ALLOWED.contains(&t.as_str()),
        Some(Value::Array(types)) => {
            let names: Vec<&str> = types.iter().filter_map(Value::as_str).collect();
            names.len() == types.len()
                && names.iter().any(|t| ALLOWED.contains(t))
                && names.iter().all(|t| ALLOWED.contains(t) || *t == "null")
        }
        _ => false,
    }
}

/// Builds the `Mcp-Param-*` headers for a call. Parameters that are absent or null are omitted.
pub fn param_header_values(params: &[HeaderParam], args: &Value) -> Vec<(String, String)> {
    params
        .iter()
        .filter_map(|param| {
            let value = param.path.iter().try_fold(args, |node, key| node.get(key))?;
            let text = match value {
                Value::String(s) => s.clone(),
                Value::Bool(b) => b.to_string(),
                Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
                Value::Number(n) => {
                    let f = n.as_f64()?;
                    if f.fract() != 0.0 || f.abs() >= 9_007_199_254_740_992.0 {
                        return None;
                    }
                    format!("{}", f as i64)
                }
                _ => return None,
            };
            Some((format!("Mcp-Param-{}", param.header), encode_header_value(&text)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_values_like_the_spec_examples() {
        assert_eq!(encode_header_value("us-west1"), "us-west1");
        assert_eq!(encode_header_value("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
        assert_eq!(encode_header_value(" padded "), "=?base64?IHBhZGRlZCA=?=");
        assert_eq!(encode_header_value("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
        assert_eq!(encode_header_value("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
    }

    #[test]
    fn keeps_plain_values_with_inner_spaces() {
        assert_eq!(encode_header_value("get weather"), "get weather");
        assert_eq!(encode_header_value("file:///projects/app/config.json"), "file:///projects/app/config.json");
    }

    #[test]
    fn validates_header_name_tokens() {
        assert!(is_token("Region"));
        assert!(is_token("X-Tenant_ID.v2"));
        assert!(!is_token(""));
        assert!(!is_token("Bad Name"));
        assert!(!is_token("Line\nBreak"));
        assert!(!is_token("Ümlaut"));
    }

    fn sql_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" },
                "query": { "type": "string" },
                "options": {
                    "type": "object",
                    "properties": {
                        "priority": { "type": "integer", "x-mcp-header": "Priority" },
                        "dryRun": { "type": ["boolean", "null"], "x-mcp-header": "Dry-Run" }
                    }
                }
            }
        })
    }

    #[test]
    fn collects_annotations_along_properties_chains() {
        let mut params = header_params(&sql_schema()).unwrap();
        params.sort_by(|a, b| a.header.cmp(&b.header));
        assert_eq!(
            params,
            vec![
                HeaderParam { header: "Dry-Run".into(), path: vec!["options".into(), "dryRun".into()] },
                HeaderParam { header: "Priority".into(), path: vec!["options".into(), "priority".into()] },
                HeaderParam { header: "Region".into(), path: vec!["region".into()] },
            ]
        );
    }

    #[test]
    fn rejects_annotations_off_the_properties_chain() {
        let in_items = json!({ "type": "object", "properties": { "tags": { "type": "array", "items": { "type": "string", "x-mcp-header": "Tag" } } } });
        let in_one_of = json!({ "type": "object", "oneOf": [ { "properties": { "a": { "type": "string", "x-mcp-header": "A" } } } ] });
        let in_defs = json!({ "type": "object", "$defs": { "a": { "type": "string", "x-mcp-header": "A" } } });
        let on_root = json!({ "type": "object", "x-mcp-header": "Root" });
        for schema in [in_items, in_one_of, in_defs, on_root] {
            assert!(header_params(&schema).is_err(), "{schema}");
        }
    }

    #[test]
    fn rejects_bad_names_types_and_duplicates() {
        let number = json!({ "properties": { "n": { "type": "number", "x-mcp-header": "N" } } });
        let object = json!({ "properties": { "o": { "type": "object", "x-mcp-header": "O" } } });
        let untyped = json!({ "properties": { "u": { "x-mcp-header": "U" } } });
        let bad_name = json!({ "properties": { "s": { "type": "string", "x-mcp-header": "Bad Name" } } });
        let duplicate = json!({ "properties": {
            "a": { "type": "string", "x-mcp-header": "Region" },
            "b": { "type": "string", "x-mcp-header": "region" }
        } });
        for schema in [number, object, untyped, bad_name, duplicate] {
            assert!(header_params(&schema).is_err(), "{schema}");
        }
    }

    #[test]
    fn ignores_annotation_like_keys_in_data_keywords() {
        let schema = json!({ "properties": { "s": { "type": "string", "default": { "x-mcp-header": "nope" } } } });
        assert_eq!(header_params(&schema).unwrap(), vec![]);
    }

    #[test]
    fn validates_whole_tool_definitions() {
        assert!(validate_tool(&json!({ "name": "execute_sql", "inputSchema": sql_schema() })).is_ok());
        assert!(validate_tool(&json!({ "name": "no_schema" })).is_ok());
        assert!(validate_tool(&json!({ "inputSchema": {} })).is_err());
        assert!(validate_tool(&json!({ "name": "bad", "inputSchema": { "properties": { "n": { "type": "number", "x-mcp-header": "N" } } } })).is_err());
    }

    #[test]
    fn builds_param_headers_from_call_arguments() {
        let params = header_params(&sql_schema()).unwrap();
        let args = json!({ "region": "us-west1", "query": "SELECT 1", "options": { "priority": 42, "dryRun": null } });
        let mut headers = param_header_values(&params, &args);
        headers.sort();
        assert_eq!(
            headers,
            vec![
                ("Mcp-Param-Priority".to_string(), "42".to_string()),
                ("Mcp-Param-Region".to_string(), "us-west1".to_string()),
            ]
        );
    }

    #[test]
    fn converts_and_encodes_param_values() {
        let params = header_params(&sql_schema()).unwrap();
        let args = json!({ "region": "Zürich", "options": { "priority": 7.0, "dryRun": true } });
        let mut headers = param_header_values(&params, &args);
        headers.sort();
        assert_eq!(
            headers,
            vec![
                ("Mcp-Param-Dry-Run".to_string(), "true".to_string()),
                ("Mcp-Param-Priority".to_string(), "7".to_string()),
                ("Mcp-Param-Region".to_string(), "=?base64?WsO8cmljaA==?=".to_string()),
            ]
        );
    }
}
