import { expect, test } from 'vitest';
import { flexibleKind } from '../../src/data/flexibleParts';

test('flexible parts are classified by their LDraw type', () => {
  expect(flexibleKind('50231')).toBe('cloth');
  expect(flexibleKind('u767')).toBe('cloth');
  expect(flexibleKind('48298')).toBe('cloth');
  expect(flexibleKind('27328')).toBe('hose');
  expect(flexibleKind('22678')).toBe('hose');
  expect(flexibleKind('22296')).toBe('hose');
  expect(flexibleKind('56823')).toBe('string');
  expect(flexibleKind('14225')).toBe('string');
  expect(flexibleKind('85543')).toBe('rubber');
  expect(flexibleKind('55709')).toBe('rubber');
});

test('part paths and .dat suffixes are accepted', () => {
  expect(flexibleKind('parts/50231.dat')).toBe('cloth');
  expect(flexibleKind('s/27328.DAT')).toBe('hose');
});

test('rigid look-alikes are not reported as flexible', () => {
  for (const part of [
    '2584', '2585', '30584a', '30585a',
    '41752', '41753', '14149', '24375',
    '18927', '6642', '6643', '6015', '42610',
  ]) expect(flexibleKind(part), part).toBeNull();
});
