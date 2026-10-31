import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { findPose, freeTargets, type Pose, type PoseQuery } from '../../src/plan/placementEngine';
import { partConnectors, worldConnectors, type Connector } from '../../src/plan/connectors';
import { collisionWorld, type Solid } from '../../src/plan/collision';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Vec3 } from '../../src/ldraw/parse';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';

type Placed = { solid: Solid; connectors: Connector[] };
/** A part upright with its top face at LDraw y = `top`, its centre at x / z. */
const place = (id: string, m: PartMetrics, x: number, top: number, z = 0, yawDeg = 0): Placed => {
  const world = new THREE.Matrix4().makeTranslation(x, top - m.body.min[1], z).multiply(new THREE.Matrix4().makeRotationY((yawDeg * Math.PI) / 180)).elements;
  return { solid: { id, world, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh }, connectors: worldConnectors(partConnectors(m), world) };
};
const query = (moving: Placed, fixed: Placed[], hit: PoseQuery['hit'], handle: number, extra: Partial<PoseQuery> = {}): PoseQuery => {
  const solids = fixed.map((f) => f.solid);
  return {
    moving: { solids: [moving.solid], connectors: moving.connectors },
    targets: freeTargets(fixed.map((f) => ({ list: f.connectors, owner: f.solid.id })), solids),
    hit, handle, yaw: 0, world: collisionWorld(solids), before: new Set(), prev: null, ...extra,
  };
};
/** index of the moving connector of a gender nearest a world point */
const handleNear = (p: Placed, gender: 'M' | 'F', at: Vec3) => {
  let best = -1, d = Infinity;
  p.connectors.forEach((c, i) => {
    if (c.gender !== gender) return;
    const e = Math.hypot(c.pos[0] - at[0], c.pos[1] - at[1], c.pos[2] - at[2]);
    if (e < d) { d = e; best = i; }
  });
  return best;
};
const moved = (p: Placed, pose: Pose) => new THREE.Vector3(0, 0, 0).applyMatrix4(new THREE.Matrix4().fromArray(pose.delta).multiply(new THREE.Matrix4().fromArray(p.solid.world as number[])));

describe('placement pose search', () => {
  it.skipIf(!ready)('seats a 2x4 brick on all 8 studs of a 2x4 plate', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const brick = place('m', await measureReal('3001'), 200, -100, 160);
    const h = handleNear(brick, 'F', [200 - 30, -100 + 24, 160 - 10]);
    const pose = findPose(query(brick, [plate], { point: [-29, 0, -9], owner: 'plate' }, h));
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(8);
    expect(pose.owners).toEqual(['plate']);
    const c = moved(brick, pose);
    expect([c.x, c.y, c.z].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, -24, 0]);
  });

  it.skipIf(!ready)('uses the stud nearest the hit point', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const pose = findPose(query(one, [plate], { point: [12, 0, 8], owner: 'plate' }, handleNear(one, 'F', [300, -52, 0])));
    const c = moved(one, pose);
    expect([c.x, c.z]).toEqual([10, 10]);
  });

  it.skipIf(!ready)('climbs onto a taller part', async () => {
    const tall = place('tall', await measureReal('3001'), 0, -24);
    const one = place('m', await measureReal('3024'), 300, -8, 0);
    const pose = findPose(query(one, [tall], { point: [10, -24, 10], owner: 'tall' }, handleNear(one, 'F', [300, 0, 0])));
    expect(pose.valid).toBe(true);
    expect(Math.round(moved(one, pose).y)).toBe(-24 - 8);
  });

  it.skipIf(!ready)("seats a 1x1 round plate on a jumper's centre stud", async () => {
    const jumper = place('j', await measureReal('3794b'), 0, 0);
    const round = place('m', await measureReal('4073'), 300, -40, 0);
    const pose = findPose(query(round, [jumper], { point: [2, 0, 1], owner: 'j' }, handleNear(round, 'F', [300, -32, 0])));
    const c = moved(round, pose);
    expect([Math.round(c.x), Math.round(c.z)]).toEqual([0, 0]);
    expect(pose.mated).toBe(1);
  });

  it.skipIf(!ready)('hangs a part under another when the handle is a top stud', async () => {
    const above = place('above', await measureReal('3001'), 0, -48);
    const one = place('m', await measureReal('3024'), 300, 0, 0);
    // pointing at the brick's underside
    const pose = findPose(query(one, [above], { point: [10, -24, 10], owner: 'above' }, handleNear(one, 'M', [300, -8, 0])));
    expect(pose.valid).toBe(true);
    const c = moved(one, pose);
    // the plate's top face (its origin, where its studs start) meets the brick's bottom at y = -24
    expect([Math.round(c.x), Math.round(c.y), Math.round(c.z)]).toEqual([10, -24, 10]);
  });

  it.skipIf(!ready)('skips a colliding pose and takes the next best', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const blocker = place('blk', await measureReal('3024'), 10, -8, 10);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const h = handleNear(one, 'F', [300, -52, 0]);
    const fixed = [plate, blocker];
    const pose = findPose(query(one, fixed, { point: [10, 0, 10], owner: 'plate' }, h));
    expect(pose.valid).toBe(true);
    const c = moved(one, pose);
    expect(Math.hypot(c.x - 10, c.z - 10)).toBeGreaterThan(5);
  });

  it.skipIf(!ready)('is invalid when every stud near the hit is taken', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const m1 = await measureReal('3024');
    const blockers = [-30, -10, 10, 30].flatMap((x) => [-10, 10].map((z) => place(`b${x},${z}`, m1, x, -8, z)));
    const one = place('m', m1, 300, -60, 0);
    const pose = findPose(query(one, [plate, ...blockers], { point: [10, 0, 10], owner: 'plate' }, handleNear(one, 'F', [300, -52, 0])));
    expect(pose.valid).toBe(false);
  });

  it.skipIf(!ready)('keeps the previous pose within the hysteresis distance', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const h = handleNear(one, 'F', [300, -52, 0]);
    const atA = findPose(query(one, [plate], { point: [10, 0, 10], owner: 'plate' }, h));
    // 6 LDU toward stud B (x = 30): B is now nearer, but not by more than the hysteresis
    const still = findPose(query(one, [plate], { point: [21, 0, 10], owner: 'plate' }, h, { prev: atA }));
    expect(moved(one, still).x).toBe(10);
    const switched = findPose(query(one, [plate], { point: [28, 0, 10], owner: 'plate' }, h, { prev: atA }));
    expect(moved(one, switched).x).toBe(30);
  });

  it.skipIf(!ready)('falls back to the floor grid when nothing is hit', async () => {
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const pose = findPose(query(one, [], { point: [33, 0, 47], owner: null }, handleNear(one, 'F', [300, -52, 0])));
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(0);
    const c = moved(one, pose);
    // a 1x1 plate centre sits mid-cell: 10 + 20k
    expect([((c.x - 10) % 20 + 20) % 20, Math.round(c.y), ((c.z - 10) % 20 + 20) % 20]).toEqual([0, -8, 0]);
    expect(Math.abs(c.x - 33)).toBeLessThanOrEqual(10);
    expect(Math.abs(c.z - 47)).toBeLessThanOrEqual(10);
  });

  it.skipIf(!ready)('rotates in hand', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const two = place('m', await measureReal('3023'), 300, -60, 0);
    const h = handleNear(two, 'F', [290, -52, 0]);
    const flat = findPose(query(two, [plate], { point: [-10, 0, -10], owner: 'plate' }, h));
    const turned = findPose(query(two, [plate], { point: [-10, 0, -10], owner: 'plate' }, h, { yaw: 90 }));
    expect(flat.mated).toBe(2);
    expect(turned.valid).toBe(true);
    expect(turned.mated).toBe(2);
    const m = new THREE.Matrix4().fromArray(turned.delta).elements;
    // a quarter turn about the vertical: x maps onto z
    expect(Math.abs(m[2])).toBeCloseTo(1, 5);
  });

  it.skipIf(!ready)('never sinks a part below the floor', async () => {
    const plate = place('plate', await measureReal('3020'), 0, -8);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    // hanging a 1x1 plate under a plate that lies on the floor would put it underground
    const pose = findPose(query(one, [plate], { point: [10, 0, 10], owner: 'plate' }, handleNear(one, 'M', [300, -60, 0])));
    expect(pose.valid).toBe(false);
  });

  it.skipIf(!ready)('stands on the floor it is given, not LDraw y = 0', async () => {
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const pose = findPose(query(one, [], { point: [30, 24, 50], owner: null }, handleNear(one, 'F', [300, -52, 0]), { floor: 24 }));
    expect(pose.valid).toBe(true);
    expect(Math.round(moved(one, pose).y)).toBe(16);
  });

  it('an empty moving set never gives a usable pose', () => {
    const pose = findPose({ moving: { solids: [], connectors: [] }, targets: [], hit: { point: [5, 0, 5], owner: null }, handle: 0, yaw: 0, world: null, before: new Set(), prev: null });
    expect(pose.valid).toBe(false);
    expect(pose.delta.every(Number.isFinite)).toBe(true);
  });

  it.skipIf(!ready)('pointing at a piece with no studs nearby stays by the mouse', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const h = handleNear(one, 'F', [300, -52, 0]);
    const far = findPose(query(one, [plate], { point: [200, 0, 0], owner: 'plate' }, h));
    expect(Math.abs(moved(one, far).x - 200)).toBeLessThanOrEqual(10);
    // even right after a seated pose: far from it, the part follows the mouse instead of jumping back
    const atA = findPose(query(one, [plate], { point: [10, 0, 10], owner: 'plate' }, h));
    const after = findPose(query(one, [plate], { point: [200, 0, 0], owner: 'plate' }, h, { prev: atA }));
    expect(Math.abs(moved(one, after).x - 200)).toBeLessThanOrEqual(10);
  });

  it.skipIf(!ready)('holds still on the seam between two pieces', async () => {
    const m = await measureReal('3020');
    const a = place('a', m, 0, 0), b = place('b', m, 80, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const h = handleNear(one, 'F', [300, -52, 0]);
    const onA = findPose(query(one, [a, b], { point: [38, 0, 10], owner: 'a' }, h));
    expect(moved(one, onA).x).toBe(30);
    const onB = findPose(query(one, [a, b], { point: [42, 0, 10], owner: 'b' }, h, { prev: onA }));
    expect(moved(one, onB).x).toBe(30);
  });

  it.skipIf(!ready)('seats a 1x2x1 2/3 brick with side studs (22885) on a 2x4 plate', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const tall = place('m', await measureReal('22885'), 300, -100, 0);
    const h = handleNear(tall, 'F', [300 - 10, -100 + 40, 0]);
    expect(h).toBeGreaterThanOrEqual(0);
    const pose = findPose(query(tall, [plate], { point: [-11, 0, -9], owner: 'plate' }, h));
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(2);
    expect(Math.round(moved(tall, pose).y)).toBe(-40);
  });

  describe('two 22885s each on one top stud of a third', () => {
    // the base stands upright: its top studs are at x = ±10, y = 0
    const centreX = (p: Placed, pose: Pose) => Math.round(moved(p, pose).x);

    it.skipIf(!ready)('puts the held socket on the stud under the mouse, even when that overhangs', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, -40);
      const held = place('m', m, 300, -200, 0);
      const right = handleNear(held, 'F', [310, -160, 0]); // held by its right-hand socket
      const pose = findPose(query(held, [base], { point: [-10, -40, 0], owner: 'base' }, right));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(1);
      expect(centreX(held, pose)).toBe(-20); // hangs off the left side
    });

    it.skipIf(!ready)('tries another socket when the held one would clash', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, -40);
      const left = place('left', m, -20, -80); // the first one, hanging off the left side
      const held = place('m', m, 300, -200, 0);
      const right = handleNear(held, 'F', [310, -160, 0]); // on the free right stud this would push into `left`
      const pose = findPose(query(held, [base, left], { point: [10, -40, 0], owner: 'base' }, right));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(1);
      expect(centreX(held, pose)).toBe(20); // hangs off the right side
    });
  });

  describe('sideways onto side studs', () => {
    const boxX = (p: Placed, pose: Pose) => {
      const w = new THREE.Matrix4().fromArray(pose.delta).multiply(new THREE.Matrix4().fromArray(p.solid.world as number[]));
      const b = new THREE.Box3(new THREE.Vector3(...p.solid.body.min), new THREE.Vector3(...p.solid.body.max)).applyMatrix4(w);
      return [Math.round(b.min.x), Math.round(b.max.x)];
    };

    it.skipIf(!ready)('mounts a 22885 flat on the side studs of another', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, 0); // upright: side studs at x = ±10, y = 10 and 30, pointing -Z
      const held = place('m', m, 300, -200, 0);
      const right = handleNear(held, 'F', [310, -160, 0]);
      const pose = findPose(query(held, [base], { point: [10, 30, -10], owner: 'base' }, right, { floor: 1000 }));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(2);
      expect(boxX(held, pose)).toEqual([-20, 20]);
    });

    it.skipIf(!ready)('never leaves a side stud cutting into the wall of a brick held half a stud off', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, 0);
      const held = place('m', m, 300, -200, 0);
      const middle = handleNear(held, 'F', [300, -160, 0]);
      // the middle socket on the lower-right stud would put the end wall over the lower-left stud
      const pose = findPose(query(held, [base], { point: [10, 30, -10], owner: 'base' }, middle, { floor: 1000 }));
      expect(boxX(held, pose)).not.toEqual([-10, 30]);
    });
  });
});
