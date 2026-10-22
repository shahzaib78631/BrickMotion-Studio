import { expect, test } from 'vitest';
import { choosePacing } from '../../src/anim/pacing';

test('small model → piece mode', () => {
  const p = choosePacing(40, 10, { targetSeconds: 15, heroOrbit: true });
  expect(p.mode).toBe('piece');
  expect(p.slot).toBeCloseTo(0.22, 2);
});
test('medium model → step mode', () => expect(choosePacing(120, 12, { targetSeconds: 15, heroOrbit: true }).mode).toBe('step'));
test('huge model → batch mode', () => {
  const p = choosePacing(600, 60, { targetSeconds: 15, heroOrbit: true });
  expect(p.mode).toBe('batch');
  expect(p.batchSize).toBe(43);
});
test('forced mode wins', () => expect(choosePacing(600, 60, { targetSeconds: 15, heroOrbit: true, mode: 'step' }).mode).toBe('step'));
test('outro depends on hero orbit', () => {
  expect(choosePacing(10, 1, { targetSeconds: 15, heroOrbit: true }).outro).toBe(3);
  expect(choosePacing(10, 1, { targetSeconds: 15, heroOrbit: false }).outro).toBe(0.5);
});
