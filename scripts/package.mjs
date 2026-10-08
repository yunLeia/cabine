// Build the Chrome Web Store upload: npm run package
// Builds dist/, checks it, and zips it to release/cabine-<version>.zip.
//   --allow-dev   package even with Clerk's development key (a draft upload, to get the store's id)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const allowDev = process.argv.includes('--allow-dev');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

run('npm', ['run', 'build']);

const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const all = files('dist');
const js = all.filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(f, 'utf8')]);
const problems = [];
const warnings = [];

// The store's remote-code rule: nothing may load scripts from elsewhere.
for (const [f, src] of js) {
  if (/https:\/\/[^"'`\s]+\.js["'`]/.test(src) && /createElement\(["']script["']\)/.test(src)) problems.push(`${f} may load a remote script`);
}
if (all.some((f) => f.endsWith('.map'))) problems.push('source maps are in dist/');
if (!js.some(([, src]) => /pk_(live|test)_/.test(src))) warnings.push('no Clerk key in the build: sign-in will be hidden');
if (js.some(([, src]) => src.includes('pk_test_'))) {
  (allowDev ? warnings : problems).push('built with Clerk\'s development key (pk_test_). Use the production key, or --allow-dev for a draft.');
}
if (!js.some(([, src]) => src.includes('cabine-server.vercel.app') || /VITE_CABINE_API/.test(src))) warnings.push('the server address looks missing');

const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));

for (const w of warnings) console.warn(`! ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}

// Zip a copy: `key` pins the extension id for the unpacked build in dist/ (keep
// it there), but the store sets its own, so the upload leaves it out.
mkdirSync('release', { recursive: true });
const stage = 'release/.stage';
rmSync(stage, { recursive: true, force: true });
cpSync('dist', stage, { recursive: true });
delete manifest.key;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const out = `release/cabine-${manifest.version}.zip`;
rmSync(out, { force: true });
run('zip', ['-qr', '../../' + out, '.', '-x', '.*'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`✓ ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB), version ${manifest.version}`);
