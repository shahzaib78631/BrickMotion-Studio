import { clamp } from './easing';

export type ArrivalMode = 'piece' | 'batch' | 'step';
export type AnimOptions = {
  targetSeconds: number; heroOrbit: boolean; mode?: ArrivalMode;
  /** V2 is explicit opt-in until articulated/flexible model coverage is ready. */
  planner?: 'legacy' | 'construction-v2';
  constructionMaxStates?: number;
  constructionMaxMilliseconds?: number;
  constructionSupport?: 'fixture' | 'table';
  constructionMechanicalSubassemblies?: boolean;
  /** Optional clip-length overrides, seconds. Null follows the automatic video length. */
  introSeconds?: number | null; buildSeconds?: number | null; outroSeconds?: number | null;
  /** Infer geometric support dependencies (default). False disables that inference, not explicit or anatomical dependencies. */
  bottomUp?: boolean;
  /** Stage supported elastic tyre/rim pairs already joined. Default true. False requires rigid routes for every separate piece. */
  preassembleKnownWheels?: boolean;
  /** Bounded re-planning of blocked access order. 1 disables reordering; maximum 32. */
  accessSearchAttempts?: number;
  /** Total additional search budget after a failed original order (default 4000 ms, maximum 10000). */
  accessSearchMilliseconds?: number;
};
export type Pacing = {
  mode: ArrivalMode;
  intro: number;
  outro: number;
  /** total build time, pauses excluded */
  build: number;
  stepPause: number;
  slot: number;
  flight: number;
  batchSize: number;
};

export const INTRO = 1.0;
const PIECE_MIN_SLOT = 0.18;
const STEP_MIN_SLOT = 0.6;
const BATCH_SLOT = 0.6;

/** Decides how fast pieces arrive so the build fits the target length. */
export function choosePacing(units: number, steps: number, opts: AnimOptions): Pacing {
  const intro = clamp(opts.introSeconds ?? INTRO, 0.2, 120);
  const outro = clamp(opts.outroSeconds ?? (opts.heroOrbit ? 3.0 : 0.5), 0.2, 120);
  const base = Math.max(1, opts.buildSeconds ?? (opts.targetSeconds - intro - outro));
  const pauseTotal = steps > 1 ? Math.min(0.25 * (steps - 1), 0.2 * base) : 0;
  const build = base - pauseTotal;
  const stepPause = steps > 1 ? pauseTotal / (steps - 1) : 0;
  const common = { intro, outro, build, stepPause };

  const piece = (): Pacing => {
    const slot = units > 0 ? build / units : build;
    return { ...common, mode: 'piece', slot, flight: Math.min(build, clamp(slot * 2.5, 0.35, 0.9)), batchSize: 1 };
  };
  const step = (): Pacing => {
    const slot = build / Math.max(1, steps);
    return { ...common, mode: 'step', slot, flight: Math.min(0.9, 0.6 * slot), batchSize: 1 };
  };
  const batch = (): Pacing => {
    const batches = Math.max(1, Math.floor(build / BATCH_SLOT));
    return { ...common, mode: 'batch', slot: BATCH_SLOT, flight: 0.5, batchSize: Math.max(1, Math.ceil(units / batches)) };
  };

  if (opts.mode === 'piece') return piece();
  if (opts.mode === 'step') return step();
  if (opts.mode === 'batch') return batch();
  if (units === 0 || build / units >= PIECE_MIN_SLOT) return piece();
  if (build / Math.max(1, steps) >= STEP_MIN_SLOT) return step();
  return batch();
}
