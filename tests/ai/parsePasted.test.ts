import { expect, test } from 'vitest';
import { parsePastedPlan } from '../../src/ai/parsePasted';

const aiJson = JSON.stringify({
  name: 'Tug',
  description: '',
  steps: [{ pieces: [{ part: '3001', color: 'Red', x: 0, y: 0, z: 0, rot: 0 }] }],
  submodels: [],
});

test('a fenced reply with prose before it', () => {
  const r = parsePastedPlan(`Sure! Here is your set:\n\n\`\`\`json\n${aiJson}\n\`\`\`\nEnjoy.`);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.plan.steps[0].pieces[0]).toMatchObject({ part: '3001' });
});

test('the AI array form without optional fields', () => {
  const r = parsePastedPlan(JSON.stringify({ name: 'X', steps: [{ pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }], submodels: [{ name: 'e', steps: [] }] }));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.plan.submodels).toHaveProperty('e');
});

test('a full brickmotion plan', () => {
  const r = parsePastedPlan(JSON.stringify({ format: 'brickmotion-plan', version: 1, name: 'P', steps: [] }));
  expect(r.ok).toBe(true);
});

test('plain text is rejected with an error', () => {
  const r = parsePastedPlan('hello');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBeTruthy();
});

test('JSON with the wrong shape is rejected', () => {
  const r = parsePastedPlan('{"name": "x", "steps": [{"pieces": [{"part": 3}]}]}');
  expect(r.ok).toBe(false);
});
