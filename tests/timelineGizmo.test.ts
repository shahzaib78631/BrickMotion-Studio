import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { assemble } from '../src/model/assemble';
import { buildTimeline } from '../src/anim/timeline';
import { aroundPivot, transformPlanItems } from '../src/plan/gizmo';
import { ensureIds } from '../src/plan/ids';
import { isGrid, type Plan } from '../src/plan/types';

const metrics = (id: string) => ({ id, body: { min: [0, -24, 0] as [number,number,number], max: [40, 0, 80] as [number,number,number] }, full: { min: [0, -24, 0] as [number,number,number], max: [40, 0, 80] as [number,number,number] }, footprint: { w: 2, d: 4 }, heightPlates: 3, placeholder: false });
const colors = new Map([[4, { code: 4, name: 'Red', hex: '#f00', edge: '#000', alpha: 255, finish: 'solid' as const }]]);
const makePlan = () => ensureIds({ format:'brickmotion-plan', version:1, name:'Timing test', steps: [
  { pieces: [{part:'3001', color:4, x:0,y:0,z:0,rot:0}] },
  { pieces: [{part:'3001', color:4, x:0,y:3,z:0,rot:0}] },
] } as Plan);

describe('dragging the timeline camera clip edges', () => {
  it('changes the intro, build, and hero durations in playback/export timeline', () => {
    const plan = makePlan(), asm = assemble(plan, metrics, colors);
    const manual = buildTimeline(asm, metrics, { targetSeconds:15, heroOrbit:true,
      introSeconds:2.5, buildSeconds:15, outroSeconds:4.7 });
    expect(manual.intro).toBeCloseTo(2.5);
    expect(manual.buildEnd).toBeGreaterThanOrEqual(17.49);
    expect(manual.duration - manual.buildEnd).toBeCloseTo(4.7);
    const clipped = buildTimeline(asm, metrics, { targetSeconds:15, heroOrbit:true,
      introSeconds:0.5, buildSeconds:5, outroSeconds:1 });
    expect(clipped.intro).toBeCloseTo(0.5);
    expect(clipped.duration - clipped.buildEnd).toBeCloseTo(1);
    const extended = buildTimeline(asm, metrics, { targetSeconds:15, heroOrbit:true,
      introSeconds:40, buildSeconds:5, outroSeconds:35 });
    expect(extended.intro).toBeCloseTo(40);
    expect(extended.duration - extended.buildEnd).toBeCloseTo(35);
  });
});

describe('Blender-style gizmo transforms', () => {
  it('snaps moves to studs and plates without changing unselected pieces', () => {
    const plan = makePlan(), asm = assemble(plan, metrics, colors);
    const moved = transformPlanItems(plan, '', [plan.steps[0].pieces[0].id!], asm.nodes,
      new THREE.Matrix4().makeTranslation(1,0.4,-1));
    const first = moved.steps[0].pieces[0];
    expect(isGrid(first)).toBe(true);
    if (isGrid(first)) expect([first.x,first.y,first.z,first.rot]).toEqual([1,1,1,0]);
    expect(moved.steps[1]).toBe(plan.steps[1]);
    expect(plan.steps[0].pieces[0]).toMatchObject({x:0,y:0,z:0});
  });

  it('keeps 90 degree rotations on-grid and stores non-standard scale as raw LDraw matrices', () => {
    const plan = makePlan(), asm = assemble(plan, metrics, colors);
    const ids = [plan.steps[0].pieces[0].id!], pivot = new THREE.Vector3(1,0,2);
    const rotated = transformPlanItems(plan,'',ids,asm.nodes,aroundPivot(new THREE.Matrix4().makeRotationY(Math.PI/2),pivot));
    expect(isGrid(rotated.steps[0].pieces[0])).toBe(true);
    const scaled = transformPlanItems(plan,'',ids,asm.nodes,aroundPivot(new THREE.Matrix4().makeScale(1.5,1,1),pivot));
    const piece = scaled.steps[0].pieces[0];
    expect(isGrid(piece)).toBe(false);
    if (!isGrid(piece)) expect(piece.matrix[0]).toBeCloseTo(1.5);
  });
});
