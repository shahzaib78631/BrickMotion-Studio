import { expect, it } from 'vitest';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';
import { declaredSlotInterface } from '../../src/ldraw/attachments';
import { sameSlotInterface } from '../../src/model/attachmentPlacements';
import { partConnectors } from '../../src/plan/connectors';
import type { PartMetrics } from '../../src/ldraw/metrics';

const placeholder = (id: string): PartMetrics => ({ id, body: { min: [0, 0, 0], max: [20, 24, 20] }, full: { min: [0, 0, 0], max: [20, 24, 20] }, footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: true });

it.skipIf(!ready)('the declared interface is exactly what the documented sword presents', async () => {
  const declared = declaredSlotInterface('19141', '30173a')!;
  expect(declared).toHaveLength(1);
  const sword = partConnectors(await measureReal('30173a'));
  // so the table can never drift from the part the LDraw example names
  expect(sword.map((c) => ({ type: c.type, gender: c.gender, pos: c.pos, axis: c.axis })))
    .toEqual(declared.map((c) => ({ type: c.type, gender: c.gender, pos: c.pos, axis: c.axis })));
});

it.skipIf(!ready)('a katana is accepted for the slot even when the documented part is not loaded', async () => {
  const katana = await measureReal('21459');
  const metricsOf = (part: string) => (part === '21459' ? katana : placeholder(part));
  // the planner has no 30173a in the scene, so it can only know the interface from the slot data
  expect(metricsOf('30173a').placeholder).toBe(true);
  expect(sameSlotInterface('19141', '30173a', '21459', metricsOf)).toBe(true);
  // a part with a different interface is still refused
  const plate = await measureReal('3001');
  expect(sameSlotInterface('19141', '30173a', '3001', (part) => (part === '3001' ? plate : placeholder(part)))).toBe(false);
});
