import { expect, test } from 'vitest';
import type { Snap } from '../../src/ldraw/shadow';
import { studsOf } from '../../src/plan/sockets';

const snap = (over: Partial<Snap>): Snap => ({
  kind: 'cyl', gender: 'M', radius: 6, length: 4, start: [0, 0, 0], axis: [0, -1, 0], shapes: ['R'], ...over,
} as Snap);

test('studs come from the geometry and the shadow pack, once each', () => {
  const studs = studsOf({
    studs: [{ base: [0, 0, 0], tip: [0, -4, 0], radius: 6 }],
    snaps: [
      snap({}),                                                                   // the same stud again
      snap({ start: [10, 20, -10], axis: [0, 0, -1] }),                            // a side (SNOT) stud
      snap({ radius: 8, length: 24, axis: [1, 0, 0] }),                             // a pin, not a stud
      snap({ gender: 'F', axis: [0, 1, 0] }),                                       // a socket, not a stud
      snap({ length: 12 }),                                                         // a long column, not a stud
    ],
  });
  expect(studs).toHaveLength(2);
  expect(studs[1].base).toEqual([10, 20, -10]);
  expect(studs[1].tip).toEqual([10, 20, -14]); // four LDU along its own axis
  expect(studs[1].radius).toBe(6);
});

test('a part with no measured studs still gets the shadow pack’s own', () => {
  const studs = studsOf({ snaps: [snap({ start: [0, 10, -10], axis: [0, 0, -1] })] });
  expect(studs).toHaveLength(1);
  expect(studs[0].tip).toEqual([0, 10, -14]);
});
