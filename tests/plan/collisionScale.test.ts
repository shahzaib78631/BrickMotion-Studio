import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { collisionWorld, type Solid } from '../../src/plan/collision';

/** A closed box mesh with its top and bottom faces cut into `n` x `n` squares (lots of triangles, like a baseplate). */
function slab(size: number, h: number, n: number): Float32Array {
  const out: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  const s = size / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x0 = i * s, x1 = x0 + s, z0 = j * s, z1 = z0 + s;
    quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]);
    quad([x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]);
  }
  quad([0, 0, 0], [0, h, 0], [size, h, 0], [size, 0, 0]);
  quad([0, 0, size], [size, 0, size], [size, h, size], [0, h, size]);
  quad([0, 0, 0], [0, 0, size], [0, h, size], [0, h, 0]);
  quad([size, 0, 0], [size, h, 0], [size, h, size], [size, 0, size]);
  return new Float32Array(out);
}
const at = (id: string, mesh: Float32Array, size: number, h: number, x: number, y: number, z: number): Solid => ({
  id, world: new THREE.Matrix4().makeTranslation(x, y, z).elements,
  body: { min: [0, 0, 0], max: [size, h, size] }, studs: [], snaps: [], mesh,
} as unknown as Solid);

describe('collision on many-triangle parts', () => {
  const big = slab(400, 24, 150); // ~90k triangles
  const small = slab(40, 24, 1);

  it('finds a small block pushed into the big slab, and not one beside it', () => {
    const world = collisionWorld([at('base', big, 400, 24, 0, 0, 0)]);
    expect([...world.hits([at('m', small, 40, 24, 100, 4, 100)])]).toEqual(['base']);
    expect(world.hits([at('m', small, 40, 24, 100, -24, 100)]).size).toBe(0);
  });

  it('tests a moving block at fresh clean spots quickly', () => {
    // an L-shaped part: its box is 400 x 400 but its mesh fills only x < 200, so a block at
    // x > 200 is inside the box (every point gets tested) yet touches nothing
    const half = slab(200, 24, 110);
    const solid = { ...at('base', half, 200, 24, 0, 0, 0), body: { min: [0, 0, 0], max: [400, 24, 400] } } as Solid;
    const world = collisionWorld([solid]);
    const mover = at('m', small, 40, 24, 213, 0, 17);
    world.hits([mover]); // first query may build indexes
    const t0 = performance.now();
    for (let i = 1; i <= 10; i++) expect(world.hits([mover], [i * 13.3, 0, i * 29.7]).size).toBe(0);
    expect((performance.now() - t0) / 10).toBeLessThan(15);
  });

  it('picks up a many-triangle part quickly', () => {
    const world = collisionWorld([at('other', small, 40, 24, 1000, 0, 1000)]);
    const fresh = slab(320, 24, 120); // ~58k triangles, never queried before
    const t0 = performance.now();
    expect(world.hits([at('m', fresh, 320, 24, 0, 0, 0)]).size).toBe(0);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
