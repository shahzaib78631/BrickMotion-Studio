import type { Plan } from '../plan/types';

/**
 * What real LEGO buildings look like, learned from the LDraw Official Model Repository
 * by python/omr/priors.py: colour schemes as sets combine them, which windows they use,
 * how many have sloped roofs, their sizes and floors. The building generator draws from
 * these instead of hand-picked tables once enough buildings have been learned.
 */
export type PriorScheme = {
  wall: number;
  stripe: number | null;
  roof: number | null;
  frame: number | null;
  door: number | null;
  trim: number | null;
  /** how many real buildings use this combination */
  weight: number;
};

export type BuildingPriors = {
  buildings: number;
  schemes: PriorScheme[];
  windows: Partial<Record<'window2x2' | 'window2x3' | 'window4x3', number>>;
  roof: { sloped: number; flat: number; slope33Share: number };
  /** [width, depth, how many] in studs */
  footprints: [number, number, number][];
  /** floors → how many buildings */
  floors: Record<string, number>;
};

/** A real set's mix of parts and colours: share of each `part:colour`. */
export type SetFingerprint = { set: string; name: string; theme: string; pieces: number; hist: [string, number][] };

/** Enough learned buildings to trust the priors over the hand-made tables. */
export const MIN_LEARNED = 20;

/** Pick by weight with a 0–1 random number. */
export function weighted<T>(items: readonly T[], weight: (t: T) => number, r: number): T {
  const total = items.reduce((s, t) => s + Math.max(0, weight(t)), 0);
  let x = r * total;
  for (const t of items) {
    x -= Math.max(0, weight(t));
    if (x < 0) return t;
  }
  return items[items.length - 1];
}

/** A plan's own fingerprint: the share of its pieces of each part and colour. */
export function fingerprint(plan: Plan): Map<string, number> {
  const all = plan.steps.flatMap((s) => s.pieces).flatMap((p) => ('part' in p ? [`${p.part.replace(/\.dat$/i, '').toLowerCase()}:${p.color}`] : []));
  const out = new Map<string, number>();
  for (const k of all) out.set(k, (out.get(k) ?? 0) + 1 / all.length);
  return out;
}

export type Originality = {
  /** 0–100: how much of the model is its own (100 − overlap with the closest set) */
  percent: number;
  /** the closest real set and how much of the model it shares, 0–100 */
  closest: { set: string; name: string; shared: number } | null;
};

/**
 * How original a model is against the learned sets: the overlap of their part-and-colour
 * mixes (the sum of the smaller share of each key), against the closest set. The set
 * fingerprints keep each set's 40 most used keys, so this is a close lower bound.
 */
export function originality(plan: Plan, sets: readonly SetFingerprint[]): Originality {
  const mine = fingerprint(plan);
  let best: Originality['closest'] = null;
  for (const s of sets) {
    let shared = 0;
    for (const [k, v] of s.hist) shared += Math.min(v, mine.get(k) ?? 0);
    if (!best || shared * 100 > best.shared) best = { set: s.set, name: s.name, shared: Math.round(shared * 1000) / 10 };
  }
  return { percent: best ? Math.round((100 - best.shared) * 10) / 10 : 100, closest: best };
}
