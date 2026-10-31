import type { Box } from '../ldraw/flatten';
import type { StudConnector } from '../ldraw/connectors';
import type { Instance, Metrics } from '../model/assemble';
import type { SnapPart } from './studSnap';

/**
 * Which pieces a moved selection would sit inside. Points sampled through the moving
 * parts' solids are tested against the other parts' meshes, column by column, with a
 * little slack so parts that only touch pass. A stud sitting in a socket is not an
 * overlap. Everything is in LDU, in one shared frame.
 */

/** A placed part, tagged with its top-level plan item id (a submodel use's parts share its id). */
export type Solid = SnapPart & { id: string };
export type CollisionWorld = {
  /** ids of the world's solids that `moving`, shifted by `shiftLdu`, would penetrate */
  hits(moving: readonly Solid[], shiftLdu?: readonly number[]): Set<string>;
};

type P3 = readonly [number, number, number];
const apply = (e: ArrayLike<number>, p: readonly number[]): P3 => [
  e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12],
  e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
  e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14],
];
function worldBox(e: ArrayLike<number>, body: Box): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const x of [body.min[0], body.max[0]]) for (const y of [body.min[1], body.max[1]]) for (const z of [body.min[2], body.max[2]]) {
    const p = apply(e, [x, y, z]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  }
  return { min, max };
}

/** Triangles bucketed by the 4 LDU cell their shadow covers, per mesh and per line axis. */
const TRI_CELL = 4;
const NO_TRIS: number[] = [];
const triIndex = new WeakMap<Float32Array, (Map<number, number[]> | undefined)[]>();
const cellOf = (a: number, b: number) => (Math.floor(a / TRI_CELL) + 32768) * 65536 + (Math.floor(b / TRI_CELL) + 32768);
/** Offsets (into `mesh`) of the triangles whose shadow on the plane across `axis` may cover (x, z). */
function trianglesNear(mesh: Float32Array, axis: 0 | 1 | 2, x: number, z: number): number[] {
  let perAxis = triIndex.get(mesh);
  if (!perAxis) triIndex.set(mesh, (perAxis = []));
  let cells = perAxis[axis];
  if (!cells) {
    cells = perAxis[axis] = new Map();
    const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    for (let t = 0; t + 8 < mesh.length; t += 9) {
      const a0 = Math.min(mesh[t + i], mesh[t + 3 + i], mesh[t + 6 + i]) - 1e-3, a1 = Math.max(mesh[t + i], mesh[t + 3 + i], mesh[t + 6 + i]) + 1e-3;
      const b0 = Math.min(mesh[t + j], mesh[t + 3 + j], mesh[t + 6 + j]) - 1e-3, b1 = Math.max(mesh[t + j], mesh[t + 3 + j], mesh[t + 6 + j]) + 1e-3;
      for (let ca = Math.floor(a0 / TRI_CELL); ca <= Math.floor(a1 / TRI_CELL); ca++)
        for (let cb = Math.floor(b0 / TRI_CELL); cb <= Math.floor(b1 / TRI_CELL); cb++) {
          const k = (ca + 32768) * 65536 + (cb + 32768), list = cells.get(k);
          if (list) list.push(t); else cells.set(k, [t]);
        }
    }
  }
  return cells.get(cellOf(x, z)) ?? NO_TRIS;
}

const spans = new WeakMap<Float32Array, Map<string, [number, number] | null>>();
/**
 * The range a part's mesh fills along one local axis through the line at the other two
 * coordinates of `q`, kept to its body, or null. Hollows count as filled, so callers
 * test all three axes: a point is inside a part only when every axis agrees.
 */
function lineSpan(mesh: Float32Array, body: Box, axis: 0 | 1 | 2, q: readonly number[]): [number, number] | null {
  let cache = spans.get(mesh);
  if (!cache) spans.set(mesh, (cache = new Map()));
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const x = Math.round(q[i] * 2) / 2, z = Math.round(q[j] * 2) / 2;
  const key = `${axis}:${x},${z}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let lo = Infinity, hi = -Infinity;
  for (const t of trianglesNear(mesh, axis, x, z)) {
    const ax = mesh[t + i], az = mesh[t + j], bx = mesh[t + 3 + i], bz = mesh[t + 3 + j], cx = mesh[t + 6 + i], cz = mesh[t + 6 + j];
    const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(area) < 1e-6) continue;
    const u = ((bx - x) * (cz - z) - (cx - x) * (bz - z)) / area;
    const v = ((cx - x) * (az - z) - (ax - x) * (cz - z)) / area;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const y = u * mesh[t + axis] + v * mesh[t + 3 + axis] + w * mesh[t + 6 + axis];
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  lo = Math.max(lo, body.min[axis]); hi = Math.min(hi, body.max[axis]);
  const span: [number, number] | null = hi - lo > 0.5 ? [lo, hi] : null;
  cache.set(key, span);
  return span;
}

/** Whether a part-space point lies in a stud (with half an LDU of slack). */
function inStud(st: StudConnector, q: readonly number[]): boolean {
  const a = [st.tip[0] - st.base[0], st.tip[1] - st.base[1], st.tip[2] - st.base[2]];
  const len = Math.hypot(a[0], a[1], a[2]);
  if (len < 1e-6) return false;
  const d = [q[0] - st.base[0], q[1] - st.base[1], q[2] - st.base[2]];
  const t = (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) / len;
  if (t < -0.5 || t > len + 0.5) return false;
  const r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - t * t;
  return r2 < (st.radius + 0.5) ** 2;
}


const samples = new WeakMap<readonly Solid[], P3[]>();
/** Points through the moving parts' solids (world LDU), cached per moving list. */
function sampleOf(moving: readonly Solid[]): P3[] {
  const hit = samples.get(moving);
  if (hit) return hit;
  const points: P3[] = [];
  for (const part of moving) {
    if (!part.mesh) continue;
    const { min, max } = part.body;
    for (let x = min[0] + 2; x <= max[0] - 2 + 1e-6; x += 4) for (let z = min[2] + 2; z <= max[2] - 2 + 1e-6; z += 4) {
      const span = lineSpan(part.mesh, part.body, 1, [x, 0, z]);
      if (!span || span[1] - span[0] < 2.5) continue;
      for (const y of [span[0] + 1, (span[0] + span[1]) / 2, span[1] - 1]) points.push(apply(part.world, [x, y, z]));
    }
  }
  samples.set(moving, points);
  return points;
}
/** How many sample points a moving set has (0 = nothing to test, e.g. no meshes). */
export const sampleCount = (moving: readonly Solid[]) => sampleOf(moving).length;

const CELL = 40;
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A collision world over fixed solids, indexed once in a uniform grid (40 LDU cells). */
export function collisionWorld(solids: readonly Solid[]): CollisionWorld {
  const entries = solids.filter((s) => s.mesh).map((part) => ({ part, box: worldBox(part.world, part.body) }));
  const grid = new Map<string, number[]>();
  entries.forEach(({ box }, i) => {
    const lo = box.min.map((v) => Math.floor(v / CELL)), hi = box.max.map((v) => Math.floor(v / CELL));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = cellKey(x, y, z), list = grid.get(k);
      if (list) list.push(i); else grid.set(k, [i]);
    }
  });
  const inside = (e: (typeof entries)[number], p: readonly number[]) => {
    const { part, box } = e;
    if (![0, 1, 2].every((k) => p[k] > box.min[k] && p[k] < box.max[k])) return false;
    // into the part's own frame (rotation transposed)
    const m = part.world, d = [p[0] - m[12], p[1] - m[13], p[2] - m[14]];
    const q = [0, 1, 2].map((c) => m[c * 4] * d[0] + m[c * 4 + 1] * d[1] + m[c * 4 + 2] * d[2]);
    // a stud sits in the selection's sockets, not inside it
    if ((part.studs ?? []).some((st) => inStud(st, q))) return false;
    return ([0, 1, 2] as const).every((k) => {
      const span = lineSpan(part.mesh!, part.body, k, q);
      return !!span && q[k] > span[0] + 0.5 && q[k] < span[1] - 0.5;
    });
  };
  return {
    hits(moving, shift = [0, 0, 0]) {
      const out = new Set<string>();
      const mine = new Set(moving);
      for (const p0 of sampleOf(moving)) {
        const p = [p0[0] + shift[0], p0[1] + shift[1], p0[2] + shift[2]];
        const list = grid.get(cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL), Math.floor(p[2] / CELL)));
        if (!list) continue;
        for (const i of list) {
          const e = entries[i];
          if (out.has(e.part.id) || mine.has(e.part)) continue;
          if (inside(e, p)) out.add(e.part.id);
        }
      }
      return out;
    },
  };
}

/** True when `after` hits a piece that `before` did not: the edit makes overlap worse. */
export function addsOverlap(before: ReadonlySet<string>, after: ReadonlySet<string>): boolean {
  for (const id of after) if (!before.has(id)) return true;
  return false;
}

/** Placed instances as solids, tagged with their top-level item id; placeholders are skipped. */
export function solidsFor(instances: readonly Instance[], metrics: Metrics): Solid[] {
  return instances.filter((i) => !i.placeholder).map((i) => {
    const m = metrics(i.part);
    return { id: i.key.split('/')[0], world: i.world.elements, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh };
  });
}
