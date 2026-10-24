import * as THREE from 'three';
import type { Instance } from '../model/assemble';
import type { KeyframeAnimation } from '../plan/types';
import { valuesAt, trackOf, type ChannelValues } from './keyframes';
import { buildTimeAt } from './buildLayer';
import { poseAt, type Timeline } from './timeline';
import { placedMatrix } from '../ui/modelPlacement';

/** LDraw world coordinates to Three.js viewport space (studs, Y up). */
export const TO_VIEW = new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20);
export const FROM_VIEW = TO_VIEW.clone().invert();

type Group = { members: Instance[]; pivot: THREE.Vector3 };

/** Pivot of the item as the editor displays it, not its imported local origin. */
export function displayPivot(instance: Instance, base: THREE.Matrix4): THREE.Vector3 {
  const original = new THREE.Box3(new THREE.Vector3(...instance.worldBox.min), new THREE.Vector3(...instance.worldBox.max));
  const transform = base.clone().multiply(instance.world.clone().invert());
  return original.applyMatrix4(transform).applyMatrix4(TO_VIEW).getCenter(new THREE.Vector3());
}

/** Location (studs), Euler XYZ (degrees), Scale about a stable display-space pivot. */
export function keyframeDelta(v: ChannelValues, pivot: THREE.Vector3): THREE.Matrix4 {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(v['rotation.x']),
    THREE.MathUtils.degToRad(v['rotation.y']),
    THREE.MathUtils.degToRad(v['rotation.z']), 'XYZ',
  );
  const view = new THREE.Matrix4().makeTranslation(v['location.x'], v['location.y'], v['location.z'])
    .multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(euler))
    .multiply(new THREE.Matrix4().makeScale(v['scale.x'], v['scale.y'], v['scale.z']))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  return FROM_VIEW.clone().multiply(view).multiply(TO_VIEW);
}

const noTransform = (v: ChannelValues) =>
  v['location.x'] === 0 && v['location.y'] === 0 && v['location.z'] === 0 &&
  v['rotation.x'] === 0 && v['rotation.y'] === 0 && v['rotation.z'] === 0 &&
  v['scale.x'] === 1 && v['scale.y'] === 1 && v['scale.z'] === 1;

/**
 * One shared viewport/export sampler. Baked leaf flights take precedence over
 * their generated Build counterpart; unbaked leaves still follow the live source.
 * Parent submodel keys remain non-destructive offsets over BOTH kinds of leaf.
 * All matrices are world LDU; no authored geometry or step data is mutated.
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
  const pivots = new Map<string, THREE.Vector3>();
  for (const inst of instances) {
    pivots.set(inst.key, displayPivot(inst, bases.get(inst.key)!));
    const target = inst.key.split('/')[0];
    const group = groups.get(target) ?? { members: [], pivot: new THREE.Vector3() };
    group.members.push(inst);
    groups.set(target, group);
  }
  const box = new THREE.Box3();
  for (const group of groups.values()) {
    box.makeEmpty();
    for (const inst of group.members) {
      const original = new THREE.Box3(new THREE.Vector3(...inst.worldBox.min), new THREE.Vector3(...inst.worldBox.max));
      const delta = bases.get(inst.key)!.clone().multiply(inst.world.clone().invert());
      box.union(original.applyMatrix4(delta).applyMatrix4(TO_VIEW));
    }
    box.getCenter(group.pivot);
  }
  const baked = new Map(instances.flatMap((inst) => {
    const track = trackOf(animation, editingModel, inst.key);
    return track?.source === 'baked-flight' ? [[inst.key, inst] as const] : [];
  }));
  const result = new Map<string, THREE.Matrix4 | null>();
  const movingBox = new THREE.Box3();
  return (frame: number) => {
    result.clear();
    const buildSeconds = animation ? buildTimeAt(animation, editingModel, frame) : null;
    const buildPose = buildSeconds !== null && buildTimeline
      ? poseAt(buildTimeline, Math.min(buildSeconds, buildTimeline.duration)) : null;
    if (buildSeconds !== null) {
      // A failed linked route is visible as a missing pose, never a false static
      // fallback. Previously baked flights remain independently playable.
      for (const inst of instances) result.set(inst.key, buildPose ? buildPose(inst.key) : null);
    }
    for (const [key] of baked) {
      const v = valuesAt(animation, editingModel, key, frame);
      result.set(key, v.visibility < .5 ? null :
        keyframeDelta(v, pivots.get(key)!).multiply(bases.get(key)!));
    }
    if (!animation?.tracks.length) return result;
    // Parent/group offsets apply after every leaf's animation. For a standalone
    // baked piece the root target IS the leaf key: do not transform it twice.
    for (const [target, group] of groups) {
      const track = trackOf(animation, editingModel, target);
      if (!track || track.source === 'baked-flight') continue;
      const v = valuesAt(animation, editingModel, target, frame);
      if (v.visibility < .5) {
        for (const inst of group.members) result.set(inst.key, null);
        continue;
      }
      if (noTransform(v)) continue;
      // Build + baked piece offsets should rotate about their CURRENT bounds,
      // not the static installed position while they are airborne.
      let pivot = group.pivot;
      if (buildSeconds !== null || [...baked.keys()].some((key) => key.startsWith(`${target}/`))) {
        movingBox.makeEmpty();
        for (const inst of group.members) {
          const current = result.has(inst.key) ? result.get(inst.key) : bases.get(inst.key);
          if (!current) continue;
          const delta = current.clone().multiply(inst.world.clone().invert());
          movingBox.union(new THREE.Box3(new THREE.Vector3(...inst.worldBox.min),
            new THREE.Vector3(...inst.worldBox.max)).applyMatrix4(delta).applyMatrix4(TO_VIEW));
        }
        if (!movingBox.isEmpty()) pivot = movingBox.getCenter(new THREE.Vector3());
      }
      const offset = keyframeDelta(v, pivot);
      for (const inst of group.members) {
        const current = result.has(inst.key) ? result.get(inst.key) : bases.get(inst.key);
        if (current) result.set(inst.key, offset.clone().multiply(current));
      }
    }
    // Nested leaf/submodel tracks are selectable in the Dope Sheet after a
    // flight has been baked. Non-baked nested offsets can also be authored.
    for (const track of animation.tracks) {
      if (track.model !== editingModel || track.source === 'baked-flight' || !track.target.includes('/')) continue;
      const v = valuesAt(animation, editingModel, track.target, frame);
      if (noTransform(v) && v.visibility >= .5) continue;
      for (const inst of instances) {
        if (inst.key !== track.target && !inst.key.startsWith(`${track.target}/`)) continue;
        const current = result.has(inst.key) ? result.get(inst.key) : bases.get(inst.key);
        if (v.visibility < .5) result.set(inst.key, null);
        else if (current) result.set(inst.key, keyframeDelta(v, pivots.get(inst.key)!).multiply(current));
      }
    }
    return result;
  };
}
