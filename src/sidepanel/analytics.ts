import { queueKey, track, type Context, type EventName, type EventProps, type QueuedEvent } from '../shared/analytics';
import { postJson } from './render';

export const trackPanel = (name: EventName, props?: EventProps) => track('panel', name, props);

// Send queued events (both contexts) in batches of up to 50. Sent events are
// removed only after the server accepts them, so nothing is lost offline.
let flushing = false;
export async function flushEvents(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const ctx of ['worker', 'panel'] as Context[]) {
      const key = queueKey(ctx);
      for (;;) {
        const queue = ((await chrome.storage.local.get(key))[key] as QueuedEvent[] | undefined) ?? [];
        if (!queue.length) break;
        const batch = queue.slice(0, 50);
        await postJson('events', { events: batch });
        // Re-read before trimming: new events may have been appended meanwhile.
        const now = ((await chrome.storage.local.get(key))[key] as QueuedEvent[] | undefined) ?? [];
        await chrome.storage.local.set({ [key]: now.slice(batch.length) });
      }
    }
  } catch {
    // Offline or server busy: try again on the next flush.
  } finally {
    flushing = false;
  }
}

export function startFlushing(): void {
  void flushEvents();
  setInterval(() => void flushEvents(), 15_000);
}
