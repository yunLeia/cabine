import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addGarments, loadState } from '../src/shared/store.ts';
import { acknowledgeEvents, queueKey, track } from '../src/shared/analytics.ts';
import { recoverInterruptedCleanups } from '../src/shared/cleanup.ts';
import { chainOrder, pruneOutfit } from '../src/shared/outfit.ts';
import { obsoleteRenderIds, putImage } from '../src/shared/images.ts';
import type { Garment } from '../src/shared/types.ts';

let data: Record<string, unknown> = {};
Object.assign(globalThis, { chrome: { storage: { local: {
  async get() {
    const snapshot = structuredClone(data);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return snapshot;
  },
  async set(patch: Record<string, unknown>) { Object.assign(data, structuredClone(patch)); },
} } } });
const garment = (id: string, category: Garment['category'] = 'top'): Garment => ({
  id, category, location: 'closet', sourceType: 'closet', imageId: id, imageVersion: 1, createdAt: 1,
});

test('independent extension contexts cannot overwrite each other or duplicate retries', async () => {
  data = {};
  const other = await import('../src/shared/store.ts?context=worker');
  await Promise.all([addGarments([garment('panel')]), other.addGarments([garment('worker')])]);
  await other.addGarments([garment('panel')]);
  assert.deepEqual((await loadState()).garments.map((g) => g.id).sort(), ['panel', 'worker']);
});

test('saved outfits follow edited categories, exclusions and deduplicate ids', () => {
  const dress = garment('a', 'dress');
  const bottom = garment('b', 'bottom');
  const byId = new Map([[dress.id, dress], [bottom.id, bottom]]);
  const restored = pruneOutfit({ top: 'a', bottom: 'b', outerwear: 'missing' }, byId);
  assert.deepEqual(restored, { dress: 'a' });
  assert.deepEqual(chainOrder(restored, byId).map((g) => g.category), ['dress']);
  assert.deepEqual(pruneOutfit({ top: 'a', dress: 'a' }, byId), { dress: 'a' });
});

test('concurrent analytics arrivals survive acknowledgement and queue truncation', async () => {
  data = {};
  await Promise.all(Array.from({ length: 10 }, () => track('panel', 'look_saved')));
  const key = queueKey('panel');
  const original = structuredClone(data[key]) as Parameters<typeof acknowledgeEvents>[1];
  assert.equal(original.length, 10);
  await Promise.all([acknowledgeEvents('panel', original.slice(0, 5)), track('panel', 'category_edited')]);
  assert.equal((data[key] as unknown[]).length, 6);
  // Overflow has already removed the sent items; acknowledgement must retain new items.
  data[key] = (data[key] as unknown[]).slice(5);
  await acknowledgeEvents('panel', original);
  assert.equal((data[key] as unknown[]).length, 1);
});

test('interrupted cleanups become retryable; another panel\'s running cleanup stays pending', async () => {
  data = { garments: ['abandoned', 'running'].map((id) => ({ ...garment(id), cleanStatus: 'pending' })) };
  await navigator.locks.request('cabine:cleanup:running', async () => {
    await recoverInterruptedCleanups();
    const { garments } = await loadState();
    assert.equal(garments.find((g) => g.id === 'abandoned')?.cleanStatus, 'failed');
    assert.equal(garments.find((g) => g.id === 'running')?.cleanStatus, 'pending');
  });
});

test('render retention preserves saved/current images while bounding age and count', () => {
  const now = Date.now();
  const entries = Array.from({ length: 25 }, (_, i) => ({ id: `render-${i}`, at: now - i }));
  entries.push({ id: 'saved', at: 0 }, { id: 'current', at: 0 }, { id: 'expired', at: 0 });
  assert.deepEqual(obsoleteRenderIds(entries, new Set(['saved', 'current']), now),
    ['render-20', 'render-21', 'render-22', 'render-23', 'render-24', 'expired']);
});

test('an image write waits for commit and rejects a transaction abort after request success', async () => {
  let tx: any;
  let req: any;
  let closed = false;
  Object.assign(globalThis, { indexedDB: { open() {
    const opened: any = {};
    queueMicrotask(() => {
      opened.result = {
        close() { closed = true; },
        transaction() {
          tx = { objectStore: () => ({ put() { req = { result: 'image' }; return req; } }) };
          return tx;
        },
      };
      opened.onsuccess();
    });
    return opened;
  } } });
  let settled = false;
  const write = putImage('image', new Blob(['photo']));
  const checked = write.then(() => { settled = true; }, (err) => { settled = true; throw err; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  req.onsuccess?.();
  await Promise.resolve();
  assert.equal(settled, false);
  tx.error = new Error('quota failure');
  tx.onabort();
  await assert.rejects(checked, /quota failure/);
  assert.equal(closed, true);

  closed = false;
  const committed = putImage('image', new Blob(['photo']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  tx.oncomplete();
  assert.equal(await committed, 'image');
  assert.equal(closed, true);
});
