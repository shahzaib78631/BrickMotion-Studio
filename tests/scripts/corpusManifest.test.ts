import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildManifest } from '../../scripts/native/corpus-manifest';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'corpus-')); roots.push(root); return root; };
const put = (path: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '0 model\n'); };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree() {
  const data = temp(), repo = temp();
  for (const f of ['10001-1/main.mpd', '10002-1/a.mpd', '10002-1/b.ldr']) put(join(data, 'omr/models', f));
  put(join(data, 'omr/models/10002-1/info.json'));
  for (let i = 0; i < 5000; i++) put(join(data, 'bricknet/models', `sft_${String(i).padStart(5, '0')}.ldr`));
  for (const f of ['a.mpd', 'b.io', 'c.lxf', 'd.mpd copy', 'e.dat']) put(join(data, 'MOC', f));
  put(join(repo, 'tests/fixtures/models/car.mpd'));
  put(join(repo, 'tests/fixtures/ldraw/LDConfig.ldr'));
  put(join(repo, 'samples/8880-1.mpd'));
  put(join(repo, 'samples/other.mpd'));
  return { data, repo };
}

test('lists omr files, a fixed bricknet sample, reference sets and fixtures', () => {
  const { data, repo } = tree();
  const m = buildManifest(data, repo);
  const count = (s: string) => m.filter(e => e.source === s).length;
  expect(count('omr')).toBe(3);
  expect(count('bricknet')).toBe(2000);
  expect(count('fixture')).toBe(1);
  expect(m.filter(e => e.source === 'moc').map(e => e.path)).toEqual(['MOC/a.mpd', 'MOC/b.io']);
  expect(m.filter(e => e.source === 'moc').every(e => e.tier === 'smoke')).toBe(true);
  expect(m.filter(e => e.source === 'reference').map(e => e.id)).toEqual(['reference/samples/8880-1.mpd']);
  expect(m.map(e => e.id)).toEqual([...m.map(e => e.id)].sort());
  for (const e of m) expect(existsSync(join(e.source === 'omr' || e.source === 'bricknet' || e.source === 'moc' ? data : repo, e.path))).toBe(true);
});

test('is the same on a second call, and marks the smoke tier', () => {
  const { data, repo } = tree();
  const a = buildManifest(data, repo);
  expect(buildManifest(data, repo)).toEqual(a);
  const smoke = a.filter(e => e.tier === 'smoke');
  expect(smoke.filter(e => e.source === 'bricknet').length).toBe(25);
  expect(smoke.filter(e => e.source === 'omr').length).toBe(3);
  expect(a.filter(e => e.source === 'fixture' || e.source === 'reference').every(e => e.tier === 'smoke')).toBe(true);
});

test('a missing data directory gives an empty source, not an error', () => {
  const repo = temp();
  put(join(repo, 'tests/fixtures/a.ldr'));
  expect(buildManifest(join(repo, 'nowhere'), repo).map(e => e.source)).toEqual(['fixture']);
});
