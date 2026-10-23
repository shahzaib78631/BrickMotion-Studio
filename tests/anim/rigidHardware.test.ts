import { expect, test } from 'vitest';
import { rigidWheelPairs } from '../../src/anim/rigidHardware';
import type { ANode, Metrics } from '../../src/model/assemble';
import type { Box } from '../../src/ldraw/flatten';
import type { PartMetrics } from '../../src/ldraw/metrics';
import { supplementarySnapsFor } from '../../src/data/connectorLibrary';

type Piece = Extract<ANode, { kind: 'piece' }>;
const boxes: Record<string, Box> = {
  '42610': { min: [-14, -14, -10], max: [14, 14, 10] },
  '51011': { min: [-21.9198, -21.9198, -8], max: [21.9198, 21.9198, 8] },
  '13971': { min: [-21, -21, -10], max: [21, 21, 10] },
  '61254': { min: [-29.63138298, -29.631, -9], max: [29.63138298, 29.631, 9] },
  '41893': { min: [-53.87, -53.87, -45], max: [53.87, 53.87, 45] },
  '56908': { min: [-53.87, -53.87, -20], max: [53.87, 53.87, 20] },
  '44772': { min: [-64.99, -64.99, -20], max: [64.99, 64.99, 20] },
};
const piece = (itemId: string, part: string, pos: [number, number, number] = [0, 0, 0]): Piece => ({
  kind: 'piece', itemId, model: 'test', step: 0, order: 0, part, color: 16, placeholder: false,
  body: boxes[part], grid: false, local: { pos, m: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
});
const metricsWith = (snapParts: string[]): Metrics => (part) => {
  const body = boxes[part];
  return {
    id: part, body, full: body, footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false,
    mesh: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    snaps: snapParts.includes(part) ? supplementarySnapsFor(part) : [],
  } as PartMetrics;
};

test('a tyre with only its own seat connector still pairs with the matching rim', () => {
  const groups = rigidWheelPairs([piece('1', '42610'), piece('2', '51011')], metricsWith(['51011']));
  expect(groups).toHaveLength(1);
  expect(groups[0].kind).toBe('wheel');
  expect(groups[0].members.map((member) => member.node.itemId).sort()).toEqual(['1', '2']);
});

test('the same pair is not added twice when both sides have supplementary connectors', () => {
  const groups = rigidWheelPairs([piece('1', '42610'), piece('2', '51011')], metricsWith(['42610', '51011']));
  expect(groups).toHaveLength(1);
});

test('a tyre beside its rim is not seated, so it is not paired', () => {
  expect(rigidWheelPairs([piece('1', '42610'), piece('2', '51011', [40, 0, 0])], metricsWith(['51011']))).toHaveLength(0);
});

test('a rim slid out of the side of its tyre is not seated', () => {
  expect(rigidWheelPairs([piece('1', '42610', [0, 0, 6]), piece('2', '51011')], metricsWith(['51011']))).toHaveLength(0);
  expect(rigidWheelPairs([piece('1', '42610', [0, 0, -6]), piece('2', '51011')], metricsWith(['51011']))).toHaveLength(0);
});

test('the seat radius must match the tyre bore', () => {
  expect(rigidWheelPairs([piece('1', '13971'), piece('2', '51011')], metricsWith(['51011']))).toHaveLength(0);
});

test('the large 61254 tyre pairs with the 13971 rim', () => {
  const groups = rigidWheelPairs([piece('1', '13971'), piece('2', '61254')], metricsWith(['61254']));
  expect(groups).toHaveLength(1);
  expect(groups[0].members.map((member) => member.node.part).sort()).toEqual(['13971', '61254']);
});

test('a generated measured seat pairs a tyre and rim without LDCad or hand data', () => {
  const groups = rigidWheelPairs([piece('1', '56908'), piece('2', '41893')], metricsWith(['41893']));
  expect(groups).toHaveLength(1);
  expect(groups[0].members.map((member) => member.node.part).sort()).toEqual(['41893', '56908']);
});

test('a generated seat still rejects a rim whose measured radius is too different', () => {
  expect(rigidWheelPairs([piece('1', '44772'), piece('2', '41893')], metricsWith(['41893']))).toHaveLength(0);
});
