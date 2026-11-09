import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Placed } from '../../src/suggest/engine';
import { fitsAt, openSpots, spotLabel, type Habits, type FitsInput } from '../../src/suggest/fitsAt';
import { isLoaded, metricsOf } from '../../src/state/partService';
import { appPartsReady, useAppParts } from '../helpers/appParts';

const file = join(__dirname, '..', '..', 'public', 'data', 'suggest', 'habits.json');
const habits: Habits | null = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const ready = appPartsReady && !!habits;

const at = (key: string, part: string, x: number, y: number, z: number, color = 4): Placed =>
  ({ key, part, color, world: new THREE.Matrix4().makeTranslation(x, y, z) });
const metrics = (p: string) => (isLoaded(p) ? metricsOf(p) : null);

/** Ask until every part the engine wants is loaded. */
async function ask(input: Omit<FitsInput, 'metrics' | 'habits'>) {
  await useAppParts(input.pieces.map((p) => p.part));
  for (let i = 0; ; i++) {
    const out = fitsAt({ ...input, metrics, habits, budgetMs: 20000 });
    if (!out.wanted.length || i > 4) return out;
    await useAppParts(out.wanted).catch(() => undefined);
  }
}

describe('habit table', () => {
  it.skipIf(!habits)('is mined from the BrickNet models', () => {
    expect(habits!.models).toBeGreaterThan(60000);
    // a 1×2 plate goes on a 1×2 plate, one plate up (Y down)
    const h = habits!.habits['3023']?.[0] ?? habits!.habits['3023b']?.[0];
    expect(h).toBeDefined();
  });
  it('names connections the way a builder would', () => {
    expect(spotLabel({ type: 'pin', gender: 'F', axis: [0, 0, 1] })).toBe('Technic hole');
    expect(spotLabel({ type: 'stud', gender: 'M', axis: [0, -1, 0] })).toBe('free stud');
  });
});

describe.skipIf(!ready)('what fits here', () => {
  it('puts a pin in a Technic brick hole', async () => {
    // Technic brick 1×4 (3701): holes run along Z, 10 LDU below the top; point at the side of one
    const pieces = [at('a', '3701', 0, 0, 0)];
    const out = await ask({ pieces, key: 'a', point: [-10, 10, 12] });
    expect(out.spot?.label).toBe('Technic hole');
    expect(out.fits.length).toBeGreaterThan(0);
    const parts = out.fits.map((f) => f.pieces[0].part);
    expect(parts.some((p) => ['2780', '3673', '6558', '4274', '43093'].includes(p))).toBe(true);
    expect(out.fits.every((f) => f.links > 0 && f.why.length > 0)).toBe(true);
    console.log(out.fits.map((f) => `${f.pieces[0].part} ${f.score.toFixed(1)} ${f.why}`).join('\n'));
  }, 60000);

  it('offers plates and bricks for a free stud, with where builders put them', async () => {
    const pieces = [at('a', '3020', 0, 0, 0)];
    const out = await ask({ pieces, key: 'a', point: [30, -8, 10] });
    expect(out.spot?.label).toBe('free stud');
    expect(out.fits.length).toBeGreaterThanOrEqual(4);
    // every fit sits on the plate (above it: Y down, so above is y < 0)
    for (const f of out.fits) expect(f.pieces[0].world[13]).toBeLessThan(0);
    expect(out.fits.some((f) => /BrickNet models/.test(f.why))).toBe(true);
  }, 60000);

  it('flags the open holes of a Technic brick, one per hole', async () => {
    const pieces = [at('a', '3701', 0, 0, 0)];
    await useAppParts(['3701']);
    const spots = openSpots(pieces, ['a'], metrics);
    expect(spots.length).toBe(3);
    expect(spots.every((s) => s.label === 'Technic hole')).toBe(true);
  }, 60000);
});
