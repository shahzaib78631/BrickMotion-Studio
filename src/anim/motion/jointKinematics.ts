/**
 * Exact rigid-body forward kinematics for the constrained FINAL phase of a
 * Standard Motion assembly flight. These operations are geometry-preserving:
 * neither nonuniform part scale nor a reflected/sheared LDraw part basis is
 * decomposed or interpolated here.
 *
 * Shadow connector matches are hints, not hinge-limit, strength, gear-tooth or
 * triangle-mesh certificates. Never use a hint to waive collision checking.
 */
import * as THREE from 'three';
import type { MechanicalJoint } from '../construction/mechanicalConstraintGraph';
import type { KinematicSegment } from '../timelineData';

const PARALLEL = 0.995;
const COAXIAL_LDU = 2;
const BALL_CENTRE_LDU = 1;
const finite3 = (v: readonly number[]): boolean => v.length === 3 && v.every(Number.isFinite);
const isTurning = (j: MechanicalJoint): boolean =>
  (j.type === 'hinge' || j.type === 'clip') && j.motion === 'revolute';
const isBall = (j: MechanicalJoint): boolean =>
  j.type === 'ball-socket' && j.motion === 'ball';
const isInsertion = (j: MechanicalJoint): boolean =>
  ['stud-socket', 'pin-hole', 'axle-hole', 'cylindrical'].includes(j.type);

/**
 * Reject an attractive but impossible joint approach when another connector
 * already fixed to the moving leaf would constrain away that degree of freedom.
 * Several aligned studs can be inserted together; two coaxial hinge barrels
 * can swing together. A second noncoaxial hinge, fixed stud or ball centre
 * cannot arbitrarily follow the first hinge's rotation.
 *
 * This is a conservative mobility test, NOT a full constraint Jacobian: an
 * ambiguous joint is skipped rather than faking articulated motion.
 */
export function jointApproachIsCompatible(primary: MechanicalJoint, moving: string,
  engaged: readonly MechanicalJoint[]): boolean {
  if (primary.male !== moving && primary.female !== moving) return false;
  if (!finite3(primary.axis) || !finite3(primary.centre) ||
      new THREE.Vector3(...primary.axis).lengthSq() < 0.5) return false;
  const axis = new THREE.Vector3(...primary.axis).normalize();
  const centre = new THREE.Vector3(...primary.centre);
  const turning = isTurning(primary), ball = isBall(primary), insertion = isInsertion(primary);
  if (!turning && !ball && !insertion) return false;
  for (const other of engaged) {
    if (other === primary || other.id === primary.id) continue;
    if (other.male !== moving && other.female !== moving ||
        !finite3(other.axis) || !finite3(other.centre)) return false;
    const otherAxis = new THREE.Vector3(...other.axis);
    if (otherAxis.lengthSq() < 0.5) return false;
    otherAxis.normalize();
    if (ball) {
      // One spherical anchor is free to tilt. Two physically distinct ball
      // centres are not free to tilt around just the first one's centre.
      if (!isBall(other) || centre.distanceTo(new THREE.Vector3(...other.centre)) > BALL_CENTRE_LDU)
        return false;
    } else if (turning) {
      if (!isTurning(other) || Math.abs(axis.dot(otherAxis)) < PARALLEL) return false;
      const delta = new THREE.Vector3(...other.centre).sub(centre);
      // Coaxial hinges may have different positions ALONG their common axis.
      if (delta.addScaledVector(axis, -delta.dot(axis)).length() > COAXIAL_LDU) return false;
    } else {
      if (!isInsertion(other) || Math.abs(axis.dot(otherAxis)) < PARALLEL) return false;
      // Aligned multi-stud/multi-pin patterns can slide together even when
      // their connectors are separated sideways in the stud plane.
    }
  }
  return true;
}

/** Interpolate one constrained segment around the FIXED world hinge centre or
 * along an exact world slider axis. Returns false for malformed metadata so
 * playback can safely use its ordinary pose interpolation instead.
 */
export function interpolateJointSegment(from: THREE.Matrix4, segment: KinematicSegment,
  t: number, out: THREE.Matrix4): boolean {
  if (!Number.isInteger(segment.index) || segment.index < 0 ||
      !Number.isFinite(segment.travel) ||
      Math.abs(segment.travel) > (segment.kind === 'revolute' ? Math.PI * 2 : 100000) ||
      !finite3(segment.axis) || !Number.isFinite(t)) return false;
  const axis = new THREE.Vector3(...segment.axis);
  if (axis.lengthSq() < 0.5) return false;
  axis.normalize();
  const travel = segment.travel * Math.max(0, Math.min(1, t));
  out.copy(from);
  if (segment.kind === 'prismatic') {
    out.elements[12] += axis.x * travel;
    out.elements[13] += axis.y * travel;
    out.elements[14] += axis.z * travel;
    return true;
  }
  if (segment.kind !== 'revolute' || !segment.pivot || !finite3(segment.pivot)) return false;
  const [x, y, z] = segment.pivot;
  const rotation = new THREE.Matrix4().makeTranslation(x, y, z)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, travel))
    .multiply(new THREE.Matrix4().makeTranslation(-x, -y, -z));
  out.premultiply(rotation);
  return true;
}
