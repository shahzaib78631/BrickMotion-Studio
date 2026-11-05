import { beforeAll, describe, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import { buildTimeline } from '../../src/anim/timeline';
import { partClips } from '../../src/anim/partClips';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';
import { buildAssemblyGraph, type AssemblyItem } from '../../src/anim/assemblyGraph';
import { setRootHint } from '../../src/plan/ops';
import type { AssemblyHints, Plan } from '../../src/plan/types';
import type { Box } from '../../src/ldraw/flatten';

/** Two 2x4 bricks, one resting on the other (LDraw −Y is up). */
const box = (y: number): Box => ({ min: [0, y - 24, 0], max: [40, y, 20] });
const item = (id: string, y: number, order: number, assembly?: AssemblyHints): AssemblyItem => ({
  id, part: '3001', step: 0, order, box: box(y), contactBox: box(y), assembly,
});

const parentsOf = (above: AssemblyItem) => {
  const graph = buildAssemblyGraph([item('below', 0, 0), above], true);
  return graph.parents.get('above');
};

test('a brick resting on another has it as a parent', () => {
  expect(parentsOf(item('above', -24, 1))).toEqual(['below']);
});

test('assembly.root says "this is its own foundation", so the support parent goes away', () => {
  expect(parentsOf(item('above', -24, 1, { root: true }))).toEqual([]);
});

test('setRootHint marks and clears it, keeping the rest of the hints', () => {
  const plan: Plan = {
    format: 'brickmotion-plan', version: 1, name: 't',
    steps: [{ pieces: [{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0, assembly: { after: ['b'], group: 'wing' } }] }],
  };
  const marked = setRootHint(plan, '', ['a'], true);
  expect(marked.steps[0].pieces[0].assembly).toEqual({ after: ['b'], group: 'wing', root: true });
  const cleared = setRootHint(marked, '', ['a'], false);
  expect(cleared.steps[0].pieces[0].assembly).toEqual({ after: ['b'], group: 'wing' });
  // and a piece with nothing else loses the whole hint object again
  const bare: Plan = { format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }] };
  expect(setRootHint(setRootHint(bare, '', ['a'], true), '', ['a'], false).steps[0].pieces[0].assembly).toBeUndefined();
});

test('a cyclic pair still plans end to end instead of reporting a missing parent', async () => {
  const metrics = await fixtureMetrics();
  // two pieces each told to go on after the other: the planner breaks the loop, and neither is
  // left waiting for a parent the order puts after it (that used to fail as "missing parent")
  const plan: Plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'loop', steps: [{ pieces: [
    { id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0, assembly: { attachTo: 'b' } },
    { id: 'b', part: '3001', color: 4, x: 4, y: 0, z: 0, rot: 0, assembly: { attachTo: 'a' } },
  ] }] });
  const tl = buildTimeline(assemble(plan, metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: false });
  expect(tl.units.length).toBe(2);
  expect([...tl.tracks.keys()].sort()).toHaveLength(2);
}, 60_000);

describe('forcing the order on a whole build', () => {
  let metrics: Metrics;
  beforeAll(async () => { metrics = await fixtureMetrics(); });
  // the top brick is listed first, though it rests on the two below it
  const stacked = (): Plan => ensureIds({ format: 'brickmotion-plan', version: 1, name: 'stack', steps: [{ pieces: [
    { part: '3001', color: 1, x: 2, y: 3, z: 0, rot: 0 },
    { part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 },
    { part: '3001', color: 4, x: 4, y: 0, z: 0, rot: 0 },
  ] }] });
  const order = (p: Plan) => {
    const tl = buildTimeline(assemble(p, metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: false });
    return partClips(tl, p.steps).sort((a, b) => a.start - b.start).map((c) => c.id);
  };

  test('the planner pulls what a piece rests on ahead of it', () => {
    const p = stacked();
    const top = p.steps[0].pieces[0].id!;
    expect(order(p).indexOf(top)).toBeGreaterThan(0);
  });

  test('forced, every piece goes on exactly in the order it is listed', () => {
    const p = stacked();
    const ids = p.steps[0].pieces.map((i) => i.id!);
    expect(order(setRootHint(p, '', ids, true))).toEqual(ids);
  });
});

test('a dependency loop is broken instead of failing the whole build', () => {
  // the planner's own contact inference can produce this; a loop is unsatisfiable, so the
  // edge that closes it is dropped and everything still gets an order
  const items: AssemblyItem[] = [
    item('a', 0, 0, { attachTo: 'b' }),
    item('b', 0, 1, { attachTo: 'a' }),
    item('c', 0, 2),
  ];
  const graph = buildAssemblyGraph(items, false);
  expect(graph.ordered.map((item) => item.id).sort()).toEqual(['a', 'b', 'c']);
  expect(graph.cycles).toHaveLength(1);
  expect([...graph.cycles[0]].sort()).toEqual(['a', 'a', 'b']);
});

test('a three-way loop is broken the same way, and self references are ignored', () => {
  const items: AssemblyItem[] = [
    item('a', 0, 0, { after: ['c'] }),
    item('b', 0, 1, { attachTo: 'a' }),
    item('c', 0, 2, { attachTo: 'b' }),
    item('d', 0, 3, { attachTo: 'd' }),
  ];
  const graph = buildAssemblyGraph(items, false);
  expect(graph.ordered).toHaveLength(4);
  expect(graph.cycles.length).toBeGreaterThanOrEqual(1);
  expect(graph.dependencies.some((d) => d.parent === 'd' && d.child === 'd')).toBe(false);
  // the edge that closed the loop is gone from the parent map too, so no piece waits for a
  // parent the order puts after it (that is what "missing/unordered parent" used to report)
  for (const [child, list] of graph.parents) {
    for (const parent of list) {
      const at = (id: string) => graph.ordered.findIndex((x) => x.id === id);
      expect(at(parent), `${child} waits for ${parent}`).toBeLessThan(at(child));
    }
  }
});
