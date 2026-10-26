import { beforeAll, describe, expect, test } from 'vitest';
import { assemble, type Assembly, type Metrics } from '../../src/model/assemble';
import { inlineSubmodelUse, movePartsToModel } from '../../src/plan/crossModel';
import { modelFrames } from '../../src/plan/modelFrames';
import type { Plan } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => { metrics = await fixtureMetrics(); });

const piece = (id: string, x = 0, extra: Record<string, unknown> = {}) => ({ id, part: '3001', color: 4, x, y: 0, z: 0, rot: 0 as const, ...extra });
const TILT = Math.SQRT1_2;

/** main → engine (grid use) → trailer (grid use) / twin (used twice) / tilted (45° raw) / spare (unused). */
const fixture = (): Plan => ({
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  submodels: {
    engine: { steps: [{ pieces: [piece('e1')] }] },
    trailer: { steps: [{ pieces: [piece('t1')] }] },
    twin: { steps: [{ pieces: [piece('tw1')] }] },
    tilted: { steps: [{ pieces: [piece('g1')] }] },
    spare: { steps: [{ pieces: [piece('s1')] }] },
  },
  steps: [
    { pieces: [piece('a', 0), piece('b', 40)] },
    { pieces: [{ id: 'u1', submodel: 'engine', x: 10, y: 0, z: 0, rot: 0 } as never] },
    { pieces: [
      { id: 'u2', submodel: 'trailer', x: 20, y: 0, z: 0, rot: 0 } as never,
      { id: 'w1', submodel: 'twin', x: 30, y: 0, z: 0, rot: 0 } as never,
      { id: 'w2', submodel: 'twin', x: 34, y: 0, z: 0, rot: 0 } as never,
      { id: 'u3', submodel: 'tilted', ldu: [60, 0, 0], matrix: [TILT, 0, TILT, 0, 1, 0, -TILT, 0, TILT] } as never,
    ] },
  ],
});

const build = (plan: Plan): Assembly => assemble(plan, metrics, fixtureColors);
const worldOf = (assembly: Assembly, itemId: string) => {
  const found = assembly.instances.find((i) => i.itemId === itemId);
  if (!found) throw new Error(`no instance for ${itemId}`);
  return found.world;
};
const samePose = (a: { elements: number[] }, b: { elements: number[] }) =>
  expect(a.elements.every((v, i) => Math.abs(v - b.elements[i]) < 1e-6)).toBe(true);

/** Every item id in the plan is its own: the build graph refuses two leaves with one id. */
const uniqueIds = (plan: Plan): boolean => {
  const ids = [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((s) => s.steps)]
    .flatMap((step) => step.pieces.map((piece) => piece.id))
    .filter((id): id is string => !!id);
  return new Set(ids).size === ids.length;
};

describe('model frames', () => {
  test('composes nested uses, counts repeats and ignores unused models', () => {
    const frames = modelFrames(build(fixture()));
    expect([...frames.keys()].sort()).toEqual(['', 'engine', 'tilted', 'trailer', 'twin']);
    expect(frames.get('spare')).toBeUndefined();
    expect(frames.get('twin')!.uses).toBe(2);
    expect(frames.get('engine')!.uses).toBe(1);
    // the main model is the reference frame
    expect(frames.get('')!.placement).toEqual({ pos: [0, 0, 0], m: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  });
});

describe('movePartsToModel', () => {
  test('keeps a part where it is in the main model when dropped into a submodel', () => {
    const plan = fixture();
    const before = worldOf(build(plan), 'a');
    const result = movePartsToModel(plan, build(plan), { from: '', to: 'engine', ids: ['a'], step: 0 });
    if ('error' in result) throw new Error(result.error);
    const moved = result.plan.steps.flatMap((s) => s.pieces).find((i) => i.id === 'a');
    expect(moved).toBeUndefined();
    expect(result.plan.submodels!.engine.steps[0].pieces.map((i) => i.id)).toEqual(['e1', 'a']);
    samePose(worldOf(build(result.plan), 'a'), before);
  });

  test('keeps a part where it is when extracted back to the main model', () => {
    const plan = fixture();
    const before = worldOf(build(plan), 'e1');
    const result = movePartsToModel(plan, build(plan), { from: 'engine', to: '', ids: ['e1'], step: 0 });
    if ('error' in result) throw new Error(result.error);
    expect(result.plan.submodels!.engine.steps).toHaveLength(0);
    samePose(worldOf(build(result.plan), 'e1'), before);
  });

  test('keeps a part where it is between sibling models', () => {
    const plan = fixture();
    const before = worldOf(build(plan), 'e1');
    const result = movePartsToModel(plan, build(plan), { from: 'engine', to: 'trailer', ids: ['e1'], step: 0 });
    if ('error' in result) throw new Error(result.error);
    expect(result.plan.submodels!.trailer.steps[0].pieces.map((i) => i.id)).toEqual(['t1', 'e1']);
    samePose(worldOf(build(result.plan), 'e1'), before);
  });

  test('stays on the grid for an axis-aligned target and falls back to raw for a tilted one', () => {
    const plan = fixture();
    const grid = movePartsToModel(plan, build(plan), { from: '', to: 'engine', ids: ['b'], step: 0 });
    if ('error' in grid) throw new Error(grid.error);
    expect('rot' in grid.plan.submodels!.engine.steps[0].pieces[1]).toBe(true);

    const tilted = movePartsToModel(plan, build(plan), { from: '', to: 'tilted', ids: ['b'], step: 0 });
    if ('error' in tilted) throw new Error(tilted.error);
    const moved = tilted.plan.submodels!.tilted.steps[0].pieces[1];
    expect('rot' in moved).toBe(false);
    samePose(worldOf(build(tilted.plan), 'b'), worldOf(build(plan), 'b'));
  });

  test('repairs sibling references that cannot cross a model boundary', () => {
    const plan = fixture();
    plan.steps[0].pieces[0] = piece('a', 0, {
      assembly: {
        attachTo: 'b', after: ['b'], insertionAxis: [0, 1, 0],
        buildSpot: { x: 1, z: 2, angle: 90 },
      },
    }) as never;
    // `b` moves too, so both references survive; the build spot does not.
    const both = movePartsToModel(plan, build(plan), { from: '', to: 'engine', ids: ['a', 'b'], step: 0 });
    if ('error' in both) throw new Error(both.error);
    const moved = both.plan.submodels!.engine.steps[0].pieces.find((i) => i.id === 'a')!;
    expect(moved.assembly?.attachTo).toBe('b');
    expect(moved.assembly?.after).toEqual(['b']);
    expect(moved.assembly?.buildSpot).toBeUndefined();
    expect(moved.assembly?.insertionAxis).toEqual([0, 1, 0]);

    // `b` stays behind here, so both references must go.
    const alone = movePartsToModel(plan, build(plan), { from: '', to: 'engine', ids: ['a'], step: 0 });
    if ('error' in alone) throw new Error(alone.error);
    const only = alone.plan.submodels!.engine.steps[0].pieces.find((i) => i.id === 'a')!;
    expect(only.assembly?.attachTo).toBeUndefined();
    expect(only.assembly?.after).toBeUndefined();
  });

  test('refuses when a part left behind depends on the selection', () => {
    const plan = fixture();
    plan.steps[0].pieces[1] = piece('b', 40, { assembly: { after: ['a'] } }) as never;
    const result = movePartsToModel(plan, build(plan), { from: '', to: 'engine', ids: ['a'], step: 0 });
    expect('error' in result && result.error).toMatch(/depend/);
  });

  test('refuses a model with no frame', () => {
    const plan = fixture();
    const result = movePartsToModel(plan, build(plan), { from: '', to: 'spare', ids: ['a'], step: 0 });
    expect('error' in result && result.error).toMatch(/no frame/);
  });

  test('drops a source step the move empties', () => {
    const plan = fixture();
    const result = movePartsToModel(plan, build(plan), { from: 'engine', to: '', ids: ['e1'], step: 0 });
    if ('error' in result) throw new Error(result.error);
    expect(result.plan.submodels!.engine.steps).toHaveLength(0);
  });
});

describe('inlineSubmodelUse', () => {
  test('replaces the use with its parts in place, keeping every pose', () => {
    const plan = fixture();
    const before = worldOf(build(plan), 'e1');
    const result = inlineSubmodelUse(plan, build(plan), '', 'u1');
    if ('error' in result) throw new Error(result.error);
    // the use is gone, its piece took its slot in step 2 — under its own id, because the
    // definition it came from keeps `e1` for itself
    const extracted = result.plan.steps[1].pieces;
    expect(extracted).toHaveLength(1);
    expect('submodel' in extracted[0]).toBe(false);
    expect(extracted[0].id).not.toBe('e1');
    expect(result.moved).toEqual([extracted[0].id]);
    samePose(worldOf(build(result.plan), extracted[0].id!), before);
    // nothing uses engine any more, so the definition goes too
    expect(result.plan.submodels!.engine).toBeUndefined();
    expect(uniqueIds(result.plan)).toBe(true);
  });

  test('keeps the definition when another use remains', () => {
    const plan = fixture();
    plan.steps[2].pieces.push({ id: 'u4', submodel: 'engine', x: 44, y: 0, z: 0, rot: 0 } as never);
    const result = inlineSubmodelUse(plan, build(plan), '', 'u1');
    if ('error' in result) throw new Error(result.error);
    expect(result.plan.submodels!.engine).toBeDefined();
  });

  test('an extracted copy never shares its id with the use that is still there', () => {
    // the reported case: `engine` is used twice, one use is extracted, and the remaining use
    // still brings `e1` in. Two visible leaves with one key is what "duplicate-id" refuses.
    const plan = fixture();
    plan.steps[2].pieces.push({ id: 'u4', submodel: 'engine', x: 44, y: 0, z: 0, rot: 0 } as never);
    const result = inlineSubmodelUse(plan, build(plan), '', 'u1');
    if ('error' in result) throw new Error(result.error);
    expect(uniqueIds(result.plan)).toBe(true);
    const keys = build(result.plan).instances.map((inst) => inst.key);
    expect(new Set(keys).size).toBe(keys.length);
    // and the pieces that stayed in the definition are untouched
    expect(result.plan.submodels!.engine.steps[0].pieces.map((i) => i.id)).toEqual(['e1']);
  });
});
