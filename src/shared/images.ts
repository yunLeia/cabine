// Image blobs live in IndexedDB (see docs/decisions.md D2). The service worker
// and the side panel share one extension origin, so they see the same database.

const DB_NAME = 'cabine';
const STORE = 'images';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE); // keys are garment ids
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = op(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close()) as Promise<T>;
}

export const putImage = (id: string, blob: Blob) => run('readwrite', (s) => s.put(blob, id));
export const getImage = (id: string) => run<Blob | undefined>('readonly', (s) => s.get(id));
export const deleteImage = (id: string) => run('readwrite', (s) => s.delete(id));
