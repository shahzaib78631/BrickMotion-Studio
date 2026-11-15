import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { auditModel } from '../../scripts/native/baseline-worker';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('measures a real model without planning', async () => {
  const row = await auditModel({ id: 'reference/public/data/test-10001.mpd', path: 'public/data/test-10001.mpd', source: 'reference', tier: 'smoke' }, { plan: false });
  expect(row.ok).toBe(true);
  expect(row.engine).toBe('web');
  expect(row.pieces).toBeGreaterThan(0);
  expect(row.joined).toBeGreaterThan(0);
  expect(row.joined).toBeLessThanOrEqual(row.pieces!);
  expect(row.groups).toBeGreaterThanOrEqual(1);
  expect(row.loadMs).toBeGreaterThan(0);
  expect(row.planOk).toBeUndefined();
}, 120_000);

test('an unknown part is listed and the model still counts as loaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-')); roots.push(dir);
  const file = join(dir, 'odd.ldr');
  writeFileSync(file, '0 odd\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 0 -24 0 1 0 0 0 1 0 0 0 1 nosuchpart-xyz.dat\n');
  const row = await auditModel({ id: 'fixture/odd.ldr', path: file, source: 'fixture', tier: 'smoke' }, { plan: false });
  expect(row.ok).toBe(true);
  expect(row.pieces).toBe(2);
  expect(row.unknownParts).toEqual(['nosuchpart-xyz']);
}, 120_000);

test('an unreadable file is a failed row, not an exception', async () => {
  const row = await auditModel({ id: 'fixture/none.ldr', path: '/nonexistent/none.ldr', source: 'fixture', tier: 'smoke' }, { plan: false });
  expect(row.ok).toBe(false);
  expect(row.error).toBeTruthy();
});
