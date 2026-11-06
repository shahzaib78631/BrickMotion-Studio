#!/usr/bin/env tsx
/**
 * BrickNet connector catalogue (Kulits & Schmid, CVPR 2026, MIT) vs the editor's own
 * connector sources (LDCad shadow snaps + local patches + connectorLibrary + wheel seats).
 *
 *   npx tsx scripts/bricknet-connectors.ts audit    [--corpus <dir of .mpd>]
 *   npx tsx scripts/bricknet-connectors.ts generate
 *
 * audit:    per part (palette = public/data/catalog.json, plus the BrickHeadz corpus),
 *           counts BrickNet connectors and editor snaps by family and reports the parts
 *           where BrickNet has a family the editor has none (or fewer) of.
 * generate: writes src/data/bricknetConnectors.generated.ts with the BrickNet rows of the
 *           families smart joints turn into rotation constraints (hinge, ball), for parts
 *           whose LDCad snaps have nothing of that family.
 *
 * Reads only python/knowledge/bricknet (labels.json.xz, part_aliases.json.xz; needs the
 * `xz` command), public/ldraw and public/data/ldcad-shadow.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PartLibrary } from '../src/ldraw/library';
import { shadowLookupFrom, type Snap } from '../src/ldraw/shadow';
import { connectorFreedom } from '../src/plan/smartJoints';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BRICKNET = flag('--bricknet', join(ROOT, 'python', 'knowledge', 'bricknet'));
const LDRAW = flag('--ldraw', join(ROOT, 'public', 'ldraw'));
const PACK = flag('--shadow', join(ROOT, 'public', 'data', 'ldcad-shadow.json'));
const CATALOG = flag('--catalog', join(ROOT, 'public', 'data', 'catalog.json'));
const CORPUS = flag('--corpus', '/Users/mac/Projects/BrickMotion-Data/ldraw_brickheadz');
const OUT_TS = join(ROOT, 'src', 'data', 'bricknetConnectors.generated.ts');

// ---------------------------------------------------------------- BrickNet catalogue

type Row = number[];
/** stud/hole/axle: {sub: rows}; hinge/ball/fixed: {typeId: {on|in: rows}} */
type Labels = Record<string, Record<string, Record<string, Row[] | Record<string, Row[]>>>>;

const xzJson = (file: string) => JSON.parse(execFileSync('xz', ['-dc', file], { maxBuffer: 1 << 30 }).toString('utf8'));
const labels: Labels = xzJson(join(BRICKNET, 'labels.json.xz'));
const IDENT = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const alias = new Map<string, string>();
for (const r of (xzJson(join(BRICKNET, 'part_aliases.json.xz')).rows ?? []) as { src: string; dst: string; final_matrix_3x4?: number[] }[])
  if ((r.final_matrix_3x4 ?? []).every((v, k) => Number(v) === IDENT[k])) alias.set(r.src.toLowerCase(), r.dst.toLowerCase());

/** Our part id -> BrickNet stem, as python/brickheadz/connectors.py: aliases, then print suffixes stripped. */
export function stem(part: string): string | null {
  const p = part.toLowerCase().replace(/\\/g, '/').split('/').pop()!.replace(/\.dat$/, '');
  for (let c of [p, alias.get(p) ?? p, p.replace(/p[0-9a-z]{2,4}$/, ''), p.replace(/(p|pr|pat)[0-9a-z]+$/, '')]) {
    c = alias.get(c) ?? c;
    if (labels[`${c}.dat`]) return c;
  }
  return null;
}

export const FAMILIES = ['stud', 'axle', 'clipbar', 'hinge', 'ball', 'fixed'] as const;
export type Family = (typeof FAMILIES)[number];
type Counts = Record<Family, number>;
const zero = (): Counts => ({ stud: 0, axle: 0, clipbar: 0, hinge: 0, ball: 0, fixed: 0 });

function bricknetCounts(s: string): Counts {
  const out = zero();
  const d = labels[`${s}.dat`] ?? {};
  for (const [kind, subs] of Object.entries(d))
    for (const [sub, rows] of Object.entries(subs)) {
      const n = Array.isArray(rows) ? rows.length : Object.values(rows).reduce((a, r) => a + r.length, 0);
      const fam: Family = kind === 'stud' || kind === 'hole' ? 'stud'
        : kind === 'axle' ? (sub === 'bar' || sub === 'clip' ? 'clipbar' : 'axle')
        : (kind as Family);
      if (fam in out) out[fam] += n;
    }
  return out;
}

// ---------------------------------------------------------------- editor snaps

/** Which BrickNet family an editor snap belongs to (heuristic: see the audit notes). */
export function snapFamily(s: Snap): Family {
  if (s.kind === 'clp') return 'clipbar';
  if (s.kind === 'fgr') return 'hinge';
  if (s.kind === 'gen') return s.shapes.some((x) => x === 'GEN:sph' || x === 'GEN:pnt') ? 'ball' : 'fixed';
  if (s.shapes.some((x) => x === 'A')) return 'axle';
  if (s.shapes.some((x) => x === 'S')) return 'stud';
  if (s.radius <= 4.6) return 'clipbar';
  return !s.slide && s.length <= 6.5 ? 'stud' : 'axle';
}

const shadow = shadowLookupFrom(JSON.parse(readFileSync(PACK, 'utf8')).files);
const fetchText = async (p: string) => {
  const f = join(LDRAW, p);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};
// The library keeps every flattened part (meshes included); start a fresh one now and then.
let lib = new PartLibrary(fetchText, shadow), loads = 0;
const warn = console.warn;
console.warn = (...a: unknown[]) => { if (!String(a[0]).startsWith('LDraw: missing sub-file')) warn(...a); };

async function editorSnaps(part: string): Promise<Snap[] | null> {
  if (++loads % 400 === 0) lib = new PartLibrary(fetchText, shadow);
  try {
    const flat = await lib.loadPart(part);
    return flat ? flat.snaps ?? [] : null;
  } catch {
    return null;
  }
}

/** Whether smart joints can already turn a part on this snap (a round pin, clip, hinge finger or ball). */
export const rotational = (s: Snap) => s.kind === 'fgr' || s.kind === 'clp' ||
  (s.kind === 'gen' ? connectorFreedom({ ...s, placement: 'free' }, { ...s, placement: 'free' }) === 'ball' : connectorFreedom(s, s) === 'revolute');

const editorCounts = (snaps: Snap[]) => {
  const out = zero();
  for (const s of snaps) out[snapFamily(s)]++;
  return out;
};

// ---------------------------------------------------------------- part sets

function paletteParts(): string[] {
  return (JSON.parse(readFileSync(CATALOG, 'utf8')) as { id: string }[]).map((p) => p.id.toLowerCase());
}

/** Distinct library part ids used by the corpus models (submodels excluded), with use counts. */
function corpusParts(): Map<string, number> {
  const uses = new Map<string, number>();
  if (!existsSync(CORPUS)) return uses;
  for (const f of readdirSync(CORPUS).filter((n) => /\.(mpd|ldr)$/i.test(n))) {
    const text = readFileSync(join(CORPUS, f), 'utf8');
    const own = new Set([...text.matchAll(/^\s*0\s+FILE\s+(.+?)\s*$/gim)].map((m) => m[1].toLowerCase()));
    for (const m of text.matchAll(/^\s*1\s+(?:\S+\s+){13}(.+?)\s*$/gm)) {
      const name = m[1].toLowerCase().replace(/\\/g, '/');
      if (own.has(name)) continue;
      const id = name.replace(/^parts\//, '').replace(/\.dat$/, '');
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
  }
  return uses;
}

// ---------------------------------------------------------------- audit

type PartRow = { id: string; stem: string; bn: Counts; ed: Counts | null; rot: boolean; fgr: string[] };

async function measure(ids: string[], label: string): Promise<PartRow[]> {
  const out: PartRow[] = [];
  let k = 0;
  for (const id of ids) {
    if (++k % 1000 === 0) process.stderr.write(`::progress ${k}/${ids.length} ${label}\n`);
    const s = stem(id);
    if (!s) continue;
    const snaps = await editorSnaps(id);
    out.push({ id, stem: s, bn: bricknetCounts(s), ed: snaps ? editorCounts(snaps) : null, rot: !!snaps?.some(rotational),
      fgr: (snaps ?? []).filter((x) => x.kind === 'fgr').map((x) => `${(x.group ?? '').toLowerCase()}|${x.gender}|${x.radius}`) });
  }
  return out;
}

function table(rows: PartRow[], weight?: Map<string, number>) {
  const lines = ['| family | parts with BrickNet rows | editor has none | editor has fewer | none, weighted by uses |', '| --- | ---: | ---: | ---: | ---: |'];
  const loaded = rows.filter((r) => r.ed);
  for (const f of FAMILIES) {
    const has = loaded.filter((r) => r.bn[f] > 0);
    const none = has.filter((r) => r.ed![f] === 0);
    const fewer = has.filter((r) => r.ed![f] > 0 && r.ed![f] < r.bn[f]);
    const w = weight ? none.reduce((a, r) => a + (weight.get(r.id) ?? 0), 0) : 0;
    lines.push(`| ${f} | ${has.length} | ${none.length} | ${fewer.length} | ${weight ? w : '-'} |`);
  }
  const noRot = loaded.filter((r) => (r.bn.hinge > 0 || r.bn.ball > 0) && !r.rot);
  const w = weight ? noRot.reduce((a, r) => a + (weight.get(r.id) ?? 0), 0) : '-';
  lines.push(`| hinge or ball, editor has no rotational connector at all | ${loaded.filter((r) => r.bn.hinge > 0 || r.bn.ball > 0).length} | ${noRot.length} | | ${w} |`);
  const allNone = loaded.filter((r) => FAMILIES.some((f) => r.bn[f] > 0) && FAMILIES.every((f) => r.ed![f] === 0));
  lines.push('', `parts measured: ${loaded.length} (BrickNet stem found, LDraw file loaded; ${rows.length - loaded.length} failed to load); ` +
    `editor has no snaps at all but BrickNet has some: ${allNone.length}`);
  return lines.join('\n');
}

const examples = (rows: PartRow[], f: Family, n = 25) =>
  rows.filter((r) => r.ed && r.bn[f] > 0 && r.ed[f] === 0).slice(0, n).map((r) => `${r.id}${r.id !== r.stem ? `→${r.stem}` : ''}`).join(', ');

async function audit() {
  const corpus = corpusParts();
  const palette = paletteParts();
  const prow = await measure(palette, 'palette');
  const byId = new Map(prow.map((r) => [r.id, r]));
  const crow: PartRow[] = [];
  for (const id of corpus.keys()) {
    const hit = byId.get(id);
    if (hit) crow.push(hit);
    else crow.push(...(await measure([id], 'corpus')));
  }
  const bnTotal = Object.keys(labels).length;
  console.log(`# BrickNet connector coverage audit\n\nBrickNet parts: ${bnTotal}; palette parts: ${palette.length}; ` +
    `palette parts with a BrickNet stem: ${prow.length}; corpus distinct parts: ${corpus.size} (with stem: ${crow.length}).\n`);
  console.log('## Palette\n\n' + table(prow) + '\n');
  console.log('## BrickHeadz corpus\n\n' + table(crow, corpus) + '\n');
  for (const f of FAMILIES) console.log(`palette, ${f}, editor none (first 25): ${examples(prow, f)}`);
  console.log(`palette, hinge/ball, no rotational connector (first 60): ${prow.filter((r) => r.ed && (r.bn.hinge || r.bn.ball) && !r.rot).slice(0, 60).map((r) => r.id).join(', ')}`);
  console.log('\n## BrickNet hinge type -> LDCad finger group (parts with both)\n');
  for (const [k, v] of [...hingeGroups(prow)].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })))
    console.log(`${k}: ${[...v].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, n]) => `${g} x${n}`).join(', ')}`);
  for (const f of FAMILIES) console.log(`corpus, ${f}, editor none: ${examples(crow, f, 200)}`);
}

/** For each BrickNet hinge "type/side", the LDCad finger snaps (group|gender|radius) on parts with only that one hinge type. */
function hingeGroups(rows: PartRow[]) {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const h = labels[`${r.stem}.dat`]?.hinge as Record<string, Record<string, Row[]>> | undefined;
    if (!h || r.fgr.length === 0) continue;
    const keys = Object.entries(h).flatMap(([t, sides]) => Object.keys(sides).map((side) => `${t}/${side}`));
    if (keys.length !== 1) continue;
    const m = out.get(keys[0]) ?? out.set(keys[0], new Map()).get(keys[0])!;
    for (const g of new Set(r.fgr)) m.set(g, (m.get(g) ?? 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------- generate

/** Families emitted as fallback connectors: the ones smart joints turn into rotation constraints. */
const EMIT = ['hinge', 'ball'] as const;
/** Same test as src/data/bricknetJoints.ts: the part has LDCad snaps of this family. */
const hasFamily = (snaps: Snap[], f: (typeof EMIT)[number]) =>
  snaps.some((s) => (f === 'hinge' ? s.kind === 'fgr' : s.kind === 'gen' && s.shapes.some((x) => x === 'GEN:sph' || x === 'GEN:pnt')));

async function generate() {
  const stems = new Map<string, string[]>();
  for (const id of paletteParts()) {
    const s = stem(id);
    if (s && EMIT.some((f) => labels[`${s}.dat`][f])) (stems.get(s) ?? stems.set(s, []).get(s)!).push(id);
  }
  const out: string[] = [];
  let parts = 0, rows = 0, k = 0;
  const listed = new Set<string>();
  for (const [s, members] of [...stems].sort(([a], [b]) => a.localeCompare(b))) {
    if (++k % 200 === 0) process.stderr.write(`::progress ${k}/${stems.size} generate\n`);
    const d = labels[`${s}.dat`];
    // A family is listed when some palette part with this stem has no LDCad snap of it;
    // the runtime checks each part's own snaps again.
    const need = new Set<(typeof EMIT)[number]>();
    for (const id of members) {
      const snaps = await editorSnaps(id);
      if (!snaps) continue;
      for (const f of EMIT) if (d[f] && !hasFamily(snaps, f)) need.add(f);
    }
    if (!need.size) continue;
    const body: string[] = [];
    for (const f of EMIT) {
      if (!need.has(f)) continue;
      for (const [type, sides] of Object.entries(d[f] as Record<string, Record<string, Row[]>>).sort(([a], [b]) => Number(a) - Number(b)))
        for (const [side, list] of Object.entries(sides).sort())
          for (const r of list) {
            const values = (f === 'ball' ? r.slice(0, 3) : r.slice(0, 5)).map((v) => +Number(v).toFixed(4));
            body.push(`[${JSON.stringify(f)},${type},${side === 'on' ? 1 : 0},${values.join(',')}]`);
            rows++;
          }
    }
    out.push(`  ${JSON.stringify(s)}: [${body.join(',')}],`);
    listed.add(s);
    parts++;
  }
  const aliases = [...alias].filter(([, dst]) => listed.has(dst)).sort(([a], [b]) => a.localeCompare(b));
  const text = `// GENERATED by scripts/bricknet-connectors.ts on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.
// Hinge and ball connectors from BrickNet's catalogue (Kulits & Schmid, CVPR 2026, MIT licence,
// https://github.com/kulits/BrickNet; copy in python/knowledge/bricknet). A family is listed for
// a part only when some palette part using it has no LDCad snap of that family (LDCad stays the
// primary source); src/data/bricknetJoints.ts turns the rows into smart-joint snaps.
//
// Row: [family, type, on, x, y, z, ...] in part space (LDU, y down). "hinge" rows go on with
// pitch and roll (degrees): the hinge axis is the frame's -Y, frame rotation
// [cz,-sz,0; cx*sz,cx*cz,-sx; sx*sz,sx*cz,cx] (x = pitch, z = roll). "ball" rows are the centre.
// "in" (on = 0) is the male half, "on" (1) the female; they mate within one family and type.

export type BricknetRow = readonly [family: 'hinge' | 'ball', type: number, on: 0 | 1, ...values: number[]];

/** ${parts} parts, ${rows} connectors. Keyed by BrickNet part stem (lower case, no .dat). */
export const bricknetConnectors: Readonly<Record<string, readonly BricknetRow[]>> = {
${out.join('\n')}
};

/** BrickNet's identity-transform part aliases (old id -> listed stem). */
export const bricknetAliases: Readonly<Record<string, string>> = {
${aliases.map(([a, b]) => `  ${JSON.stringify(a)}: ${JSON.stringify(b)},`).join('\n')}
};
`;
  writeFileSync(OUT_TS, text);
  console.log(`wrote ${OUT_TS}: ${parts} parts, ${rows} connectors, ${aliases.length} aliases`);
}

const mode = args[0];
if (mode === 'audit') await audit();
else if (mode === 'generate') await generate();
else {
  console.error('usage: tsx scripts/bricknet-connectors.ts audit|generate');
  process.exit(1);
}
