import type { Box } from '../ldraw/flatten';
import type { Mat3, Vec3 } from '../ldraw/parse';
import { ensureIds } from '../plan/ids';
import { gridToPlacement } from '../plan/placement';
import type { Plan, PlanItem, Rot, Step } from '../plan/types';
import { BUILDING_PRIORS } from '../data/buildingPriors.generated';
import { brickify, type Built, type Fixture } from './brickify';
import { MIN_LEARNED, weighted, type BuildingPriors, type PriorScheme } from './priors';
import { Voxels } from './voxels';

/**
 * Town buildings from a seed. A building is a set of volumes (a main block, its wings, a
 * corner tower, a set-back upper part, the houses of a row), each a union of rectangles
 * with its own floors, colours and roof. Storeys are cut through all of them at once: the
 * outline of what stands at each storey gets walls with real windows and doors, a floor
 * slab goes on top, and each volume group gets its roof where it ends: stepped gable,
 * stepped hip, 45° slopes with a ridge, or flat with a parapet. Brickify lays the bricks
 * around the windows, doors and slopes and checks that everything holds together.
 */

// ---------- parts ----------

/**
 * Window and door assemblies: the frame on the stud grid, the glass or door inside it.
 * `body` is the frame's measured box (LDU, y down); `inner` sits at `offset` in the frame's
 * own frame (the door hangs on the frame's hinge pin, the 1×4×3 pane on its top hinge).
 */
export const FIXTURE_PARTS = {
  window2x2: { frame: '60592', inner: '60601', w: 2, h: 6, body: { min: [-20, 0, -10], max: [20, 48, 10] }, offset: [0, 0, 0] },
  window2x3: { frame: '60593', inner: '60602', w: 2, h: 9, body: { min: [-20, 0, -10], max: [20, 72, 10] }, offset: [0, 0, 0] },
  window4x3: { frame: '60594', inner: '60603', w: 4, h: 9, body: { min: [-40, -4, -10], max: [40, 72, 10] }, offset: [0, 8, 5] },
  door: { frame: '60596', inner: '60623', w: 4, h: 18, body: { min: [-40, -4, -10], max: [40, 144, 10] }, offset: [-32, 0, 5] },
} satisfies Record<string, { frame: string; inner: string; w: number; h: number; body: Box; offset: Vec3 }>;
export type WindowKind = 'window2x2' | 'window2x3' | 'window4x3';

/** 45° slopes by width (2 deep, falling towards −z at rot 0) and double-sided ridge pieces. */
export const SLOPES: Record<number, string> = { 8: '4445', 4: '3037', 2: '3039', 1: '3040b' };
export const RIDGES: Record<number, string> = { 4: '3041', 2: '3043', 1: '3044b' };

const GLASS = 47; // trans-clear
const BASE = 72; // dark bluish grey

// ---------- spec ----------

export type Scheme = { wall: number; stripe: number | null; roof: number; frame: number; door: number; trim: number };
const SCHEMES: Scheme[] = [
  { wall: 1, stripe: 15, roof: 4, frame: 15, door: 4, trim: 15 },
  { wall: 4, stripe: null, roof: 0, frame: 15, door: 1, trim: 15 },
  { wall: 14, stripe: null, roof: 4, frame: 1, door: 1, trim: 15 },
  { wall: 15, stripe: 4, roof: 72, frame: 4, door: 4, trim: 4 },
  { wall: 19, stripe: null, roof: 70, frame: 15, door: 70, trim: 15 },
  { wall: 71, stripe: 72, roof: 0, frame: 14, door: 14, trim: 72 },
  { wall: 2, stripe: 15, roof: 15, frame: 15, door: 4, trim: 15 },
  { wall: 15, stripe: 1, roof: 1, frame: 1, door: 1, trim: 1 },
  { wall: 70, stripe: null, roof: 72, frame: 15, door: 15, trim: 19 },
  { wall: 15, stripe: null, roof: 4, frame: 0, door: 0, trim: 72 },
  { wall: 25, stripe: null, roof: 70, frame: 15, door: 15, trim: 15 },
  { wall: 72, stripe: 71, roof: 0, frame: 4, door: 4, trim: 4 },
];

export type RoofStyle = 'gable' | 'hip' | 'slope' | 'flat';
export type BuildingKind = 'house' | 'shop' | 'tower' | 'manor' | 'block';
export type Shape = 'rect' | 'L' | 'T' | 'U';
export type Rect = { x: number; z: number; w: number; d: number };

export type Volume = {
  name: string;
  rects: Rect[];
  floors: number;
  scheme: Scheme;
  roof: RoofStyle;
  windows: { ground: WindowKind; upper: WindowKind };
  /** a front door on its ground floor */
  door: boolean;
  /** volumes of one group share one roof (the wings of an L) */
  group: number;
};

export type BuildingSpec = {
  seed: number;
  kind: BuildingKind;
  shape: Shape;
  /** overall size in studs, after the volumes are laid out */
  width: number;
  depth: number;
  floors: number;
  roof: RoofStyle;
  volumes: Volume[];
  /** one line saying what it is */
  label: string;
};

export type SpecOverrides = Partial<{ kind: BuildingKind; shape: Shape; width: number; depth: number; floors: number; roof: RoofStyle }>;

/** A small fast PRNG (mulberry32): the same seed, the same building. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rectangles of a footprint shape inside W×D, front (z = 0) along x; every arm at least 4 studs. */
function shapeRects(shape: Shape, W: number, D: number, r: () => number): Rect[] {
  const span = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  if (shape === 'rect' || W < 8 || D < 8) return [{ x: 0, z: 0, w: W, d: D }];
  const front = span(4, D - 4);
  if (shape === 'L') {
    const wing = span(4, W - 4);
    const left = r() < 0.5;
    return [{ x: 0, z: 0, w: W, d: front }, { x: left ? 0 : W - wing, z: front, w: wing, d: D - front }];
  }
  if (shape === 'T') {
    const wing = span(4, Math.max(4, W - 4));
    return [{ x: 0, z: 0, w: W, d: front }, { x: Math.floor((W - wing) / 2), z: front, w: wing, d: D - front }];
  }
  // U: two back wings with a courtyard between them (at least 2 studs)
  const wing = span(4, Math.max(4, Math.floor((W - 2) / 2)));
  return [{ x: 0, z: 0, w: W, d: front }, { x: 0, z: front, w: wing, d: D - front }, { x: W - wing, z: front, w: wing, d: D - front }];
}

/** What a seed builds. Anything in `over` is kept; the rest comes from the seed. */
/** A learned colour combination as a full scheme: roles real sets left open get sensible fills. */
function learnedScheme(p: PriorScheme, striped: boolean): Scheme {
  const frame = p.frame ?? 15;
  return {
    wall: p.wall,
    stripe: striped ? p.stripe : null,
    roof: p.roof ?? 72,
    frame,
    door: p.door ?? frame,
    trim: p.trim ?? p.stripe ?? p.wall,
  };
}

/**
 * What a seed builds. Anything in `over` is kept; the rest comes from the seed, drawn
 * from what real sets do (`priors`, learned from the OMR) once enough buildings have been
 * learned, else from the hand-made tables.
 */
export function buildingSpec(seed: number, over: SpecOverrides = {}, priors: BuildingPriors = BUILDING_PRIORS): BuildingSpec {
  const r = random(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const learned = priors.buildings >= MIN_LEARNED;
  const kind = over.kind ?? pick(['house', 'house', 'shop', 'tower', 'manor', 'block'] as const);
  const schemePick = (): Scheme => (learned ? learnedScheme(weighted(priors.schemes, (s) => s.weight, r()), r() < 0.4) : pick(SCHEMES));
  const scheme = schemePick();
  const slopedShare = priors.roof.sloped / Math.max(1, priors.roof.sloped + priors.roof.flat);
  const roofPick = (): RoofStyle => (learned
    ? (r() < slopedShare ? pick(['gable', 'hip', 'slope', 'slope'] as const) : 'flat')
    : pick(['gable', 'gable', 'hip', 'slope', 'slope', 'flat'] as const));
  const roof = over.roof ?? roofPick();
  const windowKinds = Object.entries(priors.windows) as [WindowKind, number][];
  const win = (): WindowKind => (learned && windowKinds.length
    ? weighted(windowKinds, ([, n]) => n, r())[0]
    : pick(['window2x2', 'window2x3', 'window2x3', 'window4x3'] as const));
  // floors as real buildings have them (the generator builds up to 3, towers rise above)
  const floorTable = Object.entries(priors.floors).map(([f, n]) => [Math.min(3, Number(f)), n] as const);
  const floorPick = (fallback: readonly number[]) => (learned && floorTable.length ? weighted(floorTable, ([, n]) => n, r())[0] : pick(fallback));
  const volumes: Volume[] = [];
  let shape: Shape = over.shape ?? 'rect';

  if (kind === 'block') {
    // a row of 2–4 houses, fronts in line, each its own height, colours and roof
    let n = 2 + Math.floor(r() * 3);
    if (over.width) n = Math.max(1, Math.min(n, Math.floor(over.width / 6)));
    let x = 0;
    for (let i = 0; i < n; i++) {
      const w = over.width ? Math.max(6, Math.floor(over.width / n)) : pick([6, 8, 8, 10]);
      const d = over.depth ?? pick([6, 8, 10]);
      volumes.push({
        name: `house ${i + 1}`, rects: [{ x, z: 0, w, d }], floors: over.floors ?? floorPick([1, 2, 2, 3]),
        scheme: i === 0 ? scheme : schemePick(), roof: over.roof ?? (learned ? roofPick() : pick(['gable', 'gable', 'slope', 'flat'] as const)),
        windows: { ground: 'window2x3', upper: pick(['window2x2', 'window2x3'] as const) }, door: true, group: i,
      });
      x += w;
    }
  } else {
    const W = over.width ?? pick(kind === 'shop' ? [12, 14, 16] : [10, 12, 14, 16]);
    const D = over.depth ?? pick([8, 10, 12]);
    const floors = over.floors ?? (kind === 'shop' ? pick([1, 2]) : kind === 'manor' ? pick([2, 3]) : floorPick([1, 2, 2, 3]));
    if (!over.shape) shape = kind === 'shop' ? pick(['rect', 'L'] as const) : pick(['rect', 'rect', 'L', 'T', 'U'] as const);
    const rects = shapeRects(shape, W, D, r);
    if (rects.length === 1) shape = 'rect';
    const ground: WindowKind = kind === 'shop' ? 'window4x3' : win();
    const main: Volume = { name: 'main', rects, floors, scheme, roof, windows: { ground, upper: win() }, door: true, group: 0 };

    if (kind === 'manor' && floors >= 2 && rects.length === 1 && D >= 10) {
      // the ground floor runs out in front; the floors above step back behind a terrace
      const back = 2;
      volumes.push({ ...main, name: 'terrace', floors: 1, roof: 'flat', group: 1 });
      volumes.push({ ...main, name: 'upper', rects: [{ x: 0, z: back, w: W, d: D - back }], door: false, group: 0 });
    } else {
      volumes.push(main);
    }
    const sizes = [4, 6].filter((v) => v <= Math.min(W, D) - 2);
    if (kind === 'tower' && sizes.length) {
      // a square tower on a front corner, rising one or two floors above the rest
      const s = pick(sizes);
      const left = r() < 0.5;
      volumes.push({
        name: 'tower', rects: [{ x: left ? 0 : W - s, z: 0, w: s, d: s }], floors: floors + 1 + Math.floor(r() * 2),
        scheme: r() < 0.5 ? scheme : { ...schemePick(), roof: scheme.roof }, roof: pick(['hip', 'slope', 'flat'] as const),
        windows: { ground: 'window2x2', upper: 'window2x2' }, door: false, group: 9,
      });
    }
  }

  const all = volumes.flatMap((v) => v.rects);
  const width = Math.max(...all.map((q) => q.x + q.w));
  const depth = Math.max(...all.map((q) => q.z + q.d));
  const floors = Math.max(...volumes.map((v) => v.floors));
  const shapeName = { rect: '', L: 'L-shaped ', T: 'T-shaped ', U: 'U-shaped ' }[shape];
  const roofName = { gable: 'stepped gable roof', hip: 'stepped hip roof', slope: 'sloped roof', flat: 'flat roof' }[roof];
  const label = kind === 'block'
    ? `Town block of ${volumes.length} houses`
    : `${shapeName}${kind === 'tower' ? 'house with a tower' : kind === 'manor' ? 'manor with a terrace' : kind}, ${roofName}`;
  return { seed, kind, shape, width, depth, floors, roof, volumes, label: label[0].toUpperCase() + label.slice(1) };
}

// ---------- footprints ----------

class Mask {
  readonly on: Uint8Array;
  constructor(readonly w: number, readonly d: number, on?: Uint8Array) {
    this.on = on ?? new Uint8Array(w * d);
  }
  has(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.w && z < this.d && this.on[x + this.w * z] === 1;
  }
  set(x: number, z: number, v = true): void {
    this.on[x + this.w * z] = v ? 1 : 0;
  }
  forEach(f: (x: number, z: number) => void): void {
    for (let z = 0; z < this.d; z++) for (let x = 0; x < this.w; x++) if (this.on[x + this.w * z]) f(x, z);
  }
  empty(): boolean {
    return !this.on.includes(1);
  }
  /** Cells whose square (or, with `alongZ`, column) neighbourhood of radius n lies inside. */
  eroded(n: number, alongZ = false): Mask {
    const out = new Mask(this.w, this.d);
    this.forEach((x, z) => {
      for (let dz = -n; dz <= n; dz++) for (let dx = alongZ ? 0 : -n; dx <= (alongZ ? 0 : n); dx++) if (!this.has(x + dx, z + dz)) return;
      out.set(x, z);
    });
    return out;
  }
  minus(o: Mask): Mask {
    const out = new Mask(this.w, this.d);
    this.forEach((x, z) => { if (!o.has(x, z)) out.set(x, z); });
    return out;
  }
}

// ---------- fixtures ----------

const mul = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/** Which way a wall faces: the frame turn that puts the glass outside, and the axis it runs along. */
const DIRS = [
  { dx: 0, dz: -1, rot: 0 as Rot, along: 'x' as const }, // front
  { dx: 0, dz: 1, rot: 180 as Rot, along: 'x' as const }, // back
  { dx: -1, dz: 0, rot: 90 as Rot, along: 'z' as const }, // left
  { dx: 1, dz: 0, rot: 270 as Rot, along: 'z' as const }, // right
];

/** A window or door whose first cell is (x, z) at plate y, in the wall facing `rot`. */
export function opening(kind: keyof typeof FIXTURE_PARTS, along: 'x' | 'z', rot: Rot, x: number, z: number, y: number, frameColor: number, innerColor: number): Fixture {
  const f = FIXTURE_PARTS[kind];
  const at = gridToPlacement({ x, y, z, rot }, f.body);
  const off = mul(at.m, f.offset as Vec3);
  return {
    x, y, z, w: along === 'x' ? f.w : 1, d: along === 'x' ? 1 : f.w, h: f.h,
    // both as exact placements, like a window in an LDraw file: the editor checks them
    // against the bricks, and leaves the glass seated in its frame's groove alone
    items: [
      { part: f.frame, color: frameColor, ldu: at.pos, matrix: at.m },
      { part: f.inner, color: innerColor, ldu: [at.pos[0] + off[0], at.pos[1] + off[1], at.pos[2] + off[2]], matrix: at.m },
    ],
  };
}

/** A 2-deep slope or ridge piece `w` studs wide along x, first cell (x, z), at plate y. */
function roofPiece(part: string, w: number, x: number, z: number, y: number, rot: Rot, color: number): Fixture {
  return { x, y, z, w, d: 2, h: 3, items: [{ part, color, x, y, z, rot }] };
}

/** Split a run of `n` studs into the widest pieces a table has (8, 4, 2, 1). */
function widths(n: number, table: Record<number, string>): number[] {
  const sizes = Object.keys(table).map(Number).sort((a, b) => b - a);
  const out: number[] = [];
  for (const s of sizes) while (n >= s) { out.push(s); n -= s; }
  return out;
}

/** Starts (along a run of `length`) of `width`-wide openings: 2 apart, centred, a stud of wall at each end. */
export function slots(length: number, width: number): number[] {
  const gap = 2;
  const room = length - 2;
  const n = Math.floor((room - 2 + gap) / (width + gap));
  if (n <= 0) return [];
  const used = n * width + (n - 1) * gap;
  const first = 1 + Math.floor((room - used) / 2);
  return Array.from({ length: n }, (_, i) => first + i * (width + gap));
}

// ---------- generation ----------

export type GeneratedBuilding = { spec: BuildingSpec; plan: Plan; built: Built };

const GROUND = 18; // plates: tall enough for the 1×4×6 door
const UPPER = 12;

export function generateBuilding(specOrSeed: BuildingSpec | number): GeneratedBuilding {
  const spec = typeof specOrSeed === 'number' ? buildingSpec(specOrSeed) : specOrSeed;
  const g = layOut(spec, false);
  // a small building whose wide windows don't fit (short walls, the door's wall), or one
  // whose bricks don't all join up, is laid out again with narrow windows and its doors at
  // one end of their walls
  const windows = g.plan.steps.flatMap((s) => s.pieces).filter((p) => 'part' in p && WINDOW_FRAMES.has(p.part)).length;
  if (windows >= 2 && g.built.components === 1) return g;
  const again = layOut(spec, true);
  return again.built.components === 1 ? again : g;
}

const WINDOW_FRAMES = new Set(['60592', '60593', '60594']);

function layOut(spec: BuildingSpec, narrow: boolean): GeneratedBuilding {
  const { width: W, depth: D } = spec;

  // who owns each cell: the last volume listed that covers it
  const owner = new Int32Array(W * D).fill(-1);
  spec.volumes.forEach((v, i) => {
    for (const q of v.rects) for (let z = q.z; z < q.z + q.d; z++) for (let x = q.x; x < q.x + q.w; x++) owner[x + W * z] = i;
  });
  const own = (x: number, z: number) => (x >= 0 && z >= 0 && x < W && z < D ? owner[x + W * z] : -1);
  const vol = (x: number, z: number) => spec.volumes[own(x, z)];

  const floors = spec.floors;
  const storeyY: number[] = [];
  let y = 1; // the base plate is y 0
  for (let f = 0; f < floors; f++) {
    storeyY.push(y);
    y += (f === 0 ? GROUND : UPPER) + 1;
  }
  const height = (f: number) => (f === 0 ? GROUND : UPPER);
  const H = y + (Math.ceil(Math.max(W, D) / 2) + 2) * 3;

  // what stands at storey f
  const standing = (f: number) => {
    const m = new Mask(W, D);
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (own(x, z) >= 0 && vol(x, z).floors > f) m.set(x, z);
    return m;
  };

  const cells = new Voxels(W, D, H);
  const fixtures: Fixture[] = [];
  const steps: { title: string; from: number; to: number }[] = [{ title: 'Base', from: 0, to: 1 }];

  // base plate
  standing(0).forEach((x, z) => cells.set(x, 0, z, BASE));

  for (let f = 0; f < floors; f++) {
    const m = standing(f);
    const y0 = storeyY[f];
    const h = height(f);
    // walls: every cell with an outside neighbour, corners included (8-neighbourhood)
    const wall = (x: number, z: number) => {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!m.has(x + dx, z + dz)) return true;
      return false;
    };
    m.forEach((x, z) => {
      if (!wall(x, z)) return;
      const s = vol(x, z).scheme;
      for (let yy = y0; yy < y0 + h; yy++) {
        const course = Math.floor((yy - y0) / 3);
        cells.set(x, yy, z, s.stripe !== null && course % 2 === 1 ? s.stripe : s.wall);
      }
    });

    // openings, run by run: a run is a straight stretch of wall facing one way, owned by one volume
    type Run = { dir: (typeof DIRS)[number]; line: number; start: number; len: number; owner: number };
    const runs: Run[] = [];
    for (const dir of DIRS) {
      const lines = new Map<number, number[]>();
      m.forEach((x, z) => {
        if (m.has(x + dir.dx, z + dir.dz)) return;
        const key = dir.along === 'x' ? z : x;
        (lines.get(key) ?? lines.set(key, []).get(key)!).push(dir.along === 'x' ? x : z);
      });
      for (const [line, ats] of lines) {
        ats.sort((a, b) => a - b);
        const cell = (t: number) => (dir.along === 'x' ? own(t, line) : own(line, t));
        for (const a of ats) {
          const last = runs[runs.length - 1];
          if (last && last.dir === dir && last.line === line && last.start + last.len === a && cell(a) === last.owner) last.len++;
          else runs.push({ dir, line, start: a, len: 1, owner: cell(a) });
        }
      }
    }
    const cellOf = (r: Run, t: number) => (r.dir.along === 'x' ? [r.start + t, r.line] : [r.line, r.start + t]) as [number, number];

    // doors (ground floor): each volume that wants one gets it on its longest front run;
    // if none fits anywhere, the building still gets one on its longest outside wall
    const doors = new Map<Run, number>();
    if (f === 0) {
      const longest = (rs: Run[]) => rs.filter((r) => r.len >= 6).sort((a, b) => b.len - a.len)[0];
      spec.volumes.forEach((v, i) => {
        if (!v.door) return;
        const r = longest(runs.filter((q) => q.owner === i && q.dir.rot === 0));
        if (r) doors.set(r, narrow ? 1 : Math.floor((r.len - 4) / 2));
      });
      if (!doors.size) {
        const r = longest(runs.filter((q) => q.dir.rot === 0)) ?? longest(runs);
        if (r) doors.set(r, narrow ? 1 : Math.floor((r.len - 4) / 2));
      }
    }

    for (const r of runs) {
      const v = spec.volumes[r.owner];
      let kind: WindowKind = f === 0 ? v.windows.ground : v.windows.upper;
      // a wall too short for a wide window gets the narrow one of the same height
      if (kind === 'window4x3' && (narrow || !slots(r.len, 4).length)) kind = 'window2x3';
      const ww = FIXTURE_PARTS[kind].w;
      const d0 = doors.get(r);
      if (d0 !== undefined) fixtures.push(opening('door', r.dir.along, r.dir.rot, ...cellOf(r, d0), y0, v.scheme.door, v.scheme.door));
      for (const s of slots(r.len, ww)) {
        if (d0 !== undefined && s < d0 + 5 && s + ww > d0 - 1) continue; // a stud of wall beside the door
        const sill = f === 0 ? y0 + 6 : y0 + 3;
        fixtures.push(opening(kind, r.dir.along, r.dir.rot, ...cellOf(r, s), sill, v.scheme.frame, GLASS));
      }
    }

    // the floor above, in the trim colour
    m.forEach((x, z) => cells.set(x, y0 + h, z, vol(x, z).scheme.trim));
    steps.push({ title: `Floor ${f + 1}: walls`, from: y0, to: y0 + h }, { title: `Floor ${f + 1}: ceiling`, from: y0 + h, to: y0 + h + 1 });
  }

  // clear what the windows and doors take
  const clear = (fx: Fixture) => {
    for (let yy = fx.y; yy < fx.y + fx.h; yy++) for (let z = fx.z; z < fx.z + fx.d; z++) for (let x = fx.x; x < fx.x + fx.w; x++) cells.set(x, yy, z, -1);
  };
  fixtures.forEach(clear);

  // roofs: one per group, on the slab of its top storey
  const groups = [...new Set(spec.volumes.map((v) => v.group))];
  let roofTop = 0;
  for (const g of groups) {
    const members = spec.volumes.filter((v) => v.group === g);
    const top = members[0].floors - 1;
    const region = new Mask(W, D);
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (own(x, z) >= 0 && vol(x, z).group === g) region.set(x, z);
    if (region.empty()) continue;
    const y0 = storeyY[top] + height(top) + 1;
    const outer = standing(top);
    const style = members[0].roof;
    const color = (x: number, z: number) => vol(x, z).scheme.roof;
    const thin = region.eroded(2).empty();
    if (style === 'flat' || thin) {
      // parapet on the outside edge: a brick course in the trim colour, leaving the roof open
      region.forEach((x, z) => {
        let edge = false;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!outer.has(x + dx, z + dz)) edge = true;
        if (edge) for (let yy = y0; yy < y0 + 3; yy++) cells.set(x, yy, z, vol(x, z).scheme.trim);
      });
      roofTop = Math.max(roofTop, y0 + 3);
      continue;
    }
    for (let k = 0; ; k++) {
      const E = style === 'hip' ? region.eroded(k) : region.eroded(k, true);
      if (E.empty()) break;
      const inner = E.eroded(2);
      // stepped roofs stop when no 5×5 core is left; sloped ones go on until the top is
      // two deep, so a ridge can cap two slopes
      const last = style === 'slope' ? E.eroded(1, true).empty() : inner.empty();
      const band = last ? E : E.minus(inner);
      const yk = y0 + 3 * k;
      const taken = new Mask(W, D);
      if (style === 'slope') {
        // front and back rows of the band become slopes; on the top course a 2-deep ridge
        for (const [dz, rot] of [[-1, 0], [1, 180]] as const) {
          const rows = new Map<number, number[]>();
          E.forEach((x, z) => {
            if (E.has(x, z + dz)) return; // not an outside row
            const zi = z - dz; // the cell behind it
            if (!E.has(x, zi) || taken.has(x, z) || taken.has(x, zi)) return;
            const depth = (() => { let n = 0; while (E.has(x, z - dz * n)) n++; return n; })();
            if (depth === 2 && last) return; // ridge below
            const z0 = Math.min(z, zi);
            (rows.get(z0) ?? rows.set(z0, []).get(z0)!).push(x);
          });
          for (const [z0, xs] of rows) {
            xs.sort((a, b) => a - b);
            let i = 0;
            while (i < xs.length) {
              let j = i;
              while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1 && color(xs[j + 1], z0) === color(xs[i], z0)) j++;
              let x = xs[i];
              for (const wv of widths(j - i + 1, SLOPES)) {
                fixtures.push(roofPiece(SLOPES[wv], wv, x, z0, yk, rot, color(x, z0)));
                for (let t = 0; t < wv; t++) { taken.set(x + t, z0); taken.set(x + t, z0 + 1); }
                x += wv;
              }
              i = j + 1;
            }
          }
        }
        if (last) {
          // ridge where the top is exactly two deep
          const rows = new Map<number, number[]>();
          E.forEach((x, z) => {
            if (taken.has(x, z) || E.has(x, z - 1) || !E.has(x, z + 1) || E.has(x, z + 2)) return;
            (rows.get(z) ?? rows.set(z, []).get(z)!).push(x);
          });
          for (const [z0, xs] of rows) {
            xs.sort((a, b) => a - b);
            let i = 0;
            while (i < xs.length) {
              let j = i;
              while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
              let x = xs[i];
              for (const wv of widths(j - i + 1, RIDGES)) {
                fixtures.push(roofPiece(RIDGES[wv], wv, x, z0, yk, 0, color(x, z0)));
                for (let t = 0; t < wv; t++) { taken.set(x + t, z0); taken.set(x + t, z0 + 1); }
                x += wv;
              }
              i = j + 1;
            }
          }
        }
      }
      band.forEach((x, z) => {
        if (taken.has(x, z)) return;
        for (let yy = yk; yy < yk + 3; yy++) cells.set(x, yy, z, color(x, z));
      });
      roofTop = Math.max(roofTop, yk + 3);
      if (last) break;
    }
  }
  fixtures.forEach(clear);
  const lastWalls = steps[steps.length - 1].to;
  steps.push({ title: 'Roof', from: lastWalls, to: Math.max(roofTop, lastWalls + 1) });

  const built = brickify(cells, { fixtures });

  // steps: each piece goes in the band where it starts; roofs on lower volumes join the
  // storey they sit beside, so the build goes up in order
  const fixtureY = new Map<PlanItem, number>();
  for (const fx of fixtures) for (const it of fx.items) fixtureY.set(it, fx.y);
  const bandOf = (yy: number) => {
    const i = steps.findIndex((s) => yy >= s.from && yy < s.to);
    return i >= 0 ? i : steps.length - 1;
  };
  const byBand: PlanItem[][] = steps.map(() => []);
  for (const it of built.items) {
    const yy = fixtureY.get(it) ?? ('y' in it ? it.y : 0);
    byBand[bandOf(yy)].push(it);
  }
  const planSteps: Step[] = steps.map((s, i) => ({ title: s.title, pieces: byBand[i] })).filter((s) => s.pieces.length > 0);
  const plan = ensureIds({
    format: 'brickmotion-plan', version: 1,
    name: `${spec.label} #${spec.seed}`,
    description: `${spec.label}: ${spec.floors} ${spec.floors === 1 ? 'floor' : 'floors'}, ${W}×${D} studs, generated from seed ${spec.seed}.`,
    steps: planSteps,
  });
  return { spec, plan, built };
}
