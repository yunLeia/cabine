// Print the analytics queries in db/analytics.sql as tables (dev tool).
//   npm run report   (reads DATABASE_URL from ../.env.local)
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL ?? '');
const text = await readFile(new URL('../db/analytics.sql', import.meta.url), 'utf8');
for (const block of text.split(/^-- name: /m).slice(1)) {
  const [title, ...rest] = block.split('\n');
  const query = rest.filter((l) => !l.trimStart().startsWith('--')).join('\n').trim().replace(/;$/, '');
  console.log(`\n${title}`);
  const rows = (await sql.query(query)) as Record<string, unknown>[];
  if (rows.length) console.table(rows);
  else console.log('  (no rows yet)');
}
