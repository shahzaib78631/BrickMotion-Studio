import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { insertKeys, emptyAnimation } from '../../src/anim/keyframes';
import { makeKeyframePose } from '../../src/anim/keyframePose';
import type { Instance } from '../../src/model/assemble';

const part = (key: string, x: number): Instance => ({
  key, itemId: key.split('/')[0], model: '', part: '3001', color: 4,
  placeholder: false, grid: true,
  world: new THREE.Matrix4().makeTranslation(x, 0, 0),
  worldBox: { min: [x, -24, 0], max: [x + 20, 0, 20] },
});
const pos = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

describe('viewport object pose sampler', () => {
  it('applies keyed Location in studs, preserving the original brick matrices', () => {
    const instance = part('brick', 40);
    const clip = insertKeys(emptyAnimation(), 20, [{ model: '', target: 'brick', channel: 'location.x', value: 3 }]);
    const sampled = makeKeyframePose([instance], new Map(), clip, '');
    expect(pos(sampled(20).get('brick')!).x).toBeCloseTo(100); // 40 + 3*20
    expect(instance.world.elements[12]).toBe(40);
  });
  it('keeps all children of a submodel rigid under a rotation', () => {
    const a = part('truck/i1', 0), b = part('truck/i2', 80);
    const clip = insertKeys(emptyAnimation(), 1, [{ model: '', target: 'truck', channel: 'rotation.y', value: 90 }]);
    const at = makeKeyframePose([a, b], new Map(), clip, '')(1);
    const v0 = pos(at.get(a.key)!), v1 = pos(at.get(b.key)!);
    expect(v0.distanceTo(v1)).toBeCloseTo(80);
    expect(Math.abs(v0.x - v1.x)).toBeLessThan(1e-4);
    expect(Math.abs(v0.z - v1.z)).toBeCloseTo(80);
  });
  it('composes keyed motion after a placed submodel footprint only once', () => {
    const p = part('truck/i1', 0);
    const placed = new Map([['truck/i1', new THREE.Matrix4().makeTranslation(200, 0, 40)]]);
    const clip = insertKeys(emptyAnimation(), 24, [{ model: '', target: 'truck', channel: 'location.x', value: 2 }]);
    expect(pos(makeKeyframePose([p], placed, clip, '')(24).get(p.key)!).x).toBeCloseTo(240);
  });
  it('does not apply another model’s same-named target track', () => {
    const p = part('brick', 0);
    const clip = insertKeys(emptyAnimation(), 10, [{ model: 'wheel', target: 'brick', channel: 'location.x', value: 10 }]);
    expect(makeKeyframePose([p], new Map(), clip, '')(10).size).toBe(0);
  });
  it('reverts to its authored pose when there are no object keys', () => {
    const p = part('brick', 40);
    expect(makeKeyframePose([p], new Map(), undefined, '')(99).size).toBe(0);
  });
});

describe('live-linked generated Build editing', () => {
  const build = (x = 100) => ({
    duration: 1, ground: 0,
    sceneBox: { min: [0, -24, 0], max: [x + 20, 0, 20] },
    tracks: new Map([['brick', {
      appear: 0.5, floor: new THREE.Matrix4().makeTranslation(40, 0, 0),
      floorBox: { min: [40, -24, 0], max: [60, 0, 20] },
      ctx: 0, moves: [], final: new THREE.Matrix4().makeTranslation(x, 0, 0),
    }]]),
    units: [],
  }) as unknown as import('../../src/anim/timeline').Timeline;
  it('keeps pieces hidden before their Build appearance time', () => {
    const p = part('brick', 0);
    const a = { ...emptyAnimation(), buildLayers: { '': { startFrame: 1, speed: 1 } } };
    const sample = makeKeyframePose([p], new Map(), a, '', build());
    expect(sample(1).has('brick')).toBe(true);
    expect(sample(1).get('brick')).toBeNull();
    expect(pos(sample(14).get('brick')!).x).toBeCloseTo(100);
  });
  it('composes keyed offsets after the Build pose and does not double-place the scene', () => {
    const p = part('brick', 0);
    const a = insertKeys({ ...emptyAnimation(), buildLayers: { '': { startFrame: 1, speed: 1 } } }, 14,
      [{ model: '', target: 'brick', channel: 'location.x', value: 2 }]);
    const bogusPlacedSpot = new Map([['brick', new THREE.Matrix4().makeTranslation(900, 0, 0)]]);
    const sample = makeKeyframePose([p], bogusPlacedSpot, a, '', build());
    expect(pos(sample(14).get('brick')!).x).toBeCloseTo(140);
    expect(p.world.elements[12]).toBe(0);
  });
  it('has a clear hidden state when the linked Build route cannot be generated', () => {
    const a = { ...emptyAnimation(), buildLayers: { '': { startFrame: 1, speed: 1 } } };
    expect(makeKeyframePose([part('brick', 0)], new Map(), a, '', null)(1).get('brick')).toBeNull();
  });
});
