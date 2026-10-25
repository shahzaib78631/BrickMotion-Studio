import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import { flightPose, type Move, type Timeline } from '../../src/anim/timeline';
import { encodeTimeline, decodeTimeline } from '../../src/anim/timelineCodec';
import { jointApproachIsCompatible, interpolateJointSegment } from '../../src/anim/motion/jointKinematics';
import { mechanicalApproaches } from '../../src/anim/motion/kinematicCandidates';

const at = (x: number, y = 0, z = 0) => new THREE.Matrix4().makeTranslation(x, y, z);
const move = (destination = at(40)): Move => ({ unit: 0, from: at(-100, -60), to: destination,
  rel: null, skyY: -120, hold: 0, entry: [0, 0, 0] });
const joint = (type: MechanicalJoint['type'], motion: MechanicalJoint['motion'],
  axis: [number, number, number] = [0, 1, 0], centre: [number, number, number] = [0, 0, 0]): MechanicalJoint => ({
  id: `${type}:${axis.join(',')}:${centre.join(',')}`, male: 'moving', female: 'host',
  type, motion, axis, centre, engagement: 12,
});
const point = (v: THREE.Vector3, matrix: THREE.Matrix4) => v.clone().applyMatrix4(matrix);
const same = (left: THREE.Matrix4, right: THREE.Matrix4, digits = 6) =>
  left.elements.forEach((v, i) => expect(v, `matrix element ${i}`).toBeCloseTo(right.elements[i], digits));

describe('Standard Motion v3 — real joint-space kinematics', () => {
  it('keeps a hinge anchor stationary between EVERY keyframe, not just at waypoints', () => {
    const dest = at(180);
    const base = move(dest);
    const connection = joint('hinge', 'revolute');
    const candidate = mechanicalApproaches(base, connection, 'moving')[0];
    expect(candidate.motion).toBe('hinge');
    expect(candidate.kinematicSegments?.length).toBe(4);
    const pivot = new THREE.Vector3(...connection.centre);
    const localPivot = point(pivot, dest.clone().invert());
    for (const segment of candidate.kinematicSegments!) {
      for (const fraction of [0, 0.17, 0.5, 0.83, 1]) {
        const interpolated = new THREE.Matrix4();
        expect(interpolateJointSegment(candidate.poses[segment.index], segment, fraction, interpolated)).toBe(true);
        expect(point(localPivot, interpolated).distanceTo(pivot)).toBeLessThan(1e-6);
        if (fraction === 1) same(interpolated, candidate.poses[segment.index + 1]);
      }
    }
    const flight = { ...base, posePath: candidate.poses, kinematicSegments: candidate.kinematicSegments };
    const properMiddle = flightPose(flight, 0.5, new THREE.Matrix4());
    const chordMiddle = flightPose({ ...flight, kinematicSegments: undefined }, 0.5, new THREE.Matrix4());
    expect(point(localPivot, properMiddle).distanceTo(pivot)).toBeLessThan(1e-6);
    expect(point(localPivot, chordMiddle).distanceTo(pivot)).toBeGreaterThan(0.25);
    same(flightPose(flight, 1, new THREE.Matrix4()), dest);
  });

  it('inserts keyed axles without screw rotation or perpendicular drift', () => {
    const dest = at(60, -15, 12).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 3));
    const base = move(dest);
    const connection = joint('axle-hole', 'fixed', [1, 0, 0]);
    const candidates = mechanicalApproaches(base, connection, 'moving');
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.kinematicSegments?.map(s => s.kind)).toEqual(['prismatic', 'prismatic']);
      for (const seg of candidate.kinematicSegments!) {
        const from = candidate.poses[seg.index];
        const interpolated = new THREE.Matrix4();
        expect(interpolateJointSegment(from, seg, 0.5, interpolated)).toBe(true);
        const position = new THREE.Vector3().setFromMatrixPosition(interpolated);
        const basePosition = new THREE.Vector3().setFromMatrixPosition(from);
        const offset = position.sub(basePosition);
        expect(offset.y).toBeCloseTo(0, 7);
        expect(offset.z).toBeCloseTo(0, 7);
        expect(offset.x).toBeCloseTo(seg.travel * 0.5, 7);
        for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10])
          expect(interpolated.elements[index]).toBeCloseTo(from.elements[index], 7);
        const completed = new THREE.Matrix4();
        interpolateJointSegment(from, seg, 1, completed);
        same(completed, candidate.poses[seg.index + 1]);
      }
      same(candidate.poses.at(-1)!, dest);
    }
  });

  it('rejects motion when already installed mates eliminate the proposed degree of freedom', () => {
    const hinge = joint('hinge', 'revolute');
    const secondCoaxial = { ...joint('hinge', 'revolute', [0, -1, 0], [0, 35, 0]), id: 'second hinge' };
    const skewHinge = { ...joint('hinge', 'revolute', [1, 0, 0]), id: 'skew hinge' };
    const stud = joint('stud-socket', 'fixed');
    expect(jointApproachIsCompatible(hinge, 'moving', [hinge])).toBe(true);
    expect(jointApproachIsCompatible(hinge, 'moving', [hinge, secondCoaxial])).toBe(true);
    expect(jointApproachIsCompatible(hinge, 'moving', [hinge, skewHinge])).toBe(false);
    expect(jointApproachIsCompatible(hinge, 'moving', [hinge, stud])).toBe(false);
    const slider = joint('axle-hole', 'fixed', [1, 0, 0]);
    const parallelStud = joint('stud-socket', 'fixed', [-1, 0, 0], [0, 0, 25]);
    const transverseStud = joint('stud-socket', 'fixed', [0, 1, 0]);
    expect(jointApproachIsCompatible(slider, 'moving', [slider, parallelStud])).toBe(true);
    expect(jointApproachIsCompatible(slider, 'moving', [slider, transverseStud])).toBe(false);
    const ball = joint('ball-socket', 'ball');
    const secondBall = { ...joint('ball-socket', 'ball', [0, 1, 0], [10, 0, 0]), id: 'separate ball' };
    expect(jointApproachIsCompatible(ball, 'moving', [ball, secondBall])).toBe(false);
  });

  it('round-trips constrained flight data through the worker codec without losing the arc', () => {
    const base = move(at(80));
    const candidate = mechanicalApproaches(base, joint('hinge', 'revolute'), 'moving')[0];
    const flight: Move = { ...base, posePath: candidate.poses, kinematicSegments: candidate.kinematicSegments };
    const tl = { units: [{ kind: 'piece', keys: ['moving'], step: 0, start: 0, dur: 1 }],
      tracks: new Map([['moving', { appear: -Infinity, floor: base.from, final: base.to, ctx: 0,
        floorBox: { min: [-1, -1, -1], max: [1, 1, 1] }, moves: [flight] }]]) } as unknown as Timeline;
    const encoded = encodeTimeline(tl);
    const decoded = decodeTimeline(encoded);
    const recovered = decoded.tracks.get('moving')!.moves[0];
    expect(recovered.kinematicSegments).toEqual(flight.kinematicSegments);
    for (const fraction of [0, .3, .47, .5, .52, .55, .7, 1])
      same(flightPose(recovered, fraction, new THREE.Matrix4()),
        flightPose(flight, fraction, new THREE.Matrix4()));
  });
});
