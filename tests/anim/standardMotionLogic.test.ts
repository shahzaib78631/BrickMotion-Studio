import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { assemble, type Assembly, type Metrics } from '../../src/model/assemble';
import { detectConnectionChains, logicalAssemblyProposals } from '../../src/anim/motion/logicalConnections';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import type { AssemblyHints, Plan, PieceItem, Raw } from '../../src/plan/types';
import { CHANNELS, emptyAnimation } from '../../src/anim/keyframes';
import { fillMotionKeyframes } from '../../src/anim/motion/autoBake';

const basis: Raw['matrix'] = [1,0,0,0,1,0,0,0,1];
const box = (x: number, y: number, z: number) => ({
  min: [-x / 2, -y / 2, -z / 2] as [number,number,number],
  max: [x / 2, y / 2, z / 2] as [number,number,number],
});
const body = new Map([
  ['3815c01.dat', box(22,8,12)],
  ['3816.dat', box(10,24,10)],
  ['3817.dat', box(10,24,10)],
  ['973.dat', box(20,20,12)],
  ['generic.dat', box(12,12,12)],
]);
const metrics: Metrics = (id) => {
  const b = body.get(id) ?? box(12,12,12);
  return { id, body: b, full: b, footprint: { w: 1,d: 1 }, heightPlates: 1, placeholder: false };
};
const part = (id: string, name: string, x: number, y: number,
  assembly?: AssemblyHints): PieceItem => ({ id, part: name, color: 4,
  matrix: [...basis], ldu: [x,y,0], assembly });
const root = (pieces: PieceItem[][]): Plan => ({ format: 'brickmotion-plan', version: 1,
  name: 'Logical connection order', steps: pieces.map(p => ({ pieces: p })) });
const options = { targetSeconds: 15, heroOrbit: false, planner: 'standard-motion' as const,
  mode: 'piece' as const, bottomUp: true };
const legs = (hints: Record<string, AssemblyHints> = {}) => [
  part('left','3816.dat',-7,10,hints.left),
  part('right','3817.dat',7,10,hints.right),
  part('hips','3815c01.dat',0,0,hints.hips),
];
const make = (parts: PieceItem[]) => assemble(root(parts.map(p => [p])), metrics, new Map());
const first = (asm: Assembly, key: string, engine: ReturnType<typeof buildTimeline>) => {
  const mv = engine.tracks.get(key)?.moves[0];
  expect(mv).toBeDefined();
  return engine.units[mv!.unit].start;
};
const same = (a: THREE.Matrix4 | null, b: THREE.Matrix4) => {
  expect(a).not.toBeNull();
  b.elements.forEach((n, i) => expect(a!.elements[i]).toBeCloseTo(n, 5));
};

describe('Standard Motion v3 — logical connection order', () => {
  it('recognises hips and two mating legs without the optional connector library', () => {
    const asm = make(legs());
    expect(detectConnectionChains(asm)).toEqual([
      { first: 'left', hub: 'hips', last: 'right', kind: 'anatomy' },
    ]);
    const proposed = logicalAssemblyProposals(asm);
    expect(proposed).toHaveLength(3);
    expect(proposed[0].guides.get('hips')).toBe('left');
    expect(proposed[0].guides.get('right')).toBe('hips');
    expect(proposed[1].guides.get('hips')).toBe('right');
    expect(proposed[1].guides.get('left')).toBe('hips');
    expect(proposed[2].guides.get('left')).toBe('hips');
    expect(proposed[2].guides.get('right')).toBe('hips');
    expect(proposed[0].sequences).toEqual([['left','hips','right']]);
    expect(proposed[1].sequences).toEqual([['right','hips','left']]);
    expect(proposed[2].sequences).toEqual([['hips','left','right']]);
    // The saved plan is never mutated or given synthetic root/after metadata.
    expect(asm.nodes.map(n => n.itemId)).toEqual(['left','right','hips']);
    expect(asm.nodes.every(n => !n.assembly?.after && !n.assembly?.root)).toBe(true);
  });

  it('does not install both legs before hips; preserves exact final positions and editable tracks', () => {
    const asm = make(legs()); // authored order left, right, hips: the reported failure
    const tl = buildTimeline(asm, metrics, options);
    expect(tl.motion?.logical?.chains).toBe(1);
    const l = first(asm, 'left', tl), r = first(asm, 'right', tl), h = first(asm, 'hips', tl);
    // The hips must NOT be brought in after both legs have closed the joint.
    // Either first leg → hips → second leg OR hips → both legs is acceptable.
    expect(h).toBeLessThan(Math.max(l,r));
    const hipUnit = tl.units[tl.tracks.get('hips')!.moves[0].unit];
    const earlier = l < r ? 'left' : 'right', later = l < r ? 'right' : 'left';
    const firstUnit = tl.units[tl.tracks.get(earlier)!.moves[0].unit];
    const lastUnit = tl.units[tl.tracks.get(later)!.moves[0].unit];
    if (h < Math.min(l,r)) {
      expect(hipUnit.start + hipUnit.dur).toBeLessThanOrEqual(firstUnit.start + 1e-3);
      expect(hipUnit.start + hipUnit.dur).toBeLessThanOrEqual(lastUnit.start + 1e-3);
    } else {
      expect(firstUnit.start + firstUnit.dur).toBeLessThanOrEqual(hipUnit.start + 1e-3);
      expect(hipUnit.start + hipUnit.dur).toBeLessThanOrEqual(lastUnit.start + 1e-3);
    }
    for (const inst of asm.instances) same(poseAt(tl, tl.duration)(inst.key), inst.world);
    const baked = fillMotionKeyframes(emptyAnimation(), '', asm.instances, new Map(), tl);
    expect(baked.count).toBe(3);
    for (const key of ['left', 'hips', 'right']) {
      const track = baked.animation.tracks.find(t => t.target === key)!;
      expect(track.source).toBe('baked-flight');
      for (const channel of CHANNELS) expect(track.channels[channel]?.length).toBeGreaterThan(0);
    }
  });

  it('lifts the hips and inserts them sideways instead of dropping through a leg', () => {
    const asm = make(legs());
    const tl = buildTimeline(asm, metrics, options);
    for (const key of ['hips', 'right']) {
      const mv = tl.tracks.get(key)!.moves[0];
      const unit = tl.units[mv.unit];
      expect(unit.motion, key).toBe('clearance-route');
      expect(mv.posePath?.length, key).toBeGreaterThan(4);
      const path = mv.posePath!;
      const final = path[path.length - 1];
      const approach = path[path.length - 3];
      // The piece reaches its final height at the open side, then slides
      // along the hip axis into the mating part — never a vertical drop
      // through the leg that is already installed.
      expect(approach.elements[13], key).toBeCloseTo(final.elements[13], 3);
      expect(approach.elements[14], key).toBeCloseTo(final.elements[14], 3);
      expect(Math.abs(approach.elements[12] - final.elements[12]), key).toBeGreaterThan(3);
    }
  });

  it('honours explicit author dependencies even if they require hips to be last', () => {
    const asm = make(legs({ hips: { after: ['left','right'] } }));
    expect(logicalAssemblyProposals(asm)).toHaveLength(0);
    const tl = buildTimeline(asm, metrics, options);
    expect(first(asm,'hips',tl)).toBeGreaterThan(first(asm,'left',tl));
    expect(first(asm,'hips',tl)).toBeGreaterThan(first(asm,'right',tl));
  });

  it('maintains scoped IDs inside a submodel and does not cross-wire a second figure', () => {
    const pieces = legs();
    const plan: Plan = root([[part('figure','generic.dat',0,0)]]);
    plan.steps = [{ pieces: [{ id: 'figure', submodel: 'figure-def', ldu: [0,0,0], matrix: basis }] }];
    plan.submodels = { 'figure-def': { steps: pieces.map(item => ({ pieces: [item] })) } };
    const asm = assemble(plan, metrics, new Map());
    const proposed = logicalAssemblyProposals(asm);
    expect(proposed[0].guides.get('figure/hips')).toBe('figure/left');
    expect(proposed[0].guides.get('figure/right')).toBe('figure/hips');
    expect(proposed[0].assembly.nodes[0].kind).toBe('sub');
    expect(asm.nodes[0].kind).toBe('sub');
    if (asm.nodes[0].kind === 'sub') expect(asm.nodes[0].children.every(n => !n.assembly?.after)).toBe(true);
  });

  it('supports two-sided typed connector hubs that are not minifig parts', () => {
    const parts = [part('left','generic.dat',-12,0), part('coupler','generic.dat',0,0), part('right','generic.dat',12,0)];
    const asm = make(parts);
    const joint = (male: string, female: string): MechanicalJoint => ({
      id: `${male}/${female}`, male, female, type: 'pin-hole', motion: 'sliding',
      axis: [1,0,0], centre: [0,0,0], engagement: 10,
    });
    const proposed = logicalAssemblyProposals(asm, [joint('left','coupler'), joint('coupler','right')]);
    expect(proposed[0].chains[0]).toEqual({ first: 'left', hub: 'coupler', last: 'right', kind: 'joint' });
    expect(proposed[0].guides.get('coupler')).toBe('left');
    expect(proposed[0].guides.get('right')).toBe('coupler');
  });

  it('uses connection order even when Standard falls back on a malformed unrelated parent', () => {
    const asm = make([...legs(), part('orphan','generic.dat',100,0, {attachTo:'not-a-sibling'})]);
    const tl = buildTimeline(asm, metrics, options);
    expect(tl.motion?.fallback).toContain('missing-parent');
    const l = first(asm, 'left', tl), r = first(asm, 'right', tl), h = first(asm, 'hips', tl);
    expect(h).toBeGreaterThan(Math.min(l,r));
    expect(h).toBeLessThan(Math.max(l,r));
    expect(tl.tracks.size).toBe(4);
    for (const inst of asm.instances) same(poseAt(tl, tl.duration)(inst.key), inst.world);
  });
});
