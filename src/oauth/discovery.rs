//! Finding where to sign in. The server's protected resource metadata (RFC 9728) names its
//! authorization server, whose own metadata (RFC 8414, or OpenID Connect discovery) lists the
//! endpoints. Both are tried at the URLs, and in the order, the MCP spec prescribes.

use super::{auth_failed, urls};
use crate::error::{ErrorKind, McpError};
use crate::http::{self, Request};
use crate::logging;
use serde::Serialize;
use serde_json::Value;

const DISCOVERY_TIMEOUT_MS: i32 = 15_000;

/// The parameters of a `WWW-Authenticate: Bearer ...` challenge.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Challenge {
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResourceMetadata {
    /// The resource identifier tokens are requested for (the `resource` parameter).
    pub resource: String,
    pub metadata_url: String,
    pub authorization_servers: Vec<String>,
    pub scopes_supported: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthServer {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub scopes_supported: Vec<String>,
    /// The server names itself (`iss`) in authorization responses (RFC 9207).
    pub iss_parameter_supported: bool,
    pub metadata_url: String,
}

/// Reads the Bearer challenge out of a `WWW-Authenticate` header, which may hold several.
pub fn parse_challenge(header: &str) -> Option<Challenge> {
    let start = find_bearer(header)?;
    let mut rest = &header[start + "bearer".len()..];
    let mut challenge = Challenge::default();
    loop {
        rest = rest.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
        let name_len = rest.find(|c: char| c == '=' || c == ',' || c.is_whitespace()).unwrap_or(rest.len());
        if name_len == 0 {
            break;
        }
        let name = &rest[..name_len];
        // A name without "=" starts the next challenge, such as "Basic realm=...".
        let Some(after_equals) = rest[name_len..].trim_start().strip_prefix('=') else { break };
        let after_equals = after_equals.trim_start();
        let (value, remaining) = match after_equals.strip_prefix('"') {
            Some(quoted) => read_quoted(quoted),
            None => {
                let end = after_equals.find(|c: char| c == ',' || c.is_whitespace()).unwrap_or(after_equals.len());
                (after_equals[..end].to_string(), &after_equals[end..])
            }
        };
        match name.to_ascii_lowercase().as_str() {
            "resource_metadata" => challenge.resource_metadata = Some(value),
            "scope" => challenge.scope = Some(value),
            "error" => challenge.error = Some(value),
            "error_description" => challenge.error_description = Some(value),
            _ => {}
        }
        rest = remaining;
    }
    Some(challenge)
}

/// Where the Bearer scheme starts: at the beginning, or after the comma ending another challenge.
fn find_bearer(header: &str) -> Option<usize> {
    let lower = header.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("bearer") {
        let at = from + found;
        let before = lower[..at].trim_end();
        let starts_challenge = before.is_empty() || before.ends_with(',');
        let ends_word = lower[at + "bearer".len()..].chars().next().map_or(true, |c| c.is_whitespace() || c == ',');
        if starts_challenge && ends_word {
            return Some(at);
        }
        from = at + "bearer".len();
    }
    None
}

/// A quoted-string's value, unescaped, and what follows its closing quote.
fn read_quoted(text: &str) -> (String, &str) {
    let mut value = String::new();
    let mut chars = text.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                if let Some((_, escaped)) = chars.next() {
                    value.push(escaped);
                }
            }
            '"' => return (value, &text[i + 1..]),
            other => value.push(other),
        }
    }
    (value, "")
}

/// Protected resource metadata URLs: the challenge's when the browser could read it, then the
/// well-known URL for the server's path, then the one at the root.
pub fn resource_metadata_urls(server_url: &str, challenge: Option<&Challenge>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    if let Some(url) = challenge.and_then(|c| c.resource_metadata.as_deref()).filter(|u| !u.is_empty()) {
        found.push(url.to_string());
    }
    if let Some((origin, path)) = urls::split(server_url) {
        if !path.is_empty() && path != "/" {
            found.push(format!("{origin}/.well-known/oauth-protected-resource{path}"));
        }
        found.push(format!("{origin}/.well-known/oauth-protected-resource"));
    }
    found.dedup();
    found
}

pub fn parse_resource_metadata(body: &Value, server_url: &str, metadata_url: &str) -> Result<ResourceMetadata, McpError> {
    let resource = body
        .get("resource")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())
        .ok_or_else(|| auth_failed(format!("The protected resource metadata at {metadata_url} doesn't name its resource.")))?;
    if !resource_matches(resource, server_url) {
        return Err(auth_failed(format!(
            "The protected resource metadata at {metadata_url} is for {resource}, not {server_url}, so this client won't use it to sign in."
        )));
    }
    let authorization_servers = strings(body.get("authorization_servers"));
    if authorization_servers.is_empty() {
        return Err(auth_failed(format!("The protected resource metadata at {metadata_url} lists no authorization server.")));
    }
    Ok(ResourceMetadata {
        resource: resource.to_string(),
        metadata_url: metadata_url.to_string(),
        authorization_servers,
        scopes_supported: strings(body.get("scopes_supported")),
    })
}

/// The metadata's resource has to be the server URL itself or a parent of it on the same
/// origin: it becomes the audience of the token.
pub fn resource_matches(resource: &str, server_url: &str) -> bool {
    let (Some((resource_origin, resource_path)), Some((server_origin, server_path))) = (urls::split(resource), urls::split(server_url)) else {
        return false;
    };
    if !resource_origin.eq_ignore_ascii_case(server_origin) {
        return false;
    }
    let resource_path = urls::path_only(resource_path).trim_end_matches('/');
    let server_path = urls::path_only(server_path).trim_end_matches('/');
    resource_path.is_empty() || server_path == resource_path || server_path.starts_with(&format!("{resource_path}/"))
}

/// Authorization server metadata URLs in the spec's order: RFC 8414, then OpenID Connect
/// discovery, with the issuer's path inserted after the host and, for OpenID, also appended.
pub fn auth_server_metadata_urls(issuer: &str) -> Vec<String> {
    let Some((origin, path)) = urls::split(issuer) else { return Vec::new() };
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server{path}"),
            format!("{origin}/.well-known/openid-configuration{path}"),
            format!("{origin}{path}/.well-known/openid-configuration"),
        ]
    }
}

pub fn parse_auth_server_metadata(body: &Value, issuer: &str, metadata_url: &str) -> Result<AuthServer, McpError> {
    let named = body.get("issuer").and_then(Value::as_str).unwrap_or_default();
    if named != issuer {
        return Err(auth_failed(format!(
            "The authorization server metadata at {metadata_url} is for issuer {named:?}, not {issuer}, so it can't be trusted."
        )));
    }
    let endpoint = |name: &str| body.get(name).and_then(Value::as_str).filter(|v| !v.is_empty()).map(String::from);
    let authorization_endpoint =
        endpoint("authorization_endpoint").ok_or_else(|| auth_failed(format!("{issuer} doesn't list an authorization_endpoint.")))?;
    let token_endpoint = endpoint("token_endpoint").ok_or_else(|| auth_failed(format!("{issuer} doesn't list a token_endpoint.")))?;
    if !strings(body.get("code_challenge_methods_supported")).iter().any(|method| method == "S256") {
        return Err(auth_failed(format!(
            "{issuer} doesn't advertise PKCE with S256 (code_challenge_methods_supported), which MCP requires, so this client won't sign in there."
        )));
    }
    Ok(AuthServer {
        issuer: issuer.to_string(),
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: endpoint("registration_endpoint"),
        scopes_supported: strings(body.get("scopes_supported")),
        iss_parameter_supported: body.get("authorization_response_iss_parameter_supported").and_then(Value::as_bool).unwrap_or(false),
        metadata_url: metadata_url.to_string(),
    })
}

pub async fn find_resource_metadata(server_url: &str, challenge: Option<&Challenge>) -> Result<ResourceMetadata, McpError> {
    let mut misses = Vec::new();
    for url in resource_metadata_urls(server_url, challenge) {
        match fetch_json(&url, server_url).await {
            Ok(body) => {
                let metadata = parse_resource_metadata(&body, server_url, &url)?;
                logging::info(
                    server_url,
                    &format!("Found the protected resource metadata at {url}; the authorization server is {}", metadata.authorization_servers[0]),
                );
                return Ok(metadata);
            }
            Err(miss) => misses.push(miss),
        }
    }
    Err(auth_failed(format!(
        "Couldn't find the server's protected resource metadata, which says where to sign in. Tried {}.",
        misses.join("; ")
    )))
}

pub async fn find_auth_server(server_url: &str, issuer: &str) -> Result<AuthServer, McpError> {
    let mut misses = Vec::new();
    for url in auth_server_metadata_urls(issuer) {
        match fetch_json(&url, server_url).await {
            Ok(body) => {
                let server = parse_auth_server_metadata(&body, issuer, &url)?;
                logging::debug(server_url, &format!("Read the authorization server metadata from {url}"));
                return Ok(server);
            }
            Err(miss) => misses.push(miss),
        }
    }
    Err(auth_failed(format!("Couldn't read {issuer}'s authorization server metadata. Tried {}.", misses.join("; "))))
}

/// The JSON document at `url`, or a note on why there isn't one.
async fn fetch_json(url: &str, server_url: &str) -> Result<Value, String> {
    match http::send(&Request::get(url), server_url, DISCOVERY_TIMEOUT_MS).await {
        Ok(response) if (200..300).contains(&response.status) => response.json.ok_or_else(|| format!("{url} (not JSON)")),
        Ok(response) => Err(format!("{url} (HTTP {})", response.status)),
        Err(err) if err.kind == ErrorKind::Network => Err(format!("{url} (unreachable or blocked by CORS)")),
        Err(err) => Err(format!("{url} ({})", err.message)),
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const GLEAN: &str = "https://acme-be.glean.com/mcp/default";

    #[test]
    fn reads_bearer_challenges() {
        let glean = r#"Bearer resource_metadata="https://acme-be.glean.com/.well-known/oauth-protected-resource/mcp/default", scope="mcp", error="invalid_token", error_description="Authentication required""#;
        let challenge = parse_challenge(glean).unwrap();
        assert_eq!(challenge.resource_metadata.as_deref(), Some("https://acme-be.glean.com/.well-known/oauth-protected-resource/mcp/default"));
        assert_eq!(challenge.scope.as_deref(), Some("mcp"));
        assert_eq!(challenge.error.as_deref(), Some("invalid_token"));
        assert_eq!(challenge.error_description.as_deref(), Some("Authentication required"));

        let several = r#"Basic realm="x", Bearer scope=files:read, error_description="say \"hi\"""#;
        let challenge = parse_challenge(several).unwrap();
        assert_eq!(challenge.scope.as_deref(), Some("files:read"));
        assert_eq!(challenge.error_description.as_deref(), Some(r#"say "hi""#));
        assert_eq!(parse_challenge("Bearer").unwrap(), Challenge::default());
        assert_eq!(parse_challenge(r#"Basic realm="bearer""#), None);
    }

    #[test]
    fn tries_resource_metadata_urls_in_the_spec_order() {
        let challenge = Challenge { resource_metadata: Some("https://acme-be.glean.com/meta".into()), ..Challenge::default() };
        assert_eq!(
            resource_metadata_urls(GLEAN, Some(&challenge)),
            vec![
                "https://acme-be.glean.com/meta",
                "https://acme-be.glean.com/.well-known/oauth-protected-resource/mcp/default",
                "https://acme-be.glean.com/.well-known/oauth-protected-resource",
            ]
        );
        assert_eq!(resource_metadata_urls("http://127.0.0.1:8081/", None), vec!["http://127.0.0.1:8081/.well-known/oauth-protected-resource"]);
    }

    #[test]
    fn accepts_metadata_only_for_this_server_or_a_parent() {
        assert!(resource_matches(GLEAN, GLEAN));
        assert!(resource_matches("https://ACME-BE.glean.com/mcp/default/", GLEAN));
        assert!(resource_matches("https://acme-be.glean.com", GLEAN));
        assert!(resource_matches("http://127.0.0.1:8081/", "http://127.0.0.1:8081"));
        assert!(!resource_matches("https://acme-be.glean.com/mcp/other", GLEAN));
        assert!(!resource_matches("https://acme-be.glean.com/mc", GLEAN));
        assert!(!resource_matches("https://evil.test/mcp/default", GLEAN));

        let metadata = json!({ "resource": GLEAN, "authorization_servers": ["https://acme-be.glean.com/oauth"], "scopes_supported": ["mcp"] });
        let parsed = parse_resource_metadata(&metadata, GLEAN, "m").unwrap();
        assert_eq!(parsed.authorization_servers, vec!["https://acme-be.glean.com/oauth"]);
        assert_eq!(parsed.scopes_supported, vec!["mcp"]);
        let elsewhere = json!({ "resource": "https://evil.test/mcp", "authorization_servers": ["https://evil.test"] });
        assert_eq!(parse_resource_metadata(&elsewhere, GLEAN, "m").unwrap_err().kind, ErrorKind::AuthFailed);
        assert!(parse_resource_metadata(&json!({ "resource": GLEAN }), GLEAN, "m").is_err());
    }

    #[test]
    fn tries_auth_server_metadata_urls_in_the_spec_order() {
        assert_eq!(
            auth_server_metadata_urls("https://acme-be.glean.com/oauth"),
            vec![
                "https://acme-be.glean.com/.well-known/oauth-authorization-server/oauth",
                "https://acme-be.glean.com/.well-known/openid-configuration/oauth",
                "https://acme-be.glean.com/oauth/.well-known/openid-configuration",
            ]
        );
        assert_eq!(
            auth_server_metadata_urls("https://auth.test/"),
            vec!["https://auth.test/.well-known/oauth-authorization-server", "https://auth.test/.well-known/openid-configuration"]
        );
    }

    #[test]
    fn trusts_auth_server_metadata_only_for_its_issuer_and_with_s256() {
        let issuer = "https://acme-be.glean.com/oauth";
        let glean = json!({
            "issuer": issuer,
            "authorization_endpoint": "https://acme-be.glean.com/oauth/authorize",
            "token_endpoint": "https://acme-be.glean.com/oauth/token",
            "registration_endpoint": "https://acme-be.glean.com/oauth/register",
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["mcp", "offline_access"]
        });
        let server = parse_auth_server_metadata(&glean, issuer, "m").unwrap();
        assert_eq!(server.registration_endpoint.as_deref(), Some("https://acme-be.glean.com/oauth/register"));
        assert!(!server.iss_parameter_supported);

        let mut impostor = glean.clone();
        impostor["issuer"] = json!("https://evil.test");
        assert!(parse_auth_server_metadata(&impostor, issuer, "m").unwrap_err().message.contains("can't be trusted"));
        let mut plain = glean.clone();
        plain["code_challenge_methods_supported"] = json!(["plain"]);
        assert!(parse_auth_server_metadata(&plain, issuer, "m").unwrap_err().message.contains("S256"));
        let mut silent = glean;
        silent.as_object_mut().unwrap().remove("code_challenge_methods_supported");
        assert!(parse_auth_server_metadata(&silent, issuer, "m").is_err());
    }
}
