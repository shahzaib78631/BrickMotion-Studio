import { expect, test } from 'vitest';
import { layoutFloor, type FloorItem } from '../../src/anim/floorLayout';

const region = { x0: 0, z0: 0, width: 30, depth: 10 };
const items = (n: number): FloorItem[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, w: 2, d: 4, group: i < n / 2 ? 1 : 0 }));

test('no overlaps, gap ≥ 1, inside the region', () => {
  const { pos, overflow } = layoutFloor(items(20), region);
  const its = items(20).filter((i) => pos.has(i.id));
  expect(its.length + overflow.length).toBe(20);
  expect(its.length).toBeGreaterThan(0);
  for (const a of its) {
    const pa = pos.get(a.id)!;
    expect(pa.x).toBeGreaterThanOrEqual(0);
    expect(pa.z).toBeGreaterThanOrEqual(0);
    expect(pa.x + a.w).toBeLessThanOrEqual(30);
    expect(pa.z + a.d).toBeLessThanOrEqual(10);
    for (const b of its) {
      if (a === b) continue;
      const pb = pos.get(b.id)!;
      const apart = pa.x + a.w + 1 <= pb.x || pb.x + b.w + 1 <= pa.x || pa.z + a.d + 1 <= pb.z || pb.z + b.d + 1 <= pa.z;
      expect(apart).toBe(true);
    }
  }
});

test('group 0 comes before group 1 in row-major order', () => {
  const { pos } = layoutFloor(items(10), region);
  const key = (id: string) => {
    const p = pos.get(id)!;
    return p.z * 1000 + p.x;
  };
  const g0 = items(10).filter((i) => i.group === 0).map((i) => key(i.id));
  const g1 = items(10).filter((i) => i.group === 1).map((i) => key(i.id));
  expect(Math.max(...g0)).toBeLessThan(Math.min(...g1));
});

test('too many items overflow', () => {
  expect(layoutFloor(items(200), region).overflow.length).toBeGreaterThan(0);
});

test('larger footprints first within a group', () => {
  const { pos } = layoutFloor(
    [
      { id: 'small', w: 1, d: 1, group: 0 },
      { id: 'big', w: 4, d: 4, group: 0 },
    ],
    region,
  );
  expect(pos.get('big')!.x).toBeLessThan(pos.get('small')!.x);
});
