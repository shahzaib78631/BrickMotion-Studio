/** v6 mechanism laws as equations on joint coordinates. */
import { describe, expect, it } from 'vitest';
import { evaluateLaw, lawsFromMechanics, type LawContext } from '../../src/anim/motion/kinematics/laws';
import { sliderCrankTravel, camProfileTravel, intermittentIndexTravel } from '../../src/anim/motion/v8/mechanismLaws';
import type { SpatialMechanic } from '../../src/anim/motion/kinematics/laws';

const U = 20;
const hinges = new Set(['a', 'b', 'c', 'steer', 'l', 'r', 'yaw']);
const ctx: LawContext = {
  coordOf: id => id, isHinge: id => hinges.has(id), accepted: () => 0, drive: () => undefined, ratchetStop: () => 0.4,
};
const one = (m: SpatialMechanic) => lawsFromMechanics([m], ctx);
const f = (m: SpatialMechanic, x: number[]) => evaluateLaw(one(m).laws[0], x).values;

describe('mechanism laws', () => {
  it('a 24:8 external gear: out = -3 in', () => {
    const m = { id: 'g', kind: 'gear', input: 'a', output: 'b', inputTeeth: 24, outputTeeth: 8 } as const;
    expect(f(m, [0.1, -0.3])[0]).toBeCloseTo(0, 12);
    expect(f(m, [0.1, 0])[0]).toBeCloseTo(U * 0.3 / 3, 12);
  });
  it('Ackermann: inner and outer wheel angles from the centre angle', () => {
    const m = { id: 'k', kind: 'ackermann-steering', input: 'steer', left: 'l', right: 'r', wheelbaseLdu: 100, trackWidthLdu: 60 } as const;
    const s = 0.2, L = Math.atan2(100 * Math.sin(s), 100 * Math.cos(s) - 30 * Math.sin(s)), R = Math.atan2(100 * Math.sin(s), 100 * Math.cos(s) + 30 * Math.sin(s));
    const v = f(m, [s, L, R]);
    expect(v).toHaveLength(2);
    expect(Math.abs(v[0]) + Math.abs(v[1])).toBeLessThan(1e-12);
  });
  it('planetary sun 12, ring 36: carrier is the tooth-weighted mean', () => {
    const m = { id: 'p', kind: 'planetary', sun: 'a', ring: 'b', carrier: 'c', sunTeeth: 12, ringTeeth: 36 } as const;
    expect(f(m, [1, 0, 12 / 48])[0]).toBeCloseTo(0, 12);
  });
  it('slider-crank uses the exact travel', () => {
    const m = { id: 's', kind: 'slider-crank', crank: 'a', slider: 'x', crankRadiusLdu: 10, rodLengthLdu: 40 } as const;
    expect(f(m, [0.7, sliderCrankTravel(0.7, 10, 40)])[0]).toBeCloseTo(0, 12);
  });
  it('a two-fall winch lifts r/2 per radian', () => {
    const m = { id: 'w', kind: 'winch', rotary: 'a', linear: 'x', drumRadiusLdu: 8, supportedSegments: 2 } as const;
    expect(f(m, [1, 4])[0]).toBeCloseTo(0, 12);
  });
  it('a disengaged clutch adds nothing; an engaged one couples', () => {
    expect(one({ id: 'c', kind: 'clutch', input: 'a', output: 'b', engaged: false }).laws).toHaveLength(0);
    expect(f({ id: 'c', kind: 'clutch', input: 'a', output: 'b', engaged: true }, [0.5, 0.5])[0]).toBeCloseTo(0, 12);
  });
  it('stops, ratchets and backlash are inequalities, not penalties', () => {
    const { laws, inequalities } = lawsFromMechanics([
      { id: 'st', kind: 'stop', joint: 'a', min: -1, max: 2 },
      { id: 'ra', kind: 'ratchet', joint: 'b', direction: 'positive' },
      { id: 'bl', kind: 'backlash-gear', input: 'a', output: 'b', inputTeeth: 8, outputTeeth: 24, clearanceRad: 0.05 },
    ], ctx);
    expect(laws).toHaveLength(0);
    expect(inequalities.map(i => [i.id, i.lo, i.hi])).toEqual([['st', -1, 2], ['ra', 0.4, Infinity], ['bl', -0.05, 0.05]]);
    expect(inequalities[2].a).toEqual([1 / 3, 1]);
  });
  it('a detent targets the nearest pitch of the command', () => {
    const c2: LawContext = { ...ctx, drive: () => 0.74 };
    const law = lawsFromMechanics([{ id: 'd', kind: 'detent', joint: 'a', pitch: 0.5, engaged: true }], c2).laws[0];
    expect(evaluateLaw(law, [0.5]).values[0]).toBeCloseTo(0, 12);
  });
  it('every nonlinear law has a gradient that matches central differences', () => {
    const ms: SpatialMechanic[] = [
      { id: '1', kind: 'ackermann-steering', input: 'steer', left: 'l', right: 'r', wheelbaseLdu: 100, trackWidthLdu: 60 },
      { id: '2', kind: 'slider-crank', crank: 'a', slider: 'x', crankRadiusLdu: 10, rodLengthLdu: 40, guideOffsetLdu: 3 },
      { id: '3', kind: 'universal-drive', input: 'a', output: 'b', bendAngleRad: 0.5 },
      { id: '4', kind: 'cam-follower', cam: 'a', follower: 'x', liftLdu: 6, lobes: 2 },
      { id: '5', kind: 'cam-profile', cam: 'a', follower: 'x', profileLdu: [0, 2, 5, 2] },
      { id: '6', kind: 'intermittent-indexer', input: 'a', output: 'b', slots: 4, activeFraction: 0.4 },
    ];
    for (const m of ms) {
      const law = one(m).laws[0], x = law.coords.map((_, i) => 0.31 + 0.17 * i);
      const { values, grad } = evaluateLaw(law, x);
      x.forEach((_, k) => {
        const h = 1e-6, up = [...x], dn = [...x]; up[k] += h; dn[k] -= h;
        const a = evaluateLaw(law, up).values, b = evaluateLaw(law, dn).values;
        values.forEach((_, r) => expect(grad[r][k]).toBeCloseTo((a[r] - b[r]) / (2 * h), 5));
      });
    }
    expect(camProfileTravel(0, [0, 1, 2, 1])).toBe(0);
    expect(intermittentIndexTravel(0, 4, 0.5)).toBe(0);
  });
});
