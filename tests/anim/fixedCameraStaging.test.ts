import { describe, expect, it } from 'vitest';
import { createFrameStagingSpace } from '../../src/anim/cameraFrameLayout';
import type { FloorItem } from '../../src/anim/floorLayout';
import type { FrameStagingCamera } from '../../src/anim/pacing';
import type { Box } from '../../src/ldraw/flatten';

const model: Box = { min: [-80, -40, -100], max: [80, 0, 100] };
const pieces: FloorItem[] = Array.from({ length: 42 }, (_, i) => ({
  id: `piece${i}`, w: i % 9 === 0 ? 3 : 1, d: i % 7 === 0 ? 2 : 1, h: i % 11 === 0 ? 2 : 0.7, group: 0,
}));
const camera: FrameStagingCamera = { position: [0, 22, 26], target: [0, 0, 0], fov: 42, aspect: 9 / 16 };

describe('fixed camera staging is NOT fit-camera-to-pieces', () => {
  it('stages actual 3D footprints within a portrait shot, around the central build', () => {
    const before = JSON.stringify(camera);
    const space = createFrameStagingSpace(camera, 0, model, 'around');
    const result = space.place(pieces);
    expect(result.overflow).toEqual([]);
    expect(result.pos.size).toBe(pieces.length);
    expect(JSON.stringify(camera)).toBe(before); // lens and camera never change
    for (const item of pieces) {
      const p = result.pos.get(item.id)!;
      expect(space.fits(p.x, p.z, item.w, item.d, item.h!)).toBe(true);
      for (const other of pieces) {
        if (other.id === item.id) continue;
        const q = result.pos.get(other.id)!;
        expect(p.x + item.w + 0.75 <= q.x || q.x + other.w + 0.75 <= p.x ||
          p.z + item.d + 0.75 <= q.z || q.z + other.d + 0.75 <= p.z).toBe(true);
      }
    }
  });

  it('uses successive windows when a tight shot cannot hold everything', () => {
    const tight = { ...camera, position: [0, 9, 15] as [number, number, number], fov: 30 };
    const space = createFrameStagingSpace(tight, 0, model, 'around');
    const result = space.place(pieces);
    expect(result.overflow.length).toBeGreaterThan(0);
    expect(result.pos.size).toBeGreaterThan(0);
    expect(tight.position).toEqual([0, 9, 15]);
    for (const it of pieces) {
      const p = result.pos.get(it.id);
      if (p) expect(space.fits(p.x, p.z, it.w, it.d, it.h!)).toBe(true);
    }
  });

  it('responds to the camera direction and crop, while staying deterministic', () => {
    const space = createFrameStagingSpace(camera, 0, model, 'around');
    expect([...space.place(pieces).pos]).toEqual([...space.place(pieces).pos]);
    const cropped = createFrameStagingSpace({ ...camera, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }, 0, model, 'around');
    expect(cropped.place(pieces).pos.size).toBeLessThan(space.place(pieces).pos.size);
  });
});
