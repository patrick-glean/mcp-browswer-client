// The error every export rejects with. It reaches the service worker as JSON,
// {kind, message, status?, code?, data?}, the shape the page explains.
//
// kind: network, timeout, auth_required, auth_failed, http, protocol, unsupported_version,
// invalid_response or internal.

export class McpError extends Error {
    constructor(kind, message, { status, code, data } = {}) {
        super(message);
        this.kind = kind;
        this.status = status;
        this.code = code;
        this.data = data;
    }

    toJSON() {
        const { kind, message, status, code, data } = this;
        return Object.fromEntries(Object.entries({ kind, message, status, code, data }).filter(([, value]) => value !== undefined));
    }
}

export const internal = message => new McpError('internal', message);
export const authFailed = (message, options) => new McpError('auth_failed', message, options);
