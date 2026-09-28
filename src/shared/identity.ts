// An anonymous id for this Cabine install (D21): no account, no personal data.
// The server uses it to group upload sessions now, and for per-user limits and
// analytics later. It never appears in a URL or QR code.
const KEY = 'userId';

export async function getUserId(): Promise<string> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  if (typeof stored === 'string') return stored;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY]: id });
  return id;
}
