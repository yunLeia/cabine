import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Two entry points, one per extension runtime:
// - the side panel is an HTML page (Vite follows its <script> tag)
// - the service worker is a bare script, and manifest.json points at it by a
//   fixed filename, so it must not get a content hash.
export default defineConfig({
  root: r('./src'),
  publicDir: r('./public'), // copied as-is: manifest.json, seed images
  // .env.local lives at the project root. Only VITE_* variables reach the bundle,
  // so server secrets in the same file (FASHN key, Blob token) never do.
  envDir: r('.'),
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: r('./src/sidepanel/index.html'),
        'service-worker': r('./src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
