import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, DEFAULT_TRANSITION, applyPreset, endKeyForPreset, isTransitionSettings, presetById } from '../../../src/anim/cameraTrack/presets';
import type { CameraKey } from '../../../src/anim/cameraTrack/types';

const IDS = ['glide', 'push-in', 'pull-back', 'truck-left', 'truck-right', 'pedestal-up', 'pedestal-down', 'crane-down', 'crane-up',
  'orbit', 'arc-reveal', 'swoop', 'whip-pan', 'dolly-zoom', 'rack-focus', 'dutch-in', 'handheld', 'hold', 'cut'];
const p = (id: string) => BUILT_IN_PRESETS.find((x) => x.id === id)!;

describe('built-in transition presets', () => {
  it('has all 19 presets with unique ids', () => {
    expect(BUILT_IN_PRESETS.map((x) => x.id).sort()).toEqual([...IDS].sort());
  });
  it('every preset has valid settings, a label and a hint', () => {
    for (const x of BUILT_IN_PRESETS) {
      expect(isTransitionSettings(x.settings)).toBe(true);
      expect(x.label.length).toBeGreaterThan(0);
      expect(x.hint.length).toBeGreaterThan(0);
    }
  });
  it('fast swoop is a strong snap with blur and a little overshoot', () => {
    const s = p('swoop').settings;
    expect(s.curve.kind).toBe('snap');
    expect(s.curve.strength).toBeGreaterThanOrEqual(0.7);
    expect(s.path).toBe('arc');
    expect(s.motionBlur).toBeGreaterThanOrEqual(0.6);
    expect(s.overshoot).toBeCloseTo(0.15, 2);
  });
  it('whip pan has full motion blur; cut cuts; handheld shakes', () => {
    expect(p('whip-pan').settings.motionBlur).toBe(1);
    expect(p('cut').settings.cut).toBe(true);
    expect(p('handheld').settings.shake.amount).toBeGreaterThan(0);
  });
  it('dolly zoom moves lens and distance in opposite directions', () => {
    const k = p('dolly-zoom').key!;
    expect(k.lensMm!).toBeGreaterThan(0);
    expect(k.distanceScale!).toBeGreaterThan(1);
  });
  it('truck and pedestal moves slide in a straight line', () => {
    for (const id of ['truck-left', 'truck-right', 'pedestal-up', 'pedestal-down']) expect(p(id).settings.path).toBe('straight');
  });
  it('push in gets closer, pull back further', () => {
    expect(p('push-in').key!.distanceScale!).toBeLessThan(1);
    expect(p('pull-back').key!.distanceScale!).toBeGreaterThan(1);
  });
  it('the default transition is the glide', () => {
    expect(DEFAULT_TRANSITION).toEqual(p('glide').settings);
  });
});

describe('presetById', () => {
  it('falls back to glide for an unknown id', () => {
    expect(presetById('nope', []).id).toBe('glide');
  });
  it('finds a user preset before a built-in with the same id', () => {
    const mine = { ...p('swoop'), label: 'My swoop' };
    expect(presetById('swoop', [mine]).label).toBe('My swoop');
  });
});

describe('applyPreset', () => {
  it('copies settings, names the preset and marks the move as edited', () => {
    const tr = { from: 'a', to: 'b', preset: 'glide', settings: DEFAULT_TRANSITION, origin: 'auto' as const };
    const out = applyPreset(tr, p('swoop'));
    expect(out.preset).toBe('swoop');
    expect(out.settings).toEqual(p('swoop').settings);
    expect(out.settings).not.toBe(p('swoop').settings);
    expect(out.origin).toBe('user');
  });
});

describe('isTransitionSettings', () => {
  it('rejects malformed settings', () => {
    expect(isTransitionSettings({ ...DEFAULT_TRANSITION, curve: { kind: 'wobble', strength: 1 } })).toBe(false);
    expect(isTransitionSettings({ ...DEFAULT_TRANSITION, overshoot: 'lots' })).toBe(false);
    expect(isTransitionSettings(null)).toBe(false);
  });
  it('accepts a turn-late time, rejects a bad one', () => {
    expect(isTransitionSettings({ ...DEFAULT_TRANSITION, turnLast: 0.5 })).toBe(true);
    expect(isTransitionSettings({ ...DEFAULT_TRANSITION, turnLast: 'soon' })).toBe(false);
    expect(isTransitionSettings({ ...DEFAULT_TRANSITION, turnLast: -1 })).toBe(false);
  });
});

describe('endKeyForPreset: the move does what the preset says', () => {
  const k = (over: Partial<CameraKey> = {}): CameraKey => ({ id: 'x', t: 0, target: { kind: 'model' }, offset: [0, 0, 0], azimuth: 10, elevation: 30,
    distance: { fit: true, margin: 1.2 }, roll: 0, lensMm: 50, focus: 'target', blur: 0, origin: 'auto', ...over });
  const end = k({ id: 'e', t: 4, azimuth: 10, elevation: 15, distance: { fit: true, margin: 1.05 } });
  it('Orbit around turns 90° from the start view, keeping its height and distance', () => {
    expect(endKeyForPreset(k(), end, presetById('orbit', []), 50)).toMatchObject({ azimuth: 100, elevation: 30, distance: { fit: true, margin: 1.2 } });
  });
  it('Push in gets closer, with auto-fit or a fixed distance', () => {
    expect(endKeyForPreset(k(), end, presetById('push-in', []), 50)!.distance).toEqual({ fit: true, margin: 0.84 });
    expect(endKeyForPreset(k({ distance: { fit: false, value: 100 } }), end, presetById('push-in', []), 50)!.distance).toEqual({ fit: false, value: 70 });
  });
  it('Crane down lowers; Fast swoop swings round and lower', () => {
    expect(endKeyForPreset(k(), end, presetById('crane-down', []), 50)!.elevation).toBe(5);
    expect(endKeyForPreset(k(), end, presetById('swoop', []), 50)).toMatchObject({ azimuth: 80, elevation: 10 });
  });
  it('Truck right slides camera and aim to the camera\'s right', () => {
    const r = endKeyForPreset(k({ azimuth: 0 }), end, presetById('truck-right', []), 40)!;
    expect(r.offset![0]).toBeCloseTo(10, 6);
    expect(r.offset![2]).toBeCloseTo(0, 6);
  });
  it('wraps the angle and leaves the time and target of the end key alone', () => {
    const r = endKeyForPreset(k({ azimuth: 170 }), end, presetById('whip-pan', []), 50)!;
    expect(r.azimuth).toBe(-70);
    expect(r).not.toHaveProperty('t');
    expect(r).not.toHaveProperty('target');
  });
  it('presets with no move of their own (glide, hold, cut) leave the end key as it is', () => {
    for (const id of ['glide', 'hold', 'cut']) expect(endKeyForPreset(k(), end, presetById(id, []), 50)).toBeNull();
  });
});
