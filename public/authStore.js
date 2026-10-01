// OAuth state for the service worker. It lives in IndexedDB so it outlasts worker restarts and is
// shared by every tab: clients registered with each authorization server, tokens for each MCP
// server, and sign-ins waiting for their callback.

const DB_NAME = 'mcp_auth';
const DB_VERSION = 1;
// A sign-in whose callback hasn't arrived by then is abandoned.
const PENDING_TTL_MS = 10 * 60 * 1000;

let dbPromise = null;

function open() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                db.createObjectStore('clients', { keyPath: 'key' });
                db.createObjectStore('tokens', { keyPath: 'serverUrl' });
                db.createObjectStore('pending', { keyPath: 'state' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                dbPromise = null;
                reject(request.error);
            };
        });
    }
    return dbPromise;
}

// Runs one operation in its own transaction and resolves with its request's result once the
// transaction has committed.
async function run(storeName, mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = operation(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

const clientKey = (issuer, redirectUri) => `${issuer} ${redirectUri}`;

export async function listClients() {
    return (await run('clients', 'readonly', store => store.getAll())) || [];
}

export function putClient(client) {
    return run('clients', 'readwrite', store => store.put({ ...client, key: clientKey(client.issuer, client.redirectUri) }));
}

export function deleteClient(issuer, redirectUri) {
    return run('clients', 'readwrite', store => store.delete(clientKey(issuer, redirectUri)));
}

export function getTokens(serverUrl) {
    return run('tokens', 'readonly', store => store.get(serverUrl));
}

export function putTokens(tokens) {
    return run('tokens', 'readwrite', store => store.put(tokens));
}

export function deleteTokens(serverUrl) {
    return run('tokens', 'readwrite', store => store.delete(serverUrl));
}

export async function putPending(pending) {
    const expired = (await run('pending', 'readonly', store => store.getAll()) || [])
        .filter(entry => Date.now() - entry.createdAt > PENDING_TTL_MS);
    for (const entry of expired) {
        await run('pending', 'readwrite', store => store.delete(entry.state));
    }
    return run('pending', 'readwrite', store => store.put(pending));
}

// The sign-in a callback's state belongs to. It's removed in the same transaction, so a callback
// can only be used once.
export async function takePending(state) {
    if (!state) return undefined;
    const pending = await run('pending', 'readwrite', store => {
        const request = store.get(state);
        request.onsuccess = () => store.delete(state);
        return request;
    });
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) return undefined;
    return pending;
}
