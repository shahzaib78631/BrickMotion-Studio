import * as THREE from 'three';
import type { Instance } from '../../model/assemble';
import type { KeyframeAnimation } from '../../plan/types';
import { animationOf } from '../keyframes';
import { bakeBuildFlights, type BakeResult } from '../bakeBuild';
import { unlinkBuildLayer } from '../buildLayer';
import type { Timeline } from '../timeline';

/**
 * Fill every unkeyed leaf with native Location / Rotation / Scale / Visibility
 * keyframes, preserving corrections already in the Dope Sheet. Generates keys
 * once on opening Standard Motion in Timeline; it never overwrites edited keys.
 * Re-baking existing tracks remains a deliberate editor action.
 */
export function missingMotionKeyTargets(animation: KeyframeAnimation | undefined,
  editingModel: string, instances: readonly Instance[]): string[] {
  const tracks = new Set(animation?.tracks.filter(t => t.model === editingModel).map(t => t.target) ?? []);
  return instances.map(i => i.key).filter(key => !tracks.has(key));
}

export function fillMotionKeyframes(animation: KeyframeAnimation | undefined,
  editingModel: string, instances: readonly Instance[],
  placements: ReadonlyMap<string, THREE.Matrix4>, timeline: Timeline): BakeResult {
  const current = animationOf(animation);
  const missing = missingMotionKeyTargets(current, editingModel, instances);
  if (!missing.length) return { animation: current, count: 0, keys: 0 };
  const baked = bakeBuildFlights(current, editingModel, instances, placements, timeline,
    { targets: missing, bestEffort: true });
  // Only detach when EVERY leaf owns an independent baked flight. A pre-existing
  // manual (non-baked) key track may still depend on the procedural Build base.
  const bakedLeaves = new Set(baked.animation.tracks.filter(t =>
    t.model === editingModel && t.source === 'baked-flight').map(t => t.target));
  const detached = instances.every(i => bakedLeaves.has(i.key))
    ? unlinkBuildLayer(baked.animation, editingModel) : baked.animation;
  return { ...baked, animation: detached };
}
