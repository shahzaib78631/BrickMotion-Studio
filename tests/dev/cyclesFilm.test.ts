import { expect, it } from 'vitest';
import { blackmanHarrisCDF, blackmanHarrisInverseTable, blackmanHarrisWeight } from '../../src/dev/cyclesFilmMath';

it('matches the normalized finite reconstruction window, including subpixel tails', () => {
  const width = 1.5, steps = 4000, dx = 2 * width / steps;
  let integral = 0;
  for (let i = 0; i < steps; i++) integral += blackmanHarrisWeight(-width + (i + 0.5) * dx, width) * dx;
  expect(integral).toBeCloseTo(2 * width * 0.35875, 6);
  expect(blackmanHarrisWeight(width + 0.01, width)).toBe(0);
  expect(blackmanHarrisCDF(-width, width)).toBe(0);
  expect(blackmanHarrisCDF(width, width)).toBe(1);
  expect(blackmanHarrisCDF(0, width)).toBeCloseTo(0.5, 12);
  expect(blackmanHarrisCDF(0.5, width) - blackmanHarrisCDF(-0.5, width)).toBeLessThan(1);
});
it('inverts a monotone symmetric CDF without shifting the pixel centre', () => {
  const table = blackmanHarrisInverseTable(1.5);
  let mean = 0;
  for (let i = 0; i < table.length; i++) {
    if (i) expect(table[i]).toBeGreaterThan(table[i - 1]);
    expect(table[i]).toBeCloseTo(-table[table.length - i - 1], 6);
    expect(blackmanHarrisCDF(table[i], 1.5)).toBeCloseTo(i / (table.length - 1), 6);
    mean += table[i];
  }
  expect(mean / table.length).toBeCloseTo(0, 7);
});
