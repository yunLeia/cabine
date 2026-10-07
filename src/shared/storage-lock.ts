// Web Locks are shared by every panel and the extension service worker.
// A Promise queue alone only serializes writes in its own JavaScript context.
export function withStorageLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  return navigator.locks.request(`cabine:${name}`, work);
}
