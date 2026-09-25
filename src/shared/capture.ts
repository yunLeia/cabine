import type { Category, PlacementAdjust } from './types';

// The latest "Try in Cabine" capture, handed from the service worker to the side
// panel through chrome.storage.local rather than a message: the panel may be
// closed or still loading when the capture happens, and a message sent then is
// lost. The panel reads the key on load and watches it with onChanged.
export const CAPTURE_KEY = 'capture';

export interface NormalizeStats {
  bgRemoved: number; // fraction of pixels removed as background (0 = none found)
  width: number; // trimmed size, px
  height: number;
}

export interface Capture {
  id: string;
  srcUrl: string; // the retailer's URL, shown until the processed copy is ready
  pageUrl?: string;
  title: string;
  category?: Category; // unset until the user picks one (keyword guess in M1.4)
  adjust?: PlacementAdjust; // manual fit, set with the panel's fit controls
  capturedAt: number;
  status: 'processing' | 'ready' | 'failed';
  imageId?: string; // IndexedDB key of the processed image, once ready
  stats?: NormalizeStats;
  error?: string;
}
