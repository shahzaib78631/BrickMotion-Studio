import { ensureIds } from '../plan/ids';
import { rotMatrix } from '../plan/placement';
import type { Plan, PlanItem, Rot, Step } from '../plan/types';
import { brickify, type Built, type Fixture } from './brickify';
import { opening, random, slots } from './building';
import { Voxels } from './voxels';

/**
 * Castles from a seed, on real baseplates. Outside: a moat round the castle's island, a
 * bridge on an abutment, a winding path and woods of oaks, pines, bushes, rocks and
 * flowers. The island carries a stone plinth, crenellated curtain walls with arrow slits
 * and wall walks, a tower on each corner (with doors, a floor at the walk and battlements
 * or a stepped roof), a gatehouse with a real door and an arch behind it, and a keep of
 * one to three storeys against the back wall, each storey a furnished room: a great hall
 * (carpet, throne, tables with benches and food, fireplace), royal chambers (bed,
 * wardrobe, bookshelf, chest, rug, candle table), a treasury and armoury (weapon racks,
 * chests, gold). Stairs join the storeys and climb from the courtyard to the wall walk;
 * the courtyard has a well, a market stall, a forge, a training dummy, barrels, crates
 * and hay. The keep is open at the back, like a play set, so its rooms can be seen.
 *
 * Like the buildings, it is sketched as coloured cells and laid in real bricks by
 * brickify around set pieces (baseplates, the door, arches, barrels, cones).
 */

export type TowerTop = 'battlements' | 'roof';
export type Stone = 'light' | 'dark' | 'sand';
export type CastleOverrides = Partial<{
  width: number;
  depth: number;
  keepFloors: number;
  towerTop: TowerTop;
  moat: boolean;
  openBack: boolean;
  stone: Stone;
}>;

type Rect = { x: number; z: number; w: number; d: number };

export type CastleSpec = {
  seed: number;
  /** the baseplate, in studs (multiples of 16) */
  width: number;
  depth: number;
  keepFloors: number;
  towerTop: TowerTop;
  moat: boolean;
  /** the keep's back wall left off, so its rooms show */
  openBack: boolean;
  stone: Stone;
  colours: { wall: number; base: number; yard: number; hall: number; roof: number };
  /** woods round the edge, then the moat, then the island the castle stands on */
  margin: number;
  moatWidth: number;
  island: Rect;
  wallThickness: number;
  /** plates from the courtyard to the wall walk */
  wallHeight: number;
  tower: number;
  keep: Rect;
  gate: Rect & { passage: number; height: number };
  rooms: string[];
  label: string;
};

/** Baseplate sizes the generator lays (a side is built from 32s and 16s, or one 48×48). */
export const CASTLE_SIZES = [32, 48, 64, 80, 96] as const;

const STONES: Record<Stone, { wall: number; base: number; yard: number; hall: number }> = {
  light: { wall: 71, base: 72, yard: 28, hall: 72 },
  dark: { wall: 72, base: 0, yard: 28, hall: 71 },
  sand: { wall: 19, base: 28, yard: 72, hall: 72 },
};
const ROOFS = [320, 272, 288, 4, 1]; // dark red, dark blue, dark green, red, blue
const GRASS = 2;
const WOOD = 70; // reddish brown
const DARK_WOOD = 308;
const WATER = 33; // trans dark blue
const PATH = 19; // tan
const FIRE = 57; // trans orange
const GOLD = 297;
const WHITE = 15;
const LEAVES = [2, 2, 288, 10];
const FLOWERS = [4, 14, 15, 13, 25];
const BOOKS = [4, 1, 2, 14, 15, 320, 272, 288];

const FLOOR = 4; // the courtyard: on the baseplate (y 0) and a 3-plate plinth
const STOREY = 16; // 13 plates of wall, a plate of string course, a floor two plates thick

const ROOM_NAMES = ['great hall', 'royal chambers', 'treasury and armoury'];
const STOREY_NAMES = ['ground floor', 'first floor', 'second floor'];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const side16 = (v: number) => clamp(Math.round(v / 16) * 16, 32, 96);

/** What a seed builds. Anything in `over` is kept; the rest comes from the seed. */
export function castleSpec(seed: number, over: CastleOverrides = {}): CastleSpec {
  const r = random(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const width = side16(over.width ?? pick([32, 48, 48, 64]));
  const depth = side16(over.depth ?? width);
  const stone = over.stone ?? pick(['light', 'light', 'dark', 'sand'] as const);
  const roof = pick(ROOFS);
  const keepFloors = clamp(Math.round(over.keepFloors ?? pick([2, 2, 3])), 1, 3);
  const towerTop = over.towerTop ?? pick(['battlements', 'roof', 'roof'] as const);
  const moat = over.moat ?? r() < 0.8;
  const openBack = over.openBack ?? true;

  const m = Math.min(width, depth);
  const margin = clamp(Math.round(m * 0.1), 3, 10);
  const moatWidth = moat ? (m >= 48 ? 3 : 2) : 0;
  const edge = margin + moatWidth;
  const island = { x: edge, z: edge, w: width - 2 * edge, d: depth - 2 * edge };
  const im = Math.min(island.w, island.d);
  const wallThickness = im >= 30 ? 3 : 2;
  const wallHeight = im >= 30 ? 15 : 12;
  const tower = im >= 28 ? 6 : 4;
  // the keep: between the back towers, against the back; the courtyard keeps at least 8 deep
  const room = island.d - tower - wallThickness - 2 - 8;
  const kd = clamp(Math.round(island.d * 0.35), openBack ? 6 : 7, Math.max(openBack ? 6 : 7, Math.min(14, room)));
  const keep = { x: island.x + tower, z: island.z + island.d - kd, w: island.w - 2 * tower, d: kd };
  const passage = island.x + Math.floor((island.w - 4) / 2);
  const gate = { x: passage - 2, z: island.z, w: 8, d: wallThickness + 2, passage, height: Math.max(wallHeight + 9, 27) };

  const rooms = ROOM_NAMES.slice(0, keepFloors);
  const label = `Castle with four towers, a gatehouse and a ${keepFloors}-storey keep${moat ? ', moat' : ''}`;
  return {
    seed, width, depth, keepFloors, towerTop, moat, openBack, stone,
    colours: { ...STONES[stone], roof },
    margin, moatWidth, island, wallThickness, wallHeight, tower, keep, gate, rooms, label,
  };
}

// ---------- build steps ----------

const TAG = { base: 1, ground: 2, island: 3, wall: 4, gate: 5, keepTop: 6, top: 7, roof: 8, court: 9, nature: 10 } as const;
const keepTag = (storey: number, part: 0 | 1 | 2) => 16 + storey * 3 + part;

/** Free cells of one level (a storey's floor, the courtyard, the woods) for furniture and trees. */
class Space {
  readonly free: Uint8Array;
  constructor(readonly w: number, readonly d: number) {
    this.free = new Uint8Array(w * d);
  }
  open(x: number, z: number, w = 1, d = 1): void {
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && zz >= 0 && xx < this.w && zz < this.d) this.free[xx + this.w * zz] = 1;
  }
  take(x: number, z: number, w = 1, d = 1): void {
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && zz >= 0 && xx < this.w && zz < this.d) this.free[xx + this.w * zz] = 0;
  }
  isFree(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.w && z < this.d && this.free[x + this.w * z] === 1;
  }
  fits(x: number, z: number, w: number, d: number, margin = 0): boolean {
    for (let zz = z - margin; zz < z + d + margin; zz++) for (let xx = x - margin; xx < x + w + margin; xx++) if (!this.isFree(xx, zz)) return false;
    return true;
  }
  /** A random spot where a w×d thing fits (with `margin` free all round), or null. */
  find(r: () => number, w: number, d: number, margin = 0, tries = 60): { x: number; z: number } | null {
    for (let i = 0; i < tries; i++) {
      const x = Math.floor(r() * (this.w - w + 1));
      const z = Math.floor(r() * (this.d - d + 1));
      if (this.fits(x, z, w, d, margin)) return { x, z };
    }
    return null;
  }
}

export type GeneratedCastle = { spec: CastleSpec; plan: Plan; built: Built };

export function generateCastle(specOrSeed: CastleSpec | number): GeneratedCastle {
  const spec = typeof specOrSeed === 'number' ? castleSpec(specOrSeed) : specOrSeed;
  const r = random(spec.seed ^ 0x5bd1e995);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const { width: W, depth: D, island: I, tower: s, wallThickness: T, wallHeight, keep: K, gate: G, colours: C, keepFloors: KF } = spec;
  const mw = spec.moatWidth;
  const walkY = FLOOR + wallHeight;
  const towerTopY = walkY + 12; // a storey above the walk, with a lintel over its doors
  const keepTopY = FLOOR + STOREY * KF;
  const H = Math.max(keepTopY + 9 + 9 + 6, towerTopY + 9 + 6, FLOOR + G.height + 6, 32) + 2;

  const v = new Voxels(W, D, H);
  const tags = new Uint8Array(W * D * H);
  const at = (x: number, y: number, z: number) => x + W * (z + D * y);
  let tag: number = TAG.base;
  const put = (x: number, y: number, z: number, c: number) => {
    if (!v.inside(x, y, z)) return;
    v.set(x, y, z, c);
    tags[at(x, y, z)] = tag;
  };
  const column = (x: number, z: number, y0: number, y1: number, c: number) => { for (let y = y0; y < y1; y++) put(x, y, z, c); };
  const block = (x: number, z: number, w: number, d: number, y0: number, y1: number, c: number) => {
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) column(xx, zz, y0, y1, c);
  };
  const erase = (x: number, z: number, y0: number, y1: number) => { for (let y = y0; y < y1; y++) v.set(x, y, z, -1); };
  const recolour = (x: number, y: number, z: number, c: number) => { if (v.get(x, y, z) >= 0) v.set(x, y, z, c); };

  const fixtures: { f: Fixture; tag: number }[] = [];
  const fix = (f: Fixture) => fixtures.push({ f, tag });
  /** a part on the grid: its rotated footprint w×d and height h fill the cells */
  const part = (id: string, color: number, x: number, y: number, z: number, rot: Rot, w: number, d: number, h: number) =>
    fix({ x, y, z, w, d, h, items: [{ part: id, color, x, y, z, rot }] });

  // ---------- zones ----------
  const inRect = (q: Rect, x: number, z: number) => x >= q.x && x < q.x + q.w && z >= q.z && z < q.z + q.d;
  const towerOf = (x: number, z: number) => {
    const lx = x - I.x, lz = z - I.z;
    const left = lx < s, right = lx >= I.w - s, front = lz < s, back = lz >= I.d - s;
    return (left || right) && (front || back);
  };
  type Zone = 'out' | 'tower' | 'gate' | 'keep' | 'wall' | 'yard';
  const zone = (x: number, z: number): Zone => {
    if (!inRect(I, x, z)) return 'out';
    if (towerOf(x, z)) return 'tower';
    if (inRect(G, x, z)) return 'gate';
    if (inRect(K, x, z)) return 'keep';
    const lx = x - I.x, lz = z - I.z;
    if (lz < T || lx < T || lx >= I.w - T || lz >= I.d - T) return 'wall';
    return 'yard';
  };
  const isKeepWall = (x: number, z: number) => z === K.z || x === K.x || x === K.x + K.w - 1 || (!spec.openBack && z === K.z + K.d - 1);

  // ---------- baseplates ----------
  tag = TAG.base;
  if (W === 48 && D === 48) {
    fix({ x: 0, y: 0, z: 0, w: 48, d: 48, h: 1, items: [{ part: '4186', color: GRASS, ldu: [480, -8, 480], matrix: rotMatrix(0) }] });
  } else {
    for (let bz = 0; bz < D; bz += 32) for (let bx = 0; bx < W; bx += 32) {
      const w = Math.min(32, W - bx), d = Math.min(32, D - bz);
      const [id, rot]: [string, Rot] = w === 32 && d === 32 ? ['3811', 0] : w === 32 ? ['3857', 0] : d === 32 ? ['3857', 90] : ['3867', 0];
      // the baseplate's top is a plate up, where the bricks above start
      fix({ x: bx, y: 0, z: bz, w, d, h: 1, items: [{ part: id, color: GRASS, ldu: [(bx + w / 2) * 20, -8, (bz + d / 2) * 20], matrix: rotMatrix(rot) }] });
    }
  }

  // ---------- the island ----------
  tag = TAG.island;
  for (let z = I.z; z < I.z + I.d; z++) for (let x = I.x; x < I.x + I.w; x++) {
    const zn = zone(x, z);
    put(x, 1, z, C.base);
    put(x, 2, z, C.base);
    put(x, 3, z, zn === 'yard' || zn === 'gate' ? C.yard : zn === 'keep' && !isKeepWall(x, z) ? C.hall : C.base);
  }

  // ---------- moat, bridge, path ----------
  tag = TAG.ground;
  const px = G.passage;
  const pathCells = new Set<number>();
  let pathEnd: number;
  if (mw) {
    for (let z = I.z - mw; z < I.z + I.d + mw; z++) for (let x = I.x - mw; x < I.x + I.w + mw; x++) if (!inRect(I, x, z)) put(x, 1, z, WATER);
    const zb = I.z - mw - 1;
    const len = mw + 2 + (mw % 2); // an even length, so one plate can span it
    for (let x = px; x < px + 4; x++) {
      put(x, 1, zb, C.base);
      put(x, 2, zb, C.base);
      for (let z = zb; z < zb + len; z++) put(x, 3, z, WOOD);
    }
    pathEnd = zb;
  } else {
    for (let x = px; x < px + 4; x++) { put(x, 1, I.z - 1, C.base); put(x, 2, I.z - 1, C.base); put(x, 1, I.z - 2, C.base); }
    pathEnd = I.z - 2;
  }
  let off = 0;
  for (let z = pathEnd - 1; z >= 0; z--) {
    if (pathEnd - z > 2 && r() < 0.3) off = clamp(off + (r() < 0.5 ? -1 : 1), -2, 2);
    for (let x = px + off; x < px + off + 4; x++) {
      put(x, 1, z, PATH);
      for (let dx = -1; dx <= 1; dx++) pathCells.add(x + dx + W * z);
    }
  }

  // ---------- curtain walls ----------
  for (let z = I.z; z < I.z + I.d; z++) for (let x = I.x; x < I.x + I.w; x++) {
    if (zone(x, z) !== 'wall') continue;
    const lx = x - I.x, lz = z - I.z;
    const [outer, t] = lz < T ? [lz === 0, lx] : lx < T ? [lx === 0, lz] : lx >= I.w - T ? [lx === I.w - 1, lz] : [lz === I.d - 1, lx];
    tag = TAG.wall;
    column(x, z, FLOOR, walkY, C.wall);
    if (!outer) continue;
    tag = TAG.top;
    column(x, z, walkY, walkY + 3, C.wall); // parapet
    if (t % 3 !== 2) column(x, z, walkY + 3, walkY + 6, C.wall); // merlons
    if (t % 5 === 2) erase(x, z, FLOOR + 3, FLOOR + 9); // arrow slit
  }

  /** A stepped roof on a square of `n` cells (cell (a, b) at `cell(a, b)`) from plate y, capped with a cone. */
  const roofCap = (cell: (a: number, b: number) => [number, number], n: number, y0: number) => {
    tag = TAG.roof;
    let k = 0;
    for (; ; k++) {
      for (let b = k; b < n - k; b++) for (let a = k; a < n - k; a++) column(...cell(a, b), y0 + 3 * k, y0 + 3 * k + 3, C.roof);
      if (n - 2 * k <= 2) break;
    }
    const cs = [cell(k, k), cell(k + 1, k + 1)];
    const x = Math.min(cs[0][0], cs[1][0]), z = Math.min(cs[0][1], cs[1][1]);
    part('3942c', C.roof, x, y0 + 3 * (k + 1), z, 0, 2, 2, 6);
  };
  /** Battlements on a square: a floor, a parapet round it, merlons on every other cell. */
  const battlements = (cell: (a: number, b: number) => [number, number], n: number, y0: number, t: number) => {
    tag = t;
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const [x, z] = cell(a, b);
      put(x, y0, z, C.wall);
      const ring = a === 0 || b === 0 || a === n - 1 || b === n - 1;
      if (!ring) continue;
      column(x, z, y0 + 1, y0 + 4, C.wall);
      const corner = (a === 0 || a === n - 1) && (b === 0 || b === n - 1);
      if (corner || (a + b) % 2 === 0) column(x, z, y0 + 4, y0 + 7, C.wall);
    }
  };

  // ---------- towers ----------
  for (let c = 0; c < 4; c++) {
    const right = c % 2 === 1, back = c >= 2;
    // (a, b): studs in from the island's side and its front or back edge
    const cell = (a: number, b: number): [number, number] => [right ? I.x + I.w - 1 - a : I.x + a, back ? I.z + I.d - 1 - b : I.z + b];
    for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) {
      const [x, z] = cell(a, b);
      const ring = a === 0 || b === 0 || a === s - 1 || b === s - 1;
      tag = TAG.wall;
      if (ring) {
        column(x, z, FLOOR, walkY, C.wall);
        tag = TAG.top;
        column(x, z, walkY, towerTopY, C.wall);
      }
      // the floor at the wall walk: one plate layer right across, so it locks into the walls
      tag = TAG.wall;
      put(x, walkY - 1, z, C.base);
    }
    const door = s >= 6 ? 2 : 1;
    for (let a = T; a < Math.min(T + door, s - 1); a++) erase(...cell(a, s - 1), FLOOR, FLOOR + 9); // from the courtyard
    for (let a = 1; a < T; a++) erase(...cell(a, s - 1), walkY, walkY + 9); // from the side wall's walk
    if (!back) for (let b = 1; b < T; b++) erase(...cell(s - 1, b), walkY, walkY + 9); // from the front wall's walk
    const mid = Math.floor(s / 2);
    for (const [y0, y1] of [[FLOOR + 4, FLOOR + 9], [walkY + 2, walkY + 6]]) {
      erase(...cell(0, mid), y0, y1);
      erase(...cell(mid, 0), y0, y1);
    }
    if (spec.towerTop === 'battlements') battlements(cell, s, towerTopY, TAG.top);
    else roofCap(cell, s, towerTopY);
  }

  // ---------- gatehouse ----------
  tag = TAG.gate;
  const gateTop = FLOOR + G.height;
  for (let z = G.z; z < G.z + G.d; z++) for (let x = G.x; x < G.x + G.w; x++) {
    const inPassage = x >= px && x < px + 4;
    column(x, z, inPassage ? FLOOR + 18 : FLOOR, gateTop, C.wall);
    const ring = x === G.x || x === G.x + G.w - 1 || z === G.z || z === G.z + G.d - 1;
    if (!ring) continue;
    column(x, z, gateTop, gateTop + 3, C.wall);
    const corner = (x === G.x || x === G.x + G.w - 1) && (z === G.z || z === G.z + G.d - 1);
    if (corner || (x + z) % 2 === 0) column(x, z, gateTop + 3, gateTop + 6, C.wall);
  }
  // banners either side of the gate
  for (const bx of [G.x, G.x + G.w - 2]) for (let x = bx; x < bx + 2; x++) for (let y = gateTop - 12; y < gateTop - 3; y++) recolour(x, y, G.z, C.roof);
  recolour(G.x, gateTop - 8, G.z, GOLD);
  recolour(G.x + G.w - 1, gateTop - 8, G.z, GOLD);
  fix(opening('door', 'x', 0, px, G.z, FLOOR, WOOD, WOOD));
  part('3455', C.base, px - 1, FLOOR + 18, G.z + G.d - 1, 0, 6, 1, 3); // the arch on the courtyard side

  // ---------- keep ----------
  const ix0 = K.x + 1, ix1 = K.x + K.w - 1, iz0 = K.z + 1, iz1 = spec.openBack ? K.z + K.d : K.z + K.d - 1;
  const doorX = K.x + Math.floor(K.w / 2) - 1;
  const sideEnd = I.z + I.d - s; // the keep's sides beyond this stand against the towers
  const floors: Space[] = [];
  for (let k = 0; k < KF; k++) {
    const sp = new Space(W, D);
    sp.open(ix0, iz0, ix1 - ix0, iz1 - iz0);
    floors.push(sp);
  }
  const arch = (x: number, z: number, y: number, alongZ: boolean) => {
    part('3659', C.base, x, y, z, alongZ ? 90 : 0, alongZ ? 1 : 4, alongZ ? 4 : 1, 3);
    // the opening below it: two studs wide
    for (let i = 1; i <= 2; i++) erase(alongZ ? x : x + i, alongZ ? z + i : z, y - 6, y);
  };
  const windowGaps: number[] = [];
  for (let k = 0; k < KF; k++) {
    const y0 = FLOOR + STOREY * k;
    for (let z = K.z; z < K.z + K.d; z++) for (let x = K.x; x < K.x + K.w; x++) {
      const wall = isKeepWall(x, z);
      tag = keepTag(k, 0);
      if (wall) column(x, z, y0, y0 + 13, C.wall);
      // a string course: through the wall, and a ledge inside it that carries the floor
      let ledge = wall;
      for (let dz = -1; dz <= 1 && !ledge; dz++) for (let dx = -1; dx <= 1; dx++) if (inRect(K, x + dx, z + dz) && isKeepWall(x + dx, z + dz)) ledge = true;
      if (ledge) put(x, y0 + 13, z, C.base);
      // the floor above: two crossing layers of plates
      tag = keepTag(k, 2);
      for (const y of [y0 + 14, y0 + 15]) put(x, y, z, wall || k === KF - 1 ? C.wall : WOOD);
    }
    tag = keepTag(k, 0);
    if (k === 0) {
      part('3659', C.base, doorX - 1, y0 + 9, K.z, 0, 4, 1, 3);
      for (let x = doorX; x < doorX + 2; x++) erase(x, K.z, y0, y0 + 9);
      floors[0].take(doorX - 1, iz0, 4, 2); // keep the doorway clear
    }
    const rows: [number, boolean][] = [[K.z, true]];
    if (!spec.openBack) rows.push([K.z + K.d - 1, false]);
    for (const [z, front] of rows) for (const a of slots(K.w, 4)) {
      const x = K.x + a;
      if (k === 0 && front && x + 3 >= doorX - 1 && x <= doorX + 2) continue;
      arch(x, z, y0 + 9, false);
      if (front && k === KF - 1) windowGaps.push(x + 4);
    }
    const sideLen = sideEnd - K.z;
    if (sideLen >= 6) for (const xSide of [K.x, K.x + K.w - 1]) for (const a of slots(sideLen, 4)) arch(xSide, K.z + a, y0 + 9, true);
    // stairs up the right-hand side, a brick a step, through a hole in the floor above
    if (k < KF - 1 && iz1 - iz0 >= 6) {
      tag = keepTag(k, 1);
      const sx = ix1 - 1;
      for (let j = 1; j <= 5; j++) column(sx, iz0 + j - 1, y0, y0 + Math.min(3 * j, 13), C.wall);
      for (let j = 2; j <= 4; j++) for (const y of [y0 + 13, y0 + 14, y0 + 15]) v.set(sx, y, iz0 + j - 1, -1);
      floors[k].take(sx - 1, iz0, 2, 6);
      floors[k + 1].take(sx - 1, iz0, 2, 6);
    }
  }
  // banners between the top storey's front windows
  {
    const y0 = FLOOR + STOREY * (KF - 1);
    windowGaps.forEach((x, i) => {
      if (i % 2 === 1 || x + 1 >= K.x + K.w - 1) return;
      for (let xx = x; xx < x + 2; xx++) for (let y = y0 + 2; y < y0 + 13; y++) recolour(xx, y, K.z, C.roof);
      recolour(x, y0 + 7, K.z, GOLD);
    });
  }
  // the keep's roof: battlements, and a turret on the front left corner
  {
    tag = TAG.keepTop;
    const turret = K.w >= 10 && K.d >= 6;
    const inTurret = (x: number, z: number) => turret && x < K.x + 4 && z < K.z + 4;
    for (let z = K.z; z < K.z + K.d; z++) for (let x = K.x; x < K.x + K.w; x++) {
      if (!isKeepWall(x, z) || inTurret(x, z)) continue;
      column(x, z, keepTopY, keepTopY + 3, C.wall);
      const corner = (x === K.x || x === K.x + K.w - 1) && (z === K.z || z === K.z + K.d - 1);
      if (corner || (x + z) % 2 === 0) column(x, z, keepTopY + 3, keepTopY + 6, C.wall);
    }
    if (turret) {
      const cell = (a: number, b: number): [number, number] => [K.x + a, K.z + b];
      for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
        if (a === 0 || b === 0 || a === 3 || b === 3) column(...cell(a, b), keepTopY, keepTopY + 9, C.wall);
      }
      erase(...cell(2, 3), keepTopY, keepTopY + 6); // its door from the roof
      if (spec.towerTop === 'battlements') battlements(cell, 4, keepTopY + 9, TAG.keepTop);
      else roofCap(cell, 4, keepTopY + 9);
    }
  }

  // ---------- furniture ----------
  const table = (x: number, z: number, w: number, d: number, y0: number) => {
    const alongZ = d > w;
    for (const [lx, lz] of alongZ ? [[x, z], [x, z + d - 1]] : [[x, z], [x + w - 1, z]]) {
      block(lx, lz, alongZ ? w : 1, alongZ ? 1 : d, y0, y0 + 3, WOOD);
    }
    block(x, z, w, d, y0 + 3, y0 + 4, WOOD);
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) if (r() < 0.35) put(xx, y0 + 4, zz, pick([4, 14, WHITE, GOLD, 25]));
  };
  const barrel = (x: number, z: number, y0: number) => part('2489', WOOD, x, y0, z, 0, 2, 2, 5);
  const place = (sp: Space, w: number, d: number, margin: number, build: (x: number, z: number) => void, at?: { x: number; z: number }) => {
    const spot = at && sp.fits(at.x, at.z, w, d, 0) ? at : at ? null : sp.find(r, w, d, margin);
    if (!spot) return false;
    sp.take(spot.x - margin, spot.z - margin, w + 2 * margin, d + 2 * margin);
    build(spot.x, spot.z);
    return true;
  };

  const rooms: ((sp: Space, y0: number) => void)[] = [
    // the great hall: a carpet from the door to the throne, tables either side, a fireplace
    (sp, y0) => {
      const cx = doorX;
      const throneZ = iz1 - 2;
      block(cx, iz0, 2, throneZ - iz0, y0, y0 + 1, 320);
      sp.take(cx, iz0, 2, throneZ - iz0);
      place(sp, 4, 2, 0, (x, z) => {
        block(x, z, 4, 2, y0, y0 + 1, C.base); // a dais
        block(x + 1, z, 2, 2, y0 + 1, y0 + 4, C.roof); // the seat
        block(x + 1, z + 1, 2, 1, y0 + 4, y0 + 10, C.roof); // its back
        block(x + 1, z + 1, 2, 1, y0 + 10, y0 + 11, GOLD);
      }, { x: cx - 1, z: throneZ });
      const len = throneZ - 1 - (iz0 + 2);
      if (len >= 3) for (const tx of [cx - 4, cx + 4]) {
        place(sp, 4, len, 0, (x, z) => {
          block(x, z + 1, 1, len - 2, y0, y0 + 2, DARK_WOOD); // benches
          block(x + 3, z + 1, 1, len - 2, y0, y0 + 2, DARK_WOOD);
          table(x + 1, z, 2, len, y0);
        }, { x: tx - 1, z: iz0 + 2 });
      }
      place(sp, 1, 4, 0, (x, z) => {
        block(x, z, 1, 1, y0, y0 + 6, C.base);
        block(x, z + 3, 1, 1, y0, y0 + 6, C.base);
        block(x, z + 1, 1, 2, y0, y0 + 2, FIRE);
        block(x, z, 1, 4, y0 + 6, y0 + 9, C.base);
        block(x, z + 1, 1, 2, y0 + 9, y0 + 13, C.base); // the chimney breast
      }, { x: ix0, z: iz0 + Math.max(1, Math.floor((iz1 - iz0 - 4) / 2)) });
      place(sp, 2, 2, 0, (x, z) => barrel(x, z, y0), { x: ix0, z: iz0 });
      place(sp, 2, 2, 0, (x, z) => barrel(x, z, y0), { x: ix0, z: iz1 - 2 });
    },
    // the royal chambers: a bed, wardrobe, bookshelf, chest, rug and a table with a candle
    (sp, y0) => {
      place(sp, 4, 4, 0, (x, z) => block(x, z, 4, 4, y0, y0 + 1, C.roof), { x: Math.floor((ix0 + ix1) / 2) - 2, z: Math.floor((iz0 + iz1) / 2) - 2 });
      const bed = (x: number, z: number) => {
        block(x, z, 4, 2, y0, y0 + 2, WOOD);
        block(x, z, 1, 2, y0 + 2, y0 + 7, WOOD); // headboard against the wall
        block(x + 1, z, 3, 2, y0 + 2, y0 + 3, WHITE);
        block(x + 1, z, 1, 2, y0 + 3, y0 + 4, WHITE); // pillow
        block(x + 2, z, 2, 2, y0 + 3, y0 + 4, C.roof); // blanket
      };
      if (!place(sp, 4, 2, 0, bed, { x: ix0, z: iz1 - 3 })) place(sp, 4, 2, 0, bed, { x: ix0, z: iz0 + 1 });
      place(sp, 1, 2, 0, (x, z) => { block(x, z, 1, 2, y0, y0 + 11, WOOD); block(x, z, 1, 2, y0 + 11, y0 + 12, DARK_WOOD); }, { x: ix0, z: iz0 });
      place(sp, 1, 3, 0, (x, z) => {
        for (let zz = z; zz < z + 3; zz++) {
          for (const [a, b] of [[y0, y0 + 3], [y0 + 4, y0 + 7]]) column(x, zz, a, b, pick(BOOKS));
        }
        block(x, z, 1, 3, y0 + 3, y0 + 4, WOOD);
        block(x, z, 1, 3, y0 + 7, y0 + 8, WOOD);
      }, { x: ix0, z: iz0 + 3 });
      place(sp, 1, 2, 0, (x, z) => { block(x, z, 1, 2, y0, y0 + 3, WOOD); block(x, z, 1, 2, y0 + 3, y0 + 4, GOLD); }, { x: ix0 + 4, z: iz1 - 3 });
      place(sp, 2, 2, 1, (x, z) => {
        column(x, z, y0, y0 + 3, WOOD);
        column(x + 1, z + 1, y0, y0 + 3, WOOD);
        block(x, z, 2, 2, y0 + 3, y0 + 4, WOOD);
        put(x, y0 + 4, z, WHITE); // a candle
        put(x, y0 + 5, z, FIRE);
      });
    },
    // the treasury and armoury: weapon racks, chests and gold
    (sp, y0) => {
      const rack = (x: number, z: number) => {
        block(x, z, 1, 4, y0, y0 + 3, C.base);
        for (let i = 0; i < 4; i += 2) { column(x, z + i, y0 + 3, y0 + 12, WOOD); put(x, y0 + 12, z + i, 71); }
      };
      place(sp, 1, 4, 0, rack, { x: ix0, z: iz0 });
      place(sp, 1, 4, 0, rack, { x: ix0, z: iz0 + 5 });
      for (let i = 0; i < 2; i++) place(sp, 2, 1, 1, (x, z) => { block(x, z, 2, 1, y0, y0 + 3, WOOD); block(x, z, 2, 1, y0 + 3, y0 + 4, GOLD); });
      for (let i = 0; i < 3; i++) place(sp, 2, 2, 1, (x, z) => { block(x, z, 2, 2, y0, y0 + 1, GOLD); put(x, y0 + 1, z, GOLD); });
      place(sp, 2, 2, 1, (x, z) => barrel(x, z, y0));
    },
  ];
  for (let k = 0; k < KF; k++) {
    tag = keepTag(k, 1);
    rooms[k](floors[k], FLOOR + STOREY * k);
  }

  // ---------- courtyard ----------
  tag = TAG.court;
  const yard = new Space(W, D);
  for (let z = I.z; z < I.z + I.d; z++) for (let x = I.x; x < I.x + I.w; x++) if (zone(x, z) === 'yard') yard.open(x, z);
  // the way from the gate to the keep's door, and out of the towers' doors
  const lo = Math.min(px, doorX - 1), hi = Math.max(px + 4, doorX + 3);
  yard.take(lo, G.z + G.d, hi - lo, K.z - (G.z + G.d));
  for (const [x, z] of [[I.x + T, I.z + s], [I.x + I.w - T - 2, I.z + s], [I.x + T, I.z + I.d - s - 2], [I.x + I.w - T - 2, I.z + I.d - s - 2]]) yard.take(x, z, 2, 2);
  // stairs up to the wall walk, against a side wall
  {
    const n = wallHeight / 3;
    const zs = I.z + s + 2;
    for (const x of [I.x + T, I.x + I.w - T - 1]) {
      if (!yard.fits(x, zs, 1, n) || zs + n > I.z + I.d - s - 2) continue;
      for (let j = 1; j <= n; j++) column(x, zs + j - 1, FLOOR, FLOOR + 3 * j, C.wall);
      yard.take(x - 1, zs - 1, 3, n + 2);
      break;
    }
  }
  const y0 = FLOOR;
  place(yard, 4, 4, 1, (x, z) => {
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
      if (a === 0 || b === 0 || a === 3 || b === 3) column(x + a, z + b, y0, y0 + 3, C.wall);
      else put(x + a, y0, z + b, WATER);
    }
    column(x, z + 1, y0 + 3, y0 + 9, WOOD);
    column(x + 3, z + 1, y0 + 3, y0 + 9, WOOD);
    block(x, z + 1, 4, 1, y0 + 9, y0 + 10, WOOD);
    block(x, z + 1, 4, 2, y0 + 10, y0 + 13, C.roof); // a little roof
  });
  place(yard, 4, 2, 1, (x, z) => {
    for (const [a, b] of [[0, 0], [3, 0], [0, 1], [3, 1]]) column(x + a, z + b, y0, y0 + 9, WOOD);
    block(x + 1, z, 2, 1, y0, y0 + 3, WOOD); // the counter
    put(x + 1, y0 + 3, z, pick([4, 14, 25]));
    put(x + 2, y0 + 3, z, pick([4, 14, 25]));
    block(x, z, 4, 1, y0 + 9, y0 + 10, C.roof); // a striped awning
    block(x, z + 1, 4, 1, y0 + 9, y0 + 10, WHITE);
  });
  place(yard, 3, 2, 1, (x, z) => {
    block(x, z, 3, 2, y0, y0 + 3, C.base); // the forge
    block(x, z, 2, 1, y0 + 3, y0 + 4, FIRE);
    column(x + 2, z + 1, y0 + 3, y0 + 12, C.base); // its chimney
  });
  place(yard, 3, 1, 1, (x, z) => {
    column(x + 1, z, y0, y0 + 9, WOOD); // a training dummy
    block(x, z, 3, 1, y0 + 9, y0 + 10, WOOD);
    column(x + 1, z, y0 + 10, y0 + 13, PATH);
  });
  for (let i = 0; i < 3; i++) place(yard, 2, 2, 0, (x, z) => barrel(x, z, y0));
  for (let i = 0; i < 2; i++) place(yard, 2, 2, 0, (x, z) => block(x, z, 2, 2, y0, y0 + 6, WOOD)); // crates
  place(yard, 2, 2, 0, (x, z) => block(x, z, 2, 2, y0, y0 + 3, PATH)); // hay

  // ---------- woods ----------
  tag = TAG.nature;
  const woods = new Space(W, D);
  const band = { x: I.x - mw - 1, z: I.z - mw - 1, w: I.w + 2 * mw + 2, d: I.d + 2 * mw + 2 };
  for (let z = 1; z < D - 1; z++) for (let x = 1; x < W - 1; x++) if (!inRect(band, x, z) && !pathCells.has(x + W * z)) woods.open(x, z);
  const tries = Math.floor((W * D) / 10);
  for (let i = 0; i < tries; i++) {
    const kind = r();
    const R = kind < 0.85 && spec.margin >= 5 && r() < 0.5 ? 2 : 1;
    const n = 2 * R + 1;
    const spot = woods.find(r, n, n, 0, 1);
    if (!spot) continue;
    woods.take(spot.x, spot.z, n, n);
    const cx = spot.x + R, cz = spot.z + R;
    if (kind < 0.55) {
      // an oak: a trunk and a round crown
      const trunk = pick([6, 9]);
      column(cx, cz, 1, 1 + trunk, WOOD);
      const leaf = pick(LEAVES);
      const ch = R === 1 ? 6 : 9;
      const y1 = 1 + trunk;
      for (let y = y1; y < y1 + ch; y++) {
        const t = ((y - y1 + 0.5) / ch) * 2 - 1;
        const rr = (R + 0.5) ** 2 * (1 - 0.6 * t * t);
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dz * dz <= rr) put(cx + dx, y, cz + dz, leaf);
      }
    } else if (kind < 0.85) {
      // a pine: a short trunk and tiers that narrow to the top
      column(cx, cz, 1, 4, DARK_WOOD);
      let y = 4;
      for (let rad = R; rad >= 0; rad--) {
        const h = rad === 0 ? 3 : 2;
        block(cx - rad, cz - rad, 2 * rad + 1, 2 * rad + 1, y, y + h, 288);
        y += h;
      }
    } else {
      // a bush
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (Math.abs(dx) + Math.abs(dz) <= 1) column(cx + dx, cz + dz, 1, 3, 288);
      put(cx, 3, cz, pick(LEAVES));
    }
  }
  for (let i = 0; i < Math.floor(W / 6); i++) {
    place(woods, 2, 1, 0, (x, z) => { block(x, z, 2, 1, 1, 3, C.base); put(x, 3, z, 71); });
  }
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (woods.isFree(x, z) && r() < 0.03) put(x, 1, z, pick(FLOWERS));

  // ---------- bricks ----------
  for (const { f } of fixtures) {
    for (let y = f.y; y < f.y + f.h; y++) for (let z = f.z; z < f.z + f.d; z++) for (let x = f.x; x < f.x + f.w; x++) v.set(x, y, z, -1);
  }
  const built = brickify(v, { fixtures: fixtures.map((q) => q.f) });

  // ---------- steps ----------
  const order: { tag: number; title: string }[] = [
    { tag: TAG.base, title: 'Baseplate' },
    { tag: TAG.ground, title: spec.moat ? 'Moat, bridge and path' : 'Path and steps' },
    { tag: TAG.island, title: 'The island' },
    { tag: TAG.wall, title: 'Curtain walls and towers' },
    { tag: TAG.gate, title: 'Gatehouse' },
  ];
  for (let k = 0; k < KF; k++) {
    order.push({ tag: keepTag(k, 0), title: `Keep, ${STOREY_NAMES[k]}: walls` });
    order.push({ tag: keepTag(k, 1), title: `Keep, ${STOREY_NAMES[k]}: the ${spec.rooms[k]}` });
    order.push({ tag: keepTag(k, 2), title: k === KF - 1 ? 'Keep roof' : `Keep: floor of the ${STOREY_NAMES[k + 1]}` });
  }
  order.push(
    { tag: TAG.keepTop, title: 'Keep battlements and turret' },
    { tag: TAG.top, title: 'Battlements and wall walks' },
    { tag: TAG.roof, title: 'Tower roofs' },
    { tag: TAG.court, title: 'Courtyard' },
    { tag: TAG.nature, title: 'Trees and gardens' },
  );
  const byTag = new Map<number, PlanItem[]>();
  const add = (t: number, it: PlanItem) => (byTag.get(t) ?? byTag.set(t, []).get(t)!).push(it);
  const bricks = built.items.slice(0, built.pieces.length);
  built.pieces.forEach((p, i) => add(tags[at(p.x, p.y, p.z)] || TAG.island, bricks[i]));
  for (const { f, tag: t } of fixtures) for (const it of f.items) add(t, it);
  const steps: Step[] = order.map((o) => ({ title: o.title, pieces: byTag.get(o.tag) ?? [] })).filter((st) => st.pieces.length > 0);

  const plan = ensureIds({
    format: 'brickmotion-plan', version: 1,
    name: `${spec.label} #${spec.seed}`,
    description: `${spec.label}, on a ${W}×${D} baseplate: a ${spec.rooms.join(', ')} in the keep, a courtyard with a well, a market stall and a forge, and woods all round. Generated from seed ${spec.seed}.`,
    steps,
  });
  return { spec, plan, built };
}
