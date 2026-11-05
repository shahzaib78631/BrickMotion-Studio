import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { findPose, freeTargets, type Pose, type PoseQuery } from '../../src/plan/placementEngine';
import { partConnectors, worldConnectors, type Connector } from '../../src/plan/connectors';
import { collisionWorld, type Solid } from '../../src/plan/collision';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Vec3 } from '../../src/ldraw/parse';
import type { Aim } from '../../src/plan/aim';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';

type Placed = { solid: Solid; connectors: Connector[] };
/** A part upright with its top face at LDraw y = `top`, its centre at x / z. */
const place = (id: string, m: PartMetrics, x: number, top: number, z = 0, yawDeg = 0): Placed => {
  const world = new THREE.Matrix4().makeTranslation(x, top - m.body.min[1], z).multiply(new THREE.Matrix4().makeRotationY((yawDeg * Math.PI) / 180)).elements;
  return { solid: { id, world, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh }, connectors: worldConnectors(partConnectors(m), world) };
};
/** The bottom-face centre of a placed part: where a new part is held (box centre x / z, box bottom). */
const underside = (p: Placed): Vec3 => {
  const b = new THREE.Box3(new THREE.Vector3(...p.solid.body.min), new THREE.Vector3(...p.solid.body.max)).applyMatrix4(new THREE.Matrix4().fromArray(p.solid.world as number[]));
  const c = b.getCenter(new THREE.Vector3());
  return [c.x, b.max.y, c.z];
};
/** The mouse ray from `from` (default 400 LDU straight above) through `p`, hitting at `p`. */
const aimAt = (p: Vec3, from: Vec3 = [p[0], p[1] - 400, p[2]], floorY = 0): Aim => {
  const d = new THREE.Vector3(p[0] - from[0], p[1] - from[1], p[2] - from[2]);
  const depth = d.length();
  d.normalize();
  const t = Math.abs(d.y) > 1e-9 ? (floorY - from[1]) / d.y : -1;
  const floorPoint: Vec3 | null = t > 0 ? [from[0] + d.x * t, floorY, from[2] + d.z * t] : null;
  return { ray: { origin: from, dir: [d.x, d.y, d.z] }, hitDepth: depth, floorPoint, hitPoint: p };
};
const query = (moving: Placed, fixed: Placed[], aim: Aim, extra: Partial<PoseQuery> = {}): PoseQuery => {
  const solids = fixed.map((f) => f.solid);
  return {
    moving: { solids: [moving.solid], connectors: moving.connectors },
    targets: freeTargets(fixed.map((f) => ({ list: f.connectors, owner: f.solid.id })), solids),
    aim, ref: underside(moving), lock: null, yaw: 0, world: collisionWorld(solids), before: new Set(), prev: null, ...extra,
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

const centre = (p: Placed, pose: Pose) => {
  const c = moved(p, pose);
  return [c.x, c.y, c.z].map((v) => Math.round(v * 1000) / 1000);
};
const boxX = (p: Placed, pose: Pose) => {
  const w = new THREE.Matrix4().fromArray(pose.delta).multiply(new THREE.Matrix4().fromArray(p.solid.world as number[]));
  const b = new THREE.Box3(new THREE.Vector3(...p.solid.body.min), new THREE.Vector3(...p.solid.body.max)).applyMatrix4(w);
  return [Math.round(b.min.x), Math.round(b.max.x)];
};
/** looking along +z at a point from 400 LDU in front of it */
const fromFront = (p: Vec3): Vec3 => [p[0], p[1], p[2] - 400];
/** looking up at a point from 400 LDU below it */
const fromBelow = (p: Vec3): Vec3 => [p[0], p[1] + 400, p[2]];

describe('placement pose search', () => {
  it.skipIf(!ready)('seats a 2x4 brick on all 8 studs of a 2x4 plate', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const brick = place('m', await measureReal('3001'), 200, -100, 160);
    const pose = findPose(query(brick, [plate], aimAt([0, 0, 0])));
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(8);
    expect(pose.owners).toEqual(['plate']);
    expect(pose.links).toHaveLength(8);
    expect(centre(brick, pose)).toEqual([0, -24, 0]);
  });

  it.skipIf(!ready)("slides a 1x2 brick along a 1x2 plate's row as the mouse moves", async () => {
    const plate = place('plate', await measureReal('3023'), 0, 0);
    const brick = place('m', await measureReal('3004'), 300, -100, 0);
    const on = findPose(query(brick, [plate], aimAt([0, 0, 0])));
    expect(centre(brick, on)[0]).toBe(0);
    expect(on.mated).toBe(2);
    const half = findPose(query(brick, [plate], aimAt([-10, 0, 0])));
    expect(Math.abs(centre(brick, half)[0] + 10)).toBeLessThanOrEqual(10);
    expect(half.mated).toBeGreaterThanOrEqual(1);
    const off = findPose(query(brick, [plate], aimAt([-22, 0, 0])));
    expect(off.valid).toBe(true);
    expect(centre(brick, off)[0]).toBe(-20);
    expect(off.mated).toBe(1);
  });

  it.skipIf(!ready)('uses the stud nearest the mouse', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const c = centre(one, findPose(query(one, [plate], aimAt([12, 0, 8]))));
    expect([c[0], c[2]]).toEqual([10, 10]);
  });

  it.skipIf(!ready)('climbs onto a taller part', async () => {
    const tall = place('tall', await measureReal('3001'), 0, -24);
    const one = place('m', await measureReal('3024'), 300, -8, 0);
    const pose = findPose(query(one, [tall], aimAt([10, -24, 10])));
    expect(pose.valid).toBe(true);
    expect(Math.round(moved(one, pose).y)).toBe(-24 - 8);
  });

  it.skipIf(!ready)("seats a 1x1 round plate on a jumper's centre stud", async () => {
    const jumper = place('j', await measureReal('3794b'), 0, 0);
    const round = place('m', await measureReal('4073'), 300, -40, 0);
    const pose = findPose(query(round, [jumper], aimAt([2, 0, 1])));
    const c = centre(round, pose);
    expect([Math.round(c[0]), Math.round(c[2])]).toEqual([0, 0]);
    expect(pose.mated).toBe(1);
  });

  it.skipIf(!ready)('hangs a part under another by its studs, looking up', async () => {
    const above = place('above', await measureReal('3001'), 0, -48);
    const one = place('m', await measureReal('3024'), 300, 0, 0);
    const pose = findPose(query(one, [above], aimAt([10, -24, 10], fromBelow([10, -24, 10]))));
    expect(pose.valid).toBe(true);
    // the plate's top face (its origin, where its studs start) meets the brick's bottom at y = -24
    expect(centre(one, pose).map(Math.round)).toEqual([10, -24, 10]);
  });

  it.skipIf(!ready)('hangs a plate under a plate by its studs', async () => {
    const above = place('above', await measureReal('3020'), 0, -48);
    const two = place('m', await measureReal('3023'), 300, 0, 0);
    const pose = findPose(query(two, [above], aimAt([0, -40, 10], fromBelow([0, -40, 10]))));
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(2);
  });

  it.skipIf(!ready)('skips a colliding pose and takes the next best', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const blocker = { ...place('blk', await measureReal('3024'), 10, -8, 10), connectors: [] };
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const pose = findPose(query(one, [plate, blocker], aimAt([10, 0, 10])));
    expect(pose.valid).toBe(true);
    const c = centre(one, pose);
    expect(Math.hypot(c[0] - 10, c[2] - 10)).toBeGreaterThan(5);
  });

  it.skipIf(!ready)('shows the best pose invalid when every pose near the mouse collides', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    // a brick hovering 4 LDU over the plate (its own studs left out): nothing fits under it
    const lid = { ...place('lid', await measureReal('3001'), 0, -28), connectors: [] };
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const pose = findPose(query(one, [plate, lid], aimAt([10, 0, 10])));
    expect(pose.valid).toBe(false);
    expect(pose.links).toEqual([]);
    // and it says what stopped it, so the sidebar can explain the red ghost
    expect(pose.why).toBe('it would sit inside another piece');
    expect(pose.with).toContain('lid');
  });

  it.skipIf(!ready)('keeps the previous pose within the hysteresis distance', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const atA = findPose(query(one, [plate], aimAt([10, 0, 10])));
    // 11 LDU toward stud B (x = 30): B is now nearer, but not by more than the hysteresis
    const still = findPose(query(one, [plate], aimAt([21, 0, 10]), { prev: atA }));
    expect(moved(one, still).x).toBe(10);
    const switched = findPose(query(one, [plate], aimAt([28, 0, 10]), { prev: atA }));
    expect(moved(one, switched).x).toBe(30);
  });

  it.skipIf(!ready)('holds still on the seam between two plates', async () => {
    const m = await measureReal('3020');
    const a = place('a', m, 0, 0), b = place('b', m, 80, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const onA = findPose(query(one, [a, b], aimAt([38, 0, 10])));
    expect(moved(one, onA).x).toBe(30);
    const onB = findPose(query(one, [a, b], aimAt([42, 0, 10]), { prev: onA }));
    expect(moved(one, onB).x).toBe(30);
  });

  it.skipIf(!ready)('holds the pose when two are equally near', async () => {
    const plate = place('plate', await measureReal('3022'), 0, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const left = findPose(query(one, [plate], aimAt([-10, 0, 10])));
    expect(moved(one, left).x).toBe(-10);
    const between = findPose(query(one, [plate], aimAt([0, 0, 10]), { prev: left }));
    expect(moved(one, between).x).toBe(-10);
  });

  it.skipIf(!ready)('a locked grip is the only one used', async () => {
    const plate = place('plate', await measureReal('3023'), 0, 0);
    const brick = place('m', await measureReal('3004'), 300, -100, 0);
    const aim = aimAt([-12, 0, 0]);
    // automatic: the brick centres where the mouse is, overhanging by its right socket
    expect(centre(brick, findPose(query(brick, [plate], aim)))[0]).toBe(-20);
    // locked to its left socket, that socket goes on the stud
    const left = handleNear(brick, 'F', [290, -100 + 24, 0]);
    const pose = findPose(query(brick, [plate], aim, { lock: left }));
    expect(pose.handle).toBe(left);
    expect(centre(brick, pose)[0]).toBe(0);
  });

  it.skipIf(!ready)('falls back to the floor grid when no connection is near', async () => {
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const pose = findPose(query(one, [], { ...aimAt([33, 0, 47]), hitPoint: null })); // pointing at the floor
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(0);
    expect(pose.handle).toBe(-1);
    expect(pose.links).toEqual([]);
    const c = moved(one, pose);
    // a 1x1 plate centre sits mid-cell: 10 + 20k
    expect([((c.x - 10) % 20 + 20) % 20, Math.round(c.y), ((c.z - 10) % 20 + 20) % 20]).toEqual([0, -8, 0]);
    expect(Math.abs(c.x - 33)).toBeLessThanOrEqual(10);
    expect(Math.abs(c.z - 47)).toBeLessThanOrEqual(10);
  });

  it.skipIf(!ready)('pointing at the wall of a piece on the floor puts the part beside it, not inside it', async () => {
    const wall = place('wall', await measureReal('3001'), 0, -24);
    const brick = place('m', await measureReal('3001'), 600, -100, 400);
    // looking down at the side wall from the right: the cursor is on the brick, no stud near it can take the part
    for (const hit of [[40, -12, 0], [40, -12, 12], [40, -6, -14]] as Vec3[]) {
      const pose = findPose(query(brick, [wall], aimAt(hit, [300, -300, hit[2]])));
      expect(pose.valid).toBe(true);
      const [lo, hi] = boxX(brick, pose);
      expect(lo).toBeGreaterThanOrEqual(40);
      expect(hi - lo).toBe(80);
      expect(Math.round(moved(brick, pose).y)).toBe(-24);
    }
  });

  it.skipIf(!ready)('on the floor, a part lines up with the studs of the pieces beside it, not an absolute grid', async () => {
    // from the user's file: a 1x1 bracket whose studs sit 12 LDU off the 20 LDU floor grid
    const rot = (m: PartMetrics, id: string, x: number, y: number, z: number): Placed => {
      const world = new THREE.Matrix4().set(0, 0, 1, x, 0, 1, 0, y, -1, 0, 0, z, 0, 0, 0, 1).elements;
      return { solid: { id, world, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh }, connectors: worldConnectors(partConnectors(m), world) };
    };
    const bracket = rot(await measureReal('36840'), 'bracket', 252, -4, -410);
    const plate = rot(await measureReal('3710'), 'm', 600, -100, 0);
    // pointing at the floor just right of the bracket
    const pose = findPose(query(plate, [bracket], { ...aimAt([275, 4, -380]), hitPoint: null }, { floor: 4 }));
    expect(pose.valid).toBe(true);
    // the bracket's box ends at x = 262: the plate starts there, on the bracket's stud rows
    expect(boxX(plate, pose)).toEqual([262, 282]);
  });

  it.skipIf(!ready)('rotates in hand', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const two = place('m', await measureReal('3023'), 300, -60, 0);
    const flat = findPose(query(two, [plate], aimAt([-10, 0, -10])));
    const turned = findPose(query(two, [plate], aimAt([-10, 0, -10]), { yaw: 90 }));
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
    const pose = findPose(query(one, [plate], aimAt([10, 0, 10], fromBelow([10, 0, 10]))));
    expect(pose.valid).toBe(false);
  });

  it.skipIf(!ready)('stands on the floor it is given, not LDraw y = 0', async () => {
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const pose = findPose(query(one, [], aimAt([30, 24, 50], undefined, 24), { floor: 24 }));
    expect(pose.valid).toBe(true);
    expect(Math.round(moved(one, pose).y)).toBe(16);
  });

  it('an empty moving set never gives a usable pose', () => {
    const pose = findPose({ moving: { solids: [], connectors: [] }, targets: [], aim: aimAt([5, 0, 5]), ref: [0, 0, 0], lock: null, yaw: 0, world: null, before: new Set(), prev: null });
    expect(pose.valid).toBe(false);
    expect(pose.delta.every(Number.isFinite)).toBe(true);
  });

  it.skipIf(!ready)('pointing at a piece with no studs nearby stays by the mouse', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const one = place('m', await measureReal('3024'), 300, -60, 0);
    const far = findPose(query(one, [plate], aimAt([200, 0, 0])));
    expect(Math.abs(moved(one, far).x - 200)).toBeLessThanOrEqual(10);
    // even right after a seated pose: far from it, the part follows the mouse instead of jumping back
    const atA = findPose(query(one, [plate], aimAt([10, 0, 10])));
    const after = findPose(query(one, [plate], aimAt([200, 0, 0]), { prev: atA }));
    expect(Math.abs(moved(one, after).x - 200)).toBeLessThanOrEqual(10);
  });

  it.skipIf(!ready)('seats a 1x2x1 2/3 brick with side studs (22885) on a 2x4 plate', async () => {
    const plate = place('plate', await measureReal('3020'), 0, 0);
    const tall = place('m', await measureReal('22885'), 300, -100, 0);
    const pose = findPose(query(tall, [plate], aimAt([-20, 0, -10])));
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(2);
    expect(centre(tall, pose).map(Math.round)).toEqual([-20, -40, -10]);
  });

  describe('22885s on one top stud of another', () => {
    // the base stands upright: its top studs are at x = ±10, y = -40
    it.skipIf(!ready)('puts it on one stud either side, overhanging', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, -40);
      const held = place('m', m, 300, -200, 0);
      const left = findPose(query(held, [base], aimAt([-20, -40, 0])));
      expect(left.valid).toBe(true);
      expect(left.mated).toBe(1);
      expect(centre(held, left)[0]).toBe(-20);
      const right = findPose(query(held, [base], aimAt([20, -40, 0])));
      expect(right.valid).toBe(true);
      expect(centre(held, right)[0]).toBe(20);
    });

    it.skipIf(!ready)('puts a second one beside the first', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, -40);
      const first = place('first', m, -20, -80);
      const held = place('m', m, 300, -200, 0);
      const pose = findPose(query(held, [base, first], aimAt([20, -40, 0])));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(1);
      expect(centre(held, pose)[0]).toBe(20);
    });
  });

  describe('Technic pins', () => {
    // 3700 is a 1x2 brick with an 8 LDU hole through its side; 4274 is the pin that goes in it
    it.skipIf(!ready)('seats a pin in the brick’s side hole', async () => {
      const brick = place('brick', await measureReal('3700'), 0, -24);
      const pin = place('m', await measureReal('4274'), 300, -100, 0);
      // the hole's centre is 10 LDU below the brick's top (y = -14), and it opens toward −z
      const pose = findPose(query(pin, [brick], aimAt([0, -14, 0], fromFront([0, -14, 0]))));
      expect(pose.valid).toBe(true);
      expect(pose.owners).toEqual(['brick']);
      expect(pose.mated).toBe(1);
      // the pin's shaft base sits in the mouth of the hole, so its own origin lands 20 LDU in
      expect(moved(pin, pose).toArray().map(Math.round)).toEqual([0, -14, 10]);
    });
  });

  describe('bars: swords, scabbards and Technic pins', () => {
    // a minifig bar is 4 LDU across; a Technic pin's axial hole is the same bore
    it.skipIf(!ready)('seats a scabbard’s peg in a Technic pin', async () => {
      const pin = place('pin', await measureReal('4274'), 0, 0);
      const scab = place('m', await measureReal('19141'), 300, -300, 0);
      // the pin's bore runs along +x from its back end, so aim at the bore's mouth
      const pose = findPose(query(scab, [pin], aimAt([-20, 0, 0], fromFront([-20, 0, 0])), { floor: 1000 }));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(1);
      expect(pose.at?.map(Math.round)).toEqual([-20, 8, 0]); // the pin stands with its top at y 0
    });

    it.skipIf(!ready)('seats it from either end of the pin’s through hole', async () => {
      const pin = place('pin', await measureReal('4274'), 0, 0);
      const scab = place('m', await measureReal('19141'), 300, -300, 0);
      // the bore runs from x = −20 to x = 4, so the peg goes in from either face
      const back = findPose(query(scab, [pin], aimAt([-20, 8, 0], fromFront([-20, 8, 0])), { floor: 1000 }));
      expect(back.valid).toBe(true);
      expect(back.mated).toBe(1);
      expect(back.at?.map(Math.round)).toEqual([-20, 8, 0]);
      const front = findPose(query(scab, [pin], aimAt([4, 8, 0], fromFront([4, 8, 0])), { floor: 1000 }));
      expect(front.valid).toBe(true);
      expect(front.mated).toBe(1);
      expect(front.at?.map(Math.round)).toEqual([4, 8, 0]);
    });

    it.skipIf(!ready)('seats a sword’s grip in a Technic pin', async () => {
      const pin = place('pin', await measureReal('4274'), 0, 0);
      const sword = place('m', await measureReal('21459'), 300, -300, 0);
      const pose = findPose(query(sword, [pin], aimAt([-20, 0, 0], fromFront([-20, 0, 0])), { floor: 1000 }));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(1);
    });

    it.skipIf(!ready)('places a part with no matching connection where the mouse points', async () => {
      // a sword has nothing that takes a scabbard: it goes exactly where you point, unsnapped
      const scab = place('scab', await measureReal('19141'), 0, 0);
      const sword = place('m', await measureReal('21459'), 300, -300, 0);
      const ref: Vec3 = [0, -40, 0];
      const at: Vec3 = [0, -40, -60];
      const pose = findPose(query(sword, [scab], aimAt(at), { ...{ ref }, floor: 1000 }));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(0);
      expect(pose.handle).toBe(-1);
      const landed = new THREE.Vector3(...ref).applyMatrix4(new THREE.Matrix4().fromArray(pose.delta));
      expect([landed.x, landed.y, landed.z].map(Math.round)).toEqual(at);
    });
  });

  describe('sideways onto side studs', () => {
    // upright base: side studs at x = ±10, y = 10 and 30, on the face z = -10, pointing -Z
    it.skipIf(!ready)('mounts a 22885 flat on the side studs of another', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, 0);
      const held = place('m', m, 300, -200, 0);
      const pose = findPose(query(held, [base], aimAt([0, 20, -10], fromFront([0, 20, -10])), { floor: 1000 }));
      expect(pose.valid).toBe(true);
      expect(pose.mated).toBe(2);
      expect(boxX(held, pose)).toEqual([-20, 20]);
    });

    it.skipIf(!ready)('never leaves a side stud cutting into the wall of a brick held half a stud off', async () => {
      const m = await measureReal('22885');
      const base = place('base', m, 0, 0);
      const held = place('m', m, 300, -200, 0);
      // centred on the lower-right stud, the end wall would sit over the lower-left one
      const pose = findPose(query(held, [base], aimAt([10, 30, -10], fromFront([10, 30, -10])), { floor: 1000 }));
      expect(pose.valid).toBe(true);
      expect(boxX(held, pose)).not.toEqual([-10, 30]);
    });
  });
});
