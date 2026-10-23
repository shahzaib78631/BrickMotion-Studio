import * as THREE from 'three';
import { placementMatrix, transformBox, unionBox, type ANode, type Metrics } from '../model/assemble';
import type { Box } from '../ldraw/flatten';
import { mateAxis, plugAxes, worldSnaps } from './snapMates';

type PieceNode = Extract<ANode, { kind: 'piece' }>;
export type RigidMember = { node: PieceNode; rel: THREE.Matrix4 };
export type RigidHardware = { kind: 'wheel' | 'window'; root: PieceNode; members: RigidMember[]; body: Box; full: Box };
const canonical = (part: string) => part.toLowerCase().replace(/\.dat$/, '').split('/').pop();
export const wheelHardware = (part = '') => ['6014', '6015'].includes(canonical(part) ?? '');

/**
 * A known rim/tyre connection requires tyre deformation; it is not a rigid slide.
 * Stage this hardware already connected and move it as ONE rigid assembly.
 * Do not use this as a fallback for arbitrary blocked parts. Only this exact,
 * unambiguous, standard fit is recognised. Explicit user hints opt out.
 */
export function rigidWheelPairs(nodes: ANode[], metrics: Metrics): RigidHardware[] {
  const pieces = nodes.filter((n): n is PieceNode => n.kind === 'piece');
  const candidates: RigidHardware[] = [];
  for (const rim of pieces.filter((n) => canonical(n.part) === '6014' && !n.assembly)) {
    const root = placementMatrix(rim.local), inv = root.clone().invert();
    for (const tyre of pieces.filter((n) => canonical(n.part) === '6015' && !n.assembly)) {
      const rel = inv.clone().multiply(placementMatrix(tyre.local));
      const e = rel.elements;
      if ([0,1,2,4,5,6,8,9,10].some((k) => Math.abs(e[k] - ([0,5,10].includes(k) ? 1 : 0)) > 1e-5)) continue;
      if (Math.hypot(e[12], e[13], e[14] + 6) > 0.1) continue;
      const a = metrics(rim.part), b = metrics(tyre.part);
      if (a.placeholder || b.placeholder || !a.mesh?.length || !b.mesh?.length) continue;
      candidates.push({ kind: 'wheel', root: rim, members: [{ node: rim, rel: new THREE.Matrix4() }, { node: tyre, rel }],
        body: unionBox(a.body, transformBox(b.body, rel)), full: unionBox(a.full, transformBox(b.full, rel)) });
    }
  }
  // Any other rim and tyre the LDCad shadow library pairs (SNAP_GEN group "rim…",
  // male on the rim, female in the tyre), when they are actually seated together.
  const rimSnaps = (n: PieceNode, gender: 'M' | 'F') => worldSnaps(
    metrics(n.part).snaps?.filter((x) => x.kind === 'gen' && x.gender === gender && /^rim/i.test(x.group ?? '')),
    placementMatrix(n.local).elements);
  const paired = new Set(candidates.flatMap((g) => g.members.map(({ node }) => node.itemId)));
  for (const rim of pieces) {
    if (rim.assembly || paired.has(rim.itemId)) continue;
    const male = rimSnaps(rim, 'M');
    if (!male.length) continue;
    for (const tyre of pieces) {
      if (tyre === rim || tyre.assembly || paired.has(tyre.itemId)) continue;
      const female = rimSnaps(tyre, 'F');
      if (!female.some((f) => male.some((m) => mateAxis(m, f)))) continue;
      const a = metrics(rim.part), b = metrics(tyre.part);
      if (a.placeholder || b.placeholder || !a.mesh?.length || !b.mesh?.length) continue;
      const rel = placementMatrix(rim.local).invert().multiply(placementMatrix(tyre.local));
      candidates.push({ kind: 'wheel', root: rim, members: [{ node: rim, rel: new THREE.Matrix4() }, { node: tyre, rel }],
        body: unionBox(a.body, transformBox(b.body, rel)), full: unionBox(a.full, transformBox(b.full, rel)) });
    }
  }
  // A window pane in its frame (shadow SNAP_FGR group "win…" on the frame; the
  // pane has no connector data and fills the groove). The pane clicks in by
  // flexing, so frame and pane arrive together, like a tyre on its rim.
  for (const frame of pieces) {
    if (frame.assembly || paired.has(frame.itemId)) continue;
    const grooves = worldSnaps(metrics(frame.part).snaps?.filter((x) => x.kind === 'fgr' && /^win/i.test(x.group ?? '')), placementMatrix(frame.local).elements);
    if (!grooves.length) continue;
    for (const pane of pieces) {
      if (pane === frame || pane.assembly || paired.has(pane.itemId) || metrics(pane.part).snaps?.length) continue;
      const b = metrics(pane.part), a = metrics(frame.part);
      if (a.placeholder || b.placeholder || !a.mesh?.length || !b.mesh?.length) continue;
      if (!plugAxes(grooves, transformBox(b.body, placementMatrix(pane.local))).length) continue;
      const rel = placementMatrix(frame.local).invert().multiply(placementMatrix(pane.local));
      candidates.push({ kind: 'window', root: frame, members: [{ node: frame, rel: new THREE.Matrix4() }, { node: pane, rel }],
        body: unionBox(a.body, transformBox(b.body, rel)), full: unionBox(a.full, transformBox(b.full, rel)) });
    }
  }
  // A duplicated/ambiguous candidate must not silently consume another part.
  const counts = new Map<string, number>();
  for (const group of candidates) for (const { node } of group.members) counts.set(node.itemId, (counts.get(node.itemId) ?? 0) + 1);
  return candidates.filter((group) => group.members.every(({ node }) => counts.get(node.itemId) === 1));
}
