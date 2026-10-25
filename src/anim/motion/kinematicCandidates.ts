/** Connector-guided assembly *candidates*, not articulated-body dynamics.
 * All paths start at the staging pose and end at the exact authored LDraw pose.
 * A joint constrains the LAST phase of the approach. The free flight into
 * that constrained phase remains a visual estimate for manual keyframing.
 */
import * as THREE from 'three';
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
