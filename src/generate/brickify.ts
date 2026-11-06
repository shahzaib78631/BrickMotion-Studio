import type { Grid, PieceItem, PlanItem } from '../plan/types';
import { hollowed, Voxels } from './voxels';

/**
 * Shape → bricks. Fills a voxel shape (studs across, plates up) with real bricks and
 * plates, the way a builder lays a wall: big pieces first, joints offset from the course
 * below so every piece grips two below it where it can. Then a repair pass rebuilds any
 * seam that leaves the model in separate pieces, using plates that straddle it.
 *
 * Pieces only ever sit stud-on-stud on the grid, so the result is valid by construction:
 * the cells are covered exactly once, nothing overlaps, and `components` says whether it
 * all holds together (1) or not.
 */

/** A part's footprint at rot 0 (w studs along x, d along z) and height in plates. */
export type PartSpec = { part: string; w: number; d: number; plates: 1 | 3 };

export const BRICKS: PartSpec[] = [
  { part: '3005', w: 1, d: 1, plates: 3 },
  { part: '3004', w: 2, d: 1, plates: 3 },
  { part: '3622', w: 3, d: 1, plates: 3 },
  { part: '3010', w: 4, d: 1, plates: 3 },
  { part: '3009', w: 6, d: 1, plates: 3 },
  { part: '3008', w: 8, d: 1, plates: 3 },
  { part: '3003', w: 2, d: 2, plates: 3 },
  { part: '3002', w: 3, d: 2, plates: 3 },
  { part: '3001', w: 4, d: 2, plates: 3 },
  { part: '2456', w: 6, d: 2, plates: 3 },
  { part: '3007', w: 8, d: 2, plates: 3 },
];

export const PLATES: PartSpec[] = [
  { part: '3024', w: 1, d: 1, plates: 1 },
  { part: '3023', w: 2, d: 1, plates: 1 },
  { part: '3623', w: 3, d: 1, plates: 1 },
  { part: '3710', w: 4, d: 1, plates: 1 },
  { part: '3666', w: 6, d: 1, plates: 1 },
  { part: '3460', w: 8, d: 1, plates: 1 },
  { part: '3022', w: 2, d: 2, plates: 1 },
  { part: '3021', w: 3, d: 2, plates: 1 },
  { part: '3020', w: 4, d: 2, plates: 1 },
  { part: '3795', w: 6, d: 2, plates: 1 },
  { part: '3034', w: 8, d: 2, plates: 1 },
  { part: '3031', w: 4, d: 4, plates: 1 },
  { part: '3032', w: 6, d: 4, plates: 1 },
  { part: '3035', w: 8, d: 4, plates: 1 },
  { part: '3958', w: 6, d: 6, plates: 1 },
];

/** A placed piece: grid corner, rotated footprint (w along x, d along z) and height. */
export type Piece = { part: string; color: number; x: number; y: number; z: number; w: number; d: number; h: number; rot: 0 | 90; fixed?: boolean };

/**
 * Something placed before the bricks go in (a window, a door): the box of cells it fills
 * (x, z in studs, y in plates, w×d×h) and the plan items that make it. Bricks are laid
 * around it and joined to it like to any other piece; its cells should be empty in the shape.
 */
export type Fixture = { x: number; y: number; z: number; w: number; d: number; h: number; items: PlanItem[] };

export type Built = {
  pieces: Piece[];
  /** plan items: the bricks on the stud grid (y in plates, up), then the fixtures' items */
  items: PlanItem[];
  /** how many separate parts the model falls into: 1 means it holds together */
  components: number;
  /** the shape actually built (the input, or its hollowed shell) */
  shape: Voxels;
  /** shell thickness used in studs (0: solid) */
  shell: number;
};

export type BrickifyOptions = {
  parts?: PartSpec[];
  maxRepairs?: number;
  /** keep only a shell this many studs thick (0 or unset: solid) */
  hollow?: number;
  /** windows, doors and other set pieces the bricks are laid around */
  fixtures?: Fixture[];
};

type Cand = { spec: PartSpec; x: number; z: number; w: number; d: number; rot: 0 | 90 };

class Builder {
  readonly occ: Int32Array;
  pieces: (Piece | null)[] = [];

  /** cells with all six neighbours filled: nobody sees them, so any colour may fill them */
  readonly hidden: Uint8Array;

  constructor(readonly v: Voxels, readonly specs: PartSpec[]) {
    this.occ = new Int32Array(v.w * v.d * v.h).fill(-1);
    this.hidden = new Uint8Array(v.w * v.d * v.h);
    v.forEach((x, y, z) => {
      const full = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].every(([a, b, c]) => v.get(x + a, y + b, z + c) >= 0);
      if (full) this.hidden[x + v.w * (z + v.d * y)] = 1;
    });
  }

  isHidden(x: number, y: number, z: number): boolean {
    return this.v.inside(x, y, z) && this.hidden[x + this.v.w * (z + this.v.d * y)] === 1;
  }

  /** May a piece of `color` fill this cell? Its own colour, or any colour when it is hidden. */
  takes(x: number, y: number, z: number, color: number): boolean {
    const c = this.v.get(x, y, z);
    return c === color || (c >= 0 && this.isHidden(x, y, z));
  }

  at(x: number, y: number, z: number): number {
    return this.v.inside(x, y, z) ? this.occ[x + this.v.w * (z + this.v.d * y)] : -1;
  }

  private mark(p: Piece, id: number): void {
    for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.d; z++) for (let x = p.x; x < p.x + p.w; x++)
      this.occ[x + this.v.w * (z + this.v.d * y)] = id;
  }

  add(p: Piece): number {
    const id = this.pieces.length;
    this.pieces.push(p);
    this.mark(p, id);
    return id;
  }

  remove(id: number): void {
    const p = this.pieces[id];
    if (!p) return;
    this.mark(p, -1);
    this.pieces[id] = null;
  }

  /** Can this candidate go at plate y: every cell in the shape, the same colour, free and allowed? */
  private fits(c: Cand, y: number, color: number, allowed: (x: number, y: number, z: number) => boolean): boolean {
    for (let yy = y; yy < y + c.spec.plates; yy++)
      for (let z = c.z; z < c.z + c.d; z++)
        for (let x = c.x; x < c.x + c.w; x++)
          if (!this.takes(x, yy, z, color) || this.at(x, yy, z) !== -1 || !allowed(x, yy, z)) return false;
    return true;
  }

  /** Joint quality against the course below: bridges two or more pieces, and no edge lines up with a joint. */
  private bond(c: Cand, y: number): number {
    if (y === 0) return 0;
    const below = new Set<number>();
    let aligned = 0;
    for (let z = c.z; z < c.z + c.d; z++) for (let x = c.x; x < c.x + c.w; x++) {
      const b = this.at(x, y - 1, z);
      if (b >= 0) below.add(b);
    }
    // an edge is aligned where the pieces below on either side of it differ (a joint runs straight up)
    const edge = (xi: number, zi: number, xo: number, zo: number) => {
      const a = this.at(xi, y - 1, zi);
      const b = this.at(xo, y - 1, zo);
      if (a >= 0 && b >= 0 && a !== b) aligned++;
    };
    for (let z = c.z; z < c.z + c.d; z++) {
      edge(c.x, z, c.x - 1, z);
      edge(c.x + c.w - 1, z, c.x + c.w, z);
    }
    for (let x = c.x; x < c.x + c.w; x++) {
      edge(x, c.z, x, c.z - 1);
      edge(x, c.z + c.d - 1, x, c.z + c.d);
    }
    return 4 * Math.max(0, below.size - 1) - 3 * aligned;
  }

  /**
   * Fill every free shape cell at plate y that `allowed` lets in, greedily, best piece first.
   * `bonus` adds to a candidate's score (the repair pass uses it to make pieces straddle a seam).
   */
  fillLayer(y: number, allowed: (x: number, y: number, z: number) => boolean = () => true, bonus: (c: Cand) => number = () => 0, platesOnly = false): void {
    const v = this.v;
    const alongX = y % 2 === 0; // alternate the long direction per layer so layers cross
    const cells: [number, number][] = [];
    if (alongX) { for (let z = 0; z < v.d; z++) for (let x = 0; x < v.w; x++) cells.push([x, z]); }
    else { for (let x = 0; x < v.w; x++) for (let z = 0; z < v.d; z++) cells.push([x, z]); }
    for (const [cx, cz] of cells) {
      const own = v.get(cx, y, cz);
      if (own < 0 || this.at(cx, y, cz) !== -1 || !allowed(cx, y, cz)) continue;
      let best: Cand | null = null;
      let bestColor = own;
      let bestScore = -Infinity;
      const colors = this.isHidden(cx, y, cz) ? this.colorsNear(cx, y, cz) : [own];
      for (const color of colors) for (const spec of this.specs) {
        if (platesOnly && spec.plates !== 1) continue;
        if (y + spec.plates > v.h) continue;
        for (const rot of spec.w === spec.d ? [0 as const] : [0 as const, 90 as const]) {
          const w = rot === 0 ? spec.w : spec.d;
          const d = rot === 0 ? spec.d : spec.w;
          for (let x = cx - w + 1; x <= cx; x++) for (let z = cz - d + 1; z <= cz; z++) {
            const c: Cand = { spec, x, z, w, d, rot };
            if (!this.fits(c, y, color, allowed)) continue;
            const area = w * d;
            const long = w === d ? 0 : (w > d) === alongX ? 1 : 0;
            const score = area + (spec.plates === 3 ? 2 : 0) + long + this.bond(c, y) + bonus(c);
            if (score > bestScore) { bestScore = score; best = c; bestColor = color; }
          }
        }
      }
      if (!best) continue; // only when `allowed` hides every way in (never for a full shape: 1×1 plate always fits)
      this.add({ part: best.spec.part, color: bestColor, x: best.x, y, z: best.z, w: best.w, d: best.d, h: best.spec.plates, rot: best.rot });
    }
  }

  /** Colours a hidden cell could take: its own, then those of the shape cells within two studs. */
  private colorsNear(x: number, y: number, z: number): number[] {
    const out = [this.v.get(x, y, z)];
    for (let dy = -3; dy <= 3; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const c = this.v.get(x + dx, y + dy, z + dz);
      if (c >= 0 && !out.includes(c)) out.push(c);
    }
    return out;
  }

  /** Union–find over pieces joined stud-to-tube (one sits right on top of the other, footprints overlapping). */
  components(): { count: number; of: Int32Array } {
    const n = this.pieces.length;
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const v = this.v;
    for (let y = 1; y < v.h; y++) for (let z = 0; z < v.d; z++) for (let x = 0; x < v.w; x++) {
      const a = this.at(x, y, z);
      const b = this.at(x, y - 1, z);
      if (a >= 0 && b >= 0 && a !== b) parent[find(a)] = find(b);
    }
    const of = new Int32Array(n).fill(-1);
    const roots = new Map<number, number>();
    this.pieces.forEach((p, i) => {
      if (!p) return;
      const r = find(i);
      if (!roots.has(r)) roots.set(r, roots.size);
      of[i] = roots.get(r)!;
    });
    return { count: roots.size, of };
  }

  /**
   * Join two components across a seam: take two side-by-side pieces from different
   * components, clear them, and refill their cells plate by plate with pieces that are
   * rewarded for covering both sides. Returns false when no such pair exists.
   */
  repairOnce(of: Int32Array, tried: Set<string>): boolean {
    const sizes = new Map<number, number>();
    this.pieces.forEach((p, i) => { if (p) sizes.set(of[i], (sizes.get(of[i]) ?? 0) + 1); });
    // start from the smallest component: the seam around it is the cheapest to rebuild
    const order = [...sizes.keys()].sort((a, b) => sizes.get(a)! - sizes.get(b)!);
    for (const comp of order) {
      for (let i = 0; i < this.pieces.length; i++) {
        const p = this.pieces[i];
        if (!p || p.fixed || of[i] !== comp) continue;
        const pairs: number[] = [];
        for (let y = p.y; y < p.y + p.h; y++) {
          const look = (x: number, z: number) => {
            const q = this.at(x, y, z);
            if (q >= 0 && of[q] !== comp && !this.pieces[q]!.fixed && !pairs.includes(q)) pairs.push(q);
          };
          for (let z = p.z; z < p.z + p.d; z++) { look(p.x - 1, z); look(p.x + p.w, z); }
          for (let x = p.x; x < p.x + p.w; x++) { look(x, p.z - 1); look(x, p.z + p.d); }
        }
        for (const q of pairs) {
          const a = p;
          const b = this.pieces[q]!;
          const key = [a, b].map((t) => `${t.x},${t.y},${t.z},${t.w},${t.d},${t.h}`).sort().join('|');
          if (tried.has(key)) continue;
          tried.add(key);
          const side = new Map<string, number>();
          for (const [s, piece] of [[0, a], [1, b]] as const)
            for (let y = piece.y; y < piece.y + piece.h; y++) for (let z = piece.z; z < piece.z + piece.d; z++) for (let x = piece.x; x < piece.x + piece.w; x++)
              side.set(`${x},${y},${z}`, s);
          const y0 = Math.min(a.y, b.y);
          const y1 = Math.max(a.y + a.h, b.y + b.h);
          this.remove(i);
          this.remove(q);
          const allowed = (x: number, y: number, z: number) => side.has(`${x},${y},${z}`);
          const straddle = (c: Cand) => {
            const seen = new Set<number>();
            for (let z = c.z; z < c.z + c.d; z++) for (let x = c.x; x < c.x + c.w; x++) {
              for (let y = y0; y < y1; y++) { const s = side.get(`${x},${y},${z}`); if (s !== undefined) seen.add(s); }
            }
            return seen.size === 2 ? 50 : 0;
          };
          for (let y = y0; y < y1; y++) this.fillLayer(y, allowed, straddle, true);
          return true;
        }
      }
    }
    return false;
  }
}

function build(v: Voxels, opts: BrickifyOptions): Omit<Built, 'shell'> {
  const b = new Builder(v, opts.parts ?? [...BRICKS, ...PLATES]);
  for (const f of opts.fixtures ?? []) b.add({ part: 'fixture', color: -1, x: f.x, y: f.y, z: f.z, w: f.w, d: f.d, h: f.h, rot: 0, fixed: true });
  for (let y = 0; y < v.h; y++) b.fillLayer(y);
  let comps = b.components();
  const tried = new Set<string>();
  for (let n = 0; comps.count > 1 && n < (opts.maxRepairs ?? 200); n++) {
    if (!b.repairOnce(comps.of, tried)) break;
    comps = b.components();
  }
  const pieces = b.pieces.filter((p): p is Piece => !!p && !p.fixed);
  const bricks: (PieceItem & Grid)[] = pieces.map((p) => ({ part: p.part, color: p.color, x: p.x, y: p.y, z: p.z, rot: p.rot }));
  return {
    pieces,
    items: [...bricks, ...(opts.fixtures ?? []).flatMap((f) => f.items)],
    components: b.components().count,
    shape: v,
  };
}

/**
 * Bricks for a shape. With `hollow`, the core is taken out first; when a thin shell would
 * fall apart (rings that no longer overlap the ring above, near a ball's poles), the shell
 * thickens half a stud at a time until it holds, up to solid.
 */
export function brickify(input: Voxels, opts: BrickifyOptions = {}): Built {
  const solid = () => ({ ...build(input, opts), shell: 0 });
  if (!opts.hollow || opts.hollow <= 0) return solid();
  const deepest = Math.max(input.w, input.d, input.h / 2.5) / 2;
  for (let shell = opts.hollow; shell < deepest; shell += 0.5) {
    const v = hollowed(input, shell);
    if (v.count() === input.count()) break; // nothing left to take out
    const b = build(v, opts);
    if (b.components === 1) return { ...b, shell };
  }
  return solid();
}
