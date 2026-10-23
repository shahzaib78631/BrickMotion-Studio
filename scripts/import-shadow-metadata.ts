/**
 * Packs the LDCad Shadow Library's connector metadata into public/data/ldcad-shadow.json.
 *
 *   git clone --depth 1 https://github.com/RolandMelkert/LDCadShadowLibrary vendor/LDCadShadowLibrary
 *   npm run setup:shadow [-- <path to the library>]
 *
 * Only `!LDCAD SNAP_*` lines are kept, keyed like LDraw references: "3022.dat",
 * "s/3001s01.dat" (from parts/) and "stud.dat", "48/…" (from p/).
 * The library is CC BY-SA 4.0 (Roland Melkert and contributors); its licence
 * and source are recorded in the pack.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SOURCE = process.argv[2] ?? join(ROOT, 'vendor', 'LDCadShadowLibrary');
const OUT = join(ROOT, 'public', 'data', 'ldcad-shadow.json');

if (!existsSync(join(SOURCE, 'parts')) && !existsSync(join(SOURCE, 'p'))) {
  console.error(`LDCad Shadow Library not found at ${SOURCE}. Clone it first:\n  git clone --depth 1 https://github.com/RolandMelkert/LDCadShadowLibrary vendor/LDCadShadowLibrary`);
  process.exit(1);
}

const files: Record<string, string> = {};
let lines = 0;
const walk = (dir: string, base: string) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { walk(full, base); continue; }
    if (!name.toLowerCase().endsWith('.dat')) continue;
    const keep = readFileSync(full, 'utf8').split(/\r?\n/).filter((l) => /^\s*0\s+!LDCAD\s+SNAP_/i.test(l));
    if (!keep.length) continue;
    const key = relative(base, full).replace(/\\/g, '/').toLowerCase();
    files[key] = keep.join('\n');
    lines += keep.length;
  }
};
// p/ first, so parts/ wins for a shared name, as in LDraw lookups
if (existsSync(join(SOURCE, 'p'))) walk(join(SOURCE, 'p'), join(SOURCE, 'p'));
if (existsSync(join(SOURCE, 'parts'))) walk(join(SOURCE, 'parts'), join(SOURCE, 'parts'));

let commit = '';
try { commit = execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
mkdirSync(join(ROOT, 'public', 'data'), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  source: 'https://github.com/RolandMelkert/LDCadShadowLibrary',
  commit,
  license: 'CC BY-SA 4.0, LDCad Shadow Library (Roland Melkert and contributors)',
  files,
}));
console.log(`✓ ${Object.keys(files).length} shadow files, ${lines} snap lines → ${relative(ROOT, OUT)} (${(statSync(OUT).size / 1024).toFixed(0)} KB)`);
