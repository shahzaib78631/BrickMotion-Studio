import { describe, expect, it } from 'vitest';
import { layoutFloor, type FloorItem } from '../../src/anim/floorLayout';

const pieces: FloorItem[] = Array.from({ length: 9 }, (_, i) => ({ id: `piece-${i}`, w: 2, d: 2, group: i < 4 ? 0 : 1 }));
const region = { x0: -20, z0: 0, width: 40, depth: 60 };

describe('product-shot staging', () => {
  for (const style of ['showcase', 'gallery', 'fan'] as const) {
    it(`${style} keeps all pieces in bounds, centred and non-overlapping`, () => {
      const a = layoutFloor(pieces, region, 1, style);
      expect(a.overflow).toEqual([]);
      expect(layoutFloor(pieces, region, 1, style).pos).toEqual(a.pos);
      const rows = new Map<number, number[]>();
      for (const part of pieces) {
        const p = a.pos.get(part.id)!;
        expect(p.x).toBeGreaterThanOrEqual(region.x0);
        expect(p.x + part.w).toBeLessThanOrEqual(region.x0 + region.width);
        expect(p.z).toBeGreaterThanOrEqual(region.z0);
        expect(p.z + part.d).toBeLessThanOrEqual(region.z0 + region.depth);
        const group = rows.get(Math.floor(p.z / 5)) ?? [];
        group.push(p.x + part.w / 2);
        rows.set(Math.floor(p.z / 5), group);
      }
      for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
        const aPos = a.pos.get(pieces[i].id)!;
        const bPos = a.pos.get(pieces[j].id)!;
        expect(aPos.x + 2 <= bPos.x || bPos.x + 2 <= aPos.x || aPos.z + 2 <= bPos.z || bPos.z + 2 <= aPos.z).toBe(true);
      }
    });
  }
});
