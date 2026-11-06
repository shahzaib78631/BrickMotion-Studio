import { describe, expect, it } from 'vitest';
import { bricknetJointSnaps, bricknetStem, hingeAxis, withBricknetJoints } from '../../src/data/bricknetJoints';
import { bricknetConnectors } from '../../src/data/bricknetConnectors.generated';
import { analyseSelection, detectEditorJoints, type SmartPart } from '../../src/plan/smartJoints';
import type { Snap } from '../../src/ldraw/shadow';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Vec3 } from '../../src/ldraw/parse';
import { realMetrics, realPartsReady as ready } from '../helpers/realParts';

type V = [number, number, number];
const box = { min: [-60, -60, -60] as V, max: [60, 60, 60] as V };
/** Column-major 4x4 from an LDraw line's x y z a b c d e f g h i. */
const ldraw = (x: number, y: number, z: number, m: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]) =>
  [m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, x, y, z, 1];
const piece = (id: string, part: string, world: number[]): SmartPart => ({ id, part, world, worldBox: box });
/** Parts with the given LDCad snaps only (none by default), as the app's metricsOf. */
const metricsWith = (snaps: Record<string, Snap[]> = {}) => (part: string) =>
  ({ id: part, body: box, full: box, snaps: snaps[part] ?? [] } as unknown as PartMetrics);
const near = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, k) => Math.abs(v - b[k]) < eps);

describe('BrickNet fallback joint connectors', () => {
  it('reads the hinge axis as the frame -Y after pitch about x and roll about z', () => {
    expect(near(hingeAxis(0, 0), [0, -1, 0])).toBe(true);
    expect(near(hingeAxis(0, 90), [1, 0, 0])).toBe(true);
    expect(near(hingeAxis(90, 0), [0, 0, -1])).toBe(true);
    expect(near(hingeAxis(-180, 0), [0, 1, 0])).toBe(true);
  });

  it('maps part ids to BrickNet stems through aliases and print suffixes', () => {
    expect(bricknetStem('973.dat')).toBe('973');
    expect(bricknetStem('973p11')).toBe('973'); // BrickNet alias
    expect(bricknetStem('parts/3818pzz9.dat')).toBe('3818'); // unknown print -> plain arm
    expect(bricknetStem('3818px1')).toBe('3818px1'); // BrickNet lists this print itself
    expect(bricknetStem('3001')).toBeNull(); // no hinge or ball: not listed
  });

  it('turns rows into hinge fingers and balls, BrickNet "in" male and "on" female', () => {
    const arm = bricknetJointSnaps('3818', []);
    expect(arm.every((s) => s.kind === 'fgr' && s.source === 'bricknet')).toBe(true);
    const shoulder = arm.find((s) => s.group === 'bricknet-hinge0')!;
    expect(shoulder.gender).toBe('M');
    expect(near(shoulder.axis, [1, 0, 0])).toBe(true);
    // centred on the BrickNet point, [1, 0, 0] for 3818
    expect(near(shoulder.start.map((v, k) => v + shoulder.axis[k] * shoulder.length / 2), [1, 0, 0])).toBe(true);
    const balls = bricknetJointSnaps('2908', []);
    expect(balls).toHaveLength(4);
    expect(balls.every((s) => s.kind === 'gen' && s.gender === 'M' && s.shapes[0] === 'GEN:sph' && s.placement === 'free' && s.radius === 8)).toBe(true);
    expect(bricknetJointSnaps('23922', [])[0].gender).toBe('F');
  });

  it('is only a fallback: a part with its own LDCad finger or ball gets none of that family', () => {
    const finger: Snap = { kind: 'fgr', gender: 'M', start: [0, 0, 0], axis: [1, 0, 0], length: 10, radius: 4, shapes: ['FGR'], slide: false };
    const ball: Snap = { kind: 'gen', gender: 'M', start: [0, 0, 0], axis: [0, -1, 0], length: 0, radius: 8, shapes: ['GEN:sph'], slide: false, placement: 'free' };
    expect(bricknetJointSnaps('3818', [finger])).toEqual([]);
    expect(bricknetJointSnaps('2908', [ball])).toEqual([]);
    expect(withBricknetJoints('3001', undefined)).toBeUndefined();
    // rows: family, type, on, x, y, z (+ pitch, roll for hinges)
    for (const rows of Object.values(bricknetConnectors))
      for (const r of rows) expect(r.length).toBe(r[0] === 'hinge' ? 8 : 6);
  });

  it('gives two snap-less parts a ball joint about the BrickNet centre', () => {
    // 23922's socket (on) at [0,-28,20] put on 2908's ball (in) at [40,0,0]
    const parts = [piece('plate', '2908', ldraw(0, 0, 0)), piece('arm', '23922', ldraw(40, 28, -20))];
    const joints = detectEditorJoints(parts, metricsWith());
    expect(joints).toHaveLength(1);
    expect(joints[0].kind).toBe('ball');
    expect(joints[0].evidence).toBe('bricknet-catalogue');
    const guide = analyseSelection(parts, ['arm'], metricsWith());
    expect(guide.kind).toBe('ball');
    expect(guide.unknownParts).toBe(0);
  });

  it('gives a torso and arm without LDCad snaps a hinge about the shoulder axis', () => {
    // 10156-1.mpd: torso at y -72, left arm 3819 at (15.5, -64, 0)
    const parts = [piece('torso', '973', ldraw(0, -72, 0)), piece('arm', '3819', ldraw(15.5, -64, 0, [1, 0.17, 0, -0.17, 1, 0, 0, 0, 1]))];
    const guide = analyseSelection(parts, ['arm'], metricsWith());
    expect(guide.kind).toBe('revolute');
    expect(guide.interfaces[0].evidence).toBe('bricknet-catalogue');
    expect(Math.abs(guide.axis![0])).toBeGreaterThan(0.98);
    expect(Math.abs(guide.axis![1])).toBeCloseTo(0.17, 1);
  });

  const stud = (start: V): Snap => ({ kind: 'cyl', gender: 'M', start, axis: [0, -1, 0], length: 4, radius: 6, shapes: ['R'], slide: false });
  const socket = (start: V): Snap => ({ kind: 'cyl', gender: 'F', start, axis: [0, -1, 0], length: 4, radius: 6, shapes: ['R'], slide: false });
  const ballPair = () => [piece('plate', '2908', ldraw(0, 0, 0)), piece('arm', '23922', ldraw(40, 28, -20))];

  it('keeps LDCad primary per pair: a moving LDCad mate wins over BrickNet', () => {
    const pin = (gender: 'M' | 'F', start: V): Snap => ({ kind: 'cyl', gender, start, axis: [0, -1, 0], length: 10, radius: 4, shapes: ['R'], slide: false });
    const joints = detectEditorJoints(ballPair(), metricsWith({ '2908': [pin('M', [60, 0, 0])], '23922': [pin('F', [20, -28, 20])] }));
    expect(joints).toHaveLength(1);
    expect(joints[0].kind).toBe('revolute');
    expect(joints[0].evidence).toBe('ldcad-shadow');
  });

  it('a BrickNet joint replaces only the LDCad "fixed" mate at its own pivot', () => {
    // a stud-sized LDCad peg exactly at the ball: BrickNet says that joint turns
    const here = detectEditorJoints(ballPair(), metricsWith({ '2908': [stud([40, 0, 0])], '23922': [socket([0, -28, 20])] }));
    expect(here).toHaveLength(1);
    expect(here[0].kind).toBe('ball');
    // a stud elsewhere on the same pair still holds it rigid
    const elsewhere = analyseSelection(ballPair(), ['arm'], metricsWith({ '2908': [stud([60, 0, 0])], '23922': [socket([20, -28, 20])] }));
    expect(elsewhere.kind).toBe('locked');
  });
});

describe.skipIf(!ready)('BrickNet fallback joints on real LDraw parts', () => {
  const torso = ldraw(0, -72, 0);
  const leftArm = ldraw(15.5, -64, 0, [1, 0.17, 0, -0.17, 1, 0, 0, 0, 1]);

  it('a minifig arm hinges on the torso: the stud-sized LDCad shoulder peg alone read as fixed', async () => {
    for (const arm of ['3819', '3819px1']) {
      const metrics = await realMetrics(['973', arm]);
      expect(metrics(arm).snaps?.some((s) => s.kind === 'fgr')).toBeFalsy();
      const parts = [piece('t', '973', torso), piece('a', arm, leftArm)];
      // without BrickNet the only mate is the shoulder peg, classed fixed
      const ldcadOnly = detectEditorJoints(parts, metrics).length;
      expect(ldcadOnly).toBe(1);
      const guide = analyseSelection(parts, ['a'], metrics);
      expect(guide.kind).toBe('revolute');
      expect(guide.interfaces[0].evidence).toBe('bricknet-catalogue');
      expect(Math.abs(guide.axis![0])).toBeGreaterThan(0.98);
      const pivot = guide.pivot as Vec3;
      expect(Math.hypot(pivot[0] - 15, pivot[1] + 63, pivot[2])).toBeLessThan(3);
    }
  });

  it('the 10156-1 minifig: hand on LDCad wrist pin, arm plus hand hinge at the shoulder', async () => {
    // poses from tests/fixtures/models/10156-1.mpd (printed torso 973p1u)
    const metrics = await realMetrics(['973p1u', '3819', '3820']);
    const parts = [
      piece('torso', '973p1u', torso),
      piece('arm', '3819', leftArm),
      piece('hand', '3820', ldraw(23.658, -46.149, -10, [1, 0.12, -0.12, -0.17, 0.697, -0.697, 0, 0.707, 0.707])),
    ];
    const wrist = analyseSelection(parts, ['hand'], metrics);
    expect(wrist.kind).toBe('revolute');
    expect(wrist.interfaces.every((j) => j.evidence === 'ldcad-shadow')).toBe(true);
    const shoulder = analyseSelection(parts, ['arm', 'hand'], metrics);
    expect(shoulder.kind).toBe('revolute');
    expect(shoulder.interfaces.map((j) => j.evidence)).toEqual(['bricknet-catalogue']);
  });

  it('BrickNet balls mate LDCad balls of the same size (23922 socket on 3731 ball)', async () => {
    // 3731's LDCad ball is at [0,4,-40]; 23922's BrickNet socket is at [0,-28,20]
    const metrics = await realMetrics(['3731', '23922']);
    const parts = [piece('brick', '3731', ldraw(0, 0, 0)), piece('arm', '23922', ldraw(0, 32, -60))];
    const guide = analyseSelection(parts, ['arm'], metrics);
    expect(guide.kind).toBe('ball');
    expect(guide.interfaces[0].evidence).toBe('bricknet-catalogue');
  });
});
