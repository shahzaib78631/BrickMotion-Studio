import type { Timeline } from './timeline';

/** One click: when pieces seat (seconds) and how many seat together. */
export type Snap = { t: number; count: number };

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
  const ends = tl.units.map((u) => u.start + u.dur).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const out: Snap[] = [];
  for (const t of ends) {
    const last = out[out.length - 1];
    if (last && t - last.t < MERGE) last.count++;
    else out.push({ t, count: 1 });
  }
  cache.set(tl, out);
  return out;
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
