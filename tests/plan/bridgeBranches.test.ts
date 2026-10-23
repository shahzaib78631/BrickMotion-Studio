import { describe, expect, it } from 'vitest';
import { bridgeBranches } from '../../src/plan/components';

const graph = (edges: [string, string][]) => {
  const near = new Map<string, string[]>();
  for (const [a, b] of edges) {
    near.set(a, [...(near.get(a) ?? []), b]);
    near.set(b, [...(near.get(b) ?? []), a]);
  }
  return near;
};
const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => a[0].localeCompare(b[0]));

describe('bridge branches', () => {
  // a body ring (a-b-c-d) with an arm (x, y, z) hanging off c by one contact
  const body: [string, string][] = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'c']];
  const arm: [string, string][] = [['c', 'x'], ['x', 'y'], ['y', 'z'], ['x', 'z']];

  it('finds a group joined to the rest by one contact', () => {
    const near = graph([...body, ...arm]);
    expect(sorted(bridgeBranches([...near.keys()], near, 10))).toEqual([['x', 'y', 'z']]);
  });

  it('ignores groups held by two contacts, and ones too small or too big', () => {
    const twice = graph([...body, ...arm, ['d', 'y']]);
    expect(bridgeBranches([...twice.keys()], twice, 10)).toEqual([]);
    const near = graph([...body, ...arm]);
    expect(bridgeBranches([...near.keys()], near, 2)).toEqual([]);
    const pair = graph([...body, ['c', 'x'], ['x', 'y']]);
    expect(bridgeBranches([...pair.keys()], pair, 10)).toEqual([]);
  });

  it('builds aside the side away from the anchor, the biggest of nested branches', () => {
    // a chain hanging off the body: every link is a bridge
    const chain = graph([...body, ['c', 'p'], ['p', 'q'], ['q', 'r'], ['r', 's']]);
    expect(sorted(bridgeBranches([...chain.keys()], chain, 10, 'a'))).toEqual([['p', 'q', 'r', 's']]);
    // anchored at the chain's end instead, the body is the branch
    expect(sorted(bridgeBranches([...chain.keys()], chain, 10, 's'))).toEqual([['a', 'b', 'c', 'd', 'p', 'q', 'r']]);
  });

  it('only looks inside the pool it is given', () => {
    const near = graph([...body, ...arm]);
    expect(bridgeBranches(['a', 'b', 'c', 'd'], near, 10)).toEqual([]);
  });
});
