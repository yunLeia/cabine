import type { Category } from './types';

// The latest "Try in Cabine" capture, handed from the service worker to the side
// panel through chrome.storage.local rather than a message: the panel may be
// closed or still loading when the capture happens, and a message sent then is
// lost. The panel reads the key on load and watches it with onChanged.
export const CAPTURE_KEY = 'capture';

export interface Capture {
  id: string;
  srcUrl: string; // M1.2: the retailer's own URL. M1.3 stores a downloaded copy.
  pageUrl?: string;
  title: string;
  category?: Category; // unset until the user picks one (keyword guess in M1.4)
  capturedAt: number;
}
