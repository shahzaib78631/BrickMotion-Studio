import * as THREE from 'three';
import { expect, test } from 'vitest';
import { FROM_ABOVE, fromShown, plannedWay, snapWay, toShown, wayForArrow, wayLabel, type Way } from '../../src/anim/flightDirection';
import { setItemsInsertionAxis } from '../../src/plan/ops';
import { ensureIds } from '../../src/plan/ids';
import type { Plan } from '../../src/plan/types';
import type { Timeline } from '../../src/anim/timeline';

const close = (a: Way, b: Way) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], 6));
const tl = (move: Record<string, unknown>) => ({ tracks: new Map([['a', { moves: [{ entry: [0, 0, 0], ...move }] }]]) }) as unknown as Timeline;

test('the planned way comes from the side entry, the last path stretch, or above', () => {
  expect(plannedWay(tl({}), 'a')).toEqual(FROM_ABOVE);
  close(plannedWay(tl({ entry: [0, 0, -40] }), 'a')!, [0, 0, -1]);
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  close(plannedWay(tl({ posePath: [at(0, -200, 0), at(40, 0, 0), at(0, 0, 0)] }), 'a')!, [1, 0, 0]);
  expect(plannedWay(tl({ stationary: true }), 'a')).toBeNull();
  expect(plannedWay(tl({}), 'missing')).toBeNull();
});

test('the editor shows Y up and stores LDraw −Y up', () => {
  close(toShown(FROM_ABOVE), [0, 1, 0]);
  close(fromShown([0, 2, 0])!, FROM_ABOVE);
  expect(fromShown([0, 0, 0])).toBeNull();
});

test('snapping and labels', () => {
  close(snapWay([0.05, -0.998, 0]), FROM_ABOVE);
  const tilted: Way = [Math.SQRT1_2, -Math.SQRT1_2, 0];
  expect(snapWay(tilted)).toBe(tilted);
  expect(wayLabel(FROM_ABOVE)).toBe('from above');
  expect(wayLabel([0, 0, -1])).toBe('from −Z');
  expect(wayLabel(tilted)).toBe('angled');
});

test('arrow keys pick the side of the view, Shift above/below, Alt tilts', () => {
  // azimuth 0: camera on +Z (LDraw −Z), so "behind the model" is LDraw +Z
  expect(wayForArrow('ArrowUp', {}, 0, FROM_ABOVE)).toEqual([0, 0, 1]);
  expect(wayForArrow('ArrowDown', {}, 0, FROM_ABOVE)).toEqual([0, 0, -1]);
  expect(wayForArrow('ArrowRight', {}, 0, FROM_ABOVE)).toEqual([1, 0, 0]);
  expect(wayForArrow('ArrowLeft', {}, 0, FROM_ABOVE)).toEqual([-1, 0, 0]);
  // camera turned 90°: right of the view is now LDraw +Z
  expect(wayForArrow('ArrowRight', {}, 90, FROM_ABOVE)).toEqual([0, 0, 1]);
  expect(wayForArrow('ArrowUp', { shift: true }, 0, [1, 0, 0])).toEqual(FROM_ABOVE);
  expect(wayForArrow('ArrowDown', { shift: true }, 0, [1, 0, 0])).toEqual([0, 1, 0]);
  const raised = wayForArrow('ArrowUp', { alt: true }, 0, [1, 0, 0]);
  expect(raised[1]).toBeCloseTo(-Math.sin(Math.PI / 12), 6);
  expect(raised[0]).toBeCloseTo(Math.cos(Math.PI / 12), 6);
  const lowered = wayForArrow('ArrowDown', { alt: true }, 0, [1, 0, 0]);
  expect(lowered[1]).toBeGreaterThan(0);
  const turned = wayForArrow('ArrowLeft', { alt: true }, 0, [1, 0, 0]);
  expect(turned[1]).toBeCloseTo(0, 6);
  expect(Math.hypot(...turned)).toBeCloseTo(1, 6);
  expect(turned[2]).not.toBeCloseTo(0, 3);
  // from straight above, Alt+↑/↓ still tilts
  const tipped = wayForArrow('ArrowDown', { alt: true }, 0, FROM_ABOVE);
  expect(tipped[1]).toBeGreaterThan(-1 + 1e-3);
});

test('setItemsInsertionAxis stores a unit way, clears it, and ignores no-op changes', () => {
  const plan: Plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 't',
    steps: [{ pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }] });
  const id = plan.steps[0].pieces[0].id!;
  const set = setItemsInsertionAxis(plan, '', [id], [0, 0, -3]);
  expect(set.steps[0].pieces[0].assembly?.insertionAxis).toEqual([0, 0, -1]);
  expect(setItemsInsertionAxis(set, '', [id], [0, 0, -1])).toBe(set);
  const cleared = setItemsInsertionAxis(set, '', [id], null);
  expect(cleared.steps[0].pieces[0].assembly).toBeUndefined();
  expect(setItemsInsertionAxis(plan, '', [id], [0, 0, 0])).toBe(plan);
});
