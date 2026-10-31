import type { Box } from '../ldraw/flatten';
import type { Mat3, Vec3 } from '../ldraw/parse';
import { gridToPlacement, rotatedBox, rotMatrix } from './placement';
import { isGrid, type AssemblyHints, type MotionStyle, type Plan, type PlanItem, type Rot, type Step } from './types';

/** '' is the main model; anything else names a submodel. */
export type ModelName = string;
export type Footprint = (item: PlanItem) => { w: number; d: number };

export function modelSteps(p: Plan, m: ModelName): Step[] {
  return m === '' ? p.steps : (p.submodels?.[m]?.steps ?? []);
}

function withSteps(p: Plan, m: ModelName, steps: Step[]): Plan {
  if (m === '') return { ...p, steps };
  return { ...p, submodels: { ...p.submodels, [m]: { steps } } };
}

function mapItems(p: Plan, m: ModelName, ids: string[], fn: (i: PlanItem) => PlanItem): Plan {
  const set = new Set(ids);
  const steps = modelSteps(p, m).map((s) =>
    s.pieces.some((i) => i.id && set.has(i.id)) ? { ...s, pieces: s.pieces.map((i) => (i.id && set.has(i.id) ? fn(i) : i)) } : s,
  );
  return withSteps(p, m, steps);
}

/**
 * Mark pieces as their own foundation, or clear it. The build graph derives "must be built
 * first" from what a piece rests on; `root` is the author saying that derivation is wrong
 * here — the escape hatch that lets a piece be forced earlier in the timeline.
 */
export function setRootHint(p: Plan, m: ModelName, ids: string[], root = true): Plan {
  return mapItems(p, m, ids, (item) => {
    const hints: AssemblyHints = { ...item.assembly };
    if (root) hints.root = true;
    else delete hints.root;
    const out = { ...item } as PlanItem;
    if (Object.keys(hints).length) out.assembly = hints;
    else delete out.assembly;
    return out;
  });
}

/**
 * Moves items by `d` (x, z in studs, y in plates). Grid items stay on the grid for
 * whole-stud moves; a half-stud move (snapping onto a jumper stud) turns a grid
 * piece into an exact LDraw placement, which needs `bodyOf` to know its footprint.
 * Without a body, grid items fall back to the nearest whole stud.
 */
export function moveItems(p: Plan, m: ModelName, ids: string[], d: { x: number; y: number; z: number }, bodyOf?: (item: PlanItem) => Box | undefined): Plan {
  const whole = Number.isInteger(d.x) && Number.isInteger(d.y) && Number.isInteger(d.z);
  return mapItems(p, m, ids, (i) => {
    if (!isGrid(i)) return { ...i, ldu: [i.ldu[0] + 20 * d.x, i.ldu[1] - 8 * d.y, i.ldu[2] + 20 * d.z] as Vec3 };
    const body = whole ? undefined : bodyOf?.(i);
    if (!body) return { ...i, x: i.x + Math.round(d.x), y: i.y + Math.round(d.y), z: i.z + Math.round(d.z) };
    const at = gridToPlacement(i, body);
    const out: Record<string, unknown> = { ...i };
    for (const key of ['x', 'y', 'z', 'rot']) delete out[key];
    return { ...out, ldu: [at.pos[0] + 20 * d.x, at.pos[1] - 8 * d.y, at.pos[2] + 20 * d.z] as Vec3, matrix: at.m } as PlanItem;
  });
}

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r.map((v) => (Object.is(v, -0) ? 0 : v)) as Mat3;
}

/** Turn about the vertical axis by `deg` (any angle), in rotMatrix's direction. */
function yawMatrix(deg: number): Mat3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Snaps float noise (0.866 * 0.866 + …) back to exact 0 / ±1 where it is that close. */
const tidy = (m: Mat3): Mat3 => m.map((v) => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) || 0 : v)) as Mat3;

/**
 * One press of Rotate: a quarter turn about the vertical axis. A piece an imported
 * file left at an odd angle (a truck at 30°) first turns to the next square angle,
 * so pressing Rotate always reaches 0°, 90°, 180° and 270°: facing front included.
 */
export function nextQuarterTurn(m: Mat3): Mat3 {
  // only an upright piece has a yaw to snap; anything tilted keeps the plain 90° step
  if (Math.abs(m[4] - 1) > 1e-3) return mul(rotMatrix(90), m);
  const yaw = (Math.atan2(m[2], m[0]) * 180) / Math.PI;
  const off = ((yaw % 90) + 90) % 90;
  const step = off < 0.5 || off > 89.5 ? 90 : 90 - off;
  return tidy(mul(yawMatrix(step), m));
}

const center = (b: Box): Vec3 => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2) as Vec3;

export function rotateItems(p: Plan, m: ModelName, ids: string[], fp: Footprint, body: (i: PlanItem) => Box): Plan {
  return mapItems(p, m, ids, (i) => {
    if (isGrid(i)) {
      const { w, d } = fp(i);
      return { ...i, rot: ((i.rot + 90) % 360) as Rot, x: Math.floor(i.x + w / 2 - d / 2 + 0.5), z: Math.floor(i.z + d / 2 - w / 2 + 0.5) };
    }
    const b = body(i);
    const c0 = center(rotatedBox(b, i.matrix));
    const matrix = nextQuarterTurn(i.matrix);
    const c1 = center(rotatedBox(b, matrix));
    const ldu = [0, 1, 2].map((k) => i.ldu[k] + c0[k] - c1[k] || 0) as Vec3;
    return { ...i, matrix, ldu };
  });
}

export function deleteItems(p: Plan, m: ModelName, ids: string[]): Plan {
  const set = new Set(ids);
  return withSteps(
    p,
    m,
    modelSteps(p, m).map((s) => ({ ...s, pieces: s.pieces.filter((i) => !(i.id && set.has(i.id))) })),
  );
}

export function setColor(p: Plan, m: ModelName, ids: string[], color: string | number): Plan {
  return mapItems(p, m, ids, (i) => ('part' in i ? { ...i, color } : i));
}

export function setPart(p: Plan, m: ModelName, ids: string[], part: string): Plan {
  return mapItems(p, m, ids, (i) => ('part' in i ? { ...i, part } : i));
}

export function addItem(p: Plan, m: ModelName, step: number, item: PlanItem): Plan {
  const steps = [...modelSteps(p, m)];
  if (step >= steps.length) steps.push({ pieces: [item] });
  else steps[step] = { ...steps[step], pieces: [...steps[step].pieces, item] };
  return withSteps(p, m, steps);
}

export function moveItemsToStep(p: Plan, m: ModelName, ids: string[], step: number): Plan {
  const set = new Set(ids);
  const moving: PlanItem[] = [];
  const steps = modelSteps(p, m).map((s) => ({
    ...s,
    pieces: s.pieces.filter((i) => {
      if (i.id && set.has(i.id)) {
        moving.push(i);
        return false;
      }
      return true;
    }),
  }));
  while (steps.length <= step) steps.push({ pieces: [] });
  steps[step] = { ...steps[step], pieces: [...steps[step].pieces, ...moving] };
  return withSteps(p, m, steps);
}

/** Move an entire step without changing the order of parts *inside* that step. */
export function reorderStep(p: Plan, m: ModelName, from: number, to: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= steps.length || to >= steps.length || from === to) return p;
  const [s] = steps.splice(from, 1);
  steps.splice(to, 0, s);
  return withSteps(p, m, steps);
}

export function insertStep(p: Plan, m: ModelName, at: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!Number.isInteger(at) || at < 0 || at > steps.length) return p;
  steps.splice(at, 0, { pieces: [] });
  return withSteps(p, m, steps);
}

/** Removes a step; its pieces join the previous step (or the next one when it is the first). */
export function deleteStep(p: Plan, m: ModelName, at: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!Number.isInteger(at) || at < 0 || at >= steps.length || (steps.length === 1 && steps[0].pieces.length > 0)) return p;
  const [gone] = steps.splice(at, 1);
  if (gone.pieces.length && steps.length) {
    const target = at === 0 ? 0 : at - 1;
    const keep = steps[target];
    steps[target] = {
      ...keep,
      pieces: at === 0 ? [...gone.pieces, ...keep.pieces] : [...keep.pieces, ...gone.pieces],
      notes: at === 0
        ? [gone.notes, keep.notes].filter(Boolean).join('\n') || undefined
        : [keep.notes, gone.notes].filter(Boolean).join('\n') || undefined,
      // Removing a step also removes any pause between it and its neighbour.
      pauseAfter: at === 0 ? keep.pauseAfter : gone.pauseAfter,
    };
  }
  return withSteps(p, m, steps);
}

/** Update a step's editorial details. Empty text removes optional metadata. */
export function updateStep(p: Plan, m: ModelName, at: number, fields: Pick<Step, 'title' | 'notes' | 'pauseAfter'>): Plan {
  const steps = [...modelSteps(p, m)];
  if (!steps[at]) return p;
  const title = fields.title?.trim().slice(0, 80) || undefined;
  const notes = fields.notes?.trim().slice(0, 1000) || undefined;
  const pauseAfter = Number.isFinite(fields.pauseAfter)
    ? Math.round(Math.min(10, Math.max(0, fields.pauseAfter ?? 0)) * 10) / 10
    : 0;
  const previous = steps[at];
  const next = { ...previous, title, notes, pauseAfter: pauseAfter || undefined };
  if (previous.title === next.title && previous.notes === next.notes && previous.pauseAfter === next.pauseAfter) return p;
  steps[at] = next;
  return withSteps(p, m, steps);
}

/** Reorder one piece inside its step (the build plays in the new order). */
export function reorderItemInStep(p: Plan, m: ModelName, at: number, from: number, to: number): Plan {
  const steps = [...modelSteps(p, m)];
  const step = steps[at];
  if (!step || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= step.pieces.length || to >= step.pieces.length || from === to) return p;
  const pieces = [...step.pieces];
  const [item] = pieces.splice(from, 1);
  pieces.splice(to, 0, item);
  steps[at] = { ...step, pieces };
  return withSteps(p, m, steps);
}

/**
 * Moves one piece to `index` (in arrival order) of step `to`: a reorder within its own
 * step or a move into another step. The index counts the target step's other pieces.
 */
export function moveItemTo(p: Plan, m: ModelName, id: string, to: number, index: number): Plan {
  const found = findItem(p, m, id);
  if (!found || !Number.isInteger(to) || to < 0) return p;
  const steps = modelSteps(p, m).map((s, k) => (k === found.step ? { ...s, pieces: s.pieces.filter((i) => i.id !== id) } : s));
  while (steps.length <= to) steps.push({ pieces: [] });
  const pieces = [...steps[to].pieces];
  pieces.splice(Math.max(0, Math.min(pieces.length, Math.round(index))), 0, found.item);
  steps[to] = { ...steps[to], pieces };
  const unchanged = found.step === to && modelSteps(p, m)[to].pieces.every((i, k) => i === pieces[k]);
  return unchanged ? p : withSteps(p, m, steps);
}

/** Adds a piece to step `step` at arrival position `index` (the end when left out). */
export function insertItem(p: Plan, m: ModelName, step: number, item: PlanItem, index?: number): Plan {
  const steps = [...modelSteps(p, m)];
  while (steps.length <= step) steps.push({ pieces: [] });
  const pieces = [...steps[step].pieces];
  pieces.splice(index === undefined ? pieces.length : Math.max(0, Math.min(pieces.length, index)), 0, item);
  steps[step] = { ...steps[step], pieces };
  return withSteps(p, m, steps);
}

/** Split into this step and the step after it; select ids to choose the moved pieces,
 * or automatically split at the midpoint. No part is duplicated or repositioned. */
export function splitStep(p: Plan, m: ModelName, at: number, selectedIds: string[] = []): Plan {
  const steps = [...modelSteps(p, m)];
  const step = steps[at];
  if (!step || step.pieces.length < 2) return p;
  const selected = new Set(selectedIds);
  let earlier: PlanItem[] = [];
  let later: PlanItem[] = [];
  if (selected.size) {
    earlier = step.pieces.filter((i) => !i.id || !selected.has(i.id));
    later = step.pieces.filter((i) => i.id && selected.has(i.id));
  }
  if (!earlier.length || !later.length) {
    const mid = Math.ceil(step.pieces.length / 2);
    earlier = step.pieces.slice(0, mid);
    later = step.pieces.slice(mid);
  }
  // Keep the pause after the entire original step, not halfway through it.
  steps.splice(at, 1, { ...step, pieces: earlier, pauseAfter: undefined }, { pieces: later, pauseAfter: step.pauseAfter });
  return withSteps(p, m, steps);
}

/** Join two consecutive steps, retaining their parts and both sets of notes. */
export function mergeSteps(p: Plan, m: ModelName, first: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!steps[first] || !steps[first + 1]) return p;
  const a = steps[first], b = steps[first + 1];
  steps.splice(first, 2, {
    ...a,
    pieces: [...a.pieces, ...b.pieces],
    title: a.title || b.title,
    notes: [a.notes, b.notes].filter(Boolean).join('\n') || undefined,
    pauseAfter: b.pauseAfter,
  });
  return withSteps(p, m, steps);
}

export function findItem(p: Plan, m: ModelName, id: string): { item: PlanItem; step: number } | null {
  const steps = modelSteps(p, m);
  for (let s = 0; s < steps.length; s++) {
    const item = steps[s].pieces.find((i) => i.id === id);
    if (item) return { item, step: s };
  }
  return null;
}

/** Copies items into the same step, each right after its original, shifted by `d` (studs, plates); returns the copies' ids. */
export function duplicateItems(
  p: Plan,
  m: ModelName,
  ids: string[],
  newId: () => string,
  d: { x: number; y: number; z: number },
): { plan: Plan; ids: string[] } {
  const set = new Set(ids);
  const copies: string[] = [];
  const steps = modelSteps(p, m).map((s) =>
    s.pieces.some((i) => i.id && set.has(i.id))
      ? {
          ...s,
          pieces: s.pieces.flatMap((i) => {
            if (!i.id || !set.has(i.id)) return [i];
            const id = newId();
            copies.push(id);
            return [i, { ...i, id }];
          }),
        }
      : s,
  );
  return { plan: moveItems(withSteps(p, m, steps), m, copies, d), ids: copies };
}

/**
 * Splits step `at` before arrival position `index`: that piece and every one after it
 * become the next step. Nothing moves in space.
 */
export function splitStepAt(p: Plan, m: ModelName, at: number, index: number): Plan {
  const steps = [...modelSteps(p, m)];
  const step = steps[at];
  if (!step || !Number.isInteger(index) || index <= 0 || index >= step.pieces.length) return p;
  steps.splice(at, 1,
    { ...step, pieces: step.pieces.slice(0, index), pauseAfter: undefined },
    { pieces: step.pieces.slice(index), pauseAfter: step.pauseAfter, motion: step.motion });
  return withSteps(p, m, steps);
}

const sameStyle = (a: MotionStyle | undefined, b: MotionStyle | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const tidyStyle = (s: MotionStyle | null | undefined): MotionStyle | undefined => {
  if (!s) return undefined;
  const out = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== null)) as MotionStyle;
  return Object.keys(out).length ? out : undefined;
};

/** Sets (or with null clears) the flight style of one step. */
export function setStepMotion(p: Plan, m: ModelName, at: number, style: MotionStyle | null): Plan {
  const steps = [...modelSteps(p, m)];
  if (!steps[at]) return p;
  const motion = tidyStyle(style);
  if (sameStyle(steps[at].motion, motion)) return p;
  const { motion: _old, ...rest } = steps[at];
  steps[at] = motion ? { ...rest, motion } : rest;
  return withSteps(p, m, steps);
}

/** Sets (or with null clears) the flight style of pieces. */
export function setItemsMotion(p: Plan, m: ModelName, ids: string[], style: MotionStyle | null): Plan {
  const motion = tidyStyle(style);
  const set = new Set(ids);
  if (modelSteps(p, m).every((s) => s.pieces.every((i) => !i.id || !set.has(i.id) || sameStyle(i.assembly?.motion, motion)))) return p;
  return mapItems(p, m, ids, (i) => {
    const { motion: _old, ...assembly } = i.assembly ?? {};
    const next = motion ? { ...assembly, motion } : assembly;
    return { ...i, assembly: Object.keys(next).length ? next : undefined } as PlanItem;
  });
}

/**
 * Sets (or with null clears) the way pieces come in: the outward direction from
 * their seat, in the model's LDraw frame (−Y is up). Stored normalised and rounded,
 * so a tiny nudge back to the same way is not a change.
 */
export function setItemsInsertionAxis(p: Plan, m: ModelName, ids: string[], axis: Vec3 | null): Plan {
  let next: Vec3 | undefined;
  if (axis) {
    const len = Math.hypot(...axis);
    if (!Number.isFinite(len) || len < 1e-6) return p;
    next = axis.map((v) => Math.round((v / len) * 1e4) / 1e4 + 0) as Vec3;
  }
  const same = (a?: Vec3) => (!a && !next) || (!!a && !!next && a.every((v, k) => Math.abs(v - next![k]) < 1e-4));
  const set = new Set(ids);
  if (modelSteps(p, m).every((s) => s.pieces.every((i) => !i.id || !set.has(i.id) || same(i.assembly?.insertionAxis)))) return p;
  return mapItems(p, m, ids, (i) => {
    const { insertionAxis: _old, ...assembly } = i.assembly ?? {};
    const out = next ? { ...assembly, insertionAxis: next } : assembly;
    return { ...i, assembly: Object.keys(out).length ? out : undefined } as PlanItem;
  });
}

/** Sets (or with null clears) the project-wide flight style. */
export function setPlanMotion(p: Plan, style: MotionStyle | null): Plan {
  const motion = tidyStyle(style);
  if (sameStyle(p.motion, motion)) return p;
  const { motion: _old, ...rest } = p;
  return motion ? { ...rest, motion } : rest;
}
