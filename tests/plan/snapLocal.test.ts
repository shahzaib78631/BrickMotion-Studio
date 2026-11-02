import { describe, expect, it } from 'vitest';
import { rotMatrix, snapLocal } from '../../src/plan/placement';
import type { Mat3 } from '../../src/ldraw/parse';

const deg = (d: number): Mat3 => {
  const r = (d * Math.PI) / 180, c = Math.round(Math.cos(r) * 1e6) / 1e6, s = Math.round(Math.sin(r) * 1e6) / 1e6;
  return [c, 0, s, 0, 1, 0, -s, 0, c] as Mat3;
};
const round = (d: { x: number; y: number; z: number }) => [d.x, d.y, d.z].map((v) => Math.round(v * 1000) / 1000);
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3;

describe('snapping a drag along a piece’s own axes', () => {
  it('behaves like the world grid when the piece is square to it', () => {
    expect(round(snapLocal(I, { x: 0.6, y: 0, z: 0 }))).toEqual([1, 0, 0]);      // one whole stud
    expect(round(snapLocal(I, { x: 0, y: 0, z: -0.6 }))).toEqual([0, 0, -1]);    // and the way it was dragged
    expect(round(snapLocal(I, { x: 0, y: 0.3, z: 0 }))).toEqual([0, 0.4, 0]);    // a plate, not a stud
    expect(round(snapLocal(I, { x: 0.3, y: 0, z: 0 }))).toEqual([0, 0, 0]);      // inside the half step
  });

  it('snaps along the piece’s own axis when it is turned 90°', () => {
    // the piece's own x runs down the world −z, and its own z across the world +x
    expect(round(snapLocal(rotMatrix(90), { x: 0, y: 0, z: -0.6 }))).toEqual([0, 0, -1]);
    expect(round(snapLocal(rotMatrix(90), { x: 0.6, y: 0, z: 0 }))).toEqual([1, 0, 0]);
    expect(round(snapLocal(rotMatrix(90), { x: 0, y: 0.3, z: 0 }))).toEqual([0, 0.4, 0]);
  });

  it('gives a 45° piece a whole-stud step along its own axes', () => {
    const half = 0.707;
    // a drag of 0.6 studs along its own x becomes a whole stud along that 45° direction
    expect(round(snapLocal(deg(45), { x: 0.6 * half, y: 0, z: -0.6 * half }))).toEqual([half, 0, -half]);
    expect(round(snapLocal(deg(45), { x: 0.6 * half, y: 0, z: 0.6 * half }))).toEqual([half, 0, half]);
    // a small drag is inside the half-step and does not move it at all
    expect(round(snapLocal(deg(45), { x: 0.2 * half, y: 0, z: -0.2 * half }))).toEqual([0, 0, 0]);
  });
});
