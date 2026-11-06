import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { findPose, freeTargets, seat, type PoseQuery } from '../../src/plan/placementEngine';
import { connectorsMate, jointConnectors, placementConnectors, partConnectors, worldConnectors, type Connector } from '../../src/plan/connectors';
import { collisionWorld, type Solid } from '../../src/plan/collision';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Vec3 } from '../../src/ldraw/parse';
import type { Aim } from '../../src/plan/aim';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';

const box = { min: [-20, -20, -20] as Vec3, max: [20, 20, 20] as Vec3 };
const bare = (id: string) => ({ id, body: box, full: box, snaps: [] } as unknown as PartMetrics);
const near = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, k) => Math.abs(v - b[k]) < eps);
const joint = (type: 'knuckle' | 'ball', gender: 'M' | 'F', pos: Vec3, axis: Vec3 = [0, -1, 0], fit = 'r:8.0'): Connector =>
  ({ type, gender, pos, axis, fit });

describe('hinge and ball placement connectors', () => {
  it('mate by their own rule: a ball on its centre alone, a hinge on its line either way round', () => {
    const ball = joint('ball', 'M', [0, 0, 0]);
    expect(connectorsMate(ball, joint('ball', 'F', [0.5, 0, 0], [1, 0, 0]))).toBe(true);
    expect(connectorsMate(ball, joint('ball', 'F', [0, 0, 0], [0, -1, 0], 'g:techballjnt'))).toBe(false);
    expect(connectorsMate(ball, joint('ball', 'M', [0, 0, 0]))).toBe(false);
    const hinge = joint('knuckle', 'M', [0, 0, 0], [1, 0, 0], 'g:bricknet-hinge0');
    expect(connectorsMate(hinge, joint('knuckle', 'F', [0, 0, 0], [1, 0, 0], 'g:bricknet-hinge0'))).toBe(true);
    expect(connectorsMate(hinge, joint('knuckle', 'F', [0, 0, 0], [-1, 0, 0], 'g:bricknet-hinge0'))).toBe(true);
    expect(connectorsMate(hinge, joint('knuckle', 'F', [0, 0, 0], [0, 1, 0], 'g:bricknet-hinge0'))).toBe(false);
    expect(connectorsMate(hinge, joint('knuckle', 'F', [0, 0, 0], [1, 0, 0], 'g:bricknet-hinge4'))).toBe(false);
    // studs still need opposed axes
    const stud: Connector = { type: 'stud', gender: 'M', pos: [0, 0, 0], axis: [0, -1, 0] };
    expect(connectorsMate(stud, { ...stud, gender: 'F', axis: [0, 1, 0] })).toBe(true);
    expect(connectorsMate(stud, { ...stud, gender: 'F' })).toBe(false);
  });

  it('come from LDCad balls and the BrickNet fallback, and only placement sees them', () => {
    const plate = bare('2908');
    expect(jointConnectors(plate)).toHaveLength(4);
    expect(jointConnectors(plate).every((c) => c.type === 'ball' && c.gender === 'M' && c.fit === 'r:8.0')).toBe(true);
    expect(partConnectors(plate).some((c) => c.type === 'ball')).toBe(false);
    expect(placementConnectors(plate).filter((c) => c.type === 'ball')).toHaveLength(4);
    const arm = jointConnectors(bare('3818'));
    expect(arm.map((c) => c.fit).sort()).toEqual(['g:bricknet-hinge0', 'g:bricknet-hinge4']);
    // the shoulder pivot is the BrickNet point itself
    expect(near(arm.find((c) => c.fit === 'g:bricknet-hinge0')!.pos, [1, 0, 0])).toBe(true);
    // an LDCad ball counts too
    const ldcad = { ...bare('x'), snaps: [{ kind: 'gen', gender: 'F', start: [0, 0, 0], axis: [0, -1, 0], length: 0, radius: 12.7, shapes: ['GEN:sph'], slide: false, group: 'techBallJnt', placement: 'free' }] } as unknown as PartMetrics;
    expect(jointConnectors(ldcad)).toEqual([{ pos: [0, 0, 0], axis: [0, -1, 0], gender: 'F', type: 'ball', fit: 'g:techballjnt' }]);
  });

  it('a ball seats by moving its centre, keeping the orientation; R turns it about the vertical', () => {
    const m = seat(joint('ball', 'M', [5, 5, 5], [1, 0, 0]), joint('ball', 'F', [40, 0, 0], [0, 0, 1]), 0);
    expect(near(new THREE.Vector3(5, 5, 5).applyMatrix4(m).toArray(), [40, 0, 0])).toBe(true);
    expect(near(new THREE.Vector3(1, 0, 0).transformDirection(m).toArray(), [1, 0, 0])).toBe(true);
    const turned = seat(joint('ball', 'M', [0, 0, 0]), joint('ball', 'F', [40, 0, 0]), 90);
    expect(near(new THREE.Vector3(0, 0, 0).applyMatrix4(turned).toArray(), [40, 0, 0])).toBe(true);
    expect(Math.abs(new THREE.Vector3(1, 0, 0).transformDirection(turned).y)).toBeLessThan(1e-9);
  });

  it('a hinge seats on the line the least turn away, and R swings it about the hinge', () => {
    // already parallel the other way round: no turn needed
    const m = seat(joint('knuckle', 'M', [0, 0, 0], [-1, 0, 0]), joint('knuckle', 'F', [0, -20, 0], [1, 0, 0]), 0);
    expect(near(new THREE.Vector3(0, 1, 0).transformDirection(m).toArray(), [0, 1, 0])).toBe(true);
    expect(near(new THREE.Vector3(0, 0, 0).applyMatrix4(m).toArray(), [0, -20, 0])).toBe(true);
    const swung = seat(joint('knuckle', 'M', [0, 0, 0], [1, 0, 0]), joint('knuckle', 'F', [0, 0, 0], [1, 0, 0]), 90);
    expect(near(new THREE.Vector3(1, 0, 0).transformDirection(swung).toArray(), [1, 0, 0])).toBe(true);
    expect(Math.abs(new THREE.Vector3(0, 1, 0).transformDirection(swung).y)).toBeLessThan(1e-9);
  });
});

type Placed = { solid: Solid; connectors: Connector[] };
const place = (id: string, m: PartMetrics, world: number[]): Placed => {
  const joints = jointConnectors(m);
  return {
    solid: { id, world, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh, ...(joints.length ? { joints } : {}) },
    connectors: worldConnectors(placementConnectors(m), world),
  };
};
const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z).elements;
/** looking at `p` from 400 LDU in front (-z) and a little above */
const aimAt = (p: Vec3): Aim => {
  const from: Vec3 = [p[0], p[1] - 150, p[2] - 400];
  const d = new THREE.Vector3(p[0] - from[0], p[1] - from[1], p[2] - from[2]);
  const depth = d.length();
  d.normalize();
  return { ray: { origin: from, dir: [d.x, d.y, d.z] }, hitDepth: depth, floorPoint: null, hitPoint: p };
};
const query = (moving: Placed, fixed: Placed[], aim: Aim, ref: Vec3, extra: Partial<PoseQuery> = {}): PoseQuery => {
  const solids = fixed.map((f) => f.solid);
  return {
    moving: { solids: [moving.solid], connectors: moving.connectors },
    targets: freeTargets(fixed.map((f) => ({ list: f.connectors, owner: f.solid.id })), solids),
    aim, ref, lock: null, yaw: 0, world: collisionWorld(solids), before: new Set(), prev: null, floor: 1000, ...extra,
  };
};
const moved = (pose: { delta: number[] }, p: Vec3) => new THREE.Vector3(...p).applyMatrix4(new THREE.Matrix4().fromArray(pose.delta)).toArray();

describe.skipIf(!ready)('dropping parts onto hinges and balls (real LDraw parts)', () => {
  it('a 23922 socket drops onto a 2908 ball and clears collision only at the joint', async () => {
    const plate = place('plate', await measureReal('2908'), at(0, 0, 0));
    const arm = place('arm', await measureReal('23922'), at(200, -60, 100));
    // the ball on +x is at [40, 0, 0]; the arm's socket is at [0, -28, 20] in its frame
    const socket = [200, -88, 120] as Vec3;
    const pose = findPose(query(arm, [plate], aimAt([40, 0, 0]), socket));
    expect(pose.valid).toBe(true);
    expect(pose.owners).toEqual(['plate']);
    expect(pose.links.length).toBeGreaterThanOrEqual(1);
    expect(near(moved(pose, socket), [40, 0, 0], 1e-6)).toBe(true);
    // the arm keeps its orientation
    expect(near([pose.delta[0], pose.delta[5], pose.delta[10]], [1, 1, 1])).toBe(true);

    // the same pose without the joint allowance sits inside the ball
    const world = collisionWorld([plate.solid]);
    const seated = { ...arm.solid, world: new THREE.Matrix4().fromArray(pose.delta).multiply(new THREE.Matrix4().fromArray(arm.solid.world as number[])).elements };
    expect(world.hits([seated]).size).toBe(0);
    expect(collisionWorld([{ ...plate.solid, joints: undefined }]).hits([seated]).size).toBe(1);
    // and the allowance is only for a seated joint: 4 LDU off the ball, the socket is in it
    expect(world.hits([seated], [4, 0, 0]).size).toBe(1);
  });

  it('a 23922 socket drops onto the LDCad ball of a 3731', async () => {
    const brick = place('brick', await measureReal('3731'), at(0, 0, 0));
    const arm = place('arm', await measureReal('23922'), at(200, -60, 100));
    const socket = [200, -88, 120] as Vec3;
    const ball = brick.connectors.find((c) => c.type === 'ball')!;
    expect(ball.fit).toBe('r:8.0');
    const pose = findPose(query(arm, [brick], aimAt(ball.pos), socket));
    expect(pose.valid).toBe(true);
    expect(near(moved(pose, socket), ball.pos, 1e-6)).toBe(true);
  });

  it('a minifig arm drops onto the shoulder hinge of a torso', async () => {
    const torso = place('torso', await measureReal('973'), at(0, 0, 0));
    const arm = place('arm', await measureReal('3819'), at(200, -60, 100));
    const target = torso.connectors.find((c) => c.type === 'knuckle' && c.pos[0] > 0)!;
    const grip = arm.connectors.findIndex((c) => c.type === 'knuckle' && c.fit === target.fit);
    expect(grip).toBeGreaterThanOrEqual(0);
    const pose = findPose(query(arm, [torso], aimAt(target.pos), arm.connectors[grip].pos, { lock: grip }));
    expect(pose.valid).toBe(true);
    expect(pose.handle).toBe(grip);
    expect(near(moved(pose, arm.connectors[grip].pos), target.pos, 1e-6)).toBe(true);
    // R swings it about the shoulder, still seated
    const swung = findPose(query(arm, [torso], aimAt(target.pos), arm.connectors[grip].pos, { lock: grip, yaw: 90 }));
    expect(near(moved(swung, arm.connectors[grip].pos), target.pos, 1e-6)).toBe(true);
  });
});
