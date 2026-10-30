/**
 * Steering gear train cases from the 5590 benchmark: a 14T bevel pair on
 * crossing shafts and an 8T pinion on a 1x4 rack that is shifted along its
 * length (the wheels are posed turned). Gears are placed from the measured
 * per-part table, exactly as the lab does, then screened, proposed as spatial
 * mechanics and solved, so the turning direction is checked end to end.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bevelMesh, rackMesh, spurMesh, type WorldGear } from '../../src/anim/motion/gears/gearGeometry';
import { hasMeasuredGear, worldGear } from '../../src/anim/motion/gears/gearTable';
import { screenMechanismGeometry, type ScreenPart } from '../../src/anim/motion/spatial/geometryScreen';
import { proposeSpatialMechanic } from '../../src/anim/motion/spatial/spatialMechanicProposal';
import { SpatialMechanismSolver, type Q4, type SpatialModel, type V3 } from '../../src/anim/motion/kinematics/spatialModel';
import type { SpatialLinkagePreview } from '../../src/anim/motion/spatial/spatialAdapter';

/** Place a part so its own +Z (the gear shaft) points along `axis`, at `at`. */
const place = (axis: V3, at: V3, spin = 0) => {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...axis).normalize());
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin));
  return new THREE.Matrix4().compose(new THREE.Vector3(...at), q, new THREE.Vector3(1, 1, 1));
};
const g = (key: string, part: string, m: THREE.Matrix4) => worldGear(key, part, m)!;
const near = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < eps);

describe('measured gear table', () => {
  it('places an 8T gear with its 10 LDU pitch circle on the part Z axis', () => {
    const w = g('p', '3647.dat', new THREE.Matrix4());
    expect(w).toMatchObject({ kind: 'spur', teeth: 8, radius: 10 });
    expect(near((w as { axis: V3 }).axis, [0, 0, 1])).toBe(true);
  });
  it('rotates axes and cone tips with the part', () => {
    const w = g('b', '4143.dat', place([0, -1, 0], [5, 6, 7]));
    if (w.kind !== 'bevel') throw Error('expected bevel');
    expect(near(w.axis, [0, -1, 0])).toBe(true);
    // Tip is 17 LDU from the centre, on the side the teeth face.
    expect(Math.hypot(...w.tip!.map((x, i) => x - w.centre[i]))).toBeCloseTo(17, 6);
    expect(near(w.facing!, [0, 1, 0])).toBe(true);
  });
  it('knows only parts it has measurements for', () => {
    expect(hasMeasuredGear('parts/3743.dat')).toBe(true);
    expect(hasMeasuredGear('32270')).toBe(false); // double bevel: not yet measured
    expect(worldGear('x', '3001.dat', new THREE.Matrix4())).toBeNull();
  });
});

describe('spur gears', () => {
  const a = g('a', '3647', place([0, 0, 1], [0, 0, 0]));
  it('mesh when pitch circles touch, turning opposite ways', () => {
    const v = spurMesh(a, g('b', '3648', place([0, 0, 1], [40, 0, 0])));
    expect(v).toMatchObject({ meshes: true, sign: -1 });
  });
  it('reverse sign when one gear is mounted flipped (its axis points the other way)', () => {
    expect(spurMesh(a, g('b', '3648', place([0, 0, -1], [40, 0, 0]))).sign).toBe(1);
  });
  it('do not mesh 5 LDU apart, or side by side along the shaft', () => {
    expect(spurMesh(a, g('b', '3648', place([0, 0, 1], [45, 0, 0]))).meshes).toBe(false);
    expect(spurMesh(a, g('b', '3648', place([0, 0, 1], [40, 0, 10]))).meshes).toBe(false);
  });
});

// 5590 steering input: vertical shaft at x=0,z=80; lengthwise shaft at x=0,y=-62.
// They cross at (0,-62,80). 4143's teeth face its own -Z, with the cone tip
// 17 LDU out that way, so each gear sits 17 LDU back from the crossing: the
// input above it (part +Z pointing up, -Y) and the lengthwise one in front of
// it at z=63 (part +Z pointing -Z), as in the model.
const CROSS: V3 = [0, -62, 80];
const upBevel = (dx = 0) => g('up', '4143', place([0, -1, 0], [dx, -62 - 17, 80]));
const alongBevel = (dz = 0) => g('along', '4143', place([0, 0, -1], [0, -62, 80 - 17 + dz]));

describe('bevel gears', () => {
  it('mesh when both cone tips sit where the shafts cross', () => {
    const up = upBevel(), along = alongBevel();
    if (up.kind !== 'bevel') throw Error();
    expect(near(up.tip!, CROSS)).toBe(true);
    expect(bevelMesh(up, along)).toMatchObject({ meshes: true });
  });
  it('turn the opposite way when one is moved to the far side of the crossing', () => {
    // Compare in world terms: sign is about each gear's own axis, and the far
    // gear's own axis points the other way (+Z instead of -Z).
    const nearWorldZ = bevelMesh(upBevel(), alongBevel()).sign! * -1;
    const far = g('along', '4143', place([0, 0, 1], [0, -62, 80 + 17]));
    const v = bevelMesh(upBevel(), far);
    expect(v.meshes).toBe(true);
    expect(v.sign! * 1).toBe(-nearWorldZ);
  });
  it('reject shafts that miss each other', () => {
    expect(bevelMesh(upBevel(30), alongBevel()).reason).toMatch(/do not cross/);
  });
  it('reject cone tips away from the crossing', () => {
    expect(bevelMesh(upBevel(), alongBevel(-8)).reason).toMatch(/cone tips/);
  });
  it('never pair two bevels on one shaft', () => {
    expect(bevelMesh(upBevel(), g('twin', '4143', place([0, -1, 0], [0, -110, 80]))).meshes).toBe(false);
  });
});

// 5590 steering output: 8T pinion on the lengthwise shaft at (0,-62,-50); the
// 1x4 rack runs sideways beneath it with its teeth facing up (-Y).
const pinion = g('pinion', '3647', place([0, 0, 1], [0, -62, -50]));
/** Rack placed with no rotation: length along X, teeth facing -Y, pitch line 4 LDU above origin. */
const rack = (x: number, y = -62 + 10 + 4, flip = false) =>
  g('rack', '3743', new THREE.Matrix4().compose(new THREE.Vector3(x, y, -50),
    flip ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI) : new THREE.Quaternion(),
    new THREE.Vector3(1, 1, 1)));

describe('rack and pinion', () => {
  it('meshes with the rack shifted 14 LDU along its length', () => {
    const v = rackMesh(pinion, rack(14));
    expect(v).toMatchObject({ meshes: true });
    expect(v.errorLdu).toBeLessThan(1e-6);
    expect(near(v.slide!.map(Math.abs), [1, 0, 0])).toBe(true);
  });
  it('rejects a pinion beyond the end of the rack', () => {
    expect(rackMesh(pinion, rack(70)).reason).toMatch(/past the end/);
  });
  it('rejects a rack upside down (teeth facing away from the pinion)', () => {
    expect(rackMesh(pinion, rack(14, -62 + 10 + 4, true)).reason).toMatch(/side the teeth face/);
  });
  it('rejects a rack 6 LDU too low', () => {
    expect(rackMesh(pinion, rack(14, -62 + 10 + 4 + 6)).reason).toMatch(/pitch line/);
  });
  it('gives the rack direction that matches the contact velocity', () => {
    // Pinion turns +about +Z; the contact is below it (+Y), so it moves the
    // rack toward -X. Rack direction is +X, so the sign must be -1.
    expect(rackMesh(pinion, rack(14)).sign).toBe(-1);
  });
});

const part = (key: string, description: string, teeth?: number): ScreenPart =>
  ({ key, category: 'gear', description, ...(teeth ? { teeth } : {}) });
const boxOf = (w: WorldGear) => ({ min: w.centre.map(x => x - 12) as V3, max: w.centre.map(x => x + 12) as V3 });

describe('geometry screen with measured teeth', () => {
  const BEVEL = 'Technic Gear 14 Tooth Bevel';
  it('accepts the bevel pair with both axes and a turning direction', () => {
    const up = upBevel(), along = alongBevel();
    const [c] = screenMechanismGeometry([part('up', BEVEL, 14), part('along', BEVEL, 14)],
      new Map([['up', boxOf(up)], ['along', boxOf(along)]]), [], new Map<string, WorldGear>([['up', up], ['along', along]]));
    expect(c).toMatchObject({ kind: 'bevel', status: 'plausible' });
    expect(c.draft).toMatchObject({ teethA: 14, teethB: 14, axisA: (up as { axis: V3 }).axis, axisB: (along as { axis: V3 }).axis });
    expect(typeof c.draft!.reversed).toBe('boolean');
  });
  it('rejects bevels it has no measurements for instead of guessing from boxes', () => {
    const up = upBevel(), along = alongBevel();
    const [c] = screenMechanismGeometry([part('up', BEVEL, 14), part('along', BEVEL, 14)],
      new Map([['up', boxOf(up)], ['along', boxOf(along)]]));
    expect(c.status).toBe('rejected');
    expect(c.reasons.join(' ')).toMatch(/measured cone geometry/);
  });
  it('accepts the shifted rack that the old box test turned down', () => {
    const r = rack(14);
    const [c] = screenMechanismGeometry([part('pinion', 'Technic Gear 8 Tooth', 8), part('rack', 'Technic Gear Rack 1 x 4')],
      new Map([['pinion', boxOf(pinion)], ['rack', { min: [r.centre[0] - 40, r.centre[1] - 4, -60] as V3, max: [r.centre[0] + 40, r.centre[1] + 8, -40] as V3 }]]),
      [], new Map<string, WorldGear>([['pinion', pinion], ['rack', r]]));
    expect(c).toMatchObject({ kind: 'rack-pinion', status: 'plausible' });
    expect(c.draft).toMatchObject({ pitchRadiusLdu: 10, reversed: true });
  });
  it('rejects a measured pair whose teeth do not reach, explaining why', () => {
    const r = rack(70);
    const [c] = screenMechanismGeometry([part('pinion', 'Technic Gear 8 Tooth', 8), part('rack', 'Technic Gear Rack 1 x 4')],
      new Map([['pinion', boxOf(pinion)], ['rack', boxOf(r)]]), [], new Map<string, WorldGear>([['pinion', pinion], ['rack', r]]));
    expect(c.status).toBe('rejected');
    expect(c.reasons.join(' ')).toMatch(/Measured teeth: .*past the end/);
  });
});

/** Angle a pose has turned about a world axis (small angles). */
const turned = (q: Q4, axis: readonly number[]) => 2 * Math.atan2(q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2], q[3]);

describe('end to end: proposed mechanic turns the parts the physical way', () => {
  /** Each part is its own body on a joint to ground; `flip` authors the joint axis backwards. */
  const rig = (bodies: { id: string; kind: 'hinge' | 'slider'; axis: V3; at: V3; flip: boolean }[]): SpatialLinkagePreview => {
    const model: SpatialModel = {
      bodies: [{ id: 'ground', rest: { p: [0, 0, 0], q: [0, 0, 0, 1] }, fixed: true },
        ...bodies.map(b => ({ id: b.id, rest: { p: b.at, q: [0, 0, 0, 1] as Q4 } }))],
      constraints: bodies.map(b => {
        const axis = (b.flip ? b.axis.map(x => -x) : b.axis) as V3;
        return { id: `j-${b.id}`, kind: b.kind, a: { body: 'ground', local: b.at }, b: { body: b.id, local: [0, 0, 0] as V3 }, axisA: axis, axisB: axis };
      }),
    };
    return { model, members: Object.fromEntries(bodies.map(b => [b.id, [b.id]])), driver: `j-${bodies[0].id}`,
      kind: 'hinge', source: 'user-authored-json', warning: '' };
  };
  const BEVEL = 'Technic Gear 14 Tooth Bevel';

  for (const flipIn of [false, true]) for (const flipOut of [false, true]) {
    it(`bevel pair (input joint ${flipIn ? 'flipped' : 'as measured'}, output ${flipOut ? 'flipped' : 'as measured'})`, () => {
      const up = upBevel(), along = alongBevel();
      if (up.kind === 'rack' || along.kind === 'rack') throw Error();
      const [c] = screenMechanismGeometry([part('up', BEVEL, 14), part('along', BEVEL, 14)],
        new Map([['up', boxOf(up)], ['along', boxOf(along)]]), [], new Map<string, WorldGear>([['up', up], ['along', along]]));
      const preview = rig([{ id: 'up', kind: 'hinge', axis: up.axis, at: up.centre, flip: flipIn },
        { id: 'along', kind: 'hinge', axis: along.axis, at: along.centre, flip: flipOut }]);
      const { mechanic } = proposeSpatialMechanic(c, preview);
      const solver = new SpatialMechanismSolver({ ...preview.model, mechanics: [mechanic] });
      const sol = solver.solve({ 'j-up': flipIn ? -0.1 : 0.1 });
      const a = turned(sol.poses.get('up')!.q, up.axis), b = turned(sol.poses.get('along')!.q, along.axis);
      expect(a).toBeCloseTo(0.1, 3);
      // Contact velocities at the mesh must agree: sign from the measured verdict.
      expect(Math.sign(b)).toBe(bevelMesh(up, along).sign);
      expect(Math.abs(b)).toBeCloseTo(0.1, 3);
    });
  }

  for (const flipSlide of [false, true]) {
    it(`rack and pinion (slider ${flipSlide ? 'authored backwards' : 'as measured'})`, () => {
      const r = rack(14);
      if (r.kind !== 'rack' || pinion.kind === 'rack') throw Error();
      const [c] = screenMechanismGeometry([part('pinion', 'Technic Gear 8 Tooth', 8), part('rack', 'Technic Gear Rack 1 x 4')],
        new Map([['pinion', boxOf(pinion)], ['rack', boxOf(r)]]), [], new Map<string, WorldGear>([['pinion', pinion], ['rack', r]]));
      const preview = rig([{ id: 'pinion', kind: 'hinge', axis: pinion.axis, at: pinion.centre, flip: false },
        { id: 'rack', kind: 'slider', axis: r.direction, at: r.centre, flip: flipSlide }]);
      const { mechanic } = proposeSpatialMechanic(c, preview);
      const sol = new SpatialMechanismSolver({ ...preview.model, mechanics: [mechanic] }).solve({ 'j-pinion': 0.1 });
      const moved = sol.poses.get('rack')!.p.map((x, i) => x - r.centre[i]);
      // Pinion turning +0.1 rad about +Z moves the rack 1 LDU toward -X.
      expect(moved[0]).toBeCloseTo(-1, 3);
    });
  }
});
