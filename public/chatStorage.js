// chatStorage.js (module)
const DB_NAME = 'chat_contexts';
const DB_VERSION = 1;
const CONVERSATIONS_STORE = 'conversations';
const MESSAGES_STORE = 'messages';

export function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      console.log('[initDB] Creating or upgrading DB schema...');
      db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'engramId' });
      const msgStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
      msgStore.createIndex('engramId', 'engramId');
    };

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function handleOp(op, engramId, data, options) {
  switch (op) {
    case 'init':
      await initDB();
      return { status: 'initialized' };
    case 'store':
      return storeConversation(engramId, data);
    case 'append':
      return appendMessage(engramId, data.message);
    case 'load':
      return loadConversation(engramId, options);
    case 'list':
      return listConversations(options);
    case 'delete':
      return deleteConversation(engramId);
    case 'prune':
      return pruneConversation(engramId, options);
    default:
      throw new Error(`Unknown operation: ${op}`);
  }
}

async function storeConversation(engramId, data) {
  const db = await openDB();
  const tx = db.transaction([CONVERSATIONS_STORE, MESSAGES_STORE], 'readwrite');
  const convStore = tx.objectStore(CONVERSATIONS_STORE);
  const msgStore = tx.objectStore(MESSAGES_STORE);

  convStore.put({ engramId, meta: data.meta });
  for (const msg of data.messages) {
    msgStore.put({ ...msg, engramId });
  }
  await tx.complete;
  return { status: 'stored' };
}

async function appendMessage(engramId, message) {
  const db = await openDB();
  const tx = db.transaction(MESSAGES_STORE, 'readwrite');
  const msgStore = tx.objectStore(MESSAGES_STORE);
  msgStore.put({ ...message, engramId });
  await tx.complete;
  return { status: 'appended' };
}

async function loadConversation(engramId, options = {}) {
  if (engramId === null || engramId === undefined) {
    return { engramId, messages: [] };
  }
  const db = await openDB();
  const tx = db.transaction(MESSAGES_STORE, 'readonly');
  const msgStore = tx.objectStore(MESSAGES_STORE);
  const index = msgStore.index('engramId');
  const range = IDBKeyRange.only(engramId);

  const messages = [];
  index.openCursor(range).onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      messages.push(cursor.value);
      cursor.continue();
    }
  };

  await new Promise((resolve) => (tx.oncomplete = resolve));
  return { engramId, messages };
}

async function listConversations(options = {}) {
  const db = await openDB();
  const tx = db.transaction(CONVERSATIONS_STORE, 'readonly');
  const convStore = tx.objectStore(CONVERSATIONS_STORE);
  const conversations = [];

  convStore.openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      conversations.push(cursor.value.meta);
      cursor.continue();
    }
  };

  await new Promise((resolve) => (tx.oncomplete = resolve));
  return conversations;
}

async function deleteConversation(engramId) {
  const db = await openDB();
  const tx1 = db.transaction(CONVERSATIONS_STORE, 'readwrite');
  tx1.objectStore(CONVERSATIONS_STORE).delete(engramId);

  const tx2 = db.transaction(MESSAGES_STORE, 'readwrite');
  const index = tx2.objectStore(MESSAGES_STORE).index('engramId');
  const range = IDBKeyRange.only(engramId);
  index.openCursor(range).onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  await Promise.all([
    new Promise((resolve) => (tx1.oncomplete = resolve)),
    new Promise((resolve) => (tx2.oncomplete = resolve))
  ]);

  return { status: 'deleted' };
}

async function pruneConversation(engramId, options = {}) {
  const keepLastN = options.keepLastN || 50;
  const db = await openDB();
  const tx = db.transaction(MESSAGES_STORE, 'readwrite');
  const index = tx.objectStore(MESSAGES_STORE).index('engramId');
  const range = IDBKeyRange.only(engramId);

  const messages = [];
  index.openCursor(range).onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      messages.push(cursor);
      cursor.continue();
    }
  };

  await new Promise((resolve) => (tx.oncomplete = resolve));

  const toDelete = messages.length - keepLastN;
  if (toDelete > 0) {
    const tx2 = db.transaction(MESSAGES_STORE, 'readwrite');
    for (let i = 0; i < toDelete; i++) {
      tx2.objectStore(MESSAGES_STORE).delete(messages[i].primaryKey);
    }
    await new Promise((resolve) => (tx2.oncomplete = resolve));
  }

  return { status: 'pruned', removed: toDelete > 0 ? toDelete : 0 };
}
  