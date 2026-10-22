import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseLDConfig, resolveColor } from '../../src/ldraw/colors';

const t = parseLDConfig(readFileSync('tests/fixtures/ldraw/LDConfig.ldr', 'utf8'));

test('resolves names with spelling variations', () => {
  expect(resolveColor(t, 'Light Bluish Grey')).toBe(71);
  expect(resolveColor(t, 'light_bluish_gray')).toBe(71);
});

test('resolves numeric codes and numeric strings', () => {
  expect(resolveColor(t, 72)).toBe(72);
  expect(resolveColor(t, '71')).toBe(71);
});

test('unknown colors resolve to undefined', () => {
  expect(resolveColor(t, 'nope')).toBeUndefined();
  expect(resolveColor(t, 9999)).toBeUndefined();
});

test('reads alpha and finishes', () => {
  expect(t.get(47)!.alpha).toBe(128);
  expect(t.get(47)!.finish).toBe('trans');
  expect(t.get(383)!.finish).toBe('chrome');
  expect(t.get(71)).toMatchObject({ name: 'Light_Bluish_Gray', hex: '#A0A5A9', alpha: 255, finish: 'solid' });
});
