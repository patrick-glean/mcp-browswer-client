// chatStorage.js (module)
export function handleChatStorageEvent(event) {
    const { type } = event.data;
    if (type !== 'chat-storage') return false;
    event.waitUntil(processChatEvent(event));
    return true;
  }
  
  async function processChatEvent(event) {
    const { op, conversationId, data, options, requestId } = event.data;
    try {
      const result = await handleOp(op, conversationId, data, options);
      event.source.postMessage({
        type: 'chat-storage-response',
        requestId,
        success: true,
        result
      });
    } catch (error) {
      event.source.postMessage({
        type: 'chat-storage-response',
        requestId,
        success: false,
        error: error.message
      });
    }
  }
  
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
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'conversationId' });
        const msgStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
        msgStore.createIndex('conversationId', 'conversationId');
      };
  
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  
  async function handleOp(op, conversationId, data, options) {
    switch (op) {
      case 'init':
        await initDB();
        return { status: 'initialized' };
  
      case 'store':
        return storeConversation(conversationId, data);
  
      case 'append':
        return appendMessage(conversationId, data.message);
  
      case 'load':
        return loadConversation(conversationId, options);
  
      case 'list':
        return listConversations(options);
  
      case 'delete':
        return deleteConversation(conversationId);
  
      case 'prune':
        return pruneConversation(conversationId, options);
  
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
  }
  
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  
  async function storeConversation(conversationId, data) {
    const db = await openDB();
    const tx = db.transaction([CONVERSATIONS_STORE, MESSAGES_STORE], 'readwrite');
    const convStore = tx.objectStore(CONVERSATIONS_STORE);
    const msgStore = tx.objectStore(MESSAGES_STORE);
  
    convStore.put({ conversationId, meta: data.meta });
    for (const msg of data.messages) {
      msgStore.put({ ...msg, conversationId });
    }
    await tx.complete;
    return { status: 'stored' };
  }
  
  async function appendMessage(conversationId, message) {
    const db = await openDB();
    const tx = db.transaction(MESSAGES_STORE, 'readwrite');
    const msgStore = tx.objectStore(MESSAGES_STORE);
    msgStore.put({ ...message, conversationId });
    await tx.complete;
    return { status: 'appended' };
  }
  
  async function loadConversation(conversationId, options = {}) {
    const db = await openDB();
    const tx = db.transaction(MESSAGES_STORE, 'readonly');
    const msgStore = tx.objectStore(MESSAGES_STORE);
    const index = msgStore.index('conversationId');
    const range = IDBKeyRange.only(conversationId);
  
    const messages = [];
    index.openCursor(range).onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        messages.push(cursor.value);
        cursor.continue();
      }
    };
  
    await new Promise((resolve) => (tx.oncomplete = resolve));
    return { conversationId, messages };
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
  
  async function deleteConversation(conversationId) {
    const db = await openDB();
    const tx1 = db.transaction(CONVERSATIONS_STORE, 'readwrite');
    tx1.objectStore(CONVERSATIONS_STORE).delete(conversationId);
  
    const tx2 = db.transaction(MESSAGES_STORE, 'readwrite');
    const index = tx2.objectStore(MESSAGES_STORE).index('conversationId');
    const range = IDBKeyRange.only(conversationId);
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
  
  async function pruneConversation(conversationId, options = {}) {
    const keepLastN = options.keepLastN || 50;
    const db = await openDB();
    const tx = db.transaction(MESSAGES_STORE, 'readwrite');
    const index = tx.objectStore(MESSAGES_STORE).index('conversationId');
    const range = IDBKeyRange.only(conversationId);
  
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
  