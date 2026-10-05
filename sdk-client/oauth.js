// Sign-in for MCP servers that need it, through the SDK's auth(): protected resource and
// authorization server discovery, dynamic client registration, scope selection, PKCE, the
// resource indicator, the RFC 9207 issuer check and the code exchange. Refresh goes through
// refreshAuthorization().
//
// The service worker keeps registered clients, sign-ins in progress and tokens in IndexedDB and
// passes them in, so a provider only lives for one call.

import {
    OAuthError,
    OAuthErrorCode,
    auth,
    extractWWWAuthenticateParams,
    refreshAuthorization,
    validateAuthorizationResponseIssuer,
} from '@modelcontextprotocol/client';
import { McpError, authFailed } from './errors.js';
import * as log from './log.js';
import { NETWORK_FAILURE, signInFetch } from './trace.js';

const CLIENT_NAME = 'MCP Browser Client';

// The OAuthClientProvider auth() drives, holding what one call needs and records what it did.
class SignInProvider {
    constructor({ serverUrl, redirectUri, applicationType, clients = [], trace }) {
        Object.assign(this, { serverUrl, redirectUri, applicationType, clients, trace });
        this.client = undefined;
        this.newClient = false;
        this.discovered = undefined;
        this.verifier = undefined;
        this.stateValue = undefined;
        this.authorizationUrl = undefined;
        this.savedTokens = undefined;
    }

    get redirectUrl() {
        return this.redirectUri;
    }

    // A public client using the authorization code flow with refresh tokens. application_type is
    // "native" for a page served from a loopback address and "web" otherwise.
    get clientMetadata() {
        return {
            client_name: CLIENT_NAME,
            redirect_uris: [this.redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            application_type: this.applicationType,
        };
    }

    state() {
        return this.stateValue;
    }

    clientInformation(ctx) {
        if (!this.client) {
            this.client = this.clients.find(client => client.issuer === ctx?.issuer && client.redirectUri === this.redirectUri);
            if (this.client) log.debug(this.serverUrl, `Using client ${this.client.clientId} registered with ${this.client.issuer} earlier`);
        }
        if (!this.client) return undefined;
        return {
            client_id: this.client.clientId,
            ...(this.client.clientSecret ? { client_secret: this.client.clientSecret } : {}),
            token_endpoint_auth_method: this.client.tokenEndpointAuthMethod,
            issuer: this.client.issuer,
        };
    }

    saveClientInformation(info, ctx) {
        this.client = {
            issuer: ctx?.issuer ?? info.issuer,
            redirectUri: this.redirectUri,
            clientId: info.client_id,
            ...(info.client_secret ? { clientSecret: info.client_secret } : {}),
            tokenEndpointAuthMethod: info.token_endpoint_auth_method ?? 'none',
        };
        this.newClient = true;
        log.info(this.serverUrl, `Registered with ${this.client.issuer} as client ${info.client_id} (${this.applicationType} app, redirect ${this.redirectUri})`);
    }

    invalidateCredentials(scope) {
        if (scope === 'all' || scope === 'client') {
            this.client = undefined;
            this.clients = [];
            this.newClient = false;
        }
        if (scope === 'all' || scope === 'tokens') this.savedTokens = undefined;
    }

    tokens() {
        return this.savedTokens;
    }

    saveTokens(tokens) {
        this.savedTokens = tokens;
    }

    saveCodeVerifier(verifier) {
        this.verifier = verifier;
    }

    codeVerifier() {
        if (!this.verifier) throw new Error('This sign-in has no PKCE code verifier.');
        return this.verifier;
    }

    discoveryState() {
        return this.discovered;
    }

    saveDiscoveryState(state) {
        this.discovered = state;
        const { resourceMetadata, authServerMetadata } = this.trace.found;
        if (state.resourceMetadata) {
            const where = resourceMetadata ?? state.resourceMetadataUrl;
            log.info(this.serverUrl, `Found the protected resource metadata at ${where}; the authorization server is ${state.authorizationServerUrl}`);
        } else {
            log.info(this.serverUrl, `Found no protected resource metadata, so the authorization server is taken to be ${state.authorizationServerUrl}`);
        }
        if (authServerMetadata) log.debug(this.serverUrl, `Read the authorization server metadata from ${authServerMetadata}`);
    }

    redirectToAuthorization(url) {
        this.authorizationUrl = url;
    }
}

function randomToken(bytes) {
    const random = crypto.getRandomValues(new Uint8Array(bytes));
    return btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signInFailure(error, where, action) {
    if (error instanceof McpError) return error;
    if (error?.[NETWORK_FAILURE]) {
        return new McpError('network', `Couldn't reach ${where} for the ${action}: it may be down, or it doesn't allow this site through CORS.`);
    }
    if (error instanceof OAuthError) {
        const description = error.message && error.message !== error.code ? ` (${error.message})` : '';
        return authFailed(`${where} rejected the ${action}: ${error.code}${description}`);
    }
    return authFailed(error?.message || String(error));
}

// ": scope mcp, expires in 3600 s, refreshable", for the log.
function describeTokens(tokens) {
    const parts = [];
    if (tokens.scope) parts.push(`scope ${tokens.scope}`);
    if (tokens.expiresAt) parts.push(`expires in ${Math.round((tokens.expiresAt - Date.now()) / 1000)} s`);
    if (tokens.refreshToken) parts.push('refreshable');
    return parts.length ? `: ${parts.join(', ')}` : '';
}

const expiresAt = (tokens, now) => (typeof tokens.expires_in === 'number' ? now + tokens.expires_in * 1000 : null);

// Finds where to sign in, registers this client if needed, and returns the URL to open with the
// record its callback is checked against: {authorizationUrl, pending, client, newClient,
// authServer, scope}.
export async function begin(serverUrl, { redirectUri, applicationType = 'web', clients = [], wwwAuthenticate }) {
    const challenge = wwwAuthenticate
        ? extractWWWAuthenticateParams(new Response(null, { headers: { 'WWW-Authenticate': wwwAuthenticate } }))
        : {};
    const trace = signInFetch(serverUrl);
    const provider = new SignInProvider({ serverUrl, redirectUri, applicationType, clients, trace });
    provider.stateValue = randomToken(16);
    let result;
    try {
        result = await auth(provider, { serverUrl, resourceMetadataUrl: challenge.resourceMetadataUrl, scope: challenge.scope, fetchFn: trace.fetch });
    } catch (error) {
        throw signInFailure(error, serverUrl, 'sign-in');
    }
    const { authorizationUrl: url, client, discovered } = provider;
    if (result !== 'REDIRECT' || !url || !client) throw authFailed(`Signing in to ${serverUrl} didn't produce a page to sign in at (${result}).`);
    const metadata = discovered?.authorizationServerMetadata;
    const issuer = metadata?.issuer ?? discovered?.authorizationServerUrl;
    const scope = url.searchParams.get('scope');
    const issParameterSupported = metadata?.authorization_response_iss_parameter_supported === true;
    log.info(serverUrl, `Signing in with ${issuer}${scope ? ` for ${scope}` : ''}`);
    const pending = {
        state: provider.stateValue,
        codeVerifier: provider.verifier,
        serverUrl,
        resource: url.searchParams.get('resource'),
        scope,
        redirectUri,
        applicationType,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
        issuer,
        tokenEndpoint: metadata?.token_endpoint ?? null,
        issParameterSupported,
        createdAt: Date.now(),
        // auth() checks the callback against the authorization server this sign-in started with.
        discovery: discovered,
    };
    const authServer = {
        issuer,
        authorizationEndpoint: metadata?.authorization_endpoint ?? null,
        tokenEndpoint: metadata?.token_endpoint ?? null,
        registrationEndpoint: metadata?.registration_endpoint ?? null,
        scopesSupported: metadata?.scopes_supported ?? [],
        issParameterSupported,
        metadataUrl: trace.found.authServerMetadata ?? null,
    };
    return { authorizationUrl: url.href, pending, client, newClient: provider.newClient, authServer, scope };
}

// Checks the callback against its sign-in and trades the code for tokens. Error details are only
// shown once the issuer checks out, as RFC 9207 requires.
export async function finish(pending, callback) {
    if (callback.state !== pending.state) {
        throw authFailed("The sign-in response doesn't belong to the sign-in this client started (its state doesn't match), so it was ignored. Sign in again.");
    }
    if (callback.error) {
        try {
            validateAuthorizationResponseIssuer({ iss: callback.iss ?? undefined, expectedIssuer: pending.issuer, issParameterSupported: pending.issParameterSupported });
        } catch (error) {
            throw authFailed(`${error.message}, so the sign-in response was rejected.`);
        }
        const description = callback.errorDescription ? ` (${callback.errorDescription})` : '';
        throw authFailed(callback.error === 'access_denied' ? `Sign-in with ${pending.issuer} was declined.` : `${pending.issuer} couldn't sign you in: ${callback.error}${description}`);
    }
    if (!callback.code) throw authFailed('The sign-in response has no authorization code.');

    const trace = signInFetch(pending.serverUrl);
    const client = {
        issuer: pending.issuer,
        redirectUri: pending.redirectUri,
        clientId: pending.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod,
    };
    const provider = new SignInProvider({ serverUrl: pending.serverUrl, redirectUri: pending.redirectUri, applicationType: pending.applicationType, clients: [client], trace });
    provider.discovered = pending.discovery;
    provider.verifier = pending.codeVerifier;
    provider.stateValue = pending.state;
    try {
        await auth(provider, { serverUrl: pending.serverUrl, authorizationCode: callback.code, iss: callback.iss ?? undefined, fetchFn: trace.fetch });
    } catch (error) {
        throw signInFailure(error, pending.issuer, 'authorization code');
    }
    const issued = provider.savedTokens;
    if (!issued?.access_token) throw authFailed(`${pending.issuer}'s token reply has no access_token.`);
    const tokens = {
        serverUrl: pending.serverUrl,
        resource: pending.resource,
        issuer: pending.issuer,
        clientId: pending.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod,
        tokenEndpoint: pending.tokenEndpoint,
        // refreshAuthorization() needs the authorization server's metadata.
        authorizationServerUrl: pending.discovery?.authorizationServerUrl ?? pending.issuer,
        authorizationServerMetadata: pending.discovery?.authorizationServerMetadata ?? null,
        accessToken: issued.access_token,
        refreshToken: issued.refresh_token ?? null,
        scope: issued.scope ?? pending.scope ?? null,
        expiresAt: expiresAt(issued, Date.now()),
    };
    log.info(pending.serverUrl, `Signed in with ${tokens.issuer}${describeTokens(tokens)}`);
    return tokens;
}

// Gets a new access token with the refresh token. Fails with `auth_required` when the user has
// to sign in again.
export async function refresh(tokens) {
    if (!tokens.refreshToken) {
        throw new McpError('auth_required', `The access token from ${tokens.issuer} has expired and can't be refreshed. Sign in again.`);
    }
    const trace = signInFetch(tokens.serverUrl);
    let issued;
    try {
        issued = await refreshAuthorization(tokens.authorizationServerUrl ?? tokens.issuer, {
            metadata: tokens.authorizationServerMetadata ?? { issuer: tokens.issuer, token_endpoint: tokens.tokenEndpoint },
            clientInformation: {
                client_id: tokens.clientId,
                ...(tokens.clientSecret ? { client_secret: tokens.clientSecret } : {}),
                token_endpoint_auth_method: tokens.tokenEndpointAuthMethod,
            },
            refreshToken: tokens.refreshToken,
            resource: tokens.resource ?? undefined,
            fetchFn: trace.fetch,
        });
    } catch (error) {
        if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant) {
            throw new McpError('auth_required', `The sign-in with ${tokens.issuer} has expired. Sign in again.`, { status: 400 });
        }
        throw signInFailure(error, tokens.issuer, 'token refresh');
    }
    const refreshed = {
        ...tokens,
        accessToken: issued.access_token,
        // Servers that don't rotate refresh tokens leave them out of the reply.
        refreshToken: issued.refresh_token ?? tokens.refreshToken,
        scope: issued.scope ?? tokens.scope ?? null,
        expiresAt: expiresAt(issued, Date.now()),
    };
    log.info(tokens.serverUrl, `Refreshed the access token${describeTokens(refreshed)}`);
    return refreshed;
}
