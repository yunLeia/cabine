import { withStorageLock } from '../shared/storage-lock.ts';
import { acknowledgeEvents, queueKey, track, type Context, type EventName, type EventProps, type QueuedEvent } from '../shared/analytics';
import { postJson } from './render';

export const trackPanel = (name: EventName, props?: EventProps) => track('panel', name, props);

// Send queued events (both contexts) in batches of up to 50. Sent events are
// removed only after the server accepts them, so nothing is lost offline.
let flushing = false;
export async function flushEvents(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await withStorageLock('event-flush', async () => {
      for (const ctx of ['worker', 'panel'] as Context[]) {
        const key = queueKey(ctx);
        for (;;) {
          const queue = ((await chrome.storage.local.get(key))[key] as QueuedEvent[] | undefined) ?? [];
          if (!queue.length) break;
          const batch = queue.slice(0, 50);
          await postJson('events', { events: batch });
          await acknowledgeEvents(ctx, batch);
        }
      }
    });
  } catch {
    // Offline or server busy: try again on the next flush.
  } finally {
    flushing = false;
  }
}

let flushTimer: ReturnType<typeof setInterval> | undefined;
export function startFlushing(): void {
  if (flushTimer) return; // one sender per panel, however often this is called
  void flushEvents();
  flushTimer = setInterval(() => void flushEvents(), 15_000);
}
