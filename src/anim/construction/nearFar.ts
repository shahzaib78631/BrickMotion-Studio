/**
 * Deterministic, geometry-guided rigid route proposals.
 *
 * NEAR only disengages a candidate from its immediate connection / work scope.
 * FAR moves a freed candidate into its staging bay through open air. The caller
 * validates EVERY proposed segment against the continuous mesh oracle, including
 * any joint-specific allowances on the *first* segment only.
 *
 * These helpers generate candidates, never collision certificates.
 */
import type { Box } from '../../ldraw/flatten';
import { add, dot, mul, norm, overlaps, size, unit } from './math';
import type { V3 } from './math';
import type { Connection, ConstructionNode } from './types';

const distinct = (values: number[]): number[] => [...new Set(values.filter(v => Number.isFinite(v) && v > 0).map(v => Math.round(v * 1000) / 1000))].sort((a,b) => a-b);

/** Connexion priorities first, then authored insertion axis, then free-space axes.
 * A physically explicit insertion axis remains the strongest signal; it is not
 * silently overwritten by a guessed mesh-normal route.
 */
export function guidedDirections(
  node: ConstructionNode,
  contacts: readonly Connection[],
  possible: readonly V3[],
  occupied: readonly Box[],
): V3[] {
  const dirs: { direction: V3; priority: number; exposure: number; order: number }[] = [];
  const addDir = (raw: V3, priority: number) => {
    if (norm(raw) < 1e-9) return;
    const direction = unit(raw);
    if (dirs.some(d => dot(d.direction, direction) > 1 - 1e-7)) return;
    // An unobstructed exterior side is preferable to a direction facing deeper
    // into the already-assembled geometry. This is ranking, not certification.
    const distance = Math.max(24, ...size(node.bounds)) + 2;
    const sweptBounds = { min: [...node.bounds.min] as V3, max: [...node.bounds.max] as V3 };
    let exposure = 0;
    for (const box of occupied) {
      if (box === node.bounds) continue;
      const test = {min: add(sweptBounds.min, mul(direction, distance)), max: add(sweptBounds.max, mul(direction, distance))};
      if (overlaps(box, test)) exposure++;
    }
    dirs.push({direction, priority, exposure, order: dirs.length});
  };
  if (node.hints?.insertionAxis) addDir(node.hints.insertionAxis, 0);
  for (const c of contacts) if (c.outward) {
    addDir(c.outward, c.confidence === 'declared' ? 0 : 1);
    if (c.axial) addDir(mul(c.outward, -1), 1);
  }
  for (const axis of possible) addDir(axis, 2);
  dirs.sort((a,b) => a.priority-b.priority || a.exposure-b.exposure || a.order-b.order);
  // In V3's cheap guided pass, trying all six global directions for a part
  // still seated on a known joint wastes thousands of mesh sweeps. First try
  // only declared/connector-guided withdrawal axes. If none can advance the
  // scope, the planner's EXISTING exhaustive pass retains all directions and
  // candidate routes; this heuristic does not claim physical impossibility.
  const constrained = !!node.hints?.insertionAxis || contacts.some(c => !!c.outward);
  const prioritized = constrained ? dirs.filter(d => d.priority < 2) : dirs;
  return (prioritized.length ? prioritized : dirs).map(d => d.direction);
}

/** Candidate withdrawal depths from connection geometry + the nearest exit of
 * actual occupied AABBs. The key difference from V2: no blindly nested grid
 * of six distances times 29 sideways detours times rotation modes.
 */
export function nearDistances(node: ConstructionNode, direction: V3, contacts: readonly Connection[], obstacles: readonly Box[], scope: Box): number[] {
  const extent = Math.max(1, ...size(node.bounds));
  const lengths = contacts.flatMap(c => [...(c.region ? [c.region] : []), ...(c.regions ?? [])].map(r => r.length));
  const connector = lengths.length ? Math.max(...lengths) + 0.1 : 0;
  const local = Math.max(4.1, Math.min(24, extent * 0.65), connector);
  const start = node.bounds, margin = 1.0;
  const exits: number[] = [];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(direction[k]) < 1e-6) continue;
    const a = direction[k] > 0 ? scope.max[k] - start.min[k] : start.max[k] - scope.min[k];
    exits.push(a / Math.abs(direction[k]) + margin);
  }
  // Relevant obstacle faces yield meaningful clearance candidates for an
  // axial motion. An obstacle may still block the actual sweep: only the exact
  // mesh check can accept a candidate.
  for (const box of obstacles) {
    for (let k = 0; k < 3; k++) {
      if (Math.abs(direction[k]) < .999) continue;
      const parallel = [0,1,2].filter(i => i !== k).every(i => start.min[i] < box.max[i] && start.max[i] > box.min[i]);
      if (!parallel) continue;
      const dist = direction[k] > 0 ? box.max[k] - start.min[k] : start.max[k] - box.min[k];
      if (dist > 0.5) exits.push(dist / Math.abs(direction[k]) + margin);
    }
  }
  const far = exits.length ? Math.min(...exits.filter(v => v >= local), Math.max(48, extent + 8)) : Math.max(48, extent + 8);
  // At most four increasingly useful depths per direction. Trying the
  // connector clearance first often succeeds for standard LEGO insertions.
  return distinct([connector ? Math.max(connector, 2.05) : 4.05, local, far, Math.max(far, extent + 8)]).slice(0, 4);
}

/** Exit corridors from a near pose. First try the nearby position, then the
 * four exterior sides of the *actual work scope* (not 24 arbitrary slides).
 */
export function farExits(moving: Box, scope: Box, gap = 24): V3[] {
  return [
    [0, 0, 0],
    [scope.min[0] - moving.max[0] - gap, 0, 0],
    [scope.max[0] - moving.min[0] + gap, 0, 0],
    [0, 0, scope.min[2] - moving.max[2] - gap],
    [0, 0, scope.max[2] - moving.min[2] + gap],
  ].filter(d => d.every(Number.isFinite) && norm(d as V3) < 1e7) as V3[];
}
