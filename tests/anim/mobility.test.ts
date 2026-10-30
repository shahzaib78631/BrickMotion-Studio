/** Mobility of joint loops: overconstrained, singular and shaky cases that counting formulas get wrong. */
import { describe, expect, it } from 'vitest';
import { mobility, type BodyJoint } from '../../src/anim/motion/mobility/mobility';
import { screwJoint, type ConnectorFreedom, type V3 } from '../../src/anim/motion/mobility/screw';

const S = 20; // studs -> LDU
const pin = (x: number, y: number, z = 0, axis: V3 = [0, 0, 1]): ConnectorFreedom => ({ centre: [x * S, y * S, z * S], axis, turns: true, slides: false });
const hinge = (a: number, b: number, c: ConnectorFreedom): BodyJoint => ({ a, b, joint: screwJoint([c]) });

describe('planar loops', () => {
  it('four-bar: 1 DOF, exact, real', () => {
    const m = mobility(4, [hinge(0, 1, pin(0, 0)), hinge(1, 2, pin(1, 3)), hinge(2, 3, pin(5, 4)), hinge(3, 0, pin(6, 0))]);
    expect(m.mobility).toBe(1);
    expect(m.blocks[0]).toMatchObject({ firstOrder: 1, dimension: 1, exact: true, infinitesimal: 0, realMotion: true, loops: 1 });
  });
  it('parallelogram with a redundant third crank: Gruebler says 0, it moves with 1', () => {
    const m = mobility(5, [
      hinge(0, 1, pin(0, 0)), hinge(1, 4, pin(0, 3)),
      hinge(0, 2, pin(4, 0)), hinge(2, 4, pin(4, 3)),
      hinge(0, 3, pin(8, 0)), hinge(3, 4, pin(8, 3)),
    ]);
    expect(m.blocks[0]).toMatchObject({ loops: 2, dimension: 1, exact: true, realMotion: true });
    expect(m.mobility).toBe(1);
  });
  it('triangle: locked', () => {
    const m = mobility(3, [hinge(0, 1, pin(0, 0)), hinge(1, 2, pin(2, 3)), hinge(2, 0, pin(4, 0))]);
    expect(m.mobility).toBe(0);
    expect(m.blocks[0]).toMatchObject({ firstOrder: 0, dimension: 0, exact: true });
  });
  it('flat triangle (three pins in a line): shaky to first order but rigid', () => {
    const m = mobility(3, [hinge(0, 1, pin(0, 0)), hinge(1, 2, pin(2, 0)), hinge(2, 0, pin(4, 0))]);
    expect(m.blocks[0]).toMatchObject({ firstOrder: 1, dimension: 0, infinitesimal: 1, exact: true });
    expect(m.mobility).toBe(0);
  });
  it('folded four-bar (all pivots on one line): 2 to first order, 1 really (Wampler Table 2)', () => {
    const m = mobility(4, [hinge(0, 1, pin(0, 0)), hinge(1, 2, pin(2, 0)), hinge(2, 3, pin(7, 0)), hinge(3, 0, pin(5, 0))]);
    expect(m.blocks[0]).toMatchObject({ firstOrder: 2, dimension: 1, infinitesimal: 1, exact: true, realMotion: true });
  });
  it('slider-crank: 1 DOF', () => {
    const slide: ConnectorFreedom = { centre: [6 * S, 0, 0], axis: [1, 0, 0], turns: false, slides: true };
    const m = mobility(4, [hinge(0, 1, pin(0, 0)), hinge(1, 2, pin(1, 2)), hinge(2, 3, pin(6, 0)), { a: 3, b: 0, joint: screwJoint([slide]) }]);
    expect(m.blocks[0]).toMatchObject({ dimension: 1, exact: true, realMotion: true });
  });
  it('a joint still only to first order but moving at second order is not locked (42000 rear rocker square to its shock)', () => {
    // frame-rocker pivot (3,0), rocker-rod eye (1,0), rod slides in the cylinder along y, cylinder pivot (1,-5).
    const slide: ConnectorFreedom = { centre: [1 * S, -2.5 * S, 0], axis: [0, 1, 0], turns: false, slides: true };
    const m = mobility(4, [hinge(0, 1, pin(3, 0)), hinge(1, 2, pin(1, 0)), { a: 2, b: 3, joint: screwJoint([slide]) }, hinge(3, 0, pin(1, -5))]);
    expect(m.blocks[0]).toMatchObject({ dimension: 1, exact: true });
    expect(m.blocks[0].locked).toEqual([]);
  });
  it('an open chain hanging off a loop adds its own DOF', () => {
    const m = mobility(6, [hinge(0, 1, pin(0, 0)), hinge(1, 2, pin(1, 3)), hinge(2, 3, pin(5, 4)), hinge(3, 0, pin(6, 0)), hinge(2, 4, pin(3, 6)), hinge(4, 5, pin(3, 9))]);
    expect(m.freeJoints.length).toBe(2);
    expect(m.mobility).toBe(3);
  });
  it('prefers the requested driver', () => {
    const joints = [hinge(0, 1, pin(0, 0)), hinge(1, 2, pin(1, 3)), hinge(2, 3, pin(5, 4)), hinge(3, 0, pin(6, 0))];
    expect(mobility(4, joints, { driverPriority: j => (j === 2 ? 1 : 0) }).blocks[0].drivers).toEqual([{ joint: 2, coordinate: 0 }]);
    expect(mobility(4, joints, { driverPriority: j => (j === 0 ? 1 : 0) }).blocks[0].drivers).toEqual([{ joint: 0, coordinate: 0 }]);
  });
});

describe('spatial loops', () => {
  it('a 4R loop on general skew axes is rigid', () => {
    const m = mobility(4, [
      hinge(0, 1, pin(0, 0, 0, [0, 0, 1])),
      hinge(1, 2, pin(3, 0.5, 1, [0.6, 0, 0.8])),
      hinge(2, 3, pin(3.5, 4, -1, [0, 0.8, 0.6])),
      hinge(3, 0, pin(-0.5, 3, 2, [0.48, 0.6, 0.64])),
    ]);
    expect(m.blocks[0]).toMatchObject({ dimension: 0, exact: true });
  });
  it('spherical four-bar (all axes through one point): 1 DOF', () => {
    const through = (d: V3): ConnectorFreedom => { const n = Math.hypot(...d); const u = d.map(x => x / n) as V3; return { centre: u.map(x => x * 3 * S) as V3, axis: u, turns: true, slides: false }; };
    const m = mobility(4, [hinge(0, 1, through([1, 0, 0.2])), hinge(1, 2, through([0.3, 1, 0.1])), hinge(2, 3, through([-0.4, 0.5, 1])), hinge(3, 0, through([0.2, -0.3, 1]))]);
    expect(m.blocks[0]).toMatchObject({ firstOrder: 1, dimension: 1, exact: true, realMotion: true });
  });
  it('Bennett linkage: Gruebler says -2, it moves with 1', () => {
    // DH chain Rz(theta_i) Tx(a_i) Rx(alpha_i) with a/sin(alpha) = b/sin(beta), opposite links equal.
    const alpha = 0.7, beta = 1.2, a = 2, b = a * Math.sin(beta) / Math.sin(alpha);
    type M = number[][];
    const mul = (x: M, y: M) => x.map(r => y[0].map((_, j) => r.reduce((s, v, k) => s + v * y[k][j], 0)));
    const dh = (t: number, len: number, tw: number): M => [
      [Math.cos(t), -Math.sin(t) * Math.cos(tw), Math.sin(t) * Math.sin(tw), len * Math.cos(t)],
      [Math.sin(t), Math.cos(t) * Math.cos(tw), -Math.cos(t) * Math.sin(tw), len * Math.sin(t)],
      [0, Math.sin(tw), Math.cos(tw), 0], [0, 0, 0, 1]];
    const t1 = 0.9;
    let frames: M[] | null = null;
    for (const sb of [1, -1]) for (const rel of [1, -1]) for (const s3 of [1, -1]) for (const s4 of [1, -1]) {
      if (frames) break;
      const B = sb * beta, t2 = 2 * Math.atan(rel * Math.sin((B + alpha) / 2) / Math.sin((B - alpha) / 2) / Math.tan(t1 / 2));
      const params: [number, number, number][] = [[t1, a, alpha], [t2, b, B], [s3 * t1, a, alpha], [s4 * t2, b, B]];
      const fs: M[] = [[[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]];
      for (const p of params) fs.push(mul(fs[fs.length - 1], dh(...p)));
      const end = fs[4], err = end.flat().reduce((s, v, i) => s + Math.abs(v - (i % 5 === 0 ? 1 : 0)), 0);
      if (err < 1e-9) frames = fs;
    }
    expect(frames).not.toBeNull();
    const axisPin = (f: M): ConnectorFreedom => ({ centre: [f[0][3] * S, f[1][3] * S, f[2][3] * S], axis: [f[0][2], f[1][2], f[2][2]], turns: true, slides: false });
    const m = mobility(4, [hinge(3, 0, axisPin(frames![0])), hinge(0, 1, axisPin(frames![1])), hinge(1, 2, axisPin(frames![2])), hinge(2, 3, axisPin(frames![3]))]);
    expect(m.blocks[0]).toMatchObject({ dimension: 1, exact: true, realMotion: true });
  });
});
