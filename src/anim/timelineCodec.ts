import * as THREE from 'three';
import type { Timeline, Track } from './timeline';

import type { EncodedTimeline, EncTrack } from './timelineData';
export type { EncodedTimeline } from './timelineData';

export function encodeTimeline(tl: Timeline): EncodedTimeline {
  const index = new Map<THREE.Matrix4, number>();
  const list: THREE.Matrix4[] = [];
  const ref = (m: THREE.Matrix4 | null) => {
    if (!m) return -1;
    let i = index.get(m);
    if (i === undefined) {
      i = list.length;
      index.set(m, i);
      list.push(m);
    }
    return i;
  };
  const tracks: [string, EncTrack][] = [];
  for (const [key, tr] of tl.tracks)
    tracks.push([
      key,
      {
        appear: tr.appear,
        floorBox: tr.floorBox,
        ctx: tr.ctx,
        floor: ref(tr.floor),
        final: ref(tr.final),
        moves: tr.moves.map((mv) => ({ ...mv, from: ref(mv.from), to: ref(mv.to), rel: ref(mv.rel), posePath: mv.posePath?.map(ref) })),
      },
    ]);
  const mats = new Float64Array(list.length * 16);
  list.forEach((m, i) => mats.set(m.elements, i * 16));
  const { tracks: _omit, ...rest } = tl;
  return { ...rest, mats, tracks };
}

export function decodeTimeline(enc: EncodedTimeline): Timeline {
  const cache = new Map<number, THREE.Matrix4>();
  const mat = (i: number) => {
    let m = cache.get(i);
    if (!m) cache.set(i, (m = new THREE.Matrix4().fromArray(enc.mats, i * 16)));
    return m;
  };
  const tracks = new Map<string, Track>();
  for (const [key, tr] of enc.tracks)
    tracks.set(key, {
      appear: tr.appear,
      floorBox: tr.floorBox,
      ctx: tr.ctx,
      floor: mat(tr.floor),
      final: mat(tr.final),
      moves: tr.moves.map((mv) => ({ ...mv, from: mat(mv.from), to: mat(mv.to), rel: mv.rel < 0 ? null : mat(mv.rel), posePath: mv.posePath?.map(mat) })),
    });
  const { mats: _m, tracks: _t, ...rest } = enc;
  return { ...rest, tracks };
}
