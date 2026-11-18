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

test('support broad phase retains boundary contacts and order among thousands of distant items', () => {
 const near=[item('upper', 32, 40, 0),item('lower',45,53,1)];
 const expected=buildAssemblyGraph(near);
 expect(expected.dependencies).toContainEqual({parent:'lower',child:'upper',reason:'support'});
 const distant=Array.from({length:1100},(_,i)=>({
  ...item(`far-${i}`,32,40,2),box:{min:[1000+i*100,32,1000],max:[1020+i*100,40,1020]},
 } as AssemblyItem));
 const large=buildAssemblyGraph([...near,...distant]);
 expect(large.dependencies).toEqual(expected.dependencies);
 expect(large.ordered.filter(n=>!n.id.startsWith('far-')).map(n=>n.id)).toEqual(expected.ordered.map(n=>n.id));
});
