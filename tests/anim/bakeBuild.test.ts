import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bakeBuildFlights, offsetForPose, simplifyChannel } from '../../src/anim/bakeBuild';
import { emptyAnimation, insertKeys, valuesAt } from '../../src/anim/keyframes';
import { makeKeyframePose } from '../../src/anim/keyframePose';
import type { Timeline, Move, Track } from '../../src/anim/timeline';
import type { Instance } from '../../src/model/assemble';
import { deleteKeys, allKeyRefs, moveKeys } from '../../src/anim/keyframes';

const matrix = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
const instance = (key: string, x = 0): Instance => ({
  key, itemId: key.split('/').at(-1)!, model: '', part: '3001', color: 4, grid: true, placeholder: false,
  world: matrix(x), worldBox: { min: [x, -24, 0], max: [x + 20, 0, 20] },
});
const move = (unit: number, from: number, to: number): Move => ({
  unit, from: matrix(from), to: matrix(to), rel: null, skyY: -80,
  hold: 0, entry: [0, 0, 0], translationPath: [[0, 0, 0], [to - from, 0, 0]],
});
const track = (x: number, appear: number): Track => ({
  appear, floor: matrix(x + 100), floorBox: { min: [x + 100, -24, 0], max: [x + 120, 0, 20] },
  ctx: 0, moves: [move(0, x + 100, x)], final: matrix(x),
});
function source(keys = ['brick', 'other'], appear = .25): Timeline {
  const tracks = new Map(keys.map((key, i) => [key, track(i * 100, appear)]));
  return { duration: 1, intro: 0, buildEnd: 1, ground: 0, tracks, units: [{ kind: 'piece', keys, start: .4, dur: .6, step: 0 }],
    sceneBox: { min: [0, -24, 0], max: [300, 0, 20] }, buildBox: { min: [0, -24, 0], max: [300, 0, 20] }, modelBox: { min: [0, -24, 0], max: [300, 0, 20] },
    steps: [], subBuilds: [], camKeys: [], pacing: {} as Timeline['pacing'], heroOrbit: false,
  };
}
const getX = (m: THREE.Matrix4 | null | undefined) => m?.elements[12];

describe('editable generated flights', () => {
  it('bakes only the selected leaf and keeps other source flights live', () => {
    const originals = [instance('brick'), instance('other', 100)];
    const generated = source();
    const originalClip = emptyAnimation();
    const result = bakeBuildFlights(originalClip, '', originals, new Map(), generated, { targets: ['brick'] });
    expect(result.count).toBe(1);
    expect(result.animation.buildLayers?.['']).toBeDefined();
    const flight = result.animation.tracks.find((t) => t.target === 'brick')!;
    expect(flight.source).toBe('baked-flight');
    expect(flight.channels.visibility).toEqual([
      { frame: 1, value: 0, interpolation: 'constant' },
      { frame: 7, value: 1, interpolation: 'constant' },
    ]);
    const playback = makeKeyframePose(originals, new Map(), result.animation, '', generated);
    expect(playback(1).get('brick')).toBeNull();
    expect(playback(1).get('other')).toBeNull();
    // The clip includes both ends, so the 1 s Build linked at frame 1 lands on frame 25.
    expect(getX(playback(25).get('brick'))).toBeCloseTo(0, 3);
    expect(getX(playback(25).get('other'))).toBeCloseTo(100, 3);
    expect(originalClip.tracks).toEqual([]);
    expect(originals[0].world.elements[12]).toBe(0);
  });

  it('bakes the entire Build and survives lost planning without showing hidden pieces', () => {
    const parts = [instance('brick'), instance('other', 100)];
    const a = bakeBuildFlights(emptyAnimation(), '', parts, new Map(), source(), { detach: true }).animation;
    expect(a.buildLayers).toBeUndefined();
    const sample = makeKeyframePose(parts, new Map(), a, '', null);
    expect(sample(1).get('brick')).toBeNull();
    // A parked piece holds its floor pose; the channel is compressed to the
    // documented 0.004-stud tolerance (0.08 LDU), so it is near-, not exactly, 100.
    expect(Math.abs(getX(sample(7).get('brick'))! - 100)).toBeLessThan(0.08);
    expect(getX(sample(25).get('brick'))).toBeCloseTo(0, 3);
    expect(getX(sample(25).get('other'))).toBeCloseTo(100, 3);
  });

  it('keeps baked keyframes editable through normal move/delete/insert operations', () => {
    const p = instance('brick');
    const baked = bakeBuildFlights(emptyAnimation(), '', [p], new Map(), source(['brick']), { detach: true }).animation;
    const refs = allKeyRefs(baked, '', 'brick').filter((ref) => ref.channel === 'location.x');
    const moved = moveKeys(baked, refs.slice(1, 2), 2);
    expect(moved.tracks[0].source).toBe('baked-flight');
    const deleted = deleteKeys(moved, allKeyRefs(moved, '', 'brick'));
    expect(deleted.tracks[0].source).toBe('baked-flight');
    const edited = insertKeys(deleted, 15, [{ model: '', target: 'brick', channel: 'location.x', value: 8 }]);
    expect(getX(makeKeyframePose([p], new Map(), edited, '')(15).get('brick'))).toBeCloseTo(160);
    expect(valuesAt(edited, '', 'brick', 15)['location.x']).toBe(8);
  });

  it('uses nested leaf instance paths and supports a moved parent group', () => {
    const p = instance('truck/axle/wheel');
    const t = source([p.key], 0);
    const baked = bakeBuildFlights(emptyAnimation(), '', [p], new Map(), t, { detach: true }).animation;
    const moved = insertKeys(baked, 20, [{ model: '', target: 'truck', channel: 'location.z', value: 3 }]);
    const at = makeKeyframePose([p], new Map(), moved, '')(20);
    expect(at.get(p.key)?.elements[14]).toBeCloseTo(-60, 3);
  });

  it('preserves temporary hidden segments from older generated Build routes', () => {
    const p = instance('brick');
    const generated = source(['brick'], 0);
    generated.units[0].hidden = true;
    const baked = bakeBuildFlights(emptyAnimation(), '', [p], new Map(), generated, { detach: true }).animation;
    expect(baked.tracks[0].channels.visibility).toEqual([
      { frame: 1, value: 1, interpolation: 'constant' },
      { frame: 11, value: 0, interpolation: 'constant' },
      { frame: 25, value: 1, interpolation: 'constant' },
    ]);
    const frames = makeKeyframePose([p], new Map(), baked, '');
    expect(frames(12).get('brick')).toBeNull();
    expect(frames(25).get('brick')).not.toBeNull();
  });

  it('accepts a yaw rotation converted relative to a scaled/reflected LDraw base', () => {
    const original = new THREE.Matrix4().makeScale(-1, 1, 1).setPosition(20, -24, 40);
    const desired = new THREE.Matrix4().makeRotationY(Math.PI / 2).multiply(original);
    const d = offsetForPose(original, desired, new THREE.Vector3(0, 0, 0));
    expect(d.slice(0, 3).every(Number.isFinite)).toBe(true);
    expect(d.slice(3, 6).some((v) => Math.abs(v) > 89)).toBe(true);
  });

  it('compresses straight paths while retaining direction changes and endpoints', () => {
    const a = simplifyChannel([{ frame: 1, value: 0 }, { frame: 2, value: 1 }, { frame: 3, value: 2 }, { frame: 4, value: 1 }], .005);
    expect(a.map((k) => k.frame)).toEqual([1, 3, 4]);
    expect(a.every((k) => k.interpolation === 'linear')).toBe(true);
  });

  it('rejects selected bake detaching and invalid routes atomically', () => {
    const original = emptyAnimation();
    expect(() => bakeBuildFlights(original, '', [instance('brick'), instance('other')], new Map(), source(),
      { targets: ['brick'], detach: true })).toThrow('entire');
    expect(() => bakeBuildFlights(original, '', [instance('unknown')], new Map(), source(), { detach: true })).toThrow('Missing generated');
    expect(original.tracks.length).toBe(0);
  });
});
