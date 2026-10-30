/**
 * Ready-to-drive suggestions built from detected joints and measured gears:
 * 5590-style rack steering (knob -> bevel pair -> pinion -> rack on a tie rod
 * between two steering arms), a rack on a straight guide, and a turntable that
 * swings the whole trailer it carries.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Assembly, Metrics } from '../../src/model/assemble';
import type { MechanismEdge, MechanismGraph } from '../../src/anim/motion/v4/mechanismGraph';
import type { GeometryCandidate } from '../../src/anim/motion/spatial/geometryScreen';
import { bevelMesh, rackMesh, type WorldGear } from '../../src/anim/motion/gears/gearGeometry';
import { worldGear } from '../../src/anim/motion/gears/gearTable';
import { suggestRackSteering } from '../../src/anim/motion/v4/drivetrainSuggestions';
import { detectAutomaticMechanics } from '../../src/anim/motion/v4/autoMechanics';
import { MechanismSolver } from '../../src/anim/motion/v4/mechanismSolver';

type V3 = [number, number, number];
const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1];
/** Part placed so its own +Z points along `axis`. */
const place = (axis: V3, at: V3) => new THREE.Matrix4().compose(new THREE.Vector3(...at),
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...axis)), new THREE.Vector3(1, 1, 1));
const moved = (at: V3) => new THREE.Matrix4().makeTranslation(...at);

let edgeId = 0;
const edge = (a: string, b: string, motion: MechanismEdge['motion'], axis: V3, centre: V3,
  type: MechanismEdge['type'] = 'axle-hole'): MechanismEdge =>
  ({ id: `e${++edgeId}`, a, b, type, motion, axis, centre, source: 'ldcad-shadow', joint: {} as MechanismEdge['joint'] });

type Fixture = { parts: Record<string, { part: string; world: THREE.Matrix4 }>; edges: MechanismEdge[]; clusters: string[][] };
const build = (f: Fixture) => {
  const asm = { instances: Object.entries(f.parts).map(([key, p]) => ({ key, part: `${p.part}.dat`, model: 'm', world: p.world,
    worldBox: { min: [-5, -5, -5], max: [5, 5, 5] } })) } as unknown as Assembly;
  const graph = { edges: f.edges, rigidClusters: f.clusters, byBody: new Map(), uncertainBodies: [],
    mobility: () => ({ allowed: true }), isMate: () => false } as unknown as MechanismGraph;
  const measured = new Map<string, WorldGear>();
  for (const [key, p] of Object.entries(f.parts)) { const g = worldGear(key, p.part, p.world); if (g) measured.set(key, g); }
  return { asm, graph, measured };
};
const candidate = (kind: GeometryCandidate['kind'], a: string, b: string, reversed: boolean) =>
  ({ id: `${kind}:${a}:${b}`, kind, a, b, status: 'plausible', confidence: 'geometry-consistent-review-required',
    evidence: 'axis-and-bounds-screen', metrics: {}, reasons: [], draft: { axis: Z, reversed } }) as unknown as GeometryCandidate;

/**
 * 5590 steering. Shafts cross at (0,-62,80); the pinion (r=10) sits on the
 * lengthwise axle, the rack 10 LDU below it, shifted 14 LDU along its length.
 * Steering arms pivot on the frame at z=-90 and are pinned to the tie rod at
 * z=-53 by axle pins that lock in the arms (sliding along Y only).
 */
const steering = (extra: Partial<Fixture> = {}, guided = false): Fixture => {
  const parts: Fixture['parts'] = {
    frame: { part: '3001', world: new THREE.Matrix4() },
    inAxle: { part: '3706', world: moved([0, -90, 80]) },
    inBevel: { part: '4143', world: place([0, -1, 0], [0, -79, 80]) },
    lenAxle: { part: '3707', world: moved([0, -62, 0]) },
    lenBevel: { part: '4143', world: place([0, 0, -1], [0, -62, 63]) },
    pinion: { part: '3647', world: place(Z, [0, -62, -50]) },
    rack: { part: '3743', world: moved([14, -48, -50]) },
    ...(guided ? {} : {
      rod: { part: '4442', world: moved([14, -40, -53]) },
      pinL: { part: '3749', world: moved([-56, -40, -53]) }, pinR: { part: '3749', world: moved([84, -40, -53]) },
      armL: { part: '4261', world: moved([-56, -40, -70]) }, armR: { part: '4261', world: moved([84, -40, -70]) },
    }),
    ...extra.parts,
  };
  const edges = [
    edge('inBevel', 'inAxle', 'sliding', Y, [0, -79, 80]), edge('inAxle', 'frame', 'revolute', Y, [0, -90, 80]),
    edge('lenBevel', 'lenAxle', 'sliding', Z, [0, -62, 63]), edge('pinion', 'lenAxle', 'sliding', Z, [0, -62, -50]),
    edge('lenAxle', 'frame', 'revolute', Z, [0, -62, 0]),
    ...(guided ? [edge('rack', 'frame', 'sliding', X, [14, -45, -50], 'stud-socket')] : [
      edge('pinL', 'rod', 'revolute', Y, [-56, -40, -53]), edge('pinR', 'rod', 'revolute', Y, [84, -40, -53]),
      edge('pinL', 'armL', 'sliding', Y, [-56, -35, -53]), edge('pinR', 'armR', 'sliding', Y, [84, -35, -53]),
      edge('armL', 'frame', 'revolute', Y, [-56, -40, -90], 'cylindrical'), edge('armR', 'frame', 'revolute', Y, [84, -40, -90], 'cylindrical'),
    ]),
    ...(extra.edges ?? []),
  ];
  return { parts, edges, clusters: guided ? [] : [['rack', 'rod']] };
};
const candidatesFor = (m: ReadonlyMap<string, WorldGear>, bevels = true) => [
  ...(bevels ? [candidate('bevel', 'inBevel', 'lenBevel', bevelMesh(m.get('inBevel')!, m.get('lenBevel')!).sign === 1)] : []),
  candidate('rack-pinion', 'pinion', 'rack', rackMesh(m.get('pinion')!, m.get('rack')!).sign === -1),
];
const position = (frame: { poses: Map<string, THREE.Matrix4> }, key: string, asm: Assembly) =>
  new THREE.Vector3().setFromMatrixPosition(frame.poses.get(key) ?? asm.instances.find(i => i.key === key)!.world);

describe('rack steering on a four-bar tie rod', () => {
  const { asm, graph, measured } = build(steering());
  it('the fixture meshes as measured', () => {
    expect(bevelMesh(measured.get('inBevel')!, measured.get('lenBevel')!).meshes).toBe(true);
    expect(rackMesh(measured.get('pinion')!, measured.get('rack')!).meshes).toBe(true);
  });
  const [s] = suggestRackSteering(asm, graph, candidatesFor(measured), measured);
  it('is offered as one drive train from the knob to the rack', () => {
    expect(s?.title).toBe('Rack steering — 4143 → 3647 → 3743 on a four-bar tie rod');
    expect(s.evidence).toBe('measured-gear-train');
    const p = s.program;
    expect(p.joints.find(j => j.id === p.driver.joint)!.body).toBe('inBevel');
    expect(p.transmissions).toHaveLength(1);
    expect(p.closures).toHaveLength(1);
    expect(p.rackContacts).toHaveLength(1);
    // The rack, its tie rod and the cross-axle groups move with their joints.
    const follows = (leader: string) => p.rigidFollowers?.find(f => f.leader === leader)?.bodies ?? [];
    expect(follows('inBevel')).toContain('inAxle');
    expect(follows('pinion')).toEqual(expect.arrayContaining(['lenAxle', 'lenBevel']));
    expect(follows('rack')).toContain('rod');
    expect(follows('armL')).toContain('pinL');
    expect(follows('armR')).toContain('pinR');
  });
  it('turning the knob rolls the rack and swings both arms on the true arc', () => {
    const solver = new MechanismSolver(asm, s.program);
    const angle = s.program.driver.amplitude;
    for (let i = 1; i <= 8; i++) solver.solve(angle * i / 8);
    const f = solver.solve(angle);
    const pinionTurn = f.joints.get(s.program.joints.find(j => j.body === 'pinion')!.id)!;
    expect(Math.abs(pinionTurn)).toBeCloseTo(angle, 6); // 14T:14T
    const shift = position(f, 'rack', asm).sub(position({ poses: new Map() }, 'rack', asm));
    // Rolling: rack travel along its length = pitch radius x pinion turn.
    expect(Math.abs(shift.x)).toBeCloseTo(10 * Math.abs(pinionTurn), 1);
    expect(f.rackContactErrorsLdu![0]).toBeLessThan(.01);
    // Parallelogram: both arms turn by asin(travel / arm length).
    const arm = (k: string) => f.joints.get(s.program.joints.find(j => j.body === k)!.id)!;
    expect(arm('armL')).toBeCloseTo(arm('armR'), 4);
    expect(Math.abs(arm('armL'))).toBeCloseTo(Math.asin(Math.abs(shift.x) / 37), 3);
    expect(shift.y).toBeCloseTo(0, 6);
  });
  it('is not offered when a part locked to the knob shaft is also held by the frame (it would jam)', () => {
    // On the cross axle (turns with it) yet clipped to the frame (cannot turn).
    const fx = steering({ parts: { clip: { part: '3001', world: new THREE.Matrix4() } },
      edges: [edge('clip', 'inAxle', 'sliding', Y, [0, -95, 80]), edge('clip', 'frame', 'sliding', X, [0, -95, 85], 'stud-socket')] });
    const b = build(fx);
    expect(suggestRackSteering(b.asm, b.graph, candidatesFor(b.measured), b.measured)).toEqual([]);
  });
  it('allows a carried bush that only bears on the frame about the shaft', () => {
    const fx = steering({ parts: { bush: { part: '3713', world: new THREE.Matrix4() } },
      edges: [edge('bush', 'inAxle', 'sliding', Y, [0, -95, 80]), edge('bush', 'frame', 'revolute', Y, [0, -95, 80])] });
    const b = build(fx);
    const [x] = suggestRackSteering(b.asm, b.graph, candidatesFor(b.measured), b.measured);
    expect(x?.program.rigidFollowers?.find(f => f.leader === 'inBevel')?.bodies).toContain('bush');
  });
  it('is not offered without a measured gear chain to the pinion: the pinion drives directly', () => {
    const [x] = suggestRackSteering(asm, graph, candidatesFor(measured, false), measured);
    expect(x.title).toBe('Rack steering — 3647 → 3743 on a four-bar tie rod');
    expect(x.program.joints.find(j => j.id === x.program.driver.joint)!.body).toBe('pinion');
  });
});

describe('rack on a straight guide', () => {
  const { asm, graph, measured } = build(steering({}, true));
  const [s] = suggestRackSteering(asm, graph, candidatesFor(measured), measured);
  it('slides the rack by pitch radius x pinion turn, in the measured direction', () => {
    expect(s?.title).toBe('Rack steering — 4143 → 3647 → 3743 on a slide');
    const slide = s.program.joints.find(j => j.body === 'rack')!;
    expect(slide.kind).toBe('prismatic');
    const solver = new MechanismSolver(asm, s.program);
    const f = solver.solve(s.program.driver.amplitude);
    const pinion = f.joints.get(s.program.joints.find(j => j.body === 'pinion')!.id)!;
    const sign = rackMesh(measured.get('pinion')!, measured.get('rack')!).sign!;
    expect(position(f, 'rack', asm).x - 14).toBeCloseTo(sign * 10 * pinion, 6);
  });
});

describe('turntable hitch', () => {
  const metrics = ((part: string) => ({ description: /3404/.test(part) ? 'Turntable 4 x 4 Top' : /3403/.test(part) ? 'Turntable 4 x 4 Base' : 'Brick',
    snaps: [], body: undefined })) as unknown as Metrics;
  const hitch = (closed: boolean): Fixture => ({
    parts: {
      truck: { part: '3001', world: new THREE.Matrix4() }, base: { part: '3403', world: moved([0, -100, 200]) },
      top: { part: '3404', world: moved([0, -112, 200]) }, pin: { part: '4519', world: moved([0, -120, 200]) },
      trailer: { part: '3001', world: moved([0, -130, 300]) }, wheel: { part: '3001', world: moved([0, -14, 400]) },
    },
    edges: [
      edge('top', 'base', 'revolute', Y, [0, -106, 200], 'cylindrical'),
      edge('pin', 'top', 'revolute', Y, [0, -116, 200]),
      edge('wheel', 'trailer', 'revolute', X, [0, -14, 400]),
      ...(closed ? [edge('trailer', 'truck', 'sliding', Z, [0, -100, 100], 'stud-socket')] : []),
    ],
    clusters: [['truck', 'base'], ['pin', 'trailer']],
  });
  it('swings everything the top carries: the trailer and its wheels', () => {
    const { asm, graph } = build(hitch(false));
    const s = detectAutomaticMechanics(asm, metrics, graph).suggestions[0];
    expect(s.title).toBe('Turntable — 3404.dat / 3403.dat (swings 4 parts)');
    expect(s.program.joints[0].body).toBe('top');
    expect(s.program.rigidFollowers![0].bodies.sort()).toEqual(['pin', 'trailer', 'wheel']);
  });
  it('is not offered when the trailer is also tied to the truck (a closed loop)', () => {
    const { asm, graph } = build(hitch(true));
    expect(detectAutomaticMechanics(asm, metrics, graph).suggestions.filter(s => s.title.startsWith('Turntable'))).toEqual([]);
  });
});
