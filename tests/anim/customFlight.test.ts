import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bakeBuildFlights } from '../../src/anim/bakeBuild';
import { applyCustomFlights, flightFromKeys } from '../../src/anim/customFlight';
import { emptyAnimation, valuesAt } from '../../src/anim/keyframes';
import { displayPivot, FROM_VIEW } from '../../src/anim/keyframePose';
import { locationFrames, setPathKey } from '../../src/anim/flightPath';
import { applyAssemblySpotTransform, poseAt, type Move, type Timeline, type Track } from '../../src/anim/timeline';
import type { Instance } from '../../src/model/assemble';
import { flightsByKey, setPieceFlight } from '../../src/plan/pieceActions';
import { parsePlan } from '../../src/plan/schema';
import type { Plan } from '../../src/plan/types';

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
// a 4 second build so the flight has plenty of frames
function source(): Timeline {
  const keys = ['brick', 'other'];
  return { duration: 4, intro: 0, buildEnd: 4, ground: 0, tracks: new Map(keys.map((k, i) => [k, track(i * 100)])),
    units: [{ kind: 'piece', keys, start: 0.5, dur: 3, step: 0 }],
    sceneBox: { min: [0, -24, 0], max: [300, 0, 20] }, buildBox: { min: [0, -24, 0], max: [300, 0, 20] }, modelBox: { min: [0, -24, 0], max: [300, 0, 20] },
    steps: [], subBuilds: [], camKeys: [], pacing: {} as Timeline['pacing'], heroOrbit: false,
  };
}
const parts = [instance('brick'), instance('other', 100)];
const at = (tl: Timeline, t: number) => new THREE.Vector3().setFromMatrixPosition(poseAt(tl, t)('brick')!);

/** The source flight with its middle point lifted 3 studs up, handed back to the Build. */
function bent() {
  const tl = source();
  let a = bakeBuildFlights(emptyAnimation(), '', parts, new Map(), tl, { targets: ['brick'] }).animation;
  const frames = locationFrames(a, '', 'brick');
  const mid = Math.round((frames[0] + frames.at(-1)!) / 2);
  const x = valuesAt(a, '', 'brick', mid)['location.x'];
  a = setPathKey(a, '', 'brick', mid, [x, 3, 0]);
  const flight = flightFromKeys(a, '', parts[0], parts[0].world, tl)!;
  return { tl, a, flight, mid, x };
}

describe('an edited flight path played by the Build timeline', () => {
  it('starts where the piece waits, ends on its seat, and goes through the moved point', () => {
    const { tl, flight, x } = bent();
    expect(flight.length).toBeGreaterThanOrEqual(8);
    expect(flight.at(-1)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    const flown = applyCustomFlights(tl, new Map([['brick', flight]]));
    const unit = tl.units[0];
    expect(at(flown, unit.start).x).toBeCloseTo(100, 3);
    expect(at(flown, unit.start + unit.dur).distanceTo(new THREE.Vector3())).toBeLessThan(1e-6);
    // somewhere on the way it is 3 studs (60 LDU) up (-Y in LDraw), over the moved point
    let high = 0, xAtHigh = 0;
    for (let k = 0; k <= 200; k++) {
      const p = at(flown, unit.start + (unit.dur * k) / 200);
      if (-p.y > high) { high = -p.y; xAtHigh = p.x; }
    }
    expect(high).toBeGreaterThan(55);
    expect(high).toBeLessThan(61);
    const pivot = displayPivot(parts[0], parts[0].world).applyMatrix4(FROM_VIEW);
    expect(xAtHigh + pivot.x).toBeCloseTo(pivot.x + x * 20, -1);
    // the other piece keeps the planner's route
    expect(flown.tracks.get('other')).toBe(tl.tracks.get('other'));
  });

  it('eases: slow away from the start and into the seat, fastest in the middle', () => {
    const { tl, flight } = bent();
    const flown = applyCustomFlights(tl, new Map([['brick', flight]]));
    const u = tl.units[0], dt = u.dur / 40;
    const speed = (t: number) => at(flown, t + dt).distanceTo(at(flown, t));
    expect(speed(u.start)).toBeLessThan(speed(u.start + u.dur / 2 - dt / 2));
    expect(speed(u.start + u.dur - dt)).toBeLessThan(speed(u.start + u.dur / 2 - dt / 2));
  });

  it('a piece dragged on the floor afterwards starts from its new spot and keeps the end of the path', () => {
    const { tl, flight } = bent();
    const moved = source();
    const tr = moved.tracks.get('brick')!;
    moved.tracks.set('brick', { ...tr, moves: [{ ...tr.moves[0], from: matrix(140) }] });
    const flown = applyCustomFlights(moved, new Map([['brick', flight]]));
    const u = tl.units[0];
    expect(at(flown, u.start).x).toBeCloseTo(140, 3);
    const late = u.start + u.dur * 0.9;
    expect(at(flown, late).distanceTo(at(applyCustomFlights(tl, new Map([['brick', flight]])), late))).toBeLessThan(1e-6);
  });

  it('turns with the model when the main spot turns it', () => {
    const { tl, flight } = bent();
    const spot = { x: 3, z: -2, angle: 90 };
    const a = applyCustomFlights(applyAssemblySpotTransform(tl, spot), new Map([['brick', flight]]));
    const b = applyAssemblySpotTransform(applyCustomFlights(tl, new Map([['brick', flight]])), spot);
    const u = tl.units[0];
    for (const f of [0.2, 0.5, 0.8]) expect(at(a, u.start + u.dur * f).distanceTo(at(b, u.start + u.dur * f))).toBeLessThan(1e-3);
  });

  it('is saved on the piece and survives a project round trip', () => {
    const { flight } = bent();
    const plan: Plan = { format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [{ id: 'brick', part: '3001.dat', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }] } as unknown as Plan;
    const withFlight = setPieceFlight(plan, '', 'brick', flight)!;
    expect(flightsByKey(withFlight, '').get('brick')).toEqual(flight);
    const parsed = parsePlan(JSON.parse(JSON.stringify(withFlight)));
    expect(parsed.ok && flightsByKey(parsed.plan, '').get('brick')).toEqual(flight);
    const cleared = setPieceFlight(withFlight, '', 'brick', null)!;
    expect(flightsByKey(cleared, '').size).toBe(0);
    expect(cleared.steps[0].pieces[0].assembly).toBeUndefined();
  });
});
