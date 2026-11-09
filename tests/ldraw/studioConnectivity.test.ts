import { expect, test } from 'vitest';
import { parseStudioConnectivity, studioConnections } from '../../src/data/studioConnectivity';
import { studioConnectors, studioSnapsFor } from '../../src/data/studioConnectors';
import { STUDIO_CONNECTORS } from '../../src/data/studioConnectors.generated';
import type { Snap } from '../../src/ldraw/shadow';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** A side frame: its −Y (the stud axis) points at −Z, and its cells run along x and y. */
const SIDE = [1, 0, 0, 0, 0, 1, 0, -1, 0];

/** One Studio record: code, rotation, the corner-offset position, then the grid counts and padding. */
function record(code: number, m: number[], point: [number, number, number], grid: [number, number] = [1, 1]): Uint8Array {
  // the file stores the first cell's corner, so the raw position is the point plus rotationᵀ·(-10,0,10)
  const t = [0, 1, 2].map((i) => m[i] * -10 + m[3 + i] * 0 + m[6 + i] * 10);
  const cells = grid[0] * grid[1];
  const tail = cells ? 8 + 16 * cells + 8 * (grid[0] + grid[1]) : 8;
  const out = new Uint8Array(52 + tail);
  const view = new DataView(out.buffer);
  view.setInt32(0, code, true);
  m.forEach((v, i) => view.setFloat32(4 + i * 4, v, true));
  [0, 1, 2].forEach((k) => view.setFloat32(40 + k * 4, point[k] + t[k], true));
  if (cells) {
    view.setInt16(52, grid[1] * 2, true);
    view.setInt16(54, grid[0] * 2, true);
  }
  return out;
}
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

test('a record is decoded to the point and the stud axis in part space', () => {
  const file = parseStudioConnectivity(join(
    record(0x170003, I, [0, 0, 0]),        // a top stud
    record(0x2, I, [0, 24, 0]),            // an underside anti-stud
    record(0x170003, SIDE, [0, 10, -6]),   // a side stud
    record(0xc0000, SIDE, [0, 10, -10], [0, 0]), // a marker
  ));
  expect(file.complete).toBe(true);
  expect(file.records.map((r) => r.pos.map(Math.round))).toEqual([[0, 0, 0], [0, 24, 0], [0, 10, -6], [0, 10, -10]]);
  // a top stud points up (-Y); a side stud points at -Z; the marker's shape is unverified
  expect(file.records.map((r) => r.axis.map(Math.round))).toEqual([[0, -1, 0], [0, -1, 0], [0, 0, -1], [0, 0, -1]]);
  expect(studioConnections(file.records).map((c) => `${c.gender}@${c.pos.map(Math.round)}`))
    .toEqual(['M@0,0,0', 'F@0,24,0', 'M@0,10,-6']);
});

test('the grid counts are recorded, and a file that does not parse cleanly is not trusted', () => {
  const file = parseStudioConnectivity(join(record(0x170003, I, [-30, 0, 10], [4, 2])));
  expect(file.complete).toBe(true);
  expect(file.records[0].grid).toEqual([4, 2]);
  // trailing bytes that are not a record leave the file in doubt
  expect(parseStudioConnectivity(join(record(0x170003, I, [0, 0, 0]), new Uint8Array(12))).complete).toBe(false);
  // and so does a head that is not a rotation
  expect(parseStudioConnectivity(record(0x2, [2, 0, 0, 0, 2, 0, 0, 0, 2], [0, 0, 0])).records).toHaveLength(0);
});

test('Studio says the headlight brick has a back anti-stud, which this project was missing', () => {
  const connections = studioConnectors('4070');
  expect(connections).toContainEqual({ gender: 'F', pos: [0, 10, 10], axis: [0, 0, -1] });
  // ...and agrees with LDCad about the recessed headlight stud's base
  expect(connections).toContainEqual({ gender: 'M', pos: [0, 10, -6], axis: [0, 0, -1] });
  expect(connections).toHaveLength(4);
});

test('every imported connection is a stud or anti-stud on an axis-aligned axis', () => {
  for (const part of Object.keys(STUDIO_CONNECTORS)) {
    for (const c of studioConnectors(part)) {
      expect(Number.isFinite(c.pos[0] + c.pos[1] + c.pos[2])).toBe(true);
      expect(Math.abs(c.axis[0]) + Math.abs(c.axis[1]) + Math.abs(c.axis[2])).toBeCloseTo(1, 6);
    }
  }
});

test('only the connections the measurement and the shadow pack do not already have are added', () => {
  // what LDCad says about 4070: a top stud, a side stud, an underside anti-stud and the hollow
  const existing: Snap[] = [
    { kind: 'cyl', gender: 'M', start: [0, 0, 0], axis: [0, -1, 0], length: 4, radius: 6, shapes: ['R'], slide: false },
    { kind: 'cyl', gender: 'M', start: [0, 10, -6], axis: [0, 0, -1], length: 4, radius: 6, shapes: ['R'], slide: false },
    { kind: 'cyl', gender: 'F', start: [0, 24, 0], axis: [0, -1, 0], length: 4, radius: 6, shapes: ['S'], slide: false },
    { kind: 'cyl', gender: 'F', start: [0, 10, -10], axis: [0, 0, 1], length: 20, radius: 6, shapes: ['R', 'S'], slide: true },
  ];
  const added = studioSnapsFor('4070', { snaps: existing });
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ gender: 'F', start: [0, 10, 10], axis: [0, 0, -1], radius: 6, length: 4, shapes: ['S'], source: 'studio' });
  // nothing to add when the sources above already have both of a part's connections
  const all3005: Snap[] = [
    { kind: 'cyl', gender: 'M', start: [0, 0, 0], axis: [0, -1, 0], length: 4, radius: 6, shapes: ['R'], slide: false },
    { kind: 'cyl', gender: 'F', start: [0, 24, 0], axis: [0, -1, 0], length: 4, radius: 6, shapes: ['S'], slide: false },
  ];
  expect(studioSnapsFor('3005', { snaps: all3005 })).toHaveLength(0);
  // and a part Studio knows nothing about gains nothing
  expect(studioSnapsFor('not-a-part', {})).toHaveLength(0);
});

test('an underside anti-stud is left to the body grid, and a measured stud is enough', () => {
  // 3001's Studio record is one top stud and one underside anti-stud per cell; the underside is
  // `socketsOf`'s job, and the top stud is measured, so nothing is added
  expect(studioSnapsFor('3001', { studs: [{ base: [-30, 0, 10], tip: [-30, -4, 10], radius: 6 }] })).toHaveLength(0);
  // with neither source, the top stud is added; the underside socket still is not
  expect(studioSnapsFor('3001', {})!.map((s) => `${s.gender}@${s.start.map(Math.round)}`)).toEqual(['M@-30,0,10']);
});
