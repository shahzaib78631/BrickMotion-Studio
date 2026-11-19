import { expect, it } from 'vitest';
import { referenceSignature } from '../../scripts/lib/reference-equivalence';

const frame = { pos: [0, 0, 0], m: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
const definition = { id: 'old', kind: 'cyl', group: 'axle', gender: 'M', secs: [{ shape: 'A', radius: 6, length: 20 }] };
it('ignores inheritance IDs and property ordering', () => {
  expect(referenceSignature([{ frame, definition }])).toBe(referenceSignature([{ definition: { ...definition, id: 'new' }, frame: { m: frame.m, pos: frame.pos } }]));
});
it('preserves mating groups, profile dimensions and keyed rotation', () => {
  const signature = referenceSignature([{ frame, definition }]);
  expect(referenceSignature([{ frame, definition: { ...definition, group: 'different' } }])).not.toBe(signature);
  expect(referenceSignature([{ frame, definition: { ...definition, secs: [{ shape: 'A', radius: 5, length: 20 }] } }])).not.toBe(signature);
  expect(referenceSignature([{ definition, frame: { ...frame, m: [0, 0, -1, 0, 1, 0, 1, 0, 0] } }])).not.toBe(signature);
});
