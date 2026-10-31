import { describe, expect, it } from 'vitest';
import { curveAt, overshootAt } from '../../../src/anim/cameraTrack/curves';
import type { CurveKind } from '../../../src/anim/cameraTrack/types';

const KINDS: CurveKind[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'holdThenMove', 'snap'];

describe('speed curves', () => {
  it('every kind starts at 0 and ends at 1', () => {
    for (const kind of KINDS) for (const strength of [0, 0.5, 1]) {
      expect(curveAt({ kind, strength }, 0)).toBeCloseTo(0, 9);
      expect(curveAt({ kind, strength }, 1)).toBeCloseTo(1, 9);
    }
  });
  it('every kind is monotone and stays within 0..1', () => {
    for (const kind of KINDS) {
      let prev = 0;
      for (let u = 0; u <= 1.0001; u += 0.01) {
        const v = curveAt({ kind, strength: 0.8 }, Math.min(1, u));
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
        prev = v;
      }
    }
  });
  it('easeInOut is half way at the middle', () => {
    expect(curveAt({ kind: 'easeInOut', strength: 0.7 }, 0.5)).toBeCloseTo(0.5, 6);
  });
  it('holdThenMove barely moves in its first quarter', () => {
    expect(curveAt({ kind: 'holdThenMove', strength: 0.7 }, 0.25)).toBeLessThan(0.05);
  });
  it('snap covers most of the move early', () => {
    expect(curveAt({ kind: 'snap', strength: 0.8 }, 0.3)).toBeGreaterThan(0.7);
  });
  it('linear is the identity', () => {
    expect(curveAt({ kind: 'linear', strength: 1 }, 0.37)).toBeCloseTo(0.37, 9);
  });
});

describe('overshoot', () => {
  it('is zero at both ends and positive near the end', () => {
    expect(overshootAt(0, 0.5)).toBe(0);
    expect(overshootAt(1, 0.5)).toBeCloseTo(0, 9);
    expect(overshootAt(0.85, 0.5)).toBeGreaterThan(0);
    expect(overshootAt(0.85, 0)).toBe(0);
  });
});
