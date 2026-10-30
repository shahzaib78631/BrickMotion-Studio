/** Spatial rig API (formerly v6) on the unified solver. */
import { describe, expect, it } from 'vitest';
import { SpatialMechanismSolver, type SpatialModel } from '../../src/anim/motion/kinematics/spatialModel';

const I: [number, number, number, number] = [0, 0, 0, 1];
const hingeModel = (ground: 'a' | 'b'): SpatialModel => ({
  bodies: [{ id: 'frame', rest: { p: [0, 0, 0], q: I }, fixed: true }, { id: 'arm', rest: { p: [10, 0, 0], q: I } }],
  constraints: [ground === 'a'
    ? { id: 'pin', kind: 'hinge', a: { body: 'frame', local: [0, 0, 0] }, b: { body: 'arm', local: [-10, 0, 0] }, axisA: [0, 0, 1], axisB: [0, 0, 1] }
    : { id: 'pin', kind: 'hinge', a: { body: 'arm', local: [-10, 0, 0] }, b: { body: 'frame', local: [0, 0, 0] }, axisA: [0, 0, 1], axisB: [0, 0, 1] }],
});

describe('spatial rigs on the unified solver', () => {
  it('a hinge stored the other way round reports the same signed angle as v6', () => {
    // v6 measures b relative to a about axisA: with the frame as b the arm turns by -angle.
    const fwd = new SpatialMechanismSolver(hingeModel('a')).solve({ pin: 0.3 });
    const rev = new SpatialMechanismSolver(hingeModel('b')).solve({ pin: 0.3 });
    expect(fwd.status).toBe('converged');
    expect(rev.status).toBe('converged');
    expect(fwd.jointPositions.get('pin')).toBeCloseTo(0.3, 9);
    expect(rev.jointPositions.get('pin')).toBeCloseTo(0.3, 9);
    expect(fwd.poses.get('arm')!.p[1]).toBeCloseTo(10 * Math.sin(0.3), 6);
    expect(rev.poses.get('arm')!.p[1]).toBeCloseTo(-10 * Math.sin(0.3), 6);
  });

  it('a hinge driven in half-radian steps to 4 pi reports 4 pi', () => {
    const solver = new SpatialMechanismSolver(hingeModel('a'));
    let last = solver.solve({ pin: 0 });
    for (let x = 0.5; x <= 4 * Math.PI + 1e-9; x += 0.5) last = solver.solve({ pin: x });
    last = solver.solve({ pin: 4 * Math.PI });
    expect(last.status).toBe('converged');
    expect(last.jointPositions.get('pin')).toBeCloseTo(4 * Math.PI, 9);
    expect(last.poses.get('arm')!.p[0]).toBeCloseTo(10, 6);
  });
});
