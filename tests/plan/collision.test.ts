import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addsOverlap, collisionWorld, type Solid } from '../../src/plan/collision';
import type { PartMetrics } from '../../src/ldraw/metrics';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';

/** A part upright with its top face at LDraw y = `top` (y down), shifted in x / z. */
const solid = (id: string, m: PartMetrics, x: number, top: number, z = 0): Solid => ({
  id, world: new THREE.Matrix4().makeTranslation(x, top - m.body.min[1], z).elements,
  body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh,
});

describe('collision world', () => {
  it.skipIf(!ready)('reports a brick pushed into another brick', async () => {
    const b = await measureReal('3001');
    const world = collisionWorld([solid('a', b, 0, -24)]);
    expect([...world.hits([solid('m', b, 10, -24)])]).toEqual(['a']);
  });

  it.skipIf(!ready)('does not report a brick stacked on studs', async () => {
    const b = await measureReal('3001');
    const world = collisionWorld([solid('a', b, 0, -24)]);
    expect(world.hits([solid('m', b, 0, -48)]).size).toBe(0);
  });

  it.skipIf(!ready)('does not report bricks side by side touching', async () => {
    const b = await measureReal('3001');
    const world = collisionWorld([solid('a', b, 0, -24)]);
    expect(world.hits([solid('m', b, 80, -24)]).size).toBe(0);
    expect(world.hits([solid('m', b, 0, -24, 40)]).size).toBe(0);
  });

  it.skipIf(!ready)('reports a plate raised into the brick above it', async () => {
    const b = await measureReal('3001'), p = await measureReal('3023');
    // brick spans y -32..-8, plate under it spans -8..0; shifting the plate up 8 puts it inside the brick
    const world = collisionWorld([solid('brick', b, 0, -32)]);
    const plate = solid('m', p, 0, -8);
    expect(world.hits([plate]).size).toBe(0);
    expect([...world.hits([plate], [0, -8, 0])]).toEqual(['brick']);
  });

  it.skipIf(!ready)('allows moving out of an existing overlap', async () => {
    const b = await measureReal('3001');
    const world = collisionWorld([solid('b', b, 0, -24), solid('c', b, 0, -24, 200)]);
    const a = [solid('a', b, 10, -24)];
    const before = world.hits(a);
    expect([...before]).toEqual(['b']);
    expect(addsOverlap(before, world.hits(a, [0, 0, 0]))).toBe(false);
    expect(addsOverlap(before, world.hits(a, [100, 0, 0]))).toBe(false);
    expect(addsOverlap(before, world.hits(a, [-10, 0, 200]))).toBe(true);
  });

  it.skipIf(!ready)("treats a submodel's child parts as one id", async () => {
    const b = await measureReal('3001');
    const world = collisionWorld([solid('s', b, 0, -24), solid('s', b, 0, -48)]);
    expect([...world.hits([solid('m', b, 10, -48), solid('m', b, 10, -24)])]).toEqual(['s']);
  });
});
