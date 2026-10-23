import { expect, test } from 'vitest';
import { ensureIds } from '../../src/plan/ids';
import { importAsSubmodel, reachableSubmodels, standalonePlan } from '../../src/plan/modelFiles';
import type { Plan, PlanItem } from '../../src/plan/types';

const brick = (x: number): PlanItem => ({ part: '3001', color: 4, x, y: 0, z: 0, rot: 0 });
const sub = (submodel: string): PlanItem => ({ submodel, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
const set: Plan = ensureIds({
  format: 'brickmotion-plan', version: 1, name: 'truck set',
  steps: [{ pieces: [brick(0), sub('truck')] }, { pieces: [sub('trailer')] }],
  submodels: {
    truck: { steps: [{ pieces: [brick(1), sub('wheel')] }] },
    wheel: { steps: [{ pieces: [brick(2)] }] },
    trailer: { steps: [{ pieces: [brick(3)] }] },
    spare: { steps: [{ pieces: [brick(4)] }] },
  },
});

test('a submodel saved on its own keeps only the submodels it builds', () => {
  expect(reachableSubmodels(set, 'truck')).toEqual(['wheel']);
  const truck = standalonePlan(set, 'truck');
  expect(truck.name).toBe('truck');
  expect(truck.steps).toEqual(set.submodels!.truck.steps);
  expect(Object.keys(truck.submodels!)).toEqual(['wheel']);
  expect(standalonePlan(set, '')).toBe(set);
});

test('an imported file becomes a submodel placed in a new last step, names and ids kept apart', () => {
  const incoming: Plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'x', steps: [{ pieces: [brick(9), sub('wheel')] }], submodels: { wheel: { steps: [{ pieces: [brick(8)] }] } } });
  const r = importAsSubmodel(set, 'truck', incoming, 'truck');
  expect(r.name).toBe('truck 2'); // "truck" is taken
  const truckSteps = r.plan.submodels!.truck.steps;
  expect(truckSteps).toHaveLength(2);
  expect(truckSteps[1].pieces[0]).toMatchObject({ submodel: 'truck 2' });
  // its own "wheel" does not replace the set's wheel
  expect(r.plan.submodels!.wheel).toEqual(set.submodels!.wheel);
  expect(r.plan.submodels!['truck 2'].steps[0].pieces[1]).toMatchObject({ submodel: 'wheel 2' });
  const ids = [...r.plan.steps, ...Object.values(r.plan.submodels!).flatMap((m) => m.steps)].flatMap((s) => s.pieces.map((i) => i.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test('importing into the main model adds the step at the top level', () => {
  const incoming: Plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'x', steps: [{ pieces: [brick(9)] }] });
  const r = importAsSubmodel(set, '', incoming, 'boat');
  expect(r.plan.steps).toHaveLength(3);
  expect(r.plan.steps[2].pieces[0]).toMatchObject({ submodel: 'boat' });
});
