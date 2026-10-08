// The off switch for rendering and photo clean-ups (everything that costs FASHN credits).
//   npm run pause    stop making new looks and clean-ups, right away
//   npm run resume   start again
// Cached looks keep working. Uses the Blob token from ../.env.local.
import { del, put } from '@vercel/blob';

const FLAG = 'config/paused.json'; // PAUSE_FLAG in api/[action].ts
const on = process.argv[2] === 'on';
if (on) {
  await put(FLAG, JSON.stringify({ at: new Date().toISOString() }), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
  console.log('Rendering paused. New looks and clean-ups are refused until `npm run resume`.');
} else {
  await del(FLAG);
  console.log('Rendering resumed.');
}
