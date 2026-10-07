// What to send and what to take when syncing with the account (D32 step 2).
// Pure, so it's tested without a server (test/regressions.test.ts).
//
// Each synced thing is a record: a closet garment ("g:<id>") or a saved look
// ("l:<key>"). `known` remembers each record as it was at the last successful
// sync, which tells a local edit apart from a remote one, and a local deletion
// apart from something new on another computer.

export interface SyncRecord {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  images?: string[];
  data?: Record<string, unknown>;
}

export interface LocalRecord {
  id: string;
  images: string[];
  data: Record<string, unknown>;
}

export interface SyncPlan {
  push: SyncRecord[]; // send to the account (changed here, new here, or deleted here)
  pull: SyncRecord[]; // take from the account (new or changed elsewhere)
  removeLocal: string[]; // deleted on another computer
  known: Record<string, string>; // the new snapshot, once everything above is done
}

// Same content, same fingerprint, whatever the key order.
export function fingerprint(data: Record<string, unknown>): string {
  const sorted = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
      : v;
  return JSON.stringify(sorted(data));
}

export function planSync(local: LocalRecord[], remote: SyncRecord[], known: Record<string, string>, now: number): SyncPlan {
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const localIds = new Set(local.map((l) => l.id));
  const plan: SyncPlan = { push: [], pull: [], removeLocal: [], known: {} };

  for (const l of local) {
    const fp = fingerprint(l.data);
    const r = remoteById.get(l.id);
    if (r?.deleted && l.id in known) {
      plan.removeLocal.push(l.id); // deleted on another computer
    } else if (!r || r.deleted) {
      // New here, or made again after a deletion (a look's key comes from its pieces).
      plan.push.push({ id: l.id, updatedAt: now, images: l.images, data: l.data });
      plan.known[l.id] = fp;
    } else if (fingerprint(r.data ?? {}) === fp) {
      plan.known[l.id] = fp; // already the same
    } else if (known[l.id] !== fp) {
      plan.push.push({ id: l.id, updatedAt: now, images: l.images, data: l.data }); // changed here since the last sync
      plan.known[l.id] = fp;
    } else {
      plan.pull.push(r); // unchanged here, changed elsewhere
      plan.known[l.id] = fingerprint(r.data ?? {});
    }
  }

  // Synced before but gone here now: deleted on this computer.
  for (const id of Object.keys(known)) {
    if (localIds.has(id)) continue;
    const r = remoteById.get(id);
    if (r && !r.deleted) plan.push.push({ id, updatedAt: now, deleted: true });
  }

  // New on another computer.
  for (const r of remote) {
    if (r.deleted || localIds.has(r.id) || r.id in known) continue;
    plan.pull.push(r);
    plan.known[r.id] = fingerprint(r.data ?? {});
  }
  return plan;
}
