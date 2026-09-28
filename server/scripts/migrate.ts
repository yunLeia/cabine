// Apply db/schema.sql to the Neon database (dev tool). Idempotent.
//   node --env-file=../.env.local scripts/migrate.ts
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (run with --env-file=../.env.local)');
const sql = neon(url);
const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
for (const statement of schema.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean)) {
  await sql.query(statement);
}
const [{ count }] = (await sql.query('select count(*)::int as count from events')) as { count: number }[];
console.log(`schema applied; events table has ${count} rows`);
