import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Metrics } from '../../src/model/assemble';
import { assemble } from '../../src/model/assemble';
import type { PieceItem, Plan, Raw } from '../../src/plan/types';
import { buildTimeline, flightPose, poseAt } from '../../src/anim/timeline';
import { encodeTimeline, decodeTimeline } from '../../src/anim/timelineCodec';

// A connector-derived hinge is injected so joint integration is tested even
// without the user's optional Shadow Library connector metadata installed.
vi.mock('../../src/anim/construction/mechanicalConstraintGraph', () => ({
  buildMechanicalConstraintGraph: () => ({
    joints: [{ id: 'hinge:child:base', male: 'child', female: 'base', type: 'hinge',
      axis: [0, 1, 0], centre: [10, 0, 0], engagement: 6, motion: 'revolute' }],
    connections: [], pairsExamined: 1, matesByPair: new Map(), snapsByPart: new Map(),
  }),
}));

const identity: Raw['matrix'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const metrics: Metrics = (id) => ({ id,
  body: { min: [-5, -10, -5], max: [5, 0, 5] },
  full: { min: [-5, -10, -5], max: [5, 0, 5] },
  footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false,
});
const brick = (id: string, x: number): PieceItem => ({
  id, part: 'custom', color: 4, ldu: [x, 0, 0], matrix: [...identity],
  ...(id === 'child' ? { assembly: { attachTo: 'base' } } : {}),
});

describe('Standard Motion — mechanical hints', () => {
  it('uses a world-pivot hinge swing before seating and preserves the exact completed model', () => {
    const plan: Plan = { format: 'brickmotion-plan', version: 1, name: 'hinge',
      steps: [{ pieces: [brick('base', 0)] }, { pieces: [brick('child', 24)] }] };
    const asm = assemble(plan, metrics, new Map());
    const tl = buildTimeline(asm, metrics, { targetSeconds: 15, heroOrbit: false,
      mode: 'piece', planner: 'standard-motion' });
    expect(tl.motion?.articulated).toBe(1);
    const moved = tl.tracks.get('child')!.moves[0];
    expect(moved.posePath?.length).toBeGreaterThan(4);
    const u = tl.units[moved.unit];
    expect(u.motion).toBe('hinge');
    expect(u.uncertified).toBe(true);
    expect(tl.motion?.kinematics?.pivotArcs).toBe(1);
    expect(moved.kinematicSegments?.length).toBe(4);
    // The connector pivot is the SAME world point in the middle of the
    // swing, not just at the deliberately authored waypoint matrices.
    const pivot = new THREE.Vector3(10, 0, 0);
    const pivotInPiece = pivot.clone().applyMatrix4(moved.to.clone().invert());
    const sample = flightPose(moved, 0.5, new THREE.Matrix4());
    expect(pivotInPiece.clone().applyMatrix4(sample).distanceTo(pivot)).toBeLessThan(1e-5);
    const restored = decodeTimeline(encodeTimeline(tl)).tracks.get('child')!.moves[0];
    expect(restored.kinematicSegments).toEqual(moved.kinematicSegments);
    const encodedMidpoint = flightPose(restored, .5, new THREE.Matrix4());
    sample.elements.forEach((value, i) => expect(value).toBeCloseTo(encodedMidpoint.elements[i], 7));
    const opened = moved.posePath![3];
    expect(opened.elements[12]).not.toBeCloseTo(moved.to.elements[12]);
    const final = poseAt(tl, tl.duration)('child')!;
    const authored = asm.instances.find((i) => i.key === 'child')!.world;
    final.elements.forEach((value, i) => expect(value).toBeCloseTo(authored.elements[i], 5));
    expect(new THREE.Matrix4().copy(opened).equals(authored)).toBe(false);
  });
});
