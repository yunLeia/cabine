import qrcode from 'qrcode-generator';
import { putImage } from '../shared/images';
import { addGarments, loadState } from '../shared/store';
import type { Category, Garment } from '../shared/types';
import { postJson } from './render';

// "Use your phone" (D21): the server is only an inbox between the phone and this
// closet. My Closet stays here in IndexedDB; photos are deleted from the server
// as soon as they're saved locally.

export interface PhoneSession {
  token: string;
  url: string;
  expiresAt: number;
  added: number; // pieces saved into My Closet during this session
  status: 'waiting' | 'expired' | 'error';
  error?: string;
}

export async function startPhoneSession(): Promise<PhoneSession> {
  const s = await postJson<{ token: string; url: string; expiresAt: number }>('upload-session', {});
  return { ...s, added: 0, status: 'waiting' };
}

export function qrSvg(url: string): string {
  const qr = qrcode(0, 'M'); // version picked automatically; medium error correction
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

interface InboxItem {
  id: string;
  category: Category;
  image: string; // data URI
}

// Pull everything waiting in the inbox (the server sends a few per request),
// save each photo into My Closet, then delete it from the server. Saving is
// keyed by the inbox item id, so a repeat after a failed delete adds nothing.
export async function pullPhoneUploads(token: string): Promise<{ added: number; expiresAt: number }> {
  let added = 0;
  for (;;) {
    const page = await postJson<{ items: InboxItem[]; more: boolean; expiresAt: number }>('inbox', { token });
    if (page.items.length) {
      const existing = new Set((await loadState()).garments.map((g) => g.id));
      const fresh: Garment[] = [];
      for (const item of page.items.filter((i) => !existing.has(i.id))) {
        const imageId = `phone-${item.id}`;
        await putImage(imageId, await (await fetch(item.image)).blob());
        fresh.push({
          id: item.id,
          location: 'closet',
          sourceType: 'closet',
          category: item.category,
          imageId,
          imageVersion: 1,
          createdAt: Date.now(),
        });
      }
      if (fresh.length) await addGarments(fresh);
      added += fresh.length;
      await postJson('inbox-ack', { token, ids: page.items.map((i) => i.id) });
    }
    if (!page.more) return { added, expiresAt: page.expiresAt };
  }
}
