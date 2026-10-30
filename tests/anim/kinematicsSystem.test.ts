/** Unified kinematic system: forward kinematics and the analytic Jacobian. */
import { describe, expect, it } from 'vitest';
import { KinematicSystem, type JointSpec, type Equation } from '../../src/anim/motion/kinematics/system';
import { random } from '../../src/anim/motion/mobility/localDimension';
import { apply } from '../../src/anim/motion/kinematics/rigid';

type V3 = [number, number, number];

/** Central differences of every row along every coordinate. */
function numericJacobian(sys: KinematicSystem, s: ReturnType<KinematicSystem['zeroState']>, h = 1e-6) {
  const n = sys.coords.length, cols: number[][] = [];
  for (let k = 0; k < n; k++) {
    const d = new Float64Array(n);
    d[k] = h; const up = sys.constraints(sys.step(s, d)).rows.map(r => r.value);
    d[k] = -h; const dn = sys.constraints(sys.step(s, d)).rows.map(r => r.value);
    cols.push(up.map((u, i) => (u - dn[i]) / (2 * h)));
  }
  return cols;
}

/** A ring of bodies b1..bm closed back to ground, every joint kind used. */
function ring(seed: number): { joints: JointSpec[]; equations: Equation[]; bodies: string[] } {
  const rnd = random(seed), v = (): V3 => [rnd() * 40 - 20, rnd() * 40 - 20, rnd() * 40 - 20];
  const unit = (): V3 => { const a = v(), l = Math.hypot(...a); return a.map(x => x / l) as V3; };
  // Rotate the kinds with the seed so a different kind ends up as the cut joint.
  const base: JointSpec['kind'][] = ['revolute', 'universal', 'spherical', 'cylindrical', 'free', 'planar', 'prismatic', 'revolute'];
  const kinds = base.map((_, i) => base[(i + seed) % base.length]);
  const last = kinds.length - 1, bodies = kinds.slice(1).map((_, i) => `b${i + 1}`);
  const joints = kinds.map((kind, i): JointSpec => {
    const a = unit(), t = unit();
    const c: V3 = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]], l = Math.hypot(...c);
    const axis2 = kind === 'universal' ? c.map(x => x / l) as V3 : undefined;
    // j0.. chain ground -> b1 -> ... -> b(last); the last joint closes it back to ground.
    const parent = i === 0 || i === last ? null : `b${i}`, child = i === last ? `b${last}` : `b${i + 1}`;
    return { id: `j${i}`, parent, child, kind, point: v(), axis: a, axis2 };
  });
  const equations: Equation[] = [
    { kind: 'distance', id: 'rod', a: 'b2', pa: v(), b: 'b5', pb: v(), length: 3 },
    { kind: 'point', id: 'pin', a: 'b3', b: 'b4', point: v() },
    { kind: 'rolling', id: 'rack', carrier: 'b1', frame: 'b4', point: v(), along: unit(), coord: `j${kinds.indexOf('prismatic')}`, ratio: 3 },
  ];
  return { joints, equations, bodies };
}

describe('kinematic system', () => {
  it('forward kinematics of a revolute chain', () => {
    const sys = new KinematicSystem({ bodies: ['arm'], joints: [{ id: 'pin', parent: null, child: 'arm', kind: 'revolute', point: [0, 0, 0], axis: [0, 0, 1] }] });
    const d = new Float64Array(1); d[0] = 0.3;
    const tip = apply(sys.deltas(sys.step(sys.zeroState(), d)).get('arm')!, [10, 0, 0]);
    expect(tip[0]).toBeCloseTo(10 * Math.cos(0.3), 12);
    expect(tip[1]).toBeCloseTo(10 * Math.sin(0.3), 12);
  });

  it('the assembled pose closes every cut', () => {
    const sys = new KinematicSystem({ bodies: ['a', 'b'], joints: [
      { id: 'p1', parent: null, child: 'a', kind: 'revolute', point: [0, 0, 0], axis: [0, 0, 1] },
      { id: 'p2', parent: 'a', child: 'b', kind: 'revolute', point: [10, 0, 0], axis: [0, 0, 1] },
      { id: 'p3', parent: null, child: 'b', kind: 'revolute', point: [10, 10, 0], axis: [0, 0, 1] },
    ] });
    expect(sys.cuts).toHaveLength(1);
    for (const r of sys.constraints(sys.zeroState()).rows) expect(Math.abs(r.value)).toBeLessThan(1e-12);
  });

  it('a joint coordinate is cumulative (hinge returns 4 pi after two turns)', () => {
    const sys = new KinematicSystem({ bodies: ['arm'], joints: [{ id: 'pin', parent: null, child: 'arm', kind: 'revolute', point: [0, 0, 0], axis: [0, 0, 1] }] });
    let s = sys.zeroState();
    for (let i = 0; i < 8; i++) s = sys.step(s, Float64Array.of(Math.PI / 2));
    expect(sys.value(s, 'pin')).toBeCloseTo(4 * Math.PI, 12);
  });

  for (const seed of [3, 11, 29]) it(`analytic Jacobian matches central differences (seed ${seed})`, () => {
    const { joints, equations, bodies } = ring(seed);
    const sys = new KinematicSystem({ bodies, joints, equations });
    const rnd = random(seed * 7);
    const s = sys.step(sys.zeroState(), Float64Array.from(sys.coords, () => (rnd() - 0.5) * 0.6));
    const rows = sys.constraints(s).rows, num = numericJacobian(sys, s);
    expect(rows.length).toBeGreaterThan(6);
    let worst = 0;
    rows.forEach((r, i) => r.grad.forEach((g, k) => { worst = Math.max(worst, Math.abs(g - num[k][i]) / Math.max(1, Math.abs(g))); }));
    expect(worst).toBeLessThan(1e-6);
  });
});
