import * as THREE from 'three';
import { inJointContact, type JointContact, type JointPair } from './jointContact';
import type { Box } from '../ldraw/flatten';
import { maximumLinearScale, segmentTouchesSurface } from './surfaceContact';

/**
 * Real part shapes for working out how a piece goes on: a triangle soup in part space
 * (LDU), its distinct corner points, and a bounding-volume tree for fast ray tests.
 */
export type Shape = { tris: Float32Array; points: Float32Array; tree: TreeNode; /** per triangle: 1 when its front face is unknown */ twoSided: Uint8Array };
type TreeNode = { min: [number, number, number]; max: [number, number, number]; left?: TreeNode; right?: TreeNode; first: number; count: number };

const LEAF = 8;
/** surface points swept per piece (spread evenly over the part's area) */
const MAX_POINTS = 1500;

const cache = new WeakMap<Float32Array, Shape>();

/**
 * The searchable shape of a part's triangle soup (built once per part). Triangles
 * before `twoSidedFrom` face outwards counter-clockwise (LDraw BFC); the rest may face either way.
 */
export function shapeOf(tris: Float32Array, twoSidedFrom = tris.length / 9): Shape {
  let s = cache.get(tris);
  if (!s) {
    s = build(tris, twoSidedFrom);
    cache.set(tris, s);
  }
  return s;
}

function build(src: Float32Array, twoSidedFrom: number): Shape {
  const n = src.length / 9;
  const order = Array.from({ length: n }, (_, i) => i);
  const centre = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) centre[i * 3 + k] = (src[i * 9 + k] + src[i * 9 + 3 + k] + src[i * 9 + 6 + k]) / 3;
  const node = (first: number, count: number): TreeNode => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let j = first; j < first + count; j++) {
      const t = order[j] * 9;
      for (let v = 0; v < 9; v += 3)
        for (let k = 0; k < 3; k++) {
          const x = src[t + v + k];
          if (x < min[k]) min[k] = x;
          if (x > max[k]) max[k] = x;
        }
    }
    const out: TreeNode = { min, max, first, count };
    if (count <= LEAF) return out;
    const axis = [0, 1, 2].reduce((a, k) => (max[k] - min[k] > max[a] - min[a] ? k : a), 0);
    const part = order.slice(first, first + count).sort((a, b) => centre[a * 3 + axis] - centre[b * 3 + axis]);
    for (let j = 0; j < count; j++) order[first + j] = part[j];
    const half = count >> 1;
    out.left = node(first, half);
    out.right = node(first + half, count - half);
    return out;
  };
  const tree = n ? node(0, n) : { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number], first: 0, count: 0 };
  // triangles stored in tree order, so a leaf is one contiguous run
  const tris = new Float32Array(src.length);
  const twoSided = new Uint8Array(n);
  order.forEach((t, j) => {
    tris.set(src.subarray(t * 9, t * 9 + 9), j * 9);
    twoSided[j] = t >= twoSidedFrom ? 1 : 0;
  });
  // Points spread evenly over the surface by area (not just triangle corners, which
  // crowd into detailed spots like stud rims): a peg dragged through a wall then
  // crosses with its whole side, a snap only touches at its lip. Deterministic.
  const area = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const t = i * 9;
    const ax = src[t + 3] - src[t], ay = src[t + 4] - src[t + 1], az = src[t + 5] - src[t + 2];
    const bx = src[t + 6] - src[t], by = src[t + 7] - src[t + 1], bz = src[t + 8] - src[t + 2];
    area[i + 1] = area[i] + Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
  }
  const count = n ? MAX_POINTS : 0;
  const points = new Float32Array(count * 3);
  let tri = 0;
  for (let j = 0; j < count; j++) {
    const target = ((j + 0.5) / count) * area[n];
    while (tri < n - 1 && area[tri + 1] < target) tri++;
    // a well-spread spot inside the triangle (golden-ratio sequence)
    let u = (j * 0.6180339887) % 1, v = (j * 0.7548776662) % 1;
    if (u + v > 1) ((u = 1 - u), (v = 1 - v));
    const t = tri * 9;
    for (let k = 0; k < 3; k++) points[j * 3 + k] = src[t + k] + u * (src[t + 3 + k] - src[t + k]) + v * (src[t + 6 + k] - src[t + k]);
  }
  return { tris, points, tree, twoSided };
}

/** ray-box slab test: whether o + t·d meets the box for some t in [0, maxT] */
function rayMeetsBox(o: number[], d: number[], min: number[], max: number[], maxT: number): boolean {
  let t0 = 0, t1 = maxT;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < min[k] || o[k] > max[k]) return false;
      continue;
    }
    let a = (min[k] - o[k]) / d[k], b = (max[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The nearest hit of the ray o + t·d on the shape for t in (fromT, toT]: its t, and
 * whether it goes INTO the material (meets a counter-clockwise outer face, or a face
 * of unknown side). t = Infinity when nothing is hit.
 */
/** reused traversal stack: nearestHit is the planner's innermost loop */
let hitStack: TreeNode[] = new Array(64);

function nearestHit(s: Shape, o: number[], d: number[], fromT: number, toT: number): { t: number; enters: boolean } {
  const tr = s.tris;
  const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
  // slab test with the inverse direction worked out once per ray (same result as rayMeetsBox)
  const px0 = Math.abs(dx) < 1e-12, py0 = Math.abs(dy) < 1e-12, pz0 = Math.abs(dz) < 1e-12;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  const meets = (min: number[], max: number[], maxT: number): boolean => {
    let t0 = 0, t1 = maxT;
    if (px0) { if (ox < min[0] || ox > max[0]) return false; }
    else {
      let a = (min[0] - ox) * ix, b = (max[0] - ox) * ix;
      if (a > b) { const c = a; a = b; b = c; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    if (py0) { if (oy < min[1] || oy > max[1]) return false; }
    else {
      let a = (min[1] - oy) * iy, b = (max[1] - oy) * iy;
      if (a > b) { const c = a; a = b; b = c; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    if (pz0) { if (oz < min[2] || oz > max[2]) return false; }
    else {
      let a = (min[2] - oz) * iz, b = (max[2] - oz) * iz;
      if (a > b) { const c = a; a = b; b = c; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    return true;
  };
  let stack = hitStack, top = 0;
  stack[top++] = s.tree;
  let best = toT;
  let found = false;
  let enters = false;
  while (top) {
    const nd = stack[--top];
    if (!nd.count || !meets(nd.min, nd.max, best)) continue;
    if (nd.left) {
      if (top + 2 > stack.length) hitStack = stack = stack.concat(new Array(stack.length));
      stack[top++] = nd.left;
      stack[top++] = nd.right!;
      continue;
    }
    for (let j = nd.first; j < nd.first + nd.count; j++) {
      const i = j * 9;
      // Möller–Trumbore, both faces
      const e1x = tr[i + 3] - tr[i], e1y = tr[i + 4] - tr[i + 1], e1z = tr[i + 5] - tr[i + 2];
      const e2x = tr[i + 6] - tr[i], e2y = tr[i + 7] - tr[i + 1], e2z = tr[i + 8] - tr[i + 2];
      const qx0 = dy * e2z - dz * e2y, qy0 = dz * e2x - dx * e2z, qz0 = dx * e2y - dy * e2x;
      const det = e1x * qx0 + e1y * qy0 + e1z * qz0;
      if (Math.abs(det) < 1e-9) continue;
      const inv = 1 / det;
      const sx = ox - tr[i], sy = oy - tr[i + 1], sz = oz - tr[i + 2];
      const u = (sx * qx0 + sy * qy0 + sz * qz0) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > fromT && t <= best) {
        best = t;
        found = true;
        // det > 0: the ray meets the counter-clockwise (outer) side, going in
        enters = det > 0 || s.twoSided[j] === 1;
      }
    }
  }
  return { t: found ? best : Infinity, enters };
}

/** how far (LDU) a point must travel inside another part's material to count: LEGO walls are thicker */
const MIN_WALL = 0.8;

/**
 * Whether the point moving along o + t·d (t in (fromT, toT]) passes through the
 * shape's material: it goes in, and stays in for more than a hair. Grazing a
 * surface tessellated a little differently (parts in contact) goes in and straight out.
 */
export function passesThrough(s: Shape, o: number[], d: number[], fromT: number, toT: number, contactTolerance = CONTACT, joint?: JointContact): boolean {
  const touching = (lo: number, hi: number): boolean =>
    segmentTouchesSurface(s, o, d, lo, hi, contactTolerance) || !!(joint &&
      inJointContact(joint, o, d, lo, hi) && segmentTouchesSurface(s, o, d, lo, hi, joint.tolerance, joint.normalRatio));
  let cursor = fromT;
  // Inspect subsequent walls too. The old first-hit-only test missed a thick
  // wall after a grazing contact, and ignored a point that started in material.
  for (let crossing = 0; crossing < 64 && cursor < toT; crossing++) {
    const hit = nearestHit(s, o, d, cursor, toT);
    if (!Number.isFinite(hit.t)) {
      // A short segment entirely INSIDE a solid has no boundary hit. Look
      // beyond the endpoint to distinguish it from a segment in free space.
      const ahead = nearestHit(s, o, d, cursor, Infinity);
      return Number.isFinite(ahead.t) && !ahead.enters &&
        !touching(cursor, toT);
    }
    if (!hit.enters) {
      if (hit.t - cursor > MIN_WALL && !touching(cursor, hit.t)) return true;
      cursor = hit.t + 1e-4;
      continue;
    }
    const out = nearestHit(s, o, d, hit.t + 1e-4, toT);
    const end = Number.isFinite(out.t) ? out.t : toT;
    if (end - hit.t > MIN_WALL && !touching(hit.t, end)) return true;
    if (!Number.isFinite(out.t)) return false;
    cursor = out.t + 1e-4;
  }
  // Unusually complicated geometry is not certified as clear after a budget cap.
  return cursor < toT;
}

export type Placed = { shape: Shape; world: THREE.Matrix4; box: Box };

/** how far studs and pins can reach past a part's body box (LDU) */
const STUD_REACH = 5;

/** surface points closer than this (LDU) to a neighbour's surface count as touching, not crossing */
const CONTACT = 0.3;

/** How far `a` must move along unit `d` until its box is clear of `b`'s (0 when already apart). */
function clearDistance(a: Box, b: Box, d: number[]): number {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    if (d[k] > 1e-6) best = Math.min(best, (b.max[k] - a.min[k]) / d[k]);
    else if (d[k] < -1e-6) best = Math.min(best, (a.max[k] - b.min[k]) / -d[k]);
  }
  return Math.max(0, best);
}

/** How far along `d` a sweep between these boxes looks (box clearance plus stud reach). */
export function sweepReach(a: Box, b: Box, d: readonly number[]): number {
  return clearDistance(a, b, d as number[]) + STUD_REACH;
}

/** points of `from` (its own space), moved into `into`'s space, swept along d (world) — count hits */
function sweepHits(from: Placed, into: Placed, d: number[], maxT: number, toLocal: THREE.Matrix4, intoInv: THREE.Matrix4, limit: number, joint?: JointContact): number {
  const m = toLocal.elements;
  const w = intoInv.elements;
  // the direction in `into`'s space (no translation; length kept so t stays in world LDU)
  const dl = [w[0] * d[0] + w[4] * d[1] + w[8] * d[2], w[1] * d[0] + w[5] * d[1] + w[9] * d[2], w[2] * d[0] + w[6] * d[1] + w[10] * d[2]];
  // Keep the tolerance in world LDU even for scaled/sheared imported parts.
  const scale = maximumLinearScale(into.world.elements);
  const contactTolerance = Number.isFinite(scale) && scale > 0 ? CONTACT / scale : 0;
  const p = from.shape.points;
  const tree = into.shape.tree;
  let hits = 0;
  const o = [0, 0, 0];
  for (let i = 0; i < p.length; i += 3) {
    o[0] = m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12];
    o[1] = m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13];
    o[2] = m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14];
    if (!rayMeetsBox(o, dl, tree.min, tree.max, maxT)) continue;
    if (passesThrough(into.shape, o, dl, maxT <= CONTACT ? 0 : CONTACT, maxT, contactTolerance, joint) && ++hits > limit) return hits;
  }
  return hits;
}


/** Actual finite translational sweep, used only after the AABB broad phase.
 * Both surfaces are sampled, with no connector percentage allowance. Rotating
 * intervals are NOT certified by this function. It remains a mesh-sample test.
 */
export function translationClear(piece: Placed, neighbour: Placed, delta: Way): boolean {
  const length = Math.hypot(...delta);
  if (!Number.isFinite(length) || length < 1e-7 || !piece.shape.points.length || !neighbour.shape.points.length) return false;
  const d = delta.map((v) => v / length);
  const inv = neighbour.world.clone().invert();
  const rel = inv.clone().multiply(piece.world);
  if (sweepHits(piece, neighbour, d, length, rel, inv, 0)) return false;
  inv.copy(piece.world).invert(); rel.multiplyMatrices(inv, neighbour.world);
  return sweepHits(neighbour, piece, d.map((v) => -v), length, rel, inv, 0) === 0;
}

/**
 * How much `piece` has to pass through its neighbours to leave its built spot along
 * unit direction `d` (world) — and so to come in the opposite way: for each touching
 * neighbour, the share of the piece's surface points that pass through it plus the
 * share of its points that pass through the piece. 0 is a clean slide. LDraw parts
 * overlap a little where they meet (a minifig arm's shoulder sits in the torso), so
 * the right way scores low rather than 0, and a wrong way pushes a whole feature
 * (a peg, a stud, a wall) through and scores far higher. Infinity once above `cap`.
 */
export function crossings(piece: Placed, neighbours: Placed[], d: Way, scratch: { inv: THREE.Matrix4; rel: THREE.Matrix4 }, cap = BLOCKED, maxDistance = Infinity, joint?: JointPair): number {
  if (!(maxDistance > 0) || Number.isNaN(maxDistance) || !Number.isFinite(cap) || cap < 0 ||
      d.length !== 3 || !d.every(Number.isFinite) || Math.abs(Math.hypot(...d) - 1) > 1e-6) return Infinity;
  let total = 0;
  const ownPoints = piece.shape.points.length / 3;
  if (!ownPoints || neighbours.some((n) => !n.shape.points.length)) return Infinity;
  for (const n of neighbours) {
    // a little past box clearance: studs and pins stick out of the body boxes
    const clearance = clearDistance(piece.box, n.box, d);
    if (clearance <= 0) continue;
    // Certify the segment actually flown, not an unperformed continuation.
    // Keep the clearance check separate: a short entry must NOT bypass testing.
    const maxT = Math.min(clearance + STUD_REACH, maxDistance);
    // piece points → neighbour space, moving along d
    scratch.inv.copy(n.world).invert();
    scratch.rel.multiplyMatrices(scratch.inv, piece.world);
    const a = sweepHits(piece, n, d, maxT, scratch.rel, scratch.inv, Math.ceil((cap - total) * ownPoints), joint?.neighbour) / ownPoints;
    total += a;
    if (total > cap) return Infinity;
    // neighbour points → piece space, moving along −d (the same relative motion)
    const theirPoints = n.shape.points.length / 3;
    scratch.inv.copy(piece.world).invert();
    scratch.rel.multiplyMatrices(scratch.inv, n.world);
    total += sweepHits(n, piece, [-d[0], -d[1], -d[2]], maxT, scratch.rel, scratch.inv, Math.ceil((cap - total) * theirPoints), joint?.piece) / theirPoints;
    if (total > cap) return Infinity;
  }
  return total;
}

/**
 * Scores at or under this are a way in. Measured on a minifig: legs onto the hips
 * from the side 0.007, torso down onto the hips 0, arm into the torso 0.06, hand
 * into its wrist 0.05, cape from behind 0.02, head and hair from above ≤ 0.012.
 * Wrong ways push a peg, pin or wall through: hips down onto the legs 0.12, head
 * from the side 0.10, hand from above 0.17, an arm from above 0.21.
 */
export const CLEAR = 0.085;
/** scores past this are not worth measuring further */
const BLOCKED = 1;
/** a way within this of the best is as good (then the preferred one, e.g. from above, wins) */
const AS_GOOD = 0.02;

export type Way = [number, number, number];

/** in from above (LDraw −Y is up) */
export const UP: Way = [0, -1, 0];

/**
 * The ways to try for a piece at `world`, in order: `preferred` first, then the
 * piece's own axes (a tilted hand's wrist peg), including tilted axes; the route planner checks actual floor clearance.
 */
export function waysFor(world: THREE.Matrix4, preferred: Way[]): Way[] {
  const e = world.elements;
  const ways = [...preferred];
  for (const c of [0, 4, 8]) {
    const len = Math.hypot(e[c], e[c + 1], e[c + 2]) || 1;
    for (const s of [1, -1]) {
      const w: Way = [(s * e[c]) / len, (s * e[c + 1]) / len, (s * e[c + 2]) / len];
      if (ways.some((o) => o[0] * w[0] + o[1] * w[1] + o[2] * w[2] > 1 - 1e-10)) continue;
      ways.push(w);
    }
  }
  return ways;
}

const SIDES: Way[] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The ways in for a piece, best first: of `ways` (in order of preference) those
 * scoring at most CLEAR; the earliest that is about as good as the best leads.
 */
export function rankWays(piece: Placed, neighbours: Placed[], ways: Way[], scratch = { inv: new THREE.Matrix4(), rel: new THREE.Matrix4() }): Way[] {
  // Keep alternative clean directions: the preferred insertion may be clear
  // locally while its approach corridor is blocked by a distant overhang.
  const scored = ways.map((w) => ({ w, s: neighbours.length ? crossings(piece, neighbours, w, scratch, CLEAR) : 0 })).filter((x) => x.s <= CLEAR);
  if (!scored.length) return [];
  const best = Math.min(...scored.map((x) => x.s));
  const lead = scored.find((x) => x.s <= best + AS_GOOD)!;
  return [lead.w, ...scored.filter((x) => x !== lead).sort((a, b) => a.s - b.s).map((x) => x.w)];
}

/** Whether the piece has any way in or out at all (above, sides, its own axes). */
export function canLeave(piece: Placed, neighbours: Placed[], scratch = { inv: new THREE.Matrix4(), rel: new THREE.Matrix4() }): boolean {
  if (!neighbours.length) return true;
  return waysFor(piece.world, [UP, ...SIDES]).some((w) => crossings(piece, neighbours, w, scratch, CLEAR) <= CLEAR);
}


/**
 * Hand-made LDraw files often place a part up to a unit off the stud grid, so it
 * cuts about 1 LDU into a neighbour it only touches in the real set. A route is
 * accepted when it is clear with the piece nudged this far ACROSS the way it moves
 * (never along it), so authoring slop is forgiven but a part never passes through
 * another one.
 */
export const AUTHORING_SLOP = 1;

/** Sideways nudges to retry a blocked route with: across `d`, up to AUTHORING_SLOP, nearest first. */
export function slopNudges(d: readonly number[]): Way[] {
  const n = new THREE.Vector3(...d).normalize();
  const helper = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3().crossVectors(n, helper).normalize();
  const b = new THREE.Vector3().crossVectors(n, a).normalize();
  const out: Way[] = [];
  for (const s of [0.5, AUTHORING_SLOP])
    for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]])
      out.push([s * (u * a.x + v * b.x), s * (u * a.y + v * b.y), s * (u * a.z + v * b.z)]);
  return out;
}

/** The same placed piece moved by `offset` (world LDU). */
export function nudged(p: Placed, offset: readonly number[]): Placed {
  const world = p.world.clone();
  world.elements[12] += offset[0];
  world.elements[13] += offset[1];
  world.elements[14] += offset[2];
  return { shape: p.shape, world, box: { min: p.box.min.map((v, k) => v + offset[k]) as Box['min'], max: p.box.max.map((v, k) => v + offset[k]) as Box['max'] } };
}
