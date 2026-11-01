import { expect, test } from 'vitest';
import type { Box } from '../../src/ldraw/flatten';
import { placementMatrix, transformBox, type Assembly, type Instance } from '../../src/model/assemble';
import { gridToPlacement } from '../../src/plan/placement';
import { findFreeSpot } from '../../src/state/editing';

/** A 2×4 brick: 2 studs wide, a brick tall, 1 stud deep. */
const BRICK: Box = { min: [0, -24, 0], max: [40, 0, 20] };

const instance = (body: Box, x: number, z: number): Instance => {
  const world = placementMatrix(gridToPlacement({ x, y: 0, z, rot: 0 }, body));
  return { key: `${x}/${z}`, itemId: `${x}/${z}`, model: '', part: '3001', color: 4, world, worldBox: transformBox(body, world), placeholder: false, grid: true };
};

const view = (instances: Instance[]): Assembly => ({ nodes: [], instances, bounds: instances[0]?.worldBox ?? null, problems: [] });

const at = (body: Box, spot: ReturnType<typeof findFreeSpot>): Box => transformBox(body, placementMatrix(gridToPlacement(spot, body)));

/** How far two floor boxes stand apart: 0 when their faces touch, positive when there is a gap. */
const gapBetween = (a: Box, b: Box) =>
  Math.max(Math.max(a.min[0] - b.max[0], b.min[0] - a.max[0]), Math.max(a.min[2] - b.max[2], b.min[2] - a.max[2]));

test('a single added part still lands flush against the model', () => {
  const other = instance(BRICK, 0, 0);
  expect(gapBetween(at(BRICK, findFreeSpot(view([other]), BRICK)), other.worldBox)).toBe(0);
});

test('an imported part keeps a stud of clear floor around it', () => {
  const other = instance(BRICK, 0, 0);
  expect(gapBetween(at(BRICK, findFreeSpot(view([other]), BRICK, 20)), other.worldBox)).toBeGreaterThanOrEqual(19);
});

test('imported parts stay a stud apart as the tray fills up', () => {
  const instances: Instance[] = [];
  const boxes: Box[] = [];
  for (let i = 0; i < 12; i++) {
    const spot = findFreeSpot(view(instances), BRICK, 20);
    boxes.push(at(BRICK, spot));
    instances.push(instance(BRICK, spot.x, spot.z));
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) expect(gapBetween(boxes[i], boxes[j])).toBeGreaterThanOrEqual(19);
});
