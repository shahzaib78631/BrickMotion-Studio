import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { encodeTimeline, decodeTimeline } from '../../src/anim/timelineCodec';
import { assemble, type Metrics } from '../../src/model/assemble';
import type { AssemblyHints, PieceItem, Plan, Raw } from '../../src/plan/types';
import { CHANNELS, emptyAnimation, insertKeys, valuesAt } from '../../src/anim/keyframes';
import { makeKeyframePose } from '../../src/anim/keyframePose';
import { fillMotionKeyframes, missingMotionKeyTargets } from '../../src/anim/motion/autoBake';

// Small synthetic parts keep planner/keyframe regression coverage independent
// of the optional downloaded LDraw parts and Shadow Library assets.
const identity: Raw['matrix'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const body = { min: [-5, -10, -5] as [number, number, number], max: [5, 0, 5] as [number, number, number] };
const metrics: Metrics = (id) => ({
  id, body, full: body, footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false,
});
const piece = (id: string, x: number, assembly?: AssemblyHints, matrix: Raw['matrix'] = identity): PieceItem => ({
  id, part: 'synthetic', color: 4, ldu: [x, 0, 0], matrix: [...matrix], assembly,
});
const plan = (pieces: PieceItem[][]): Plan => ({
  format: 'brickmotion-plan', version: 1, name: 'Motion engine test',
  steps: pieces.map((items) => ({ pieces: items })),
});
const option = { targetSeconds: 12, heroOrbit: false, planner: 'standard-motion' as const, mode: 'piece' as const };
const model = () => assemble(plan([
  [piece('a', 0)], [piece('b', 24)], [piece('c', 48)],
]), metrics, new Map());

const matches = (a: THREE.Matrix4 | null | undefined, b: THREE.Matrix4): void => {
  expect(a).not.toBeNull();
  a!.elements.forEach((n, i) => expect(n).toBeCloseTo(b.elements[i], 4));
};

describe('Standard Motion — separate preview engine', () => {
  it('keeps every leaf and reaches its exact authored position, including worker serialization', () => {
    const asm = model();
    const tl = buildTimeline(asm, metrics, option);
    expect(tl.motion?.engine).toBe('standard-motion');
    expect(tl.motion?.parts).toBe(asm.instances.length);
    expect(tl.tracks.size).toBe(asm.instances.length);
    expect(tl.units.length).toBeGreaterThan(0);
    const restored = decodeTimeline(encodeTimeline(tl));
    for (const instance of asm.instances) {
      expect(tl.tracks.has(instance.key)).toBe(true);
      matches(poseAt(restored, restored.duration)(instance.key), instance.world);
    }
  });

  it('finishes an unresolved support graph instead of dropping the orphan part', () => {
    const asm = assemble(plan([[piece('base', 0)],
      [piece('orphan', 24, { attachTo: 'does-not-exist' })],
      [piece('last', 48)]]), metrics, new Map());
    const tl = buildTimeline(asm, metrics, option);
    expect(tl.motion?.fallback).toContain('missing-parent');
    expect(tl.motion?.review).toBe(asm.instances.length);
    expect(tl.units.every((unit) => unit.uncertified)).toBe(true);
    expect(tl.tracks.size).toBe(asm.instances.length);
    for (const inst of asm.instances) {
      expect(tl.tracks.get(inst.key)?.moves[0].posePath?.length).toBeGreaterThan(2);
      matches(poseAt(tl, tl.duration)(inst.key), inst.world);
    }
  });

  it('creates nine editable channels for each and every part, independent from generated Build', () => {
    const asm = model();
    const tl = buildTimeline(asm, metrics, option);
    const result = fillMotionKeyframes(emptyAnimation(), '', asm.instances, new Map(), tl);
    expect(result.count).toBe(asm.instances.length);
    expect(result.animation.buildLayers?.['']).toBeUndefined();
    expect(result.animation.tracks).toHaveLength(asm.instances.length);
    expect(result.keys).toBeGreaterThan(asm.instances.length * 9);
    for (const inst of asm.instances) {
      const track = result.animation.tracks.find((t) => t.target === inst.key)!;
      expect(track.source).toBe('baked-flight');
      for (const channel of CHANNELS) {
        expect(track.channels[channel]?.length, `${inst.key}: ${channel}`).toBeGreaterThan(0);
      }
      matches(makeKeyframePose(asm.instances, new Map(), result.animation, '')(result.animation.endFrame).get(inst.key), inst.world);
    }
    expect(missingMotionKeyTargets(result.animation, '', asm.instances)).toEqual([]);
  });

  it('preserves hand-edited part channels and bakes only missing leaves', () => {
    const asm = model();
    const tl = buildTimeline(asm, metrics, option);
    const edited = insertKeys(emptyAnimation(), 12,
      [{ model: '', target: 'a', channel: 'location.x', value: 6 }]);
    const result = fillMotionKeyframes(edited, '', asm.instances, new Map(), tl);
    expect(result.count).toBe(2);
    expect(result.animation.buildLayers?.['']).toBeDefined();
    const original = result.animation.tracks.find((t) => t.target === 'a')!;
    expect(original.source).toBeUndefined();
    expect(original.channels['location.x']).toEqual(edited.tracks[0].channels['location.x']);
    expect(valuesAt(result.animation, '', 'a', 12)['location.x']).toBe(6);
    for (const key of ['b', 'c']) expect(result.animation.tracks.find((t) => t.target === key)?.source).toBe('baked-flight');
    expect(missingMotionKeyTargets(result.animation, '', asm.instances)).toEqual([]);
  });

  it('does not turn a singular placement into a misleading keyframed preview', () => {
    const item = piece('bad', 0, undefined, [1, 0, 0, 0, 0, 0, 0, 0, 1]);
    const asm = assemble(plan([[item]]), metrics, new Map());
    expect(() => buildTimeline(asm, metrics, option)).toThrow('invalid-transform');
  });
});
