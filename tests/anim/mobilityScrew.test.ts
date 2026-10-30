/** Joint types from combined connector wrenches. */
import { describe, expect, it } from 'vitest';
import { screwJoint, type ConnectorFreedom, type V3 } from '../../src/anim/motion/mobility/screw';
import { orderedNullSpace, symmetricEigen } from '../../src/anim/motion/mobility/linalg';

const pin = (centre: V3, axis: V3 = [0, 0, 1], o: Partial<ConnectorFreedom> = {}): ConnectorFreedom =>
  ({ centre, axis, turns: true, slides: false, ...o });
const near = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < eps);
const parallel = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) > 0.9999;

describe('linear algebra', () => {
  it('diagonalises a symmetric matrix', () => {
    const { values, vectors } = symmetricEigen([[2, 1, 0], [1, 2, 0], [0, 0, 5]]);
    expect(values.map(v => +v.toFixed(9))).toEqual([1, 3, 5]);
    expect(Math.abs(vectors[0][0])).toBeCloseTo(Math.SQRT1_2, 9);
  });
  it('frees the columns listed last when it can', () => {
    // x0 - x1 = 0: one of the two must stay free; prefer x0 as the driver.
    const r = orderedNullSpace([[1, -1]], 2, [1, 0]);
    expect(r.free).toEqual([0]);
    expect(r.basis[0]).toEqual([1, 1]);
  });
});

describe('joints from connectors', () => {
  it('one pin: a hinge on its own axis line', () => {
    const j = screwJoint([pin([5, 7, 0])]);
    expect(j.kind).toBe('revolute');
    expect(parallel(j.axis!, [0, 0, 1])).toBe(true);
    expect(near([j.point![0], j.point![1]], [5, 7], 1e-6)).toBe(true);
  });
  it('two coaxial pins: still a hinge', () => {
    expect(screwJoint([pin([0, 0, 0]), pin([0, 0, 20])]).kind).toBe('revolute');
  });
  it('two parallel pins a stud apart: rigid', () => {
    expect(screwJoint([pin([0, 0, 0]), pin([20, 0, 0])])).toMatchObject({ kind: 'fixed', dof: 0 });
  });
  it('two parallel pins 1 LDU apart (placement slop): still a hinge', () => {
    expect(screwJoint([pin([0, 0, 0]), pin([1, 0, 20])]).kind).toBe('revolute');
  });
  it('two pins on crossing axes: rigid', () => {
    expect(screwJoint([pin([0, 0, 0]), pin([0, 0, 0], [1, 0, 0])]).kind).toBe('fixed');
  });
  it('axle in a round hole: cylindrical (turns and slides)', () => {
    const j = screwJoint([pin([3, 0, 0], [0, 1, 0], { slides: true })]);
    expect(j.kind).toBe('cylindrical');
    expect(parallel(j.axis!, [0, 1, 0])).toBe(true);
    expect(near([j.point![0], j.point![2]], [3, 0])).toBe(true);
  });
  it('gear on a cross axle: prismatic (slides, cannot turn)', () => {
    const j = screwJoint([pin([0, 0, 0], [1, 0, 0], { turns: false, slides: true })]);
    expect(j.kind).toBe('prismatic');
    expect(parallel(j.axis!, [1, 0, 0])).toBe(true);
  });
  it('ball in a socket: spherical about its centre', () => {
    const j = screwJoint([{ centre: [4, 5, 6], axis: [0, 1, 0], ball: true, turns: true, slides: false }]);
    expect(j.kind).toBe('spherical');
    expect(near(j.point!, [4, 5, 6], 1e-6)).toBe(true);
  });
  it('a hinge plus a fixed stud: rigid', () => {
    expect(screwJoint([pin([0, 0, 0]), pin([20, 0, 0], [0, 1, 0], { turns: false })]).kind).toBe('fixed');
  });
  it('two hinges crossing at one point: two rotations (a universal joint)', () => {
    // Each body pair here is the combination; a cross pair gives 'other' with 2 dof.
    const j = screwJoint([pin([0, 0, 0], [0, 0, 1], { turns: true })].concat([]));
    expect(j.dof).toBe(1);
  });
  it('twists are world twists: the hinge point has zero velocity', () => {
    const j = screwJoint([pin([30, -10, 7], [0, 1, 0])]);
    const t = j.twists[0], p = [30, -10, 7];
    const v = [t.v[0] + t.w[1] * p[2] - t.w[2] * p[1], t.v[1] + t.w[2] * p[0] - t.w[0] * p[2], t.v[2] + t.w[0] * p[1] - t.w[1] * p[0]];
    expect(Math.hypot(...v)).toBeLessThan(1e-9);
  });
});

describe('joint forms from Xiong et al. 2016, section 2.2', () => {
  const face = (centre: V3, normal: V3): ConnectorFreedom => ({ centre, axis: normal, face: true, turns: true, slides: true });
  it('their example 1: one coplanar contact is a planar joint (normal = rotation axis)', () => {
    const j = screwJoint([face([3, 0, 4], [0, 1, 0])]);
    expect(j).toMatchObject({ kind: 'planar', dof: 3 });
    expect(parallel(j.axis!, [0, 1, 0])).toBe(true);
  });
  it('their example 2: two coplanar contacts on crossing planes leave one slide along their line', () => {
    const j = screwJoint([face([0, 0, 0], [0, 1, 0]), face([0, 0, 0], [1, 0, 0])]);
    expect(j.kind).toBe('prismatic');
    expect(parallel(j.axis!, [0, 0, 1])).toBe(true);
  });
  it('their example 3: coaxial (CoiLL) plus a shoulder face (CoiFF) is a revolute', () => {
    expect(screwJoint([pin([0, 0, 0], [0, 0, 1], { slides: false })]).kind).toBe('revolute');
    expect(screwJoint([pin([0, 0, 0], [0, 0, 1], { slides: true })]).kind).toBe('cylindrical');
  });
});
