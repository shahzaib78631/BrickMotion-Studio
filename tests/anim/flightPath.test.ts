import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bakeBuildFlights } from '../../src/anim/bakeBuild';
import { emptyAnimation, trackOf, valuesAt } from '../../src/anim/keyframes';
import { displayPivot, makeKeyframePose } from '../../src/anim/keyframePose';
import { addPathKey, deletePathKey, flightPath, locationFrames, pathHits, setPathKey, unbakeFlight } from '../../src/anim/flightPath';
import type { Move, Timeline, Track } from '../../src/anim/timeline';
import type { Instance } from '../../src/model/assemble';
import { importLDraw } from '../../src/io/ldrawImport';
import { ensureIds } from '../../src/plan/ids';
import { partDataInstalled } from '../diagnostics/loadRealModel';
import { loadRealPlan } from '../diagnostics/loadRealPlan';

const matrix = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
const instance = (key: string, x = 0): Instance => ({
  key, itemId: key, model: '', part: '3001', color: 4, grid: true, placeholder: false,
  world: matrix(x), worldBox: { min: [x, -24, 0], max: [x + 20, 0, 20] },
});
const move = (from: number, to: number): Move => ({
  unit: 0, from: matrix(from), to: matrix(to), rel: null, skyY: -80,
  hold: 0, entry: [0, 0, 0], translationPath: [[0, 0, 0], [to - from, 0, 0]],
});
const track = (x: number): Track => ({
  appear: 0.25, floor: matrix(x + 100), floorBox: { min: [x + 100, -24, 0], max: [x + 120, 0, 20] },
  ctx: 0, moves: [move(x + 100, x)], final: matrix(x),
});
function source(): Timeline {
  const keys = ['brick', 'other'];
  return { duration: 1, intro: 0, buildEnd: 1, ground: 0, tracks: new Map(keys.map((k, i) => [k, track(i * 100)])),
    units: [{ kind: 'piece', keys, start: 0.4, dur: 0.6, step: 0 }],
    sceneBox: { min: [0, -24, 0], max: [300, 0, 20] }, buildBox: { min: [0, -24, 0], max: [300, 0, 20] }, modelBox: { min: [0, -24, 0], max: [300, 0, 20] },
    steps: [], subBuilds: [], camKeys: [], pacing: {} as Timeline['pacing'], heroOrbit: false,
  };
}
const parts = [instance('brick'), instance('other', 100)];
const baked = () => bakeBuildFlights(emptyAnimation(), '', parts, new Map(), source(), { targets: ['brick'] }).animation;

describe('a baked flight path', () => {
  it('runs from where the piece appears to its seat, one point per location key', () => {
    const a = baked();
    const path = flightPath(a, '', parts[0], parts[0].world)!;
    expect(path.keys.length).toBeGreaterThanOrEqual(2);
    const pivot = displayPivot(parts[0], parts[0].world);
    // the last point is the seat (no offset); the first is out on the floor, 100 LDU (5 studs) away
    expect(path.keys.at(-1)!.at.distanceTo(pivot)).toBeLessThan(1e-3);
    expect(path.keys[0].at.x - pivot.x).toBeCloseTo(5, 2);
    // nothing is drawn before the piece appears
    expect(path.samples.every((s) => valuesAt(a, '', 'brick', s.frame).visibility === 1)).toBe(true);
    expect(path.samples[0].frame).toBe(path.keys[0].frame);
  });

  it('a new point keeps the shape; moving it bends the path; deleting it straightens it again', () => {
    const a = baked();
    const frames = locationFrames(a, '', 'brick');
    const mid = Math.round((frames[0] + frames.at(-1)!) / 2);
    const before = valuesAt(a, '', 'brick', mid);
    const added = addPathKey(a, '', 'brick', mid);
    expect(locationFrames(added, '', 'brick')).toContain(mid);
    expect(valuesAt(added, '', 'brick', mid)['location.x']).toBeCloseTo(before['location.x'], 3);
    const bent = setPathKey(added, '', 'brick', mid, [before['location.x'], 3, 0]);
    expect(valuesAt(bent, '', 'brick', mid)['location.y']).toBe(3);
    // the rest of the flight still ends on the seat
    expect(valuesAt(bent, '', 'brick', frames.at(-1)!)['location.y']).toBe(0);
    const removed = deletePathKey(bent, '', 'brick', mid);
    expect(locationFrames(removed, '', 'brick')).not.toContain(mid);
    // the start and the seat cannot be deleted
    const ends = locationFrames(a, '', 'brick');
    expect(deletePathKey(a, '', 'brick', ends.at(-1)!)).toBe(a);
  });

  it('back to planner removes only that piece\'s baked keys', () => {
    const a = baked();
    const back = unbakeFlight(a, '', 'brick');
    expect(trackOf(back, '', 'brick')).toBeUndefined();
    expect(back.buildLayers?.['']).toBeDefined();
    expect(unbakeFlight(back, '', 'brick')).toBe(back);
  });

  it.skipIf(!partDataInstalled())('marks the frames where the path goes through a built piece', async () => {
    // bend the flight down through `other`'s seat (it is already resting, at x 100)
    let a = bakeBuildFlights(emptyAnimation(), '', parts, new Map(), source(), { targets: ['brick'] }).animation;
    const frames = locationFrames(a, '', 'brick');
    const mid = Math.round((frames[0] + frames.at(-1)!) / 2);
    a = setPathKey(a, '', 'brick', mid, [5, 0, 0]);
    const { metrics } = await loadRealPlan(ensureIds(importLDraw('0 two\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n', 'x.ldr')));
    const bases = new Map(parts.map((p) => [p.key, p.world]));
    const pose = makeKeyframePose(parts, new Map(), a, '', source());
    // `other` is at its seat for the whole check (its flight is not part of this)
    const at = (f: number) => { const m = new Map(pose(f)); m.set('other', parts[1].world); return m; };
    const hits = pathHits(parts, at, bases, metrics, 'brick', [mid]);
    expect(hits.has(mid)).toBe(true);
    // the straight, unedited path does not pass through it at that frame
    const straight = makeKeyframePose(parts, new Map(), baked(), '', source());
    const clean = pathHits(parts, (f) => { const m = new Map(straight(f)); m.set('other', parts[1].world); return m; }, bases, metrics, 'brick', [frames.at(-1)!]);
    expect(clean.size).toBe(0);
  });
});
