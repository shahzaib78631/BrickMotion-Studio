import { planConstruction,modelFromNodes,compileConstruction } from './construction';
import { decodeTimeline } from './timelineCodec';
import { pathOffset } from './construction/math';
import type { ConstructionPlan } from './construction/types';
import { searchAccessOrder, AccessBudgetExceeded, type AccessEdge } from './accessOrder';
import { rigidWheelPairs, type RigidHardware } from './rigidHardware';
import { wristContact, hairContact, cupGripContact } from './jointContact';
import { transformConnections, connectionGeometryFor } from '../ldraw/connectors';
import * as THREE from 'three';
import type { PlanningProgress } from './planning';
import { factorAffine, type AffineFactors } from './affineTransform';
import type { Box } from '../ldraw/flatten';
import { placementMatrix, transformBox, unionBox, type ANode, type Assembly, type Instance, type Metrics } from '../model/assemble';
import { clamp01, easeInOutCubic, lerp } from './easing';
import { layoutFloor, type FloorItem, type Region } from './floorLayout';
import { choosePacing, SEQUENTIAL_GAP, type AnimOptions, type Pacing } from './pacing';
import { AssemblyPlanningError, buildAssemblyGraph } from './assemblyGraph';
import { intersects, sweptIntersects, rotationPadding } from './sweptBounds';
import { mateAxes, plugAxes, worldSnaps, type WorldSnap } from './snapMates';
import { CLEAR, crossings, nudged, shapeOf, slopNudges, sweepReach, translationClear, UP, waysFor, type Placed, type Way } from './shapes';

const STUD = 20;
const BRICK = 24;
const FLOOR_MARGIN = 2; // studs around the model's footprint kept clear
const SIDE_GAP = 4; // studs between the model area and a side spot
const SETTLE_TIME = 0.03;
const FLOOR_READY_TIME = 0.05;
// A flight first clears the work area, then travels above the existing pieces,
// then lowers into position. Moving sideways while low caused parts to pass
// through the finished model (and each other).
const LIFT_END = 0.24;
const LOWER_START = 0.76;
// A wheel, tyre or an overhung part may have to slide into its socket from
// the side. Lowering everything from above is not collision free.
const SIDE_CRUISE_END = 0.56;
const SIDE_INSERT_START = 0.8;
const ROUTE_SAMPLES = 48;
const FLIGHT_CLEARANCE = 24; // LDraw units (one brick)
const AIR_LANE = 80; // extra height when two airborne trajectories intersect
const CAM_KEY_STEP = 0.2;
const SIDE_REACH = 1.5;
/** Bound event-based reservation retries; a static blockage is reported, never hidden. */
const MAX_POSTPONE = 6;

/** the camera needs this long to move into a submodel close-up (and out of it) */
export const CLOSE_EASE = 0.6;

/** One thing that flies: a single piece, or a finished submodel chunk (the attach). */
/** `box`: the space the flight sweeps (LDU), for the camera */
import type { Unit, SubBuild, CamKey, StepSpan, MoveData, TrackData, TimelineData } from './timelineData';
export type { Unit, SubBuild, CamKey, StepSpan } from './timelineData';
export type Move = MoveData<THREE.Matrix4>;
export type Track = TrackData<THREE.Matrix4>;
export type Timeline = TimelineData & { tracks: Map<string, Track> };

const EMPTY_BOX: Box = { min: [0, -24, 0], max: [20, 0, 20] };

/** Cached affine factors preserve rounded/sheared LDraw geometry throughout a flight. */
const affineCache = new WeakMap<THREE.Matrix4, AffineFactors>();
function affine(matrix: THREE.Matrix4, key = 'part'): AffineFactors {
  let factors = affineCache.get(matrix);
  if (!factors) {
    factors = factorAffine(matrix.elements) ?? undefined;
    if (!factors) throw new AssemblyPlanningError([{
      code: 'invalid-transform', items: [key],
      message: `"${key}" has a singular, non-affine, or non-finite transform. Correct that placement before animating it.`,
    }]);
    affineCache.set(matrix, factors);
  }
  return factors;
}
/** Rotation-free shape, including the source's scale, reflection and shear. */
const naturalBasis = (target: THREE.Matrix4) => new THREE.Matrix4().fromArray(affine(target).shape);
function assertDecomposable(matrix: THREE.Matrix4, key: string): void { affine(matrix, key); }

/**
 * Compact staging like the reference videos. The previous bands often spread a
 * small car's pieces across a huge empty floor; fitting all that empty space in
 * a vertical camera made the actual assembly tiny. Use smaller, tidy staging
 * bands, and let the existing collision-safe windows replenish them as pieces
 * are picked up. The windows NEVER overlap in time on the same floor space.
 */
function bandsAround(box: Box, padArea = 0): Region[] {
  const bx0 = Math.floor(box.min[0] / STUD);
  const bx1 = Math.ceil(box.max[0] / STUD);
  const bz0 = Math.floor(box.min[2] / STUD);
  const bz1 = Math.ceil(box.max[2] / STUD);
  const W = Math.max(1, bx1 - bx0);
  const D = Math.max(1, bz1 - bz0);
  const width = Math.max(W + 2 * FLOOR_MARGIN, 12);
  const depth = Math.max(6, Math.min(
    Math.max(6, Math.ceil(0.9 * Math.max(W, D))),
    Math.max(Math.ceil((1.05 * W * D) / width), Math.ceil((0.33 * padArea) / width)),
  ));
  const x0 = Math.floor((bx0 + bx1) / 2 - width / 2);
  return [
    { x0, z0: bz0 - FLOOR_MARGIN - depth, width, depth }, // front (towards the camera)
    { x0, z0: bz1 + FLOOR_MARGIN, width, depth }, // behind
  ];
}

const regionBox = (r: Region, ground: number): Box => ({
  min: [r.x0 * STUD, ground - BRICK, r.z0 * STUD],
  max: [(r.x0 + r.width) * STUD, ground, (r.z0 + r.depth) * STUD],
});

/**
 * Packs the bands in order. Within a band the used rows are pushed against the
 * model and flipped so the earliest pieces lie furthest out: the floor empties
 * from the outside in, which lets the camera move in during the build.
 * Band 0 lies in front (its edge nearest the model is its max z), band 1 behind.
 */
function layoutBands(items: FloorItem[], bands: Region[]) {
  const pos = new Map<string, { x: number; z: number }>();
  let rest = items;
  bands.forEach((band, bi) => {
    if (!rest.length) return;
    const r = layoutFloor(rest, band);
    const depthOf = new Map(rest.map((i) => [i.id, i.d]));
    let used = 0;
    r.pos.forEach((p, k) => (used = Math.max(used, p.z + depthOf.get(k)! - band.z0)));
    r.pos.forEach((p, k) => {
      const d = depthOf.get(k)!;
      pos.set(k, { x: p.x, z: bi === 0 ? p.z + Math.max(0, band.depth - used) : band.z0 + used - (p.z - band.z0) - d });
    });
    const left = new Set(r.overflow);
    rest = rest.filter((i) => left.has(i.id));
  });
  return { pos, overflow: rest.map((i) => i.id) };
}

/** Splits pieces (in play order) into windows that each fit the bands. */
function windowed(items: FloorItem[], bands: Region[]) {
  const windows: { ids: string[]; pos: Map<string, { x: number; z: number }> }[] = [];
  let i = 0;
  while (i < items.length) {
    let lo = 1;
    let hi = items.length - i;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (layoutBands(items.slice(i, i + mid), bands).overflow.length === 0) lo = mid;
      else hi = mid - 1;
    }
    const best = layoutBands(items.slice(i, i + lo), bands);
    windows.push({ ids: items.slice(i, i + lo).map((it) => it.id), pos: best.pos });
    i += lo;
  }
  return windows;
}

type PlayHints = { requires?: string[]; entryWay?: Way };
type PlayPiece = PlayHints & { kind: 'piece'; rigid?: { key: string; rel: THREE.Matrix4 }[]; rigidKind?: RigidHardware['kind']; key: string; target: THREE.Matrix4; ctx: number; after?: PlayAttach[] };
type PlayAttach = PlayHints & { kind: 'attach'; key: string; keys: string[]; from: THREE.Matrix4; to: THREE.Matrix4; sub: number; after?: PlayAttach[] };
type PlayStep = { units: (PlayPiece | PlayAttach)[]; model: string; index: number; scope: string; pauseAfter: number };
/** `parent`: the context a nested submodel is built inside; its floor is not laid out before the parent's. */
type Ctx = { bands: Region[]; pieces: string[]; group: Map<string, number>; after?: number; parent?: number };

/** Re-planning work allowed after a failed original order (planner progress reports). */
export const DEFAULT_ACCESS_WORK = 1500;

export function buildTimeline(asm: Assembly, metrics: Metrics, opts: AnimOptions, onProgress?: (p: PlanningProgress) => void): Timeline {
  if (opts.planner === 'construction-v2') {
    const model = modelFromNodes(asm.nodes, metrics);
    const construction = planConstruction(model, {
      maxStates: opts.constructionMaxStates,
      maxMilliseconds: opts.constructionMaxMilliseconds,
      supportMode: opts.constructionSupport ?? 'fixture',
      mechanicalSubassemblies: opts.constructionMechanicalSubassemblies,
      onProgress: (p) => onProgress?.({ ...p, phase: p.phase === 'connections' ? 'connections' : p.phase === 'validation' ? 'validation' : 'disassembly' }),
    });
    return decodeTimeline(compileConstruction(construction, opts));
  }

  let retryStart: number | undefined;
  let retryWork = 0;
  // mesh checks depend only on final poses, so every pass (each reorder, the fallback) shares them
  const memo: PlanMemo = { insertion: new Map(), translation: new Map() };
  const work = Number.isFinite(opts.accessSearchWork) ? Math.max(0, Math.min(20000, opts.accessSearchWork!)) : DEFAULT_ACCESS_WORK;
  const milliseconds = opts.accessSearchMilliseconds == null ? Infinity : Number.isFinite(opts.accessSearchMilliseconds) ? Math.max(0, Math.min(10000, opts.accessSearchMilliseconds)) : 0;
  try {
    return searchAccessOrder((edges) => {
      const progress = (p: PlanningProgress) => {
        if (edges.length) {
          // count work, not time, so the result is the same on any machine
          if (++retryWork > work) throw new AccessBudgetExceeded();
          if (milliseconds !== Infinity) {
            retryStart ??= performance.now();
            if (performance.now() - retryStart >= milliseconds) throw new AccessBudgetExceeded();
          }
        }
        onProgress?.(p);
      };
      return planTimeline(asm, metrics, opts, progress, edges, false, memo);
    }, opts.accessSearchAttempts ?? 12);
  } catch (error) {
    // No order gives every piece a certified route. Still animate: blocked pieces
    // take their least-obstructed route and are listed (Unit.uncertified).
    if (!(error instanceof AssemblyPlanningError) || !error.issues.some((i) => i.code === 'blocked-route')) throw error;
    // Keep the reorder that got furthest, so only the pieces it could not fix fall back.
    const best = error.issues.find((i) => i.code === 'blocked-route')?.search?.edges ?? [];
    try { return planTimeline(asm, metrics, opts, onProgress, best, true, memo); }
    catch (retry) { if (!best.length || !(retry instanceof AssemblyPlanningError)) throw retry; }
    return planTimeline(asm, metrics, opts, onProgress, [], true, memo);
  }
}

/** Results of mesh checks, keyed by the exact poses involved; valid for one assembly. */
type PartMetricsLike = ReturnType<Metrics>;
type PlanMemo = { insertion: Map<string, boolean>; translation: Map<string, boolean> };

function planTimeline(asm: Assembly, metrics: Metrics, opts: AnimOptions, onProgress: ((p: PlanningProgress) => void) | undefined, access: AccessEdge[], allowUncertified = false, memo: PlanMemo = { insertion: new Map(), translation: new Map() }): Timeline {
  onProgress?.({ phase: 'preparing', completed: 0, total: asm.instances.length });
  const missing = [...new Set(asm.instances.filter((i) => i.placeholder).map((i) => i.part))];
  if (missing.length) throw new AssemblyPlanningError([{
    code: 'missing-geometry', items: missing,
    message: `Cannot verify assembly without geometry for: ${missing.join(', ')}. Load these model parts and their referenced primitives, then retry. A complete parts-library download is not required.`,
  }]);
  for (const inst of asm.instances) assertDecomposable(inst.world, inst.key);
  const byKey = new Map<string, Instance>(asm.instances.map((i) => [i.key, i]));
  // Connector links from the LDCad shadow library, between parts at their final places.
  const snapCache = new Map<string, WorldSnap[]>();
  const snapsAt = (key: string): WorldSnap[] => {
    let list = snapCache.get(key);
    if (!list) {
      const inst = byKey.get(key);
      list = inst ? worldSnaps(metrics(inst.part).snaps, inst.world.elements) : [];
      snapCache.set(key, list);
    }
    return list;
  };
  const mateCache = new Map<string, [number, number, number][]>();
  /** final-insertion mesh checks, shared by every entry length, wait, retry and pass */
  const insertionMemo = memo.insertion;
  const matesOf = (a: string, b: string): [number, number, number][] => {
    const id = a < b ? `${a}|${b}` : `${b}|${a}`;
    let axes = mateCache.get(id);
    if (!axes) {
      axes = mateAxes(snapsAt(a), snapsAt(b));
      // a part with no connector data still joins a neighbour whose socket it fills
      const uncovered = (k: string) => { const i = byKey.get(k); return !!i && !metrics(i.part).snaps?.length; };
      if (!axes.length && uncovered(a) !== uncovered(b)) {
        const [bare, other] = uncovered(a) ? [a, b] : [b, a];
        axes = plugAxes(snapsAt(other), byKey.get(bare)!.worldBox);
      }
      mateCache.set(id, axes);
    }
    return axes;
  };
  const ground = asm.instances.length ? Math.max(...asm.instances.map((i) => i.worldBox.max[1])) : 0;
  const modelBox = asm.bounds ?? EMPTY_BOX;
  /** footprint plus a 1-stud gap of the pieces placed directly in these nodes */
  const padArea = (nodes: ANode[]) =>
    nodes.reduce((sum, n) => {
      if (n.kind !== 'piece') return sum;
      const b = metrics(n.part).body;
      return sum + (Math.ceil((b.max[0] - b.min[0]) / STUD - 0.01) + 1) * (Math.ceil((b.max[2] - b.min[2]) / STUD - 0.01) + 1);
    }, 0);
  const mainBands = bandsAround(modelBox, padArea(asm.nodes));

  const steps: PlayStep[] = [];
  const ctxs: Ctx[] = [{ bands: mainBands, pieces: [], group: new Map() }];
  const subInfo: { key: string; name: string; closeUp: boolean; firstStep: number; spot: Box; ctx: number }[] = [];
  const closeNames = new Set<string>();
  let sceneBox: Box = unionBox(modelBox, regionBox(mainBands[0], ground));
  sceneBox = unionBox(sceneBox, regionBox(mainBands[1], ground));
  let sideRight = Math.max(modelBox.max[0], (mainBands[0].x0 + mainBands[0].width) * STUD);

  const keyOf = (prefix: string, id: string) => (prefix ? `${prefix}/${id}` : id);
  const keysUnder = (n: ANode, prefix: string): string[] => {
    const k = keyOf(prefix, n.itemId);
    if (n.kind === 'piece') return byKey.has(k) ? [k] : [];
    return n.children.flatMap((c) => keysUnder(c, k));
  };

  /**
   * A model whose file has no STEP lines lists its pieces in no build order, so
   * "bottom-up off" (keep the file order) would ask for an unbuildable sequence.
   * Such a model, and one whose steps were all made by auto-steps, is always built bottom-up.
   */
  const unordered = (nodes: ANode[]) => (nodes.filter((n) => n.kind === 'piece').length > 8 && new Set(nodes.map((n) => n.step)).size === 1) ||
    // layer steps made by auto-steps carry no author order either
    (nodes.length > 0 && nodes.every((n) => n.autoStep));
  const hardware = new Map<string, RigidHardware>();
  /** All steps share a dependency graph; editorial order cannot override a joint. */
  const play = (nodes: ANode[], frame: THREE.Matrix4, prefix: string, ctx: number) => {
    const groups = opts.preassembleKnownWheels === false ? [] : rigidWheelPairs(nodes, metrics);
    const groupOf = new Map(groups.flatMap((g) => g.members.map(({ node }) => [node.itemId, g] as const)));
    const canonicalId = (id: string) => groupOf.get(id)?.root.itemId ?? id;
    for (const g of groups) hardware.set(keyOf(prefix, g.root.itemId), g);
    const graph = buildAssemblyGraph(nodes.filter((n) => !groupOf.has(n.itemId) || groupOf.get(n.itemId)!.root === n).map((n) => {
      const group = groupOf.get(n.itemId);
      let assembly: ANode['assembly'] = n.assembly ? { ...n.assembly,
        after: n.assembly.after?.map(canonicalId),
        attachTo: n.assembly.attachTo ? canonicalId(n.assembly.attachTo) : undefined } : undefined;
      const accessParents = access.filter((e) => e.after === keyOf(prefix, n.itemId)).map((e) => canonicalId(e.before.slice(prefix ? prefix.length + 1 : 0)));
      if (accessParents.length) assembly = { ...assembly, after: [...(assembly?.after ?? []), ...accessParents] };
      return { id: n.itemId, n, part: n.kind === 'piece' ? n.part : undefined,
        step: n.step, order: n.order, assembly, world: placementMatrix(n.local).elements,
        box: transformBox(group?.body ?? n.body, placementMatrix(n.local)),
        contactBox: transformBox(group?.full ?? (n.kind === 'piece' ? metrics(n.part).full : n.body), placementMatrix(n.local)),
        ...(n.kind === 'piece' && !group ? transformConnections(connectionGeometryFor(n.part, metrics(n.part)), placementMatrix(n.local).elements) : {}) };
    }), opts.bottomUp !== false || unordered(nodes));
    const hints = (n: ANode): PlayHints => {
      const axis = n.assembly?.insertionAxis;
      const direction = axis ? new THREE.Vector3(...axis).transformDirection(frame) : null;
      return {
        requires: graph.parents.get(n.itemId)!.map((id) => keyOf(prefix, id)),
        entryWay: direction ? [direction.x, direction.y, direction.z] : undefined,
      };
    };
    // A repaired order may revisit an editorial step. Keep its original label,
    // while scheduling these spans in actual dependency order.
    const spans: ANode[][] = [];
    for (const { n } of graph.ordered) {
      if (!spans.length || spans[spans.length - 1][0].step !== n.step) spans.push([]);
      spans[spans.length - 1].push(n);
    }
    for (const inStep of spans) {
      const s = inStep[0].step;
      const model = inStep[0]?.model ?? '';
      let step: PlayStep = { units: [], model, index: s, scope: prefix, pauseAfter: inStep[0]?.pauseAfter ?? 0 };
      const push = (u: PlayPiece | PlayAttach) => {
        if (pending.length) ((u.after = pending), (pending = []));
        step.units.push(u);
      };
      for (const n of inStep) {
        if (n.kind === 'sub') {
          // the submodel is built aside and attached right away; the rest of the step follows
          if (step.units.length) steps.push(step);
          step = { units: [], model, index: s, scope: prefix, pauseAfter: inStep[0]?.pauseAfter ?? 0 };
          const a = Object.assign(buildSub(n, frame, prefix, ctx), hints(n));
          if (a.keys.length) push(a);
          continue;
        }
        const key = keyOf(prefix, n.itemId);
        const inst = byKey.get(key);
        if (!inst) continue;
        const target = ctx === 0 ? inst.world.clone() : frame.clone().multiply(placementMatrix(n.local));
        push({ kind: 'piece', key, target, ctx, ...hints(n),
          rigid: groupOf.get(n.itemId)?.members.map(({ node, rel }) => ({ key: keyOf(prefix, node.itemId), rel })), rigidKind: groupOf.get(n.itemId)?.kind });
        ctxs[ctx].pieces.push(key);
        ctxs[ctx].group.set(key, steps.length);
      }
      if (step.units.length) steps.push(step);
    }
  };
  /** attach units the next unit played must wait for (the side spot it uses is still occupied) */
  let pending: PlayAttach[] = [];
  const lastAttachAtDepth: PlayAttach[] = [];
  let depth = 0;

  const buildSub = (n: Extract<ANode, { kind: 'sub' }>, parentFrame: THREE.Matrix4, prefix: string, parentCtx: number): PlayAttach => {
    const key = keyOf(prefix, n.itemId);
    const to = parentFrame.clone().multiply(placementMatrix(n.local));
    const basis = naturalBasis(to);
    const b = transformBox(n.body, basis);
    const zMid = (modelBox.min[2] + modelBox.max[2]) / 2;
    const tx = sideRight + SIDE_GAP * STUD - b.min[0];
    const from = new THREE.Matrix4().makeTranslation(tx, ground - b.max[1], zMid - (b.min[2] + b.max[2]) / 2).multiply(basis);
    let spot = transformBox(n.body, from);
    let bands = bandsAround(spot, padArea(n.children));
    // Reserve room for the submodel's FLOOR pieces as well as the assembled
    // chunk. Otherwise the side staging band can overlap main-floor pieces.
    const edge = Math.min(spot.min[0], ...bands.map((r) => r.x0 * STUD));
    const shift = Math.max(0, sideRight + SIDE_GAP * STUD - edge);
    if (shift) {
      from.elements[12] += shift;
      spot = transformBox(n.body, from);
      bands = bandsAround(spot, padArea(n.children));
    }
    const focus = unionBox(unionBox(spot, regionBox(bands[0], ground)), regionBox(bands[1], ground)); // the scene bounds; the camera uses the occupied part
    sceneBox = unionBox(sceneBox, focus);
    const savedRight = sideRight;
    sideRight = Math.max(spot.max[0], focus.max[0]);
    const ctx = ctxs.length;
    ctxs.push({ bands, pieces: [], group: new Map(), parent: parentCtx === 0 ? undefined : parentCtx });
    const sub = subInfo.length;
    // nested submodels are built inside their parent's close-up; copies are built in the wide shot
    const closeUp = depth === 0 && !closeNames.has(n.submodel);
    if (depth === 0) closeNames.add(n.submodel);
    subInfo.push({ key, name: n.submodel, closeUp, firstStep: steps.length, spot, ctx: ctxs.length - 1 });
    const prev = lastAttachAtDepth[depth];
    if (prev) {
      pending = [...pending, prev];
      ctxs[ctx].after = subInfo[prev.sub].ctx; // same side spot and floor: wait until that floor is cleared
    }
    depth++;
    play(n.children, from, key, ctx);
    depth--;
    sideRight = savedRight;
    const attach: PlayAttach = { kind: 'attach', key, keys: keysUnder(n, prefix), from, to, sub };
    lastAttachAtDepth[depth] = attach;
    lastAttachAtDepth.length = depth + 1; // deeper spots are free again for the next parent
    return attach;
  };

  play(asm.nodes, new THREE.Matrix4(), '', 0);

  // --- pacing and schedule ---
  const flat: { u: PlayPiece | PlayAttach; step: number }[] = [];
  steps.forEach((s, si) => s.units.forEach((u) => flat.push({ u, step: si })));
  const pacing = choosePacing(flat.length, steps.length, opts);
  const { intro, outro, flight, slot, stepPause } = pacing;
  // A parent step may be interrupted by a submodel build, so only pause after
  // its LAST unit (rather than each of the step's separate timeline spans).
  const stepKey = (s: PlayStep) => `${s.scope}\u0000${s.model}\u0000${s.index}`;
  const lastOfStep = new Map<string, number>();
  flat.forEach((f, i) => lastOfStep.set(stepKey(steps[f.step]), i));
  const holdAfter = flat.map((f, i) => lastOfStep.get(stepKey(steps[f.step])) === i ? steps[f.step].pauseAfter : 0);
  const totalHold = holdAfter.reduce((sum, n) => sum + n, 0);
  const buildEnd = intro + pacing.build + (steps.length > 1 ? stepPause * (steps.length - 1) : 0) + totalHold;

  const raw: number[] = [];
  if (pacing.mode === 'piece') flat.forEach((f, i) => raw.push(intro + i * slot + f.step * stepPause));
  else if (pacing.mode === 'step') {
    let i = 0;
    steps.forEach((s, si) => {
      const n = s.units.length;
      s.units.forEach((_, k) => (raw[i++] = intro + si * (slot + stepPause) + (n > 1 ? (k / (n - 1)) * 0.4 * slot : 0)));
    });
  } else {
    flat.forEach((f, i) => {
      const b = Math.floor(i / pacing.batchSize);
      raw.push(intro + b * slot + ((i % pacing.batchSize) / pacing.batchSize) * 0.3 * slot + f.step * stepPause);
    });
  }

  // what each unit waits for: earlier units that move the same pieces, and the attach that frees its side spot
  const deps: number[][] = flat.map(() => []);
  const lastUnitOf = new Map<string, number>();
  const indexOf = new Map<PlayPiece | PlayAttach, number>(flat.map((f, i) => [f.u, i]));
  const pieceKeys = (u: PlayPiece): string[] => u.rigid?.map((m) => m.key) ?? [u.key];
  const unitByKey = new Map(flat.flatMap((f, i) => (f.u.kind === 'piece' ? pieceKeys(f.u) : [f.u.key]).map((key) => [key, i] as const)));
  flat.forEach((f, i) => {
    const keys = f.u.kind === 'piece' ? pieceKeys(f.u) : f.u.keys;
    const d = new Set<number>();
    for (const k of keys) {
      const prev = lastUnitOf.get(k);
      if (prev !== undefined) d.add(prev);
      lastUnitOf.set(k, i);
    }
    for (const a of f.u.after ?? []) if (indexOf.has(a)) d.add(indexOf.get(a)!); // its side spot must be free
    for (const key of f.u.requires ?? []) {
      const parent = unitByKey.get(key);
      if (parent === undefined || parent >= i) throw new AssemblyPlanningError([{
        code: 'missing-parent', items: [f.u.key, key], message: `Cannot schedule "${f.u.key}" after missing/unordered parent "${key}".`,
      }]);
      d.add(parent);
    }
    deps[i] = [...d];
  });
  // a close-up's first piece waits until every earlier flight has landed and the camera has moved in
  const holds = new Set(subInfo.filter((si) => si.closeUp).map((si) => flat.findIndex((f) => f.step >= si.firstStep)));
  const schedule = (c: number, dur: number) => {
    const s: number[] = [];
    let end = intro;
    let completedHold = 0;
    flat.forEach((_, i) => {
      if (i > 0) completedHold += holdAfter[i - 1];
      let t = intro + (raw[i] - intro) * c + completedHold;
      if (i > 0) t = Math.max(t, s[i - 1]); // keep play order
      if (i > 0 && pacing.sequential) t = Math.max(t, s[i - 1] + dur + SEQUENTIAL_GAP); // one piece in the air at a time
      // Start a pause only AFTER every earlier in-flight piece has landed.
      if (i > 0 && holdAfter[i - 1] > 0) t = Math.max(t, end + holdAfter[i - 1]);
      for (const d of deps[i]) t = Math.max(t, s[d] + dur + SETTLE_TIME);
      if (holds.has(i)) t = Math.max(t, i > 0 ? end + CLOSE_EASE : CLOSE_EASE);
      s.push(t);
      end = Math.max(end, t + dur);
    });
    return { s, end: end + (holdAfter[holdAfter.length - 1] ?? 0) };
  };
  let starts: number[] = [];
  let actualEnd = buildEnd;
  // A chain of flights that wait on each other (a submodel's pieces, its attach, the next
  // submodel) can be longer than the build; then the video runs longer instead of rushing.
  const flightDur = flight;
  if (flat.length) {
    let lo = 0;
    let hi = 1;
    while (schedule(hi, flightDur).end < buildEnd && hi < 1e6) hi *= 2;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (schedule(mid, flightDur).end <= buildEnd) lo = mid;
      else hi = mid;
    }
    const r = schedule(lo, flightDur);
    starts = r.s;
    actualEnd = Math.max(buildEnd, r.end);
  }
  const units: Unit[] = flat.map((f, i) => ({
    kind: f.u.kind,
    dependsOn: deps[i],
    keys: f.u.kind === 'piece' ? pieceKeys(f.u) : f.u.keys,
    preassembled: f.u.kind === 'piece' && f.u.rigid ? (f.u.rigidKind === 'window' ? 'window + glass' : 'rim + tyre') : undefined,
    start: starts[i],
    dur: flightDur,
    step: f.step,
  }));
  const pieceStart = new Map<string, number>();
  flat.forEach((f, i) => f.u.kind === 'piece' && pieceStart.set(f.u.key, starts[i]));

  // --- floor poses, windows ---
  const tracks = new Map<string, Track>();
  const windowVisibility: { ctx: number; windows: { ids: string[] }[] }[] = [];
  /** when each context's first floor window drops in */
  const firstAppear: number[] = [];
  ctxs.forEach((ctx, ci) => {
    const items: (FloorItem & { color: number })[] = ctx.pieces.map((key) => {
      const inst = byKey.get(key)!;
      const b = transformBox(hardware.get(key)?.body ?? metrics(inst.part).body, naturalBasis(inst.world));
      return {
        id: key,
        w: Math.max(1, Math.ceil((b.max[0] - b.min[0]) / STUD - 0.01)),
        d: Math.max(1, Math.ceil((b.max[2] - b.min[2]) / STUD - 0.01)),
        group: ctx.group.get(key) ?? 0,
        color: inst.color,
      };
    });
    // colour order within ties: layoutFloor keeps the caller's order
    const ordered = items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => a.it.group - b.it.group || a.it.color - b.it.color || a.i - b.i)
      .map((e) => e.it);
    const playOrder = new Map(ctx.pieces.map((k, i) => [k, i]));
    const windows = windowed(
      [...ordered].sort((a, b) => playOrder.get(a.id)! - playOrder.get(b.id)!).map(({ id, w, d, group }) => ({ id, w, d, group })),
      ctx.bands,
    );
    windowVisibility.push({ ctx: ci, windows });
    // ctxs are created parent first, so the parent's first appearance is known here
    // re-layout each window in colour order so similar pieces sit together
    // a copy that reuses a side spot drops its pieces in once the previous copy's floor is empty
    // A repeated side spot is not free when the previous submodel's last
    // constituent takes off: the assembled chunk remains there until its
    // ATTACH flight completes. Do not drop the next batch on top of it.
    const previousSub = subInfo.find((sub) => sub.ctx === ctx.after);
    const previousAttach = previousSub ? flat.findIndex((f) => f.u.kind === 'attach' && f.u.key === previousSub.key) : -1;
    let appear = previousAttach < 0 ? -Infinity : starts[previousAttach] + flightDur;
    if (ctx.parent !== undefined) appear = Math.max(appear, firstAppear[ctx.parent] ?? -Infinity);
    firstAppear[ci] = appear;
    windows.forEach((win, wi) => {
      const set = new Set(win.ids);
      const r = layoutBands(
        ordered.filter((it) => set.has(it.id)).map(({ id, w, d, group }) => ({ id, w, d, group })),
        ctx.bands,
      );
      const pos = r.overflow.length ? win.pos : r.pos;
      if (wi > 0) {
        const prev = windows[wi - 1].ids;
        appear = prev.reduce((m, k) => Math.max(m, (pieceStart.get(k) ?? 0) + flightDur * LIFT_END + 0.01), -Infinity);
      }
      for (const key of win.ids) {
        const inst = byKey.get(key)!;
        const basis = naturalBasis(inst.world);
        const b = transformBox(hardware.get(key)?.body ?? metrics(inst.part).body, basis);
        const p = pos.get(key) ?? { x: ctx.bands[0].x0, z: ctx.bands[0].z0 };
        const floor = new THREE.Matrix4().makeTranslation(p.x * STUD - b.min[0], ground - b.max[1], p.z * STUD - b.min[2]).multiply(basis);
        const rigid = hardware.get(key);
        const entries = rigid?.members.map(({ node, rel }) => ({ key: key.slice(0, key.length - rigid.root.itemId.length) + node.itemId, rel }))
          ?? [{ key, rel: new THREE.Matrix4() }];
        for (const member of entries) {
          const child = byKey.get(member.key)!, pose = floor.clone().multiply(member.rel);
          tracks.set(member.key, { appear, floor: pose, floorBox: transformBox(metrics(child.part).full, pose), ctx: ci, moves: [], final: child.world.clone() });
        }
      }
    });
  });

  // --- moves ---
  const current = new Map<string, THREE.Matrix4>();
  flat.forEach((f, i) => {
    if (f.u.kind === 'piece') {
      const rootFloor = tracks.get(f.u.key)!.floor;
      for (const member of f.u.rigid ?? [{ key: f.u.key, rel: null }]) {
        const tr = tracks.get(member.key)!;
        tr.moves.push({ unit: i, from: rootFloor, to: f.u.target, rel: member.rel, skyY: 0, hold: 0, entry: [0, 0, 0] });
        current.set(member.key, restPose(f.u.target, member.rel));
      }
      return;
    }
    const inv = f.u.from.clone().invert();
    for (const k of f.u.keys) {
      const cur = current.get(k);
      const tr = tracks.get(k);
      if (!cur || !tr) continue;
      const rel = inv.clone().multiply(cur);
      tr.moves.push({ unit: i, from: f.u.from, to: f.u.to, rel, skyY: 0, hold: 0, entry: [0, 0, 0] });
      current.set(k, f.u.to.clone().multiply(rel));
    }
  });
  // A flight's safe cruise height is above everything already built and everything
  // waiting on the floor. It is calculated in build order rather than against the
  // *future* completed tower, which would force early pieces needlessly high.
  let builtTop = Math.min(ground - BRICK, ...[...tracks.values()].map((tr) => tr.floorBox.min[1]));
  const members = units.map(() => [] as { key: string; move: Move; body: Box }[]);
  for (const [key, tr] of tracks)
    for (const mv of tr.moves) members[mv.unit].push({ key, move: mv, body: metrics(byKey.get(key)!.part).full });
  const sweptXY: Box[] = [];
  // Cache the boxes at each assembled target, including the constituent
  // relative transforms of an attach unit. Only contacts already present at
  // the final target may be tolerated at the END of an insertion (e.g. a
  // wheel rim inside the hollow tyre); other bricks must never be crossed.
  const destinationBoxes = members.map((group) => group.map(({ move, body }) =>
    transformBox(body, restPose(move.to, move.rel)),
  ));
  const restAfterMove = new Map<Move, Box>();
  for (const group of members) for (const { move, body } of group)
    restAfterMove.set(move, transformBox(body, restPose(move.to, move.rel)));
  // An attach moves a whole submodel rigidly. Checking its hundreds of member
  // boxes one by one made large models (a train, a building) take minutes to
  // plan. Collision checks use ONE conservative box for the rigid group: the
  // union of every member box expressed in the attach's own frame.
  const proxies: Member[][] = members.map((group, i) => {
    if (units[i].kind !== 'attach' || group.length <= 1) return group;
    const first = group[0].move;
    let local: Box | null = null;
    for (const { move, body } of group) local = unionBox(local, move.rel ? transformBox(body, move.rel) : body);
    const move: Move = { unit: i, from: first.from, to: first.to, rel: null, skyY: 0, hold: 0, entry: [0, 0, 0] };
    return [{ key: group[0].key, move, body: local ?? EMPTY_BOX }];
  });
  /** coarse swept boxes of units whose flight is already decided (they never change again) */
  const settledPhases: (PhaseBox[] | null)[] = units.map(() => null);

  // Recalculate when new pieces may safely occupy a reused floor band. A
  // piece that has merely STARTED rising is still in the space where the next
  // window drops in. The band isn't empty until the last piece clears it.
  const refreshAppear = () => {
  for (const { ctx, windows } of windowVisibility) {
    const previousSub = subInfo.find((sub) => sub.ctx === ctxs[ctx].after);
    const previousAttach = previousSub ? flat.findIndex((f) => f.u.kind === 'attach' && f.u.key === previousSub.key) : -1;
    let appear = previousAttach < 0 ? -Infinity : units[previousAttach].start + units[previousAttach].dur;
    const parent = ctxs[ctx].parent;
    if (parent !== undefined) appear = Math.max(appear, firstAppear[parent] ?? -Infinity);
    firstAppear[ctx] = appear;
    for (const win of windows) {
      for (const key of win.ids) {
        const unit = tracks.get(key)!.moves[0].unit;
        for (const member of units[unit].keys) tracks.get(member)!.appear = appear;
      }
      appear = win.ids.reduce((latest, key) => {
        const move = tracks.get(key)!.moves[0];
        const unit = units[move.unit];
        return Math.max(latest, unit.start + unit.dur + FLOOR_READY_TIME);
      }, -Infinity);
    }
  }
  };
  refreshAppear();
  /**
   * Later pieces of the blocked unit's step that sit on the same side of the
   * blockers (below a chassis, behind a wall) and under their footprint: they
   * will be blocked the same way, so the access search reorders them together.
   */
  const blockedPeers = (i: number, blockers: string[]): string[] => {
    const own = byKey.get(units[i].keys[0])?.worldBox;
    if (!own) return [];
    const walls = blockers.map((k) => byKey.get(k)?.worldBox).filter((b): b is Box => !!b);
    const side = (a: Box, b: Box) => {
      // the axis and direction that separate a from b the most
      let best = -Infinity, axis = 0, dir = 0;
      for (let k = 0; k < 3; k++) {
        if (b.min[k] - a.max[k] > best) [best, axis, dir] = [b.min[k] - a.max[k], k, -1];
        if (a.min[k] - b.max[k] > best) [best, axis, dir] = [a.min[k] - b.max[k], k, 1];
      }
      return { axis, dir };
    };
    const sides = walls.map((w) => side(own, w));
    const out: string[] = [];
    for (let j = i + 1; j < units.length; j++) {
      const u = units[j];
      if (u.step !== units[i].step) continue;
      const box = byKey.get(u.keys[0])?.worldBox;
      if (!box) continue;
      const same = walls.some((w, n) => {
        const s = side(box, w);
        const across = [0, 1, 2].filter((k) => k !== s.axis).every((k) => Math.min(box.max[k], w.max[k]) - Math.max(box.min[k], w.min[k]) > 0);
        return s.axis === sides[n].axis && s.dir === sides[n].dir && across;
      });
      if (same) out.push(u.keys[0]);
    }
    return out;
  };
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const report = () => onProgress?.({ phase: 'routing', completed: i, total: units.length, item: `${u.keys[0]} (part ${byKey.get(u.keys[0])?.part ?? 'subassembly'})` });
    report();
    const ready = Math.max(u.start, ...members[i].map(({ key }) => tracks.get(key)!.appear + FLOOR_READY_TIME),
      ...deps[i].map((j) => units[j].start + units[j].dur + SETTLE_TIME));
    if (ready > u.start) {
      const delay = ready - u.start;
      for (let k = i; k < units.length; k++) units[k].start += delay;
      refreshAppear();
    }
    let top = builtTop;
    let bottomOffset = -Infinity;
    let extent = 0;
    let sweep: Box | null = null;
    for (const { move: mv, body } of members[i]) {
      const fromBox = transformBox(body, restPose(mv.from, mv.rel));
      const toBox = transformBox(body, restPose(mv.to, mv.rel));
      const fromY = mv.from.elements[13];
      const toY = mv.to.elements[13];
      top = Math.min(top, fromBox.min[1], toBox.min[1]);
      bottomOffset = Math.max(bottomOffset, fromBox.max[1] - fromY, toBox.max[1] - toY);
      if (turns(mv)) bottomOffset = Math.max(bottomOffset, memberRadius(body, mv));
      extent = Math.max(extent, fromBox.max[1] - fromBox.min[1], toBox.max[1] - toBox.min[1]);
      sweep = unionBox(sweep, unionBox(fromBox, toBox));
    }
    const skyY = top - FLIGHT_CLEARANCE - (Number.isFinite(bottomOffset) ? bottomOffset : 0);
    builtTop = Math.min(builtTop, top);
    const dst = destinationBoxes[i].reduce<Box | null>((box, next) => unionBox(box, next), null) ?? EMPTY_BOX;

    // Look at pieces that are NOT flying at this time. Previously the planner
    // only called flightsIntersect(), so a tyre could fall straight THROUGH
    // the already assembled car body without triggering any collision.
    // A track may rest first on the floor, later on a submodel's side spot,
    // and finally in the model. Preserve those time intervals individually.
    let safe = false;
    /** best-effort route when nothing certifies: the entry the fewest neighbours object to */
    let fallback: { entry: [number, number, number]; rejects: number } | null = null;
    const missingInsertionParts = new Set<string>();
    const rejectedBy = new Map<string, string>();
    const accessBlockers = new Set<string>();
    const recordBlock = (block: RestingBlock, stage: string) => {
      if (block.assembled && block.end === Infinity && accessBlockers.size < 8) accessBlockers.add(block.key);
      const id = `${block.key}|${stage}`;
      if (rejectedBy.size < 8) rejectedBy.set(id, `${block.key} (part ${block.part}, ${stage})`);
    };
    // If every route is blocked right now (typically: too many parts in the air
    // at once), wait a little and try again rather than hiding the part. The rest
    // of the build shifts with it, so the step order is kept.
    for (let attempt = 0; ; attempt++) {
      const blockers: RestingBlock[] = [];
      for (const [key, tr] of tracks) {
        if (u.keys.includes(key)) continue;
        const part = byKey.get(key)!.part;
        let previousEnd = tr.appear;
        let pose = tr.floor;
        let rest = transformBox(metrics(part).full, pose);
        let restAt: Move | null = null;
        const addRest = (end: number) => {
          if (end > previousEnd && end > u.start && previousEnd < u.start + u.dur)
            blockers.push({ key, box: rest, start: previousEnd, end, pose, part, assembled: restAt !== null });
        };
        for (const mv of tr.moves) {
          // An unplanned launch can be delayed later. Never certify a route on
          // the assumption that a future floor piece has already taken off.
          if (mv.unit >= i) break;
          const flight = units[mv.unit];
          addRest(flight.start);
          previousEnd = flight.start + flight.dur;
          rest = restAfterMove.get(mv)!;
          pose = restPose(mv.to, mv.rel);
          restAt = mv;
        }
        addRest(Infinity);
      }

      // A narrow upright round part (e.g. an LDraw tyre oriented on an axle)
      // should be inserted along its thin horizontal axis, not dropped onto the
      // axle from the roof. Prefer the nearer outer side of the model.
      const spans = [0, 1, 2].map((axis) => dst.max[axis] - dst.min[axis]);
      // ...but a piece seated on top of something already built (a minifig torso on
      // the hips) goes on from above, however thin it is.
      const resting = blockers.filter((b) => b.end === Infinity).map((b) => b.box);
      const narrowSide = u.kind === 'piece' && seatedOn(dst, resting) ? undefined : [0, 2].find((axis) =>
        spans[axis] < Math.min(spans[1], spans[axis === 0 ? 2 : 0]) * 0.7,
      );
      /** the way a piece comes in from (unit vector; it moves along the opposite way to land) */
      type Dir = [number, number, number];
      const axisDir = (axis: number, dir: number): Dir => [axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0];
      const sides: Dir[] = [];
      const orderedSide = (axis: 0 | 2) => {
        const middle = (dst.min[axis] + dst.max[axis]) / 2;
        const sceneMiddle = (modelBox.min[axis] + modelBox.max[axis]) / 2;
        const outer = middle < sceneMiddle ? -1 : 1;
        sides.push(axisDir(axis, outer), axisDir(axis, -outer));
      };
      if (narrowSide !== undefined) orderedSide(narrowSide as 0 | 2);
      if (narrowSide !== 0) orderedSide(0);
      if (narrowSide !== 2) orderedSide(2);
      // Generate plausible directions without applying a second, inconsistent
      // collision policy here. The SAME per-pair insertion predicate below
      // checks both candidate directions and the final flight's seating phase.
      const slide = u.kind === 'piece' ? slideAxis(dst, resting) : null;
      // Along the axis of a connector it joins (pin into hole, axle into clip), both ways.
      const connectorWays: Dir[] = [];
      if (u.kind === 'piece')
        for (const block of blockers)
          if (block.end === Infinity && boxesTouch(dst, block.box))
            for (const member of members[i])
              for (const a of matesOf(member.key, block.key))
                for (const w of [a, [-a[0], -a[1], -a[2]] as Dir])
                  if (!connectorWays.some((o) => o[0] * w[0] + o[1] * w[1] + o[2] * w[2] > 1 - 1e-6)) connectorWays.push(w);
      const boxWays: Dir[] = [...(slide ? [axisDir(slide[0], slide[1])] : []), ...connectorWays, ...(narrowSide !== undefined ? sides.slice(0, 2) : []), UP, ...sides];
      const explicitWay = flat[i].u.entryWay;
      const directions: Iterable<Dir> = explicitWay ? [explicitWay] : u.kind === 'piece'
        ? waysFor(restPose(members[i][0].move.to, members[i][0].move.rel), boxWays) : boxWays;

      const overlaps = [] as number[];
      for (let j = 0; j < i; j++) {
        if (units[j].start >= u.start + u.dur || units[j].start + units[j].dur <= u.start) continue;
        if (members[i].some((p) => members[j].some((q) => p.key === q.key))) continue;
        overlaps.push(j);
      }

      // Try sensible insertion sides, flight lanes and small takeoff holds.
      // Check stationary as well as airborne parts on every candidate path.
      // Where each final slide starts: outside the whole model along the way (clear
      // of everything), else just clear of the touching pieces (a tilted minifig hand
      // slides a short way into its wrist). Never from under the floor.
      // Generate candidates lazily: a successful stud-aligned path should not
      // pay for every alternative mesh direction before it is even attempted.
      function* entries(): Generator<Dir> {
        const seen: Dir[] = [];
        let triedUp = false;
        for (const way of directions) {
          if (Math.abs(way[0]) < 1e-8 && Math.abs(way[2]) < 1e-8 && way[1] < 0) {
            if (!triedUp) { triedUp = true; yield [0, 0, 0]; }
            continue;
          }
          const clearOf = (boxes: Box[]) => boxes.reduce((far, b) => {
            let d = Infinity;
            for (let k = 0; k < 3; k++) {
              if (way[k] > 1e-6) d = Math.min(d, (b.max[k] - dst.min[k]) / way[k]);
              else if (way[k] < -1e-6) d = Math.min(d, (dst.max[k] - b.min[k]) / -way[k]);
            }
            return Math.max(far, d);
          }, 0);
          const around = blockers.filter((b) => b.end === Infinity && boxesTouch(dst, b.box)).map((b) => b.box);
          // Small joints need short entries; forcing every joint to approach
          // from two studs away can push a tilted wrist below the floor.
          const lengths = [Math.max(4, clearOf(around) + 0.6), 4, 8, 12, 20,
            ...[clearOf(around), clearOf([modelBox])].map((d) => Math.max(2 * STUD, d + FLIGHT_CLEARANCE))];
          for (const len of lengths) {
            if (dst.max[1] + way[1] * len > ground + 0.5) continue;
            if (seen.some((e) => Math.hypot(e[0] - way[0] * len, e[1] - way[1] * len, e[2] - way[2] * len) < 1e-6)) continue;
            const entry: Dir = [way[0] * len, way[1] * len, way[2] * len];
            seen.push(entry);
            yield entry;
          }
        }
      }
      const insertionCache = new Map<string, boolean>();
      const insertionAllowed = (member: Member, block: RestingBlock): boolean => {
        const way: Way = member.move.entry.some((n) => n !== 0)
          ? new THREE.Vector3(...member.move.entry).normalize().toArray() as Way : UP;
        const id = `${member.key}|${block.key}|${member.move.entry.join(',')}`;
        let clear = insertionCache.get(id);
        if (clear !== undefined) return clear;
        const holder = (flat[i].u.requires ?? []).some((key) => block.key === key || block.key.startsWith(`${key}/`)) ||
          matesOf(member.key, block.key).length > 0;
        for (const part of [byKey.get(member.key)!.part, block.part]) {
          const geometry = metrics(part);
          if (geometry.placeholder || !geometry.mesh?.length) missingInsertionParts.add(part);
        }
        clear = verifiedInsertion(member, block, way, metrics, byKey, holder, insertionMemo);
        insertionCache.set(id, clear);
        return clear;
      };
      /** some way in failed only for reasons that waiting for other flights can change */
      let transient = false;
      for (const entry of entries()) {
        report();
        for (const { move } of [...members[i], ...proxies[i]]) move.entry = entry;
        const arrival = u.start + u.dur;
        // Cache and precheck FINAL contacts before trying thirty cruise/hold
        // variations. Never sum independent connector scores into one budget.
        const blockedSeat = members[i].some((member, k) => blockers.some((block) => {
          if (!block.assembled || block.start > arrival || block.end < arrival || !boxIntersects(destinationBoxes[i][k], block.box)) return false;
          if (insertionAllowed(member, block)) return false;
          recordBlock(block, 'final insertion');
          return true;
        }));
        if (blockedSeat) {
          if (allowUncertified) {
            const rejects = members[i].reduce((n, member, k) => n + blockers.filter((block) =>
              block.assembled && block.start <= arrival && block.end >= arrival && boxIntersects(destinationBoxes[i][k], block.box) &&
              !insertionAllowed(member, block)).length, 0);
            if (!fallback || rejects < fallback.rejects) fallback = { entry, rejects };
          }
          continue;
        }
        if (allowUncertified && (!fallback || fallback.rejects > 0)) fallback = { entry, rejects: 0 };
        const routeSweep = destinationBoxes[i].reduce<Box | null>((box, next, k) => {
          const { move: mv, body } = members[i][k];
          const approach = mv.to.clone();
          approach.elements[12] += entry[0];
          approach.elements[13] += entry[1];
          approach.elements[14] += entry[2];
          const start = transformBox(body, restPose(mv.from, mv.rel));
          return unionBox(unionBox(box, next), unionBox(start, transformBox(body, restPose(approach, mv.rel))));
        }, null) ?? EMPTY_BOX;
        // A rotating piece can protrude beyond the boxes at either endpoint.
        const radius = members[i].reduce((r, { body, move }) => {
          if (!turns(move)) return r;
          const rel = move.rel ? transformBox(body, move.rel) : body;
          const radius = memberRadius(body, move);
          return Math.max(r, 2 * radius);
        }, 0);
        const expandedSweep = radius > 0 ? {
          min: [routeSweep.min[0] - radius, routeSweep.min[1], routeSweep.min[2] - radius],
          max: [routeSweep.max[0] + radius, routeSweep.max[1], routeSweep.max[2] + radius],
        } as Box : routeSweep;
        const near = blockers.filter((block) =>
          block.end > u.start && block.start < u.start + u.dur && xyIntersects(block.box, expandedSweep),
        );
        // The last slide into place does not depend on the flight lane or the
        // takeoff delay: once a piece already built blocks it, this way is out.
        let corridorBlocked = false;
        const recordRoute = (block: RestingBlock, stage: string) => {
          recordBlock(block, stage);
          if (stage === 'insertion corridor' && block.assembled && block.end === Infinity) corridorBlocked = true;
        };
        for (let lane = 0; lane < 5 && !safe && !corridorBlocked; lane++) {
          const laneHeight = skyY - lane * Math.max(AIR_LANE, extent + FLIGHT_CLEARANCE);
          for (const hold of [0, 0.12, 0.24, 0.36, 0.48, 0.6]) {
            if (corridorBlocked) break;
            for (const { move: mv } of [...members[i], ...proxies[i]]) {
              mv.skyY = laneHeight;
              mv.hold = hold;
              mv.entry = entry;
            }
            // Compound AABBs are broad-phase only: gaps inside a subassembly
            // must not grant its solid members permission to cross an obstacle.
            if (routeHitsResting(u, members[i], destinationBoxes[i], near, insertionAllowed, recordRoute,
              (member, block, a, b) => verifiedTranslation(member, block, a, b, metrics, byKey, memo.translation))) continue;
            const phases = phaseBoxes(u, proxies[i]);
            if (overlaps.some((j) =>
              xyIntersects(expandedSweep, sweptXY[j]) &&
              phasesIntersect(phases, (settledPhases[j] ??= phaseBoxes(units[j], proxies[j]))) &&
              flightsIntersect(units, proxies, i, j))) continue;
            sweep = expandedSweep;
            safe = true;
            break;
          }
        }
        if (!corridorBlocked) transient = true;
        if (safe) break;
      }
      // Pieces already built never move: if they block every way, waiting is useless.
      if (safe || attempt >= MAX_POSTPONE || !transient) break;
      // Wait for actual reservations to clear, not arbitrary retry increments.
      const event = Math.max(u.start, ...overlaps.map((j) => units[j].start + units[j].dur + SETTLE_TIME));
      if (event <= u.start + 1e-8) break;
      const delay = event - u.start;
      for (let k = i; k < units.length; k++) units[k].start += delay;
      refreshAppear();
    }
    if (!safe && allowUncertified) {
      // Shown, never hidden: it flies at the top lane and enters the least-obstructed way.
      u.uncertified = true;
      for (const { move: mv } of [...members[i], ...proxies[i]]) {
        mv.entry = fallback?.entry ?? [0, 0, 0];
        mv.skyY = skyY;
        mv.hold = 0;
      }
      safe = true;
    }
    if (!safe) throw new AssemblyPlanningError([{
      code: 'blocked-route', items: u.keys,
      access: { moving: u.keys[0], blockers: [...accessBlockers], completed: i, total: units.length, peers: blockedPeers(i, [...accessBlockers]) },
      message: `No verified rigid insertion path for ${u.keys.map((key) => `${key} (part ${byKey.get(key)?.part ?? "subassembly"})`).join(', ')}. Check its final placement, parent, and insertionAxis; move enclosing parts to a later step or build a subassembly.${missingInsertionParts.size ? ` Missing collision meshes: ${[...missingInsertionParts].sort().join(', ')}. Overlapping connector bounds cannot be certified without these meshes.` : ' The available geometry did not certify any of the tested routes.'}${rejectedBy.size ? ` Blocking contacts: ${[...rejectedBy.values()].join('; ')}.` : ''} No part was hidden or teleported.`,
    }]);
    sweptXY[i] = sweep ?? EMPTY_BOX;
  }
  refreshAppear();
  // Keep the remainder of the timeline, submodel labels and outro aligned if
  // an exceptional collision forced a launch to be postponed.
  for (let i = 0; i < units.length; i++) starts[i] = units[i].start;
  actualEnd = Math.max(actualEnd, ...units.map((u) => u.start + u.dur));

  onProgress?.({ phase: 'routing', completed: units.length, total: units.length });
  onProgress?.({ phase: 'camera', completed: 0, total: units.length });
  // --- what the camera must see ---
  const launch = (tr: Track) => (tr.moves.length ? units[tr.moves[0].unit].start : Infinity);
  const occupied = (ctx: number) => [...tracks.values()].filter((tr) => tr.ctx === ctx);

  const subBuilds: SubBuild[] = subInfo.map((s) => {
    const attachIdx = flat.findIndex((f) => f.u.kind === 'attach' && f.u.key === s.key);
    const firstIdx = flat.findIndex((f) => f.step >= s.firstStep);
    const attachStart = attachIdx >= 0 ? starts[attachIdx] : buildEnd;
    return {
      key: s.key,
      name: s.name,
      closeUp: s.closeUp,
      start: firstIdx >= 0 ? starts[firstIdx] : attachStart,
      attachStart,
      attachEnd: attachStart + flightDur,
      focus: occupied(s.ctx).reduce((b, tr) => unionBox(b, tr.floorBox), s.spot),
    };
  });

  // Include the ascent, air lane and descent (not just the two endpoints)
  // so a wide-shot camera doesn't cut off a high-flying brick.
  const flightBox: (Box | null)[] = units.map(() => null);
  const landBox: (Box | null)[] = units.map(() => null);
  for (const group of members)
    for (const { move: mv, body } of group) {
      if (units[mv.unit].hidden) continue;
      const end = transformBox(body, flightPose(mv, 1, new THREE.Matrix4()));
      landBox[mv.unit] = landBox[mv.unit] ? unionBox(landBox[mv.unit]!, end) : end;
      for (const u of [0, LIFT_END, 0.5, SIDE_CRUISE_END, LOWER_START, SIDE_INSERT_START, 1]) {
        const b = transformBox(body, flightPose(mv, u, new THREE.Matrix4()));
        flightBox[mv.unit] = flightBox[mv.unit] ? unionBox(flightBox[mv.unit]!, b) : b;
      }
    }

  units.forEach((u, i) => ((u.box = flightBox[i]), (u.land = landBox[i])));

  // The wide shot keeps the model, the pieces still on the floor, every flight in progress and
  // any side spot in use in view. A side spot is kept from SIDE_REACH before its build until
  // SIDE_REACH after its attach, so submodels built one after another widen the view once.
  // (Submodel close-ups are chosen by the camera from subBuilds and the units' flight boxes.)
  let buildBox = modelBox;
  for (const tr of tracks.values()) buildBox = unionBox(buildBox, tr.floorBox);
  const camKeys: CamKey[] = [];
  const camEnd = flat.length ? actualEnd : intro;
  for (let t = 0; t <= camEnd + 1e-9; t += CAM_KEY_STEP) {
    let box = modelBox;
    for (const tr of tracks.values()) if (tr.appear <= t && t < launch(tr)) box = unionBox(box, tr.floorBox);
    units.forEach((u, i) => {
      if (flightBox[i] && u.start < t + CAM_KEY_STEP && u.start + u.dur > t - CAM_KEY_STEP) box = unionBox(box, flightBox[i]!);
    });
    for (const sb of subBuilds) if (t >= sb.start - SIDE_REACH && t <= sb.attachEnd + SIDE_REACH) box = unionBox(box, sb.focus);
    camKeys.push({ t, box });
  }

  const stepSpans: StepSpan[] = steps.map((st) => ({ model: st.model, index: st.index, start: Infinity, end: -Infinity }));
  units.forEach((u) => {
    const sp = stepSpans[u.step];
    sp.start = Math.min(sp.start, u.start);
    sp.end = Math.max(sp.end, u.start + u.dur);
  });

  return {
    duration: (flat.length ? actualEnd : intro) + outro,
    steps: stepSpans.filter((sp) => sp.end > sp.start),
    pacing,
    heroOrbit: opts.heroOrbit,
    intro,
    buildEnd: flat.length ? actualEnd : intro,
    units,
    subBuilds,
    buildBox,
    modelBox,
    sceneBox,
    camKeys,
    ground,
    tracks,
  };
}

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _unitScale = new THREE.Vector3(1, 1, 1);

type Decomposed = { p0: THREE.Vector3; q0: THREE.Quaternion; p1: THREE.Vector3; q1: THREE.Quaternion; shape: THREE.Matrix4 };
/** A move's endpoints never change after planning; decompose them once. */
const decomposed = new WeakMap<THREE.Matrix4, WeakMap<THREE.Matrix4, Decomposed>>();
/** blockers touching a piece's spot this closely (LDU) are checked with real shapes */
const NEAR = 1;
const boxesTouch = (a: Box, b: Box) => [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > -NEAR);

/**
 * Whether a piece at `dst` sits on top of one of the `built` boxes: they overlap, and
 * that piece lies clearly lower (LDraw −Y is up) — not level with it, like a rim inside a tyre.
 */
export function seatedOn(dst: Box, built: Box[]): boolean {
  const mid = (dst.min[1] + dst.max[1]) / 2;
  const quarter = (dst.max[1] - dst.min[1]) / 4;
  return built.some((b) =>
    [0, 1, 2].every((k) => Math.min(dst.max[k], b.max[k]) - Math.max(dst.min[k], b.min[k]) > 1) &&
    (b.min[1] + b.max[1]) / 2 > mid + quarter,
  );
}

/** stud height: a piece clipped on by its studs overlaps what holds it by no more than this */
const STUD_GRIP = 8;

/**
 * The side to slide a piece in from when it sits deep inside the piece holding it
 * (overlapping it by more than a stud's grip): along the axis it sticks out of that
 * holder most, from that side. Null for ordinary stacked bricks (they go on from
 * above) and for pieces hanging below their holder.
 */
export function slideAxis(dst: Box, built: Box[]): [number, number] | null {
  let best: { box: Box; volume: number } | null = null;
  for (const box of built) {
    const o = [0, 1, 2].map((k) => Math.min(dst.max[k], box.max[k]) - Math.max(dst.min[k], box.min[k]));
    if (o.some((v) => v <= 1)) continue;
    const deep = o[1] > STUD_GRIP && o[1] > 0.5 * Math.min(dst.max[1] - dst.min[1], box.max[1] - box.min[1]);
    if (!deep) continue;
    const volume = o[0] * o[1] * o[2];
    if (!best || volume > best.volume) best = { box, volume };
  }
  if (!best) return null;
  const d = [0, 1, 2].map((k) => (dst.min[k] + dst.max[k]) / 2 - (best!.box.min[k] + best!.box.max[k]) / 2);
  const axis = [0, 1, 2].reduce((a, k) => (Math.abs(d[k]) > Math.abs(d[a]) ? k : a), 0);
  if (axis === 1) return d[1] < 0 ? [1, -1] : null;
  return [axis, Math.sign(d[axis]) || 1];
}

function endpointPair(from: THREE.Matrix4, to: THREE.Matrix4): Decomposed {
  let inner = decomposed.get(from);
  if (!inner) decomposed.set(from, (inner = new WeakMap()));
  let d = inner.get(to);
  if (!d) {
    const a = affine(from), b = affine(to);
    const magnitude = Math.max(1, ...a.shape.map(Math.abs), ...b.shape.map(Math.abs));
    if (a.shape.some((value, i) => Math.abs(value - b.shape[i]) > 1e-7 * magnitude))
      throw new AssemblyPlanningError([{ code: 'invalid-transform', items: [], message: 'A flight would change the part shape between staging and attachment. Its scale/shear must stay fixed.' }]);
    d = {
      p0: new THREE.Vector3(...a.position), p1: new THREE.Vector3(...b.position),
      q0: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(a.rotation)).normalize(),
      q1: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(b.rotation)).normalize(),
      shape: new THREE.Matrix4().fromArray(b.shape),
    };
    inner.set(to, d);
  }
  return d;
}
function endpoints(m: Move): Decomposed { return endpointPair(m.from, m.to); }

export function flightPose(m: Move, u: number, out: THREE.Matrix4): THREE.Matrix4 {
  u = clamp01((u - m.hold) / (1 - m.hold));
  if (u <= 0 || u >= 1) {
    out.copy(u <= 0 ? m.from : m.to);
    if (m.rel) out.multiply(m.rel);
    return out;
  }
  if (m.translationPath) {
    const offset = pathOffset(m.translationPath, easeInOutCubic(u));
    out.copy(m.from);
    out.elements[12] += offset[0]; out.elements[13] += offset[1]; out.elements[14] += offset[2];
    if (m.rel) out.multiply(m.rel);
    return out;
  }
  if (m.posePath?.length) {
    if (m.posePath.length < 2) {
      out.copy(m.posePath[0] ?? m.from);
      if (m.rel) out.multiply(m.rel);
      return out;
    }
    const scaled = easeInOutCubic(u) * (m.posePath.length - 1);
    const i = Math.min(m.posePath.length - 2, Math.floor(scaled));
    const local = Math.max(0, Math.min(1, scaled - i));
    const d = endpointPair(m.posePath[i], m.posePath[i + 1]);
    _p0.copy(d.p0).lerp(d.p1, local);
    _q0.copy(d.q0).slerp(d.q1, local);
    out.compose(_p0, _q0, _unitScale).multiply(d.shape);
    if (m.rel) out.multiply(m.rel);
    return out;
  }
  const d = endpoints(m);
  _p0.copy(d.p0);
  _q0.copy(d.q0);
  _p1.copy(d.p1);
  _q1.copy(d.q1);
  const lateral = m.entry.some((v) => v !== 0);
  if (u < LIFT_END) {
    _p0.y = lerp(_p0.y, m.skyY, easeInOutCubic(clamp01(u / LIFT_END)));
    out.compose(_p0, _q0, _unitScale).multiply(d.shape);
  } else if (lateral) {
    if (u < SIDE_CRUISE_END) {
      const e = easeInOutCubic(clamp01((u - LIFT_END) / (SIDE_CRUISE_END - LIFT_END)));
      _p0.set(lerp(_p0.x, _p1.x + m.entry[0], e), m.skyY, lerp(_p0.z, _p1.z + m.entry[2], e));
      _q0.slerp(_q1, e);
      out.compose(_p0, _q0, _unitScale).multiply(d.shape);
    } else if (u < SIDE_INSERT_START) {
      const e = easeInOutCubic(clamp01((u - SIDE_CRUISE_END) / (SIDE_INSERT_START - SIDE_CRUISE_END)));
      _p1.set(_p1.x + m.entry[0], lerp(m.skyY, _p1.y + m.entry[1], e), _p1.z + m.entry[2]);
      out.compose(_p1, _q1, _unitScale).multiply(d.shape);
    } else {
      const e = easeInOutCubic(clamp01((u - SIDE_INSERT_START) / (1 - SIDE_INSERT_START)));
      _p1.set(_p1.x + m.entry[0] * (1 - e), _p1.y + m.entry[1] * (1 - e), _p1.z + m.entry[2] * (1 - e));
      out.compose(_p1, _q1, _unitScale).multiply(d.shape);
    }
  } else if (u < LOWER_START) {
    const e = easeInOutCubic(clamp01((u - LIFT_END) / (LOWER_START - LIFT_END)));
    _p0.set(lerp(_p0.x, _p1.x, e), m.skyY, lerp(_p0.z, _p1.z, e));
    _q0.slerp(_q1, e);
    out.compose(_p0, _q0, _unitScale).multiply(d.shape);
  } else {
    _p1.y = lerp(m.skyY, _p1.y, easeInOutCubic(clamp01((u - LOWER_START) / (1 - LOWER_START))));
    out.compose(_p1, _q1, _unitScale).multiply(d.shape);
  }
  if (m.rel) out.multiply(m.rel);
  return out;
}

/** Static time-window that a flying member must not cross. */
/** `pose`/`part`: where the resting piece is and what it is, for real-shape checks */
type RestingBlock = { key: string; box: Box; start: number; end: number; pose: THREE.Matrix4; part: string; assembled: boolean };
type Member = { key: string; move: Move; body: Box };
/** A conservative box that a unit's members stay inside between two times. */
type PhaseBox = { t0: number; t1: number; box: Box };


const turns = (move: Move): boolean => endpoints(move).q0.angleTo(endpoints(move).q1) > 1e-7;

const radiusCache = new WeakMap<Move, WeakMap<Box, number>>();
function memberRadius(body: Box, move: Move): number {
  let cache = radiusCache.get(move);
  if (!cache) radiusCache.set(move, (cache = new WeakMap()));
  let radius = cache.get(body);
  if (radius === undefined) {
    const shape = endpoints(move).shape;
    const local = transformBox(body, move.rel ? shape.clone().multiply(move.rel) : shape);
    radius = Math.hypot(...local.min.map((x, k) => Math.max(Math.abs(x), Math.abs(local.max[k]))));
    cache.set(body, radius);
  }
  return radius;
}

function intervalRotationPadding(move: Move, body: Box, local0: number, local1: number): number {
  const end = move.entry.some((v) => v !== 0) ? SIDE_CRUISE_END : LOWER_START;
  const progress = (u: number) => easeInOutCubic(clamp01((u - LIFT_END) / (end - LIFT_END)));
  const d = endpoints(move);
  return rotationPadding(memberRadius(body, move), d.q0.angleTo(d.q1) * Math.abs(progress(local1) - progress(local0)));
}

/** A bounded stud/socket contact, never a waiver for the holder's whole body. */
function studSeat(member: Member, block: RestingBlock, way: Way, metrics: Metrics, byKey: Map<string, Instance>): boolean {
  if (way[1] > -0.999 || !block.assembled) return false;
  const own = metrics(byKey.get(member.key)!.part), other = metrics(block.part);
  if (own.placeholder || other.placeholder) return false;
  const child = transformBox(own.body, restPose(member.move.to, member.move.rel));
  const parent = transformBox(other.body, block.pose);
  const studHeight = parent.min[1] - block.box.min[1];
  return studHeight > 0.3 && studHeight <= 5 && Math.abs(child.max[1] - parent.min[1]) <= 0.3 &&
    !boxIntersects(child, parent) && xyIntersects(child, parent);
}

/**
 * A target AABB overlap is not itself a connector. Only an already assembled
 * neighbour with usable surface geometry can pass this narrow-phase check.
 * Snap-fit tolerance is restricted to graph-declared holders; unrelated parts
 * must have zero sampled material crossings. This remains a mesh heuristic,
 * not a claim of CAD-level connector recognition or deformable snap simulation.
 */
function verifiedInsertion(member: Member, block: RestingBlock, way: Way, metrics: Metrics, byKey: Map<string, Instance>, holder: boolean, memo?: Map<string, boolean>): boolean {
  if (!block.assembled) return false;
  if (studSeat(member, block, way, metrics, byKey)) return true;
  const own = metrics(byKey.get(member.key)!.part), other = metrics(block.part);
  if (!own.mesh?.length || !other.mesh?.length || own.placeholder || other.placeholder) return false;
  const world = restPose(member.move.to, member.move.rel);
  const piece: Placed = { shape: shapeOf(own.mesh, own.meshTwoSidedFrom), world, box: transformBox(own.full, world) };
  const neighbour: Placed = { shape: shapeOf(other.mesh, other.meshTwoSidedFrom), world: block.pose, box: block.box };
  // The sweep only looks a few LDU past box clearance, so every longer entry along
  // the same way gives the same answer: reuse it for the whole plan.
  const entryLength = Math.hypot(...member.move.entry) || Infinity;
  const far = entryLength >= sweepReach(piece.box, block.box, way) + 1.5;
  const id = memo && [member.key, block.key, holder ? 1 : 0, way.map((v) => v.toFixed(4)).join(','), far ? 'far' : entryLength.toFixed(3),
    ...world.elements.map((v) => v.toFixed(3)), ...block.pose.elements.map((v) => v.toFixed(3))].join('|');
  const known = id ? memo!.get(id) : undefined;
  if (known !== undefined) return known;
  const result = sweepInsertion(member, block, way, byKey, holder, piece, neighbour, world, entryLength);
  if (id) memo!.set(id, result);
  return result;
}

function sweepInsertion(member: Member, block: RestingBlock, way: Way, byKey: Map<string, Instance>, holder: boolean, piece: Placed, neighbour: Placed, world: THREE.Matrix4, entryLength: number): boolean {
  const cap = holder ? CLEAR : 0;
  const rel = block.pose.clone().invert().multiply(world);
  const localWay = new THREE.Vector3(...way).transformDirection(block.pose.clone().invert()).toArray() as Way;
  const joint = holder ? (wristContact(byKey.get(member.key)!.part, block.part, rel.elements, localWay) ?? hairContact(byKey.get(member.key)!.part, block.part, rel.elements, localWay) ?? cupGripContact(byKey.get(member.key)!.part, block.part, rel.elements, localWay)) ?? undefined : undefined;
  const distance = entryLength;
  const scratch = { inv: new THREE.Matrix4(), rel: new THREE.Matrix4() };
  if (crossings(piece, [neighbour], way, scratch, cap, distance, joint) <= cap) return true;
  // Forgive authoring slop: the same route, the piece set up to 1 LDU across it.
  return slopNudges(way).some((offset) => crossings(nudged(piece, offset), [neighbour], way, scratch, cap, distance, joint) <= cap);
}

/** Fail closed on missing meshes and orientation changes. */
function verifiedTranslation(member: Member, block: RestingBlock, from: THREE.Matrix4, to: THREE.Matrix4, metrics: Metrics, byKey: Map<string, Instance>, memo?: Map<string, boolean>): boolean {
  const own = metrics(byKey.get(member.key)!.part), other = metrics(block.part);
  if (!own.mesh?.length || !other.mesh?.length || own.placeholder || other.placeholder) return false;
  if ([0,1,2,4,5,6,8,9,10].some((k) => Math.abs(from.elements[k] - to.elements[k]) > 1e-8)) return false;
  const id = memo && [member.key, block.key, ...from.elements, ...to.elements, ...block.pose.elements].map((v) => (typeof v === 'number' ? v.toFixed(3) : v)).join('|');
  const known = id ? memo!.get(id) : undefined;
  if (known !== undefined) return known;
  const clear = sweepTranslation(own, other, block, from, to);
  if (id) memo!.set(id, clear);
  return clear;
}

function sweepTranslation(own: PartMetricsLike, other: PartMetricsLike, block: RestingBlock, from: THREE.Matrix4, to: THREE.Matrix4): boolean {
  if (!own.mesh || !other.mesh) return false;
  const piece: Placed = { shape: shapeOf(own.mesh, own.meshTwoSidedFrom), world: from, box: transformBox(own.full, from) };
  const neighbour: Placed = { shape: shapeOf(other.mesh, other.meshTwoSidedFrom), world: block.pose, box: block.box };
  const delta: Way = [12,13,14].map((k) => to.elements[k] - from.elements[k]) as Way;
  if (translationClear(piece, neighbour, delta)) return true;
  // Forgive authoring slop, as for the final insertion.
  return Math.hypot(...delta) > 1e-7 && slopNudges(delta).some((offset) => translationClear(nudged(piece, offset), neighbour, delta));
}

/**
 * Conservative swept boxes for each phase of a flight (hold, lift, cruise, lower /
 * insert). Translation is monotone inside a phase, so the endpoint boxes bound it;
 * a part that turns can reach up to twice its radius beyond them.
 */
function phaseBoxes(u: Unit, members: Member[]): PhaseBox[] {
  if (u.hidden) return [];
  const out: PhaseBox[] = [];
  for (const { move, body } of members) {
    const lateral = move.entry.some((v) => v !== 0);
    const cuts = lateral ? [0, LIFT_END, SIDE_CRUISE_END, SIDE_INSERT_START, 1] : [0, LIFT_END, LOWER_START, 1];
    let pad = 0;
    if (turns(move)) {
      const rel = move.rel ? transformBox(body, move.rel) : body;
      pad = 2 * memberRadius(body, move);
    }
    const at = (phase: number) => move.hold + (1 - move.hold) * phase;
    let prevT = u.start;
    let prev = transformBox(body, flightPose(move, 0, new THREE.Matrix4()));
    for (const phase of cuts.slice(1)) {
      const t = u.start + at(phase) * u.dur;
      const next = transformBox(body, flightPose(move, at(phase), new THREE.Matrix4()));
      const box = unionBox(prev, next);
      if (pad) for (let k = 0; k < 3; k++) ((box.min[k] -= pad), (box.max[k] += pad));
      out.push({ t0: prevT, t1: t, box });
      prevT = t;
      prev = next;
    }
  }
  return out;
}

function phasesIntersect(a: PhaseBox[], b: PhaseBox[]): boolean {
  for (const p of a)
    for (const q of b) if (p.t0 < q.t1 && q.t0 < p.t1 && boxIntersects(p.box, q.box)) return true;
  return false;
}

function routeHitsResting(
  unit: Unit,
  members: { key: string; move: Move; body: Box }[],
  destinations: Box[],
  blockers: RestingBlock[],
  allowInsertion: (member: Member, block: RestingBlock) => boolean,
  onBlocked?: (block: RestingBlock, stage: string) => void,
  allowTranslation?: (member: Member, block: RestingBlock, from: THREE.Matrix4, to: THREE.Matrix4) => boolean,
): boolean {
  if (!blockers.length) return false;
  // Most LEGO builds are top-down stacks whose settled pieces lie BELOW the
  // last segment of the flight. A conservative phase-AABB check handles these
  // quickly; fine swept samples run only near possible obstruction.
  const lateral = members[0].move.entry.some((v) => v !== 0);
  const cuts = lateral ? [0, LIFT_END, SIDE_CRUISE_END, SIDE_INSERT_START, 1] : [0, LIFT_END, LOWER_START, 1];
  const coarse: Box[] = [];
  for (const { move, body } of members) {
    let prev: Box | null = null;
    for (const phase of cuts) {
      const t = move.hold + (1 - move.hold) * phase;
      const box = transformBox(body, flightPose(move, t, new THREE.Matrix4()));
      if (prev) coarse.push(unionBox(prev, box));
      prev = box;
    }
  }
  // A slerping part may swing OUTSIDE the envelope of its endpoint boxes.
  // The phase shortcut is therefore valid only for fixed orientation; rotating
  // flights always run the swept samples (including rigid submodel members).
  const rotates = members.some(({ move }) => turns(move));
  if (!rotates && blockers.every(({ box }) => coarse.every((path) => !boxIntersects(box, path)))) return false;
  const times = [...new Set([
    0, 1, ...Array.from({ length: ROUTE_SAMPLES + 1 }, (_, n) => n / ROUTE_SAMPLES),
    ...members.flatMap(({ move }) => [move.hold, ...cuts.map((c) => move.hold + (1 - move.hold) * c)]),
  ])].sort((a, b) => a - b);
  const translationCache = new Map<string, boolean>();
  let previous = members.map(({ move, body }) => transformBox(body, flightPose(move, 0, new THREE.Matrix4())));
  for (let n = 1; n < times.length; n++) {
    const u0 = times[n - 1], u1 = times[n];
    const left = unit.start + u0 * unit.dur, right = unit.start + u1 * unit.dur;
    const next = members.map(({ move, body }) => transformBox(body, flightPose(move, u1, new THREE.Matrix4())));
    for (const block of blockers) {
      if (block.end <= left || block.start >= right) continue;
      for (let k = 0; k < next.length; k++) {
        const { move, body } = members[k];
        const local0 = clamp01((u0 - move.hold) / (1 - move.hold));
        const local1 = clamp01((u1 - move.hold) / (1 - move.hold));
        const pad = intervalRotationPadding(move, body, local0, local1);
        const envelope = unionBox(previous[k], next[k]);
        for (let axis = 0; axis < 3; axis++) { envelope.min[axis] -= pad; envelope.max[axis] += pad; }
        if (!boxIntersects(envelope, block.box)) continue;
        if (pad < 1e-9 && !sweptIntersects(previous[k], next[k], block.box)) continue;
        const insertion = move.entry.some((v) => v !== 0) ? SIDE_INSERT_START : LOWER_START;
        if (local0 >= insertion - 1e-6 && boxIntersects(destinations[k], block.box) && allowInsertion(members[k], block)) continue;
        // Empty space inside round/concave bounding boxes is not solid. Only
        // fixed-orientation intervals may use the finite mesh narrow phase.
        if (pad < 1e-9 && allowTranslation) {
          // Test the WHOLE straight phase, not a tiny sampling interval. A
          // wall must not be fragmented into sub-tolerance pieces by sampling.
          const phase = cuts.findIndex((end, index) => index > 0 && local0 >= cuts[index - 1] - 1e-8 && local1 <= end + 1e-8);
          if (phase > 0) {
            const id = `${k}|${block.key}|${block.start}|${phase}`;
            let clear = translationCache.get(id);
            if (clear === undefined) {
              const t0 = move.hold + (1 - move.hold) * cuts[phase - 1];
              const t1 = move.hold + (1 - move.hold) * cuts[phase];
              clear = allowTranslation(members[k], block,
                flightPose(move, t0, new THREE.Matrix4()), flightPose(move, t1, new THREE.Matrix4()));
              translationCache.set(id, clear);
            }
            if (clear) continue;
          }
        }
        onBlocked?.(block, local0 >= insertion - 1e-6 ? 'insertion corridor' : local0 < LIFT_END ? 'takeoff' : 'transit');
        return true;
      }
    }
    previous = next;
  }
  return false;
}

/** Ignore mere face contact / LDraw stud tolerance when checking body volumes. */
const boxIntersects = intersects;

const xyIntersects = (a: Box, b: Box) =>
  [0, 2].every((axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > 0.3);

/** Check overlapping flight times and real member boxes, not group envelopes. */
function flightsIntersect(
  units: Unit[],
  members: Member[][],
  i: number,
  j: number,
): boolean {
  const a = units[i];
  const b = units[j];
  if (a.hidden || b.hidden) return false;
  const t0 = Math.max(a.start, b.start);
  const t1 = Math.min(a.start + a.dur, b.start + b.dur);
  if (t1 <= t0) return false;
  // Swept-box checks between times catch very brief contacts that point
  // sampling misses: each interval's box includes both endpoint boxes, so two
  // pieces cannot "swap places" unnoticed. Rather than scanning the whole
  // overlap at a fixed rate, split the time range only where the two swept
  // boxes touch (finest interval ≈ the old 1/160 s). Inside one flight phase a
  // part's translation is monotone, so endpoint boxes bound the interval.
  const cutTimes = (u: Unit, mv: Move) => {
    const lateral = mv.entry.some((v) => v !== 0);
    const cuts = lateral ? [0, LIFT_END, SIDE_CRUISE_END, SIDE_INSERT_START, 1] : [0, LIFT_END, LOWER_START, 1];
    return cuts.map((c) => u.start + (mv.hold + (1 - mv.hold) * c) * u.dur);
  };
  const times = [...new Set([t0, t1, ...cutTimes(a, members[i][0].move), ...cutTimes(b, members[j][0].move)])]
    .filter((t) => t >= t0 && t <= t1)
    .sort((x, y) => x - y);
  const cache = new Map<number, [Box[], Box[]]>();
  const boxesAt = (t: number): [Box[], Box[]] => {
    let hit = cache.get(t);
    if (!hit) {
      const at = (index: number, u: Unit) => members[index].map(({ move, body }) =>
        transformBox(body, flightPose(move, clamp01((t - u.start) / u.dur), _pose)));
      cache.set(t, (hit = [at(i, a), at(j, b)]));
    }
    return hit;
  };
  const swept = (x: Box[], y: Box[], index: number, ta: number, tb: number) => x.map((box, k) => {
    const bound = unionBox(box, y[k]);
    const { move, body } = members[index][k];
    const unit = units[index];
    const local = (t: number) => clamp01(((t - unit.start) / unit.dur - move.hold) / (1 - move.hold));
    const pad = intervalRotationPadding(move, body, local(ta), local(tb));
    for (let axis = 0; axis < 3; axis++) { bound.min[axis] -= pad; bound.max[axis] += pad; }
    return bound;
  });
  const LEAF = 1 / 160;
  const hits = (ta: number, tb: number): boolean => {
    const [a0, b0] = boxesAt(ta);
    const [a1, b1] = boxesAt(tb);
    const leaf = tb - ta <= LEAF;
    const sa = swept(a0, a1, i, ta, tb);
    const sb = swept(b0, b1, j, ta, tb);
    if (!sa.some((x) => sb.some((y) => boxIntersects(x, y)))) return false;
    if (leaf) return true;
    const mid = (ta + tb) / 2;
    return hits(ta, mid) || hits(mid, tb);
  };
  for (let k = 1; k < times.length; k++) if (times[k] > times[k - 1] && hits(times[k - 1], times[k])) return true;
  return false;
}
const _pose = new THREE.Matrix4();

const restPose = (m: THREE.Matrix4, rel: THREE.Matrix4 | null) => (rel ? m.clone().multiply(rel) : m.clone());

/** World LDU matrix of every instance at time t; null = not on screen yet. */
export function poseAt(tl: Timeline, t: number): (key: string) => THREE.Matrix4 | null {
  return (key) => {
    const tr = tl.tracks.get(key);
    if (!tr) return null;
    if (t < tr.appear) return null;
    if (!tr.moves.length) return tr.final.clone();
    const first = tl.units[tr.moves[0].unit];
    if (t < first.start) {
      // Replenishment appears on the cleared table, not via an unplanned drop
      // through airborne pieces. Its launch is scheduled after floor readiness.
      return tr.floor.clone();
    }
    for (let i = 0; i < tr.moves.length; i++) {
      const mv = tr.moves[i];
      const u = tl.units[mv.unit];
      if (t < u.start) return restPose(tr.moves[i - 1].to, tr.moves[i - 1].rel);
      if (t < u.start + u.dur) return u.hidden ? null : flightPose(mv, (t - u.start) / u.dur, new THREE.Matrix4());
    }
    return tr.final.clone();
  };
}
