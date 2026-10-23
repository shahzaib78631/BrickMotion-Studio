/**
 * Measures tyre bore and wheel-rim seat geometry from the LDraw library and
 * writes src/data/wheelSeats.generated.ts.
 *
 *   npx tsx scripts/measure-wheels.ts
 *
 * Only parts whose LDCad shadow metadata does not already define a "rim…"
 * SNAP_GEN group are emitted; LDCad is authoritative for the rest. The same
 * script validates the measured fit rule against the tyre/rim pairings that the
 * shadow data does describe and prints precision/recall plus the chosen
 * tolerance. Flexible-part classification lives in scripts/measure-flexible.ts.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PartLibrary } from '../src/ldraw/library';
import type { FlatPart } from '../src/ldraw/flatten';
import { ownSnaps, shadowLookupFrom } from '../src/ldraw/shadow';

const ROOT = process.cwd();
const LDRAW = join(ROOT, 'public', 'ldraw');
const PARTS = join(LDRAW, 'parts');
const OUT = join(ROOT, 'src', 'data', 'wheelSeats.generated.ts');

type Kind = 'tyre' | 'rim';
type Seat = { part: string; role: Kind; axis: [number, number, number]; radius: number; width: number };

const fetchText = async (path: string) => {
  for (const f of [join(LDRAW, path), join(LDRAW, 'parts', path), join(LDRAW, 'p', path)]) {
    if (statSync(f, { throwIfNoEntry: false })?.isFile()) return readFileSync(f, 'utf8');
  }
  return null;
};
const shadowPack = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'ldcad-shadow.json'), 'utf8')) as { files: Record<string, string> };
const shadow = shadowLookupFrom(shadowPack.files);
const lib = new PartLibrary(fetchText, shadow);

type Header = { id: string; title: string; category: string };
function headers(): Header[] {
  const out: Header[] = [];
  for (const file of readdirSync(PARTS)) {
    if (!file.toLowerCase().endsWith('.dat')) continue;
    const text = readFileSync(join(PARTS, file), 'utf8').split(/\r?\n/, 40);
    const title = text[0]?.startsWith('0 ') ? text[0].slice(2).trim() : '';
    const category = text.find((l) => /^0\s+!CATEGORY\b/i.test(l))?.replace(/^0\s+!CATEGORY\s*/i, '').trim() ?? '';
    out.push({ id: file.replace(/\.dat$/i, ''), title, category });
  }
  return out;
}

const isSticker = (h: Header) => /sticker/i.test(h.title) || /sticker/i.test(h.category);
/** Tyres are named "Tyre …" (US "Tire …"); rims "Wheel Rim …". */
function roleOf(h: Header): Kind | null {
  if (isSticker(h)) return null;
  if (/^(tyre|tire)\b/i.test(h.title)) return 'tyre';
  // Complete wheel assemblies ("Wheel Rim … with Tyre …") are not bare rims.
  if (/^wheel rim\b/i.test(h.title) && !/\bwith\b.*\b(tyre|tire)\b|\bcomplete\b/i.test(h.title)) return 'rim';
  return null;
}

function triangles(p: FlatPart): number[][] {
  const out: number[][] = [];
  for (const map of [p.tris, p.doubleSided])
    for (const list of map.values())
      for (let i = 0; i + 8 < list.length; i += 9) out.push(list.slice(i, i + 9));
  return out;
}

/**
 * Finds the axis of rotational symmetry from the geometry itself. For each
 * part-space axis we cut the mesh into thin cross-sections and check how much
 * the outer radius varies with angle around the section: a body of revolution
 * is circular, an off-axis cut is not. The bounding-box shortcut fails on small
 * rims whose axle makes the width as large as the diameter.
 */
function radiusAngles(t: number[], k: number, z: number, c: [number, number, number]): { r: number; a: number }[] {
  const perp = [0, 1, 2].filter((i) => i !== k);
  const out: { r: number; a: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const a0 = t[i * 3 + k] - z, b0 = t[j * 3 + k] - z;
    if ((a0 < 0 && b0 < 0) || (a0 > 0 && b0 > 0)) continue;
    let x: number, y: number;
    if (Math.abs(a0 - b0) < 1e-9) {
      x = t[i * 3 + perp[0]];
      y = t[i * 3 + perp[1]];
    } else {
      const f = (z - t[i * 3 + k]) / (t[j * 3 + k] - t[i * 3 + k]);
      x = t[i * 3 + perp[0]] + (t[j * 3 + perp[0]] - t[i * 3 + perp[0]]) * f;
      y = t[i * 3 + perp[1]] + (t[j * 3 + perp[1]] - t[i * 3 + perp[1]]) * f;
    }
    const r = Math.hypot(x - c[perp[0]], y - c[perp[1]]);
    if (r > 0.2) out.push({ r, a: Math.atan2(y - c[perp[1]], x - c[perp[0]]) });
  }
  return out;
}

function symmetryScore(tris: number[][], k: number, b: { min: [number, number, number]; max: [number, number, number] }): number {
  const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2) as [number, number, number];
  const width = b.max[k] - b.min[k];
  const step = Math.max(0.25, Math.min(1, width / 60));
  let sum = 0, n = 0;
  for (let z = b.min[k] + step / 2; z < b.max[k]; z += step) {
    const ra: { r: number; a: number }[] = [];
    for (const t of tris) ra.push(...radiusAngles(t, k, z, c));
    if (ra.length < 6) continue;
    const bins = new Array<number>(36).fill(-1);
    for (const { r, a } of ra) {
      const bi = Math.floor(((a + Math.PI) / (2 * Math.PI)) * 36) % 36;
      if (r > bins[bi]) bins[bi] = r;
    }
    const vals = bins.filter((v) => v >= 0);
    if (vals.length < 4) continue;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    sum += sd / mean;
    n++;
  }
  return n ? sum / n : Number.POSITIVE_INFINITY;
}

function wheelAxis(p: FlatPart, tris: number[][]): { axis: [number, number, number]; k: number; width: number; centre: [number, number, number] } | null {
  const b = p.bodyBox;
  if (!b) return null;
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  if (ext.some((x) => !(x > 0))) return null;
  const scores = [0, 1, 2].map((k) => symmetryScore(tris, k, b));
  const best = scores.indexOf(Math.min(...scores));
  if (!Number.isFinite(scores[best])) return null;
  const axis: [number, number, number] = best === 0 ? [1, 0, 0] : best === 1 ? [0, 1, 0] : [0, 0, 1];
  return { axis, k: best, width: ext[best], centre: [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2) as [number, number, number] };
}

/** Surface radii at one axial plane, from triangle/plane intersections. */
function sliceRadii(tris: number[][], k: number, z: number, c: [number, number, number]): number[] {
  const perp = [0, 1, 2].filter((i) => i !== k);
  const out: number[] = [];
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a0 = t[i * 3 + k] - z, b0 = t[((i + 1) % 3) * 3 + k] - z;
      if ((a0 < 0 && b0 < 0) || (a0 > 0 && b0 > 0)) continue;
      if (Math.abs(a0 - b0) < 1e-9) {
        const r = Math.hypot(t[i * 3 + perp[0]] - c[perp[0]], t[i * 3 + perp[1]] - c[perp[1]]);
        if (r > 0.2) out.push(r);
        continue;
      }
      const f = (z - t[i * 3 + k]) / (t[((i + 1) % 3) * 3 + k] - t[i * 3 + k]);
      const x = t[i * 3 + perp[0]] + (t[((i + 1) % 3) * 3 + perp[0]] - t[i * 3 + perp[0]]) * f;
      const y = t[i * 3 + perp[1]] + (t[((i + 1) % 3) * 3 + perp[1]] - t[i * 3 + perp[1]]) * f;
      const r = Math.hypot(x - c[perp[0]], y - c[perp[1]]);
      if (r > 0.2) out.push(r);
    }
  }
  return out;
}

/** The most common radius in a set, refined to the mean of its 0.5 LDU bin. */
function mode(values: number[]): number {
  if (!values.length) return 0;
  const bins = new Map<number, number[]>();
  for (const v of values) {
    const key = Math.round(v * 2) / 2;
    const list = bins.get(key);
    if (list) list.push(v);
    else bins.set(key, [v]);
  }
  let best: number[] = [];
  for (const list of bins.values()) if (list.length > best.length) best = list;
  return best.reduce((s, v) => s + v, 0) / best.length;
}

type Profile = { inner: number[]; outer: number[]; slices: number };
function profile(tris: number[][], axis: { k: number; width: number; centre: [number, number, number] }): Profile {
  const { k, centre, width } = axis;
  const step = Math.max(0.25, Math.min(1, width / 100));
  const inner: number[] = [], outer: number[] = [];
  let slices = 0;
  for (let z = centre[k] - width / 2 + step / 2; z < centre[k] + width / 2; z += step) {
    const rs = sliceRadii(tris, k, z, centre);
    if (!rs.length) continue;
    slices++;
    inner.push(Math.min(...rs));
    outer.push(Math.max(...rs));
  }
  return { inner, outer, slices };
}

function measure(part: FlatPart, role: Kind): Seat | null {
  const tris = triangles(part);
  if (!tris.length) return null;
  const axis = wheelAxis(part, tris);
  if (!axis) return null;
  const prof = profile(tris, axis);
  if (!prof.slices || !prof.inner.length) return null;
  let radius: number;
  if (role === 'tyre') {
    // The bore is the tightest inner surface. Large open tyres have their open
    // middle at a much larger radius; ignore it and take the bead band.
    const min = Math.min(...prof.inner);
    const bead = prof.inner.filter((r) => r <= min * 1.5);
    radius = mode(bead.length ? bead : prof.inner);
  } else {
    // The seat is the outer cylinder that persists along the rim; flanges and
    // hub ends are narrow, so the mode ignores them.
    radius = mode(prof.outer);
  }
  if (!(radius > 0) || !Number.isFinite(radius)) return null;
  return { part: part.id.toLowerCase(), role, axis: axis.axis, radius: Math.round(radius * 100) / 100, width: Math.round(axis.width * 100) / 100 };
}

function rimGroups(part: FlatPart): { group: string; gender: 'M' | 'F' }[] {
  return (part.snaps ?? [])
    .filter((s) => s.kind === 'gen' && /^rim/i.test(s.group ?? ''))
    .map((s) => ({ group: s.group!.toLowerCase(), gender: s.gender }));
}

type Validation = { tolerance: number; widthTolerance: number; precision: number; recall: number; truePositives: number; falsePositives: number; falseNegatives: number; pairs: number };
function evaluate(seats: Map<string, Seat>, truth: Set<string>, candidates: string[], tol: number, widthTol: number): Validation {
  const tyres = candidates.filter((id) => seats.get(id)?.role === 'tyre');
  const rims = candidates.filter((id) => seats.get(id)?.role === 'rim');
  let tp = 0, fp = 0, fn = 0, pairs = 0;
  const predicted = new Set<string>();
  for (const t of tyres) for (const r of rims) {
    const a = seats.get(t)!, b = seats.get(r)!;
    if (Math.abs(a.radius - b.radius) > tol) continue;
    if (b.width > a.width + widthTol || b.width < a.width * 0.4) continue;
    const key = `${t}|${r}`;
    predicted.add(key);
    pairs++;
    if (truth.has(key)) tp++;
    else fp++;
  }
  for (const key of truth) if (!predicted.has(key) && seats.has(key.split('|')[0]) && seats.has(key.split('|')[1])) fn++;
  return { tolerance: tol, widthTolerance: widthTol, precision: pairs ? tp / pairs : 1, recall: truth.size ? (truth.size - fn) / truth.size : 1, truePositives: tp, falsePositives: fp, falseNegatives: fn, pairs };
}

async function main() {
  const all = headers();
  const candidates = all.map((h) => ({ h, role: roleOf(h) })).filter((x): x is { h: Header; role: Kind } => x.role !== null);
  const seats = new Map<string, Seat>();
  const described = new Set<string>();
  const failed: string[] = [];
  for (const { h, role } of candidates) {
    const part = await lib.loadPart(h.id);
    if (!part) { failed.push(h.id); continue; }
    // LDCad groups come from the raw shadow (including SNAP_INCL), never from
    // the supplementary connectors this app adds on top.
    if (ownSnaps(`${h.id}.dat`, shadow).some((s) => s.kind === 'gen' && /^rim/i.test(s.group ?? ''))) described.add(part.id.toLowerCase());
    const seat = measure(part, role);
    if (seat) seats.set(part.id.toLowerCase(), seat);
    else failed.push(h.id);
  }

  // Ground truth: tyres and rims that LDCad itself joins with the same rim…
  // group. Read the raw shadow (not the flattened part, which also carries the
  // supplementary groups) so the validation set is independent of this file.
  const byGroup = new Map<string, { tyres: string[]; rims: string[] }>();
  for (const { h } of candidates) {
    for (const snap of ownSnaps(`${h.id}.dat`, shadow)) {
      if (snap.kind !== 'gen' || !/^rim/i.test(snap.group ?? '')) continue;
      const e = byGroup.get(snap.group!.toLowerCase()) ?? { tyres: [], rims: [] };
      if (snap.gender === 'F') e.tyres.push(h.id.toLowerCase());
      else e.rims.push(h.id.toLowerCase());
      byGroup.set(snap.group!.toLowerCase(), e);
    }
  }
  const truth = new Set<string>();
  for (const e of byGroup.values()) for (const t of e.tyres) for (const r of e.rims) truth.add(`${t}|${r}`);
  // Only validate pairs whose two parts were actually measured; skipped or
  // unmeasurable parts are reported separately instead of counting as misses.
  for (const key of [...truth]) { const [t, r] = key.split('|'); if (!seats.has(t) || !seats.has(r)) truth.delete(key); }
  const validationParts = [...new Set([...truth].flatMap((k) => k.split('|')))];
  const grid: Validation[] = [];
  for (const tol of [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12])
    for (const widthTol of [4, 8, 12, 20]) grid.push(evaluate(seats, truth, validationParts, tol, widthTol));
  const good = grid.filter((v) => v.recall >= 1 && v.falsePositives === 0).sort((a, b) => a.tolerance - b.tolerance || a.widthTolerance - b.widthTolerance);
  const chosen = good[0] ?? grid.sort((a, b) => b.recall - a.recall || a.falsePositives - b.falsePositives || a.tolerance - b.tolerance)[0];

  const generated = [...seats.values()]
    .filter((s) => !described.has(s.part))
    .sort((a, b) => a.role.localeCompare(b.role) || a.part.localeCompare(b.part));
  const date = new Date().toISOString().slice(0, 10);
  const body = generated.map((s) => `  { part: '${s.part}', role: '${s.role}', axis: [${s.axis.join(', ')}], radius: ${s.radius}, width: ${s.width} },`).join('\n');
  const text = `// GENERATED by scripts/measure-wheels.ts on ${date}. Do not edit by hand.\n// Measured tyre bores and wheel-rim seats from public/ldraw geometry.\n// LDCad shadow parts with a "rim…" SNAP_GEN group are intentionally omitted.\n\nexport type WheelSeat = {\n  part: string;\n  role: 'tyre' | 'rim';\n  /** measured wheel axis in part space */\n  axis: [number, number, number];\n  /** tyre bore / rim seat radius, LDU */\n  radius: number;\n  /** width along the axis, LDU */\n  width: number;\n};\n\nexport const wheelSeats: readonly WheelSeat[] = [\n${body}\n];\n`;
  mkdirSync(join(ROOT, 'src', 'data'), { recursive: true });
  writeFileSync(OUT, text);

  const count = (role: Kind) => generated.filter((s) => s.role === role).length;
  const measuredCount = (role: Kind) => [...seats.values()].filter((s) => s.role === role).length;
  console.log(`Scanned ${candidates.length} tyre/rim parts (${candidates.filter((c) => c.role === 'tyre').length} tyres, ${candidates.filter((c) => c.role === 'rim').length} rims).`);
  console.log(`Measured ${measuredCount('tyre')} tyres and ${measuredCount('rim')} rims; ${failed.length} skipped.`);
  console.log(`Generated ${generated.length} entries (${count('tyre')} tyres, ${count('rim')} rims), ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB → ${relative(ROOT, OUT)}`);
  console.log(`LDCad-described parts (authoritative, omitted): ${[...described].sort().join(', ')}`);
  console.log(`Ground-truth LDCad pairs (${truth.size}): ${[...truth].sort().join(', ')}`);
  for (const v of grid.filter((x) => x.recall >= 1 && x.falsePositives === 0).slice(0, 8))
    console.log(`  tol ${v.tolerance} width ${v.widthTolerance}: P ${v.precision.toFixed(2)} R ${v.recall.toFixed(2)} tp ${v.truePositives} fp ${v.falsePositives} fn ${v.falseNegatives}`);
  console.log(`CHOSEN tolerance ${chosen.tolerance} LDU, width tolerance ${chosen.widthTolerance} LDU: precision ${chosen.precision.toFixed(2)}, recall ${chosen.recall.toFixed(2)} (tp ${chosen.truePositives}, fp ${chosen.falsePositives}, fn ${chosen.falseNegatives}, predicted ${chosen.pairs}).`);
  if (failed.length) console.log(`Skipped: ${failed.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
