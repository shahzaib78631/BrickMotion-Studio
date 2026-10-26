import { beforeAll, expect, test } from 'vitest';
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
