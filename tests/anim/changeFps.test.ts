import { describe, expect, it } from 'vitest';
import { changeFps, valuesAt } from '../../src/anim/keyframes';
import type { KeyframeAnimation } from '../../src/plan/types';

/** A baked flight at 24 fps: rests until frame 25, flies to x = 10 by frame 34 (0.375 s). */
const baked = (): KeyframeAnimation => ({
  fps: 24, startFrame: 1, endFrame: 241,
  buildLayers: { '': { startFrame: 1, speed: 1 } },
  tracks: [{
    kind: 'object', model: '', target: 'brick', source: 'baked-flight',
    channels: {
      'location.x': [
        { frame: 1, value: 0, interpolation: 'linear' }, { frame: 25, value: 0, interpolation: 'linear' },
        { frame: 30, value: 6, interpolation: 'linear' }, { frame: 34, value: 10, interpolation: 'linear' },
      ],
      visibility: [{ frame: 1, value: 0, interpolation: 'constant' }, { frame: 13, value: 1, interpolation: 'constant' }],
    },
  }],
});
const seconds = (a: KeyframeAnimation, frame: number) => (frame - a.startFrame) / a.fps;

describe('changing the scene frame rate', () => {
  it('keeps every key at the same moment in seconds, so flights keep their speed', () => {
    const a = baked();
    const b = changeFps(a, 120);
    expect(b.fps).toBe(120);
    const keys = (x: KeyframeAnimation) => x.tracks[0].channels['location.x']!.map((k) => seconds(x, k.frame));
    expect(keys(b)).toEqual(keys(a));
    expect(seconds(b, b.tracks[0].channels.visibility![1].frame)).toBeCloseTo(seconds(a, 13), 6);
    // the flight still takes 0.375 s: x is half way at the same moment
    expect(valuesAt(b, '', 'brick', 1 + 0.35 * 120)['location.x']).toBeCloseTo(valuesAt(a, '', 'brick', 1 + 0.35 * 24)['location.x'], 6);
  });

  it('keeps the scene length and the Build layer start in seconds', () => {
    const b = changeFps({ ...baked(), buildLayers: { '': { startFrame: 25, speed: 1 } } }, 120);
    expect(seconds(b, b.endFrame)).toBeCloseTo(10, 6);
    expect(seconds(b, b.buildLayers![''].startFrame)).toBeCloseTo(1, 6);
  });

  it('lowering the rate merges keys that land on one frame, keeping the later one', () => {
    const a = { ...baked(), fps: 120, endFrame: 1201 };
    a.tracks[0].channels['location.x'] = [
      { frame: 1, value: 0, interpolation: 'linear' }, { frame: 121, value: 1, interpolation: 'linear' },
      { frame: 122, value: 2, interpolation: 'linear' }, { frame: 241, value: 3, interpolation: 'linear' },
    ];
    const keys = changeFps(a, 24).tracks[0].channels['location.x']!;
    expect(keys.map((k) => k.frame)).toEqual([1, 25, 49]);
    expect(keys.map((k) => k.value)).toEqual([0, 2, 3]);
  });

  it('is a no-op for the same rate and refuses a scene too long for the frame limit', () => {
    const a = baked();
    expect(changeFps(a, 24)).toBe(a);
    expect(() => changeFps({ ...a, endFrame: 10000 }, 120)).toThrow(/20,000/);
  });
});
