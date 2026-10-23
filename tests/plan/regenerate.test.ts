import { expect, test } from 'vitest';
import type { Box } from '../../src/ldraw/flatten';
import { assemble, type Metrics } from '../../src/model/assemble';
import { splitPlanComponents } from '../../src/plan/components';
import { ensureIds } from '../../src/plan/ids';
import { modelSteps } from '../../src/plan/ops';
import { connectedIds } from '../../src/plan/pieceActions';
import { regenerateSteps } from '../../src/plan/regenerate';
import type { PieceItem, Plan } from '../../src/plan/types';

// Parts are plain boxes in part space (LDraw: -Y up, origin at the top).
const shapes: Record<string, Box> = {
  base: { min: [-280, 0, -60], max: [280, 16, 60] }, // train base, 16 LDU thick
  bogie: { min: [-40, 0, -30], max: [40, 24, 30] },
  wheel: { min: [-30, 0, -30], max: [30, 30, 30] },
  wall: { min: [-20, 0, -10], max: [20, 24, 10] },
  roof: { min: [-60, 0, -60], max: [60, 8, 60] },
  stack: { min: [-10, 0, -10], max: [10, 8, 10] },
};
const metrics: Metrics = (id) => ({ id, body: shapes[id], full: shapes[id], footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false });
const at = (part: string, x: number, y: number, z: number): PieceItem => ({ part, color: 4, ldu: [x, y, z], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });

/** a base at y=-100, two bogies with wheels under it, walls on it, a roof layer on top */
function train(): Plan {
  const pieces: PieceItem[] = [at('base', 0, -100, 0)];
  for (const x of [-200, 200]) pieces.push(at('bogie', x, -84, 0), at('wheel', x, -60, 0), at('wheel', x + 1, -60, 1));
  // walls: two rows along each side, three courses high
  for (let course = 0; course < 3; course++)
    for (let x = -240; x <= 240; x += 40) for (const z of [-50, 50]) pieces.push(at('wall', x, -124 - course * 24, z));
  // roof plates covering the top, and a few things on them
  for (const x of [-240, -120, 0, 120, 240]) pieces.push(at('roof', x, -180, 0));
  pieces.push(at('stack', 0, -188, 0), at('stack', 0, -196, 0), at('stack', 100, -188, 0));
  return ensureIds({ format: 'brickmotion-plan', version: 1, name: 'Train', steps: [{ pieces }] });
}

/** every piece's id, part and world box, rounded */
const placed = (p: Plan) => assemble(p, metrics, new Map()).instances
  .map((i) => `${i.part} ${[...i.worldBox.min, ...i.worldBox.max].map(Math.round).join(',')}`).sort();

test('regenerating steps puts the old components back and splits again: same pieces, same places, no duplicates', () => {
  const split = splitPlanComponents(train(), metrics, new Map()).plan;
  const again = regenerateSteps(split, '', metrics, new Map());
  expect(Object.keys(again.submodels ?? {}).sort()).toEqual(Object.keys(split.submodels ?? {}).sort());
  expect(placed(again)).toEqual(placed(train()));
  expect(modelSteps(again, '').length).toBeGreaterThan(1);
});

test('regenerating a model with hand-made steps gives it layered steps', () => {
  const pieces = Array.from({ length: 12 }, (_, k) => at('stack', 0, -8 * k, 0));
  const plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'Tower', steps: [{ pieces: pieces.slice(6) }, { pieces: pieces.slice(0, 6) }] });
  const out = regenerateSteps(plan, '', metrics, new Map());
  expect(placed(out)).toEqual(placed(plan));
  // bottom first: the first step holds the lowest pieces
  const first = modelSteps(out, '')[0].pieces as PieceItem[];
  expect(Math.max(...first.map((i) => ('ldu' in i ? i.ldu[1] : 0))) === 0).toBe(true);
});

test('touching and connected selection follow contacts, but not through the base', () => {
  const plan = train();
  const items = modelSteps(plan, '')[0].pieces as (PieceItem & { id: string })[];
  const id = (part: string, x: number, y?: number) => items.find((i) => i.part === part && 'ldu' in i && i.ldu[0] === x && (y === undefined || i.ldu[1] === y))!.id;
  const bogie = id('bogie', -200);
  expect(connectedIds(plan, '', [bogie], 'touching', metrics, new Map()).sort()).toEqual([bogie, id('wheel', -200), id('wheel', -199), id('base', 0)].sort());
  // the bogie's group reaches the base, but the search stops there: the other bogie is not taken
  const group = connectedIds(plan, '', [bogie], 'connected', metrics, new Map());
  expect(group).toContain(id('base', 0));
  expect(group).not.toContain(id('bogie', 200));
  // starting on the base, everything joined to it comes along
  expect(connectedIds(plan, '', [id('base', 0)], 'connected', metrics, new Map())).toContain(id('bogie', 200));
});

test('a small model keeps its steps: there is nothing to layer', () => {
  const plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'Two', steps: [{ pieces: [at('stack', 0, 0, 0)] }, { pieces: [at('stack', 0, -8, 0)] }] });
  expect(regenerateSteps(plan, '', metrics, new Map())).toBe(plan);
});
