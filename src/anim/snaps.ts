import type { Timeline } from './timeline';

/**
 * One click: when pieces seat (seconds) and how many seat together. `studs` (footprint
 * studs that seat) and `height` (LDU) say how big the landing parts are, so a 1x1 plate
 * and a 2x4 brick sound different; both are absent when the timeline has no boxes.
 */
export type Snap = { t: number; count: number; studs?: number; height?: number };

/** landings closer than this (seconds) sound as one, slightly louder click */
const MERGE = 0.03;

const cache = new WeakMap<Timeline, Snap[]>();

/**
 * When pieces connect: the end of every flight (a piece seating, or a finished
 * submodel attaching), sorted, with near-simultaneous landings merged.
 */
export function snapsOf(tl: Timeline): Snap[] {
  const had = cache.get(tl);
  if (had) return had;
  const ends = tl.units
    .map((u) => ({ t: u.start + u.dur, ...sizeOf(u.land ?? u.box) }))
    .filter((e) => Number.isFinite(e.t) && e.t >= 0)
    .sort((a, b) => a.t - b.t);
  const out: Snap[] = [];
  for (const e of ends) {
    const last = out[out.length - 1];
    if (last && e.t - last.t < MERGE) {
      last.count++;
      if (e.studs !== undefined) last.studs = (last.studs ?? 0) + e.studs;
      if (e.height !== undefined) last.height = Math.max(last.height ?? 0, e.height);
    } else out.push({ t: e.t, count: 1, ...(e.studs !== undefined ? { studs: e.studs, height: e.height } : {}) });
  }
  cache.set(tl, out);
  return out;
}

/** Footprint studs and height (LDU) of a landing box: 20 LDU per stud. */
function sizeOf(box: { min: ArrayLike<number>; max: ArrayLike<number> } | null | undefined): { studs?: number; height?: number } {
  if (!box) return {};
  const w = box.max[0] - box.min[0], h = box.max[1] - box.min[1], d = box.max[2] - box.min[2];
  if (![w, h, d].every((v) => Number.isFinite(v) && v >= 0)) return {};
  return { studs: Math.min(64, Math.max(1, Math.round(w / 20)) * Math.max(1, Math.round(d / 20))), height: h };
}

/** The snaps in (from, to]. */
export function snapsBetween(snaps: Snap[], from: number, to: number): Snap[] {
  if (!(to > from)) return [];
  let lo = 0;
  let hi = snaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid].t <= from) lo = mid + 1;
    else hi = mid;
  }
  const out: Snap[] = [];
  for (let i = lo; i < snaps.length && snaps[i].t <= to; i++) out.push(snaps[i]);
  return out;
}
