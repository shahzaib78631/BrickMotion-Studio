import { expect, test } from 'vitest';
import { buildAssemblyGraph, type AssemblyItem } from '../../src/anim/assemblyGraph';

const item = (id: string, y0: number, y1: number, step: number, assembly?: AssemblyItem['assembly']): AssemblyItem =>
  ({ id, box: { min: [0, y0, 0], max: [20, y1, 20] }, step, order: 0, assembly } as AssemblyItem);

// L sits just under U, so the planner infers "L waits for U"; the author said U comes after L.
// One of the two has to give. Whichever edge is dropped, what remains must be satisfiable by `ordered`.
test('a broken loop leaves no parent ordered after its child', () => {
  const items = [item('L', 0, 8, 0), item('U', 8, 16, 1, { after: ['L'] })];
  const graph = buildAssemblyGraph(items);
  expect(graph.cycles.length).toBeGreaterThan(0);
  const at = new Map(graph.ordered.map((it, i) => [it.id, i]));
  for (const [child, list] of graph.parents) for (const parent of list) expect(at.get(parent)!).toBeLessThan(at.get(child)!);
});
