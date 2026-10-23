import { expect, test } from 'vitest';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { assemble, type Metrics } from '../../src/model/assemble';
import type { AssemblyHints, PieceItem, Plan, Raw } from '../../src/plan/types';

// Synthetic non-interpenetrating anatomy tests scheduling, not real connector geometry.
// No LDraw downloads are required for these cases.
const identity: Raw['matrix'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const metrics: Metrics = (id) => ({
  id,
  body: { min: [-5, -10, -5], max: [5, 0, 5] },
  full: { min: [-5, -10, -5], max: [5, 0, 5] },
  footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false,
});
const piece = (id: string, part: string, x: number, assembly?: AssemblyHints): PieceItem => ({
  id, part, color: 4, ldu: [x, 0, 0], matrix: [...identity], assembly,
});
const plan = (steps: PieceItem[][]): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 'Assembly constraints',
  steps: steps.map((pieces) => ({ pieces })),
});
const options = { targetSeconds: 5, heroOrbit: false, mode: 'batch' as const };

for (const bottomUp of [true, false]) {
  test(`a hand waits for a settled arm across steps (bottomUp=${bottomUp})`, () => {
    const asm = assemble(plan([
      [piece('hand', '3820', 20)], [piece('arm', '3818', 10)], [piece('torso', '973', 0)],
    ]), metrics, new Map());
    const tl = buildTimeline(asm, metrics, { ...options, bottomUp });
    const unit = (key: string) => tl.units[tl.tracks.get(key)!.moves[0].unit];
    for (const [parent, child] of [['torso', 'arm'], ['arm', 'hand']]) {
      expect(unit(child).start).toBeGreaterThanOrEqual(unit(parent).start + unit(parent).dur + 0.02999);
    }
    expect(tl.units.some((u) => u.hidden)).toBe(false);
    for (const inst of asm.instances) {
      expect(poseAt(tl, tl.duration)(inst.key)!.elements).toEqual(inst.world.elements);
    }
  });
}

test('an explicit custom-part dependency survives batch timing', () => {
  const asm = assemble(plan([[piece('child', 'custom', 20, { attachTo: 'parent' })], [piece('parent', 'base', 0)]]), metrics, new Map());
  const tl = buildTimeline(asm, metrics, options);
  const [parent, child] = tl.units;
  expect(parent.keys).toContain('parent');
  expect(child.start).toBeGreaterThanOrEqual(parent.start + parent.dur + 0.02999);
});

test('an unresolved overlapping placement still plans: a visible, least-blocked flight marked uncertified', () => {
  const asm = assemble(plan([[piece('parent', 'base', 0)], [piece('child', 'custom', 0, { attachTo: 'parent' })]]), metrics, new Map());
  const tl = buildTimeline(asm, metrics, options);
  expect(tl.units.some((u) => u.hidden)).toBe(false);
  const child = asm.instances.find((i) => i.itemId === 'child')!;
  const unit = tl.units[tl.tracks.get(child.key)!.moves[0].unit];
  expect(unit.uncertified).toBe(true);
  // a placement that does certify is never marked
  const parent = asm.instances.find((i) => i.itemId === 'parent')!;
  expect(tl.units[tl.tracks.get(parent.key)!.moves[0].unit].uncertified).toBeFalsy();
});

test('singular transforms are rejected rather than taking an unintended flight', () => {
  const p = piece('singular', 'base', 0);
  if (!('matrix' in p)) throw new Error('Expected raw placement');
  p.matrix = [1, 0, 0, 0, 0, 0, 0, 0, 1];
  const asm = assemble(plan([[p]]), metrics, new Map());
  expect(() => buildTimeline(asm, metrics, options)).toThrow('invalid-transform');
});

test('missing model geometry fails early and names only the required parts', () => {
  const missing: Metrics = (id) => ({ ...metrics(id), placeholder: true });
  const asm = assemble(plan([[piece('missing-part', 'custom-123', 0)]]), missing, new Map());
  expect(() => buildTimeline(asm, missing, options)).toThrow('missing-geometry');
  expect(() => buildTimeline(asm, missing, options)).toThrow('custom-123');
});

test('planning reports real unit progress before camera preparation', () => {
  const asm = assemble(plan([[piece('base', 'base', 0)], [piece('next', 'custom', 20)]]), metrics, new Map());
  const updates: { phase: string; completed: number; total: number }[] = [];
  const tl = buildTimeline(asm, metrics, options, (p) => updates.push(p));
  expect(updates[0].phase).toBe('preparing');
  expect(updates.some((p) => p.phase === 'routing' && p.completed === tl.units.length && p.total === tl.units.length)).toBe(true);
  expect(updates.at(-1)!.phase).toBe('camera');
});

test('rounded/sheared hand placement retains its exact shape during the entire flight', () => {
  const p = piece('hand', '3820', 0, { root: true });
  if (!('matrix' in p)) throw new Error('Expected raw placement');
  p.matrix = [1, 0.12, -0.12, -0.17, 0.697, -0.697, 0, 0.707, 0.707];
  const asm = assemble(plan([[p]]), metrics, new Map());
  const tl = buildTimeline(asm, metrics, options);
  const target = asm.instances[0].world;
  const gram = (elements: number[]) => [0, 4, 8].flatMap((a) => [0, 4, 8].map((b) =>
    elements[a] * elements[b] + elements[a + 1] * elements[b + 1] + elements[a + 2] * elements[b + 2]));
  const expected = gram(target.elements);
  const u = tl.units[0];
  for (let i = 0; i <= 100; i++) {
    const m = poseAt(tl, u.start + u.dur * i / 100)('hand')!;
    gram(m.elements).forEach((v, k) => expect(v).toBeCloseTo(expected[k], 8));
  }
  expect(poseAt(tl, tl.duration)('hand')!.elements).toEqual(target.elements);
  const almost = poseAt(tl, u.start + u.dur * (1 - 1e-6))('hand')!;
  almost.elements.forEach((v, k) => expect(v).toBeCloseTo(target.elements[k], 6));
});
