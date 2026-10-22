import { expect, test } from 'vitest';
import { aiPlanToPlan, AiPlanSchema } from '../../src/ai/schema';

const ai = {
  name: 'Mini jet',
  description: 'A tiny jet',
  steps: [
    { pieces: [{ part: '3020', color: 'Blue', x: 0, y: 0, z: 0, rot: 0 }] },
    { pieces: [{ submodel: 'engine', x: 0, y: 1, z: 0, rot: 90 }] },
  ],
  submodels: [{ name: 'engine', steps: [{ pieces: [{ part: '3062b', color: 'Trans Orange', x: 0, y: 0, z: 0, rot: 0 }] }] }],
};

test('the AI form parses and converts to a Plan', () => {
  const parsed = AiPlanSchema.safeParse(ai);
  expect(parsed.success).toBe(true);
  const plan = aiPlanToPlan(parsed.data!);
  expect(plan.format).toBe('brickmotion-plan');
  expect(plan.version).toBe(1);
  expect(Object.keys(plan.submodels!)).toEqual(['engine']);
  expect(plan.submodels!.engine.steps[0].pieces[0]).toMatchObject({ part: '3062b' });
  expect(plan.steps.map((s) => s.pieces.length)).toEqual([1, 1]);
  expect(plan.steps[1].pieces[0]).toMatchObject({ submodel: 'engine', rot: 90 });
  expect(plan.steps[0].pieces[0].id).toBeTruthy();
});

test('raw (ldu/matrix) items are not allowed in the AI form', () => {
  const bad = { ...ai, steps: [{ pieces: [{ part: '3001', color: 4, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] }] };
  expect(AiPlanSchema.safeParse(bad).success).toBe(false);
});
