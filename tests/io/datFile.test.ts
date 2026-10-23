import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPartFile, readPlanFile } from '../../src/io/planFile';

describe('opening .dat files', () => {
  it('opens a library part as a one-piece set that carries the part', () => {
    const text = readFileSync('public/ldraw/parts/3001.dat', 'utf8');
    const r = readPlanFile(text, '3001.dat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps).toHaveLength(1);
    expect(r.plan.steps[0].pieces).toEqual([expect.objectContaining({ part: '3001', ldu: [0, 0, 0] })]);
    expect(r.plan.parts?.['3001.dat']).toBe(text);
    expect(r.plan.name).toBe("Brick 2 x 4");
  });

  it('opens a .dat model like an .ldr', () => {
    const text = ['0 My car', '0 Name: car.dat', '0 !LDRAW_ORG Model', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '0 STEP', '1 15 0 -24 0 1 0 0 0 1 0 0 0 1 3003.dat'].join('\n');
    const r = readPlanFile(text, 'car.dat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.name).toBe('car');
    expect(r.plan.steps.flatMap((s) => s.pieces).map((p) => ('part' in p ? p.part : ''))).toEqual(['3001', '3003']);
    expect(r.plan.parts).toBeUndefined();
  });

  it('tells parts from models', () => {
    expect(isPartFile('0 !LDRAW_ORG Unofficial_Part UPDATE 2024-01\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s/x.dat')).toBe(true);
    expect(isPartFile('0 !LDRAW_ORG Model\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat')).toBe(false);
    expect(isPartFile('0 no header\n3 16 0 0 0 1 0 0 0 1 0')).toBe(true);
    expect(isPartFile('0 no header\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat')).toBe(false);
  });

  it('still rejects unknown types', () => {
    expect(readPlanFile('x', 'a.txt').ok).toBe(false);
  });
});
