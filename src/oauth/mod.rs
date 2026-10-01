//! OAuth for MCP servers that need sign-in, following the MCP authorization spec: discovery
//! through protected resource metadata, dynamic client registration, the authorization code
//! flow with PKCE, and refresh.
//!
//! Nothing is kept here between calls. The service worker stores registered clients, sign-ins
//! in progress and tokens, and passes them back in.

pub mod discovery;
mod pkce;
mod register;
pub mod tokens;
mod urls;

use crate::error::{ErrorKind, McpError};
use crate::http;
use crate::logging;
use discovery::AuthServer;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const TOKEN_TIMEOUT_MS: i32 = 20_000;

/// A client registered with one authorization server, for one redirect URI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub issuer: String,
    pub redirect_uri: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default = "public_client")]
    pub token_endpoint_auth_method: String,
}

/// A sign-in waiting for its callback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub state: String,
    pub code_verifier: String,
    pub server_url: String,
    pub resource: String,
    #[serde(default)]
    pub scope: Option<String>,
    pub redirect_uri: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default = "public_client")]
    pub token_endpoint_auth_method: String,
    pub issuer: String,
    pub token_endpoint: String,
    pub iss_parameter_supported: bool,
    pub created_at: f64,
}

/// What a sign-in produced, for one MCP server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub server_url: String,
    pub resource: String,
    pub issuer: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default = "public_client")]
    pub token_endpoint_auth_method: String,
    pub token_endpoint: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    /// Milliseconds since the epoch; absent when the server didn't say.
    #[serde(default)]
    pub expires_at: Option<f64>,
}

/// The query parameters the authorization server redirected back with.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub iss: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginOptions {
    pub redirect_uri: String,
    #[serde(default = "web_app")]
    pub application_type: String,
    /// Clients registered earlier, so this one isn't registered again.
    #[serde(default)]
    pub clients: Vec<Client>,
    /// The 401's challenge, when the browser could read it.
    #[serde(default)]
    pub www_authenticate: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Begin {
    pub authorization_url: String,
    pub pending: Pending,
    pub client: Client,
    /// The client was registered just now and should be stored.
    pub new_client: bool,
    pub auth_server: AuthServer,
    pub scope: Option<String>,
}

fn public_client() -> String {
    "none".to_string()
}

fn web_app() -> String {
    "web".to_string()
}

pub(crate) fn auth_failed(message: impl Into<String>) -> McpError {
    McpError::new(ErrorKind::AuthFailed, message)
}

/// An authorization server's error reply, e.g. "https://auth.test rejected the registration:
/// invalid_redirect_uri (loopback not allowed)".
pub(crate) fn server_error(issuer: &str, action: &str, status: u16, body: Option<&Value>) -> McpError {
    let field = |name: &str| body.and_then(|b| b.get(name)).and_then(Value::as_str);
    let detail = match (field("error"), field("error_description")) {
        (Some(code), Some(description)) => format!("{code} ({description})"),
        (Some(code), None) => code.to_string(),
        (None, Some(description)) => description.to_string(),
        (None, None) => format!("HTTP {status}"),
    };
    auth_failed(format!("{issuer} rejected the {action}: {detail}")).with_status(status)
}

/// Finds where to sign in, registers this client if needed, and returns the URL to open.
pub async fn begin(server_url: &str, options: BeginOptions) -> Result<Begin, McpError> {
    let challenge = options.www_authenticate.as_deref().and_then(discovery::parse_challenge);
    let metadata = discovery::find_resource_metadata(server_url, challenge.as_ref()).await?;
    let server = discovery::find_auth_server(server_url, &metadata.authorization_servers[0]).await?;
    let known = options
        .clients
        .into_iter()
        .find(|client| client.issuer == server.issuer && client.redirect_uri == options.redirect_uri);
    let (client, new_client) = match known {
        Some(client) => {
            logging::debug(server_url, &format!("Using client {} registered with {} earlier", client.client_id, server.issuer));
            (client, false)
        }
        None => (register::register(server_url, &server, &options.redirect_uri, &options.application_type).await?, true),
    };
    let challenge_scope = challenge.as_ref().and_then(|c| c.scope.as_deref());
    let scope = tokens::select_scope(challenge_scope, &metadata.scopes_supported, &server.scopes_supported);
    let (authorization_url, pending) = tokens::authorization_request(
        server_url,
        &metadata,
        &server,
        &client,
        scope.as_deref(),
        &pkce::random_bytes(),
        &pkce::random_bytes(),
        js_sys::Date::now(),
    );
    let scope_text = scope.as_deref().map(|s| format!(" for {s}")).unwrap_or_default();
    logging::info(server_url, &format!("Signing in with {}{scope_text}", server.issuer));
    Ok(Begin { authorization_url, pending, client, new_client, auth_server: server, scope })
}

/// Checks the callback against its sign-in and trades the code for tokens.
pub async fn finish(pending: Pending, callback: Callback) -> Result<Tokens, McpError> {
    let code = tokens::check_callback(&pending, &callback)?;
    let response = http::send(&tokens::code_request(&pending, &code), &pending.server_url, TOKEN_TIMEOUT_MS).await?;
    let reply = tokens::parse_token_reply(response.status, response.json.as_ref(), &pending.issuer, "code")?;
    let tokens = Tokens::from_code(&pending, reply, js_sys::Date::now());
    logging::info(&pending.server_url, &format!("Signed in with {}{}", tokens.issuer, describe(&tokens)));
    Ok(tokens)
}

/// Gets a new access token with the refresh token. Fails with `auth_required` when the user has
/// to sign in again.
pub async fn refresh(tokens: Tokens) -> Result<Tokens, McpError> {
    let Some(refresh_token) = tokens.refresh_token.clone() else {
        return Err(McpError::new(
            ErrorKind::AuthRequired,
            format!("The access token from {} has expired and can't be refreshed. Sign in again.", tokens.issuer),
        ));
    };
    let response = http::send(&tokens::refresh_request(&tokens, &refresh_token), &tokens.server_url, TOKEN_TIMEOUT_MS).await?;
    let reply = tokens::parse_token_reply(response.status, response.json.as_ref(), &tokens.issuer, "refresh")?;
    let refreshed = tokens.refreshed(reply, js_sys::Date::now());
    logging::info(&refreshed.server_url, &format!("Refreshed the access token{}", describe(&refreshed)));
    Ok(refreshed)
}

/// ": scope mcp, expires in 3600 s, refreshable", for the log.
fn describe(tokens: &Tokens) -> String {
    let mut parts = Vec::new();
    if let Some(scope) = &tokens.scope {
        parts.push(format!("scope {scope}"));
    }
    if let Some(expires_at) = tokens.expires_at {
        parts.push(format!("expires in {} s", ((expires_at - js_sys::Date::now()) / 1000.0).round()));
    }
    if tokens.refresh_token.is_some() {
        parts.push("refreshable".to_string());
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(": {}", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_round_trip_through_the_worker() {
        let tokens = json!({
            "serverUrl": "https://mcp.test/mcp",
            "resource": "https://mcp.test/mcp",
            "issuer": "https://auth.test",
            "clientId": "c",
            "tokenEndpoint": "https://auth.test/token",
            "accessToken": "at",
            "expiresAt": 5.0
        });
        let parsed: Tokens = serde_json::from_value(tokens).unwrap();
        assert_eq!(parsed.token_endpoint_auth_method, "none");
        assert_eq!(parsed.refresh_token, None);
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back["accessToken"], "at");
        assert!(back.get("clientSecret").is_none());

        let options: BeginOptions = serde_json::from_value(json!({ "redirectUri": "r" })).unwrap();
        assert_eq!(options.application_type, "web");
        assert!(options.clients.is_empty());
        let callback: Callback = serde_json::from_value(json!({ "code": "c", "state": "s", "errorDescription": "d" })).unwrap();
        assert_eq!(callback.error_description.as_deref(), Some("d"));
    }

    #[test]
    fn explains_authorization_server_errors() {
        let both = server_error("https://auth.test", "registration", 400, Some(&json!({ "error": "invalid_client_metadata", "error_description": "bad" })));
        assert_eq!(both.message, "https://auth.test rejected the registration: invalid_client_metadata (bad)");
        assert_eq!(both.status, Some(400));
        assert_eq!(server_error("i", "token refresh", 503, None).message, "i rejected the token refresh: HTTP 503");
    }
}
