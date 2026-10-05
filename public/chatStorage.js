// The Chat app's conversations, in IndexedDB: a record per conversation and one per message, both
// keyed by conversationId. Version 1 of the database called it engramId; opening it moves those
// records over.
import { logger } from './logger.js';

const DB_NAME = 'chat_contexts';
const DB_VERSION = 2;
const CONVERSATIONS_STORE = 'conversations';
const MESSAGES_STORE = 'messages';

let opened = null;

// The only way in, so an older database is always upgraded before anything reads it.
export function openDB() {
    opened ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = event => upgrade(request.result, request.transaction, event.oldVersion);
        request.onblocked = () => logger.warn('Waiting for an older copy of the app to close the conversation store');
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

function upgrade(db, transaction, oldVersion) {
    if (oldVersion < 1) createStores(db);
    else if (oldVersion < 2) migrateFromVersion1(db, transaction);
}

function createStores(db) {
    db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'conversationId' });
    db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' }).createIndex('conversationId', 'conversationId');
}

const renamed = ({ engramId, ...record }) => ({ ...record, conversationId: engramId });

// Reads every version 1 record, recreates the stores keyed by conversationId and writes the
// records back, all in the upgrade transaction: if any step fails, the database stays as it was.
function migrateFromVersion1(db, transaction) {
    const conversations = transaction.objectStore(CONVERSATIONS_STORE).getAll();
    const messages = transaction.objectStore(MESSAGES_STORE).getAll();
    // Requests in a transaction finish in order, so both results are in.
    messages.onsuccess = () => {
        db.deleteObjectStore(CONVERSATIONS_STORE);
        db.deleteObjectStore(MESSAGES_STORE);
        createStores(db);
        const conversationStore = transaction.objectStore(CONVERSATIONS_STORE);
        const messageStore = transaction.objectStore(MESSAGES_STORE);
        for (const conversation of conversations.result) {
            conversationStore.put({ ...renamed(conversation), meta: conversation.meta && renamed(conversation.meta) });
        }
        for (const message of messages.result) messageStore.put(renamed(message));
        logger.info(`Moved ${conversations.result.length} conversation${conversations.result.length === 1 ? '' : 's'} with ${messages.result.length} message${messages.result.length === 1 ? '' : 's'} to the renamed conversation store`);
    };
}

const finished = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
});

// Time-ordered IDs, so a conversation's messages come back in the order they were saved.
function uuidv7() {
    const timestamp = Date.now().toString(16).padStart(12, '0');
    const random = crypto.getRandomValues(new Uint8Array(10));
    const randomHex = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
    return [
        timestamp.slice(0, 8),
        timestamp.slice(8, 12),
        '7' + randomHex.slice(0, 3),
        (8 + (random[3] & 0x3)).toString(16) + randomHex.slice(3, 6),
        randomHex.slice(6, 18)
    ].join('-');
}

// Saves a message {text, role, timestamp, conversationId}, starting the conversation if it's new.
export async function saveMessage(message) {
    const db = await openDB();
    const transaction = db.transaction([CONVERSATIONS_STORE, MESSAGES_STORE], 'readwrite');
    const conversations = transaction.objectStore(CONVERSATIONS_STORE);
    const existing = conversations.getKey(message.conversationId);
    existing.onsuccess = () => {
        if (existing.result === undefined) {
            conversations.put({ conversationId: message.conversationId, meta: { created: Date.now(), conversationId: message.conversationId } });
        }
    };
    transaction.objectStore(MESSAGES_STORE).put({ ...message, id: uuidv7(), timestamp: message.timestamp || Date.now() });
    await finished(transaction);
}

export async function loadConversation(conversationId) {
    if (conversationId === null || conversationId === undefined) return { conversationId, messages: [] };
    const db = await openDB();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const request = transaction.objectStore(MESSAGES_STORE).index('conversationId').getAll(IDBKeyRange.only(conversationId));
    await finished(transaction);
    return { conversationId, messages: request.result };
}

export async function listConversations() {
    const db = await openDB();
    const transaction = db.transaction(CONVERSATIONS_STORE, 'readonly');
    const request = transaction.objectStore(CONVERSATIONS_STORE).getAll();
    await finished(transaction);
    return request.result.map(conversation => conversation.meta);
}

export async function deleteConversation(conversationId) {
    const db = await openDB();
    const transaction = db.transaction([CONVERSATIONS_STORE, MESSAGES_STORE], 'readwrite');
    transaction.objectStore(CONVERSATIONS_STORE).delete(conversationId);
    const messages = transaction.objectStore(MESSAGES_STORE);
    const keys = messages.index('conversationId').getAllKeys(IDBKeyRange.only(conversationId));
    keys.onsuccess = () => keys.result.forEach(key => messages.delete(key));
    await finished(transaction);
}
