import * as THREE from 'three';
import type { Instance, Metrics } from '../model/assemble';
import { collisionWorld, type Solid } from '../plan/collision';
import type { AnimationChannel, KeyframeAnimation } from '../plan/types';
import { insertKeys, trackOf, valuesAt, deleteKeys, type KeyRef } from './keyframes';
import { displayPivot } from './keyframePose';

/**
 * A baked piece's flight path as the viewport draws it: where its centre is at each frame
 * it is visible, and a point at each frame that has a location key. All positions are in
 * view space (studs, Y up), the same space as the location channels.
 */
export type PathPoint = { frame: number; at: THREE.Vector3 };
export type FlightPath = { target: string; keys: PathPoint[]; samples: PathPoint[] };

export const LOCATION: readonly AnimationChannel[] = ['location.x', 'location.y', 'location.z'];
/** at most this many samples along one path; longer paths are sampled every few frames */
const MAX_SAMPLES = 1500;

/** Frames with a key on any location channel, sorted. */
export function locationFrames(animation: KeyframeAnimation | undefined, model: string, target: string): number[] {
  const track = trackOf(animation, model, target);
  const frames = new Set<number>();
  for (const ch of LOCATION) for (const key of track?.channels[ch] ?? []) frames.add(key.frame);
  return [...frames].sort((a, b) => a - b);
}

/** The piece's centre at `frame` (view space): the display pivot moved by the location keys. */
export function centreAt(animation: KeyframeAnimation | undefined, model: string, target: string, pivot: THREE.Vector3, frame: number): THREE.Vector3 {
  const v = valuesAt(animation, model, target, frame);
  // the rotation and scale keys turn the piece about this same pivot, so it only moves by the location
  return new THREE.Vector3(pivot.x + v['location.x'], pivot.y + v['location.y'], pivot.z + v['location.z']);
}

const visibleAt = (animation: KeyframeAnimation | undefined, model: string, target: string, frame: number) =>
  valuesAt(animation, model, target, frame).visibility >= 0.5;

/**
 * The drawn path of a baked piece, from its first visible location key to its last. Hidden
 * frames (before the piece appears) are left out. Null when the piece has no location keys.
 */
export function flightPath(animation: KeyframeAnimation | undefined, model: string, inst: Instance, base: THREE.Matrix4): FlightPath | null {
  const target = inst.key;
  const frames = locationFrames(animation, model, target).filter((f) => visibleAt(animation, model, target, f));
  if (!frames.length) return null;
  const pivot = displayPivot(inst, base);
  const keys = frames.map((frame) => ({ frame, at: centreAt(animation, model, target, pivot, frame) }));
  const first = frames[0], last = frames[frames.length - 1];
  const step = Math.max(1, Math.ceil((last - first) / MAX_SAMPLES));
  const samples: PathPoint[] = [];
  for (let f = first; f <= last; f += step) {
    if (visibleAt(animation, model, target, f)) samples.push({ frame: f, at: centreAt(animation, model, target, pivot, f) });
  }
  if (samples[samples.length - 1]?.frame !== last) samples.push({ frame: last, at: centreAt(animation, model, target, pivot, last) });
  return { target, keys, samples };
}

/** The location keys at one frame (what deleting a path point removes). */
export function pathKeyRefs(animation: KeyframeAnimation | undefined, model: string, target: string, frame: number): KeyRef[] {
  const track = trackOf(animation, model, target);
  return LOCATION.filter((ch) => track?.channels[ch]?.some((k) => k.frame === frame))
    .map((channel) => ({ model, target, channel, frame }));
}

/**
 * Every path point keys all three location channels. Baking keys each channel on its own
 * (a straight drop has no X or Z keys at all), so before a point is moved or added the
 * other channels get a key there too, at the value they already have: moving one point
 * then cannot shift the rest of the path.
 */
export function fullPathKeys(animation: KeyframeAnimation, model: string, target: string, extra: readonly number[] = []): KeyframeAnimation {
  const track = trackOf(animation, model, target);
  let next = animation;
  for (const frame of [...new Set([...locationFrames(animation, model, target), ...extra])]) {
    const v = valuesAt(animation, model, target, frame);
    const missing = LOCATION.filter((ch) => !track?.channels[ch]?.some((k) => k.frame === frame));
    if (missing.length) next = insertKeys(next, frame, missing.map((channel) => ({ model, target, channel, value: v[channel] })));
  }
  return next;
}

/** A new path point at `frame`, where the path already runs: the path does not change shape. */
export function addPathKey(animation: KeyframeAnimation, model: string, target: string, frame: number): KeyframeAnimation {
  return fullPathKeys(animation, model, target, [frame]);
}

/** Moves the path point at `frame` to `location` (studs from the seat, view space). */
export function setPathKey(animation: KeyframeAnimation, model: string, target: string, frame: number, location: readonly [number, number, number]): KeyframeAnimation {
  const full = fullPathKeys(animation, model, target, [frame]);
  return insertKeys(full, frame, LOCATION.map((channel, i) => ({ model, target, channel, value: Math.round(location[i] * 1000) / 1000 })));
}

/** Removes the path point at `frame`. The first and last points stay: they hold the start and the seat. */
export function deletePathKey(animation: KeyframeAnimation, model: string, target: string, frame: number): KeyframeAnimation {
  const frames = locationFrames(animation, model, target);
  if (frames.length <= 2 || frame === frames[0] || frame === frames[frames.length - 1]) return animation;
  return deleteKeys(animation, pathKeyRefs(animation, model, target, frame));
}

/** Hands a piece back to the planner: its baked flight keys (and any baked leaves inside it) go. */
export function unbakeFlight(animation: KeyframeAnimation, model: string, target: string): KeyframeAnimation {
  const tracks = animation.tracks.filter((t) => !(t.model === model && t.source === 'baked-flight' &&
    (t.target === target || t.target.startsWith(`${target}/`))));
  return tracks.length === animation.tracks.length ? animation : { ...animation, tracks };
}

/**
 * Frames along the path where the piece is inside another piece that is already built
 * (resting at its seat at that frame). Uses the placement collision world, so studs going
 * into their sockets are fine; the last `near` LDU before the seat are not tested (that is
 * where the piece engages its neighbours).
 */
export function pathHits(
  instances: readonly Instance[],
  poseAt: (frame: number) => ReadonlyMap<string, THREE.Matrix4 | null>,
  bases: ReadonlyMap<string, THREE.Matrix4>,
  metrics: Metrics,
  target: string,
  frames: readonly number[],
  near = 4.5,
): Set<number> {
  const inst = instances.find((i) => i.key === target);
  const seat = bases.get(target);
  const hits = new Set<number>();
  if (!inst || !seat || inst.placeholder) return hits;
  const solid = (i: Instance, m: THREE.Matrix4): Solid => {
    const g = metrics(i.part);
    return { id: i.key, world: m.elements, body: g.body, studs: g.studs, snaps: g.snaps, mesh: g.mesh };
  };
  const others = instances.filter((i) => i.key !== target && !i.placeholder && bases.has(i.key));
  // one world of every other piece at its seat; a hit only counts while that piece is resting there
  const world = collisionWorld(others.map((i) => solid(i, bases.get(i.key)!)));
  const atSeat = (m: THREE.Matrix4 | null | undefined, b: THREE.Matrix4) => !!m && m.elements.every((v, k) => Math.abs(v - b.elements[k]) < 1e-3);
  const s = seat.elements;
  for (const frame of frames) {
    const poses = poseAt(frame);
    const mine = poses.get(target);
    if (!mine) continue;
    const e = mine.elements;
    if (Math.hypot(e[12] - s[12], e[13] - s[13], e[14] - s[14]) < near) continue;
    for (const id of world.hits([solid(inst, mine)], undefined, false)) {
      const other = bases.get(id);
      if (other && atSeat(poses.has(id) ? poses.get(id) : other, other)) { hits.add(frame); break; }
    }
  }
  return hits;
}
