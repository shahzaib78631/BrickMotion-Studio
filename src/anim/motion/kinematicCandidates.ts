/** Connector-guided assembly *candidates*, not articulated-body dynamics.
 * All paths start at the staging pose and end at the exact authored LDraw pose.
 * A joint constrains the LAST phase of the approach. The free flight into
 * that constrained phase remains a visual estimate for manual keyframing.
 */
import * as THREE from 'three';
import type { Box } from '../../ldraw/flatten';
import { transformBox } from '../../model/assemble';
import type { MechanicalJoint } from '../construction/mechanicalConstraintGraph';
import type { Move } from '../timeline';
import type { Unit } from '../timelineData';

const CLEARANCE = 50;
const POS = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
export type MotionCandidate = {
  poses: THREE.Matrix4[];
  motion: NonNullable<Unit['motion']>;
  /** Installed joint partner. */
  host?: string;
  /** Prefer connector-informed paths over equally clear generic flights. */
  preference: number;
};
const shifted = (pose: THREE.Matrix4, offset: THREE.Vector3) =>
  new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z).multiply(pose);
const elevated = (pose: THREE.Matrix4, sky: number) =>
  shifted(pose, new THREE.Vector3(0, sky - pose.elements[13], 0));
const swung = (pose: THREE.Matrix4, joint: MechanicalJoint, angle: number, axis?: THREE.Vector3) => {
  const pivot = new THREE.Vector3(...joint.centre);
  const turn = axis ?? new THREE.Vector3(...joint.axis).normalize();
  return new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(turn, angle))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(pose);
};
const validJoint = (j: MechanicalJoint) =>
  [...j.axis, ...j.centre, j.engagement].every(Number.isFinite) &&
  new THREE.Vector3(...j.axis).lengthSq() > 0.5;

/** At least two alternative approach signs are important around crowded models. */
export function mechanicalApproaches(move: Move, joint: MechanicalJoint, movingKey: string): MotionCandidate[] {
  if (!validJoint(joint) || move.stationary || move.rel || move.rigidDeltas?.length) return [];
  const sky = Math.min(move.skyY, move.from.elements[13] - CLEARANCE, move.to.elements[13] - CLEARANCE);
  if (!Number.isFinite(sky)) return [];
  const axis = new THREE.Vector3(...joint.axis).normalize();
  const host = joint.male === movingKey ? joint.female : joint.male;
  const start = move.from.clone(), dest = move.to.clone();
  if (joint.type === 'hinge' || joint.type === 'clip' || joint.type === 'ball-socket') {
    // Hinges and clips can swing about their connector axis. A ball-joint
    // tilts around a perpendicular tangent through the ball centre.
    let rotationAxis = axis;
    if (joint.type === 'ball-socket') {
      const radial = POS(dest).sub(new THREE.Vector3(...joint.centre));
      rotationAxis = radial.lengthSq() > 1e-6 ? radial.normalize().cross(axis).normalize() :
        new THREE.Vector3(1, 0, 0).cross(axis).normalize();
      if (rotationAxis.lengthSq() < .5) rotationAxis = new THREE.Vector3(0, 0, 1);
    }
    const angle = joint.type === 'hinge' ? Math.PI * 0.42 : joint.type === 'clip' ? Math.PI * 0.28 : Math.PI * 0.20;
    return [-1, 1].map((sign): MotionCandidate => {
      const a = angle * sign;
      const open = swung(dest, joint, a, rotationAxis);
      return { motion: joint.type, host, preference: -1.5, poses: [
        start.clone(), elevated(start, sky), elevated(open, sky), open,
        swung(dest, joint, a * 0.70, rotationAxis),
        swung(dest, joint, a * 0.37, rotationAxis),
        swung(dest, joint, a * 0.12, rotationAxis), dest.clone(),
      ] };
    });
  }
  if (!['pin-hole', 'axle-hole', 'cylindrical', 'stud-socket'].includes(joint.type)) return [];
  const depth = Math.min(70, Math.max(24, joint.engagement + 20));
  // Keyed axles and studs must NOT screw into their destination. Only round
  // pins and round cylindrical joints admit a small axial correction.
  const twist = joint.type === 'pin-hole' ? Math.PI / 7 : joint.type === 'cylindrical' ? Math.PI / 9 : 0;
  return [-1, 1].map((sign): MotionCandidate => {
    const offset = axis.clone().multiplyScalar(depth * sign);
    const prep = shifted(swung(dest, joint, sign * twist), offset);
    const middle = shifted(swung(dest, joint, sign * twist * .35), offset.clone().multiplyScalar(.35));
    return { motion: joint.type, host, preference: -1.2, poses: [
      start.clone(), elevated(start, sky), elevated(prep, sky), prep, middle, dest.clone(),
    ] };
  });
}

/** Four optional non-joint approaches. Used only if Standard's default path is
 * visibly obstructed in the advisory broad phase. Never moves final parts. */
export function clearanceApproaches(move: Move, extent: number): MotionCandidate[] {
  if (move.stationary || move.rel || move.rigidDeltas?.length) return [];
  const sky = Math.min(move.skyY, move.from.elements[13] - CLEARANCE, move.to.elements[13] - CLEARANCE);
  const distance = Math.max(30, Math.min(90, extent * 1.2 + 15));
  return [[distance, 0, 0], [-distance, 0, 0], [0, 0, distance], [0, 0, -distance]].map(([x, y, z]): MotionCandidate => {
    const near = shifted(move.to, new THREE.Vector3(x, y, z));
    return { motion: 'clearance-route', preference: 0.5, poses: [
      move.from.clone(), elevated(move.from, sky), elevated(near, sky), near, move.to.clone(),
    ] };
  });
}

/**
 * Topology-guided, but NOT connector-certified, approach to an installed part.
 * A bridge joint (one leg → hips → other leg) should close from the OPEN SIDE,
 * not lower the hips through the free leg. This route works when Shadow
 * connectors have not been downloaded: host and target world poses suffice.
 *
 * The approach is translated, never falsely rotates a keyed joint. Both sides
 * are offered to the obstruction scorer; it can reject the preferred side when
 * something else is there. Unlike a connector mate, this is a visual proposal.
 */
export function connectionApproaches(move: Move, movingBox: {min: number[]; max: number[]},
  hostBox: {min: number[]; max: number[]}, horizontalHinge = false): MotionCandidate[] {
  if (move.stationary || move.rel || move.rigidDeltas?.length) return [];
  const dest = move.to.clone(), start = move.from.clone();
  const target = [0, 1, 2].map(k => (movingBox.min[k] + movingBox.max[k]) / 2);
  const fixed = [0, 1, 2].map(k => (hostBox.min[k] + hostBox.max[k]) / 2);
  const delta = new THREE.Vector3(target[0] - fixed[0], target[1] - fixed[1], target[2] - fixed[2]);
  // Side-clipped pieces such as minifigure hip/leg pins join primarily along
  // the shared model's local X axis, even when their centres differ in height.
  const side = new THREE.Vector3(dest.elements[0], dest.elements[1], dest.elements[2]);
  const normal = horizontalHinge && side.lengthSq() > 0.25 ? side.normalize() : delta.lengthSq() > 1
    ? delta.normalize() : new THREE.Vector3(1, 0, 0);
  const outward = delta.dot(normal) < 0 ? normal.multiplyScalar(-1) : normal;
  const extent = Math.max(...[0,1,2].map(k => movingBox.max[k] - movingBox.min[k]));
  const distance = Math.max(28, Math.min(72, extent * 1.5 + 14));
  const sky = Math.min(move.skyY, start.elements[13] - CLEARANCE, dest.elements[13] - CLEARANCE);
  return [1, -1].map((sign): MotionCandidate => {
    const offset = outward.clone().multiplyScalar(sign * distance);
    const prep = shifted(dest, offset);
    return { motion: 'clearance-route', preference: sign > 0 ? -0.8 : 0.8,
      poses: [start.clone(), elevated(start, sky), elevated(prep, sky), prep,
        shifted(dest, offset.clone().multiplyScalar(0.67)),
        shifted(dest, offset.clone().multiplyScalar(0.25)), dest.clone()] };
  });
}

/**
 * Obstacle-sized, rigid-translation detours for ordinary free leaves. Fixed
 * 30-90 LDU sidesteps are too short around tall towers, walls and long beams.
 * Move above the local obstacle envelope, then approach the exact destination
 * from one of six open faces. Score every candidate against the timed scene;
 * none of these suggestions bypasses the collision reviewer.
 *
 * Matrix multiplication preserves the part's authored shear/reflection. Only
 * the flight's free-air phase may rotate to its final orientation.
 */
export function adaptiveClearanceApproaches(move: Move, body: Box,
  obstacles: readonly Box[]): MotionCandidate[] {
  if (move.stationary || move.rel || move.rigidDeltas?.length) return [];
  const from = move.from.clone(), dest = move.to.clone();
  const goal = transformBox(body, dest), start = transformBox(body, from);
  const extent = Math.max(...[0, 1, 2].map(k => Math.max(start.max[k] - start.min[k], goal.max[k] - goal.min[k])));
  const margin = Math.max(12, Math.min(28, extent * 0.25));
  // Only overhead obstacles between launch and landing determine cruise
  // altitude. A tower far across the scene must not send this brick skyward.
  const corridor = { min: [Math.min(start.min[0], goal.min[0]), Math.min(start.min[2], goal.min[2])],
    max: [Math.max(start.max[0], goal.max[0]), Math.max(start.max[2], goal.max[2])] };
  let top = Infinity;
  for (const b of obstacles) {
    if (b.min[0] < corridor.max[0] + margin && b.max[0] > corridor.min[0] - margin &&
        b.min[2] < corridor.max[1] + margin && b.max[2] > corridor.min[1] - margin)
      top = Math.min(top, b.min[1]);
  }
  const below = Math.max(start.max[1] - from.elements[13], goal.max[1] - dest.elements[13]);
  const sky = Math.min(move.skyY, from.elements[13] - 48, dest.elements[13] - 48,
    Number.isFinite(top) ? top - below - margin : Infinity);
  const candidates: MotionCandidate[] = [];
  // The cheapest successful solution is often simply going OVER the obstacle,
  // without adding an unnecessary side insertion.
  candidates.push({ motion: 'clearance-route', preference: 0.4,
    poses: [from.clone(), elevated(from, sky), elevated(dest, sky), dest.clone()] });

  // Side approach distances are sized using neighboring geometry, not a
  // constant. The swept checker decides whether the chosen face is actually
  // open. Keep a 600-LDU cap so malformed giant bounds cannot explode paths.
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [0, -1, 0], [0, 1, 0], [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]];
  const minimum = Math.max(34, extent * 1.15 + margin);
  for (const [x, y, z] of dirs) {
    const axis = x ? 0 : y ? 1 : 2;
    const sign = [x, y, z][axis];
    let distance = minimum;
    for (const b of obstacles) {
      // Only a wall in the immediate insertion neighborhood matters for
      // calculating a face-clearance distance. Far walls are tested later.
      if (![0, 1, 2].every(k => b.min[k] < goal.max[k] + margin &&
        b.max[k] > goal.min[k] - margin)) continue;
      distance = Math.max(distance, sign > 0
        ? b.max[axis] - goal.min[axis] + margin
        : goal.max[axis] - b.min[axis] + margin);
    }
    distance = Math.min(600, distance);
    const unit = new THREE.Vector3(x, y, z).normalize().multiplyScalar(distance);
    const prep = shifted(dest, unit);
    candidates.push({ motion: 'clearance-route', preference: 0.6,
      poses: [from.clone(), elevated(from, sky), elevated(prep, sky), prep, dest.clone()] });
  }
  return candidates;
}
