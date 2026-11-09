import { expect, it } from 'vitest';
import { solveLighting, displayChannel, linearChannel, fitTone, toneAt, inverseTone, TONE_ABSCISSAE } from '../../src/dev/referenceFitMath';

it('recovers coupled nonnegative light intensities from linear measurements', () => {
  const a = [[1, 0.5], [0.2, 1], [0.7, 0.4]], expected = [2, 0.3];
  const b = a.map((row) => row[0] * expected[0] + row[1] * expected[1]);
  const gram = [0, 1].map((i) => [0, 1].map((j) => a.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const cross = [0, 1].map((i) => a.reduce((sum, row, k) => sum + row[i] * b[k], 0));
  const fitted = solveLighting(gram, cross, [10, 10]);
  expect(fitted[0]).toBeCloseTo(2, 6); expect(fitted[1]).toBeCloseTo(0.3, 6);
});
it('respects nonnegative and upper physical bounds', () => {
  expect(solveLighting([[1, 0], [0, 1]], [-1, 50], [10, 4])).toEqual([0, 4]);
});
it('roundtrips the piecewise sRGB transfer function', () => {
  for (const value of [0, 0.001, 0.04, 0.5, 1]) expect(displayChannel(linearChannel(value))).toBeCloseTo(value, 6);
});

it('fits a monotone shared tone curve and preserves its endpoints', () => {
  const observations = Array.from({ length: 100 }, (_, i) => ({ x: i / 99, y: (i / 99) ** 1.2, weight: 1 }));
  const curve = fitTone(observations);
  expect(curve[0]).toBe(0); expect(curve[7]).toBe(1);
  for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
  for (const x of TONE_ABSCISSAE) expect(toneAt(inverseTone(toneAt(x, curve), curve), curve)).toBeCloseTo(toneAt(x, curve), 6);
});
