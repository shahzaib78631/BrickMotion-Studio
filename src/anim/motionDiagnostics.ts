import * as THREE from 'three';
import type { Instance } from '../model/assemble';
import { transformBox } from '../model/assemble';
import type { Box } from '../ldraw/flatten';
import type { KeyframeAnimation } from '../plan/types';
import { buildTimeAt } from './buildLayer';
import { makeKeyframePose } from './keyframePose';
import { poseAt, type Timeline } from './timeline';
import { intersects, sweptIntersects } from './sweptBounds';
import { placedMatrix } from '../ui/modelPlacement';

export type MotionWarning = { frame: number; first: string; second: string; kind: 'possible-overlap' | 'possible-swept-overlap' };
export type MotionReport = {
  warnings: MotionWarning[];
  checkedFrames: number;
  complete: boolean;
  /** This is a conservative AABB advisory, NOT the construction planner's mesh certification. */
  method: 'swept-bounds-advisory';
};
const BOX_SKIN = 0.3;
const LIMIT_WARNINGS = 20;
const PAIR_BUDGET = 1400000;

/** Same world transform on both leaves preserves their relative part geometry.
 * These pairs cannot acquire a NEW collision with each other; this matters for
 * studs that overlap in conservative AABBs inside a rigid subassembly. */
function sameDelta(a: THREE.Matrix4 | null, b: THREE.Matrix4 | null): boolean {
  if (!a || !b) return false;
  return a.elements.every((x, i) => Math.abs(x - b.elements[i]) < 1e-5);
}

function boxesOf(instances: readonly Instance[], poses: ReadonlyMap<string, THREE.Matrix4 | null>): (Box | null)[] {
  return instances.map((inst) => {
    const matrix = poses.get(inst.key);
    if (!matrix) return null;
    return transformBox(inst.worldBox, matrix.clone().multiply(inst.world.clone().invert()));
  });
}

/** Prefer authored frames and their midpoints; also scan the whole range.
 * A sampled broad-phase test is advisory. Anything skipped is flagged incomplete. */
export function checkEditedMotion(
  instances: readonly Instance[],
  placements: ReadonlyMap<string, THREE.Matrix4>,
  animation: KeyframeAnimation,
  model: string,
  buildTimeline: Timeline | null,
  maxFrames = 340,
): MotionReport {
  const active = animation.tracks.filter((t) => t.model === model && Object.values(t.channels).some((keys) => keys?.length));
  const empty: MotionReport = { warnings: [], checkedFrames: 0, complete: true, method: 'swept-bounds-advisory' };
  if (!active.length || instances.length < 2) return empty;
  const span = animation.endFrame - animation.startFrame;
  const dense = new Set<number>([animation.startFrame, animation.endFrame]);
  for (const track of active) for (const list of Object.values(track.channels)) for (const key of list ?? []) {
    dense.add(key.frame); dense.add(Math.min(animation.endFrame, key.frame + 1));
    dense.add(Math.max(animation.startFrame, key.frame - 1));
  }
  const interval = Math.max(1, Math.ceil(span / Math.max(2, maxFrames - 1)));
  for (let f = animation.startFrame; f <= animation.endFrame; f += interval) dense.add(f);
  const all = [...dense].filter((f) => f >= animation.startFrame && f <= animation.endFrame).sort((a, b) => a - b);
  // Deterministic bounded sampling for complex projects. Never report a full pass
  // when sampling or pair comparisons were truncated.
  const stride = Math.max(1, Math.ceil(all.length / maxFrames));
  const frames = all.filter((_, i) => i % stride === 0 || i === all.length - 1);
  const edited = new Set<string>();
  for (const track of active) for (const inst of instances) {
    if (inst.key === track.target || inst.key.startsWith(`${track.target}/`)) edited.add(inst.key);
  }
  const sample = makeKeyframePose(instances, placements, animation, model, buildTimeline);
  const bases = new Map(instances.map((inst) => [inst.key, placedMatrix(inst, placements)]));
  const inverses = instances.map((inst) => bases.get(inst.key)!.clone().invert());
  const warnings: MotionWarning[] = [];
  const seen = new Set<string>();
  let tests = 0, checked = 0, complete = stride === 1;
  let last: (Box | null)[] | null = null;
  let lastReference: (Box | null)[] | null = null;
  for (const frame of frames) {
    const output = sample(frame);
    // A sampler's empty map means 'use placed resting matrix'. An explicit null
    // means 'hidden', and must never be interpreted as an unedited/resting piece.
    const poses = new Map(instances.map((inst) => [inst.key, output.has(inst.key) ? output.get(inst.key)! : bases.get(inst.key)!]));
    const current = boxesOf(instances, poses);
    const deltas = instances.map((inst, i) => poses.get(inst.key)?.clone().multiply(inverses[i]) ?? null);
    const time = buildTimeAt(animation, model, frame);
    const baseline = time !== null && buildTimeline ? poseAt(buildTimeline, time) : null;
    const reference = baseline ? boxesOf(instances, new Map(instances.map((inst) => [inst.key, baseline(inst.key)]))) : null;
    checked++;
    for (let i = 0; i < instances.length; i++) {
      if (!current[i]) continue;
      for (let j = i + 1; j < instances.length; j++) {
        if (!edited.has(instances[i].key) && !edited.has(instances[j].key)) continue;
        if (sameDelta(deltas[i], deltas[j])) continue;
        if (++tests > PAIR_BUDGET) { complete = false; break; }
        if (!current[j]) continue;
        const overlap = intersects(current[i]!, current[j]!, BOX_SKIN);
        const swept = !!last?.[i] && !!last?.[j] && sweptIntersects(last[i]!, current[i]!, last[j]!, current[j]!, BOX_SKIN);
        if (!overlap && !swept) continue;
        // Do not report overlaps already present in the generated route at the
        // same frame. This avoids treating normal LEGO mating as a new collision.
        const wasOverlap = !!reference?.[i] && !!reference?.[j] && intersects(reference[i]!, reference[j]!, BOX_SKIN);
        const wasSwept = !!lastReference?.[i] && !!lastReference?.[j] && !!reference?.[i] && !!reference?.[j]
          && sweptIntersects(lastReference[i]!, reference[i]!, lastReference[j]!, reference[j]!, BOX_SKIN);
        if ((overlap && wasOverlap) || (!overlap && swept && wasSwept)) continue;
        // An installed, unchanged pair may share volume in rough part AABBs.
        // This is expected for interlocking LEGO studs and isn't an edited path.
        if (!baseline && !last && overlap) continue;
        const kind = overlap ? 'possible-overlap' : 'possible-swept-overlap';
        const pair = `${instances[i].key}|${instances[j].key}|${kind}`;
        if (!seen.has(pair)) {
          seen.add(pair);
          warnings.push({ frame, first: instances[i].key, second: instances[j].key, kind });
        }
        if (warnings.length >= LIMIT_WARNINGS) { complete = false; break; }
      }
      if (tests > PAIR_BUDGET || warnings.length >= LIMIT_WARNINGS) break;
    }
    last = current; lastReference = reference;
    if (tests > PAIR_BUDGET || warnings.length >= LIMIT_WARNINGS) break;
  }
  // Even dense frame samples cannot certify rotated paths or part mesh contact.
  // 'complete' means the selected broad-phase sample budget was not truncated.
  return { warnings, checkedFrames: checked, complete, method: 'swept-bounds-advisory' };
}
