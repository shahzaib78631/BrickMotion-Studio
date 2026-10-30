/** Shifting during playback (spec §4.3-4.5): the output changes speed, never position. */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Assembly } from '../../../src/model/assemble';
import { MechanismSolver } from '../../../src/anim/motion/v4/mechanismSolver';
import { validateMechanismProgram, type MechanismProgram } from '../../../src/anim/motion/v4/mechanismProgram';
import { playShiftTrack, type ShiftFrame } from '../../../src/anim/motion/gearbox/shiftPlayback';

// Two-speed box: input shaft 'in' with clutch gears g1 (30T) and g2 (10T) beside it on the
// same line, both meshing the output 'out' (10T and 30T). A ring on 'in' selects one.
const at = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
const assembly = (): Assembly => ({
  instances: [['in', 0], ['g1', 0], ['g2', 0], ['out', 40], ['ring', 0]].map(([key, x]) => ({ key, part: `${key}.dat`, world: at(x as number),
    worldBox: { min: [(x as number) - 1, -1, -1], max: [(x as number) + 1, 1, 1] }, placeholder: false })),
  nodes: [], problems: [], bounds: null,
} as unknown as Assembly);
const source = 'inferred' as const;
const program = (shiftAt: number): MechanismProgram => ({
  mode: 'kinematic', duration: 4,
  joints: [['in', 0], ['g1', 0], ['g2', 0], ['out', 40]].map(([id, x]) => ({ id: id as string, body: id as string, kind: 'revolute' as const, axis: [0, 0, 1] as [number, number, number], pivot: [x as number, 0, 0] as [number, number, number] })),
  driver: { joint: 'in', amplitude: 6 },
  transmissions: [
    { id: 'm1', source, kind: 'gear', a: 'g1', b: 'out', teethA: 30, teethB: 10 },
    { id: 'm2', source, kind: 'gear', a: 'g2', b: 'out', teethA: 10, teethB: 30 },
    { id: 'c1', source, kind: 'clutch', a: 'in', b: 'g1', engaged: true, dogs: 4 },
    { id: 'c2', source, kind: 'clutch', a: 'in', b: 'g2', engaged: false, dogs: 4 },
  ],
  rigidFollowers: [{ leader: 'in', bodies: ['ring'] }],
  selectors: [{ ring: 'ring', axis: [0, 0, 1], at: { c1: { engaged: -8, waiting: -2 }, c2: { engaged: 8, waiting: 2 } } }],
  shiftTrack: [{ at: 0, label: 'low', engagements: { c1: true, c2: false } }, { at: shiftAt, label: 'high', engagements: { c1: false, c2: true } }],
});
const angle = (a: THREE.Matrix4, b: THREE.Matrix4) => {
  const qa = new THREE.Quaternion().setFromRotationMatrix(a), qb = new THREE.Quaternion().setFromRotationMatrix(b);
  return qa.angleTo(qb);
};
const play = (shiftAt: number, frames = 400) => {
  const solver = new MechanismSolver(assembly(), program(shiftAt));
  const out: ShiftFrame[] = [];
  for (let i = 0; i <= frames; i++) out.push(playShiftTrack(solver, i / frames));
  return out;
};

describe('shift track playback', () => {
  it('the gearbox program with a shift track is valid', () => {
    expect(validateMechanismProgram(program(0.5))).toEqual([]);
    expect(validateMechanismProgram({ ...program(0.5), shiftTrack: [{ at: 0.5, label: 'a', engagements: {} }, { at: 0.2, label: 'b', engagements: {} }] }))
      .toEqual([expect.stringMatching(/shift track/i)]);
  });
  it('a shift during playback never jumps', () => {
    const f = play(0.5);
    let steady = 0, worst = 0;
    for (let i = 2; i < f.length; i++) {
      const step = Math.max(...['in', 'g1', 'g2', 'out'].map(k => angle(f[i - 1].poses.get(k)!, f[i].poses.get(k)!)));
      if (i < 150) steady = Math.max(steady, step); else worst = Math.max(worst, step);
    }
    expect(steady).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(3 * steady);
    expect(f[100].mode).toBe('low');
    expect(f[399].mode).toBe('high');
  });
  it('a misaligned shift stalls in neutral, then engages once the dogs line up', () => {
    // Input at 12t − 6 and g2 at 9× input, so the dogs are 8·1.47 rad ≈ 7.5 pitches apart: half a pitch out.
    const f = play(0.625);
    const first = f.findIndex((x, i) => i / 400 >= 0.625);
    expect(f[first].stalled).toEqual(['c2']);
    const engaged = f.findIndex((x, i) => i > first && x.stalled.length === 0);
    expect(engaged).toBeGreaterThan(first);
    expect(f[engaged].mode).toBe('high');
    // While it waits the ring stands at the engagement boundary; then it slides home.
    const slide = (x: ShiftFrame) => new THREE.Vector3().setFromMatrixPosition(x.poses.get('ring')!).z;
    expect(slide(f[first + 1])).toBeLessThanOrEqual(2 + 1e-9);
    expect(slide(f[f.length - 1])).toBeCloseTo(8, 6);
  });
});
