import { expect, test } from 'vitest';
import { planToJson, readPlanFile } from '../../src/io/planFile';
import { emptyPlan } from '../../src/plan/types';

test('reads plan json', () => {
  const r = readPlanFile(planToJson(emptyPlan('x')), 'x.json');
  expect(r.ok).toBe(true);
});

test('reads mpd', () => {
  const r = readPlanFile('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n', 'set.mpd');
  expect(r.ok && r.plan.steps[0].pieces.length).toBe(1);
});

test('rejects unsupported files and bad json', () => {
  expect(readPlanFile('hello', 'notes.txt').ok).toBe(false);
  expect(readPlanFile('{oops', 'x.json').ok).toBe(false);
});
