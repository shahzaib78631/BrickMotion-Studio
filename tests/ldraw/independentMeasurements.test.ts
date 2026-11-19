import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { measureIndependentPart } from '../../scripts/lib/independent-measurements';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function library(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'bm-measure-')); temporary.push(dir);
  mkdirSync(join(dir, 'parts'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'parts', name), text);
  return dir;
}

it('measures a fixture without loading imported connector data and records input hashes', () => {
  const result = measureIndependentPart(resolve('tests/fixtures/ldraw'), '3001');
  expect(result.status).toBe('measured');
  expect(result.measurements?.studs).toHaveLength(8);
  expect(result.measurements?.fullBoundsLdu).toEqual({ min: [-40, -4, -20], max: [40, 24, 20] });
  expect(result.sources['parts/3001.dat']).toMatch(/^[0-9a-f]{64}$/);
  expect(result.measurements).not.toHaveProperty('snaps');
});

it('quarantines incomplete geometry instead of measuring a misleading partial mesh', () => {
  const dir = library({ 'part.dat': '0 Part\n3 16 0 0 0 1 0 0 0 1 0\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 absent.dat\n' });
  const result = measureIndependentPart(dir, 'part');
  expect(result.status).toBe('incomplete');
  expect(result.measurements).toBeNull();
  expect(result.issues).toContain('Missing file: absent.dat');
  expect(measureIndependentPart(dir, 'absent').status).toBe('missing');
});

it('reports cyclic files', () => {
  const dir = library({ 'cycle.dat': '0 Cycle\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 cycle.dat\n' });
  const result = measureIndependentPart(dir, 'cycle');
  expect(result.status).toBe('incomplete');
  expect(result.issues).toContain('Cyclic reference: cycle.dat');
  expect(result.measurements).toBeNull();
});

it('rejects a hierarchy deeper than the geometry flattener supports', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 34; i++) files[`${i}.dat`] = i === 33
    ? '0 End\n3 16 0 0 0 1 0 0 0 1 0\n'
    : `0 Level\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${i + 1}.dat\n`;
  const result = measureIndependentPart(library(files), '0');
  expect(result.status).toBe('incomplete');
  expect(result.issues).toContain('Depth limit: 33.dat');
  expect(result.measurements).toBeNull();
});

it('records a high-resolution substitution and prefers the standard primitive when present', () => {
  const dir = library({ 'part.dat': '0 Part\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 1-12cyli.dat\n' });
  mkdirSync(join(dir, 'p', '48'), { recursive: true });
  const triangle = '0 Surface\n3 16 0 0 0 1 0 0 0 1 0\n';
  writeFileSync(join(dir, 'p', '48', '1-12cyli.dat'), triangle);
  const fallback = measureIndependentPart(dir, 'part');
  expect(fallback.status).toBe('measured');
  expect(fallback.resolutions['1-12cyli.dat']).toBe('p/48/1-12cyli.dat');
  expect(fallback.sources['p/48/1-12cyli.dat']).toMatch(/^[0-9a-f]{64}$/);
  writeFileSync(join(dir, 'p', '1-12cyli.dat'), triangle);
  expect(measureIndependentPart(dir, 'part').resolutions['1-12cyli.dat']).toBe('p/1-12cyli.dat');
});
