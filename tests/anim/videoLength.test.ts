import { describe, expect, it } from 'vitest';
import { clipPatch, lengthPatch, type LengthSettings } from '../../src/anim/pacing';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/storage/settings';

const auto: LengthSettings = { targetSeconds: 60, introSeconds: null, buildSeconds: null, outroSeconds: null, heroOrbit: true };
const total = (s: LengthSettings) => (s.introSeconds ?? 1) + (s.buildSeconds ?? s.targetSeconds - (s.introSeconds ?? 1) - (s.outroSeconds ?? (s.heroOrbit ? 3 : 0.5))) + (s.outroSeconds ?? (s.heroOrbit ? 3 : 0.5));

describe('video Length and clip durations stay in step', () => {
  it('with auto timing, Length only sets the target', () => {
    expect(lengthPatch(auto, 90)).toEqual({ targetSeconds: 90 });
  });

  it('with a custom Build (a dragged clip edge), Length refits the Build so the video is that long', () => {
    const custom = { ...auto, buildSeconds: 51.5, outroSeconds: 1.9 };
    const next = { ...custom, ...lengthPatch(custom, 90) };
    expect(next.targetSeconds).toBe(90);
    expect(next.buildSeconds).toBeCloseTo(90 - 1 - 1.9, 6);
    expect(next.outroSeconds).toBe(1.9);
    expect(total(next)).toBeCloseTo(90, 6);
  });

  it('dragging the Build edge updates Length to the new total; an intro or ending under auto Build leaves it', () => {
    const next = { ...auto, ...clipPatch(auto, 'buildSeconds', 120) };
    expect(next.buildSeconds).toBe(120);
    expect(next.targetSeconds).toBeCloseTo(1 + 120 + 3, 6);
    expect(clipPatch(auto, 'outroSeconds', 5)).toEqual({ outroSeconds: 5 });
    const custom = { ...auto, buildSeconds: 40 };
    expect(clipPatch(custom, 'outroSeconds', 5)).toEqual({ outroSeconds: 5, targetSeconds: 46 });
  });

  it('a long custom Build survives a reload (up to 30 minutes)', () => {
    const stored = { ...DEFAULT_SETTINGS, video: { ...DEFAULT_SETTINGS.video, buildSeconds: 300 } };
    expect(sanitizeSettings(stored).video.buildSeconds).toBe(300);
    const tooLong = { ...DEFAULT_SETTINGS, video: { ...DEFAULT_SETTINGS.video, buildSeconds: 4000 } };
    expect(sanitizeSettings(tooLong).video.buildSeconds).toBeNull();
  });
});
