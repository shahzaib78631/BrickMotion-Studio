import { expect, it } from 'vitest';
import { geometrySignature } from '../../scripts/lib/geometry-signature';

const a = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const b = [0, 0, 1, 1, 0, 1, 0, 1, 1];
const part = (points: number[], two = false) => ({ tris: new Map(two ? [] : [[16, points]]), doubleSided: new Map(two ? [[16, points]] : []) });
it('ignores colour and record ordering and preserves cyclic vertex equivalence', () => {
  const signature = geometrySignature(part([...a, ...b]));
  const other = { tris: new Map([[4, b], [71, [...a.slice(3), ...a.slice(0, 3)]]]), doubleSided: new Map<number, number[]>() };
  expect(geometrySignature(other)).toBe(signature);
});
it('does not equate different surfaces with the same bounds, winding changes, or sidedness changes', () => {
  const signature = geometrySignature(part([...a, ...b]));
  expect(geometrySignature(part([...a, ...b.slice(0, 3), ...b.slice(6), ...b.slice(3, 6)]))).not.toBe(signature);
  expect(geometrySignature(part([...a, ...b], true))).not.toBe(signature);
  const changed = [...a, ...b]; changed[3] = 0.5;
  expect(geometrySignature(part(changed))).not.toBe(signature);
});
it('preserves duplicate surfaces and refuses empty or invalid evidence', () => {
  expect(geometrySignature(part([...a, ...a]))).not.toBe(geometrySignature(part(a)));
  expect(geometrySignature(part([]))).toBeNull();
  expect(() => geometrySignature(part([1]))).toThrow('Incomplete triangle');
  expect(() => geometrySignature(part([NaN, ...a.slice(1)]))).toThrow('Non-finite');
});
