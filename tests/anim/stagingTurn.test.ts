import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyStagingTurn, poseAt, type Move, type Timeline, type Track } from '../../src/anim/timeline';
import { setStagingTurn, stagingTurnOf } from '../../src/plan/pieceActions';
import { parsePlan } from '../../src/plan/schema';
import type { Plan } from '../../src/plan/types';

const at = (x: number, z = 0) => new THREE.Matrix4().makeTranslation(x, 0, z);
const pos = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
/** A piece waiting 200 LDU in front (+X) of a model centred on x = 20, z = 10. */
function source(route: 'legacy' | 'translation' | 'pose'): Timeline {
  const from = at(220, 10), to = at(20, 10);
  const move: Move = { unit: 0, from, to, rel: null, skyY: -80, hold: 0, entry: [0, 0, 0] };
  if (route === 'translation') move.translationPath = [[0, 0, 0], [0, -80, 0], [-200, -80, 0], [-200, 0, 0]];
  if (route === 'pose') move.posePath = [from.clone(), at(220, 10).setPosition(220, -80, 10), at(20, 10).setPosition(20, -80, 10), to.clone()];
  const track: Track = { appear: 0.2, floor: from.clone(), floorBox: { min: [210, -24, 0], max: [230, 0, 20] }, ctx: 0, moves: [move], final: to.clone() };
  return { duration: 4, intro: 0, buildEnd: 4, ground: 0, tracks: new Map([['brick', track]]),
    units: [{ kind: 'piece', keys: ['brick'], start: 0.5, dur: 3, step: 0 }],
    sceneBox: { min: [0, -24, 0], max: [230, 0, 20] }, buildBox: { min: [0, -24, 0], max: [40, 0, 20] }, modelBox: { min: [0, -24, 0], max: [40, 0, 20] },
    steps: [], subBuilds: [], camKeys: [], pacing: {} as Timeline['pacing'], heroOrbit: false } as Timeline;
}
const place = (tl: Timeline, t: number) => pos(poseAt(tl, t)('brick')!);

describe('turning the staging area about the model', () => {
  for (const route of ['legacy', 'translation', 'pose'] as const) {
    it(`swings the waiting spot about the model centre and still lands on the seat (${route} route)`, () => {
      const tl = source(route);
      const turned = applyStagingTurn(tl, 90);
      const u = tl.units[0];
      // waiting: 200 LDU from the centre (20, 10), a quarter turn round (yaw 90 maps +X to -Z)
      const wait = place(turned, u.start - 0.01);
      expect(wait.x).toBeCloseTo(20, 3);
      expect(wait.z).toBeCloseTo(10 - 200, 3);
      expect(pos(turned.tracks.get('brick')!.floor).distanceTo(wait)).toBeLessThan(1e-6);
      // the flight starts there and ends exactly on the seat
      expect(place(turned, u.start + 1e-4).distanceTo(wait)).toBeLessThan(1);
      expect(place(turned, u.start + u.dur - 1e-4).distanceTo(new THREE.Vector3(20, 0, 10))).toBeLessThan(1);
      expect(place(turned, u.start + u.dur + 0.01).distanceTo(new THREE.Vector3(20, 0, 10))).toBeLessThan(1e-6);
      // no jumps on the way
      let prev = place(turned, u.start), worst = 0;
      for (let k = 1; k <= 300; k++) { const p = place(turned, u.start + (u.dur * k) / 300); worst = Math.max(worst, p.distanceTo(prev)); prev = p; }
      expect(worst).toBeLessThan(15);
      // the camera's scene box holds the turned floor
      expect(turned.sceneBox.min[2]).toBeLessThanOrEqual(10 - 200 - 9);
    });
  }

  it('a turn of 0 leaves the timeline as it is', () => {
    const tl = source('pose');
    expect(applyStagingTurn(tl, 0)).toBe(tl);
  });

  it('is kept per model on the plan, wrapped to -180..180, and survives a project round trip', () => {
    const plan = { format: 'brickmotion-plan', version: 1, name: 't', steps: [] } as unknown as Plan;
    const turned = setStagingTurn(plan, '', 270);
    expect(stagingTurnOf(turned, '')).toBe(-90);
    expect(stagingTurnOf(turned, 'sub.ldr')).toBe(0);
    const parsed = parsePlan(JSON.parse(JSON.stringify(turned)));
    expect(parsed.ok && stagingTurnOf(parsed.plan, '')).toBe(-90);
    expect(setStagingTurn(turned, '', 0).stagingTurns).toBeUndefined();
  });
});
