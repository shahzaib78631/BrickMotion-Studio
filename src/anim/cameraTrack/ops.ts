/**
 * Pure edits of a Camera track inside the plan. Each returns a new plan (the input is
 * never changed), so every edit is one undo step through `useStudio.apply`.
 * Invariant: keys sorted by unique time, exactly one move between each pair of keys.
 */
import type { Plan } from '../../plan/types';
import { DEFAULT_TRANSITION, applyPreset, endKeyForPreset, type TransitionPreset } from './presets';
import type { CameraClock, CameraKey, CameraTrack, CameraTransition } from './types';

export type TrackRef = { model: string; clock: CameraClock };

const EMPTY: CameraTrack = { keys: [], transitions: [], shutter: 0.5 };
let counter = 0;
export const newKeyId = () => `cam-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function trackOf(p: Plan, ref: TrackRef): CameraTrack | undefined {
  return p.cameraTracks?.[ref.model]?.[ref.clock];
}

function withTrack(p: Plan, ref: TrackRef, track: CameraTrack): Plan {
  const all = p.cameraTracks ?? {};
  return { ...p, cameraTracks: { ...all, [ref.model]: { ...all[ref.model], [ref.clock]: track } } };
}

const glide = (from: string, to: string): CameraTransition =>
  ({ from, to, preset: 'glide', settings: structuredClone(DEFAULT_TRANSITION), origin: 'user' });

/**
 * Sorts keys and rebuilds the moves between neighbours. A pair that already had a move
 * keeps it; a new pair takes the move that used to leave its first key, else the one that
 * used to arrive at its second key, else a glide (so a key splitting a move keeps it on both sides).
 */
export function relink(keys: CameraKey[], old: CameraTransition[]): CameraTransition[] {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const out: CameraTransition[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i].id, to = sorted[i + 1].id;
    const same = old.find((t) => t.from === from && t.to === to);
    const leaving = old.find((t) => t.from === from);
    const arriving = old.find((t) => t.to === to);
    const src = same ?? leaving ?? arriving;
    out.push(src ? { ...src, from, to, settings: structuredClone(src.settings) } : glide(from, to));
  }
  return out;
}

function finish(p: Plan, ref: TrackRef, track: CameraTrack, keys: CameraKey[], transitions = track.transitions): Plan {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  return withTrack(p, ref, { ...track, keys: sorted, transitions: relink(sorted, transitions) });
}

/** A time no other key has: nudged by one frame away from any key it would land on. */
function freeTime(keys: CameraKey[], t: number, fps: number, duration: number, except?: string): number {
  const step = 1 / Math.max(1, fps);
  let at = Math.min(Math.max(0, t), duration);
  const taken = (v: number) => keys.some((k) => k.id !== except && Math.abs(k.t - v) < step / 2);
  for (let n = 0; taken(at) && n < 10000; n++) at = at - step >= 0 ? at - step : at + step;
  return at;
}

export function addCameraKey(p: Plan, ref: TrackRef, key: Omit<CameraKey, 'id' | 'origin'>, fps: number, duration = Infinity): Plan {
  const track = trackOf(p, ref) ?? EMPTY;
  const k: CameraKey = { ...structuredClone(key), id: newKeyId(), origin: 'user', t: freeTime(track.keys, key.t, fps, duration) };
  return finish(p, ref, track, [...track.keys, k]);
}

export function updateCameraKey(p: Plan, ref: TrackRef, id: string, patch: Partial<Omit<CameraKey, 'id'>>): Plan {
  const track = trackOf(p, ref);
  if (!track) return p;
  return finish(p, ref, track, track.keys.map((k) => (k.id === id ? { ...k, ...patch, id, origin: 'user' as const } : k)));
}

export function moveCameraKey(p: Plan, ref: TrackRef, id: string, t: number, fps: number, duration: number): Plan {
  const track = trackOf(p, ref);
  if (!track) return p;
  const at = freeTime(track.keys, t, fps, duration, id);
  const keys = track.keys.map((k) => (k.id === id ? { ...k, t: at, origin: 'user' as const } : k));
  // a key that changes place in the order starts new pairs: the moves follow the keys' new neighbours
  const order = (ks: CameraKey[]) => [...ks].sort((a, b) => a.t - b.t).map((k) => k.id).join();
  const transitions = order(keys) === order(track.keys) ? track.transitions : track.transitions.filter((tr) => tr.from !== id && tr.to !== id);
  return finish(p, ref, track, keys, transitions);
}

export function deleteCameraKey(p: Plan, ref: TrackRef, id: string): Plan {
  const track = trackOf(p, ref);
  if (!track) return p;
  // the move arriving at the deleted key carries on to the next key
  const transitions = track.transitions.filter((tr) => tr.from !== id);
  return finish(p, ref, track, track.keys.filter((k) => k.id !== id), transitions);
}

/** Deletes several keys at once (one undo step); the moves left close up as with one key. */
export function deleteCameraKeys(p: Plan, ref: TrackRef, ids: readonly string[]): Plan {
  const track = trackOf(p, ref);
  if (!track || !ids.length) return p;
  const gone = new Set(ids);
  return finish(p, ref, track, track.keys.filter((k) => !gone.has(k.id)), track.transitions.filter((tr) => !gone.has(tr.from)));
}

/** Sets the same values on several keys; each becomes the user's. */
export function updateCameraKeys(p: Plan, ref: TrackRef, ids: readonly string[], patch: Partial<Omit<CameraKey, 'id' | 't'>>): Plan {
  const track = trackOf(p, ref);
  if (!track || !ids.length) return p;
  const set = new Set(ids);
  return finish(p, ref, track, track.keys.map((k) => (set.has(k.id) ? { ...k, ...structuredClone(patch), id: k.id, t: k.t, origin: 'user' as const } : k)));
}

/**
 * Moves several keys by `dt` seconds together, keeping their spacing. The shift stops at the
 * start and end of the video; a key landing on another is nudged by a frame.
 */
export function moveCameraKeys(p: Plan, ref: TrackRef, ids: readonly string[], dt: number, fps: number, duration: number): Plan {
  const track = trackOf(p, ref);
  if (!track || !ids.length) return p;
  const set = new Set(ids);
  const moving = track.keys.filter((k) => set.has(k.id));
  if (!moving.length) return p;
  const lo = -Math.min(...moving.map((k) => k.t)), hi = duration - Math.max(...moving.map((k) => k.t));
  const shift = Math.min(hi, Math.max(lo, dt));
  const placed = track.keys.filter((k) => !set.has(k.id));
  for (const k of moving) placed.push({ ...k, t: freeTime(placed, k.t + shift, fps, duration), origin: 'user' });
  const order = (ks: CameraKey[]) => [...ks].sort((a, b) => a.t - b.t).map((k) => k.id).join();
  // keys that change place start new pairs; a move between two keys moved together stays
  const transitions = order(placed) === order(track.keys) ? track.transitions
    : track.transitions.filter((tr) => (set.has(tr.from) && set.has(tr.to)) || (!set.has(tr.from) && !set.has(tr.to)));
  return finish(p, ref, track, placed, transitions);
}

export function setTransition(p: Plan, ref: TrackRef, fromId: string, patch: Partial<Omit<CameraTransition, 'from' | 'to'>>): Plan {
  const track = trackOf(p, ref);
  if (!track) return p;
  const transitions = track.transitions.map((tr) => (tr.from === fromId ? { ...tr, ...patch, from: tr.from, to: tr.to, origin: 'user' as const } : tr));
  return withTrack(p, ref, { ...track, transitions });
}

/**
 * Chooses a preset for the move leaving key `fromId`: its settings, and (for presets that are
 * a move, like Orbit or Push in) its end key set from the start key, so the camera does what
 * the preset says. One plan change, so one undo step. `distance` ≈ how far the camera is.
 */
export function choosePreset(p: Plan, ref: TrackRef, fromId: string, preset: TransitionPreset, distance: number): Plan {
  const track = trackOf(p, ref);
  const tr = track?.transitions.find((x) => x.from === fromId);
  if (!track || !tr) return p;
  const next = applyPreset(tr, preset);
  let out = setTransition(p, ref, fromId, { preset: next.preset, settings: next.settings });
  const a = track.keys.find((k) => k.id === tr.from), b = track.keys.find((k) => k.id === tr.to);
  const view = a && b ? endKeyForPreset(a, b, preset, distance) : null;
  if (b && view) out = updateCameraKey(out, ref, b.id, view);
  return out;
}

/** Sets the whole track (Auto-direct's merged result, or clearing with an empty one). */
export function replaceAutoTrack(p: Plan, ref: TrackRef, track: CameraTrack): Plan {
  return finish(p, ref, track, track.keys, track.transitions);
}

/** Changes track-wide values (shutter, style). */
export function setTrackOptions(p: Plan, ref: TrackRef, patch: Partial<Pick<CameraTrack, 'shutter' | 'style'>>): Plan {
  return withTrack(p, ref, { ...(trackOf(p, ref) ?? EMPTY), ...patch });
}
