import * as THREE from 'three';
import type { Instance } from '../model/assemble';
import type { KeyframeAnimation } from '../plan/types';
import { valuesAt, trackOf } from './keyframes';
import { buildTimeAt } from './buildLayer';
import { poseAt, type Timeline } from './timeline';
import { placedMatrix } from '../ui/modelPlacement';

/** LDraw world coordinates to the Three.js viewport: Y and Z are flipped. */
const TO_VIEW = new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20);
const FROM_VIEW = TO_VIEW.clone().invert();

type Group = { members: Instance[]; pivot: THREE.Vector3 };

/**
 * Pre-computes group pivots in viewport units. Every leaf of a submodel use moves
 * rigidly with its top-level object track. Build-spot preview deltas are part of
 * the base pose, so keyframing never erases/manual-doubles a placed workbench.
 */
export function makeKeyframePose(
  instances: readonly Instance[],
  placements: ReadonlyMap<string, THREE.Matrix4>,
  animation: KeyframeAnimation | undefined,
  editingModel: string,
  buildTimeline: Timeline | null = null,
): (frame: number) => Map<string, THREE.Matrix4 | null> {
  const bases = new Map(instances.map((inst) => [inst.key, placedMatrix(inst, placements)]));
  const groups = new Map<string, Group>();
  for (const inst of instances) {
    const target = inst.key.split('/')[0];
    const group = groups.get(target) ?? { members: [], pivot: new THREE.Vector3() };
    group.members.push(inst);
    groups.set(target, group);
  }
  const box = new THREE.Box3();
  const transformed = new THREE.Box3();
  for (const group of groups.values()) {
    box.makeEmpty();
    for (const inst of group.members) {
      // Instance worldBox is in LDraw, while the renderer operates in view space.
      // Take the original world's AABB through its placement delta, then map to view.
      const originalBox = new THREE.Box3(new THREE.Vector3(...inst.worldBox.min), new THREE.Vector3(...inst.worldBox.max));
      const delta = bases.get(inst.key)!.clone().multiply(inst.world.clone().invert());
      transformed.copy(originalBox).applyMatrix4(delta).applyMatrix4(TO_VIEW);
      box.union(transformed);
    }
    box.getCenter(group.pivot);
  }
  const empty = !animation?.tracks.length;
  const t = new THREE.Matrix4(), to = new THREE.Matrix4(), from = new THREE.Matrix4();
  const rot = new THREE.Matrix4(), scale = new THREE.Matrix4(), delta = new THREE.Matrix4();
  const result = new Map<string, THREE.Matrix4 | null>();
  const pivotBox = new THREE.Box3();
  return (frame: number) => {
    result.clear();
    const buildSeconds = animation ? buildTimeAt(animation, editingModel, frame) : null;
    const buildPose = buildSeconds !== null && buildTimeline ? poseAt(buildTimeline, Math.min(buildSeconds, buildTimeline.duration)) : null;
    if (buildSeconds !== null && !buildTimeline) {
      // A failed/missing procedural Build must not masquerade as a successfully
      // evaluated static pose. The Dope Sheet reports the source error to the user.
      for (const inst of instances) result.set(inst.key, null);
      return result;
    }
    // An invisible brick is an explicit null, NOT a missing key. Otherwise
    // the fallback to its resting pose makes pieces appear before construction.
    if (buildPose) for (const inst of instances) result.set(inst.key, buildPose(inst.key));
    if (empty) return result;
    for (const [target, group] of groups) {
      if (!trackOf(animation, editingModel, target)) continue;
      const v = valuesAt(animation, editingModel, target, frame);
      const identity = v['location.x'] === 0 && v['location.y'] === 0 && v['location.z'] === 0 &&
        v['rotation.x'] === 0 && v['rotation.y'] === 0 && v['rotation.z'] === 0 &&
        v['scale.x'] === 1 && v['scale.y'] === 1 && v['scale.z'] === 1;
      if (identity) continue;
      // With a linked Build base, the pivot follows the built object, rather
      // than staying at its installed location while the piece is flying.
      let pivot = group.pivot;
      if (buildPose) {
        pivotBox.makeEmpty();
        for (const inst of group.members) {
          const matrix = result.get(inst.key);
          if (!matrix) continue;
          const originalBox = new THREE.Box3(new THREE.Vector3(...inst.worldBox.min), new THREE.Vector3(...inst.worldBox.max));
          const moved = matrix.clone().multiply(inst.world.clone().invert());
          pivotBox.union(originalBox.applyMatrix4(moved).applyMatrix4(TO_VIEW));
        }
        if (!pivotBox.isEmpty()) pivot = pivotBox.getCenter(new THREE.Vector3());
      }
      // A Blender-like object transform in viewport coordinates, around its
      // resting origin. Translation is in studs; Euler angles are in degrees.
      t.makeTranslation(v['location.x'], v['location.y'], v['location.z']);
      to.makeTranslation(pivot.x, pivot.y, pivot.z);
      from.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
      rot.makeRotationFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(v['rotation.x']),
        THREE.MathUtils.degToRad(v['rotation.y']),
        THREE.MathUtils.degToRad(v['rotation.z']), 'XYZ',
      ));
      scale.makeScale(v['scale.x'], v['scale.y'], v['scale.z']);
      delta.copy(FROM_VIEW).multiply(t).multiply(to).multiply(rot).multiply(scale).multiply(from).multiply(TO_VIEW);
      for (const inst of group.members) {
        const source = buildPose ? result.get(inst.key) : bases.get(inst.key);
        if (source) result.set(inst.key, delta.clone().multiply(source));
      }
    }
    // Returned matrices are newly allocated per evaluated frame. Do not cache
    // the map reference between calls; caller consumes it synchronously.
    return result;
  };
}
