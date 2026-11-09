import { describe, expect, it } from 'vitest';
import { castleSpec, generateCastle } from '../../src/generate/castle';
import { certify } from '../../src/generate/certify';
import type { PlanItem } from '../../src/plan/types';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const ids = (items: PlanItem[]) => [...new Set(items.flatMap((p) => ('part' in p ? [p.part] : [])))];

describe('castle spec', () => {
  it('keeps what was asked for and snaps sizes to baseplates', () => {
    const s = castleSpec(7, { width: 50, depth: 64, keepFloors: 3, moat: false, towerTop: 'roof', stone: 'sand' });
    expect(s).toMatchObject({ width: 48, depth: 64, keepFloors: 3, moat: false, moatWidth: 0, towerTop: 'roof', stone: 'sand' });
    expect(s.rooms).toEqual(['great hall', 'royal chambers', 'treasury and armoury']);
  });
  it('is the same castle for the same seed', () => {
    const a = generateCastle(castleSpec(11, { width: 32 }));
    const b = generateCastle(castleSpec(11, { width: 32 }));
    expect(a.plan).toEqual(b.plan);
  });
});

describe.skipIf(!ready)('castles are buildable', () => {
  const cases = [
    { width: 32, depth: 32, keepFloors: 2, moat: true, towerTop: 'battlements' as const },
    { width: 48, depth: 48, keepFloors: 3, moat: true, towerTop: 'roof' as const },
    { width: 64, depth: 48, keepFloors: 2, moat: false, towerTop: 'roof' as const, openBack: false },
  ];
  for (const over of cases) {
    it(`${over.width}×${over.depth}, ${over.keepFloors} floors, ${over.moat ? 'moat' : 'no moat'}, ${over.towerTop}`, async () => {
      const t0 = performance.now();
      const g = generateCastle(castleSpec(1234, over));
      const t1 = performance.now();
      const items = g.plan.steps.flatMap((s) => s.pieces);
      await useAppParts(ids(items));
      const c = await certify(g.plan, g.built.components);
      const t2 = performance.now();
      console.log(`${over.width}×${over.depth}: ${items.length} pieces, generate ${Math.round(t1 - t0)} ms, certify ${Math.round(t2 - t1)} ms`,
        JSON.stringify({ parts: c.parts, floating: c.floating, overlapping: c.overlapping, unknown: c.unknown, tipping: c.tipping, buildable: c.buildable }),
        g.plan.steps.map((s) => `${s.title}: ${s.pieces.length}`).join(' | '));
      expect(g.built.components).toBe(1);
      expect(c).toMatchObject({ parts: 1, floating: 0, overlapping: 0, unknown: 0, buildable: true });
    }, 300000);
  }
});
