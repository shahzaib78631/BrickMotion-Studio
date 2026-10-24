import { describe, expect, it } from 'vitest';
import {
  allKeyRefs, channelAt, copyKeys, deleteKeys, emptyAnimation, insertKeys,
  moveKeys, pasteKeys, refId, selectedKeys, setInterpolation, trackOf, valuesAt,
} from '../../src/anim/keyframes';
import type { KeyframeAnimation } from '../../src/plan/types';

const edit = (value: number, frame = 1, model = '', target = 'brick') =>
  ({ model, target, channel: 'location.x' as const, value });
const get = (clip: KeyframeAnimation, model = '', target = 'brick') => trackOf(clip, model, target)?.channels['location.x'] ?? [];
const key = (frame: number, model = '', target = 'brick') => ({ model, target, channel: 'location.x' as const, frame });

describe('object Dope Sheet keyframes', () => {
  it('starts with a distinct, non-destructive action at frames 1–250', () => {
    const a = emptyAnimation();
    expect(a).toEqual({ fps: 24, startFrame: 1, endFrame: 250, tracks: [] });
  });
  it('upserts a key by frame and channel, sorted and immutable', () => {
    const base = emptyAnimation();
    const a = insertKeys(base, 30, [edit(3)]);
    const b = insertKeys(a, 10, [edit(-1)]);
    const c = insertKeys(b, 30, [edit(6)]);
    expect(get(c).map((v) => [v.frame, v.value])).toEqual([[10, -1], [30, 6]]);
    expect(get(a)).toEqual([{ frame: 30, value: 3, interpolation: 'bezier' }]);
    expect(base.tracks).toEqual([]);
  });
  it('preserves keys per submodel scope when sibling IDs are equal', () => {
    const a = insertKeys(emptyAnimation(), 20, [edit(2, 1, '', 'i0'), edit(8, 1, 'truck', 'i0')]);
    expect(valuesAt(a, '', 'i0', 20)['location.x']).toBe(2);
    expect(valuesAt(a, 'truck', 'i0', 20)['location.x']).toBe(8);
    expect(a.tracks).toHaveLength(2);
  });
  it('holds endpoint values and defaults missing transform channels to identity', () => {
    const a = insertKeys(insertKeys(emptyAnimation(), 10, [edit(4)]), 20, [edit(20)], 'linear');
    expect(valuesAt(a, '', 'brick', 0)['location.x']).toBe(4);
    expect(valuesAt(a, '', 'brick', 900)['location.x']).toBe(20);
    expect(valuesAt(a, '', 'brick', 15)['scale.x']).toBe(1);
    expect(valuesAt(a, '', 'brick', 15)['rotation.x']).toBe(0);
  });
  it('interpolates constant/linear/auto bezier and exactly hits endpoint values', () => {
    const a = insertKeys(insertKeys(emptyAnimation(), 10, [edit(0)]), 20, [edit(8)]);
    const bezier = get(a);
    expect(channelAt(bezier, 12, 0)).toBeCloseTo(0.832, 6); // smoothstep .2 = .104
    expect(channelAt(bezier, 20, 0)).toBe(8);
    const linear = get(setInterpolation(a, [key(10)], 'linear'));
    expect(channelAt(linear, 12, 0)).toBeCloseTo(1.6);
    const constant = get(setInterpolation(a, [key(10)], 'constant'));
    expect(channelAt(constant, 19, 0)).toBe(0);
    expect(channelAt(constant, 20, 0)).toBe(8);
  });
  it('moves a multi-selected block atomically, while keeping frames sorted', () => {
    let a = emptyAnimation();
    for (const [f, v] of [[10, 1], [20, 2], [30, 3]] as const) a = insertKeys(a, f, [edit(v)]);
    const b = moveKeys(a, [key(10), key(20)], 5);
    expect(get(b).map((k) => [k.frame, k.value])).toEqual([[15, 1], [25, 2], [30, 3]]);
    expect(get(a).map((k) => k.frame)).toEqual([10, 20, 30]);
  });
  it('handles collisions deterministically: moved keys replace resident keys', () => {
    let a = emptyAnimation();
    for (const [f, v] of [[10, 1], [20, 2], [30, 3]] as const) a = insertKeys(a, f, [edit(v)]);
    expect(get(moveKeys(a, [key(10)], 10)).map((k) => [k.frame, k.value])).toEqual([[20, 1], [30, 3]]);
  });
  it('copies keys with relative offsets and pastes at playhead', () => {
    const a = insertKeys(insertKeys(emptyAnimation(), 10, [edit(2)]), 25, [edit(9)]);
    const clip = copyKeys(a, [key(10), key(25)]);
    expect(clip.map((k) => k.offset)).toEqual([0, 15]);
    const b = pasteKeys(a, clip, 50);
    expect(get(b).map((k) => k.frame)).toEqual([10, 25, 50, 65]);
    expect(get(b).at(-1)!.value).toBe(9);
  });
  it('deletes only selected channels and prunes empty tracks', () => {
    const a = insertKeys(emptyAnimation(), 12, [edit(7), { model: '', target: 'brick', channel: 'scale.x', value: 1.5 }]);
    const b = deleteKeys(a, [key(12)]);
    expect(get(b)).toEqual([]);
    expect(b.tracks).toHaveLength(1);
    expect(deleteKeys(b, [{ model: '', target: 'brick', channel: 'scale.x', frame: 12 }]).tracks).toEqual([]);
  });
  it('preserves interpolation when replacing an existing key', () => {
    const a = setInterpolation(insertKeys(emptyAnimation(), 20, [edit(5)]), [key(20)], 'constant');
    expect(get(insertKeys(a, 20, [edit(6)]))[0].interpolation).toBe('constant');
  });
  it('clamps invalid keyframe movement to the scene range', () => {
    const a = insertKeys(emptyAnimation(), 249, [edit(3)]);
    expect(get(moveKeys(a, [key(249)], 1000))[0].frame).toBe(250);
  });
  it('keeps keyframe references stable and handles absent keys gracefully', () => {
    const a = emptyAnimation();
    expect(allKeyRefs(a, '')).toEqual([]);
    expect(selectedKeys(a, [key(12)])).toEqual([]);
    expect(refId(key(12))).toBe(refId(key(12)));
    expect(deleteKeys(a, [key(12)])).toBe(a);
  });
  it('serializes and reloads all channels/keys without losing keyframes', () => {
    const a = insertKeys(emptyAnimation(), 24, [edit(3), { model: '', target: 'truck', channel: 'rotation.y', value: 90 }]);
    const b = JSON.parse(JSON.stringify(a)) as KeyframeAnimation;
    expect(b).toEqual(a);
    expect(valuesAt(b, '', 'truck', 24)['rotation.y']).toBe(90);
  });
});
