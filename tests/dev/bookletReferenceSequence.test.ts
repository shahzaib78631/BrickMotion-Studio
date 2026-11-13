import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

type Part = { part: string; color: number; matrix: number[]; new: boolean };
type Step = { parts: Part[]; flipped: boolean; exploded?: boolean };
const step = (n: number): Step => JSON.parse(readFileSync(new URL(`../../public/_booklet/21065/step-${String(n).padStart(4, '0')}.json`, import.meta.url), 'utf8'));

describe('21065 assembled reference geometry', () => {
  it('carries existing assembled poses unchanged into each subsequent step', () => {
    for (let n = 2; n <= 6; n++) {
      const previous = step(n - 1).parts.map(({ new: _new, ...p }) => p);
      const base = step(n).parts.filter((p) => !p.new).map(({ new: _new, ...p }) => p);
      expect(base, `step ${n} base`).toEqual(previous);
    }
  });
  it('keeps the step-5 end plates on the row plane when they become the step-6 base', () => {
    for (const n of [5, 6]) {
      const ends = step(n).parts.filter((p) => p.part === '11212.dat' && Math.abs(p.matrix[12]) === 180);
      expect(ends).toHaveLength(2);
      expect(ends.map((p) => p.matrix[13])).toEqual([0, 0]);
    }
  });
  it('extends both ends symmetrically in the turned-over step 6', () => {
    const d = step(6);
    expect(d.flipped).toBe(true);
    expect(d.exploded).toBe(false);
    const positions = d.parts.filter((p) => p.new).map((p) => p.matrix.slice(12, 15)).sort((a, b) => a[0] - b[0]);
    expect(positions).toEqual([[-240, 0, 0], [240, 0, 0]]);
  });
});
