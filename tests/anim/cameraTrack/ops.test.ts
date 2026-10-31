import { describe, expect, it } from 'vitest';
import { addCameraKey, choosePreset, deleteCameraKey, deleteCameraKeys, moveCameraKeys, updateCameraKeys, moveCameraKey, replaceAutoTrack, setTransition, trackOf, updateCameraKey } from '../../../src/anim/cameraTrack/ops';
import { DEFAULT_TRANSITION, presetById } from '../../../src/anim/cameraTrack/presets';
import type { CameraKey, CameraTrack } from '../../../src/anim/cameraTrack/types';
import type { Plan } from '../../../src/plan/types';

const ref = { model: '', clock: 'build' as const };
const plan = (): Plan => ({ format: 'brickmotion-plan', version: 1, name: 'x', steps: [] });
const keyAt = (t: number, azimuth = 0): Omit<CameraKey, 'id' | 'origin'> => ({
  t, target: { kind: 'model' }, offset: [0, 0, 0], azimuth, elevation: 30, distance: { fit: true, margin: 1.1 },
  roll: 0, lensMm: 50, focus: 0.5, blur: 0,
});
const deepFreeze = <T,>(o: T): T => { Object.freeze(o); for (const v of Object.values(o as object)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); return o; };
const three = () => [0, 5, 2].reduce((p, t) => addCameraKey(p, ref, keyAt(t, t * 10), 30), plan());

describe('camera track ops', () => {
  it('adds keys sorted, by hand, with one move between each pair', () => {
    const tr = trackOf(three(), ref)!;
    expect(tr.keys.map((k) => k.t)).toEqual([0, 2, 5]);
    expect(tr.keys.every((k) => k.origin === 'user')).toBe(true);
    expect(tr.transitions).toHaveLength(2);
    expect(tr.transitions.map((x) => [x.from, x.to])).toEqual([[tr.keys[0].id, tr.keys[1].id], [tr.keys[1].id, tr.keys[2].id]]);
  });
  it('a key splitting a move keeps that move on both sides', () => {
    let p = [0, 4].reduce((q, t) => addCameraKey(q, ref, keyAt(t), 30), plan());
    const first = trackOf(p, ref)!.keys[0].id;
    p = setTransition(p, ref, first, { preset: 'swoop' });
    p = addCameraKey(p, ref, keyAt(2), 30);
    expect(trackOf(p, ref)!.transitions.map((x) => x.preset)).toEqual(['swoop', 'swoop']);
  });
  it('moving onto another key nudges by one frame', () => {
    const p = three();
    const [, mid] = trackOf(p, ref)!.keys;
    const q = moveCameraKey(p, ref, mid.id, 5, 30, 10);
    expect(trackOf(q, ref)!.keys.find((k) => k.id === mid.id)!.t).toBeCloseTo(5 - 1 / 30, 9);
  });
  it('moving past the end clamps to the video length and re-sorts', () => {
    const p = three();
    const first = trackOf(p, ref)!.keys[0];
    const tr = trackOf(moveCameraKey(p, ref, first.id, 99, 30, 10), ref)!;
    expect(tr.keys.at(-1)!.id).toBe(first.id);
    expect(tr.keys.at(-1)!.t).toBe(10);
    expect(tr.transitions).toHaveLength(2);
    expect(tr.transitions.every((x, i) => x.from === tr.keys[i].id && x.to === tr.keys[i + 1].id)).toBe(true);
  });
  it('deleting a middle key merges its two moves, keeping the earlier one', () => {
    let p = three();
    const [a, b] = trackOf(p, ref)!.keys;
    p = setTransition(p, ref, a.id, { preset: 'orbit' });
    p = setTransition(p, ref, b.id, { preset: 'cut' });
    const tr = trackOf(deleteCameraKey(p, ref, b.id), ref)!;
    expect(tr.keys).toHaveLength(2);
    expect(tr.transitions).toEqual([expect.objectContaining({ from: a.id, to: tr.keys[1].id, preset: 'orbit' })]);
  });
  it('editing a key or a move marks it as edited by hand', () => {
    const auto: CameraTrack = { keys: [{ ...keyAt(0), id: 'k1', origin: 'auto' }, { ...keyAt(3), id: 'k2', origin: 'auto' }],
      transitions: [{ from: 'k1', to: 'k2', preset: 'glide', settings: DEFAULT_TRANSITION, origin: 'auto' }], shutter: 0.5 };
    let p = replaceAutoTrack(plan(), ref, auto);
    p = updateCameraKey(p, ref, 'k1', { azimuth: 45 });
    p = setTransition(p, ref, 'k1', { settings: { ...DEFAULT_TRANSITION, overshoot: 0.3 } });
    const tr = trackOf(p, ref)!;
    expect(tr.keys[0]).toMatchObject({ azimuth: 45, origin: 'user' });
    expect(tr.transitions[0]).toMatchObject({ origin: 'user', preset: 'glide' });
    expect(tr.transitions[0].settings.overshoot).toBe(0.3);
  });
  it('never changes the plan it is given', () => {
    const p = deepFreeze(three());
    const id = trackOf(p, ref)!.keys[1].id;
    expect(() => {
      addCameraKey(p, ref, keyAt(7), 30);
      moveCameraKey(p, ref, id, 1, 30, 10);
      deleteCameraKey(p, ref, id);
      updateCameraKey(p, ref, id, { roll: 5 });
      setTransition(p, ref, id, { preset: 'cut' });
    }).not.toThrow();
  });
  it('tracks of different models and clocks are separate', () => {
    const p = addCameraKey(three(), { model: 'sub.ldr', clock: 'timeline' }, keyAt(1), 30);
    expect(trackOf(p, ref)!.keys).toHaveLength(3);
    expect(trackOf(p, { model: 'sub.ldr', clock: 'timeline' })!.keys).toHaveLength(1);
    expect(trackOf(p, { model: 'sub.ldr', clock: 'build' })).toBeUndefined();
  });
});

describe('choosePreset', () => {
  it('sets the move and its end key in one go: Orbit around between two front views now turns', () => {
    const p0 = [0, 4].reduce((p, t) => addCameraKey(p, ref, keyAt(t, 0), 30), plan());
    const [a, b] = trackOf(p0, ref)!.keys;
    const p1 = choosePreset(p0, ref, a.id, presetById('orbit', []), 50);
    const tr = trackOf(p1, ref)!;
    expect(tr.transitions.find((x) => x.from === a.id)!.preset).toBe('orbit');
    expect(tr.keys.find((k) => k.id === b.id)!.azimuth).toBe(90);
    expect(tr.keys.find((k) => k.id === b.id)!.t).toBe(4);
  });
  it('a preset with no move of its own keeps the end key', () => {
    const p0 = [0, 4].reduce((p, t) => addCameraKey(p, ref, keyAt(t, t * 10), 30), plan());
    const [a, b] = trackOf(p0, ref)!.keys;
    const p1 = choosePreset(p0, ref, a.id, presetById('hold', []), 50);
    expect(trackOf(p1, ref)!.keys.find((k) => k.id === b.id)).toEqual(trackOf(p0, ref)!.keys.find((k) => k.id === b.id));
  });
});

describe('several keys at once', () => {
  const four = () => [0, 2, 4, 6].reduce((p, t) => addCameraKey(p, ref, keyAt(t, t * 10), 30), plan());
  const ids = (p: Plan) => trackOf(p, ref)!.keys.map((k) => k.id);
  it('deletes the chosen keys and keeps one move between each remaining pair', () => {
    const p = four();
    const [a, b, c, d] = ids(p);
    const out = deleteCameraKeys(p, ref, [b, c]);
    expect(ids(out)).toEqual([a, d]);
    expect(trackOf(out, ref)!.transitions.map((x) => [x.from, x.to])).toEqual([[a, d]]);
  });
  it('sets the same values on every chosen key and marks them as the user\'s', () => {
    const p = four();
    const [a, b, c] = ids(p);
    const out = updateCameraKeys(p, ref, [a, c], { lensMm: 85, blur: 0.4 });
    const ks = trackOf(out, ref)!.keys;
    expect(ks.find((k) => k.id === a)).toMatchObject({ lensMm: 85, blur: 0.4, origin: 'user', t: 0 });
    expect(ks.find((k) => k.id === c)).toMatchObject({ lensMm: 85, blur: 0.4, t: 4 });
    expect(ks.find((k) => k.id === b)!.lensMm).toBe(50);
  });
  it('moves the chosen keys together, keeping their spacing, never past the start or end', () => {
    const p = four();
    const [a, b, c, d] = ids(p);
    const t = (pl: Plan) => trackOf(pl, ref)!.keys.map((k) => k.t);
    expect(t(moveCameraKeys(p, ref, [b, c], 0.5, 30, 10))).toEqual([0, 2.5, 4.5, 6]);
    expect(t(moveCameraKeys(p, ref, [a, b], -3, 30, 10))).toEqual([0, 2, 4, 6]);
    expect(t(moveCameraKeys(p, ref, [c, d], 9, 30, 10))).toEqual([0, 2, 8, 10]);
  });
  it('keeps the move between two keys moved together', () => {
    const p0 = four();
    const p = setTransition(p0, ref, trackOf(p0, ref)!.keys[1].id, { preset: 'orbit' });
    const [, b, c] = ids(p);
    const out = moveCameraKeys(p, ref, [b, c], 0.5, 30, 10);
    expect(trackOf(out, ref)!.transitions.find((x) => x.from === b)!.preset).toBe('orbit');
  });
});
