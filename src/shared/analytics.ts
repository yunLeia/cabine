// Product analytics (D23): funnel events queued locally, sent in batches by the
// panel to POST /api/events. Only event names and small facts go in: category,
// store domain, counts, timings, random garment ids. Never photos, product
// titles or page URLs. The server hashes the install id.
//
// Each extension context has its own queue key, so the service worker and the
// panel never overwrite each other's events.

export type EventName =
  | 'extension_opened'
  | 'store_item_captured'
  | 'store_item_category_selected'
  | 'closet_upload_session_created'
  | 'closet_item_uploaded'
  | 'fitting_room_item_selected'
  | 'closet_item_selected'
  | 'outfit_render_requested'
  | 'outfit_render_completed'
  | 'outfit_render_failed'
  | 'decision_buy'
  | 'decision_save'
  | 'decision_pass'
  | 'item_moved_to_closet'
  | 'photo_cleanup_requested'
  | 'photo_cleanup_completed'
  | 'photo_cleanup_failed';

export type EventProps = Record<string, string | number | boolean | string[]>;
export interface QueuedEvent {
  name: EventName;
  at: number;
  props: EventProps;
}

export type Context = 'panel' | 'worker';
export const queueKey = (ctx: Context) => `eventQueue:${ctx}`;
const MAX_QUEUE = 500; // offline for a long time: keep the newest

export async function track(ctx: Context, name: EventName, props: EventProps = {}): Promise<void> {
  try {
    const key = queueKey(ctx);
    const queue = ((await chrome.storage.local.get(key))[key] as QueuedEvent[] | undefined) ?? [];
    queue.push({ name, at: Date.now(), props });
    await chrome.storage.local.set({ [key]: queue.slice(-MAX_QUEUE) });
  } catch (err) {
    console.warn('[cabine] could not queue event', name, err); // analytics must never break the product
  }
}

// The store's domain only (e.g. "www.cos.com"), never the product URL.
export const domainOf = (url?: string) => {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};
