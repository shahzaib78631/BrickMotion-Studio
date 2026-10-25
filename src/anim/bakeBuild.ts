import * as THREE from 'three';
import type { Instance } from '../model/assemble';
import type { AnimationChannel, KeyframeAnimation, ObjectAnimationTrack } from '../plan/types';
import { buildLayerAt, linkBuildLayer, unlinkBuildLayer } from './buildLayer';
import { FROM_VIEW, TO_VIEW, displayPivot, keyframeDelta } from './keyframePose';
import { simplifyChannel } from './bakeCurves';
export { simplifyChannel } from './bakeCurves';
import { poseAt, type Timeline } from './timeline';
import { placedMatrix } from '../ui/modelPlacement';

export type BakeResult = { animation: KeyframeAnimation; count: number; keys: number; warnings?: string[] };
export type BakeOptions = {
  /** Top-level item ID, full nested use path, or all leaves (undefined). */
  targets?: readonly string[];
  /** Remove the procedural Build only if every leaf has been baked. */
  detach?: boolean;
  /** Use an editable best-effort pose for anomalous affine frames instead of
   * aborting every other part. Report those frames for manual review. */
  bestEffort?: boolean;
};
const TRANSFORMS = [
  'location.x', 'location.y', 'location.z',
  'rotation.x', 'rotation.y', 'rotation.z',
  'scale.x', 'scale.y', 'scale.z',
] as const satisfies readonly AnimationChannel[];
const STUDS_TOLERANCE = 0.004;
const DEGREES_TOLERANCE = 0.04;
const SCALE_TOLERANCE = 0.00002;
const MAX_TOTAL_KEYS = 380000;
const MAX_FRAMES_PER_CHANNEL = 5000;
const MAX_SAMPLED_POSES = 300000;
const MAX_SAMPLES_PER_TRACK = 7000;

const finite = (value: number): number => {
  if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error('Cannot bake a non-finite or unbounded flight transform.');
  return Math.abs(value) < 1e-9 ? 0 : Math.round(value * 1e7) / 1e7;
};

/** Derive the *exact* viewport object offset from a world-space flight matrix.
 * Respect affine LDraw bases: the baked offset is based on desired * inverse(base),
 * never decomposed from a mirrored/sheer part's authored object matrix itself. */
export function offsetForPose(base: THREE.Matrix4, world: THREE.Matrix4, pivot: THREE.Vector3, previous?: readonly number[]): number[] {
  const transform = TO_VIEW.clone().multiply(world).multiply(base.clone().invert()).multiply(FROM_VIEW);
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  transform.decompose(position, quaternion, scale);
  const reconstructed = new THREE.Matrix4().compose(position, quaternion, scale);
  if (transform.elements.some((n, i) => !Number.isFinite(n) || Math.abs(n - reconstructed.elements[i]) > 1e-4))
    throw new Error('One flight contains an unsupported shear or non-rigid transform. It was not baked.');
  const angle = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  const movedPivot = pivot.clone().applyMatrix4(transform).sub(pivot);
  const vals = [
    movedPivot.x, movedPivot.y, movedPivot.z,
    THREE.MathUtils.radToDeg(angle.x), THREE.MathUtils.radToDeg(angle.y), THREE.MathUtils.radToDeg(angle.z),
    scale.x, scale.y, scale.z,
  ].map(finite);
  // Euler XYZ has an equivalent (X+180, 180-Y, Z+180) solution.
  // Choose the nearest representation BEFORE unwrapping, or a 90-degree
  // subassembly turn can suddenly flip X/Z by 180 degrees at gimbal lock.
  if (previous) {
    const candidates = [vals.slice(3, 6), [vals[3] + 180, 180 - vals[4], vals[5] + 180]];
    for (const candidate of candidates) for (let i = 0; i < 3; i++) {
      while (candidate[i] - previous[3 + i] > 180) candidate[i] -= 360;
      while (candidate[i] - previous[3 + i] < -180) candidate[i] += 360;
    }
    const score = (candidate: number[]) => candidate.reduce((sum, value, i) => sum + (value - previous[3 + i]) ** 2, 0);
    const chosen = score(candidates[0]) <= score(candidates[1]) ? candidates[0] : candidates[1];
    for (let i = 0; i < 3; i++) vals[3 + i] = finite(chosen[i]);
  }
  // Fail the transaction if a decomposition cannot be reproduced by the same
  // offset model as playback/export (including its chosen pivot).
  const v = Object.fromEntries([...TRANSFORMS.map((ch, i) => [ch, vals[i]]), ['visibility', 1]]) as Parameters<typeof keyframeDelta>[0];
  const reproduced = keyframeDelta(v, pivot).multiply(base);
  const error = reproduced.elements.reduce((max, n, i) => Math.max(max, Math.abs(n - world.elements[i])), 0);
  if (error > 0.003) throw new Error(`Cannot faithfully bake a flight transform (matrix error ${error.toFixed(4)} LDU).`);
  return vals;
}

/** Candidate frames concentrate on the chosen part's actual flight intervals.
 * A frame before/after each move preserves idle rests without hundreds of keys. */
function relevantFrames(timeline: Timeline, key: string, scene: KeyframeAnimation, start: number, speed: number): number[] {
  const result = new Set([scene.startFrame, scene.endFrame]);
  const tr = timeline.tracks.get(key)!;
  const f = (seconds: number) => start + seconds / speed * scene.fps;
  const add = (n: number) => { if (n >= scene.startFrame && n <= scene.endFrame) result.add(n); };
  const appear = Math.ceil(f(tr.appear) - 1e-8);
  add(appear - 1); add(appear);
  const mechanism = timeline.mechanismStage;
  if (mechanism?.tracks.some((p) => p.key === key)) {
    const lo = Math.ceil(f(mechanism.start)), hi = Math.ceil(f(mechanism.start + mechanism.duration));
    add(lo - 1); add(lo); add(hi); add(hi + 1);
    for (let frame = Math.max(scene.startFrame, lo); frame <= Math.min(scene.endFrame, hi); frame++) add(frame);
  }
  for (const move of tr.moves) {
    const u = timeline.units[move.unit];
    if (!u) throw new Error(`Build timeline has an invalid move reference for ${key}.`);
    const lo = Math.ceil(f(u.start));
    const hi = Math.ceil(f(u.start + u.dur));
    add(lo - 1); add(lo); add(hi); add(hi + 1);
    for (let frame = Math.max(scene.startFrame, lo); frame <= Math.min(scene.endFrame, hi); frame++) add(frame);
  }
  return [...result].sort((a, b) => a - b);
}

/** Bakes one or all planner-generated flights to native, editable object keys.
 * Every leaf retains independent X/Y/Z channels AND step visibility. This is a
 * transactional pure operation: a failure never partially alters a project. */
export function bakeBuildFlights(
  animation: KeyframeAnimation,
  editingModel: string,
  instances: readonly Instance[],
  placements: ReadonlyMap<string, THREE.Matrix4>,
  timeline: Timeline,
  options: BakeOptions = {},
): BakeResult {
  if (!timeline || !Number.isFinite(timeline.duration) || timeline.duration <= 0) throw new Error('A valid generated Build animation is required.');
  if (!instances.length) throw new Error('There are no brick instances to bake.');
  const selected = options.targets ? new Set(options.targets) : null;
  const chosen = instances.filter((inst) => !selected || [...selected].some((id) => inst.key === id || inst.key.startsWith(`${id}/`)));
  if (!chosen.length) throw new Error('Select a visible piece or submodel before baking its Build flight.');
  // Linking first ensures all other, unbaked bricks keep their procedural motion.
  let next = linkBuildLayer(animation, editingModel, timeline.duration);
  const layer = buildLayerAt(next, editingModel)!;
  if (options.detach && chosen.length !== instances.length)
    throw new Error('Bake the entire model before detaching the generated Build.');
  const fresh: ObjectAnimationTrack[] = [];
  const matrices = new Map<number, ReturnType<typeof poseAt>>();
  let total = next.tracks.reduce((sum, track) => sum + Object.values(track.channels).reduce((n, keys) => n + (keys?.length ?? 0), 0), 0);
  let sampledPoses = 0;
  const warnings: string[] = [];
  // This mode must support large per-leaf dope sheets. Keep hard safety limits,
  // but do not inherit the ordinary interactive 2,000-part bake cap.
  const sampleBudget = options.bestEffort ? 1_500_000 : MAX_SAMPLED_POSES;
  const keyBudget = options.bestEffort ? 1_500_000 : MAX_TOTAL_KEYS;
  const trackBudget = options.bestEffort ? 10_000 : 2_000;
  for (const inst of chosen) {
    const source = timeline.tracks.get(inst.key);
    if (!source) throw new Error(`Missing generated flight for ${inst.key}. Replan Build before baking.`);
    const base = placedMatrix(inst, placements);
    const pivot = displayPivot(inst, base);
    const frames = relevantFrames(timeline, inst.key, next, layer.startFrame, layer.speed);
    if (frames.length > MAX_SAMPLES_PER_TRACK) throw new Error(`Flight ${inst.key} exceeds the 7,000-sample/brick processing limit. Shorten the scene or bake a shorter Build.`);
    const values: { frame: number; value: number }[][] = TRANSFORMS.map(() => []);
    let previous: number[] | undefined;
    const visibility: { frame: number; value: number; interpolation: 'constant' }[] = [];
    let lastVisible: number | undefined;
    for (const frame of frames) {
      if (++sampledPoses > sampleBudget) throw new Error(`Bake exceeds the ${sampleBudget.toLocaleString()}-sample safety limit. Shorten the scene or reduce FPS.`);
      let sample = matrices.get(frame);
      if (!sample) {
        const seconds = Math.max(0, Math.min(timeline.duration, (frame - layer.startFrame) / next.fps * layer.speed));
        sample = poseAt(timeline, seconds);
        matrices.set(frame, sample);
      }
      // Preserve not only initial appearance, but any legacy hidden flight
      // intervals. Visibility is evaluated at integer playback/export frames.
      const actual = sample(inst.key);
      const visible = actual ? 1 : 0;
      if (visible !== lastVisible) {
        visibility.push({ frame, value: visible, interpolation: 'constant' });
        lastVisible = visible;
      }
      // An invisible part still retains a harmless independent floor matrix.
      const desired = actual ?? source.floor;
      let converted: number[];
      try { converted = offsetForPose(base, desired, pivot, previous); }
      catch (error) {
        if (!options.bestEffort) throw error;
        if (!warnings.includes(inst.key)) warnings.push(inst.key);
        // A missed sample stays at its previous pose until the user corrects
        // that part's keyframes. Never create NaNs or drop the part's track.
        converted = previous?.slice() ?? [0, 0, 0, 0, 0, 0, 1, 1, 1];
      }
      converted.forEach((value, i) => values[i].push({ frame, value }));
      previous = converted;
    }
    const channels: ObjectAnimationTrack['channels'] = {};
    for (let index = 0; index < TRANSFORMS.length; index++) {
      const channel = TRANSFORMS[index];
      const tolerance = channel.startsWith('location.') ? STUDS_TOLERANCE
        : channel.startsWith('rotation.') ? DEGREES_TOLERANCE : SCALE_TOLERANCE;
      const compressed = simplifyChannel(values[index], tolerance);
      if (compressed.length > MAX_FRAMES_PER_CHANNEL)
        throw new Error(`Flight ${inst.key} exceeds the 5,000-key/channel limit. Reduce the Build length or FPS.`);
      channels[channel] = compressed;
      total += compressed.length;
    }
    // Visibility never interpolates; this includes temporarily hidden units
    // in timelines saved by older planner versions.
    channels.visibility = visibility;
    total += channels.visibility.length;
    if (total > keyBudget) throw new Error(`Bake exceeds the ${keyBudget.toLocaleString()}-key safety budget. Shorten the scene or reduce FPS.`);
    fresh.push({ kind: 'object', source: 'baked-flight', model: editingModel, target: inst.key, channels });
  }
  if (next.tracks.length + fresh.length > trackBudget) {
    const duplicates = fresh.filter((t) => next.tracks.some((old) => old.model === t.model && old.target === t.target));
    if (next.tracks.length + fresh.length - duplicates.length > trackBudget)
      throw new Error(`Bake would exceed the ${trackBudget.toLocaleString()}-track project safety limit.`);
  }
  const replacing = new Set(fresh.map((t) => JSON.stringify([t.model, t.target])));
  next = { ...next, tracks: [...next.tracks.filter((t) => !replacing.has(JSON.stringify([t.model, t.target]))), ...fresh] };
  if (options.detach) next = unlinkBuildLayer(next, editingModel);
  return { animation: next, count: chosen.length, keys: fresh.reduce((n, t) => n + Object.values(t.channels).reduce((sum, keys) => sum + (keys?.length ?? 0), 0), 0), warnings };
}

export const isBakedFlight = (animation: KeyframeAnimation | undefined, model: string, key: string): boolean =>
  !!animation?.tracks.some((t) => t.model === model && t.target === key && t.source === 'baked-flight');
