import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { validate } from '../../src/model/validate';
import { ensureIds } from '../../src/plan/ids';
import type { PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const brick = (x: number, y: number, z = 0, part = '3001'): PlanItem => ({ part, color: 4, x, y, z, rot: 0 });
const run = (items: PlanItem[], extra?: Record<string, PlanItem[]>) =>
  validate(
    assemble(
      ensureIds({
        format: 'brickmotion-plan',
        version: 1,
        name: 't',
        steps: [{ pieces: items }],
        submodels: extra && Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { steps: [{ pieces: v }] }])),
      }),
      metrics,
      fixtureColors,
    ),
  );

test('two bricks in the same spot overlap', () => {
  const w = run([brick(0, 0), brick(0, 0)]);
  expect(w).toHaveLength(1);
  expect(w[0].kind).toBe('overlap');
  expect(w[0].itemIds).toHaveLength(2);
});

test('a plate resting on a brick is fine', () => {
  expect(run([brick(0, 0), brick(0, 3, 0, '3020')])).toEqual([]);
});

test('a plate in mid-air floats', () => {
  const w = run([brick(10, 0), brick(0, 10, 0, '3020')]);
  expect(w.map((x) => x.kind)).toEqual(['floating']);
});

test('a brick attached to the side of a tower does not float', () => {
  expect(run([brick(0, 0), brick(0, 3), brick(0, 6), brick(4, 6)])).toEqual([]);
});

test('unknown parts are reported', () => {
  expect(run([brick(0, 0, 0, 'zzz')]).map((x) => x.kind)).toEqual(['unknown-part']);
});

test('assembly problems become warnings', () => {
  expect(run([{ submodel: 'ghost', x: 0, y: 0, z: 0, rot: 0 }]).map((x) => x.kind)).toEqual(['missing-submodel']);
});

test('3,000 bricks validate quickly', () => {
  const items: PlanItem[] = [];
  for (let y = 0; y < 10; y++) for (let i = 0; i < 15; i++) for (let j = 0; j < 20; j++) items.push(brick(i * 4, y * 3, j * 2));
  const asm = assemble(ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: items }] }), metrics, fixtureColors);
  const t = performance.now();
  const w = validate(asm);
  const ms = performance.now() - t;
  expect(w).toEqual([]);
  expect(ms).toBeLessThan(300);
});

const raw = (x: number): PlanItem => ({ part: '3001', color: 4, ldu: [x + 40, -24, 20], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });

test('imported (raw) pieces are trusted: no overlap between two raw pieces', () => {
  expect(run([raw(0), raw(0)])).toEqual([]);
});

test('a grid piece overlapping an imported piece is still reported', () => {
  expect(run([raw(0), brick(0, 0)]).map((x) => x.kind)).toEqual(['overlap']);
});

const sub = (name: string, x: number, y: number): PlanItem => ({ submodel: name, x, y, z: 0, rot: 0 });

test('separate submodels each rest on their own lowest point', () => {
  // A minifig beside a truck whose wheels sit one plate higher: neither floats.
  const w = run([sub('truck', 0, 1), sub('fig', 10, 0)], {
    truck: [brick(0, 0), brick(0, 3)],
    fig: [brick(0, 0), brick(0, 3)],
  });
  expect(w).toEqual([]);
});

test('a piece hovering inside a submodel still floats', () => {
  const w = run([sub('truck', 0, 1), sub('fig', 10, 0)], {
    truck: [brick(0, 0), brick(0, 3), brick(0, 12)],
    fig: [brick(0, 0)],
  });
  expect(w.map((x) => [x.kind, x.model])).toEqual([['floating', 'truck']]);
});

test('a piece joined only by a real stud (its box meeting a neighbour along a thin strip) is not floating; without the joint it is', () => {
  // a plate beside a brick's top edge: the boxes share just a 1 LDU strip, like 10156's sideways headlights
  const brickAt: PlanItem = { id: 'b', part: '3001', color: 4, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const bb = assemble(ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [brickAt] }] }), metrics, fixtureColors).bounds!;
  const pb = metrics('3020').body;
  const plateLdu: [number, number, number] = [bb.max[0] - pb.min[0], bb.min[1] + 1 - pb.max[1], (bb.min[2] + bb.max[2]) / 2 - (pb.min[2] + pb.max[2]) / 2];
  const plate: PlanItem = { id: 'p', part: '3020', color: 1, ldu: plateLdu, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const asm = assemble(ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [brickAt, plate] }] }), metrics, fixtureColors);
  const joint = [bb.max[0], bb.min[1] + 0.5, (bb.min[2] + bb.max[2]) / 2];
  const snap = (gender: 'M' | 'F', origin: number[]) => ({ kind: 'cyl' as const, gender, start: joint.map((v, k) => v - origin[k]) as [number, number, number], axis: [1, 0, 0] as [number, number, number], length: 4, radius: 6, shapes: ['R'], slide: false });
  const snaps = (part: string) => (part === '3001' ? [snap('M', [0, 0, 0])] : [snap('F', plateLdu)]);
  expect(validate(asm).some((w) => w.kind === 'floating')).toBe(true);
  expect(validate(asm, (p) => p, snaps).filter((w) => w.kind === 'floating')).toEqual([]);
  // snaps that do not meet join nothing: a plate in mid-air still floats
  const far: PlanItem = { ...plate, id: 'f', ldu: [plateLdu[0] + 200, plateLdu[1] - 100, plateLdu[2]] };
  const asm2 = assemble(ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [brickAt, far] }] }), metrics, fixtureColors);
  expect(validate(asm2, (p) => p, snaps).filter((w) => w.kind === 'floating').map((w) => w.itemIds[0])).toEqual(['f']);
});
