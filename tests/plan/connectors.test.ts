import { describe, expect, it } from 'vitest';
import { partConnectors, submodelConnectors, worldConnectors, type Connector } from '../../src/plan/connectors';
import { itemPlacement } from '../../src/model/assemble';
import { placementMatrix } from '../../src/model/assemble';
import type { Plan } from '../../src/plan/types';
import { measureReal, realMetrics, realPartsReady as ready } from '../helpers/realParts';

const near = (a: readonly number[], b: readonly number[], eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const males = (c: Connector[]) => c.filter((x) => x.gender === 'M');
const females = (c: Connector[]) => c.filter((x) => x.gender === 'F');

describe('connector model', () => {
  it.skipIf(!ready)('gives a 2x4 brick 8 up studs and 8 down sockets', async () => {
    const m = await measureReal('3001');
    const c = partConnectors(m);
    expect(males(c)).toHaveLength(8);
    expect(females(c)).toHaveLength(8);
    expect(males(c).every((s) => near(s.axis, [0, -1, 0]))).toBe(true);
    expect(females(c).every((s) => near(s.axis, [0, 1, 0]) && Math.abs(s.pos[1] - m.body.max[1]) < 1e-3)).toBe(true);
  });

  it.skipIf(!ready)('gives a 1x2 jumper one centre stud', async () => {
    const c = partConnectors(await measureReal('3794b'));
    const up = males(c).filter((s) => near(s.axis, [0, -1, 0]));
    expect(up).toHaveLength(1);
    expect(near([up[0].pos[0], up[0].pos[2]], [0, 0])).toBe(true);
  });

  it.skipIf(!ready)('gives a SNOT brick a sideways stud', async () => {
    const c = partConnectors(await measureReal('87087'));
    expect(males(c).some((s) => near(s.axis, [0, 0, -1]) || near(s.axis, [1, 0, 0]) || near(s.axis, [-1, 0, 0]))).toBe(true);
  });

  it.skipIf(!ready)('dedupes studs found by both metrics.studs and shadow snaps', async () => {
    for (const id of ['3001', '3023', '3794b', '87087']) {
      const c = partConnectors(await measureReal(id));
      for (let i = 0; i < c.length; i++)
        for (let j = i + 1; j < c.length; j++)
          if (c[i].gender === c[j].gender && near(c[i].axis, c[j].axis)) expect(Math.hypot(...c[i].pos.map((v, k) => v - c[j].pos[k]))).toBeGreaterThan(1);
    }
  });

  it.skipIf(!ready)('builds submodel connectors in the submodel frame', async () => {
    const metrics = await realMetrics(['3001']);
    const item = { id: 'b', part: '3001', color: 4, x: 1, y: 2, z: 0, rot: 90 as const };
    const plan = { steps: [], submodels: { s: { steps: [{ pieces: [item] }] } } } as unknown as Plan;
    const got = submodelConnectors(plan, 's', metrics, new Map());
    const want = worldConnectors(partConnectors(metrics('3001')), placementMatrix(itemPlacement(item, metrics('3001').body)).elements);
    expect(got).toHaveLength(16);
    for (const w of want) expect(got.some((g) => g.gender === w.gender && near(g.pos, w.pos) && near(g.axis, w.axis))).toBe(true);
  });
});
