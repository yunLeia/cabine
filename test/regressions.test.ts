import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addGarments, loadState } from '../src/shared/store.ts';
import { acknowledgeEvents, queueKey, track } from '../src/shared/analytics.ts';
import { recoverInterruptedCleanups } from '../src/shared/cleanup.ts';
import { chainOrder, pruneOutfit } from '../src/shared/outfit.ts';
import { obsoleteRenderIds, putImage } from '../src/shared/images.ts';
import { defaultKeep, describeChanges, favoriteIds, nothingToTry, pickCandidates, usablePlan } from '../src/shared/different.ts';
import { fingerprint, planSync } from '../src/shared/sync-plan.ts';
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

// ---- Account sync plan (D32 step 2) ----

const rec = (id: string, data: Record<string, unknown>) => ({ id, images: [`img-${id}`], data });

test('sync: first sign-in uploads the local closet; new pieces from another computer come down', () => {
  const plan = planSync([rec('g:a', { c: 'top' })], [{ id: 'g:b', updatedAt: 1, data: { c: 'shoes' } }], {}, 100);
  assert.deepEqual(plan.push.map((r) => r.id), ['g:a']);
  assert.deepEqual(plan.pull.map((r) => r.id), ['g:b']);
  assert.deepEqual(Object.keys(plan.known).sort(), ['g:a', 'g:b']);
});

test('sync: an edit here goes up; an edit elsewhere comes down; nothing changes when both match', () => {
  const known = { 'g:a': fingerprint({ c: 'top' }), 'g:b': fingerprint({ c: 'top' }), 'g:c': fingerprint({ c: 'top' }) };
  const plan = planSync(
    [rec('g:a', { c: 'bottom' }), rec('g:b', { c: 'top' }), rec('g:c', { c: 'top' })],
    [
      { id: 'g:a', updatedAt: 1, data: { c: 'top' } },
      { id: 'g:b', updatedAt: 2, data: { c: 'dress' } },
      { id: 'g:c', updatedAt: 1, data: { c: 'top' } },
    ],
    known,
    100,
  );
  assert.deepEqual(plan.push.map((r) => [r.id, r.data?.c]), [['g:a', 'bottom']]);
  assert.deepEqual(plan.pull.map((r) => [r.id, r.data?.c]), [['g:b', 'dress']]);
});

test('sync: a deletion here sends a tombstone; a deletion elsewhere removes it here', () => {
  const known = { 'g:a': fingerprint({}), 'l:b': fingerprint({}) };
  const plan = planSync([rec('l:b', {})], [{ id: 'g:a', updatedAt: 1, data: {} }, { id: 'l:b', updatedAt: 2, deleted: true }], known, 100);
  assert.deepEqual(plan.push, [{ id: 'g:a', updatedAt: 100, deleted: true }]);
  assert.deepEqual(plan.removeLocal, ['l:b']);
  assert.deepEqual(plan.known, {});
});

test('sync: fingerprints ignore key order and missing fields', () => {
  assert.equal(fingerprint({ a: 1, b: undefined, c: { y: 2, x: 1 } }), fingerprint({ c: { x: 1, y: 2 }, a: 1 }));
});

test('sync: a look saved again after being deleted comes back instead of being removed', () => {
  const plan = planSync([rec('l:x', { k: 1 })], [{ id: 'l:x', updatedAt: 5, deleted: true }], {}, 100);
  assert.deepEqual(plan.removeLocal, []);
  assert.deepEqual(plan.push.map((r) => [r.id, r.deleted]), [['l:x', undefined]]);
});

test('a saved look whose piece changed kind restores as a valid look', () => {
  const byId = new Map<string, Garment>([
    ['x', garment('x', 'dress')],
    ['y', garment('y', 'bottom')],
    ['t', garment('t', 'top')],
  ]);
  // The top became a dress: the dress wins, and the bottom it can't be worn with is left out.
  assert.deepEqual(pruneOutfit({ top: 'x', bottom: 'y' }, byId), { dress: 'x' });
  // A deleted piece is dropped; the rest stays.
  assert.deepEqual(pruneOutfit({ top: 't', bottom: 'gone' }, byId), { top: 't' });
  for (const o of [pruneOutfit({ top: 'x', bottom: 'y' }, byId), pruneOutfit({ dress: 'x', bottom: 'y', top: 't' }, byId)]) {
    assert.ok(!(o.dress && (o.top || o.bottom)), 'a dress is never worn with a top or bottom');
  }
});

// ---- Try a Different Look (D36) ----
const piece = (id: string, category: Garment['category'], location: Garment['location'] = 'closet', extra: Partial<Garment> = {}): Garment =>
  ({ ...garment(id, category), location, sourceType: location === 'closet' ? 'closet' : 'shopping', ...extra });

test('different look: the store piece is kept by default; a closet-only look keeps its main piece', () => {
  assert.deepEqual(defaultKeep([piece('coat', 'outerwear', 'fittingRoom'), piece('jeans', 'bottom')]), ['coat']);
  assert.deepEqual(defaultKeep([piece('shirt', 'top'), piece('coat', 'outerwear'), piece('jeans', 'bottom')]), ['coat']);
  assert.deepEqual(defaultKeep([]), []);
});

test('different look: candidates are closet pieces that fit around what is kept', () => {
  const coat = piece('coat', 'outerwear', 'fittingRoom');
  const trousers = piece('trousers', 'bottom'); // in the look now, to be replaced
  const jeans = piece('jeans', 'bottom', 'closet', { createdAt: 5 });
  const skirt = piece('skirt', 'bottom', 'closet', { createdAt: 9 });
  const gown = piece('gown', 'dress');
  const parka = piece('parka', 'outerwear'); // the coat's kind is kept
  const shoes = piece('shoes', 'shoes');
  const other = piece('store-top', 'top', 'fittingRoom'); // store pieces are never swapped in
  const all = [coat, trousers, jeans, skirt, gown, parka, shoes, other];
  const ids = (list: Garment[]) => list.map((g) => g.id);

  const found = pickCandidates(all, [coat, trousers], ['coat'], []);
  assert.deepEqual(ids(found), ['skirt', 'jeans', 'gown', 'shoes'], 'bottoms first (the kind being replaced), newest first; no kept kind, no worn piece, no store piece');
  assert.deepEqual(ids(pickCandidates(all, [coat, trousers], ['coat'], ['jeans'])).slice(0, 2), ['jeans', 'skirt'], 'favorites come first');

  // Keeping a top means no dress; keeping a dress means no top or bottom.
  const top = piece('top1', 'top', 'fittingRoom');
  assert.ok(!ids(pickCandidates([top, gown, jeans], [top], ['top1'], [])).includes('gown'));
  assert.deepEqual(ids(pickCandidates([gown, jeans, piece('shirt', 'top'), shoes, parka], [gown], ['gown'], [])).sort(), ['parka', 'shoes']);

  // No more than 8 of a kind, 24 in all.
  const many = Array.from({ length: 30 }, (_, i) => piece(`b${i}`, 'bottom', 'closet', { createdAt: i }));
  assert.equal(pickCandidates(many, [coat], ['coat'], []).length, 8);
});

test('different look: favorites come from saved looks; nothing-to-try says why', () => {
  const byId = new Map([piece('a', 'top'), piece('b', 'bottom'), piece('s', 'top', 'fittingRoom')].map((g) => [g.id, g]));
  const looks = [
    { key: 'k1', createdAt: 1, outfit: { top: 'a', bottom: 'b' } },
    { key: 'k2', createdAt: 2, outfit: { top: 'a', outerwear: 's' } },
    { key: 'k3', createdAt: 3, outfit: { bottom: 'b' }, saved: false },
  ];
  assert.deepEqual(favoriteIds(looks, byId), ['a', 'b'], 'closet pieces only, most-used first, unsaved looks ignored');

  const coat = piece('coat', 'outerwear', 'fittingRoom');
  assert.match(nothingToTry([coat], [], []) ?? '', /Keep at least one/);
  assert.match(nothingToTry([coat], ['coat'], []) ?? '', /Choose a piece to change/);
  assert.match(nothingToTry([coat, piece('j', 'bottom')], ['coat'], []) ?? '', /no other pieces/);
  assert.equal(nothingToTry([coat, piece('j', 'bottom')], ['coat'], [piece('k', 'bottom')]), null);
});

test('different look: a plan that no longer fits the closet is not shown', () => {
  const byId = new Map([piece('coat', 'outerwear', 'fittingRoom'), piece('jeans', 'bottom')].map((g) => [g.id, g]));
  const plan = { understood: '', direction: '', outfit: { outerwear: 'coat', bottom: 'jeans' }, kept: ['coat'], changes: [] };
  assert.equal(usablePlan(plan, byId), true);
  assert.equal(usablePlan({ ...plan, outfit: { outerwear: 'coat', bottom: 'deleted' } }, byId), false, 'a piece was deleted meanwhile');
  assert.equal(usablePlan({ ...plan, kept: ['gone'] }, byId), false);
  byId.set('jeans', piece('jeans', 'dress'));
  assert.equal(usablePlan(plan, byId), false, 'jeans changed kind meanwhile, so the plan about them is stale');
});

test('different look: what changed is written from the facts', () => {
  const names: Record<string, string> = { jacket: 'Brown leather jacket', trousers: 'Black trousers', jeans: 'Blue straight jeans', sneakers: 'White sneakers', tee: 'White tee', top: 'ZARA TOP' };
  const nameOf = (id: string) => names[id];
  const plan = (kept: string[], changes: { category: 'top' | 'bottom' | 'shoes'; from?: string; to?: string }[]) => ({ title: '', reason: '', outfit: {}, kept, changes });
  assert.equal(
    describeChanges(plan(['jacket'], [{ category: 'bottom', from: 'trousers', to: 'jeans' }, { category: 'shoes', to: 'sneakers' }]), nameOf),
    'Swapped your black trousers for blue straight jeans and added white sneakers. Your brown leather jacket stays.',
  );
  assert.equal(describeChanges(plan(['jacket', 'tee'], [{ category: 'bottom', from: 'trousers', to: 'jeans' }]), nameOf), 'Swapped your black trousers for blue straight jeans. Your brown leather jacket and white tee stay.');
  assert.equal(describeChanges(plan(['top'], [{ category: 'shoes', from: 'sneakers' }]), nameOf), 'Took off your white sneakers. Your ZARA TOP stays.', 'a name in capitals keeps its capitals');
  assert.equal(describeChanges(plan([], []), nameOf), 'A new combination from your closet.');
  assert.equal(describeChanges(plan(['gone'], [{ category: 'bottom', from: 'x', to: 'y' }]), nameOf), 'A new combination from your closet.', 'a piece we have no name for is left out, never "undefined"');
});
