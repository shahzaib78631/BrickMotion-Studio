/** World-rigid deltas used by the Construction V2 staging and replay pipeline.
 * Each delta left-multiplies a part's original world matrix. The yaw is around
 * the vertical LDraw axis; source scale, shear, and reflection are untouched.
 */
import type { Box } from '../../ldraw/flatten';
import type { AssemblySpot } from '../../plan/types';
import { add, centre, point, pos, rigidDelta, sub, transformBox, translation } from './math';
import type { M4, V3 } from './math';

export const UP: V3 = [0, 1, 0];
const LINEAR = [0, 1, 2, 4, 5, 6, 8, 9, 10] as const;

export function sameOrientation(a: readonly number[], b: readonly number[]): boolean {
  return LINEAR.every(k => Math.abs(a[k] - b[k]) < 1e-8);
}
export function isIdentityOrientation(a: readonly number[]): boolean {
  return sameOrientation(a, translation([0, 0, 0]));
}
export function poseMoved(pose: readonly number[], delta: V3): M4 {
  const out = [...pose];
  out[12] += delta[0]; out[13] += delta[1]; out[14] += delta[2];
  return out;
}
/** Transform a world-space translation into the original frame of a yaw delta.
 * The yaw delta must be rigid (orthonormal), NOT a piece's authored matrix. */
export function inverseDirection(pose: readonly number[], v: V3): V3 {
  return [pose[0] * v[0] + pose[1] * v[1] + pose[2] * v[2],
          pose[4] * v[0] + pose[5] * v[1] + pose[6] * v[2],
          pose[8] * v[0] + pose[9] * v[1] + pose[10] * v[2]];
}
export const yawOf = (pose: readonly number[]) => Math.atan2(pose[8], pose[0]);

/** Place the box's world-space centre at (x,z) studs with a specified yaw.
 * Its floor Y is preserved through yaw, and the box bottom rests at `ground`. */
export function fixedBayPose(box: Box, spot: AssemblySpot, ground: number): M4 {
  if (![spot.x, spot.z, spot.angle].every(Number.isFinite))
    throw new Error('Assembly spot coordinates and angle must be finite.');
  const c = centre(box);
  return rigidDelta([spot.x * 20 - c[0], ground - box.max[1], spot.z * 20 - c[2]], c, UP, spot.angle * Math.PI / 180);
}

/** Move a rigid body by setting its centre and world yaw. Useful for flying a
 * staged submodel back to the parent assembly, without rescaling any member. */
export function poseWithCentreAndYaw(box: Box, location: V3, angle: number): M4 {
  const c = centre(box);
  return rigidDelta(sub(location, c), c, UP, angle);
}

/** AABB of the entire rotating body, not just its centre or a marker. */
export function stagedBounds(box: Box, pose: readonly number[]): Box {
  return transformBox(box, pose);
}

/** All points of a rigid body stay inside this sphere for any orientation.
 * Safe for a continuous rotation, not a discrete frame-sampling approximation. */
export function turningSphere(box: Box, pose: readonly number[]): Box {
  const c = point(pose, centre(box));
  const d = sub(box.max, box.min), r = Math.hypot(...d) / 2;
  const half: V3 = [r, r, r];
  return { min: sub(c, half), max: add(c, half) };
}

/** Return the translation offsets expected by the original mesh oracle for a
 * pair of bodies with the SAME world-rigid orientation. */
export function oracleOffsets(a: readonly number[], b: readonly number[], worldDelta: V3) {
  return { a: inverseDirection(a, pos(a)), b: inverseDirection(a, pos(b)), delta: inverseDirection(a, worldDelta) };
}
