import { expect, it } from 'vitest';
import { referencePorts } from '../../scripts/lib/reference-ports';
import type { Snap } from '../../src/ldraw/shadow';

const bore: Snap = { kind: 'cyl', gender: 'F', start: [0, 10, -10], axis: [0, 0, 1],
  length: 20, radius: 6, shapes: ['R', 'S'], slide: true, caps: 'none',
  sections: [{ shape: 'R', radius: 4, start: 0, length: 8 }, { shape: 'S', radius: 6, start: 8, length: 12 }] };
it('recovers the headlight rear socket from the far end of the independent profile', () => {
  const [front, rear] = referencePorts([bore]);
  expect(front.sections[0].radius).toBe(4);
  expect(rear.position).toEqual([0, 10, 10]);
  expect(rear.inward).toEqual([0, 0, -1]);
  expect(rear.sections).toEqual([{ shape: 'S', radius: 6, start: 0, length: 12 }, { shape: 'R', radius: 4, start: 12, length: 8 }]);
});
it('does not invent a second opening in capped or unspecified profiles', () => {
  expect(referencePorts([{ ...bore, caps: 'one' }])).toHaveLength(1);
  expect(referencePorts([{ ...bore, caps: undefined }])).toHaveLength(0);
  expect(referencePorts([{ ...bore, caps: 'two' }])).toHaveLength(0);
  expect(referencePorts([{ ...bore, gender: 'M' }])).toHaveLength(0);
});

it('exposes only the specified end of asymmetrically capped sockets', () => {
  const a = referencePorts([{ ...bore, caps: 'A' }]);
  const b = referencePorts([{ ...bore, caps: 'B' }]);
  expect(a).toHaveLength(1); expect(b).toHaveLength(1);
  expect(a[0].position).toEqual([0, 10, 10]);
  expect(a[0].sections[0].radius).toBe(6);
  expect(b[0].position).toEqual([0, 10, -10]);
  expect(b[0].sections[0].radius).toBe(4);
});
