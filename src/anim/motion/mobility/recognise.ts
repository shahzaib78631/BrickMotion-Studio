/**
 * Bodies and joints from assembled parts.
 *
 * 1. Every connector between two parts becomes the constraint wrenches of
 *    what it holds (screw.ts). All connectors between the same two bodies are
 *    combined into one screw joint; a pair left with no motion is one body.
 * 2. Merging changes which connectors meet (two parts welded to one body may
 *    now hold a third on two axes), so step 1 repeats on the merged bodies.
 * 3. The joints that remain form loops; the loop mobility test (mobility.ts)
 *    finds loops that cannot move (a pinned triangle) and joints that cannot
 *    move inside a moving loop. Those bodies merge too, and 1-3 repeat until
 *    nothing changes.
 */
import type { MechanicalJoint } from '../../construction/mechanicalConstraintGraph';
import { mobility, type Mobility, type MobilityOptions } from './mobility';
import { screwJoint, type ConnectorFreedom, type ScrewJoint, type V3 } from './screw';

/**
 * What a connector leaves free. Studs are friction fits: never a joint on
 * their own. Axles and pins are held along their axis by friction, bushes and
 * cross holes, so an axial slide counts only with `axialSlides` (a builder
 * does not intend a wheel to slide off its axle), or where the parts were
 * designed to slide (`designedSlide`: a rod in its cylinder).
 */
export function connectorFreedom(j: MechanicalJoint, axialSlides = false): ConnectorFreedom | null {
  const len = Math.hypot(...j.axis);
  if (!(len > 0.5) || !j.centre.every(Number.isFinite)) return null;
  const axis = j.axis.map(x => x / len) as V3, centre = [...j.centre] as V3;
  if (j.type === 'ball-socket' || j.motion === 'ball') return { centre, axis, ball: true, turns: true, slides: false };
  if (j.type === 'stud-socket') return { centre, axis, turns: false, slides: false };
  return { centre, axis, turns: !!j.rotates || j.motion === 'revolute', slides: (axialSlides || !!j.designedSlide) && j.motion === 'sliding' };
}

export type RecognisedPair = { a: string; b: string; joint: ScrewJoint; connectors: MechanicalJoint[] };
export type Recognition = {
  /** Parts that move as one, sorted. */
  bodies: string[][];
  bodyOf: Map<string, number>;
  /** Joints between bodies (a < b as body indices). */
  joints: { a: number; b: number; joint: ScrewJoint; connectors: MechanicalJoint[] }[];
  mobility: Mobility;
  rounds: number;
  /** Single pins/axles whose free spin was folded into a neighbour. */
  idle: string[];
};

export function recogniseMechanism(parts: readonly string[], connectors: readonly MechanicalJoint[], options: MobilityOptions & { axialSlides?: boolean; keepIdle?: boolean } = {}): Recognition {
  const parent = new Map(parts.map(p => [p, p]));
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); return true; };
  const usable = connectors.flatMap(j => {
    if (j.male === j.female || !parent.has(j.male) || !parent.has(j.female)) return [];
    const f = connectorFreedom(j, options.axialSlides);
    return f ? [{ j, f }] : [];
  });
  const idle = new Set<string>();
  for (let rounds = 1; ; rounds++) {
    // 1-2: combine connectors per body pair until no pair is rigid.
    let joints: Recognition['joints'] = [], bodies: string[][] = [], bodyOf = new Map<string, number>();
    for (;;) {
      const roots = [...new Set(parts.map(find))].sort();
      bodyOf = new Map(); const index = new Map(roots.map((r, i) => [r, i]));
      for (const p of parts) bodyOf.set(p, index.get(find(p))!);
      bodies = roots.map(() => []); for (const p of parts) bodies[bodyOf.get(p)!].push(p);
      const byPair = new Map<string, { a: number; b: number; list: typeof usable }>();
      for (const u of usable) {
        let a = bodyOf.get(u.j.male)!, b = bodyOf.get(u.j.female)!;
        if (a === b) continue;
        if (a > b) [a, b] = [b, a];
        const k = `${a}|${b}`, e = byPair.get(k) ?? { a, b, list: [] };
        e.list.push(u); byPair.set(k, e);
      }
      joints = [];
      let merged = false;
      for (const { a, b, list } of byPair.values()) {
        const joint = screwJoint(list.map(u => u.f));
        if (joint.dof === 0) { merged = union(bodies[a][0], bodies[b][0]) || merged; continue; }
        joints.push({ a, b, joint, connectors: list.map(u => u.j) });
      }
      if (!merged) break;
    }
    // Idle spins: a lone pin or axle turning on one line between bodies moves
    // nothing but itself. Folding it into its heaviest neighbour composes its
    // joints in series (each other neighbour keeps a hinge on that line).
    let merged = false;
    if (!options.keepIdle) {
      const around = new Map<number, typeof joints>();
      for (const j of joints) for (const x of [j.a, j.b]) (around.get(x) ?? around.set(x, []).get(x)!).push(j);
      for (const [x, list] of around) {
        const part = bodies[x][0];
        // Only inserted connectors (pins, axles): male in every connection. A
        // turntable top or a wheel is a designed moving part, not idle.
        if (bodies[x].length !== 1 || list.length < 2 || !list.every(j => j.joint.kind === 'revolute' && sameLine(j.joint, list[0].joint))) continue;
        if (!usable.every(u => (u.j.male !== part && u.j.female !== part) || u.j.male === part)) continue;
        const host = list.map(j => (j.a === x ? j.b : j.a)).sort((p, q) => bodies[q].length - bodies[p].length || p - q)[0];
        idle.add(bodies[x][0]);
        merged = union(bodies[host][0], bodies[x][0]) || merged;
      }
    }
    if (merged) continue;
    // 3: loops that cannot move, and joints that cannot move inside loops.
    const m = mobility(bodies.length, joints, options);
    for (const block of m.blocks) {
      if (block.exact && block.dimension === 0) {
        for (const e of block.joints) merged = union(bodies[joints[e].a][0], bodies[joints[e].b][0]) || merged;
        continue;
      }
      // Without the exact test, "still to first order" is not proof of locked
      // (a joint may move at second order), so such a block merges nothing.
      if (!block.exact) continue;
      const lockedCoords = new Map<number, number>();
      for (const l of block.locked) lockedCoords.set(l.joint, (lockedCoords.get(l.joint) ?? 0) + 1);
      for (const [e, n] of lockedCoords) if (n === joints[e].joint.dof) merged = union(bodies[joints[e].a][0], bodies[joints[e].b][0]) || merged;
    }
    if (!merged) {
      bodies.forEach(b => b.sort());
      return { bodies, bodyOf, joints, mobility: m, rounds, idle: [...idle].sort() };
    }
  }
}

/** Same axis line, within the connector slop (4 degrees, 2 LDU). */
function sameLine(a: ScrewJoint, b: ScrewJoint): boolean {
  const u = a.axis!, w = b.axis!, p = a.point!, q = b.point!;
  if (Math.abs(u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) < Math.cos((4 * Math.PI) / 180)) return false;
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], t = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  return Math.hypot(d[0] - u[0] * t, d[1] - u[1] * t, d[2] - u[2] * t) <= 2;
}
