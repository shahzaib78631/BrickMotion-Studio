import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import type { Move, Timeline } from '../../src/anim/timeline';
import { mechanicalApproaches, clearanceApproaches, adaptiveClearanceApproaches } from '../../src/anim/motion/kinematicCandidates';
import { InstalledRouteIndex } from '../../src/anim/motion/routeSelection';
import { articulateStandardTimeline } from '../../src/anim/motion/standardMotion';
import { flightPose } from '../../src/anim/timeline';
import { transformBox, type Assembly, type Metrics } from '../../src/model/assemble';
import { SpatialHash } from '../../src/model/spatialHash';

const at = (x: number, y = 0, z = 0) => new THREE.Matrix4().makeTranslation(x, y, z);
const raw: Move = { unit: 1, from: at(-100), to: at(100), rel: null,
  skyY: -100, hold: 0, entry: [0, 0, 0] };
const joint = (type: MechanicalJoint['type']): MechanicalJoint => ({
  id: 'mate', type, male: 'moving', female: 'static',
  axis: [0, 1, 0], centre: [10, 0, 0], engagement: 12,
  motion: type === 'hinge' || type === 'clip' ? 'revolute' : type === 'ball-socket' ? 'ball' : 'sliding',
});
const exact = (a: THREE.Matrix4, b: THREE.Matrix4) =>
  expect(a.elements.every((v, i) => Math.abs(v - b.elements[i]) < 1e-7)).toBe(true);

describe('Standard Motion v2 — genuine joint paths', () => {
  it('keeps the authored endpoints, rotates about a world pivot, and exposes both swing signs', () => {
    const hinge = joint('hinge');
    const swings = mechanicalApproaches(raw, hinge, 'moving');
    expect(swings).toHaveLength(2);
    const pivot = new THREE.Vector3(...hinge.centre);
    const radius = new THREE.Vector3().setFromMatrixPosition(raw.to).distanceTo(pivot);
    for (const swing of swings) {
      exact(swing.poses[0], raw.from);
      exact(swing.poses.at(-1)!, raw.to);
      const opened = new THREE.Vector3().setFromMatrixPosition(swing.poses[3]);
      expect(opened.distanceTo(pivot)).toBeCloseTo(radius, 5);
      expect(opened.x).not.toBeCloseTo(raw.to.elements[12], 3);
    }
    expect(swings[0].poses[3].elements[14]).toBeCloseTo(-swings[1].poses[3].elements[14], 5);
  });

  it('seats axles and pins without a fictional screw', () => {
    // Round pins are inserted axially too: no invented screw thread, and no
    // rotation the connector does not describe.
    for (const [expected, routes] of [['axle-hole', mechanicalApproaches(raw, joint('axle-hole'), 'moving')],
      ['pin-hole', mechanicalApproaches(raw, joint('pin-hole'), 'moving')]] as const) {
      expect(routes).toHaveLength(2);
      for (const route of routes) {
        expect(route.motion).toBe(expected);
        expect(route.kinematicSegments?.every((s) => s.kind === 'prismatic')).toBe(true);
        exact(route.poses.at(-1)!, raw.to);
        // The keyed part's orientation is fixed throughout its final insertion.
        for (const frame of route.poses.slice(3)) {
          expect(frame.elements[0]).toBeCloseTo(raw.to.elements[0], 6);
          expect(frame.elements[10]).toBeCloseTo(raw.to.elements[10], 6);
        }
      }
    }
    expect(mechanicalApproaches(raw, joint('stud-socket'), 'moving')).toHaveLength(2);
    expect(mechanicalApproaches(raw, joint('ball-socket'), 'moving')).toHaveLength(2);
    expect(clearanceApproaches(raw, 24)).toHaveLength(4);
  });

  it('plays the proposed polyline in the existing motion sampler (not just preview metadata)', () => {
    const route = mechanicalApproaches(raw, joint('hinge'), 'moving')[0];
    const mv = { ...raw, posePath: route.poses };
    exact(flightPose(mv, 0, new THREE.Matrix4()), raw.from);
    exact(flightPose(mv, 1, new THREE.Matrix4()), raw.to);
    expect(flightPose(mv, 0.6, new THREE.Matrix4()).elements[12]).not.toBeCloseTo(raw.from.elements[12]);
  });
});

const body = { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
const metrics: Metrics = (id) => ({ id, body, full: body, footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false });
function scene(staticStart: number): { assembly: Assembly; timeline: Timeline } {
  const instances = ['static', 'moving'].map((key, i) => ({
    key, itemId: key, model: '', part: 'synthetic', color: 4, grid: true, placeholder: false,
    world: at(i ? 100 : 0),
    worldBox: { min: [i ? 95 : -5, -5, -5] as [number,number,number],
      max: [i ? 105 : 5, 5, 5] as [number,number,number] },
  }));
  const assembly = { instances, bounds: { min: [-5, -5, -5], max: [105, 5, 5] }, nodes: [] } as unknown as Assembly;
  const tracks = new Map(instances.map((instance, i) => [instance.key, {
    appear: 0, floor: at(i ? -100 : -300),
    floorBox: transformBox(body, at(i ? -100 : -300)), ctx: 0, final: instance.world,
    moves: [{ ...raw, unit: i, from: at(i ? -100 : -300), to: instance.world }],
  }] as const));
  const timeline = { tracks, units: [
    { kind: 'piece', keys: ['static'], start: staticStart, dur: 1, step: 0 },
    { kind: 'piece', keys: ['moving'], start: 2, dur: 1, step: 1 },
  ] } as unknown as Timeline;
  return { assembly, timeline };
}

describe('Standard Motion v2 — route advisories', () => {
  it('queries the installed-part spatial hash without duplicates', () => {
    const hash = new SpatialHash(10);
    hash.insert(1, { min: [-6, -5, -5], max: [6, 5, 5] });
    hash.insert(2, { min: [100, -5, -5], max: [110, 5, 5] });
    expect(hash.query({ min: [-10, -6, -4], max: [10, 6, 4] })).toEqual([1]);
    expect(hash.query({ min: [90, -6, -4], max: [120, 6, 4] })).toEqual([2]);
  });

  it('handles oversized boxes without exploding the grid and retains conservative pairs', () => {
    const hash = new SpatialHash(10);
    hash.insert(1, { min: [-10000, -10000, -10000], max: [10000, 10000, 10000] });
    hash.insert(2, { min: [5000, -3, -3], max: [5003, 3, 3] });
    expect(hash.query({ min: [5000, -5, -5], max: [5010, 5, 5] })).toEqual([1, 2]);
    expect(hash.pairs()).toEqual([[1, 2]]);
  });

  it('does not compare a temporary workbench submodel move against final-world obstructions', () => {
    const { assembly, timeline } = scene(0);
    const tr = timeline.tracks.get('moving')!;
    tr.ctx = 1;
    const result = new InstalledRouteIndex(assembly, timeline).assess(
      { ...raw, translationPath: [[0, 0, 0], [200, 0, 0]] }, 'moving', 'synthetic', 2, metrics);
    expect(result.assessed).toBe(false);
    expect(result.hits).toBe(0);
  });

  it('detects a blocked direct path and fewer potential contacts on an overhead detour', () => {
    const { assembly, timeline } = scene(0);
    const index = new InstalledRouteIndex(assembly, timeline);
    const straight: Move = { ...raw, translationPath: [[0, 0, 0], [200, 0, 0]] };
    const rerouted: Move = { ...raw, posePath: [at(-100), at(-100, -120), at(100, -120), at(100)] };
    expect(index.assess(straight, 'moving', 'synthetic', 2, metrics).hits).toBeGreaterThan(0);
    expect(index.assess(rerouted, 'moving', 'synthetic', 2, metrics).hits).toBe(0);
  });

  it('does not count a future brick as an already-installed obstruction', () => {
    const { assembly, timeline } = scene(9);
    const assessment = new InstalledRouteIndex(assembly, timeline).assess(
      { ...raw, translationPath: [[0, 0, 0], [200, 0, 0]] }, 'moving', 'synthetic', 2, metrics);
    expect(assessment.blockers).toEqual([]);
    expect(assessment.hits).toBe(0);
  });
});

describe('Standard Motion v3 — time-aware collision avoidance', () => {
  const sceneOf = (parts: { key: string; final: THREE.Matrix4; floor: THREE.Matrix4;
    move: Move; start: number; dur?: number; appear?: number }[], m: Metrics = metrics) => {
    const instances = parts.map(p => ({ key: p.key, itemId: p.key, model: '', part: 'synthetic', color: 4,
      grid: true, placeholder: false, world: p.final,
      worldBox: transformBox(m('synthetic').full, p.final) }));
    const assembly = { instances, nodes: [], bounds: null } as unknown as Assembly;
    const tracks = new Map(parts.map((p, i) => [p.key, {
      appear: p.appear ?? -Infinity, ctx: 0, floor: p.floor,
      floorBox: transformBox(m('synthetic').full, p.floor),
      final: p.final, moves: [{ ...p.move, unit: i }],
    }] as const));
    const timeline = { tracks, units: parts.map((p) => ({ kind: 'piece', keys: [p.key],
      start: p.start, dur: p.dur ?? 1, step: 0 })) } as unknown as Timeline;
    return { assembly, timeline };
  };

  it('finds a collision between two simultaneously moving parts (not installed yet)', () => {
    const a = at(-100), b = at(0, 0, -100);
    const { assembly, timeline } = sceneOf([
      { key: 'east', final: at(100), floor: a, start: 1,
        move: { ...raw, unit: 0, from: a, to: at(100), posePath: [a, at(100)] } },
      { key: 'north', final: at(0, 0, 100), floor: b, start: 1,
        move: { ...raw, unit: 1, from: b, to: at(0, 0, 100), posePath: [b, at(0, 0, 100)] } },
    ]);
    const index = new InstalledRouteIndex(assembly, timeline, metrics);
    const assessment = index.assess(timeline.tracks.get('east')!.moves[0], 'east', 'synthetic', 1, metrics);
    expect(assessment.blockers).toContain('north');
    expect(assessment.hits).toBeGreaterThan(0);
  });

  it('replans concurrent flights and reviews the final routes, not stale original motion', () => {
    const a = at(-100), b = at(0, 0, -100);
    const { assembly, timeline } = sceneOf([
      { key: 'east', final: at(100), floor: a, start: 1,
        move: { ...raw, from: a, to: at(100), posePath: [a, at(100)] } },
      { key: 'north', final: at(0, 0, 100), floor: b, start: 1,
        move: { ...raw, from: b, to: at(0, 0, 100), posePath: [b, at(0, 0, 100)] } },
    ]);
    timeline.camKeys = [];
    timeline.buildBox = { min: [-120, -20, -120], max: [120, 20, 120] };
    timeline.sceneBox = timeline.buildBox;
    articulateStandardTimeline(timeline, assembly, metrics, new Map(), []);
    expect(timeline.motion?.obstructed).toBe(0);
    expect(timeline.motion?.issues).toEqual([]);
    for (const instance of assembly.instances) {
      const track = timeline.tracks.get(instance.key)!;
      expect(flightPose(track.moves[0], 1, new THREE.Matrix4()).equals(instance.world)).toBe(true);
    }
  });

  it('finds an occupied staging position even when that piece has not launched', () => {
    const from = at(-100), to = at(100), parked = at(0);
    const { assembly, timeline } = sceneOf([
      { key: 'moving', final: to, floor: from, start: 1,
        move: { ...raw, from, to, posePath: [from, to] } },
      { key: 'parked', final: at(300), floor: parked, start: 9,
        move: { ...raw, from: parked, to: at(300), posePath: [parked, at(300)] } },
    ]);
    const index = new InstalledRouteIndex(assembly, timeline, metrics);
    const assessment = index.assess(timeline.tracks.get('moving')!.moves[0], 'moving', 'synthetic', 1, metrics);
    expect(assessment.blockers).toContain('parked');
  });

  it('adapts the cruise height to clear a tall, wide wall that fixed offsets cannot bypass', () => {
    const tall = { min: [-60, -180, -190] as [number, number, number],
      max: [60, 5, 190] as [number, number, number] };
    const sized: Metrics = part => ({ id: part, body: part === 'wall' ? tall : body,
      full: part === 'wall' ? tall : body, footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false });
    const from = at(-100), to = at(100);
    const instances = [
      { key: 'wall', itemId: 'wall', model: '', part: 'wall', color: 4, grid: true, placeholder: false, world: at(0), worldBox: tall },
      { key: 'moving', itemId: 'moving', model: '', part: 'synthetic', color: 4, grid: true, placeholder: false, world: to,
        worldBox: transformBox(body, to) },
    ] as Assembly['instances'];
    const flight: Move = { ...raw, from, to, translationPath: [[0,0,0],[200,0,0]] };
    const tl = { tracks: new Map([
      ['wall', { appear: -Infinity, ctx: 0, floor: at(0), floorBox: tall,
        final: at(0), moves: [{ ...raw, unit: 0, from: at(0), to: at(0), stationary: true }] }],
      ['moving', { appear: -Infinity, ctx: 0, floor: from, floorBox: transformBox(body, from),
        final: to, moves: [{ ...flight, unit: 1 }] }],
    ]), units: [{ kind: 'piece', keys: ['wall'], start: 0, dur: 1 },
      { kind: 'piece', keys: ['moving'], start: 2, dur: 1 }],
    } as unknown as Timeline;
    const index = new InstalledRouteIndex({ instances } as Assembly, tl, sized);
    expect(index.assess(flight, 'moving', 'synthetic', 2, sized).hits).toBeGreaterThan(0);
    for (const candidate of clearanceApproaches(flight, 10)) {
      const mv = { ...flight, translationPath: undefined, posePath: candidate.poses };
      expect(index.assess(mv, 'moving', 'synthetic', 2, sized).hits).toBeGreaterThan(0);
    }
    const candidates = adaptiveClearanceApproaches(flight, body, index.obstacleBoxes(2, 3, 'moving'));
    const scores = candidates.map(candidate => index.assess({ ...flight, translationPath: undefined,
      posePath: candidate.poses }, 'moving', 'synthetic', 2, sized).hits);
    expect(Math.min(...scores)).toBe(0);
    expect(candidates.every(c => c.poses.at(-1)!.equals(to))).toBe(true);
  });

  it('does not skip collisions in the last three percent of a flight', () => {
    const tiny = { min: [-0.3, -0.3, -0.3] as [number, number, number],
      max: [0.3, 0.3, 0.3] as [number, number, number] };
    const sized: Metrics = id => ({ id, body: tiny, full: tiny,
      footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false });
    const { assembly, timeline } = sceneOf([
      { key: 'target', floor: at(1000), final: at(1000), start: 0,
        move: { ...raw, from: at(1000), to: at(1000), stationary: true } },
      { key: 'moving', floor: at(0), final: at(1000), start: 2,
        move: { ...raw, from: at(0), to: at(1000), posePath: [at(0), at(1000)] } },
    ], sized);
    const result = new InstalledRouteIndex(assembly, timeline, sized).assess(
      timeline.tracks.get('moving')!.moves[0], 'moving', 'synthetic', 2, sized, 64);
    expect(result.firstHit).toBeGreaterThan(0.96);
    expect(result.blockers).toContain('target');
  });

  it('does not exempt a path through the host just because the host is its mate', () => {
    const origin = at(-100), goal = at(100);
    const { assembly, timeline } = sceneOf([
      { key: 'host', floor: at(0), final: at(0), start: 0,
        move: { ...raw, from: at(0), to: at(0), stationary: true } },
      { key: 'moving', floor: origin, final: goal, start: 2,
        move: { ...raw, from: origin, to: goal, posePath: [origin, goal] } },
    ]);
    const index = new InstalledRouteIndex(assembly, timeline, metrics);
    const result = index.assess(timeline.tracks.get('moving')!.moves[0], 'moving', 'synthetic', 2,
      metrics, 32, 'host', true);
    expect(result.hits).toBeGreaterThan(0);
    expect(result.blockers).toContain('host');
  });
});
