import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importLDraw } from '../../src/io/ldrawImport';
import { certifyModel } from '../../src/anim/brickheadz/mesh';
import { loadNodeLibrary } from '../../scripts/brickheadz-node';

const LIB = resolve('public/ldraw');
const FIXTURES = resolve('tests/fixtures/brickheadz');
const ready = existsSync(join(LIB, 'parts')) && existsSync(resolve('vendor/LDCadShadowLibrary'));

// The LDraw library is a git-ignored, on-demand download; skip when it is absent.
describe.skipIf(!ready)('generated model passes mesh certification', () => {
  const lib = loadNodeLibrary(LIB);

  it('the MPD fixture certifies CLEAR', () => {
    const plan = importLDraw(readFileSync(join(FIXTURES, 'bh-sample.mpd'), 'utf8'), 'bh-sample.mpd');
    const report = certifyModel(plan, lib.measurePlan(plan), lib.colors);
    expect(report.verdict, JSON.stringify(report.overlaps.slice(0, 6))).toBe('CLEAR');
    expect(report.pieces).toBeGreaterThan(30);
  });

  it('the plan fixture certifies CLEAR', () => {
    const plan = JSON.parse(readFileSync(join(FIXTURES, 'bh-sample.plan.json'), 'utf8'));
    const report = certifyModel(plan, lib.measurePlan(plan), lib.colors);
    expect(report.verdict, JSON.stringify(report.overlaps.slice(0, 6))).toBe('CLEAR');
  });

  it('a cast (learned-pattern) fixture certifies CLEAR', () => {
    const plan = JSON.parse(readFileSync(join(FIXTURES, 'bh-cast.plan.json'), 'utf8'));
    const report = certifyModel(plan, lib.measurePlan(plan), lib.colors);
    expect(report.verdict, JSON.stringify(report.overlaps.slice(0, 6))).toBe('CLEAR');
    expect(report.pieces).toBeGreaterThan(35);
  });
});
