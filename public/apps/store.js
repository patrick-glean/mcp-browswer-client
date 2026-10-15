// The apps you build, in IndexedDB so every tab shares them and they outlast reloads. Only the
// page uses this: an app's calls go to the worker one at a time, like the Workbench's.
//
// An app: { id, name, description, version, createdAt, updatedAt, downloadedAt, screen, flow }

const DB_NAME = 'mcp_apps';
const DB_VERSION = 1;
const STORE = 'apps';

let opened = null;

function open() {
    opened ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
                db.close();
                opened = null;
            };
            resolve(db);
        };
        request.onerror = () => {
            opened = null;
            reject(request.error);
        };
    });
    return opened;
}

async function transact(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('The apps store transaction was aborted'));
    });
}

export const listApps = () => transact('readonly', store => store.getAll());
export const getApp = id => transact('readonly', store => store.get(id));
export const deleteApp = id => transact('readwrite', store => store.delete(id));

export async function saveApp(app) {
    await transact('readwrite', store => store.put(app));
    return app;
}
