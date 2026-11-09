import { describe, expect, it } from 'vitest';
import { brickify } from '../../src/generate/brickify';
import { certify } from '../../src/generate/certify';
import { Voxels } from '../../src/generate/voxels';
import type { Plan, PlanItem } from '../../src/plan/types';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

/** Bricks for a shape, as one plan step. */
function planOf(items: PlanItem[]): Plan {
  return { format: 'brickmotion-plan', version: 1, name: 'test', steps: [{ pieces: items }] } as Plan;
}
const ids = (items: PlanItem[]) => [...new Set(items.flatMap((p) => ('part' in p ? [p.part] : [])))];
const bricks = (v: Voxels) => brickify(v).items;

describe.skipIf(!ready)('the certificate', () => {
  it('passes a wall of bricks laid in bond', async () => {
    const items = bricks(Voxels.from(8, 1, 9, () => 4));
    await useAppParts(ids(items));
    expect(await certify(planOf(items))).toMatchObject({ buildable: true, parts: 1, floating: 0, overlapping: 0 });
  });

  it('fails two towers that only touch side by side, whatever the generator claims', async () => {
    // two 2×2 columns one stud apart in x... then pushed together: they touch but no brick spans both
    const left = bricks(Voxels.from(2, 2, 9, () => 4));
    const right = left.map((p) => ({ ...p, x: (p as { x: number }).x + 2 }));
    const items = [...left, ...right];
    await useAppParts(ids(items));
    const c = await certify(planOf(items), 1);
    expect(c.parts).toBe(2);
    expect(c.floating).toBe(0); // both stand on the ground: only the parts count catches it
    expect(c.buildable).toBe(false);
  });

  it('fails a brick floating above the rest', async () => {
    const base = bricks(Voxels.from(4, 2, 3, () => 4));
    const lifted = base.map((p) => ({ ...p, y: (p as { y: number }).y + 6 }));
    const items = [...base, ...lifted];
    await useAppParts(ids(items));
    const c = await certify(planOf(items));
    expect(c.buildable).toBe(false);
    expect(c.parts).toBe(2);
    expect(c.floating).toBeGreaterThan(0);
  });

  it('fails two bricks in the same place', async () => {
    const base = bricks(Voxels.from(4, 2, 3, () => 4));
    const items = [...base, ...base.map((p) => ({ ...p }))];
    await useAppParts(ids(items));
    const c = await certify(planOf(items));
    expect(c.buildable).toBe(false);
    expect(c.overlapping).toBeGreaterThan(0);
  });

  it('fails a post with a long arm that tips it over, and passes the arm held centred', async () => {
    // a 2×2 post one brick tall with a beam two bricks thick on top: reaching 8 studs to one side it falls,
    // centred over the post (a T) it stands
    const arm = (from: number) => bricks(Voxels.from(10, 2, 9, (x, y) => (y >= 3 || (x >= from && x < from + 2) ? 4 : null)));
    const tips = arm(0), stands = arm(4);
    await useAppParts([...ids(tips), ...ids(stands)]);
    const t = await certify(planOf(tips));
    expect(t.parts).toBe(1);
    expect(t.tipping).toBe(1);
    expect(t.buildable).toBe(false);
    expect(await certify(planOf(stands))).toMatchObject({ tipping: 0, buildable: true });
  });
});
