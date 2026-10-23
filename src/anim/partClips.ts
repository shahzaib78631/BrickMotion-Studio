import { isSub, type Step } from '../plan/types';
import type { Timeline } from './timeline';

/** One piece (or attached submodel) of the open model, as a clip on the timeline's Parts lane. */
export type PartClip = {
  id: string;
  /** step and arrival position in it (plan order) */
  step: number;
  index: number;
  /** when its flight starts and ends, seconds */
  start: number;
  end: number;
  part?: string;
  submodel?: string;
  color?: string | number;
  /** lane row after packing */
  row: number;
};

/**
 * The flight of every top-level piece of the open model: a piece's own flight, or for a
 * submodel the moment its finished build is attached. Pieces flying inside a submodel's
 * build belong to that submodel's own timeline and are left out.
 */
export function partClips(tl: Timeline, steps: Step[]): PartClip[] {
  const flight = new Map<string, { start: number; end: number; size: number }>();
  for (const u of tl.units) {
    // A preassembled wheel is one flight but both part rows must remain
    // selectable in the timeline. Outer submodel attaches still win by size.
    const keys = u.kind === 'piece' ? u.keys : u.keys.slice(0, 1);
    for (const first of keys) {
      if (!first) continue;
      const top = first.split('/')[0];
      if (u.kind === 'piece' && first.includes('/')) continue;
      const size = u.kind === 'attach' ? u.keys.length : 0;
      const had = flight.get(top);
      if (had && had.size >= size && u.kind === 'attach') continue;
      flight.set(top, { start: u.start, end: u.start + u.dur, size });
    }
  }
  const out: PartClip[] = [];
  steps.forEach((s, step) =>
    s.pieces.forEach((item, index) => {
      const f = item.id ? flight.get(item.id) : undefined;
      if (!f || !item.id) return;
      out.push(
        isSub(item)
          ? { id: item.id, step, index, start: f.start, end: f.end, submodel: item.submodel, row: 0 }
          : { id: item.id, step, index, start: f.start, end: f.end, part: item.part, color: item.color, row: 0 },
      );
    }),
  );
  return out;
}

/**
 * Stacks overlapping clips into rows (each clip at least `minSeconds` wide on screen).
 * Beyond `maxRows`, a clip goes into the row that frees up first. Returns the row count.
 */
export function packRows(clips: PartClip[], minSeconds: number, maxRows: number): number {
  const ends: number[] = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start || a.step - b.step || a.index - b.index)) {
    const end = Math.max(c.end, c.start + minSeconds);
    let row = ends.findIndex((e) => e <= c.start);
    if (row < 0) {
      if (ends.length < maxRows) row = ends.push(0) - 1;
      else row = ends.indexOf(Math.min(...ends));
    }
    ends[row] = Math.max(ends[row], end);
    c.row = row;
  }
  return Math.max(1, ends.length);
}

/**
 * Where a piece dropped at `t` seconds goes: the step whose span holds `t` (or the
 * nearest one) and its arrival position among that step's other pieces (`skip`: the
 * piece being moved).
 */
export function dropTarget(tl: Timeline, steps: Step[], clips: PartClip[], t: number, skip?: string): { step: number; index: number } | null {
  const spans = tl.steps.filter((s) => s.model === '');
  if (!spans.length) return steps.length ? { step: steps.length - 1, index: steps[steps.length - 1].pieces.length } : { step: 0, index: 0 };
  const dist = (s: { start: number; end: number }) => (t < s.start ? s.start - t : t > s.end ? t - s.end : 0);
  const span = spans.reduce((best, s) => (dist(s) < dist(best) ? s : best));
  const step = span.index;
  const startOf = new Map(clips.filter((c) => c.step === step).map((c) => [c.id, c.start]));
  const others = (steps[step]?.pieces ?? []).filter((i) => i.id !== skip);
  let index = others.findIndex((i) => (i.id ? (startOf.get(i.id) ?? -Infinity) : -Infinity) >= t);
  if (index < 0) index = others.length;
  return { step, index };
}

/** The open model's step being built at `t`: the last step started by then (the first during the intro). */
export function stepAt(tl: Timeline, t: number): number | null {
  const spans = tl.steps.filter((s) => s.model === '').sort((a, b) => a.start - b.start);
  if (!spans.length) return null;
  const started = spans.filter((s) => s.start <= t + 1e-6);
  return (started.length ? started[started.length - 1] : spans[0]).index;
}

/** When step `index` of the open model plays: [start, end] (a step split by a submodel build spans all its parts). */
export function stepRange(tl: Timeline | null, index: number): [number, number] | null {
  const spans = tl?.steps.filter((s) => s.model === '' && s.index === index) ?? [];
  if (!spans.length) return null;
  return [Math.min(...spans.map((s) => s.start)), Math.max(...spans.map((s) => s.end))];
}

/**
 * After a clip is dropped at a new place, the pieces the user put after it that the
 * replanned build still brings in first: the planner pulls in what a piece rests on
 * or needs room from before the piece itself.
 */
export function pulledAhead(clips: PartClip[], moved: string, later: ReadonlySet<string>): PartClip[] {
  const c = clips.find((x) => x.id === moved);
  if (!c) return [];
  return clips.filter((x) => later.has(x.id) && x.start < c.start - 1e-6).sort((a, b) => a.start - b.start);
}
