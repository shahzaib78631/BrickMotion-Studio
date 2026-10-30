/** Unified solver: corrector, continuation, active set, singularity stop, several drivers. */
import { describe, expect, it } from 'vitest';
import { KinematicSystem, type JointSpec, type State } from '../../src/anim/motion/kinematics/system';
import { solve } from '../../src/anim/motion/kinematics/solve';

type V3 = [number, number, number];
const Z: V3 = [0, 0, 1];
const pin = (id: string, parent: string | null, child: string, point: V3): JointSpec => ({ id, parent, child, kind: 'revolute', point, axis: Z });
/** Upper intersection of circles (p, r) and (q, s) in the plane. */
function meet(p: V3, r: number, q: V3, s: number): V3 {
  const dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy), a = (r * r - s * s + d * d) / (2 * d), h = Math.sqrt(r * r - a * a);
  const x = p[0] + a * dx / d, y = p[1] + a * dy / d;
  return [x - h * dy / d, y + h * dx / d, 0];
}
/** Crank-rocker: crank 10, coupler 35, rocker 25, ground 30 (Grashof, crank shortest). */
function fourBar() {
  const A: V3 = [0, 0, 0], B: V3 = [0, 10, 0], D: V3 = [30, 0, 0], C = meet(B, 35, D, 25);
  const sys = new KinematicSystem({ bodies: ['crank', 'coupler', 'rocker'], joints: [
    pin('A', null, 'crank', A), pin('B', 'crank', 'coupler', B), pin('C', 'coupler', 'rocker', C), pin('D', null, 'rocker', D),
  ] });
  return { sys, C, D };
}
const maxRow = (sys: KinematicSystem, s: State) => Math.max(...sys.constraints(s).rows.map(r => Math.abs(r.value)));
const drive = (entries: [string, number][]) => new Map(entries);

describe('unified solver', () => {
  it('a four-bar follows its crank and every closure holds', () => {
    const { sys } = fourBar();
    let s = sys.zeroState();
    for (const q of [0.1, 0.4, 0.9, 1.5]) {
      const r = solve(sys, s, drive([['A', q]]));
      expect(r.status).toBe('converged');
      s = r.state;
      expect(sys.value(s, 'A')).toBeCloseTo(q, 10);
      expect(maxRow(sys, s)).toBeLessThan(1e-6);
    }
  });

  it('a crank-rocker turns a full revolution continuously and comes back', () => {
    const { sys } = fourBar();
    let s = sys.zeroState(), last = 0;
    for (let i = 1; i <= 63; i++) {
      const r = solve(sys, s, drive([['A', (i / 63) * 2 * Math.PI]]));
      expect(r.status).toBe('converged');
      s = r.state;
      const rocker = sys.value(s, 'D');
      expect(Math.abs(rocker - last)).toBeLessThan(0.2);
      last = rocker;
    }
    expect(Math.abs(sys.value(s, 'D'))).toBeLessThan(1e-6);
    // Coordinates count turns: the coupler has turned once backwards relative to the crank.
    expect(Math.abs(sys.value(s, 'B') + 2 * Math.PI)).toBeLessThan(1e-6);
  });

  it('a 3 rad jump lands on the same branch as 30 small steps', () => {
    const { sys } = fourBar();
    const jump = solve(sys, sys.zeroState(), drive([['A', 3]]));
    let s = sys.zeroState();
    for (let i = 1; i <= 30; i++) s = solve(sys, s, drive([['A', i * 0.1]])).state;
    expect(jump.status).toBe('converged');
    for (const c of ['B', 'C', 'D']) expect(Math.abs(sys.value(jump.state, c) - sys.value(s, c))).toBeLessThan(1e-6);
  });

  it('driving the rocker past its dead point stops at the toggle instead of jumping', () => {
    const { sys, C, D } = fourBar();
    // The rocker's limit: crank and coupler folded, |AC| = 35 - 10.
    const Cl = meet([0, 0, 0], 25, D, 25);
    const limit = Math.atan2(Cl[1] - D[1], Cl[0] - D[0]) - Math.atan2(C[1] - D[1], C[0] - D[0]);
    expect(limit).toBeGreaterThan(0);
    const r = solve(sys, sys.zeroState(), drive([['D', limit + 0.5]]));
    expect(r.status).toBe('singular');
    expect(r.reason).toMatch(/dead point/);
    expect(Math.abs(sys.value(r.state, 'D') - limit)).toBeLessThan(0.05);
    expect(maxRow(sys, r.state)).toBeLessThan(1e-6);
  });

  it('a parallelogram with a redundant third crank converges and is not called singular', () => {
    const sys = new KinematicSystem({ bodies: ['c1', 'c2', 'c3', 'bar'], joints: [
      pin('g1', null, 'c1', [0, 0, 0]), pin('g2', null, 'c2', [30, 0, 0]), pin('g3', null, 'c3', [15, 0, 0]),
      pin('t1', 'c1', 'bar', [0, 10, 0]), pin('t2', 'c2', 'bar', [30, 10, 0]), pin('t3', 'c3', 'bar', [15, 10, 0]),
    ] });
    let s = sys.zeroState();
    for (const q of [0.3, 0.8, 1.2]) {
      const r = solve(sys, s, drive([['g1', q]]));
      expect(r.status).toBe('converged');
      expect(r.conditioning).toBeGreaterThan(1e-3);
      s = r.state;
    }
    expect(sys.value(s, 'g2')).toBeCloseTo(1.2, 8);
    expect(sys.value(s, 'g3')).toBeCloseTo(1.2, 8);
  });

  it('two drivers at once: a five-bar takes both crank angles', () => {
    const A: V3 = [0, 0, 0], E: V3 = [20, 0, 0], B: V3 = [0, 10, 0], Dp: V3 = [20, 10, 0], C = meet(B, 20, Dp, 20);
    const sys = new KinematicSystem({ bodies: ['k1', 'k2', 'l1', 'l2'], joints: [
      pin('A', null, 'k1', A), pin('E', null, 'k2', E), pin('B', 'k1', 'l1', B), pin('Dj', 'k2', 'l2', Dp), pin('C', 'l1', 'l2', C),
    ] });
    const r = solve(sys, sys.zeroState(), drive([['A', 0.3], ['E', -0.2]]));
    expect(r.status).toBe('converged');
    expect(r.freeDof).toBe(0);
    expect(sys.value(r.state, 'A')).toBeCloseTo(0.3, 10);
    expect(sys.value(r.state, 'E')).toBeCloseTo(-0.2, 10);
    expect(maxRow(sys, r.state)).toBeLessThan(1e-6);
  });

  it('minimum change: an undriven free hinge stays where it was', () => {
    const sys = new KinematicSystem({ bodies: ['a', 'b'], joints: [pin('pa', null, 'a', [0, 0, 0]), pin('pb', null, 'b', [50, 0, 0])] });
    const r = solve(sys, sys.zeroState(), drive([['pa', 0.7]]));
    expect(r.status).toBe('converged');
    expect(r.freeDof).toBe(1);
    expect(sys.value(r.state, 'pb')).toBe(0);
  });

  it('active set: a coupled joint is held on its bound; a request past it fails as a joint stop', () => {
    const sys = new KinematicSystem({ bodies: ['a', 'b'], joints: [pin('pa', null, 'a', [0, 0, 0]), pin('pb', null, 'b', [50, 0, 0])] });
    const inequalities = [{ id: 'gap', coords: ['pa', 'pb'], a: [-1, 1], lo: -0.05, hi: 0.05, scale: 20 }];
    const r = solve(sys, sys.zeroState(), drive([['pa', 0.3]]), { inequalities });
    expect(r.status).toBe('converged');
    expect(sys.value(r.state, 'pb')).toBeCloseTo(0.25, 9);
    expect(r.active).toEqual(['gap']);
    const laws = [{ id: 'gear', coords: ['pa', 'pb'], f: (x: readonly number[]) => [20 * (x[1] + 3 * x[0])] }];
    const stop = [{ id: 'stop', coords: ['pb'], a: [1], lo: -1, hi: 1, scale: 20 }];
    expect(solve(sys, sys.zeroState(), drive([['pa', 0.2]]), { laws, inequalities: stop }).status).toBe('converged');
    const over = solve(sys, sys.zeroState(), drive([['pa', 0.5]]), { laws, inequalities: stop });
    expect(over.status).toBe('failed');
    expect(over.reason).toMatch(/joint stop/);
  });

  it('a Bennett linkage moves with one degree of freedom', () => {
    const alpha = 0.7, beta = 1.2, a = 40, b = a * Math.sin(beta) / Math.sin(alpha);
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
      const fs: M[] = [[[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]];
      for (const p of [[t1, a, alpha], [t2, b, B], [s3 * t1, a, alpha], [s4 * t2, b, B]] as [number, number, number][]) fs.push(mul(fs[fs.length - 1], dh(...p)));
      if (fs[4].flat().reduce((s, v, i) => s + Math.abs(v - (i % 5 === 0 ? 1 : 0)), 0) < 1e-9) frames = fs;
    }
    const at = (f: M) => ({ point: [f[0][3], f[1][3], f[2][3]] as V3, axis: [f[0][2], f[1][2], f[2][2]] as V3 });
    const sys = new KinematicSystem({ bodies: ['l0', 'l1', 'l2'], joints: [
      { id: 'j0', parent: null, child: 'l0', kind: 'revolute', ...at(frames![0]) },
      { id: 'j1', parent: 'l0', child: 'l1', kind: 'revolute', ...at(frames![1]) },
      { id: 'j2', parent: 'l1', child: 'l2', kind: 'revolute', ...at(frames![2]) },
      { id: 'j3', parent: null, child: 'l2', kind: 'revolute', ...at(frames![3]) },
    ] });
    let s = sys.zeroState();
    for (const q of [0.1, 0.25, 0.4]) {
      const r = solve(sys, s, drive([['j0', q]]));
      expect(r.status).toBe('converged');
      expect(r.freeDof).toBe(0);
      s = r.state;
    }
    expect(maxRow(sys, s)).toBeLessThan(1e-6);
  });
});
