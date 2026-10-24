import { describe, expect, it } from 'vitest';
import { parsePlan } from '../../src/plan/schema';
import { emptyAnimation, insertKeys } from '../../src/anim/keyframes';

const base = { format: 'brickmotion-plan', version: 1, name: 'Keyed model', steps: [] };

describe('saved animation shape', () => {
  it('preserves independent object keyframes across JSON export/reimport', () => {
    const animation = insertKeys(emptyAnimation(), 16, [
      { model: '', target: 'brick', channel: 'location.x', value: 2 },
      { model: '', target: 'brick', channel: 'rotation.z', value: 25 },
    ]);
    const parsed = parsePlan(JSON.parse(JSON.stringify({ ...base, animation })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.animation).toEqual(animation);
  });
  it('does not accept unbounded FPS or invalid frame ranges', () => {
    expect(parsePlan({ ...base, animation: { ...emptyAnimation(), fps: 0 } }).ok).toBe(false);
    expect(parsePlan({ ...base, animation: { ...emptyAnimation(), endFrame: 0 } }).ok).toBe(false);
    expect(parsePlan({ ...base, animation: { ...emptyAnimation(), startFrame: 50, endFrame: 20 } }).ok).toBe(false);
  });
  it('rejects unsafe keyframe values and unsorted/duplicated keyframes', () => {
    const t = { kind: 'object', model: '', target: 'brick', channels: {
      'location.x': [{ frame: 10, value: 2, interpolation: 'linear' }, { frame: 10, value: 4, interpolation: 'linear' }],
    } };
    expect(parsePlan({ ...base, animation: { ...emptyAnimation(), tracks: [t] } }).ok).toBe(false);
    t.channels['location.x'][1].value = Number.POSITIVE_INFINITY;
    expect(parsePlan({ ...base, animation: { ...emptyAnimation(), tracks: [t] } }).ok).toBe(false);
  });
  it('rejects saved keyframes outside the playback range', () => {
    const clip = insertKeys(emptyAnimation(), 100, [{ model: '', target: 'brick', channel: 'location.y', value: 4 }]);
    expect(parsePlan({ ...base, animation: { ...clip, endFrame: 50 } }).ok).toBe(false);
  });
  it('rejects duplicate track bindings', () => {
    const t = { kind: 'object', model: '', target: 'brick', channels: {} };
    expect(parsePlan({ ...base, animation: { ...emptyAnimation(), tracks: [t, t] } }).ok).toBe(false);
  });
});

describe('procedural Build source project persistence', () => {
  it('keeps linked Build layers and authored keys through a project roundtrip', () => {
    const animation = { ...insertKeys(emptyAnimation(), 20, [{ model: '', target: 'truck', channel: 'location.x', value: 5 }]),
      endFrame: 600, buildLayers: { '': { speed: 1, startFrame: 1 }, truck: { speed: 0.5, startFrame: 24 } } };
    const parsed = parsePlan(JSON.parse(JSON.stringify({ ...base, animation })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan.animation).toEqual(animation);
  });
  it('rejects invalid build speeds, impossible starts, and nonfinite layer data', () => {
    const a = emptyAnimation();
    const verify = (speed: number, startFrame: number) => parsePlan({ ...base,
      animation: { ...a, buildLayers: { '': { speed, startFrame } } } }).ok;
    expect(verify(0, 1)).toBe(false);
    expect(verify(5, 1)).toBe(false);
    expect(verify(Number.NaN, 1)).toBe(false);
    expect(verify(1, 251)).toBe(false);
    expect(verify(1, 10.3)).toBe(false);
    expect(verify(1, 1)).toBe(true);
  });
});
