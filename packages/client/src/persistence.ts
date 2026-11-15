import type { PersistedUpload, ResumeStore } from './types.js';

export function memoryStore(): ResumeStore {
  const records = new Map<string, PersistedUpload>();
  return {
    async get(id) {
      return records.get(id);
    },
    async list() {
      return [...records.values()];
    },
    async put(record) {
      records.set(record.id, record);
    },
    async delete(id) {
      records.delete(id);
    },
  };
}

/**
 * IndexedDB store. Holds tickets and file descriptors only (no bytes). Asks for persistent storage once,
 * which reduces eviction (Safari deletes script-writable storage after 7 days without a visit).
 */
export function indexedDBStore(options: { dbName?: string } = {}): ResumeStore {
  const dbName = options.dbName ?? 'upload-sdk';
  let dbPromise: Promise<IDBDatabase> | undefined;
  const db = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('uploads', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    void navigator.storage?.persist?.().catch(() => false);
    return dbPromise;
  };
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction('uploads', mode);
      const request = fn(tx.objectStore('uploads'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (id) => run('readonly', (s) => s.get(id) as IDBRequest<PersistedUpload | undefined>),
    list: () => run('readonly', (s) => s.getAll() as IDBRequest<PersistedUpload[]>),
    put: async (record) => {
      await run('readwrite', (s) => s.put(record));
    },
    delete: async (id) => {
      await run('readwrite', (s) => s.delete(id));
    },
  };
}

export function defaultStore(): ResumeStore {
  return typeof indexedDB !== 'undefined' ? indexedDBStore() : memoryStore();
}
