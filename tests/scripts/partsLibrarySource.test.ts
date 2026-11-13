import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resolvePartsLibrary } from '../../scripts/parts-library-source';
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'parts-source-')); roots.push(root); return root; };
function library(root: string) {
  mkdirSync(join(root, 'parts'), { recursive: true });
  mkdirSync(join(root, 'p'), { recursive: true });
  writeFileSync(join(root, 'parts', '3001.dat'), '0 Brick');
  writeFileSync(join(root, 'p', 'stud.dat'), '0 Stud');
  writeFileSync(join(root, 'LDConfig.ldr'), '0 Colors');
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('resolves official complete.zip ldraw wrapper', () => {
  const root = temp(); library(join(root, 'ldraw'));
  expect(resolvePartsLibrary(root, true)).toBe(join(root, 'ldraw'));
});
test('accepts a flat library', () => {
  const root = temp(); library(root);
  expect(resolvePartsLibrary(root, true)).toBe(root);
});
test('rejects empty or incomplete archives before applying', () => {
  const root = temp();
  expect(() => resolvePartsLibrary(root, true)).toThrow('left unchanged');
  mkdirSync(join(root, 'parts')); writeFileSync(join(root, 'parts', '3001.dat'), '0 Brick');
  expect(() => resolvePartsLibrary(root, true)).toThrow('left unchanged');
});
