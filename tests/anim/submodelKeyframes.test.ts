import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/gamora-submodel-flight.json';
import { decodeTimeline, encodeTimeline, type EncodedTimeline } from '../../src/anim/timelineCodec';
import { poseAt, applyAssemblySpotTransform } from '../../src/anim/timeline';
import { makeKeyframePose } from '../../src/anim/keyframePose';
import { applySubmodelKeyframes, flightFrameRange } from '../../src/anim/submodelKeyframes';
import type { KeyframeAnimation } from '../../src/plan/types';
import type { Assembly, Instance } from '../../src/model/assemble';

const animation = fixture.animation as unknown as KeyframeAnimation;
const decode = (value: unknown) => decodeTimeline(value as EncodedTimeline);
const child = decode(fixture.child);
const world = child.tracks.get('i3f')!.final;
const inst: Instance = { key: 'i3f', itemId: 'i3f', model: animation.tracks[0].model,
  part: 'test', color: 4, grid: false, placeholder: false, world,
  worldBox: fixture.childBox as Instance['worldBox'] };
const assembly: Assembly = { instances: [inst], nodes: [], bounds: inst.worldBox, problems: [] };
const difference = (a: THREE.Matrix4, b: THREE.Matrix4) => Math.max(...a.elements.map((v, i) => Math.abs(v - b.elements[i])));

describe('Gamora saved sub-build flight in the main model', () => {
  it('matches standalone keyed playback throughout the flight and retains the attach', () => {
    const parent = decode(fixture.parent);
    const result = applySubmodelKeyframes(parent, animation, '', () => assembly);
    const key = 'i2s/i3f';
    const original = parent.tracks.get(key)!, flown = result.tracks.get(key)!;
    const move = original.moves[0], unit = parent.units[move.unit];
    const seat = move.rel ? move.to.clone().multiply(move.rel) : move.to;
    const frame = seat.clone().multiply(world.clone().invert());
    const sample = makeKeyframePose([inst], new Map(), animation, inst.model, child);
    const [lo, hi] = flightFrameRange(animation.tracks[0])!;
    for (let i = 0; i < 100; i++) {
      const u = i / 100;
      const expected = frame.clone().multiply(sample(lo + (hi - lo) * u).get('i3f')!);
      expect(difference(poseAt(result, unit.start + unit.dur * u)(key)!, expected)).toBeLessThan(.03);
    }
    expect(flown.moves.slice(1)).toEqual(original.moves.slice(1));
    for (const time of [parent.subBuilds[0].attachStart, parent.subBuilds[0].attachEnd, parent.duration]) {
      expect(difference(poseAt(result, time)(key)!, poseAt(parent, time)(key)!)).toBeLessThan(1e-8);
    }
    expect(original.moves[0].posePath).toBeUndefined();
    expect(difference(poseAt(decodeTimeline(encodeTimeline(result)), unit.start + unit.dur * .5)(key)!,
      poseAt(result, unit.start + unit.dur * .5)(key)!)).toBeLessThan(1e-8);
  });

  it('carries the route through a translated and rotated main assembly spot', () => {
    const parent = decode(fixture.parent);
    const spot = { x: 4, z: -5, angle: 90 };
    const before = applyAssemblySpotTransform(applySubmodelKeyframes(parent, animation, '', () => assembly), spot);
    const after = applySubmodelKeyframes(applyAssemblySpotTransform(parent, spot), animation, '', () => assembly);
    const unit = parent.units[0];
    for (const u of [0, .2, .5, .9, 1]) {
      const t = unit.start + unit.dur * u;
      expect(difference(poseAt(before, t)('i2s/i3f')!, poseAt(after, t)('i2s/i3f')!)).toBeLessThan(1e-6);
    }
  });

  it('reuses the same saved flight for repeated uses and remains idempotent', () => {
    const parent = decode(fixture.parent);
    const moved = applyAssemblySpotTransform(parent, { x: 8, z: 3, angle: 180 });
    const second = moved.tracks.get('i2s/i3f')!;
    const repeated = { ...parent,
      tracks: new Map([...parent.tracks, ['copy/i3f', second] as const]),
      subBuilds: [...parent.subBuilds, { ...parent.subBuilds[0], key: 'copy' }] };
    let loads = 0;
    const result = applySubmodelKeyframes(repeated, animation, '', () => { loads++; return assembly; });
    expect(loads).toBe(1);
    const again = applySubmodelKeyframes(result, animation, '', () => assembly);
    const unit = parent.units[0];
    for (const key of ['i2s/i3f', 'copy/i3f']) {
      for (const u of [0, .1, .5, .9, 1]) {
        const t = unit.start + unit.dur * u;
        expect(difference(poseAt(result, t)(key)!, poseAt(again, t)(key)!)).toBeLessThan(1e-8);
      }
    }
  });

  it('does no work without saved child keys and respects a main-model override', () => {
    const parent = decode(fixture.parent);
    const fail = () => { throw new Error('must not load or plan a submodel'); };
    expect(applySubmodelKeyframes(parent, undefined, '', fail)).toBe(parent);
    expect(applySubmodelKeyframes(parent, { ...animation, tracks: [] }, '', fail)).toBe(parent);
    const override = { ...animation.tracks[0], model: '', target: 'i2s/i3f' };
    expect(applySubmodelKeyframes(parent, { ...animation, tracks: [...animation.tracks, override] }, '', () => assembly)).toBe(parent);
  });
});
