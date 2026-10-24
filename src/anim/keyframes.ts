import type { AnimationChannel, AnimationKey, KeyframeAnimation, KeyInterpolation, ObjectAnimationTrack } from '../plan/types';

/** Independent object/action keyframes. All operations are pure for project undo/redo. */
export const CHANNELS = [
  'location.x', 'location.y', 'location.z',
  'rotation.x', 'rotation.y', 'rotation.z',
  'scale.x', 'scale.y', 'scale.z',
  'visibility',
] as const satisfies readonly AnimationChannel[];
export const TRANSFORM_CHANNELS: readonly AnimationChannel[] = CHANNELS.filter((channel) => channel !== 'visibility');
export const TRANSFORM_SECTIONS = ['location', 'rotation', 'scale'] as const;
export type ChannelGroup = typeof TRANSFORM_SECTIONS[number];
export type KeyRef = { model: string; target: string; channel: AnimationChannel; frame: number };
export type ChannelValues = Record<AnimationChannel, number>;

const DEFAULT_ANIMATION: KeyframeAnimation = Object.freeze({ fps: 24, startFrame: 1, endFrame: 250, tracks: Object.freeze([]) }) as unknown as KeyframeAnimation;
export function emptyAnimation(): KeyframeAnimation {
  return { fps: 24, startFrame: 1, endFrame: 250, tracks: [] };
}
export function animationOf(animation: KeyframeAnimation | undefined): KeyframeAnimation {
  return animation ?? DEFAULT_ANIMATION;
}
export const defaultValue = (channel: AnimationChannel): number => channel === 'visibility' || channel.startsWith('scale.') ? 1 : 0;
export const refId = (ref: KeyRef): string => JSON.stringify([ref.model, ref.target, ref.channel, ref.frame]);
export const trackId = (model: string, target: string): string => JSON.stringify([model, target]);
export const boundedFrame = (frame: number, animation: KeyframeAnimation): number =>
  Math.max(animation.startFrame, Math.min(animation.endFrame, Math.round(Number.isFinite(frame) ? frame : animation.startFrame)));

/** Strictly sorted, unique frames. Bezier is cubic Hermite with automatic zero-slope handles. */
export function channelAt(keys: readonly AnimationKey[] | undefined, frame: number, fallback: number, discrete = false): number {
  if (!keys?.length) return fallback;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys.length - 1;
  if (frame >= keys[last].frame) return keys[last].value;
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const from = keys[lo], to = keys[hi];
  const t = (frame - from.frame) / (to.frame - from.frame);
  const smooth = from.interpolation === 'bezier' ? t * t * (3 - 2 * t) : t;
  return from.interpolation === 'constant' || discrete ? from.value : from.value + (to.value - from.value) * smooth;
}

export function trackOf(animation: KeyframeAnimation | undefined, model: string, target: string): ObjectAnimationTrack | undefined {
  return animation?.tracks.find((track) => track.kind === 'object' && track.model === model && track.target === target);
}
export function valuesAt(animation: KeyframeAnimation | undefined, model: string, target: string, frame: number): ChannelValues {
  const track = trackOf(animation, model, target);
  return Object.fromEntries(CHANNELS.map((channel) => [channel, channelAt(track?.channels[channel], frame, defaultValue(channel), channel === 'visibility')])) as ChannelValues;
}

export type KeyUpdate = { model: string; target: string; channel: AnimationChannel; value: number };
/** Insert/replace all listed channels as one edit, preserving other channels and keys. */
export function insertKeys(animation: KeyframeAnimation, frame: number, updates: readonly KeyUpdate[], interpolation: KeyInterpolation = 'bezier'): KeyframeAnimation {
  if (!updates.length) return animation;
  const at = boundedFrame(frame, animation);
  const grouped = new Map<string, { model: string; target: string; channels: Map<AnimationChannel, number> }>();
  for (const u of updates) {
    if (!CHANNELS.includes(u.channel) || !u.target || !Number.isFinite(u.value)) continue;
    const id = trackId(u.model, u.target);
    let entry = grouped.get(id);
    if (!entry) { entry = { model: u.model, target: u.target, channels: new Map() }; grouped.set(id, entry); }
    entry.channels.set(u.channel, u.value);
  }
  if (!grouped.size) return animation;
  const tracks = animation.tracks.map((track) => {
    const change = grouped.get(trackId(track.model, track.target));
    if (!change) return track;
    grouped.delete(trackId(track.model, track.target));
    return {
      ...track,
      channels: updateChannels(track.channels, change.channels, at, interpolation),
    };
  });
  for (const entry of grouped.values()) {
    tracks.push({ kind: 'object', model: entry.model, target: entry.target, channels: updateChannels({}, entry.channels, at, interpolation) });
  }
  return { ...animation, tracks };
}

function updateChannels(channels: ObjectAnimationTrack['channels'], updates: Map<AnimationChannel, number>, frame: number, interpolation: KeyInterpolation): ObjectAnimationTrack['channels'] {
  const next = { ...channels };
  for (const [channel, value] of updates) {
    const old = channels[channel] ?? [];
    const existing = old.find((key) => key.frame === frame);
    const key: AnimationKey = { frame, value, interpolation: channel === 'visibility' ? 'constant' : existing?.interpolation ?? interpolation };
    next[channel] = [...old.filter((k) => k.frame !== frame), key].sort((a, b) => a.frame - b.frame);
  }
  return next;
}

/** Key selection/editing operates on precise channel+frame references, not array indices. */
export function selectedKeys(animation: KeyframeAnimation, refs: readonly KeyRef[]): { ref: KeyRef; key: AnimationKey }[] {
  const chosen = new Set(refs.map(refId));
  const result: { ref: KeyRef; key: AnimationKey }[] = [];
  for (const track of animation.tracks) for (const channel of CHANNELS) {
    for (const key of track.channels[channel] ?? []) {
      const ref = { model: track.model, target: track.target, channel, frame: key.frame };
      if (chosen.has(refId(ref))) result.push({ ref, key });
    }
  }
  return result;
}
export function deleteKeys(animation: KeyframeAnimation, refs: readonly KeyRef[]): KeyframeAnimation {
  const chosen = new Set(refs.map(refId));
  if (!chosen.size) return animation;
  let changed = false;
  const tracks = animation.tracks.map((track) => {
    let updated = track.channels;
    for (const channel of CHANNELS) {
      const old = track.channels[channel];
      if (!old?.length) continue;
      const keys = old.filter((key) => !chosen.has(refId({ model: track.model, target: track.target, channel, frame: key.frame })));
      if (keys.length !== old.length) {
        if (updated === track.channels) updated = { ...updated };
        updated[channel] = keys;
        changed = true;
      }
    }
    return updated === track.channels ? track : { ...track, channels: updated };
  }).filter((track) => track.source === 'baked-flight' || CHANNELS.some((channel) => (track.channels[channel]?.length ?? 0) > 0));
  return changed ? { ...animation, tracks } : animation;
}

/** Moving a set atomically avoids index drift and swaps; moving keys win on collisions. */
export function moveKeys(animation: KeyframeAnimation, refs: readonly KeyRef[], delta: number): KeyframeAnimation {
  const picked = selectedKeys(animation, refs);
  const shift = Math.round(delta);
  if (!picked.length || !shift) return animation;
  const without = deleteKeys(animation, picked.map((p) => p.ref));
  const grouped = new Map<string, { model: string; target: string; channel: AnimationChannel; keys: AnimationKey[] }>();
  for (const p of picked) {
    const id = JSON.stringify([p.ref.model, p.ref.target, p.ref.channel]);
    let entry = grouped.get(id);
    if (!entry) { entry = { model: p.ref.model, target: p.ref.target, channel: p.ref.channel, keys: [] }; grouped.set(id, entry); }
    entry.keys.push({ ...p.key, frame: boundedFrame(p.key.frame + shift, animation) });
  }
  let next = without;
  for (const { model, target, channel, keys } of grouped.values()) {
    // Stable ordering for keys clipped to the boundary: last wins deterministically.
    for (const key of keys) {
      next = insertKeys(next, key.frame, [{ model, target, channel, value: key.value }], key.interpolation);
      const track = trackOf(next, model, target)!;
      const adjusted = track.channels[channel]!.map((k) => k.frame === key.frame ? key : k);
      next = { ...next, tracks: next.tracks.map((t) => t === track ? { ...t, channels: { ...t.channels, [channel]: adjusted } } : t) };
    }
  }
  return next;
}

export function setInterpolation(animation: KeyframeAnimation, refs: readonly KeyRef[], interpolation: KeyInterpolation): KeyframeAnimation {
  const chosen = new Set(refs.map(refId));
  if (!chosen.size) return animation;
  let changed = false;
  const tracks = animation.tracks.map((track) => {
    const channels = { ...track.channels };
    for (const channel of CHANNELS) if (channels[channel]) {
      channels[channel] = channels[channel]!.map((key) => {
        if (channel === 'visibility' || !chosen.has(refId({ model: track.model, target: track.target, channel, frame: key.frame })) || key.interpolation === interpolation) return key;
        changed = true;
        return { ...key, interpolation };
      });
    }
    return { ...track, channels };
  });
  return changed ? { ...animation, tracks } : animation;
}

export function allKeyRefs(animation: KeyframeAnimation, model: string, target?: string): KeyRef[] {
  return animation.tracks.filter((t) => t.model === model && (target === undefined || t.target === target))
    .flatMap((track) => CHANNELS.flatMap((channel) => (track.channels[channel] ?? []).map((key) => ({ model, target: track.target, channel, frame: key.frame }))));
}

/** Clipboard contents are relative to the first copied frame. */
export type KeyClipboard = { offset: number; model: string; target: string; channel: AnimationChannel; value: number; interpolation: KeyInterpolation }[];
export function copyKeys(animation: KeyframeAnimation, refs: readonly KeyRef[]): KeyClipboard {
  const data = selectedKeys(animation, refs);
  const first = Math.min(...data.map((p) => p.ref.frame));
  return data.map(({ ref, key }) => ({ offset: ref.frame - first, model: ref.model, target: ref.target, channel: ref.channel, value: key.value, interpolation: key.interpolation }));
}
export function pasteKeys(animation: KeyframeAnimation, clip: KeyClipboard, atFrame: number): KeyframeAnimation {
  let next = animation;
  for (const key of clip) {
    const frame = boundedFrame(atFrame + key.offset, animation);
    next = insertKeys(next, frame, [key], key.interpolation);
    const track = trackOf(next, key.model, key.target)!;
    next = { ...next, tracks: next.tracks.map((t) => t === track ? {
      ...t, channels: { ...t.channels, [key.channel]: t.channels[key.channel]!.map((k) => k.frame === frame ? { ...k, interpolation: key.interpolation } : k) },
    } : t) };
  }
  return next;
}
