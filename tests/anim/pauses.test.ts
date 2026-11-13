import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPauses, normalizePauses, shownTime } from '../../src/anim/pauses';
import { applyMotionStyle } from '../../src/anim/motionStyle';
import { poseAt, type Timeline } from '../../src/anim/timeline';
import { addPause, removePause, setPauseLength } from '../../src/plan/pauseOps';
import { parsePlan } from '../../src/plan/schema';
import type { Plan } from '../../src/plan/types';

const from = new THREE.Matrix4().makeTranslation(100, 0, 0);
const to = new THREE.Matrix4();
const tl = (): Timeline => ({
  duration: 5, steps: [{ model: '', index: 0, start: 1, end: 3 }], intro: 1, buildEnd: 4, heroOrbit: false,
  pacing: { mode: 'piece', intro: 1, outro: 1, build: 3, stepPause: 0, slot: 1, flight: 1, batchSize: 1 },
  units: [{ kind: 'piece', keys: ['a'], start: 1, dur: 2, step: 0 }, { kind: 'piece', keys: ['b'], start: 3, dur: 1, step: 0 }],
  subBuilds: [], camKeys: [{ t: 3, box: { min: [0, 0, 0], max: [1, 1, 1] } }],
  buildBox: { min: [0, 0, 0], max: [1, 1, 1] }, modelBox: { min: [0, 0, 0], max: [1, 1, 1] }, sceneBox: { min: [0, 0, 0], max: [1, 1, 1] }, ground: 0,
  tracks: new Map(['a', 'b'].map((k, i) => [k, { appear: 0, floor: from, floorBox: { min: [0, 0, 0], max: [1, 1, 1] }, ctx: 0, final: to,
    moves: [{ unit: i, from, to, rel: null, skyY: -100, hold: 0, entry: [0, 0, 0] }] }])),
}) as unknown as Timeline;
const x = (t: Timeline, at: number, key = 'a') => poseAt(t, at)(key)!.elements[12];

describe('pause blocks', () => {
  it('tidies overlapping and empty blocks', () => {
    expect(normalizePauses([{ id: 'b', at: 2, len: 2 }, { id: 'a', at: 1, len: 2 }, { id: 'z', at: 9, len: 0 }]))
      .toEqual([{ id: 'a', at: 1, len: 2 }, { id: 'b', at: 3, len: 2 }]);
  });
  it('maps un-paused time to the finished video', () => {
    const ps = [{ id: 'a', at: 2, len: 1 }];
    expect(shownTime(ps, 1, true)).toBe(1);
    expect(shownTime(ps, 2, false)).toBe(2); // a flight ending here ends before the pause
    expect(shownTime(ps, 2, true)).toBe(3); // one starting here starts after it
    expect(shownTime(ps, 4, true)).toBe(5);
  });
  it('freezes a flight in mid-air and carries on from the same pose', () => {
    const t = tl();
    const out = applyPauses(t, [{ id: 'p', at: 2, len: 1.5 }]); // the flight 1..3 is half way at 2
    expect(out.duration).toBe(6.5);
    const half = x(t, 2);
    expect(half).not.toBe(0);
    expect(x(out, 2)).toBeCloseTo(half);
    expect(x(out, 2.75)).toBeCloseTo(half); // still frozen
    expect(x(out, 3.5)).toBeCloseTo(half);
    expect(x(out, 4.5)).toBeCloseTo(x(t, 3)); // landed 1 s after it carried on
    expect(out.units[1].start).toBe(4.5);
    expect(out.camKeys[0].t).toBe(4.5);
    expect(out.units[0].dur).toBe(3.5);
  });
  it('composes with a flight-time change', () => {
    const styled = applyMotionStyle(tl(), () => ({ time: 2 }));
    const out = applyPauses(styled, [{ id: 'p', at: 3, len: 1 }]); // the stretched flight 1..5, paused half way
    const half = x(poseAt(styled, 3) ? styled : styled, 3);
    expect(x(out, 3.5)).toBeCloseTo(half);
    expect(x(out, 4)).toBeCloseTo(half);
    expect(x(out, 6)).toBeCloseTo(x(styled, 5));
  });
  it('does not touch a timeline without pauses', () => {
    const t = tl();
    expect(applyPauses(t, [])).toBe(t);
  });
});

describe('pause edits', () => {
  const plan = (): Plan => ({
    format: 'brickmotion-plan', version: 1, name: 't', steps: [],
    cameraTracks: { '': { build: { shutter: 0.5, transitions: [], keys: [
      { id: 'k1', t: 1, origin: 'user' }, { id: 'k2', t: 4, origin: 'user' },
    ] as never } } },
  });
  it('adds, lengthens and removes a pause, moving later camera keys with it', () => {
    const a = addPause(plan(), '', 2, 1).plan;
    expect(a.pauses?.['']).toMatchObject([{ at: 2, len: 1 }]);
    expect(a.cameraTracks!['']!.build!.keys.map((k) => k.t)).toEqual([1, 5]);
    const id = a.pauses![''][0].id;
    const b = setPauseLength(a, '', id, 3);
    expect(b.cameraTracks!['']!.build!.keys.map((k) => k.t)).toEqual([1, 7]);
    const c = removePause(b, '', id);
    expect(c.pauses).toBeUndefined();
    expect(c.cameraTracks!['']!.build!.keys.map((k) => k.t)).toEqual([1, 4]);
  });
  it('keeps a pause out of another and shifts later ones', () => {
    const a = addPause(plan(), '', 5, 1).plan;
    const b = addPause(a, '', 2, 2).plan;
    expect(b.pauses![''].map((p) => [p.at, p.len])).toEqual([[2, 2], [7, 1]]);
    const inside = addPause(b, '', 3, 1).plan;
    expect(inside.pauses![''].map((p) => [p.at, p.len])).toEqual([[2, 2], [4, 1], [8, 1]]);
  });
  it('survives a save and load', () => {
    const p = addPause({ ...plan(), cameraTracks: undefined }, '', 2, 1).plan;
    const r = parsePlan(JSON.parse(JSON.stringify(p)));
    expect(r.ok && r.plan.pauses).toEqual(p.pauses);
  });
});
