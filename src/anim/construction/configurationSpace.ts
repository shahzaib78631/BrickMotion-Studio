/**
 * Bounded, obstacle-face configuration-space roadmap for rigid translation.
 *
 * This is NOT a sampled-collision certificate. The roadmap proposes waypoints;
 * every edge is checked by the caller's continuous swept-mesh oracle, and the
 * caller must independently replay the accepted route in the final scene.
 * Coordinates include obstacle-expanded faces, allowing two- and three-turn
 * escapes that a single lateral sidestep cannot represent. Only rigid paths
 * are admitted: articulated parts require a separate joint-motion validator.
 */
import type { Box } from '../../ldraw/flatten';
import { add, norm, sub, type V3 } from './math';

export type DetourStats = {
  expanded: number;
  edges: number;
  endChecks: number;
  blocked: number;
};
export type DetourSearch = {
  /** Translation component of the already-certified near pose. */
  start: V3;
  /** World AABB at start; remains the same shape during this search. */
  moving: Box;
  /** Actual occupied obstacles. The caller must omit its moving unit. */
  obstacles: readonly Box[];
  /** Max Y (downwards in LDraw) permitted for every path endpoint. */
  floor: number;
  /** Centre of the horizontal region to escape and its boundaries. */
  scope: Box;
  /** Above all scene obstacles, in the LDraw negative-Y direction. */
  sky: number;
  /** Exact continuous mesh test, INCLUDING staging and moving parts. */
  clearEdge: (from: V3, to: V3) => boolean;
  /** Checks a certified route to the actual staged pose from this waypoint. */
  complete: (at: V3) => V3[] | null;
  pulse?: () => void;
  report?: (stats: DetourStats) => void;
  maxExpanded?: number;
  maxEdges?: number;
  maxFinishChecks?: number;
  /** Additional wall-clock cap, independent of global search budget. */
  maxMilliseconds?: number;
};
export type DetourResult = { waypoints: V3[]; stats: DetourStats };

const EPS = 1e-5;
const finite = (v: V3): boolean => v.every(Number.isFinite);
const clampLimits = (v: number | undefined, fallback: number, cap: number): number =>
  Number.isFinite(v) ? Math.max(1, Math.min(cap, Math.floor(v!))) : fallback;
const coord = (v: number) => Math.round(v * 1000) / 1000;

/** Sorted nonuniform lattice coordinates; obstacle faces get priority over a
 * fine uniform grid. Never round the actual initial coordinate or corridor. */
function levels(start: number, proposals: number[], limit: number): number[] {
  const unique = [...new Set(proposals.filter(Number.isFinite).map(coord))]
    .filter(v => Math.abs(v - start) > EPS)
    .sort((a, b) => Math.abs(a - start) - Math.abs(b - start) || a - b)
    .slice(0, limit - 1);
  return [...unique, start].sort((a, b) => a - b);
}

/** Finds a mesh-certified, nonstraight escape from a certified connector-aligned
 * NEAR pose. A budget failure means UNKNOWN, never a blocked-path proof. */
export function findCertifiedDetour(input: DetourSearch): DetourResult | null {
  const { start, moving, obstacles, scope, floor, sky, clearEdge, complete } = input;
  if (!finite(start) || !Number.isFinite(floor) || !Number.isFinite(sky))
    throw new Error('Invalid configuration-space search inputs');
  const stats: DetourStats = { expanded: 0, edges: 0, endChecks: 0, blocked: 0 };
  const maxExpanded = clampLimits(input.maxExpanded, 64, 256);
  const maxEdges = clampLimits(input.maxEdges, 210, 1024);
  const maxFinishChecks = clampLimits(input.maxFinishChecks, 48, 64);
  const maxMilliseconds = clampLimits(input.maxMilliseconds, 450, 5000);
  const started = performance.now();
  const gap = 0.5; // AABB roadmap *proposal* clearance, not a mesh tolerance.
  const radius = Math.min(320, Math.max(72,
    Math.min(scope.max[0] - scope.min[0], scope.max[2] - scope.min[2]) / 2));
  const ox: number[] = [], oy: number[] = [], oz: number[] = [];
  // Shortest potential escape via the four sides; nonstraight paths can pass
  // round a corner of any close obstacle on the way there.
  ox.push(start[0] + scope.min[0] - moving.max[0] - 8,
    start[0] + scope.max[0] - moving.min[0] + 8);
  oz.push(start[2] + scope.min[2] - moving.max[2] - 8,
    start[2] + scope.max[2] - moving.min[2] + 8);
  oy.push(start[1] + sky - moving.max[1], start[1] - 12, start[1] - 24);
  for (const o of obstacles) {
    const dx = Math.max(0, o.min[0] - moving.max[0], moving.min[0] - o.max[0]);
    const dz = Math.max(0, o.min[2] - moving.max[2], moving.min[2] - o.max[2]);
    if (Math.hypot(dx, dz) > radius || o.min[1] > floor + EPS) continue;
    ox.push(start[0] + o.min[0] - moving.max[0] - gap,
      start[0] + o.max[0] - moving.min[0] + gap);
    oz.push(start[2] + o.min[2] - moving.max[2] - gap,
      start[2] + o.max[2] - moving.min[2] + gap);
    // LDraw Y grows downwards. Moving above an obstacle is negative Y.
    oy.push(start[1] + o.min[1] - moving.max[1] - gap);
  }
  const xs = levels(start[0], ox, 13);
  const zs = levels(start[2], oz, 13);
  const ys = levels(start[1], oy.filter(y => y + moving.max[1] - start[1] <= floor + EPS && y <= start[1]), 5);
  const si = xs.indexOf(start[0]), sj = ys.indexOf(start[1]), sk = zs.indexOf(start[2]);
  if (si < 0 || sj < 0 || sk < 0) return null;
  const toKey = (i: number, j: number, k: number) => `${i}:${j}:${k}`;
  const startKey = toKey(si, sj, sk);
  type Entry = { i: number; j: number; k: number; key: string; cost: number; rank: number };
  const records = new Map<string, { cost: number; parent?: string; at: V3 }>();
  records.set(startKey, { cost: 0, at: start });
  const open: Entry[] = [{ i: si, j: sj, k: sk, key: startKey, cost: 0, rank: 0 }];
  const closed = new Set<string>();
  // Prefer walking towards open exterior space. Rank does not discard other
  // states; a blocked corridor remains eligible when the route bends away.
  const outside = (p: V3): number => Math.min(
    Math.abs(p[0] + moving.max[0] - start[0] - scope.min[0]),
    Math.abs(scope.max[0] - (p[0] + moving.min[0] - start[0])),
    Math.abs(p[2] + moving.max[2] - start[2] - scope.min[2]),
    Math.abs(scope.max[2] - (p[2] + moving.min[2] - start[2])),
    Math.max(0, p[1] + moving.max[1] - start[1] - sky),
  );
  while (open.length && stats.expanded < maxExpanded && stats.edges < maxEdges) {
    if (performance.now() - started > maxMilliseconds) break;
    input.pulse?.();
    open.sort((a, b) => a.rank - b.rank || a.cost - b.cost || a.key.localeCompare(b.key));
    const current = open.shift()!;
    if (closed.has(current.key)) continue;
    // Skip an outdated queue entry when a cheaper route to this waypoint was
    // discovered after it was enqueued. Otherwise closing the stale record
    // could discard an entirely valid corridor.
    if (current.cost > (records.get(current.key)?.cost ?? Infinity) + 1e-7) continue;
    closed.add(current.key);
    stats.expanded++;
    const at = records.get(current.key)!.at;
    // The direct route from the start was checked by the caller already.
    if (current.key !== startKey && stats.endChecks < maxFinishChecks) {
      stats.endChecks++;
      const tail = complete(at);
      if (tail) {
        const backwards: V3[] = [at];
        let key = current.key;
        while (records.get(key)?.parent) {
          key = records.get(key)!.parent!;
          backwards.push(records.get(key)!.at);
        }
        input.report?.(stats);
        return { waypoints: [...backwards.reverse(), ...tail], stats };
      }
    }
    const neighbours: [number, number, number][] = [
      [current.i - 1, current.j, current.k], [current.i + 1, current.j, current.k],
      [current.i, current.j - 1, current.k], [current.i, current.j + 1, current.k],
      [current.i, current.j, current.k - 1], [current.i, current.j, current.k + 1],
    ];
    for (const [i, j, k] of neighbours) {
      if (i < 0 || j < 0 || k < 0 || i >= xs.length || j >= ys.length || k >= zs.length) continue;
      const next: V3 = [xs[i], ys[j], zs[k]];
      const key = toKey(i, j, k);
      if (closed.has(key) || next[1] + moving.max[1] - start[1] > floor + EPS) continue;
      const length = norm(sub(next, at));
      const cost = current.cost + length;
      if (cost >= (records.get(key)?.cost ?? Infinity) - 1e-7) continue;
      if (stats.edges >= maxEdges) break;
      stats.edges++;
      input.pulse?.();
      if (performance.now() - started > maxMilliseconds) break;
      if (!clearEdge(at, next)) { stats.blocked++; continue; }
      records.set(key, { cost, parent: current.key, at: next });
      open.push({ i, j, k, key, cost, rank: cost + outside(next) * 0.45 });
    }
  }
  input.report?.(stats);
  return null;
}
