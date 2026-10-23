import { expect, test } from 'vitest';
import type { Box } from '../../src/ldraw/flatten';
import { assemble, type Metrics } from '../../src/model/assemble';
import { buildInComponents, modelsToSplit, splitPlanComponents } from '../../src/plan/components';
import { ensureIds } from '../../src/plan/ids';
import { modelSteps } from '../../src/plan/ops';
import { isSub, type PieceItem, type Plan } from '../../src/plan/types';

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

test('a step-less train splits into its bogies and its roof; every piece stays where it was', () => {
  const plan = train();
  expect(modelsToSplit(plan)).toEqual(['']);
  const { plan: out, components } = splitPlanComponents(plan, metrics, new Map());
  expect(components).toEqual(['Train - underside 1', 'Train - underside 2', 'Train - top 1']);
  const parts = (m: string) => modelSteps(out, m).flatMap((s) => s.pieces).map((i) => ('part' in i ? i.part : `[${i.submodel}]`)).sort();
  expect(parts('Train - underside 1')).toEqual(['bogie', 'wheel', 'wheel']);
  expect(parts('Train - top 1')).toEqual(['roof', 'roof', 'roof', 'roof', 'roof', 'stack', 'stack', 'stack']);
  // the base and the walls stay in the train itself, next to the three components
  const main = modelSteps(out, '').flatMap((s) => s.pieces);
  expect(main.filter(isSub)).toHaveLength(3);
  expect(main.filter((i) => !isSub(i))).toHaveLength(1 + 13 * 2 * 3);
  // same world placements before and after
  const where = (p: Plan) => assemble(p, metrics, new Map()).instances.map((i) => `${i.part}@${[12, 13, 14].map((k) => i.world.elements[k]).join(',')}`).sort();
  expect(where(out)).toEqual(where(plan));
});

test('a model without an underside or a roof is left as it is', () => {
  const pieces: PieceItem[] = [];
  for (let k = 0; k < 45; k++) pieces.push(at('wall', (k % 9) * 40, -24 * Math.floor(k / 9), 0));
  const plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'Wall', steps: [{ pieces }] });
  const r = buildInComponents(plan, '', metrics, new Map());
  expect(r.components).toEqual([]);
  expect(r.plan).toBe(plan);
});

test('a model that is already split is not offered again', () => {
  const { plan } = splitPlanComponents(train(), metrics, new Map());
  expect(buildInComponents(plan, '', metrics, new Map()).components).toEqual([]);
});
