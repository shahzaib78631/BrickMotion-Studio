import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyMotionStyle, buildRetime, cleanStyle, forward, inverse, landingWarp } from '../../src/anim/motionStyle';
import { flightPose, poseAt, type Timeline } from '../../src/anim/timeline';
import { mergeSteps, modelSteps, setItemsMotion, setPlanMotion, setStepMotion, splitStepAt } from '../../src/plan/ops';
import { parsePlan } from '../../src/plan/schema';
import type { Plan, PlanItem } from '../../src/plan/types';
import { floorCentreOffset } from '../../src/state/editing';
import { motionResolver } from '../../src/state/timelineService';

const piece = (id: string): PlanItem => ({ id, part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 });
const plan = (): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 't',
  steps: [{ pieces: [piece('a'), piece('b'), piece('c')] }, { pieces: [piece('d')] }],
});

describe('landingWarp', () => {
  it('is the identity with no landing or hover set', () => {
    for (const u of [0, 0.2, 0.5, 0.9, 1]) expect(landingWarp(u, {}, 0.76)).toBe(u);
  });
  it('spends the chosen share of time seating, and holds during the hover', () => {
    const s = { landing: 0.5, hover: 0.1 };
    expect(landingWarp(0, s, 0.76)).toBe(0);
    expect(landingWarp(0.4, s, 0.76)).toBeCloseTo(0.76);
    expect(landingWarp(0.45, s, 0.76)).toBeCloseTo(0.76);
    expect(landingWarp(0.5, s, 0.76)).toBeCloseTo(0.76);
    expect(landingWarp(0.75, s, 0.76)).toBeCloseTo(0.88);
    expect(landingWarp(1, s, 0.76)).toBeCloseTo(1);
  });
  it('is monotone', () => {
    let prev = -1;
    for (let k = 0; k <= 100; k++) {
      const v = landingWarp(k / 100, { landing: 0.6, hover: 0.3 }, 0.8);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});

describe('buildRetime', () => {
  it('returns null when nothing changes speed', () => {
    expect(buildRetime([{ start: 0, dur: 1 }], () => 1)).toBeNull();
  });
  it('slows only while the slowed flight is in the air', () => {
    const r = buildRetime([{ start: 1, dur: 1 }, { start: 3, dur: 1 }], (i) => (i === 0 ? 2 : 1))!;
    expect(forward(r, 1)).toBe(1);
    expect(forward(r, 2)).toBe(3); // the 1 s flight now takes 2 s
    expect(forward(r, 3)).toBe(4); // the gap after it is unchanged
    expect(forward(r, 4)).toBe(5);
    expect(forward(r, 6)).toBe(7); // after the last flight the clock runs normally
    for (const t of [0, 1.5, 2.5, 3.7, 9]) expect(inverse(r, forward(r, t))).toBeCloseTo(t);
  });
  it('takes the slowest factor where flights overlap', () => {
    const r = buildRetime([{ start: 0, dur: 2 }, { start: 1, dur: 2 }], (i) => (i === 0 ? 3 : 1.5))!;
    expect(forward(r, 1)).toBe(3);
    expect(forward(r, 2)).toBe(6);
    expect(forward(r, 3)).toBeCloseTo(7.5);
  });
});

describe('applyMotionStyle', () => {
  const from = new THREE.Matrix4().makeTranslation(100, 0, 0);
  const to = new THREE.Matrix4();
  const tl = (): Timeline => ({
    duration: 5, steps: [{ model: '', index: 0, start: 1, end: 2 }], intro: 1, buildEnd: 4, heroOrbit: false,
    pacing: { mode: 'piece', intro: 1, outro: 1, build: 3, stepPause: 0, slot: 1, flight: 1, batchSize: 1 },
    units: [{ kind: 'piece', keys: ['a'], start: 1, dur: 1, step: 0 }],
    subBuilds: [], camKeys: [{ t: 2, box: { min: [0, 0, 0], max: [1, 1, 1] } }],
    buildBox: { min: [0, 0, 0], max: [1, 1, 1] }, modelBox: { min: [0, 0, 0], max: [1, 1, 1] }, sceneBox: { min: [0, 0, 0], max: [1, 1, 1] }, ground: 0,
    tracks: new Map([['a', { appear: 0, floor: from, floorBox: { min: [0, 0, 0], max: [1, 1, 1] }, ctx: 0, final: to,
      moves: [{ unit: 0, from, to, rel: null, skyY: -100, hold: 0, entry: [0, 0, 0] }] }]]),
  }) as unknown as Timeline;

  it('leaves the timeline alone without styles', () => {
    const t = tl();
    expect(applyMotionStyle(t, () => null)).toBe(t);
  });
  it('stretches a slowed flight and everything after it, sampling the same poses', () => {
    const t = tl();
    const out = applyMotionStyle(t, () => ({ time: 2 }));
    expect(out.units[0]).toMatchObject({ start: 1, dur: 2 });
    expect(out.duration).toBe(6);
    expect(out.camKeys[0].t).toBe(3);
    const planned = poseAt(t, 1.5)('a')!;
    const shown = poseAt(out, 2)('a')!;
    expect(shown.elements).toEqual(planned.elements);
  });
  it('shapes the seat without changing where the piece ends up', () => {
    const out = applyMotionStyle(tl(), () => ({ landing: 0.6, ease: 'gentle' }));
    const mv = out.tracks.get('a')!.moves[0];
    expect(mv.style).toEqual({ landing: 0.6, hover: undefined, ease: 'gentle' });
    const end = flightPose(mv, 0.999999, new THREE.Matrix4());
    expect(end.elements[12]).toBeCloseTo(0, 3);
    // with a longer landing, at 60 % of the flight it is still well above the seat
    const mid = flightPose(mv, 0.6, new THREE.Matrix4());
    expect(mid.elements[13]).toBeLessThan(-50);
  });
});

describe('motion overrides in the plan', () => {
  it('resolve piece over step over project', () => {
    let p = setPlanMotion(plan(), { time: 1.5, ease: 'gentle' });
    p = setStepMotion(p, '', 0, { landing: 0.5 });
    p = setItemsMotion(p, '', ['b'], { time: 3 });
    const style = motionResolver(p, '', p.motion);
    const unit = (key: string) => ({ kind: 'piece' as const, keys: [key], start: 0, dur: 1, step: 0 });
    expect(style(unit('a'))).toEqual({ time: 1.5, ease: 'gentle', landing: 0.5 });
    expect(style(unit('b'))).toEqual({ time: 3, ease: 'gentle', landing: 0.5 });
    expect(style(unit('d'))).toEqual({ time: 1.5, ease: 'gentle' });
  });
  it('clear back to nothing and survive a save', () => {
    let p = setItemsMotion(setStepMotion(plan(), '', 1, { hover: 0.2 }), '', ['a'], { ease: 'soft' });
    expect(parsePlan(JSON.parse(JSON.stringify(p)))).toBeTruthy();
    p = setItemsMotion(setStepMotion(p, '', 1, null), '', ['a'], null);
    expect(JSON.stringify(p)).toBe(JSON.stringify(plan()));
  });
  it('cleanStyle clamps values', () => {
    expect(cleanStyle({ time: 10, landing: 0, hover: -1 })).toEqual({ time: 4, landing: 0.1, hover: 0 });
    expect(cleanStyle({})).toBeNull();
  });
});

describe('splitStepAt', () => {
  it('makes the piece and those after it the next step', () => {
    const p = splitStepAt(plan(), '', 0, 1);
    expect(modelSteps(p, '').map((s) => s.pieces.map((i) => i.id))).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(modelSteps(mergeSteps(p, '', 0), '')[0].pieces.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
  it('does nothing at the first piece', () => {
    const p = plan();
    expect(splitStepAt(p, '', 0, 0)).toBe(p);
  });
});

describe('floorCentreOffset', () => {
  it('centres the footprint and drops the base to the floor', () => {
    // LDraw: y grows downwards, the base is max y
    expect(floorCentreOffset({ min: [40, -64, -20], max: [120, -16, 60] })).toEqual({ x: -4, y: -2, z: -1 });
    expect(floorCentreOffset({ min: [-20, -24, -20], max: [20, 0, 20] })).toBeNull();
  });
});
