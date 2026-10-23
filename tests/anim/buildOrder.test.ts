import { expect, test } from 'vitest';
import { assemblyOrder, bottomUpOrder, type OrderItem } from '../../src/anim/buildOrder';
import type { Box } from '../../src/ldraw/flatten';

// LDraw: −Y is up, so a box's max[1] is its bottom.
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
const item = (id: string, b: Box): OrderItem => ({ id, box: b });
const ids = (items: OrderItem[]) => bottomUpOrder(items).map((i) => i.id);

test('a piece waits for the piece it rests on', () => {
  const top = item('top', box(0, -48, 0, 40, -24, 20));
  const bottom = item('bottom', box(0, -24, 0, 40, 0, 20));
  expect(ids([top, bottom])).toEqual(['bottom', 'top']);
});

test('pieces that do not touch keep the plan order', () => {
  const high = item('high', box(0, -48, 0, 40, -24, 20));
  const low = item('low', box(200, -24, 0, 240, 0, 20));
  expect(ids([high, low])).toEqual(['high', 'low']);
});

test('pieces side by side on the same level keep the plan order', () => {
  const a = item('a', box(40, -24, 0, 80, 0, 20));
  const b = item('b', box(0, -24, 0, 40, 0, 20));
  expect(ids([a, b])).toEqual(['a', 'b']);
});

test('of two touching pieces with the same bottom, the taller one goes first', () => {
  const arm = item('arm', box(-20, -33, 0, 0, -0, 20));
  const torso = item('torso', box(0, -44, 0, 40, 0, 20));
  expect(ids([arm, torso])).toEqual(['torso', 'arm']);
});

test('a minifig listed head first is built from the legs up', () => {
  // real boxes of the 10001 minifig, in its file order
  const fig = [
    item('head', box(249, -154, 153, 275, -130, 179)),
    item('hips', box(244, -107, 156, 280, -75, 176)),
    item('armR', box(232, -133, 143, 256, -96, 175)),
    item('armL', box(268, -135, 140, 291, -99, 175)),
    item('handR', box(233, -121, 130, 247, -101, 161)),
    item('handL', box(276, -125, 129, 290, -109, 159)),
    item('legR', box(243, -93, 155, 261, -56, 175)),
    item('legL', box(264, -93, 155, 282, -56, 175)),
    item('torso', box(243, -140, 156, 281, -96, 176)),
    item('hair', box(247, -161, 151, 277, -137, 182)),
    item('cape', box(247, -142, 156, 277, -98, 191)),
  ];
  const order = ids(fig);
  const before = (a: string, b: string) => expect(order.indexOf(a), `${a} before ${b}: ${order.join(' ')}`).toBeLessThan(order.indexOf(b));
  before('legR', 'hips');
  before('legL', 'hips');
  before('hips', 'torso');
  before('torso', 'armR');
  before('torso', 'armL');
  before('armR', 'handR');
  before('armL', 'handL');
  before('torso', 'head');
  before('head', 'hair');
  expect(order).toHaveLength(fig.length);
});

test('never drops or repeats a piece, even with circular overlaps', () => {
  const a = item('a', box(0, -10, 0, 10, 0, 10));
  const b = item('b', box(5, -11, 0, 15, -1.5, 10));
  const c = item('c', box(10, -12, 0, 20, -3, 10));
  const order = ids([c, b, a]);
  expect([...order].sort()).toEqual(['a', 'b', 'c']);
});

test('assemblyOrder keeps the preferred order where it can, and puts a locking piece first', () => {
  // a "pin" piece that can only go in while its two "clips" are not both there
  const hips = item('hips', box(0, -20, 0, 40, 0, 20));
  const legL = item('legL', box(-20, -20, 0, 2, 20, 20));
  const legR = item('legR', box(38, -20, 0, 60, 20, 20));
  const top = item('top', box(0, -40, 0, 40, -19, 20));
  const canLeave = (it: OrderItem, others: OrderItem[]) => it.id !== 'hips' || others.filter((o) => o.id.startsWith('leg')).length < 2;
  const order = assemblyOrder([legL, legR, hips, top], canLeave).map((i) => i.id);
  // both legs can't be on before the hips: the hips go on while at most one leg is
  expect(order.indexOf('hips')).toBeLessThan(Math.max(order.indexOf('legL'), order.indexOf('legR')));
  expect(order[order.length - 1]).toBe('top');
  // with nothing locking, the preferred order stands
  expect(assemblyOrder([legL, legR, hips, top], () => true).map((i) => i.id)).toEqual(['legL', 'legR', 'hips', 'top']);
});
