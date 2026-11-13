/**
 * Pause blocks: the build stands still for a while (parts stop where they are, even in
 * mid-flight) while the video, and so the camera, runs on. A pause is a change of the clock
 * of a finished timeline, the same way a flight-time factor is (see motionStyle.ts): nothing
 * is planned again and every route stays exactly as planned.
 */
import type { Pause } from '../plan/types';
import { inverse, type Retime } from './motionStyle';
import type { Timeline, Track } from './timeline';

export const MIN_PAUSE = 0.1;
export const MAX_PAUSE = 60;

/** Sorted, with no overlap and no empty blocks. `at` is on the finished video (earlier pauses included). */
export function normalizePauses(pauses: readonly Pause[]): Pause[] {
  const out: Pause[] = [];
  let end = 0;
  for (const p of [...pauses].sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(p.at) || !Number.isFinite(p.len)) continue;
    const len = Math.min(MAX_PAUSE, p.len);
    if (len < MIN_PAUSE - 1e-9) continue;
    const at = Math.max(p.at, end);
    out.push({ ...p, at, len });
    end = at + len;
  }
  return out;
}

/** Where on the finished video the time `t` of the un-paused timeline lands (`after`: past a pause that starts at t). */
export function shownTime(pauses: readonly Pause[], t: number, after: boolean): number {
  let shift = 0;
  for (const p of normalizePauses(pauses)) {
    const start = p.at - shift; // its place on the un-paused clock
    if (start < t - 1e-9 || (after && Math.abs(start - t) <= 1e-9)) shift += p.len;
    else break;
  }
  return t + shift;
}

/** Total seconds the pauses add. */
export const pausedSeconds = (pauses: readonly Pause[]) => normalizePauses(pauses).reduce((s, p) => s + p.len, 0);

/**
 * The same timeline with the pauses in it. Starts move to just after a pause that begins at
 * the same moment, ends stay before it, so a flight that crosses a pause freezes and goes on.
 */
export function applyPauses(tl: Timeline, input: readonly Pause[]): Timeline {
  const pauses = normalizePauses(input);
  if (!pauses.length) return tl;
  const Gr = (t: number) => shownTime(pauses, t, true);
  const Gl = (t: number) => shownTime(pauses, t, false);
  // the clock map: planned seconds -> shown seconds, flat over each pause
  const base: Retime = tl.retime ?? { from: [0], to: [0] };
  const pts: [number, number][] = base.from.map((f, i) => [f, Gl(base.to[i])]);
  let shift = 0;
  for (const p of pauses) {
    const start = p.at - shift;
    const planned = tl.retime ? inverse(tl.retime, start) : start;
    pts.push([planned, start + shift], [planned, start + shift + p.len]);
    shift += p.len;
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const retime: Retime = { from: pts.map((q) => q[0]), to: pts.map((q) => q[1]) };

  const units = tl.units.map((u) => {
    const start = Gr(u.start);
    return { ...u, start, dur: Math.max(0, Math.max(start, Gl(u.start + u.dur)) - start) };
  });
  const tracks = new Map<string, Track>();
  for (const [key, tr] of tl.tracks) tracks.set(key, Number.isFinite(tr.appear) ? { ...tr, appear: Gr(tr.appear) } : tr);
  return {
    ...tl,
    tracks,
    units,
    retime,
    duration: tl.duration + shift,
    intro: Gl(tl.intro),
    buildEnd: Gl(tl.buildEnd),
    steps: tl.steps.map((s) => ({ ...s, start: Gr(s.start), end: Math.max(Gr(s.start), Gl(s.end)) })),
    subBuilds: tl.subBuilds.map((s) => ({ ...s, start: Gr(s.start), attachStart: Gr(s.attachStart), attachEnd: Math.max(Gr(s.attachStart), Gl(s.attachEnd)) })),
    camKeys: tl.camKeys.map((k) => ({ ...k, t: Gr(k.t) })),
    mechanismStage: tl.mechanismStage && { ...tl.mechanismStage, start: Gr(tl.mechanismStage.start) },
  };
}
