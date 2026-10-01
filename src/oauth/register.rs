//! Dynamic client registration (RFC 7591). The MCP spec now prefers client ID metadata
//! documents, but authorization servers such as Glean's only offer registration.

use super::discovery::AuthServer;
use super::{auth_failed, server_error, Client};
use crate::error::McpError;
use crate::http::{self, Request};
use crate::logging;
use serde_json::{json, Value};

const CLIENT_NAME: &str = "MCP Browser Client";
const REGISTRATION_TIMEOUT_MS: i32 = 15_000;

/// A public client (no secret) using the authorization code flow with refresh tokens.
/// `application_type` is "native" for a page served from a loopback address and "web" otherwise,
/// as the spec asks of clients registering with OpenID Connect servers.
pub fn registration_body(redirect_uri: &str, application_type: &str) -> Value {
    json!({
        "client_name": CLIENT_NAME,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": application_type,
    })
}

pub fn parse_registration(status: u16, body: Option<&Value>, issuer: &str, redirect_uri: &str) -> Result<Client, McpError> {
    if !(200..300).contains(&status) {
        return Err(server_error(issuer, "registration", status, body));
    }
    let body = body.ok_or_else(|| auth_failed(format!("{issuer} answered the registration without JSON.")))?;
    let field = |name: &str| body.get(name).and_then(Value::as_str).filter(|v| !v.is_empty()).map(String::from);
    let client_id = field("client_id").ok_or_else(|| auth_failed(format!("{issuer}'s registration reply has no client_id.")))?;
    Ok(Client {
        issuer: issuer.to_string(),
        redirect_uri: redirect_uri.to_string(),
        client_id,
        client_secret: field("client_secret"),
        token_endpoint_auth_method: field("token_endpoint_auth_method").unwrap_or_else(|| "none".to_string()),
    })
}

pub async fn register(server_url: &str, server: &AuthServer, redirect_uri: &str, application_type: &str) -> Result<Client, McpError> {
    let Some(endpoint) = &server.registration_endpoint else {
        return Err(auth_failed(format!(
            "{} doesn't offer dynamic client registration, and this client has no other way to register with it yet.",
            server.issuer
        )));
    };
    let request = Request::post_json(endpoint, registration_body(redirect_uri, application_type));
    let response = http::send(&request, server_url, REGISTRATION_TIMEOUT_MS).await?;
    let client = parse_registration(response.status, response.json.as_ref(), &server.issuer, redirect_uri)?;
    logging::info(
        server_url,
        &format!("Registered with {} as client {} ({application_type} app, redirect {redirect_uri})", server.issuer, client.client_id),
    );
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    #[test]
    fn registers_a_public_client_for_the_redirect_uri() {
        let body = registration_body("http://127.0.0.1:8888/oauth-callback.html", "native");
        assert_eq!(body["redirect_uris"], json!(["http://127.0.0.1:8888/oauth-callback.html"]));
        assert_eq!(body["application_type"], "native");
        assert_eq!(body["token_endpoint_auth_method"], "none");
        assert_eq!(body["grant_types"], json!(["authorization_code", "refresh_token"]));
        assert_eq!(registration_body("https://x.test/cb", "web")["application_type"], "web");
    }

    #[test]
    fn reads_the_registration_reply() {
        let reply = json!({ "client_id": "abc", "token_endpoint_auth_method": "none", "redirect_uris": ["r"] });
        let client = parse_registration(201, Some(&reply), "https://auth.test", "r").unwrap();
        assert_eq!((client.client_id.as_str(), client.issuer.as_str(), client.client_secret), ("abc", "https://auth.test", None));

        let rejected = json!({ "error": "invalid_redirect_uri", "error_description": "loopback not allowed" });
        let err = parse_registration(400, Some(&rejected), "https://auth.test", "r").unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
        assert_eq!(err.message, "https://auth.test rejected the registration: invalid_redirect_uri (loopback not allowed)");
        assert!(parse_registration(201, Some(&json!({})), "https://auth.test", "r").is_err());
    }
}
