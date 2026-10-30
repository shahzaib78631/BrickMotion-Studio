import type { Mat3, Vec3 } from './parse';
import { withShadowPatches } from './shadowPatches';

/**
 * LDCad shadow library snap metadata (https://www.melkert.net/LDCad/tech/meta).
 *
 * Shadow files sit beside the LDraw library under the same names and describe
 * connectors: studs, anti-studs, pins, pin holes, axles, clips, hinge fingers.
 * A part inherits the snaps of every sub-file it references (moved with that
 * reference), unless its own shadow clears them with SNAP_CLEAR.
 */

/** One cylinder section: R round, A axle (cross), S square; L_/_L are flexible round ends. */
export type SnapSection = { shape: string; radius: number; length: number };

type SnapBase = {
  /** connector name (e.g. "studC", "axleHole"), used by SNAP_CLEAR */
  id?: string;
  group?: string;
  /** a frame per grid copy: 3x3 orientation (row-major, LDraw style) and position */
  frames: { m: Mat3; pos: Vec3 }[];
};
export type CylSnapDef = SnapBase & {
  kind: 'cyl';
  gender: 'M' | 'F';
  /** which ends are closed: none, one (the far end), two, A, B */
  caps: string;
  secs: SnapSection[];
  /** sections centred on the position instead of starting there */
  center: boolean;
  /** may slide along its axis (pin holes, axle holes) */
  slide: boolean;
  /** LDCad axis scaling qualifier (e.g. "YOnly" for axle/axle-hole primitives). */
  scale?: string;
  /** LDCad match qualifier (e.g. "size"). */
  match?: string;
};
export type ClipSnapDef = SnapBase & { kind: 'clp'; radius: number; length: number; center: boolean; slide: boolean };
/** Radius for a SNAP_FGR without one: the library's most common finger radius. */
export const DEFAULT_FINGER_RADIUS = 4;
export type FingerSnapDef = SnapBase & { kind: 'fgr'; genderOfs: 'M' | 'F'; seq: number[]; radius: number; center: boolean };
export type GenSnapDef = SnapBase & {
  kind: 'gen';
  gender: 'M' | 'F';
  bounding: string;
  /** "free" permits an unconstrained mate (ball joints). */
  placement?: string;
  match?: string;
};
export type SnapDef = CylSnapDef | ClipSnapDef | FingerSnapDef | GenSnapDef;

export type ShadowInfo = {
  snaps: SnapDef[];
  /** SNAP_INCL: snaps of another file, placed like a sub-file */
  includes: { ref: string; frames: { m: Mat3; pos: Vec3 }[] }[];
  /** SNAP_CLEAR: drop inherited snaps; null = all of them */
  clear: Set<string> | null | undefined;
};

const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** `[key=value]` pairs of one meta line. Values may contain spaces. Keys are case-insensitive. */
export function snapParams(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\[\s*([A-Za-z]+)\s*=([^\]]*)\]/g)) out.set(m[1].toLowerCase(), m[2].trim());
  return out;
}

const nums = (s: string | undefined): number[] => (s ? s.trim().split(/\s+/).map(Number) : []);

/**
 * The grid copies of a snap. `grid=C 2 1 20 0`: 2 copies along X centred on the
 * position, 1 along Z, 20 LDU apart. Without C a row starts at the position.
 * Offsets are in the snap's own frame.
 */
export function gridOffsets(grid: string | undefined): Vec3[] {
  if (!grid) return [[0, 0, 0]];
  const t = grid.trim().split(/\s+/);
  let k = 0;
  const axis = () => {
    const centred = t[k] === 'C' || t[k] === 'c';
    if (centred) k++;
    return { centred, count: Math.max(1, Math.round(Number(t[k++]))) };
  };
  const x = axis(), z = axis();
  const sx = Number(t[k++]), sz = Number(t[k++]);
  if (![x.count, z.count, sx, sz].every(Number.isFinite)) return [[0, 0, 0]];
  const along = (a: { centred: boolean; count: number }, step: number) =>
    Array.from({ length: a.count }, (_, i) => (a.centred ? (i - (a.count - 1) / 2) * step : i * step));
  const out: Vec3[] = [];
  for (const dx of along(x, sx)) for (const dz of along(z, sz)) out.push([dx, 0, dz]);
  return out;
}

const mulMat = (a: Mat3, b: Mat3): Mat3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const applyMat = (m: Mat3, p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
];

function framesOf(p: Map<string, string>): { m: Mat3; pos: Vec3 }[] {
  const pos = nums(p.get('pos'));
  const ori = nums(p.get('ori'));
  const base: Vec3 = pos.length === 3 && pos.every(Number.isFinite) ? [pos[0], pos[1], pos[2]] : [0, 0, 0];
  const m: Mat3 = ori.length === 9 && ori.every(Number.isFinite) ? (ori as Mat3) : I3;
  return gridOffsets(p.get('grid')).map((o) => {
    const d = applyMat(m, o);
    return { m, pos: [base[0] + d[0], base[1] + d[1], base[2] + d[2]] };
  });
}

/** `R 6 4   A 6 1`: shape, radius, length triples. */
export function parseSections(secs: string | undefined): SnapSection[] {
  const t = (secs ?? '').trim().split(/\s+/).filter(Boolean);
  const out: SnapSection[] = [];
  for (let k = 0; k + 2 < t.length; k += 3) {
    const radius = Number(t[k + 1]), length = Number(t[k + 2]);
    if (Number.isFinite(radius) && Number.isFinite(length)) out.push({ shape: t[k].toUpperCase(), radius, length });
  }
  return out;
}

const bool = (v: string | undefined) => v?.toLowerCase() === 'true';
const gender = (v: string | undefined): 'M' | 'F' | null => (v?.toUpperCase() === 'M' ? 'M' : v?.toUpperCase() === 'F' ? 'F' : null);

/**
 * The snap metadata in one shadow file. Commented-out commands (`0 //!LDCAD`)
 * and MIRROR_INFO/HINTS are ignored.
 */
export function parseShadow(text: string): ShadowInfo {
  const info: ShadowInfo = { snaps: [], includes: [], clear: undefined };
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*0\s+!LDCAD\s+(SNAP_[A-Z]+)\b(.*)$/i.exec(raw);
    if (!m) continue;
    const cmd = m[1].toUpperCase();
    const p = snapParams(m[2]);
    const common = { id: p.get('id'), group: p.get('group'), frames: framesOf(p) };
    if (cmd === 'SNAP_CLEAR') {
      const id = p.get('id');
      if (!id) info.clear = null;
      else if (info.clear !== null) (info.clear ??= new Set()).add(id);
    } else if (cmd === 'SNAP_INCL') {
      const ref = p.get('ref');
      if (ref) info.includes.push({ ref, frames: common.frames });
    } else if (cmd === 'SNAP_CYL') {
      const g = gender(p.get('gender'));
      const secs = parseSections(p.get('secs'));
      if (g && secs.length) info.snaps.push({ ...common, kind: 'cyl', gender: g, caps: p.get('caps')?.toLowerCase() ?? 'one', secs, center: bool(p.get('center')), slide: bool(p.get('slide')),
        ...(p.get('scale') ? { scale: p.get('scale') } : {}), ...(p.get('match') ? { match: p.get('match') } : {}) });
    } else if (cmd === 'SNAP_CLP') {
      const radius = Number(p.get('radius')), length = Number(p.get('length') ?? 0);
      if (Number.isFinite(radius)) info.snaps.push({ ...common, kind: 'clp', radius, length: Number.isFinite(length) ? length : 0, center: bool(p.get('center')), slide: bool(p.get('slide')) });
    } else if (cmd === 'SNAP_FGR') {
      const g = gender(p.get('genderofs'));
      const seq = nums(p.get('seq')).filter(Number.isFinite);
      // Some shadow files leave the radius out (every locking hinge, for one); keep those fingers.
      const radius = p.has('radius') ? Number(p.get('radius')) : DEFAULT_FINGER_RADIUS;
      if (g && seq.length && Number.isFinite(radius)) info.snaps.push({ ...common, kind: 'fgr', genderOfs: g, seq, radius, center: bool(p.get('center')) });
    } else if (cmd === 'SNAP_GEN') {
      const g = gender(p.get('gender'));
      if (g) info.snaps.push({ ...common, kind: 'gen', gender: g, bounding: p.get('bounding') ?? '',
        ...(p.get('placement') ? { placement: p.get('placement') } : {}), ...(p.get('match') ? { match: p.get('match') } : {}) });
    }
  }
  return info;
}

/**
 * A resolved connector in part space: a segment along `axis` from `start` with
 * `length`, as LDCad runs sections along the snap's -Y.
 */
export type Snap = {
  kind: SnapDef['kind'];
  id?: string;
  group?: string;
  gender: 'M' | 'F';
  /** start of the connector (LDU, part space) */
  start: Vec3;
  /** unit direction its sections run in */
  axis: Vec3;
  length: number;
  /** largest round radius; axles report their outer radius */
  radius: number;
  /** section shapes, in order (R, A, S, ...) */
  shapes: string[];
  /** Actual coaxial section profile measured from `start`, including each section radius.
   * A single max-radius approximation can reject a valid tapered stud, or worse,
   * accept two incompatible profiles. Legacy cached metrics may omit this. */
  sections?: { shape: string; radius: number; start: number; length: number }[];
  slide: boolean;
  /** Raw LDCad semantics retained for kinematic inference (V4). */
  caps?: string;
  center?: boolean;
  seq?: number[];
  scale?: string;
  match?: string;
  placement?: string;
};

const DOWN_LOCAL: Vec3 = [0, -1, 0];

/** One resolved snap per grid copy of a definition, placed by `m`/`t` (the reference into the part). */
export function placeSnap(def: SnapDef, m: Mat3, t: Vec3): Snap[] {
  const out: Snap[] = [];
  for (const f of def.frames) {
    const fm = mulMat(m, f.m);
    const origin = applyMat(m, f.pos);
    const o: Vec3 = [origin[0] + t[0], origin[1] + t[1], origin[2] + t[2]];
    const raw = applyMat(fm, DOWN_LOCAL);
    const scale = Math.hypot(...raw) || 1;
    const axis: Vec3 = [raw[0] / scale, raw[1] / scale, raw[2] / scale];
    // lengths scale with the reference (e.g. a stretched axle hole primitive)
    let length = 0, radius = 0, shapes: string[] = [], sections: Snap['sections'] = [], g: 'M' | 'F' = 'M', centred = false, slide = false;
    let caps: string | undefined, seq: number[] | undefined, scaleQ: string | undefined, match: string | undefined, placement: string | undefined;
    const side = Math.max(Math.hypot(fm[0], fm[3], fm[6]), Math.hypot(fm[2], fm[5], fm[8]));
    if (def.kind === 'cyl') {
      length = def.secs.reduce((s, x) => s + x.length, 0) * scale;
      radius = Math.max(...def.secs.map((x) => x.radius)) * side;
      shapes = def.secs.map((x) => x.shape);
      let cursor = 0;
      sections = def.secs.map(x => {
        const result = { shape: x.shape, radius: x.radius * side, start: cursor, length: x.length * scale };
        cursor += result.length;
        return result;
      });
      g = def.gender; centred = def.center; slide = def.slide;
      caps = def.caps; scaleQ = def.scale; match = def.match;
    } else if (def.kind === 'clp') {
      length = def.length * scale; radius = def.radius * side; shapes = ['CLP']; g = 'F'; centred = def.center; slide = def.slide;
    } else if (def.kind === 'fgr') {
      length = def.seq.reduce((s, x) => s + x, 0) * scale; radius = def.radius * side; shapes = ['FGR']; g = def.genderOfs; centred = def.center;
      seq = def.seq;
    } else {
      // bounding=cyl <radius> <length> | sph <radius> | box …: centred on the position
      const [shape, a, b] = def.bounding.trim().split(/\s+/);
      g = def.gender; centred = true;
      shapes = [`GEN:${(shape ?? '').toLowerCase()}`];
      radius = (Number(a) || 0) * side;
      length = shape?.toLowerCase() === 'cyl' ? (Number(b) || 0) * scale : 0;
      match = def.match; placement = def.placement;
    }
    const start: Vec3 = centred ? [o[0] - axis[0] * length / 2, o[1] - axis[1] * length / 2, o[2] - axis[2] * length / 2] : o;
    out.push({ kind: def.kind, id: def.id, group: def.group, gender: g, start, axis, length, radius, shapes, ...(sections.length ? { sections } : {}), slide,
      ...(caps ? { caps } : {}), ...(centred ? { center: true } : {}), ...(seq ? { seq } : {}), ...(scaleQ ? { scale: scaleQ } : {}), ...(match ? { match } : {}), ...(placement ? { placement } : {}) });
  }
  return out;
}

/** Shadow info by lower-case file name (e.g. "stud.dat", "3022.dat", "s/3001s01.dat"). */
export type ShadowLookup = (file: string) => ShadowInfo | null;

/**
 * The snaps a file defines itself, with SNAP_INCL references expanded (they
 * are placed like sub-files). Bounded against include loops.
 */
export function ownSnaps(file: string, lookup: ShadowLookup, m: Mat3 = I3, t: Vec3 = [0, 0, 0], depth = 0): Snap[] {
  const info = lookup(file);
  if (!info || depth > 8) return [];
  const out = info.snaps.flatMap((def) => placeSnap(def, m, t));
  for (const inc of info.includes)
    for (const f of inc.frames) {
      const fm = mulMat(m, f.m);
      const ft = applyMat(m, f.pos);
      out.push(...ownSnaps(inc.ref.toLowerCase(), lookup, fm, [ft[0] + t[0], ft[1] + t[1], ft[2] + t[2]], depth + 1));
    }
  return out;
}

/** Whether inherited snaps are dropped by the file's SNAP_CLEAR (all, or this connector's id). */
export function clears(info: ShadowInfo | null, id: string | undefined): boolean {
  if (!info || info.clear === undefined) return false;
  if (info.clear === null) return true;
  return !!id && [...info.clear].some((c) => c.toLowerCase() === id.toLowerCase());
}

/** Parses a JSON pack of raw shadow files (name → text) into a lookup, local patches included. */
export function shadowLookupFrom(files: Record<string, string>): ShadowLookup {
  const parsed = new Map<string, ShadowInfo>();
  // Local connector additions (shadowPatches.ts) ride on top of the upstream pack.
  const index = new Map(Object.entries(withShadowPatches(files)));
  return (file) => {
    const n = file.toLowerCase().replace(/\\/g, '/');
    let info = parsed.get(n);
    if (info) return info;
    const text = index.get(n);
    if (text === undefined) return null;
    info = parseShadow(text);
    parsed.set(n, info);
    return info;
  };
}
