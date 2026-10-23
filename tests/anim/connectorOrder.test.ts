import { expect, test } from 'vitest';
import { assemblyRole, buildAssemblyGraph, type AssemblyItem } from '../../src/anim/assemblyGraph';
import { bottomSocketFace, studFitsFace, transformConnections } from '../../src/ldraw/connectors';

const bounds = { min: [-10, -10, -10] as [number, number, number], max: [10, 10, 10] as [number, number, number] };
test('an imported 4485 cap waits for the head even when authored first', () => {
  const items: AssemblyItem[] = [
    { id: 'cap', part: '4485', box: bounds, step: 0, order: 0 },
    { id: 'head', part: '3626bp04', box: bounds, step: 0, order: 1 },
  ];
  expect(assemblyRole('4485b.dat')).toBe('headwear');
  expect(buildAssemblyGraph(items).ordered.map((item) => item.id)).toEqual(['head', 'cap']);
});
test('a recessed stud deck precedes the rail receiving its studs', () => {
  const rail = { min: [-80, -24, -10] as [number, number, number], max: [80, 0, 10] as [number, number, number] };
  const items: AssemblyItem[] = [
    { id: 'rail', part: '2465', box: rail, step: 0, order: 0, socketFace: bottomSocketFace(rail, 'Brick 1 x 16') },
    { id: 'carrier', part: '6157', box: { min: [-20, -8, -30], max: [20, 8, 30] }, step: 2, order: 0,
      studs: [{ base: [0, 0, 0], tip: [0, -4, 0], radius: 6 }] },
  ];
  const graph = buildAssemblyGraph(items);
  expect(graph.ordered.map((item) => item.id)).toEqual(['carrier', 'rail']);
  expect(graph.dependencies).toContainEqual({ parent: 'carrier', child: 'rail', reason: 'stud' });
});
test('reflected socket metadata keeps its inward-facing orientation', () => {
  const g = transformConnections({
    studs: [{ base: [0, 0, 0], tip: [0, -4, 0], radius: 6 }],
    socketFace: { origin: [-20, 0, -20], u: [40, 0, 0], v: [0, 0, 40] },
  }, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 20, -40, 1]);
  expect(studFitsFace(g.studs![0], g.socketFace!)).toBe(true);
});
