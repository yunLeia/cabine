// Image bytes and render timestamps share one committed IndexedDB transaction.
const DB_NAME = 'cabine';
const STORE = 'images';
const RENDER_TIMES = 'renderTimes';
const MAX_UNSAVED_RENDERS = 20;
const RENDER_RETENTION_MS = 30 * 24 * 60 * 60_000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(RENDER_TIMES)) req.result.createObjectStore(RENDER_TIMES);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore, times: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([STORE, RENDER_TIMES], mode);
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error ?? new Error('Image transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('Image transaction failed'));
    const req = op(tx.objectStore(STORE), tx.objectStore(RENDER_TIMES));
  }).finally(() => db.close());
}

export const putImage = (id: string, blob: Blob) => run('readwrite', (s, times) => {
  if (id.startsWith('render-')) times.put(Date.now(), id);
  return s.put(blob, id);
});
export const getImage = (id: string) => run<Blob | undefined>('readonly', (s) => s.get(id));
export const deleteImage = (id: string) => run('readwrite', (s, times) => {
  times.delete(id);
  return s.delete(id);
});

export function obsoleteRenderIds(
  entries: { id: string; at: number }[], protectedIds: Set<string>, now = Date.now(),
): string[] {
  const unsaved = entries.filter((e) => !protectedIds.has(e.id)).sort((a, b) => b.at - a.at);
  return unsaved.filter((e, i) => i >= MAX_UNSAVED_RENDERS || e.at < now - RENDER_RETENTION_MS).map((e) => e.id);
}

// Keep saved/current looks indefinitely; bound every other render by age and count.
// Images from the old schema have no timestamp and can be discarded if unsaved.
export async function pruneRenderCache(protectedIds: Set<string>): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, RENDER_TIMES], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Cache cleanup aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('Cache cleanup failed'));
      const images = tx.objectStore(STORE);
      const times = tx.objectStore(RENDER_TIMES);
      const keys = images.getAllKeys();
      const timeKeys = times.getAllKeys();
      const values = times.getAll();
      values.onsuccess = () => {
        const timestamps = new Map(timeKeys.result.map((key, i) => [String(key), Number(values.result[i])]));
        const entries = keys.result.map(String).filter((id) => id.startsWith('render-'))
          .map((id) => ({ id, at: timestamps.get(id) ?? 0 }));
        for (const id of obsoleteRenderIds(entries, protectedIds)) {
          images.delete(id);
          times.delete(id);
        }
      };
    });
  } finally {
    db.close();
  }
}
