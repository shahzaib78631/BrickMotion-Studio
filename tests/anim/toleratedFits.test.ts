/**
 * Fits accepted only within a tolerance are reported, so the model file can
 * be corrected: what was off, by how much, and the limit we allowed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeSnap, type CylSnapDef } from '../../src/ldraw/shadow';
import { worldSnaps } from '../../src/anim/snapMates';
import { profiledCylinderMate } from '../../src/anim/construction/profiledCylinderMate';
import { inspectMechanisms } from '../../src/anim/motion/v4/mechanismLab';
import { loadRealModel, partDataInstalled } from '../diagnostics/loadRealModel';

const M = [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number];
const def = (gender: 'M' | 'F', secs: { shape: string; radius: number; length: number }[], offset: [number, number, number]): CylSnapDef =>
  ({ kind: 'cyl', gender, caps: 'one', slide: false, center: false, secs, frames: [{ m: [...M], pos: offset }] });
const male = worldSnaps(placeSnap(def('M', [{ shape: 'R', radius: 10, length: 3 }, { shape: 'R', radius: 6, length: 4 }], [0, 0, 0]), [...M], [0, 0, 0]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])[0];
const female = (at: [number, number, number]) =>
  worldSnaps(placeSnap(def('F', [{ shape: 'R', radius: 6, length: 5 }], at), [...M], [0, 0, 0]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])[0];

describe('tolerated fits', () => {
  it('a clean fit reports nothing', () => {
    expect(profiledCylinderMate(male, female([0, -3, 0]))?.tolerated).toEqual([]);
  });
  it('a shoulder overlapping the hole by 0.4 LDU is reported as a section misfit', () => {
    const fits = profiledCylinderMate(male, female([0, -2.6, 0]))!.tolerated;
    expect(fits).toHaveLength(1);
    expect(fits[0]).toMatchObject({ rule: 'section-misfit', allowed: 0.5, unit: 'LDU' });
    expect(fits[0].measured).toBeCloseTo(0.4, 6);
  });
  it('an axis 0.8 LDU off is reported as an axis offset', () => {
    const fits = profiledCylinderMate(male, female([0.8, -3, 0]))!.tolerated;
    expect(fits.map(f => f.rule)).toEqual(['axis-offset']);
    expect(fits[0].measured).toBeCloseTo(0.8, 6);
    expect(fits[0].allowed).toBe(1.2);
  });
});

const M42000 = join(__dirname, '..', '..', 'samples', '42000-1.mpd');
describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 tolerated fits', () => {
  it('lists the right rear shock eye sitting 0.4 LDU along its pin', async () => {
    const { asm, metrics } = await loadRealModel(M42000);
    const report = inspectMechanisms(asm, metrics);
    const at = (part: string, x: number, y: number, z: number) => asm.instances.find(i => i.part.replace(/\.dat$/, '') === part &&
      Math.hypot(i.world.elements[12] - x, i.world.elements[13] - y, i.world.elements[14] - z) < 1)!.key;
    const eye = at('4255', 20, -120, 520), pin = at('6558', 20, -120, 520);
    const entry = report.tolerances.find(t => [t.a, t.b].sort().join() === [eye, pin].sort().join());
    expect(entry, report.tolerances.map(t => `${t.partA} ${t.partB}`).join('; ')).toBeDefined();
    expect(entry!.fits.find(f => f.rule === 'section-misfit')?.measured).toBeCloseTo(0.4, 1);
    // Worst first, and every entry says what to correct.
    const ratio = (t: (typeof report.tolerances)[0]) => Math.max(...t.fits.map(f => f.measured / f.allowed));
    for (let i = 1; i < report.tolerances.length; i++) expect(ratio(report.tolerances[i - 1])).toBeGreaterThanOrEqual(ratio(report.tolerances[i]));
    for (const t of report.tolerances) for (const f of t.fits) expect(f.detail.length).toBeGreaterThan(10);
  }, 120_000);
});
