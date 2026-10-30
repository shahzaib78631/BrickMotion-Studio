/** Axles and pins turning in round holes (benchmark 5590 finding #1). */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { placeSnap, type CylSnapDef } from '../../src/ldraw/shadow';
import { buildMechanicalConstraintGraph, cylinderCanRotate, type MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import { buildMotionMechanismGraph } from '../../src/anim/motion/v4/mechanismGraph';
import { modelFromNodes } from '../../src/anim/construction/input';
import type { ANode } from '../../src/model/assemblyTypes';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Assembly } from '../../src/model/assemble';
import type { V3 } from '../../src/anim/construction/math';

const M = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
const def = (gender: 'M' | 'F', shape: string, length: number, offset: V3 = [0, 0, 0]): CylSnapDef =>
  ({ kind: 'cyl', gender, caps: 'one', slide: true, center: false, secs: [{ shape, radius: 6, length }], frames: [{ m: [...M], pos: offset }] });
const CV = [[-12,-12,-12],[12,-12,-12],[12,12,-12],[-12,12,-12],[-12,-12,12],[12,-12,12],[12,12,12],[-12,12,12]];
const CUBE = new Float32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5].flatMap(i => CV[i]));
const B = { min: [-12, -12, -12] as V3, max: [12, 12, 12] as V3 };
const node = (id: string): ANode => ({ kind: 'piece', itemId: id, model: 'demo', step: 0, order: 0, part: id, color: 16, grid: false, placeholder: false, body: B, local: { pos: [0, 0, 0], m: [...M] } });

describe('cylinder connectors that can turn', () => {
  it('lets a connection turn unless both sides are non-round', () => {
    expect(cylinderCanRotate(['A'], ['R', 'R', 'R'])).toBe(true);   // axle in a Technic brick hole
    expect(cylinderCanRotate(['L', '_', 'R', 'R', 'A'], ['R'])).toBe(true); // axle pin in a round hole
    expect(cylinderCanRotate(['R', '_', 'L'], ['R', '_', 'L'])).toBe(true); // turntable ring
    expect(cylinderCanRotate(['A'], ['A'])).toBe(false);             // axle in a gear / bush
    expect(cylinderCanRotate(['A'], ['R', 'A'])).toBe(false);        // axle in a bevel gear hub
    expect(cylinderCanRotate(['S'], ['S'])).toBe(false);
  });

  it('marks an axle in a round hole as able to turn, and an axle in a cross hole as locked', () => {
    const axle = placeSnap(def('M', 'A', 20, [0, 10, 0]), [...M], [0, 0, 0])[0];
    const round = placeSnap(def('F', 'R', 8), [...M], [0, 0, 0])[0];
    const cross = placeSnap(def('F', 'A', 8), [...M], [0, 0, 0])[0];
    const run = (hole: typeof round) => {
      const metric = (id: string): PartMetrics => ({ id, body: B, full: B, footprint: { w: 1, d: 1 }, heightPlates: 3, mesh: CUBE, placeholder: false, snaps: id === 'axle' ? [axle] : [hole] });
      return buildMechanicalConstraintGraph(modelFromNodes([node('axle'), node('hole')], metric)).joints;
    };
    const turning = run(round), locked = run(cross);
    expect(turning.length).toBeGreaterThan(0);
    expect(turning.every(j => j.rotates)).toBe(true);
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.some(j => j.rotates)).toBe(false);
  });
});

describe('motion graph from turning connectors', () => {
  const asm = { instances: ['a', 'b', 'c'].map(key => ({ key, part: 'x', world: new THREE.Matrix4(), worldBox: B })) } as unknown as Assembly;
  const hint = (male: string, female: string, centre: V3, extra: Partial<MechanicalJoint> = {}): MechanicalJoint =>
    ({ id: `${male}:${female}:${centre.join(',')}`, male, female, type: 'axle-hole', axis: [0, 1, 0], centre, engagement: 8, motion: 'sliding', rotates: true, ...extra });
  const cluster = (g: ReturnType<typeof buildMotionMechanismGraph>, id: string) => g.rigidClusters.find(c => c.includes(id))!;

  it('turns a single round-hole connector into a revolute joint', () => {
    const g = buildMotionMechanismGraph(asm, [hint('a', 'b', [0, 0, 0])]);
    expect(g.edges[0].motion).toBe('revolute');
    expect(cluster(g, 'a')).not.toContain('b');
  });
  it('keeps two coaxial connectors on one part pair turning', () => {
    const g = buildMotionMechanismGraph(asm, [hint('a', 'b', [0, 0, 0]), hint('a', 'b', [0, 20, 0])]);
    expect(g.edges.every(e => e.motion === 'revolute')).toBe(true);
  });
  it('makes a pair rigid when it is held on two separate axes', () => {
    const g = buildMotionMechanismGraph(asm, [hint('a', 'b', [0, 0, 0]), hint('a', 'b', [20, 0, 0])]);
    expect(cluster(g, 'a')).toContain('b');
    expect(g.edges.every(e => e.motion === 'fixed')).toBe(true);
  });
  it('makes a pair rigid when it also has a fixed connection', () => {
    const g = buildMotionMechanismGraph(asm, [hint('a', 'b', [0, 0, 0]), hint('a', 'b', [5, 0, 0], { type: 'stud-socket', motion: 'fixed', rotates: false })]);
    expect(cluster(g, 'a')).toContain('b');
  });
  it('holds an axle in a cross hole axially (friction fit): no joint', () => {
    const g = buildMotionMechanismGraph(asm, [hint('a', 'b', [0, 0, 0], { rotates: false })]);
    expect(g.edges[0].motion).toBe('fixed');
  });
  it('keeps a ball joint', () => {
    const g = buildMotionMechanismGraph(asm, [hint('a', 'b', [0, 0, 0], { type: 'ball-socket', motion: 'ball', rotates: false })]);
    expect(g.edges[0].motion).toBe('ball');
  });
  it('welds a pinned triangle into one body (a locked loop)', () => {
    const pinZ = (m: string, f: string, c: V3) => hint(m, f, c, { axis: [0, 0, 1], type: 'pin-hole' });
    const g = buildMotionMechanismGraph(asm, [pinZ('a', 'b', [0, 0, 0]), pinZ('b', 'c', [40, 60, 0]), pinZ('c', 'a', [80, 0, 0])]);
    expect(cluster(g, 'a')).toEqual(['a', 'b', 'c']);
    expect(g.edges.every(e => e.motion === 'fixed')).toBe(true);
  });
});
