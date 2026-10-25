import { clamp } from './easing';
import type { JointLimitRule } from './motion/v4/jointLimits';
import type { MechanismProgram } from './motion/v4/mechanismProgram';

export type ArrivalMode = 'piece' | 'batch' | 'step';
export type FloorSort = 'step' | 'colour' | 'part' | 'size';
export type FloorSides = 'front-back' | 'front' | 'behind' | 'sides';
export type AnimOptions = {
  targetSeconds: number; heroOrbit: boolean; mode?: ArrivalMode;
  /** V2 is explicit opt-in until articulated/flexible model coverage is ready. */
  planner?: 'legacy' | 'construction-v2' | 'construction-auto' | 'construction-v3' | 'construction-v3-auto' | 'construction-v4' | 'standard-motion' | 'standard-motion-v4' | 'assembly-artifact';
  /** v4 verified/user-defined signed joint stops. Never guessed from render meshes. */
  motionV4Limits?: JointLimitRule[];
  /** Explicit postassembly gear, linkage or reduced-gravity demonstration. */
  motionV4Mechanism?: MechanismProgram | null;
  constructionMaxStates?: number;
  constructionMaxCandidates?: number;
  constructionMaxMilliseconds?: number;
  constructionSupport?: 'fixture' | 'table';
  constructionMechanicalSubassemblies?: boolean;
  /** Opt-in authored-step preassembly of genuinely matched mechanical neighbours. */
  constructionStepModules?: boolean;
  /** Optional clip-length overrides, seconds. Null follows the automatic video length. */
  introSeconds?: number | null; buildSeconds?: number | null; outroSeconds?: number | null;
  /** Infer geometric support dependencies (default). False disables that inference, not explicit or anatomical dependencies. */
  bottomUp?: boolean;
  /** Stage supported elastic tyre/rim pairs already joined. Default true. False requires rigid routes for every separate piece. */
  preassembleKnownWheels?: boolean;
  /** Bounded re-planning of blocked access order. 1 disables reordering; maximum 32. */
  accessSearchAttempts?: number;
  /**
   * Assembly plan artifact (`brickmotion-assembly-plan` v1 JSON, from the Python
   * engine) for the `assembly-artifact` planner. It is carried alongside the
   * model plan (`plan.assemblyPlan`) — not set by hand.
   */
  assemblyPlan?: unknown;
  /**
   * Work budget for re-planning after a failed original order, counted in planner
   * progress reports (one per piece and per route tried). Counting work, not time,
   * gives the same build order on a fast or a busy machine. Default 1500, maximum 20000.
   */
  accessSearchWork?: number;
  /**
   * After the access search gives up, reorder every piece still blocked by a piece
   * that does not hold it, and plan once more (off by default: one extra full plan,
   * no gain measured on the jet, 5590 or 10001; see docs/diagnostics/assembler-port.md).
   */
  accessRepair?: boolean;
  /**
   * How pieces waiting on the floor are grouped: by build step (default: the
   * earliest pieces lie furthest out), by colour, by part, or by size only.
   */
  floorSort?: FloorSort;
  /** Where they wait around the model: in front and behind (default), only in front, only behind, or at its left and right. */
  floorSides?: FloorSides;
  /** Optional wall-clock cap on that re-planning (ms, maximum 10000). Unset by default: a time cap makes results depend on machine load. */
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
  /** each piece starts only after the previous one has landed (the video grows to fit) */
  sequential?: boolean;
};

export const INTRO = 1.0;
const PIECE_MIN_SLOT = 0.18;
const STEP_MIN_SLOT = 0.6;
const BATCH_SLOT = 0.6;
const PIECE_MIN_FLIGHT = 0.35;
/** gap between one piece landing and the next leaving, in one-by-one mode */
export const SEQUENTIAL_GAP = 0.05;

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

  // Chosen explicitly, one by one means one piece in the air at a time, however long that takes.
  if (opts.mode === 'piece') {
    const slot = units > 0 ? build / units : build;
    return { ...common, mode: 'piece', slot, flight: clamp(slot * 0.85, PIECE_MIN_FLIGHT, 0.9), batchSize: 1, sequential: true };
  }
  if (opts.mode === 'step') return step();
  if (opts.mode === 'batch') return batch();
  if (units === 0 || build / units >= PIECE_MIN_SLOT) return piece();
  if (build / Math.max(1, steps) >= STEP_MIN_SLOT) return step();
  return batch();
}
