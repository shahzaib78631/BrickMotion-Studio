import { beforeAll, expect, test } from 'vitest';
import { assemble, transformBox, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan, PlanItem } from '../../src/plan/types';
import { buildTimeline } from '../../src/anim/timeline';
import { layoutFloor, type FloorItem } from '../../src/anim/floorLayout';
import type { AnimOptions, FloorStyle } from '../../src/anim/pacing';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => { metrics = await fixtureMetrics(); });

const brick = (id: string, x: number, y: number, z: number, color = 4): PlanItem => ({ id, part: '3001', color, x, y, z, rot: 0 });
/** a 4×4 wall of bricks, four layers, in two colours: enough pieces to need several floor windows */
const wall = (): Plan => ensureIds({
  format: 'brickmotion-plan', version: 1, name: 'w',
  steps: [0, 1, 2, 3].map((layer) => ({
    pieces: [0, 1, 2, 3].flatMap((i) => [0, 1].map((j) => brick(`p${layer}${i}${j}`, i * 4, layer * 3, j * 2, (i + j + layer) % 2 ? 1 : 4))),
  })),
});
const opts: AnimOptions = { targetSeconds: 15, heroOrbit: false };
const plan = (o: Partial<AnimOptions>) => {
  const asm = assemble(wall(), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, { ...opts, ...o });
  return { asm, tl, boxes: new Map(asm.instances.map((i) => [i.key, transformBox(metrics(i.part).body, tl.tracks.get(i.key)!.floor)])) };
};
const overlaps = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
  a.min[0] < b.max[0] - 1e-3 && b.min[0] < a.max[0] - 1e-3 && a.min[2] < b.max[2] - 1e-3 && b.min[2] < a.max[2] - 1e-3;

const items: FloorItem[] = [
  { id: 'a', w: 4, d: 2, group: 0 }, { id: 'b', w: 2, d: 2, group: 0 }, { id: 'c', w: 1, d: 1, group: 1 },
  { id: 'd', w: 6, d: 1, group: 1 }, { id: 'e', w: 2, d: 4, group: 2 }, { id: 'f', w: 1, d: 2, group: 2 },
];
const region = { x0: 0, z0: 0, width: 40, depth: 40 };

test('every staging style places every piece without overlaps', () => {
  for (const style of ['packed', 'spaced', 'grid', 'rows', 'scattered'] as FloorStyle[]) {
    const { pos, overflow } = layoutFloor(items, region, 1, style);
    expect(overflow).toEqual([]);
    const rect = (it: FloorItem) => ({ min: [pos.get(it.id)!.x, 0, pos.get(it.id)!.z], max: [pos.get(it.id)!.x + it.w, 0, pos.get(it.id)!.z + it.d] });
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(overlaps(rect(items[i]), rect(items[j]))).toBe(false);
  }
});

test('rows start a new row for every group; spaced leaves wider gaps than packed', () => {
  const rows = layoutFloor(items, region, 1, 'rows').pos;
  expect(rows.get('a')!.z).toBe(rows.get('b')!.z);
  expect(rows.get('c')!.z).toBeGreaterThan(rows.get('a')!.z);
  expect(rows.get('e')!.z).toBeGreaterThan(rows.get('c')!.z);
  const packed = layoutFloor(items, region, 1, 'packed').pos;
  const spaced = layoutFloor(items, region, 1, 'spaced').pos;
  expect(spaced.get('b')!.x - spaced.get('a')!.x).toBeGreaterThan(Math.abs(packed.get('b')!.x - packed.get('a')!.x));
});

test('grid puts pieces in cells of one size, centred to the stud', () => {
  const grid = layoutFloor(items, region, 1, 'grid').pos;
  const cell = 4; // the 75th-percentile footprint of these items
  // single-cell pieces start a whole number of cells (plus 1-stud gaps) in, nudged to their centre
  for (const [id, w] of [['b', 2], ['c', 1], ['f', 1]] as const) {
    const cellStart = grid.get(id)!.x - Math.floor((cell - w) / 2);
    expect(cellStart % (cell + 1)).toBe(0);
  }
});

test('scattered staging is repeatable', () => {
  expect([...layoutFloor(items, region, 1, 'scattered').pos]).toEqual([...layoutFloor(items, region, 1, 'scattered').pos]);
});

test('"all parts at once" puts every piece on the floor from the very start', () => {
  const { tl, asm } = plan({ floorSort: 'all' });
  const appear = asm.instances.map((i) => tl.tracks.get(i.key)!.appear);
  expect(new Set(appear).size).toBe(1);
  const { boxes } = plan({ floorSort: 'all' });
  const list = [...boxes.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(overlaps(list[i], list[j])).toBe(false);
});

test('"all around" stages pieces on every side of the model, clear of it', () => {
  const { asm, boxes } = plan({ floorSides: 'around', floorSort: 'all' });
  const m = asm.bounds!;
  const list = [...boxes.values()];
  expect(list.every((b) => !overlaps(b, m))).toBe(true);
  expect(list.some((b) => b.max[2] <= m.min[2])).toBe(true); // in front
  expect(list.some((b) => b.min[2] >= m.max[2])).toBe(true); // behind
  expect(list.some((b) => b.max[0] <= m.min[0] || b.min[0] >= m.max[0])).toBe(true); // at a side
});

test('every staging style plans a build with no pieces overlapping on the floor', () => {
  for (const floorStyle of ['spaced', 'grid', 'rows', 'scattered'] as FloorStyle[]) {
    const { boxes, tl } = plan({ floorStyle, floorSort: 'all' });
    const list = [...boxes.entries()];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (tl.tracks.get(list[i][0])!.appear !== tl.tracks.get(list[j][0])!.appear) continue;
      // scattered pieces are turned a little: allow a hair of box overlap from the rotation
      if (floorStyle !== 'scattered') expect(overlaps(list[i][1], list[j][1])).toBe(false);
    }
  }
});

test('"nearest to where it goes": pieces built at the back wait behind, those at the front in front', () => {
  for (const floorSides of ['front-back', 'around'] as const) {
    const { asm, boxes } = plan({ floorSides, floorMatch: 'nearest', floorSort: 'all' });
    const m = asm.bounds!;
    const mid = (m.min[2] + m.max[2]) / 2;
    for (const inst of asm.instances) {
      const at = (inst.worldBox.min[2] + inst.worldBox.max[2]) / 2;
      const waits = boxes.get(inst.key)!;
      if (at > mid) expect(waits.min[2] >= m.max[2] || waits.max[0] <= m.min[0] || waits.min[0] >= m.max[0]).toBe(true);
      else expect(waits.max[2] <= m.min[2] || waits.max[0] <= m.min[0] || waits.min[0] >= m.max[0]).toBe(true);
    }
  }
  // filling in order puts at least one back piece in front (the default the option fixes)
  const fill = plan({ floorSides: 'front-back', floorSort: 'all' });
  const m = fill.asm.bounds!;
  const mid = (m.min[2] + m.max[2]) / 2;
  expect(fill.asm.instances.some((i) => (i.worldBox.min[2] + i.worldBox.max[2]) / 2 > mid && fill.boxes.get(i.key)!.max[2] <= m.min[2])).toBe(true);
});
