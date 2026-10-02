// The Workbench's records, in IndexedDB so every tab shares them and they outlast reloads: saved
// requests and the collections they're grouped in, environments of variables, and the history of
// runs. The page and the service worker both use this module. The database keeps the name it had
// when the Workbench was called the sandbox.

const DB_NAME = 'mcp_sandbox';
const DB_VERSION = 1;
export const MAX_RUNS = 500;

let dbPromise = null;

function open() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                const requests = db.createObjectStore('requests', { keyPath: 'id' });
                requests.createIndex('tool', ['serverUrl', 'toolName']);
                requests.createIndex('collectionId', 'collectionId');
                db.createObjectStore('collections', { keyPath: 'id' });
                db.createObjectStore('environments', { keyPath: 'id' });
                const runs = db.createObjectStore('runs', { keyPath: 'id' });
                runs.createIndex('startedAt', 'startedAt');
                runs.createIndex('compareKey', ['compareKey', 'startedAt']);
                runs.createIndex('tool', ['serverUrl', 'toolName', 'startedAt']);
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

// Runs `work` in one transaction and resolves once it commits, with what `work` returned (a
// request's result when it returned a request) or what it passed to `done` from a callback.
async function transact(storeNames, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let value;
        tx.oncomplete = () => resolve(value instanceof IDBRequest ? value.result : value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('The Workbench store transaction was aborted'));
        const returned = work(tx, result => { value = result; });
        if (returned !== undefined) value = returned;
    });
}

// Visits records from a cursor until `visit` returns false.
function eachRecord(source, range, direction, visit) {
    source.openCursor(range, direction).onsuccess = event => {
        const cursor = event.target.result;
        if (cursor && visit(cursor.value, cursor) !== false) cursor.continue();
    };
}

const all = storeName => transact(storeName, 'readonly', tx => tx.objectStore(storeName).getAll());
const get = (storeName, key) => transact(storeName, 'readonly', tx => tx.objectStore(storeName).get(key));
const put = (storeName, record) => transact(storeName, 'readwrite', tx => {
    tx.objectStore(storeName).put(record);
    return record;
});
const remove = (storeName, key) => transact(storeName, 'readwrite', tx => {
    tx.objectStore(storeName).delete(key);
});

const stamped = record => {
    const now = Date.now();
    return { ...record, id: record.id || crypto.randomUUID(), createdAt: record.createdAt || now, updatedAt: now };
};

// --- Saved requests: { id, name, serverUrl, toolName, args, collectionId, createdAt, updatedAt } ---

export const listRequests = () => all('requests');
export const getRequest = id => get('requests', id);
export const deleteRequest = id => remove('requests', id);

export function saveRequest(request) {
    return put('requests', stamped({ collectionId: null, ...request }));
}

export function requestsForTool(serverUrl, toolName) {
    return transact('requests', 'readonly', tx => tx.objectStore('requests').index('tool').getAll([serverUrl, toolName]));
}

// --- Collections: { id, name, createdAt } ---

export const listCollections = () => all('collections');

export function saveCollection(collection) {
    return put('collections', stamped(collection));
}

// The collection's requests stay, without a collection.
export function deleteCollection(id) {
    return transact(['collections', 'requests'], 'readwrite', tx => {
        tx.objectStore('collections').delete(id);
        eachRecord(tx.objectStore('requests').index('collectionId'), IDBKeyRange.only(id), 'next', (request, cursor) => {
            cursor.update({ ...request, collectionId: null });
        });
    });
}

// --- Environments: { id, name, variables: { [name]: string } } ---

export const listEnvironments = () => all('environments');
export const deleteEnvironment = id => remove('environments', id);

export function saveEnvironment(environment) {
    return put('environments', stamped({ variables: {}, ...environment }));
}

// --- Runs: one per tool call, newest MAX_RUNS kept ---

export function addRun(run) {
    return transact('runs', 'readwrite', tx => {
        const store = tx.objectStore('runs');
        store.put(run);
        const count = store.count();
        count.onsuccess = () => {
            let excess = count.result - MAX_RUNS;
            if (excess <= 0) return;
            eachRecord(store.index('startedAt'), null, 'next', (record, cursor) => {
                cursor.delete();
                return --excess > 0;
            });
        };
        return run;
    });
}

export const getRun = id => get('runs', id);
export const clearRuns = () => transact('runs', 'readwrite', tx => {
    tx.objectStore('runs').clear();
});

// The newest run that counts as the same request.
export function latestRun(compareKey) {
    return transact('runs', 'readonly', (tx, done) => {
        const range = IDBKeyRange.bound([compareKey, -Infinity], [compareKey, Infinity]);
        eachRecord(tx.objectStore('runs').index('compareKey'), range, 'prev', record => {
            done(record);
            return false;
        });
    });
}

// Runs from the Workbench's own request pane and Run all; 'sandbox' is the Workbench's old name.
export const WORKBENCH_SOURCES = new Set(['workbench', 'collection', 'sandbox']);

// What was last sent to a tool from the Workbench (chat calls carry the whole conversation instead).
export function lastSent(serverUrl, toolName) {
    return transact('runs', 'readonly', (tx, done) => {
        const range = IDBKeyRange.bound([serverUrl, toolName, -Infinity], [serverUrl, toolName, Infinity]);
        eachRecord(tx.objectStore('runs').index('tool'), range, 'prev', record => {
            if (!WORKBENCH_SOURCES.has(record.source)) return true;
            done(record);
            return false;
        });
    });
}

// Newest first. `compareKey` limits them to runs of one request.
export function listRuns({ limit = 200, serverUrl = null, compareKey = null } = {}) {
    return transact('runs', 'readonly', (tx, done) => {
        const runs = [];
        done(runs);
        const index = tx.objectStore('runs').index(compareKey ? 'compareKey' : 'startedAt');
        const range = compareKey ? IDBKeyRange.bound([compareKey, -Infinity], [compareKey, Infinity]) : null;
        eachRecord(index, range, 'prev', record => {
            if (!serverUrl || record.serverUrl === serverUrl) runs.push(record);
            return runs.length < limit;
        });
    });
}

// --- Export and import: requests, collections and environments (not history) ---

export const EXPORT_FORMAT = 'mcp-workbench';
const IMPORT_FORMATS = new Set([EXPORT_FORMAT, 'mcp-sandbox']);

export async function exportAll() {
    const [requests, collections, environments] = await Promise.all([listRequests(), listCollections(), listEnvironments()]);
    return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), requests, collections, environments };
}

// Records with the same id are replaced, so importing an export restores it.
export async function importAll(data) {
    if (!IMPORT_FORMATS.has(data?.format) || data.version !== 1) {
        throw new Error(`That file isn't a Workbench export (its format should be ${EXPORT_FORMAT}, version 1).`);
    }
    const lists = {
        requests: (data.requests || []).filter(r => r?.id && r.serverUrl && r.toolName),
        collections: (data.collections || []).filter(c => c?.id && c.name),
        environments: (data.environments || []).filter(e => e?.id && e.name),
    };
    await transact(Object.keys(lists), 'readwrite', tx => {
        for (const [storeName, records] of Object.entries(lists)) {
            for (const record of records) tx.objectStore(storeName).put(record);
        }
    });
    return Object.fromEntries(Object.entries(lists).map(([name, records]) => [name, records.length]));
}
