import { describe, expect, it } from 'vitest';
import { layoutFloor, type FloorItem } from '../../src/anim/floorLayout';

const pieces: FloorItem[] = Array.from({ length: 22 }, (_, i) => ({ id: `piece-${i}`, w: 2 + i % 3, d: 2 + i % 2, group: 0 }));
const region = { x0: -30, z0: 0, width: 60, depth: 40 };

describe('Camera frame staging', () => {
  it('centers each row and changes its shape with output aspect ratio', () => {
    const portrait = layoutFloor(pieces, region, 1, 'camera-frame', 9 / 16);
    const landscape = layoutFloor(pieces, region, 1, 'camera-frame', 16 / 9);
    expect(portrait.overflow).toEqual([]);
    expect(landscape.overflow).toEqual([]);
    const bounds = (points: typeof portrait.pos) => {
      const placed = pieces.map((p) => ({ ...p, ...points.get(p.id)! }));
      return { width: Math.max(...placed.map((p) => p.x + p.w)) - Math.min(...placed.map((p) => p.x)),
        depth: Math.max(...placed.map((p) => p.z + p.d)) - Math.min(...placed.map((p) => p.z)) };
    };
    expect(bounds(portrait.pos).width).toBeLessThan(bounds(landscape.pos).width);
    for (const result of [portrait, landscape]) for (const item of pieces) {
      const spot = result.pos.get(item.id)!;
      expect(spot.x).toBeGreaterThanOrEqual(region.x0);
      expect(spot.x + item.w).toBeLessThanOrEqual(region.x0 + region.width);
      expect(spot.z).toBeGreaterThanOrEqual(region.z0);
      expect(spot.z + item.d).toBeLessThanOrEqual(region.z0 + region.depth);
    }
  });

  it('keeps the composed layouts collision-free inside their staging bands', () => {
    for (const style of ['showcase', 'gallery', 'fan', 'camera-frame'] as const) {
      for (const aspect of [9 / 16, 4 / 5, 1, 16 / 9]) {
        const { pos } = layoutFloor(pieces, region, 1, style, aspect);
        const placed = pieces.filter((piece) => pos.has(piece.id));
        for (let i = 0; i < placed.length; i++) {
          const a = placed[i], pa = pos.get(a.id)!;
          expect(pa.x).toBeGreaterThanOrEqual(region.x0);
          expect(pa.x + a.w).toBeLessThanOrEqual(region.x0 + region.width);
          expect(pa.z).toBeGreaterThanOrEqual(region.z0);
          expect(pa.z + a.d).toBeLessThanOrEqual(region.z0 + region.depth);
          for (let j = i + 1; j < placed.length; j++) {
            const b = placed[j], pb = pos.get(b.id)!;
            const apart = pa.x + a.w <= pb.x || pb.x + b.w <= pa.x || pa.z + a.d <= pb.z || pb.z + b.d <= pa.z;
            expect(apart).toBe(true);
          }
        }
      }
    }
  });
});
