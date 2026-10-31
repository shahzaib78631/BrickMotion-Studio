import { clamp, clamp01 } from './easing';
import type { MotionEase, MotionStyle } from '../plan/types';
import type { Timeline, Track } from './timeline';
import type { Unit } from './timelineData';

export type { MotionEase, MotionStyle };

export const MOTION_EASES: { value: MotionEase; label: string }[] = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'gentle', label: 'Gentle' },
  { value: 'soft', label: 'Soft (slow ends)' },
  { value: 'linear', label: 'Linear' },
];

/** Ranges the editor offers; stored values are clamped to them. */
export const MOTION_LIMITS = {
  time: { min: 0.25, max: 4 },
  landing: { min: 0.1, max: 0.7 },
  hover: { min: 0, max: 0.4 },
} as const;

const EASE: Record<MotionEase, (u: number) => number> = {
  smooth: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  gentle: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
  soft: (u) => (u < 0.5 ? 16 * u ** 5 : 1 - Math.pow(-2 * u + 2, 5) / 2),
  linear: (u) => u,
};
export const easeOf = (name: MotionEase | undefined) => EASE[name ?? 'smooth'] ?? EASE.smooth;

/** Only the fields a flight's own shape uses (speed is applied to the whole scene's clock). */
export type FlightStyle = Pick<MotionStyle, 'landing' | 'hover' | 'ease'>;

/** Drops unset/invalid fields and clamps the rest. Null when nothing is set. */
export function cleanStyle(s: MotionStyle | null | undefined): MotionStyle | null {
  if (!s) return null;
  const out: MotionStyle = {};
  const num = (v: unknown, r: { min: number; max: number }) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(clamp(v, r.min, r.max) * 100) / 100 : undefined;
  const time = num(s.time, MOTION_LIMITS.time);
  const landing = num(s.landing, MOTION_LIMITS.landing);
  const hover = num(s.hover, MOTION_LIMITS.hover);
  if (time !== undefined) out.time = time;
  if (landing !== undefined) out.landing = landing;
  if (hover !== undefined) out.hover = hover;
  if (s.ease && s.ease in EASE) out.ease = s.ease;
  return Object.keys(out).length ? out : null;
}

/** Later styles win, field by field. */
export function mergeStyles(...styles: (MotionStyle | null | undefined)[]): MotionStyle {
  const out: MotionStyle = {};
  for (const s of styles) if (s) for (const [k, v] of Object.entries(s)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/**
 * Re-times a flight's progress (0..1) along its unchanged path: the last part, from
 * `landStart` on, is the seat into place. `landing` is the share of the flight time
 * spent on it and `hover` a pause just before it. With neither set it is the identity.
 */
export function landingWarp(u: number, style: FlightStyle | undefined, landStart: number): number {
  if (!style || (style.landing === undefined && !style.hover)) return u;
  const landing = style.landing ?? 1 - landStart;
  const hover = Math.min(style.hover ?? 0, 0.9 - landing);
  const cruise = Math.max(0.05, 1 - landing - Math.max(0, hover));
  const seat = 1 - cruise - Math.max(0, hover);
  if (u <= cruise) return (landStart * u) / cruise;
  if (u <= cruise + hover) return landStart;
  return landStart + ((1 - landStart) * clamp01((u - cruise - hover) / seat));
}

/** Piecewise-linear clock map from planned seconds to shown seconds. */
export type Retime = { from: number[]; to: number[] };

const interp = (xs: number[], ys: number[], x: number) => {
  const n = xs.length;
  if (x <= xs[0]) return ys[0] + (x - xs[0]);
  if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  return span > 0 ? ys[lo] + ((x - xs[lo]) / span) * (ys[hi] - ys[lo]) : ys[lo];
};
export const forward = (r: Retime, t: number) => interp(r.from, r.to, t);
export const inverse = (r: Retime, t: number) => interp(r.to, r.from, t);

/**
 * The clock map for per-unit flight-time factors. While units fly, the clock runs
 * slower by the largest factor among them; between flights it runs normally. Every
 * shown moment is exactly a planned moment, so the checked flights stay as planned.
 */
export function buildRetime(units: readonly Pick<Unit, 'start' | 'dur'>[], factor: (i: number) => number): Retime | null {
  const spans = units.map((u, i) => ({ a: u.start, b: u.start + u.dur, f: factor(i) })).filter((s) => s.b > s.a);
  if (!spans.some((s) => Math.abs(s.f - 1) > 1e-6)) return null;
  const cuts = [...new Set(spans.flatMap((s) => [s.a, s.b]))].sort((x, y) => x - y);
  spans.sort((x, y) => x.a - y.a);
  const from = [cuts[0]];
  const to = [cuts[0]];
  let first = 0;
  for (let k = 1; k < cuts.length; k++) {
    const a = cuts[k - 1], b = cuts[k];
    while (first < spans.length && spans[first].b <= a) first++;
    let f = 0;
    for (let i = first; i < spans.length && spans[i].a < b; i++) if (spans[i].b > a) f = Math.max(f, spans[i].f);
    from.push(b);
    to.push(to[to.length - 1] + (b - a) * (f || 1));
  }
  return { from, to };
}

/**
 * Applies motion styles to a planned timeline without planning again: flight-time
 * factors re-time the whole clock (see buildRetime), landing/hover/ease reshape how
 * each flight moves along its own path. `styleOf(unit)` gives the resolved style.
 */
export function applyMotionStyle(tl: Timeline, styleOf: (unit: Unit, index: number) => MotionStyle | null): Timeline {
  const styles = tl.units.map((u, i) => styleOf(u, i));
  const shaped = styles.some((s) => s && (s.landing !== undefined || s.hover || (s.ease && s.ease !== 'smooth')));
  const retime = buildRetime(tl.units, (i) => styles[i]?.time ?? 1);
  if (!shaped && !retime) return tl;
  const T = (t: number) => (retime ? forward(retime, t) : t);
  const units = tl.units.map((u) => {
    const start = T(u.start);
    return { ...u, start, dur: T(u.start + u.dur) - start };
  });
  const tracks = new Map<string, Track>();
  for (const [key, tr] of tl.tracks) {
    tracks.set(key, {
      ...tr,
      appear: Number.isFinite(tr.appear) ? T(tr.appear) : tr.appear,
      moves: tr.moves.map((mv) => {
        const s = styles[mv.unit];
        if (!s || (s.landing === undefined && !s.hover && (!s.ease || s.ease === 'smooth'))) return mv;
        return { ...mv, style: { landing: s.landing, hover: s.hover, ease: s.ease } };
      }),
    });
  }
  return {
    ...tl,
    tracks,
    units,
    retime: retime ?? undefined,
    duration: T(tl.duration),
    intro: T(tl.intro),
    buildEnd: T(tl.buildEnd),
    steps: tl.steps.map((s) => ({ ...s, start: T(s.start), end: T(s.end) })),
    subBuilds: tl.subBuilds.map((s) => ({ ...s, start: T(s.start), attachStart: T(s.attachStart), attachEnd: T(s.attachEnd) })),
    camKeys: tl.camKeys.map((k) => ({ ...k, t: T(k.t) })),
    mechanismStage: tl.mechanismStage && { ...tl.mechanismStage, start: T(tl.mechanismStage.start) },
  };
}
