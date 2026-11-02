import { describe, expect, it } from 'vitest';
import { localDelta, rotMatrix } from '../../src/plan/placement';
import type { Mat3 } from '../../src/ldraw/parse';

const deg = (d: number): Mat3 => {
  const r = (d * Math.PI) / 180, c = Math.round(Math.cos(r) * 1e6) / 1e6, s = Math.round(Math.sin(r) * 1e6) / 1e6;
  return [c, 0, s, 0, 1, 0, -s, 0, c] as Mat3;
};
const round = (d: { x: number; y: number; z: number }) => [d.x, d.y, d.z].map((v) => Math.round(v * 1000) / 1000);
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3;

describe('a nudge along the piece’s own axes', () => {
  it('is the model nudge when the piece is square to the world', () => {
    expect(round(localDelta(I, { x: 1, y: 0, z: 0 }))).toEqual([1, 0, 0]);
    expect(round(localDelta(I, { x: 0, y: 2, z: 0 }))).toEqual([0, 2, 0]);
    expect(round(localDelta(I, { x: 0, y: 0, z: -3 }))).toEqual([0, 0, -3]);
  });

  it('follows a quarter turn: a piece turned 90° moves along its own x, which is the world −z', () => {
    expect(round(localDelta(rotMatrix(90), { x: 1, y: 0, z: 0 }))).toEqual([0, 0, -1]);
    expect(round(localDelta(rotMatrix(90), { x: 0, y: 0, z: 1 }))).toEqual([1, 0, 0]);
    // a quarter turn about the vertical cannot tilt a plate step
    expect(round(localDelta(rotMatrix(90), { x: 0, y: 1, z: 0 }))).toEqual([0, 1, 0]);
    expect(round(localDelta(rotMatrix(180), { x: 1, y: 0, z: 0 }))).toEqual([-1, 0, 0]);
    expect(round(localDelta(rotMatrix(270), { x: 1, y: 0, z: 0 }))).toEqual([0, 0, 1]);
  });

  it('follows any angle, which is the point: 45° steps out along 45°', () => {
    const cos = 0.707;               // one stud out at 45°, to the three decimals this checks
    expect(round(localDelta(deg(45), { x: 1, y: 0, z: 0 }))).toEqual([cos, 0, -cos]);
    expect(round(localDelta(deg(45), { x: 0, y: 0, z: 1 }))).toEqual([cos, 0, cos]);
    expect(round(localDelta(deg(-30), { x: 1, y: 0, z: 0 }))).toEqual([0.866, 0, 0.5]);
  });
});
