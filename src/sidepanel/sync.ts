import { deleteImage, getImage, putImage } from '../shared/images';
import { addGarments, loadState, removeGarment, setSavedLooks, updateGarment } from '../shared/store';
import { withStorageLock } from '../shared/storage-lock.ts';
import { planSync, type LocalRecord, type SyncRecord } from '../shared/sync-plan';
import { isSaved, type Garment, type Outfit, type SavedLook } from '../shared/types';
import { account } from './auth';
import { postJson, uploadableImage } from './render';

// My Closet and Saved Looks follow your account (D32 step 2). This computer keeps
// working from its own copy (chrome.storage + IndexedDB); signed in, it syncs
// with the account's copy on the server: on sign-in, when the panel opens or
// regains focus, and shortly after any change. The Fitting Room stays here.

const META = 'sync';
interface Meta {
  account: string; // whose snapshot this is; another account starts fresh
  known: Record<string, string>; // each record as of the last sync (sync-plan.ts)
}

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'failed';
let status: SyncStatus = 'off';
let onStatus: () => void = () => {};
export const syncStatus = () => status;
export const onSyncStatus = (fn: () => void) => void (onStatus = fn);
const setStatus = (s: SyncStatus) => {
  if (s === status) return;
  status = s;
  onStatus();
};

// The fields that travel. Clean-up progress and "last used" are this computer's business.
const GARMENT_FIELDS = ['id', 'location', 'sourceType', 'category', 'title', 'sourcePageUrl', 'imageId', 'imageVersion', 'cleanImageId', 'createdAt'] as const;

const garmentRecord = (g: Garment): LocalRecord => ({
  id: `g:${g.id}`,
  images: [g.imageId, ...(g.cleanImageId ? [g.cleanImageId] : [])],
  data: Object.fromEntries(GARMENT_FIELDS.map((k) => [k, g[k]])),
});
const lookRecord = (l: SavedLook): LocalRecord => ({
  id: `l:${l.key}`,
  images: [l.key],
  data: { key: l.key, outfit: l.outfit, createdAt: l.createdAt },
});

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;

// Ask for a sync soon. Bursts of changes collapse into one.
export function requestSync(delayMs = 1500): void {
  if (!account()) return setStatus('off');
  clearTimeout(timer);
  timer = setTimeout(() => void run(), delayMs);
}

async function run(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  setStatus('syncing');
  try {
    // One sync at a time across every open panel.
    await navigator.locks.request('cabine-sync', syncOnce);
    setStatus(account() ? 'synced' : 'off');
  } catch (err) {
    console.warn('[cabine] sync failed', err);
    setStatus('failed');
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 60_000); // try again in a minute
  } finally {
    running = false;
    if (again) {
      again = false;
      requestSync(0);
    }
  }
}

async function syncOnce(): Promise<void> {
  const me = account();
  if (!me) return;
  const stored = (await chrome.storage.local.get(META))[META] as Meta | undefined;
  const meta: Meta = stored?.account === me.id ? stored : { account: me.id, known: {} };

  const state = await loadState();
  const local = [
    ...state.garments.filter((g) => g.location === 'closet').map(garmentRecord),
    ...state.savedLooks.filter(isSaved).map(lookRecord),
  ];
  const { records: remote } = await postJson<{ records: SyncRecord[] }>('closet', {});
  const plan = planSync(local, remote, meta.known, Date.now());

  // Up: photos first, so a record never arrives on another computer before its
  // photos. The account's live copy of a record says which photos it already has.
  const inAccount = new Set(remote.flatMap((r) => (r.deleted ? [] : r.images ?? [])));
  for (const r of plan.push) {
    for (const id of r.images ?? []) {
      if (inAccount.has(id)) continue;
      const blob = await getImage(id);
      if (!blob) continue; // lost locally; the record still syncs
      await postJson('closet-image-put', { id, image: await uploadableImage(blob) });
      inAccount.add(id);
    }
  }
  for (let i = 0; i < plan.push.length; i += 100) await postJson('closet-put', { records: plan.push.slice(i, i + 100) });

  // Down: new and changed records, then deletions from other computers.
  const known = { ...plan.known };
  for (const r of plan.pull) {
    try {
      for (const id of r.images ?? []) {
        if (await getImage(id)) continue;
        const { image } = await postJson<{ image: string }>('closet-image', { id });
        await putImage(id, await (await fetch(image)).blob());
      }
      await applyRemote(r);
    } catch (err) {
      console.warn('[cabine] could not bring in', r.id, err);
      delete known[r.id]; // try again next time
    }
  }
  for (const id of plan.removeLocal) await removeLocal(id);

  await chrome.storage.local.set({ [META]: { account: me.id, known } satisfies Meta });
}

async function applyRemote(r: SyncRecord): Promise<void> {
  const data = r.data ?? {};
  if (r.id.startsWith('g:')) {
    const g = data as unknown as Garment;
    const exists = (await loadState()).garments.some((x) => x.id === g.id);
    // Every travelling field, so one cleared elsewhere (a clean photo removed) clears here too.
    const patch = Object.fromEntries(GARMENT_FIELDS.map((k) => [k, g[k]])) as Partial<Garment>;
    if (exists) await updateGarment(g.id, patch);
    else await addGarments([{ ...g, location: 'closet' }]);
  } else {
    const look = { key: String(data.key), outfit: (data.outfit ?? {}) as Outfit, createdAt: Number(data.createdAt) || Date.now(), saved: true };
    await withStorageLock('savedLooks', async () => {
      const { savedLooks } = await loadState();
      await setSavedLooks([...savedLooks.filter((l) => l.key !== look.key), look]);
    });
  }
}

async function removeLocal(id: string): Promise<void> {
  if (id.startsWith('g:')) {
    const g = (await loadState()).garments.find((x) => x.id === id.slice(2));
    if (!g) return;
    await removeGarment(g.id);
    await Promise.all([deleteImage(g.imageId), g.cleanImageId ? deleteImage(g.cleanImageId) : null]);
  } else {
    const key = id.slice(2);
    await withStorageLock('savedLooks', async () => {
      const { savedLooks } = await loadState();
      await setSavedLooks(savedLooks.filter((l) => l.key !== key));
    });
    await withStorageLock('render-cache', () => deleteImage(key));
  }
}
