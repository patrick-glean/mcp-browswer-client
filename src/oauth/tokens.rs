//! The authorization code flow: the URL to sign in at, checking the callback (`state`, then the
//! issuer per RFC 9207), exchanging the code, and refreshing.

use super::discovery::{AuthServer, ResourceMetadata};
use super::{auth_failed, pkce, server_error, urls, Callback, Client, Pending, Tokens};
use crate::error::{ErrorKind, McpError};
use crate::http::{encode_component, Request};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;

/// The scope to request: the challenge's, or else every scope the resource lists. When the
/// authorization server offers `offline_access` it's added, so the sign-in can be refreshed.
pub fn select_scope(challenge_scope: Option<&str>, resource_scopes: &[String], server_scopes: &[String]) -> Option<String> {
    let mut scopes: Vec<String> = match challenge_scope.map(str::trim).filter(|s| !s.is_empty()) {
        Some(challenged) => challenged.split_whitespace().map(String::from).collect(),
        None => resource_scopes.to_vec(),
    };
    // On its own, offline_access would replace the server's default scopes.
    let offline = "offline_access";
    if !scopes.is_empty() && server_scopes.iter().any(|s| s == offline) && !scopes.iter().any(|s| s == offline) {
        scopes.push(offline.to_string());
    }
    (!scopes.is_empty()).then(|| scopes.join(" "))
}

/// The URL to open for sign-in, and the record its callback is checked against.
#[allow(clippy::too_many_arguments)]
pub fn authorization_request(
    server_url: &str,
    metadata: &ResourceMetadata,
    server: &AuthServer,
    client: &Client,
    scope: Option<&str>,
    verifier_random: &[u8; 32],
    state_random: &[u8; 16],
    now: f64,
) -> (String, Pending) {
    let code_verifier = pkce::verifier(verifier_random);
    let state = pkce::state(state_random);
    let challenge = pkce::challenge(&code_verifier);
    let mut params = vec![
        ("response_type", "code"),
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", client.redirect_uri.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
        ("resource", metadata.resource.as_str()),
    ];
    if let Some(scope) = scope {
        params.push(("scope", scope));
    }
    let url = urls::with_query(&server.authorization_endpoint, &params);
    let pending = Pending {
        state,
        code_verifier,
        server_url: server_url.to_string(),
        resource: metadata.resource.clone(),
        scope: scope.map(String::from),
        redirect_uri: client.redirect_uri.clone(),
        client_id: client.client_id.clone(),
        client_secret: client.client_secret.clone(),
        token_endpoint_auth_method: client.token_endpoint_auth_method.clone(),
        issuer: server.issuer.clone(),
        token_endpoint: server.token_endpoint.clone(),
        iss_parameter_supported: server.iss_parameter_supported,
        created_at: now,
    };
    (url, pending)
}

/// Checks a callback against the sign-in it claims to finish and returns its code. Error
/// details are only shown once the issuer checks out, as RFC 9207 requires.
pub fn check_callback(pending: &Pending, callback: &Callback) -> Result<String, McpError> {
    if callback.state.as_deref() != Some(pending.state.as_str()) {
        return Err(auth_failed(
            "The sign-in response doesn't belong to the sign-in this client started (its state doesn't match), so it was ignored. Sign in again.",
        ));
    }
    check_issuer(pending, callback.iss.as_deref())?;
    if let Some(error) = callback.error.as_deref() {
        let message = match error {
            "access_denied" => format!("Sign-in with {} was declined.", pending.issuer),
            _ => format!(
                "{} couldn't sign you in: {error}{}",
                pending.issuer,
                callback.error_description.as_deref().map(|d| format!(" ({d})")).unwrap_or_default()
            ),
        };
        return Err(auth_failed(message));
    }
    callback
        .code
        .clone()
        .filter(|code| !code.is_empty())
        .ok_or_else(|| auth_failed("The sign-in response has no authorization code."))
}

/// RFC 9207: an `iss` in the response must be the issuer recorded when sign-in began, and a
/// server that promises to send one must have sent it.
pub fn check_issuer(pending: &Pending, iss: Option<&str>) -> Result<(), McpError> {
    match (pending.iss_parameter_supported, iss) {
        (_, Some(iss)) if iss == pending.issuer => Ok(()),
        (_, Some(iss)) => Err(auth_failed(format!(
            "The sign-in response came from issuer {iss:?}, not {}, so it was rejected.",
            pending.issuer
        ))),
        (true, None) => Err(auth_failed(format!(
            "{} says it names itself in sign-in responses, but this one didn't, so it was rejected.",
            pending.issuer
        ))),
        (false, None) => Ok(()),
    }
}

pub fn code_request(pending: &Pending, code: &str) -> Request {
    let form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), pending.redirect_uri.clone()),
        ("code_verifier".to_string(), pending.code_verifier.clone()),
        ("resource".to_string(), pending.resource.clone()),
    ];
    token_request(&pending.token_endpoint, form, &pending.client_id, pending.client_secret.as_deref(), &pending.token_endpoint_auth_method)
}

pub fn refresh_request(tokens: &Tokens, refresh_token: &str) -> Request {
    let form = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token.to_string()),
        ("resource".to_string(), tokens.resource.clone()),
    ];
    token_request(&tokens.token_endpoint, form, &tokens.client_id, tokens.client_secret.as_deref(), &tokens.token_endpoint_auth_method)
}

/// A token endpoint request authenticated the way the client registered: public clients
/// send just their `client_id`.
fn token_request(endpoint: &str, mut form: Vec<(String, String)>, client_id: &str, secret: Option<&str>, method: &str) -> Request {
    match (secret, method) {
        (Some(secret), "client_secret_basic") => {
            let credentials = format!("{}:{}", encode_component(client_id), encode_component(secret));
            return Request::post_form(endpoint, form).header("Authorization", format!("Basic {}", STANDARD.encode(credentials)));
        }
        (Some(secret), "client_secret_post") => {
            form.push(("client_id".to_string(), client_id.to_string()));
            form.push(("client_secret".to_string(), secret.to_string()));
        }
        _ => form.push(("client_id".to_string(), client_id.to_string())),
    }
    Request::post_form(endpoint, form)
}

/// What a token endpoint returned.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenReply {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
    pub expires_in: Option<f64>,
}

pub fn parse_token_reply(status: u16, body: Option<&Value>, issuer: &str, grant: &str) -> Result<TokenReply, McpError> {
    if !(200..300).contains(&status) {
        let error = body.and_then(|b| b.get("error")).and_then(Value::as_str);
        if grant == "refresh" && error == Some("invalid_grant") {
            return Err(McpError::new(ErrorKind::AuthRequired, format!("The sign-in with {issuer} has expired. Sign in again.")).with_status(status));
        }
        let action = if grant == "refresh" { "token refresh" } else { "authorization code" };
        return Err(server_error(issuer, action, status, body));
    }
    let body = body.ok_or_else(|| auth_failed(format!("{issuer}'s token endpoint didn't answer with JSON.")))?;
    let field = |name: &str| body.get(name).and_then(Value::as_str).filter(|v| !v.is_empty()).map(String::from);
    let access_token = field("access_token").ok_or_else(|| auth_failed(format!("{issuer}'s token reply has no access_token.")))?;
    let token_type = field("token_type").unwrap_or_else(|| "Bearer".to_string());
    if !token_type.eq_ignore_ascii_case("bearer") {
        return Err(auth_failed(format!("{issuer} issued a {token_type} token; this client only uses Bearer tokens.")));
    }
    Ok(TokenReply {
        access_token,
        refresh_token: field("refresh_token"),
        scope: field("scope"),
        expires_in: body.get("expires_in").and_then(Value::as_f64),
    })
}

impl Tokens {
    pub fn from_code(pending: &Pending, reply: TokenReply, now: f64) -> Tokens {
        Tokens {
            server_url: pending.server_url.clone(),
            resource: pending.resource.clone(),
            issuer: pending.issuer.clone(),
            client_id: pending.client_id.clone(),
            client_secret: pending.client_secret.clone(),
            token_endpoint_auth_method: pending.token_endpoint_auth_method.clone(),
            token_endpoint: pending.token_endpoint.clone(),
            access_token: reply.access_token,
            refresh_token: reply.refresh_token,
            scope: reply.scope.or_else(|| pending.scope.clone()),
            expires_at: reply.expires_in.map(|seconds| now + seconds * 1000.0),
        }
    }

    /// The tokens after a refresh. Servers that don't rotate refresh tokens leave it out of the
    /// reply, so the old one is kept.
    pub fn refreshed(&self, reply: TokenReply, now: f64) -> Tokens {
        Tokens {
            access_token: reply.access_token,
            refresh_token: reply.refresh_token.or_else(|| self.refresh_token.clone()),
            scope: reply.scope.or_else(|| self.scope.clone()),
            expires_at: reply.expires_in.map(|seconds| now + seconds * 1000.0),
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Body;
    use serde_json::json;

    fn server(iss_parameter_supported: bool) -> AuthServer {
        AuthServer {
            issuer: "https://auth.test/oauth".into(),
            authorization_endpoint: "https://auth.test/oauth/authorize".into(),
            token_endpoint: "https://auth.test/oauth/token".into(),
            registration_endpoint: None,
            scopes_supported: vec!["mcp".into(), "offline_access".into()],
            iss_parameter_supported,
            metadata_url: "m".into(),
        }
    }

    fn client(secret: Option<&str>, method: &str) -> Client {
        Client {
            issuer: "https://auth.test/oauth".into(),
            redirect_uri: "http://127.0.0.1:8888/oauth-callback.html".into(),
            client_id: "client-1".into(),
            client_secret: secret.map(String::from),
            token_endpoint_auth_method: method.into(),
        }
    }

    fn metadata() -> ResourceMetadata {
        ResourceMetadata {
            resource: "https://mcp.test/mcp".into(),
            metadata_url: "m".into(),
            authorization_servers: vec!["https://auth.test/oauth".into()],
            scopes_supported: vec!["mcp".into()],
        }
    }

    fn pending(iss_parameter_supported: bool) -> Pending {
        let (_, pending) = authorization_request("https://mcp.test/mcp", &metadata(), &server(iss_parameter_supported), &client(None, "none"), Some("mcp"), &[7; 32], &[9; 16], 1000.0);
        pending
    }

    fn query(url: &str) -> Vec<(String, String)> {
        url.split_once('?').unwrap().1.split('&').map(|pair| {
            let (name, value) = pair.split_once('=').unwrap();
            (name.to_string(), value.replace("%3A", ":").replace("%2F", "/").replace("%20", " "))
        }).collect()
    }

    fn form(request: &Request) -> Vec<(String, String)> {
        match &request.body {
            Some(Body::Form(fields)) => fields.clone(),
            _ => panic!("not a form request"),
        }
    }

    #[test]
    fn asks_for_the_challenged_or_listed_scopes_plus_offline_access() {
        let offered = vec!["mcp".to_string(), "offline_access".to_string()];
        assert_eq!(select_scope(Some("files:read"), &["mcp".into()], &offered).as_deref(), Some("files:read offline_access"));
        assert_eq!(select_scope(None, &["mcp".into()], &offered).as_deref(), Some("mcp offline_access"));
        assert_eq!(select_scope(None, &["mcp".into()], &["mcp".into()]).as_deref(), Some("mcp"));
        assert_eq!(select_scope(Some("  "), &[], &offered), None);
        assert_eq!(select_scope(Some("mcp offline_access"), &[], &offered).as_deref(), Some("mcp offline_access"));
    }

    #[test]
    fn builds_the_authorization_url_with_pkce_state_and_resource() {
        let (url, pending) = authorization_request("https://mcp.test/mcp", &metadata(), &server(false), &client(None, "none"), Some("mcp offline_access"), &[7; 32], &[9; 16], 1000.0);
        assert!(url.starts_with("https://auth.test/oauth/authorize?"));
        let params = query(&url);
        let get = |name: &str| params.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!(get("client_id"), Some("client-1"));
        assert_eq!(get("redirect_uri"), Some("http://127.0.0.1:8888/oauth-callback.html"));
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(get("code_challenge"), Some(pkce::challenge(&pending.code_verifier).as_str()));
        assert_eq!(get("state"), Some(pending.state.as_str()));
        assert_eq!(get("resource"), Some("https://mcp.test/mcp"));
        assert_eq!(get("scope"), Some("mcp offline_access"));
        assert_eq!(pending.issuer, "https://auth.test/oauth");
        assert_eq!(pending.token_endpoint, "https://auth.test/oauth/token");
        assert_eq!(pending.created_at, 1000.0);
    }

    #[test]
    fn checks_the_issuer_as_rfc_9207_describes() {
        let issuer = "https://auth.test/oauth";
        assert!(check_issuer(&pending(true), Some(issuer)).is_ok());
        assert!(check_issuer(&pending(true), None).is_err());
        assert!(check_issuer(&pending(false), Some(issuer)).is_ok());
        assert!(check_issuer(&pending(false), Some("https://evil.test")).is_err());
        assert!(check_issuer(&pending(false), None).is_ok());
        // No normalization: a trailing slash is a different issuer.
        assert!(check_issuer(&pending(false), Some("https://auth.test/oauth/")).is_err());
    }

    #[test]
    fn checks_the_state_before_anything_else() {
        let pending = pending(false);
        let state = Some(pending.state.clone());
        let ok = Callback { code: Some("code-1".into()), state: state.clone(), ..Callback::default() };
        assert_eq!(check_callback(&pending, &ok).unwrap(), "code-1");
        let forged = Callback { code: Some("code-1".into()), state: Some("other".into()), ..Callback::default() };
        assert!(check_callback(&pending, &forged).unwrap_err().message.contains("state"));
        let denied = Callback { state: state.clone(), error: Some("access_denied".into()), ..Callback::default() };
        assert_eq!(check_callback(&pending, &denied).unwrap_err().message, "Sign-in with https://auth.test/oauth was declined.");
        let wrong_issuer = Callback { state: state.clone(), iss: Some("https://evil.test".into()), error: Some("server_error".into()), error_description: Some("look here".into()), ..Callback::default() };
        assert!(!check_callback(&pending, &wrong_issuer).unwrap_err().message.contains("look here"));
        assert!(check_callback(&pending, &Callback { state, ..Callback::default() }).is_err());
    }

    #[test]
    fn exchanges_the_code_as_a_public_client() {
        let pending = pending(false);
        let request = code_request(&pending, "code-1");
        assert_eq!(request.url, "https://auth.test/oauth/token");
        let fields = form(&request);
        let get = |name: &str| fields.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
        assert_eq!(get("grant_type"), Some("authorization_code"));
        assert_eq!(get("code"), Some("code-1"));
        assert_eq!(get("code_verifier"), Some(pending.code_verifier.as_str()));
        assert_eq!(get("resource"), Some("https://mcp.test/mcp"));
        assert_eq!(get("client_id"), Some("client-1"));
        assert_eq!(get("client_secret"), None);
        assert!(request.headers.is_empty());
    }

    #[test]
    fn authenticates_confidential_clients_the_registered_way() {
        let (_, mut pending) = authorization_request("https://mcp.test/mcp", &metadata(), &server(false), &client(Some("s3cret"), "client_secret_basic"), None, &[1; 32], &[2; 16], 0.0);
        let basic = code_request(&pending, "c");
        assert_eq!(basic.headers, vec![("Authorization".to_string(), format!("Basic {}", STANDARD.encode("client-1:s3cret")))]);
        assert!(!form(&basic).iter().any(|(name, _)| name == "client_id"));
        pending.token_endpoint_auth_method = "client_secret_post".into();
        let post = form(&code_request(&pending, "c"));
        assert!(post.contains(&("client_secret".to_string(), "s3cret".to_string())));
    }

    #[test]
    fn reads_token_replies_and_keeps_unrotated_refresh_tokens() {
        let reply = parse_token_reply(200, Some(&json!({ "access_token": "at", "token_type": "bearer", "expires_in": 3600, "refresh_token": "rt" })), "i", "code").unwrap();
        let tokens = Tokens::from_code(&pending(false), reply, 1_000.0);
        assert_eq!(tokens.expires_at, Some(3_601_000.0));
        assert_eq!(tokens.scope.as_deref(), Some("mcp"));
        assert_eq!(tokens.refresh_token.as_deref(), Some("rt"));

        let again = parse_token_reply(200, Some(&json!({ "access_token": "at2", "expires_in": 60 })), "i", "refresh").unwrap();
        let refreshed = tokens.refreshed(again, 10_000.0);
        assert_eq!((refreshed.access_token.as_str(), refreshed.refresh_token.as_deref()), ("at2", Some("rt")));
        assert_eq!(refreshed.expires_at, Some(70_000.0));
        let fields = form(&refresh_request(&refreshed, "rt"));
        assert!(fields.contains(&("grant_type".to_string(), "refresh_token".to_string())));
        assert!(fields.contains(&("resource".to_string(), "https://mcp.test/mcp".to_string())));

        assert!(parse_token_reply(200, Some(&json!({ "access_token": "at", "token_type": "DPoP" })), "i", "code").is_err());
        let expired = parse_token_reply(400, Some(&json!({ "error": "invalid_grant" })), "i", "refresh").unwrap_err();
        assert_eq!(expired.kind, ErrorKind::AuthRequired);
        let bad_code = parse_token_reply(400, Some(&json!({ "error": "invalid_grant", "error_description": "used" })), "i", "code").unwrap_err();
        assert_eq!((bad_code.kind, bad_code.message.as_str()), (ErrorKind::AuthFailed, "i rejected the authorization code: invalid_grant (used)"));
    }
}
