import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addsOverlap, collisionWorld, type Solid } from '../../src/plan/collision';
import { partConnectors } from '../../src/plan/connectors';
import { studsOf } from '../../src/plan/sockets';
import type { PartMetrics } from '../../src/ldraw/metrics';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';

/** An LDraw reference line's transform: `1 colour x y z a b c d e f g h i part.dat`. */
const ldrawAt = (x: number, y: number, z: number, m: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]) =>
  new THREE.Matrix4().set(m[0], m[1], m[2], x, m[3], m[4], m[5], y, m[6], m[7], m[8], z, 0, 0, 0, 1).elements;

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

  it.skipIf(!ready)('reports the stud of one brick that reaches into the other’s wall', async () => {
    const b = await measureReal('3001');
    // the lower brick's studs, half a stud under the upper one, end up in its wall
    const world = collisionWorld([solid('a', b, 0, -24)]);
    expect([...world.hits([solid('m', b, 10, -48)])]).toEqual(['a']);
  });

  it.skipIf(!ready)('reports a moving stud pushed into the piece above it', async () => {
    const b = await measureReal('3001');
    const world = collisionWorld([solid('a', b, 0, -48)]);
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
    // brick spans y -32..-8, plate under it spans -8..0; shifting the plate up 8 puts it inside the brick.
    // The plate's studs are on the brick's socket grid (z = 10), so at rest it only touches
    const world = collisionWorld([solid('brick', b, 0, -32)]);
    const plate = solid('m', p, 0, -8, 10);
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

  it.skipIf(!ready)('lets a pin slide into a Technic hole, and stops it beside the hole', async () => {
    const brick = await measureReal('3700'), pin = await measureReal('4274');
    // brick top at −24, so its 8 LDU side hole is centred at y = −14 and opens toward −z
    const world = collisionWorld([solid('brick', brick, 0, -24)]);
    const turn = new THREE.Matrix4().makeRotationY(Math.PI / 2); // the pin's shaft (local +X) turns to −z
    const mid = new THREE.Vector3(-8, 0, 0).applyMatrix4(turn).toArray(); // the shaft's midpoint in its own frame
    const at = (y: number, z: number): Solid => ({
      id: 'pin', world: new THREE.Matrix4().makeTranslation(-mid[0], y - mid[1], z - mid[2]).multiply(turn).elements,
      body: pin.body, studs: pin.studs, snaps: pin.snaps, mesh: pin.mesh,
    });
    // pushing it in through the mouth: the shaft passes down the hole, so nothing is in the way
    for (const z of [-20, -10, 0, 10, 20]) expect([...world.hits([at(-14, z)])]).toEqual([]);
    // 2 LDU off the hole's line, the shaft is in the wall beside it
    expect([...world.hits([at(-12, 0)])]).toEqual(['brick']);
  });

  it.skipIf(!ready)("treats a submodel's child parts as one id", async () => {
    const b = await measureReal('3001');
    const world = collisionWorld([solid('s', b, 0, -24), solid('s', b, 0, -48)]);
    expect([...world.hits([solid('m', b, 10, -48), solid('m', b, 10, -24)])]).toEqual(['s']);
  });
});

describe('side (SNOT) studs', () => {
  it.skipIf(!ready)('count as studs, so a seated side-stud join is not an overlap', async () => {
    const brick = await measureReal('22885'), plate = await measureReal('2420');
    // the measured studs and the shadow library's are one list, so a part whose side studs
    // are drawn some other way still has them: 22885's four are already measured, no doubles
    const own = studsOf(brick);
    expect(new Set(own.map((s) => s.base.join(','))).size).toBe(own.length);
    expect(own.filter((s) => Math.abs(s.tip[2] - s.base[2]) > 1)).toHaveLength(4);
    // and the snapper seats on the same four
    expect(partConnectors(brick).filter((c) => c.gender === 'M' && Math.abs(c.axis[2]) > 0.9)).toHaveLength(4);

    // the corner plate mounted on those side studs, from the user's file: its sockets take the
    // studs, so its body reaching 4 LDU into the brick's box is a seat, not an overlap
    const world = collisionWorld([{ id: 'brick', world: ldrawAt(140, -160, -228), body: brick.body, studs: brick.studs, snaps: brick.snaps, mesh: brick.mesh }]);
    const plateAt = (dz: number): Solid => ({
      id: 'plate', world: ldrawAt(130, -130, -246 + dz, [0, 0, -1, -1, 0, 0, 0, 1, 0]),
      body: plate.body, studs: plate.studs, snaps: plate.snaps, mesh: plate.mesh,
    });
    expect([...world.hits([plateAt(0)])]).toEqual([]);
    // pushed 4 LDU into the brick — past its sockets, off the studs — it is a real overlap
    expect([...world.hits([plateAt(4)])]).toEqual(['brick']);
  });
  it.skipIf(!ready)('accepts plates stacked in the open corner of an L bracket', async () => {
    // 44728's underside anti-studs are square ("S") in the shadow library, and its body is
    // not a whole-stud footprint, so it once had no sockets and every plate read as a poke
    const br = await measureReal('44728'), p = await measureReal('3710');
    const at = (id: string, m: PartMetrics, x: number, y: number): Solid => ({ id, world: ldrawAt(x, y, 10), body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh });
    const bracket = at('br', br, 0, -40);
    const plates = [-32, -24, -16, -8].map((y, k) => at(`p${k}`, p, 20, y));
    for (const plate of plates) {
      const world = collisionWorld([bracket, ...plates.filter((q) => q !== plate)]);
      expect([...world.hits([plate])]).toEqual([]);
    }
    expect([...collisionWorld(plates).hits([bracket])]).toEqual([]);
    // the bracket's top plate is still solid: a plate pushed up into it is an overlap
    expect([...collisionWorld([bracket]).hits([at('up', p, 20, -36)])]).toEqual(['br']);
  });
  it.skipIf(!ready)('accepts hinge halves joined round their shared axis', async () => {
    // knuckles interlock round the axis: each fills the other's bounds there
    const at = (id: string, m: PartMetrics, x = 0, z = 0, turn = false): Solid => ({
      id, world: ldrawAt(x, 0, z, turn ? [-1, 0, 0, 0, 1, 0, 0, 0, -1] : undefined), body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh,
    });
    for (const [b, t, x, z, turn] of [['3937', '3938', 0, 0, false], ['3830', '3831', 0, 0, false], ['4275', '4276', 60, 20, true]] as const) {
      const mb = await measureReal(b), mt = await measureReal(t);
      expect([...collisionWorld([at('base', mb)]).hits([at('top', mt, x, z, turn)])], `${t} on ${b}`).toEqual([]);
      expect([...collisionWorld([at('top', mt, x, z, turn)]).hits([at('base', mb)])], `${b} under ${t}`).toEqual([]);
    }
    // the hinge is no free pass: the top shifted along the base still collides
    const mb = await measureReal('3830'), mt = await measureReal('3831');
    expect([...collisionWorld([at('base', mb)]).hits([at('top', mt, 10, 0)])]).toEqual(['base']);
  });
});
