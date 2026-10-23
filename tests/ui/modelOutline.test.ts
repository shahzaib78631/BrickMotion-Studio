import { expect, test } from 'vitest';
import { modelOutline } from '../../src/ui/ModelsPanel';
import type { Plan, PlanItem } from '../../src/plan/types';

const b: PlanItem = { part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 };
const sub = (name: string): PlanItem => ({ submodel: name, x: 0, y: 0, z: 0, rot: 0 });

test('outline lists main, then submodels in build order with nesting, totals and use counts', () => {
  const plan: Plan = {
    format: 'brickmotion-plan', version: 1, name: 't',
    steps: [{ pieces: [b, sub('train')] }, { pieces: [sub('train')] }],
    submodels: {
      spare: { steps: [{ pieces: [b] }] },
      train: { steps: [{ pieces: [b, b, sub('fig')] }] },
      fig: { steps: [{ pieces: [b, b, b] }] },
    },
  };
  const rows = modelOutline(plan);
  expect(rows.map((r) => [r.name, r.depth, r.total, r.uses, r.used])).toEqual([
    ['', 0, 11, 0, true],
    ['train', 1, 5, 2, true],
    ['fig', 2, 3, 1, true],
    ['spare', 1, 1, 0, false],
  ]);
});
