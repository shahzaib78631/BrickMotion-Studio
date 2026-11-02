import { addCameraKey, type TrackRef } from './ops';
import type { CameraKey } from './types';
import type { Plan } from '../../plan/types';

/**
 * Copy and paste for camera keys. A copied shot keeps every setting it had — target, angle,
 * distance, lens, focus, blur — and the paste keeps the *spacing* of what was copied, so a run
 * of shots can be repeated further along the video. Key ids are never reused: pasting adds new
 * keys, so the originals stay exactly where they were.
 */
let copied: readonly CameraKey[] = [];

/** Keeps a copy of these keys, in time order. Returns how many were copied. */
export function copyCameraKeys(keys: readonly CameraKey[]): number {
  copied = [...keys].sort((a, b) => a.t - b.t);
  return copied.length;
}

/** How many keys are waiting to be pasted. */
export const copiedCameraKeys = (): readonly CameraKey[] => copied;

/** The time span a paste will cover, for a menu label. */
export const copiedSpan = (): number => (copied.length > 1 ? copied[copied.length - 1].t - copied[0].t : 0);

/**
 * Adds the copied keys to a track, the first one landing at `at` seconds, the rest keeping their
 * spacing. Nothing happens with an empty clipboard.
 */
export function pasteCameraKeys(plan: Plan, ref: TrackRef, at: number, fps: number, duration = Infinity): Plan {
  if (!copied.length) return plan;
  const first = copied[0].t;
  let out = plan;
  for (const key of copied) {
    const { id: _id, origin: _origin, t, ...settings } = key;
    const when = Math.max(0, Math.min(duration, at + (t - first)));
    out = addCameraKey(out, ref, { ...settings, t: when }, fps, duration);
  }
  return out;
}

/** For tests and for clearing the clipboard when a project closes. */
export function clearCameraKeyClipboard(): void {
  copied = [];
}
