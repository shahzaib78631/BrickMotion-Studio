/** Bodies and joints recognised from connectors. */
import { describe, expect, it } from 'vitest';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import { recogniseMechanism } from '../../src/anim/motion/mobility/recognise';

type V3 = [number, number, number];
let n = 0;
const pinIn = (male: string, female: string, centre: V3, axis: V3 = [0, 0, 1]): MechanicalJoint =>
  ({ id: `c${n++}`, male, female, type: 'pin-hole', axis, centre, engagement: 8, motion: 'fixed', rotates: true });

describe('recognising bodies and joints', () => {
  it('two beams on one friction pin: a hinge, the pin folded in as an idle spin', () => {
    const r = recogniseMechanism(['A', 'B', 'p'], [pinIn('p', 'A', [0, 0, 0]), pinIn('p', 'B', [0, 0, 10])]);
    expect(r.joints).toHaveLength(1);
    expect(r.joints[0].joint.kind).toBe('revolute');
    expect(r.idle).toEqual(['p']);
    expect(r.mobility.mobility).toBe(1);
  });
  it('two beams on two pins: one body (each pin only spins in place)', () => {
    const r = recogniseMechanism(['A', 'B', 'p', 'q'], [
      pinIn('p', 'A', [0, 0, 0]), pinIn('p', 'B', [0, 0, 10]), pinIn('q', 'A', [40, 0, 0]), pinIn('q', 'B', [40, 0, 10])]);
    expect(r.bodies).toEqual([['A', 'B', 'p', 'q']]);
    expect(r.mobility.mobility).toBe(0);
  });
  it('the same, keeping idle spins: the loop analysis still welds the beams', () => {
    const r = recogniseMechanism(['A', 'B', 'p', 'q'], [
      pinIn('p', 'A', [0, 0, 0]), pinIn('p', 'B', [0, 0, 10]), pinIn('q', 'A', [40, 0, 0]), pinIn('q', 'B', [40, 0, 10])], { keepIdle: true });
    // Only the two pin spins remain: A and B never move relative to each other.
    expect(r.mobility.mobility).toBe(2);
    expect(r.mobility.blocks[0]).toMatchObject({ dimension: 2, exact: true });
  });
  it('a part holding the pin in its own hole is not idle (a turntable top)', () => {
    const r = recogniseMechanism(['base', 'top', 'axle'], [pinIn('top', 'base', [0, 0, 0]), pinIn('axle', 'top', [0, 0, 10])]);
    expect(r.idle).toEqual([]);
    expect(r.bodyOf.get('top')).not.toBe(r.bodyOf.get('base'));
  });
  it('a pinned four-bar of beams: 1 DOF, four hinges', () => {
    const r = recogniseMechanism(['g', 'c', 'k', 'r'], [
      pinIn('c', 'g', [0, 0, 0]), pinIn('k', 'c', [20, 60, 0]), pinIn('k', 'r', [100, 80, 0]), pinIn('r', 'g', [120, 0, 0])]);
    expect(r.joints).toHaveLength(4);
    expect(r.mobility.mobility).toBe(1);
  });
});
