import { beforeEach, describe, expect, it } from 'vitest';
import { addCameraKey, trackOf, type TrackRef } from '../../src/anim/cameraTrack/ops';
import { clearCameraKeyClipboard, copiedCameraKeys, copyCameraKeys, copiedSpan, pasteCameraKeys } from '../../src/anim/cameraTrack/clipboard';
import type { CameraKey } from '../../src/anim/cameraTrack/types';
import type { Plan } from '../../src/plan/types';

const ref: TrackRef = { model: '', clock: 'build' };
const settings = (t: number, azimuth: number): Omit<CameraKey, 'id' | 'origin'> => ({
  t, target: { kind: 'model' }, offset: [0, 0, 0], azimuth, elevation: 30,
  distance: { fit: true, margin: 1.1 }, roll: 0, lensMm: 50, focus: 'target', blur: 0,
});
/** a plan with three shots at 1 s, 3 s and 6 s */
const withTrack = (): Plan => {
  let plan: Plan = { format: 'brickmotion-plan', version: 1, name: 't', steps: [] } as Plan;
  for (const [t, azimuth] of [[1, 10], [3, 40], [6, 70]] as const) plan = addCameraKey(plan, ref, settings(t, azimuth), 30, 30);
  return plan;
};
const keysOf = (plan: Plan): CameraKey[] => trackOf(plan, ref)?.keys ?? [];

describe('copying camera keyframes', () => {
  beforeEach(() => clearCameraKeyClipboard());

  it('pastes the shots at the same spacing, with every setting kept', () => {
    const plan = withTrack();
    const [first, second] = keysOf(plan);
    expect(copyCameraKeys([second, first])).toBe(2);      // copied out of order, pasted in time order
    expect(copiedSpan()).toBe(2);                          // 1 s → 3 s

    const pasted = pasteCameraKeys(plan, ref, 10, 30, 30);
    const keys = keysOf(pasted);
    expect(keys).toHaveLength(5);
    const added = keys.filter((k) => !keysOf(plan).some((old) => old.id === k.id));
    expect(added.map((k) => k.t)).toEqual([10, 12]);
    // the shots keep what they were: angle here, and the lens/focus/blur/target fields
    expect(added.map((k) => k.azimuth)).toEqual([10, 40]);
    expect(added.map((k) => k.lensMm)).toEqual([50, 50]);
    // and the originals are untouched
    expect(keysOf(pasted).slice(0, 3).map((k) => [k.id, k.t])).toEqual(keysOf(plan).map((k) => [k.id, k.t]));
  });

  it('keeps a paste inside the video', () => {
    const plan = withTrack();
    copyCameraKeys(keysOf(plan));
    const added = keysOf(pasteCameraKeys(plan, ref, 29, 30, 30)).slice(3).map((k) => k.t);
    expect(added[0]).toBeCloseTo(29, 6);
    // the rest keep their spacing but never run past the end of the video
    expect(added.every((t) => t <= 30 + 1e-6)).toBe(true);
    expect(added[1]).toBeGreaterThan(added[0]);
  });

  it('does nothing with an empty clipboard', () => {
    const plan = withTrack();
    expect(copiedCameraKeys()).toHaveLength(0);
    expect(pasteCameraKeys(plan, ref, 5, 30, 30)).toBe(plan);
  });
});
