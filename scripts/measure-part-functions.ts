/**
 * Measures what every LDraw part does mechanically (gear teeth, worms, racks)
 * from its geometry and writes public/data/part-functions.json, which the app
 * loads at start-up instead of measuring each part as it loads.
 *
 *   npm run data:part-functions            # whole library (about 10 minutes)
 *   npm run data:part-functions -- 3743 4143   # just these parts, printed
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PartLibrary } from '../src/ldraw/library';
import { measurePartFunctions, packPartFunctions, type PartFunctions } from '../src/anim/motion/parts/partFunctions';

const ROOT = process.cwd();
const LDRAW = join(ROOT, 'public', 'ldraw');
const OUT = join(ROOT, 'public', 'data', 'part-functions.json');
const fetchText = async (path: string) => {
  const f = join(LDRAW, path);
  return statSync(f, { throwIfNoEntry: false })?.isFile() ? readFileSync(f, 'utf8') : null;
};
/** The library caches every file and part it loads; a fresh one every few hundred parts keeps memory flat. */
let lib = new PartLibrary(fetchText);

async function main() {
  const only = process.argv.slice(2);
  const ids = only.length ? only : readdirSync(join(LDRAW, 'parts')).filter(f => f.toLowerCase().endsWith('.dat')).map(f => f.slice(0, -4)).sort();
  const measured: Record<string, PartFunctions> = {};
  const slow: string[] = [];
  const start = Date.now();
  for (const [i, id] of ids.entries()) {
    const t = Date.now();
    if (i % 400 === 0) lib = new PartLibrary(fetchText);
    try {
      measured[id] = measurePartFunctions(await lib.loadPart(`${id}.dat`));
    } catch (e) {
      console.warn(`${id}: ${(e as Error).message}`);
    }
    if (Date.now() - t > 2000) slow.push(`${id} ${Date.now() - t} ms`);
    if (i % 250 === 0 || i === ids.length - 1) console.log(`::progress ${i + 1}/${ids.length}`);
  }
  const table = packPartFunctions(measured, { library: `LDraw parts in public/ldraw (${new Date().toISOString().slice(0, 10)})`, scanned: ids.length });
  if (only.length) {
    console.log(JSON.stringify(table.parts, null, 1));
    return;
  }
  writeFileSync(OUT, JSON.stringify(table));
  const kinds = new Map<string, number>();
  for (const f of Object.values(table.parts)) for (const t of f.teeth) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
  console.log(`${Object.keys(table.parts).length} of ${ids.length} parts have functions (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}) in ${((Date.now() - start) / 1000).toFixed(0)} s -> ${OUT}`);
  if (slow.length) console.log(`slow: ${slow.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
