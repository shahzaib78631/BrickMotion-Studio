import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import type { Move, Timeline } from '../../src/anim/timeline';
import { mechanicalApproaches, clearanceApproaches } from '../../src/anim/motion/kinematicCandidates';
import { InstalledRouteIndex } from '../../src/anim/motion/routeSelection';
import { flightPose } from '../../src/anim/timeline';
import type { Assembly, Metrics } from '../../src/model/assemble';
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

  it('seats axles without a fictional screw, but permits guided cylindrical twists', () => {
    const axle = mechanicalApproaches(raw, joint('axle-hole'), 'moving');
    const pin = mechanicalApproaches(raw, joint('pin-hole'), 'moving');
    for (const route of axle) {
      expect(route.motion).toBe('axle-hole');
      exact(route.poses.at(-1)!, raw.to);
      // The keyed axle's orientation is fixed throughout its final insertion.
      for (const frame of route.poses.slice(3)) {
        expect(frame.elements[0]).toBeCloseTo(raw.to.elements[0], 6);
        expect(frame.elements[10]).toBeCloseTo(raw.to.elements[10], 6);
      }
    }
    expect(pin[0].poses[3].elements[0]).not.toBeCloseTo(raw.to.elements[0], 6);
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
    appear: 0, floor: at(-100), floorBox: body, ctx: 0, final: instance.world,
    moves: [{ ...raw, unit: i }],
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
