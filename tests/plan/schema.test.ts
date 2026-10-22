import { expect, test } from 'vitest';
import { ensureIds } from '../../src/plan/ids';
import { parsePlan } from '../../src/plan/schema';

const base = { format: 'brickmotion-plan', version: 1, name: 'T' };

test('accepts an empty plan and empty steps', () => {
  expect(parsePlan({ ...base, steps: [] }).ok).toBe(true);
  expect(parsePlan({ ...base, steps: [{ pieces: [] }] }).ok).toBe(true);
});

test('accepts grid, raw and submodel items, strips unknown keys', () => {
  const r = parsePlan({
    ...base,
    extra: 1,
    submodels: { engine: { steps: [{ pieces: [{ part: '3062b', color: 'Dark Bluish Grey', x: 0, y: 0, z: 0, rot: 0 }] }] } },
    steps: [{ pieces: [
      { part: '3001', color: '71', x: 0, y: 0, z: 0, rot: 90, junk: true },
      { part: '3001', color: 4, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      { submodel: 'engine', x: 4, y: 3, z: 0, rot: 0 },
    ] }],
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect((r.plan as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect((r.plan.steps[0].pieces[0] as unknown as Record<string, unknown>).junk).toBeUndefined();
  }
});

test('rejects bad plans', () => {
  expect(parsePlan({ version: 1, name: 'x', steps: [] }).ok).toBe(false);
  expect(parsePlan({ ...base, steps: [{ pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 45 }] }] }).ok).toBe(false);
  expect(parsePlan({ ...base, steps: [{ pieces: [{ part: '3001', submodel: 'e', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }] }).ok).toBe(false);
});

test('ensureIds gives unique ids across steps and submodels', () => {
  const r = parsePlan({
    ...base,
    submodels: { e: { steps: [{ pieces: [{ part: '1', color: 0, x: 0, y: 0, z: 0, rot: 0 }] }] } },
    steps: [{ pieces: [{ part: '1', color: 0, x: 0, y: 0, z: 0, rot: 0 }, { id: 'keep', part: '1', color: 0, x: 0, y: 0, z: 0, rot: 0 }] }, { pieces: [{ submodel: 'e', x: 0, y: 0, z: 0, rot: 0 }] }],
  });
  if (!r.ok) throw new Error(r.errors.join());
  const p = ensureIds(r.plan);
  const ids = [...p.steps.flatMap((s) => s.pieces), ...p.submodels!.e.steps.flatMap((s) => s.pieces)].map((i) => i.id);
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain('keep');
  expect(r.plan.steps[0].pieces[0].id).toBeUndefined(); // input not mutated
});
