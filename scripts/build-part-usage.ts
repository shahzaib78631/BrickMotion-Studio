#!/usr/bin/env tsx
/**
 * Mines "frequently used parts" from the model corpora on disk and writes
 * `public/data/part-usage.json`, which the Parts panel reads at runtime.
 *
 * Sources, in order of authority:
 *   - public/data/omr/**\/*.mpd     official OMR sets (in-repo, real sets)
 *   - public/data/bricknet/**\/*.ldr   BrickNet models (optional: the directory may be absent)
 *
 * A part's `sets`/`instances` are counted over the OMR corpus and its `models`/
 * `instances` over BrickNet. Submodel references inside an MPD are expanded
 * recursively, so a wheel used four times counts its parts four times.
 *
 * Run: npx tsx scripts/build-part-usage.ts
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLDraw, parseMpd } from '../src/ldraw/parse';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OMR = join(ROOT, 'public', 'data', 'omr');
const BRICKNET = join(ROOT, 'public', 'data', 'bricknet');
const CATALOG = join(ROOT, 'public', 'data', 'catalog.json');
const LDRAW_PARTS = join(ROOT, 'public', 'ldraw', 'parts');
const OUT = join(ROOT, 'public', 'data', 'part-usage.json');

/** `parts/3001.dat` and `S\3001s01.dat` both become `3001` / `3001s01`. */
const partIdOf = (file: string) => basename(file.trim().replace(/\\/g, '/')).replace(/\.dat$/i, '').toLowerCase();

/**
 * The browsable catalog. Older models reference renamed parts (`3023`, a stub whose
 * header says `~Moved to 3023b`), so every counted id is mapped onto the id the
 * Parts panel can actually show; primitives (p/) and obsolete parts resolve to null.
 */
const catalogIds = new Set<string>(
  existsSync(CATALOG) ? (JSON.parse(readFileSync(CATALOG, 'utf8')) as { id: string }[]).map((e) => e.id) : [],
);
if (!catalogIds.size) console.warn(`no catalog at ${CATALOG} — part ids are not resolved`);
const resolvedAlias = new Map<string, string | null>();

function resolveId(id: string, seen = new Set<string>()): string | null {
  const cached = resolvedAlias.get(id);
  if (cached !== undefined) return cached;
  let out: string | null = null;
  if (catalogIds.has(id)) out = id;
  else if (!seen.has(id)) {
    seen.add(id);
    const file = join(LDRAW_PARTS, `${id}.dat`);
    if (existsSync(file)) {
      const moved = /^0\s+~Moved to\s+(\S+)/im.exec(readFileSync(file, 'utf8').slice(0, 800));
      if (moved) out = resolveId(partIdOf(moved[1]), seen);
    }
  }
  resolvedAlias.set(id, out);
  return out;
}

/** Maps raw reference counts onto catalog ids, merging aliases of the same part. */
function canonicalize(counts: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [raw, n] of counts) {
    const id = resolveId(raw);
    if (id) out.set(id, (out.get(id) ?? 0) + n);
  }
  return out;
}

function walk(dir: string, ext: string, visit: (file: string) => void): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, ext, visit);
    else if (name.toLowerCase().endsWith(ext)) visit(path);
  }
}

/** Every part instance in one MPD, expanding its own submodels (cycle-safe). */
function countMpd(text: string): Map<string, number> {
  const { main, files } = parseMpd(text);
  const memo = new Map<string, Map<string, number>>();
  const open = new Set<string>();
  const countFile = (name: string): Map<string, number> => {
    const cached = memo.get(name);
    if (cached) return cached;
    const out = new Map<string, number>();
    const file = files.get(name);
    if (!file || open.has(name)) return out;
    open.add(name);
    for (const cmd of file.cmds) {
      if (cmd.t !== 'ref') continue;
      if (files.has(cmd.file)) {
        for (const [id, n] of countFile(cmd.file)) out.set(id, (out.get(id) ?? 0) + n);
      } else {
        const id = partIdOf(cmd.file);
        if (id) out.set(id, (out.get(id) ?? 0) + 1);
      }
    }
    open.delete(name);
    memo.set(name, out);
    return out;
  };
  return countFile(main);
}

/** Every part instance in one flat .ldr model. */
function countLdr(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const cmd of parseLDraw(text).cmds) {
    if (cmd.t !== 'ref') continue;
    const id = partIdOf(cmd.file);
    if (id) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

type Entry = { sets: number; instances: number; models: number; bnInstances: number };

/** Accumulates one model's part counts into the corpus totals. */
function merge(totals: Map<string, Entry>, counts: Map<string, number>, field: 'omr' | 'bricknet'): void {
  for (const [id, n] of counts) {
    let e = totals.get(id);
    if (!e) totals.set(id, (e = { sets: 0, instances: 0, models: 0, bnInstances: 0 }));
    if (field === 'omr') {
      e.sets++;
      e.instances += n;
    } else {
      e.models++;
      e.bnInstances += n;
    }
  }
}

const totals = new Map<string, Entry>();
let omrSets = 0;
let bricknetModels = 0;

if (existsSync(OMR)) {
  // One directory per official set; a part present in any of the set's files counts once.
  for (const name of readdirSync(OMR)) {
    const dir = join(OMR, name);
    if (!statSync(dir).isDirectory()) continue;
    const counts = new Map<string, number>();
    for (const file of readdirSync(dir)) {
      if (!file.toLowerCase().endsWith('.mpd')) continue;
      try {
        for (const [id, n] of countMpd(readFileSync(join(dir, file), 'utf8'))) counts.set(id, (counts.get(id) ?? 0) + n);
      } catch (e) {
        console.warn(`skip ${join(dir, file)}: ${(e as Error).message}`);
      }
    }
    if (!counts.size) continue;
    merge(totals, canonicalize(counts), 'omr');
    omrSets++;
  }
} else {
  console.warn(`no OMR corpus at ${OMR} — skipping`);
}

if (existsSync(BRICKNET)) {
  walk(BRICKNET, '.ldr', (file) => {
    try {
      merge(totals, canonicalize(countLdr(readFileSync(file, 'utf8'))), 'bricknet');
      bricknetModels++;
    } catch (e) {
      console.warn(`skip ${file}: ${(e as Error).message}`);
    }
  });
} else {
  console.warn(`no BrickNet corpus at ${BRICKNET} — skipping`);
}

// Most official sets first, then most instances, then BrickNet coverage.
const parts = [...totals.entries()]
  .filter(([id, e]) => id && (e.sets > 0 || e.models > 0))
  .sort((a, b) => b[1].sets - a[1].sets || b[1].instances - a[1].instances || b[1].models - a[1].models || a[0].localeCompare(b[0]))
  .map(([id, e]) => [id, e.sets, e.instances, e.models, e.bnInstances]);

const payload = {
  format: 'brickmotion-part-usage',
  version: 1,
  sources: { omrSets, bricknetModels },
  /** [partId, sets, instances, models, modelInstances] */
  parts,
};
writeFileSync(OUT, JSON.stringify(payload));

console.log(`wrote ${OUT}`);
console.log(`  ${omrSets} OMR sets, ${bricknetModels} BrickNet models, ${parts.length} distinct parts`);
console.log(`  top: ${parts.slice(0, 12).map((p) => `${p[0]}(${p[1]} sets)`).join(', ')}`);
