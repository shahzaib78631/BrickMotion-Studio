import { describe, expect, it } from 'vitest';
import { AssemblyPlanningError } from '../../src/anim/assemblyGraph';
import { searchAccessOrder, type AccessEdge } from '../../src/anim/accessOrder';

const blocked = (blockers: string[], harm?: Record<string, number>, completed = 5, needs?: string[]) =>
  new AssemblyPlanningError([{ code: 'blocked-route', items: ['m'], message: 'blocked', access: { moving: 'm', blockers, completed, total: 10, harm, needs } }]);

describe('access-order search look-ahead', () => {
  it('tries the reorder that cuts fewest certified flights first', () => {
    const tried: string[] = [];
    const result = searchAccessOrder((edges: AccessEdge[]) => {
      tried.push(edges.map((e) => `${e.before}>${e.after}`).join(','));
      if (!edges.length) throw blocked(['a', 'b'], { a: 3, b: 0 });
      return edges;
    }, 4);
    expect(tried).toEqual(['', 'm>b']);
    expect(result).toEqual([{ before: 'm', after: 'b' }]);
  });

  it('keeps the blocker order when nothing is known about harm', () => {
    const tried: string[] = [];
    searchAccessOrder((edges: AccessEdge[]) => {
      tried.push(edges.map((e) => `${e.before}>${e.after}`).join(','));
      if (!edges.length) throw blocked(['a', 'b']);
      return edges;
    }, 4);
    expect(tried).toEqual(['', 'm>a']);
  });

  it('never lets harm outrank getting further through the build', () => {
    const tried: string[] = [];
    searchAccessOrder((edges: AccessEdge[]) => {
      const sig = edges.map((e) => `${e.before}>${e.after}`).join(',');
      tried.push(sig);
      // the first reorder gets further but its next options all cut many flights
      if (!edges.length) throw blocked(['a', 'b'], { a: 0, b: 0 }, 5);
      if (sig === 'm>a') throw new AssemblyPlanningError([{ code: 'blocked-route', items: ['n'], message: 'blocked', access: { moving: 'n', blockers: ['c'], completed: 6, total: 10, harm: { c: 99 } } }]);
      return edges;
    }, 4);
    expect(tried.slice(0, 3)).toEqual(['', 'm>a', 'm>a,n>c']);
  });

  it('never puts a piece before what holds it', () => {
    const tried: string[] = [];
    searchAccessOrder((edges: AccessEdge[]) => {
      tried.push(edges.map((e) => `${e.before}>${e.after}`).join(','));
      if (!edges.length) throw blocked(['holder', 'b'], {}, 5, ['holder']);
      return edges;
    }, 4);
    expect(tried).toEqual(['', 'm>b']);
  });

  it('gives up at once when only holders block the piece, keeping the failure', () => {
    let calls = 0;
    expect(() => searchAccessOrder(() => { calls++; throw blocked(['holder'], {}, 5, ['holder']); }, 12)).toThrow(AssemblyPlanningError);
    expect(calls).toBe(1);
  });
});

describe('repair reorders', () => {
  it('reorders each blocked piece before blockers that do not hold it and cut no flights', async () => {
    const { repairEdges } = await import('../../src/anim/accessOrder');
    const edges = repairEdges([
      { moving: 'm', blockers: ['holder', 'a', 'b'], completed: 3, total: 9, needs: ['holder'], harm: { a: 0, b: 2 } },
      { moving: 'n', blockers: ['a', 'm'], completed: 5, total: 9 },
    ], [{ before: 'a', after: 'n' }]);
    // m>holder: held by it; m>b: would cut a flight; n>a: the reverse is required already
    expect(edges).toEqual([{ before: 'm', after: 'a' }, { before: 'n', after: 'm' }]);
  });
});
