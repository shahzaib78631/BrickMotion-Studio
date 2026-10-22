import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import { placementMatrix, transformBox, unionBox, type ANode, type Assembly, type Instance, type Metrics } from '../model/assemble';
import { clamp01, easeInOutCubic, easeOutCubic, lerp } from './easing';
import { layoutFloor, type FloorItem, type Region } from './floorLayout';
import { choosePacing, type AnimOptions, type Pacing } from './pacing';

const STUD = 20;
const BRICK = 24;
const FLOOR_MARGIN = 2; // studs around the model's footprint kept clear
const SIDE_GAP = 4; // studs between the model area and a side spot
const DROP_TIME = 0.3;
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
/** the camera needs this long to move into a submodel close-up (and out of it) */
export const CLOSE_EASE = 0.6;

/** One thing that flies: a single piece, or a finished submodel chunk (the attach). */
/** `box`: the space the flight sweeps (LDU), for the camera */
export type Unit = {
  kind: 'piece' | 'attach'; keys: string[]; start: number; dur: number; step: number; box?: Box | null;
  /** Only if every collision-free insertion is blocked: snap safely rather than visibly cross a brick. */
  hidden?: boolean;
};
/** `closeUp`: the camera moves in close while this build runs (the first build of each top-level submodel) */
export type SubBuild = { key: string; name: string; closeUp: boolean; start: number; attachStart: number; attachEnd: number; focus: Box };
/** What the build camera must keep in view at time t (LDU): the model plus the pieces still on the floor. */
export type CamKey = { t: number; box: Box };

type Move = {
  unit: number;
  from: THREE.Matrix4;
  to: THREE.Matrix4;
  rel: THREE.Matrix4 | null;
  skyY: number;
  hold: number;
  /** World-space offset of the point from which the part is inserted. */
  entry: [number, number, number];
};
type Track = { appear: number; floor: THREE.Matrix4; floorBox: Box; ctx: number; moves: Move[]; final: THREE.Matrix4 };

/** When one step of a model plays (a step split by a submodel build plays in parts). */
export type StepSpan = { model: string; index: number; start: number; end: number };

export type Timeline = {
  duration: number;
  steps: StepSpan[];
  pacing: Pacing;
  heroOrbit: boolean;
  intro: number;
  buildEnd: number;
  units: Unit[];
  subBuilds: SubBuild[];
  /** LDU boxes for the camera */
  buildBox: Box;
  modelBox: Box;
  /** everything the camera may show, LDU */
  sceneBox: Box;
  camKeys: CamKey[];
  ground: number;
  tracks: Map<string, Track>;
};

const EMPTY_BOX: Box = { min: [0, -24, 0], max: [20, 0, 20] };

/** A rotation-free basis, mirrored when the target is mirrored so slerp stays valid. */
const naturalBasis = (target: THREE.Matrix4) => (target.determinant() < 0 ? new THREE.Matrix4().makeScale(-1, 1, 1) : new THREE.Matrix4());

/**
 * The two floor bands in front of and behind a footprint, together 3× its area,
 * deep enough for the pieces (`padArea` = their footprints plus gaps) unless that
 * would make the floor more than twice the model's size; then windows take over.
 */
function bandsAround(box: Box, padArea = 0): Region[] {
  const bx0 = Math.floor(box.min[0] / STUD);
  const bx1 = Math.ceil(box.max[0] / STUD);
  const bz0 = Math.floor(box.min[2] / STUD);
  const bz1 = Math.ceil(box.max[2] / STUD);
  const W = Math.max(1, bx1 - bx0);
  const D = Math.max(1, bz1 - bz0);
  const width = Math.max(W + 2 * FLOOR_MARGIN, 12);
  const depth = Math.max(4, Math.ceil((1.5 * W * D) / width), Math.min(Math.ceil((0.65 * padArea) / width), 2 * Math.max(W, D, 8)));
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

type PlayPiece = { kind: 'piece'; key: string; target: THREE.Matrix4; ctx: number; after?: PlayAttach[] };
type PlayAttach = { kind: 'attach'; key: string; keys: string[]; from: THREE.Matrix4; to: THREE.Matrix4; sub: number; after?: PlayAttach[] };
type PlayStep = { units: (PlayPiece | PlayAttach)[]; model: string; index: number; scope: string; pauseAfter: number };
type Ctx = { bands: Region[]; pieces: string[]; group: Map<string, number>; after?: number };

export function buildTimeline(asm: Assembly, metrics: Metrics, opts: AnimOptions): Timeline {
  const byKey = new Map<string, Instance>(asm.instances.map((i) => [i.key, i]));
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

  /** Plays a model's nodes into `frame`; submodels are built aside first. */
  const play = (nodes: ANode[], frame: THREE.Matrix4, prefix: string, ctx: number) => {
    const stepIds = [...new Set(nodes.map((n) => n.step))].sort((a, b) => a - b);
    for (const s of stepIds) {
      const inStep = nodes.filter((n) => n.step === s).sort((a, b) => a.order - b.order);
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
          const a = buildSub(n, frame, prefix);
          if (a.keys.length) push(a);
          continue;
        }
        const key = keyOf(prefix, n.itemId);
        const inst = byKey.get(key);
        if (!inst) continue;
        const target = ctx === 0 ? inst.world.clone() : frame.clone().multiply(placementMatrix(n.local));
        push({ kind: 'piece', key, target, ctx });
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

  const buildSub = (n: Extract<ANode, { kind: 'sub' }>, parentFrame: THREE.Matrix4, prefix: string): PlayAttach => {
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
    ctxs.push({ bands, pieces: [], group: new Map() });
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
  flat.forEach((f, i) => {
    const keys = f.u.kind === 'piece' ? [f.u.key] : f.u.keys;
    const d = new Set<number>();
    for (const k of keys) {
      const prev = lastUnitOf.get(k);
      if (prev !== undefined) d.add(prev);
      lastUnitOf.set(k, i);
    }
    for (const a of f.u.after ?? []) if (indexOf.has(a)) d.add(indexOf.get(a)!); // its side spot must be free
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
      // Start a pause only AFTER every earlier in-flight piece has landed.
      if (i > 0 && holdAfter[i - 1] > 0) t = Math.max(t, end + holdAfter[i - 1]);
      for (const d of deps[i]) t = Math.max(t, s[d] + dur);
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
    keys: f.u.kind === 'piece' ? [f.u.key] : f.u.keys,
    start: starts[i],
    dur: flightDur,
    step: f.step,
  }));
  const pieceStart = new Map<string, number>();
  flat.forEach((f, i) => f.u.kind === 'piece' && pieceStart.set(f.u.key, starts[i]));

  // --- floor poses, windows ---
  const tracks = new Map<string, Track>();
  const windowVisibility: { ctx: number; windows: { ids: string[] }[] }[] = [];
  ctxs.forEach((ctx, ci) => {
    const items: (FloorItem & { color: number })[] = ctx.pieces.map((key) => {
      const inst = byKey.get(key)!;
      const b = transformBox(metrics(inst.part).body, naturalBasis(inst.world));
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
    // re-layout each window in colour order so similar pieces sit together
    // a copy that reuses a side spot drops its pieces in once the previous copy's floor is empty
    // A repeated side spot is not free when the previous submodel's last
    // constituent takes off: the assembled chunk remains there until its
    // ATTACH flight completes. Do not drop the next batch on top of it.
    const previousSub = subInfo.find((sub) => sub.ctx === ctx.after);
    const previousAttach = previousSub ? flat.findIndex((f) => f.u.kind === 'attach' && f.u.key === previousSub.key) : -1;
    let appear = previousAttach < 0 ? -Infinity : starts[previousAttach] + flightDur;
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
        const b = transformBox(metrics(inst.part).body, basis);
        const p = pos.get(key) ?? { x: ctx.bands[0].x0, z: ctx.bands[0].z0 };
        const floor = new THREE.Matrix4().makeTranslation(p.x * STUD - b.min[0], ground - b.max[1], p.z * STUD - b.min[2]).multiply(basis);
        tracks.set(key, { appear, floor, floorBox: transformBox(metrics(inst.part).body, floor), ctx: ci, moves: [], final: inst.world.clone() });
      }
    });
  });

  // --- moves ---
  const current = new Map<string, THREE.Matrix4>();
  flat.forEach((f, i) => {
    if (f.u.kind === 'piece') {
      const tr = tracks.get(f.u.key)!;
      tr.moves.push({ unit: i, from: tr.floor, to: f.u.target, rel: null, skyY: 0, hold: 0, entry: [0, 0, 0] });
      current.set(f.u.key, f.u.target);
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
    for (const mv of tr.moves) members[mv.unit].push({ key, move: mv, body: metrics(byKey.get(key)!.part).body });
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

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    let top = builtTop;
    let offset = Infinity;
    let extent = 0;
    let sweep: Box | null = null;
    for (const { move: mv, body } of members[i]) {
      const fromBox = transformBox(body, restPose(mv.from, mv.rel));
      const toBox = transformBox(body, restPose(mv.to, mv.rel));
      const fromY = mv.from.elements[13];
      const toY = mv.to.elements[13];
      top = Math.min(top, fromBox.min[1], toBox.min[1]);
      offset = Math.min(offset, fromBox.min[1] - fromY, toBox.min[1] - toY);
      extent = Math.max(extent, fromBox.max[1] - fromBox.min[1], toBox.max[1] - toBox.min[1]);
      sweep = unionBox(sweep, unionBox(fromBox, toBox));
    }
    const skyY = top - FLIGHT_CLEARANCE - (Number.isFinite(offset) ? offset : 0);
    builtTop = Math.min(builtTop, top);
    const dst = destinationBoxes[i].reduce<Box | null>((box, next) => unionBox(box, next), null) ?? EMPTY_BOX;

    // Look at pieces that are NOT flying at this time. Previously the planner
    // only called flightsIntersect(), so a tyre could fall straight THROUGH
    // the already assembled car body without triggering any collision.
    // A track may rest first on the floor, later on a submodel's side spot,
    // and finally in the model. Preserve those time intervals individually.
    const blockers: RestingBlock[] = [];
    for (const [key, tr] of tracks) {
      if (u.keys.includes(key)) continue;
      let previousEnd = tr.appear;
      let rest = tr.floorBox;
      for (const mv of tr.moves) {
        const flight = units[mv.unit];
        if (flight.start > previousEnd && flight.start > u.start && previousEnd < u.start + u.dur)
          blockers.push({ box: rest, start: previousEnd, end: flight.start });
        previousEnd = flight.start + flight.dur;
        rest = restAfterMove.get(mv)!;
        if (previousEnd >= u.start + u.dur) break;
      }
      if (previousEnd < u.start + u.dur) blockers.push({ box: rest, start: previousEnd, end: Infinity });
    }

    // A narrow upright round part (e.g. an LDraw tyre oriented on an axle)
    // should be inserted along its thin horizontal axis, not dropped onto the
    // axle from the roof. Prefer the nearer outer side of the model.
    const spans = [0, 1, 2].map((axis) => dst.max[axis] - dst.min[axis]);
    const narrowSide = [0, 2].find((axis) =>
      spans[axis] < Math.min(spans[1], spans[axis === 0 ? 2 : 0]) * 0.7,
    );
    const directions: [number, number][] = [];
    const orderedSide = (axis: 0 | 2) => {
      const middle = (dst.min[axis] + dst.max[axis]) / 2;
      const sceneMiddle = (modelBox.min[axis] + modelBox.max[axis]) / 2;
      const outer = middle < sceneMiddle ? -1 : 1;
      directions.push([axis, outer], [axis, -outer]);
    };
    if (narrowSide !== undefined) orderedSide(narrowSide as 0 | 2);
    directions.push([1, -1]); // vertical, the traditional top-down assembly
    if (narrowSide !== 0) orderedSide(0);
    if (narrowSide !== 2) orderedSide(2);

    const overlaps = [] as number[];
    for (let j = 0; j < i; j++) {
      if (units[j].start >= u.start + u.dur || units[j].start + units[j].dur <= u.start) continue;
      if (members[i].some((p) => members[j].some((q) => p.key === q.key))) continue;
      overlaps.push(j);
    }

    let safe = false;
    // Try sensible insertion sides, flight lanes and small takeoff holds.
    // Check stationary as well as airborne parts on every candidate path.
    for (const [axis, dir] of directions) {
      const entry: [number, number, number] = [0, 0, 0];
      if (axis !== 1) {
        const farFace = dir < 0 ? modelBox.min[axis] : modelBox.max[axis];
        const dist = dir < 0
          ? dst.max[axis] - farFace + FLIGHT_CLEARANCE
          : farFace - dst.min[axis] + FLIGHT_CLEARANCE;
        entry[axis] = dir * Math.max(2 * STUD, dist);
      }
      const routeSweep = destinationBoxes[i].reduce<Box | null>((box, next, k) => {
        const { move: mv, body } = members[i][k];
        const approach = mv.to.clone();
        approach.elements[12] += entry[0];
        approach.elements[14] += entry[2];
        const start = transformBox(body, restPose(mv.from, mv.rel));
        return unionBox(unionBox(box, next), unionBox(start, transformBox(body, restPose(approach, mv.rel))));
      }, null) ?? EMPTY_BOX;
      // A rotating piece can protrude beyond the boxes at either endpoint.
      const radius = members[i].reduce((r, { body, move }) => {
        const a = move.from.elements, b = move.to.elements;
        const turns = [0, 1, 2, 4, 5, 6, 8, 9, 10].some((k) => Math.abs(a[k] - b[k]) > 0.01);
        if (!turns) return r;
        const rel = move.rel ? transformBox(body, move.rel) : body;
        const radius = Math.hypot(...rel.min.map((x, k) => Math.max(Math.abs(x), Math.abs(rel.max[k]))));
        return Math.max(r, 2 * radius);
      }, 0);
      const expandedSweep = radius > 0 ? {
        min: [routeSweep.min[0] - radius, routeSweep.min[1], routeSweep.min[2] - radius],
        max: [routeSweep.max[0] + radius, routeSweep.max[1], routeSweep.max[2] + radius],
      } as Box : routeSweep;
      const near = blockers.filter((block) =>
        block.end > u.start && block.start < u.start + u.dur && xyIntersects(block.box, expandedSweep),
      );
      for (let lane = 0; lane < 5 && !safe; lane++) {
        const laneHeight = skyY - lane * Math.max(AIR_LANE, extent + FLIGHT_CLEARANCE);
        for (const hold of [0, 0.12, 0.24, 0.36, 0.48, 0.6]) {
          for (const { move: mv } of members[i]) {
            mv.skyY = laneHeight;
            mv.hold = hold;
            mv.entry = entry;
          }
          if (routeHitsResting(u, members[i], destinationBoxes[i], near)) continue;
          if (overlaps.some((j) => xyIntersects(expandedSweep, sweptXY[j]) && flightsIntersect(units, members, i, j))) continue;
          sweep = expandedSweep;
          safe = true;
          break;
        }
      }
      if (safe) break;
    }
    if (!safe) {
      // A tightly enclosed or poorly modeled attachment may have NO clear
      // rigid path (particularly with bounding boxes for hollow parts). Never
      // display a penetrating fallback trajectory: keep it hidden while it
      // snaps from the staging floor to its destination.
      u.hidden = true;
      for (const { move: mv } of members[i]) {
        mv.entry = [0, 0, 0];
        mv.skyY = skyY;
        mv.hold = 0;
      }
    }
    sweptXY[i] = sweep ?? EMPTY_BOX;
  }
  // Recalculate when new pieces may safely occupy a reused floor band. A
  // piece that has merely STARTED rising is still in the space where the next
  // window drops in. The band isn't empty until the last piece clears it.
  for (const { ctx, windows } of windowVisibility) {
    const previousSub = subInfo.find((sub) => sub.ctx === ctxs[ctx].after);
    const previousAttach = previousSub ? flat.findIndex((f) => f.u.kind === 'attach' && f.u.key === previousSub.key) : -1;
    let appear = previousAttach < 0 ? -Infinity : units[previousAttach].start + units[previousAttach].dur;
    for (const win of windows) {
      for (const key of win.ids) tracks.get(key)!.appear = appear;
      appear = win.ids.reduce((latest, key) => {
        const move = tracks.get(key)!.moves[0];
        const unit = units[move.unit];
        return Math.max(latest, unit.start + unit.dur * (move.hold + (1 - move.hold) * LIFT_END) + 0.01);
      }, -Infinity);
    }
  }
  // Keep the remainder of the timeline, submodel labels and outro aligned if
  // an exceptional collision forced a launch to be postponed.
  for (let i = 0; i < units.length; i++) starts[i] = units[i].start;
  actualEnd = Math.max(actualEnd, ...units.map((u) => u.start + u.dur));

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
  for (const group of members)
    for (const { move: mv, body } of group) {
      if (units[mv.unit].hidden) continue;
      for (const u of [0, LIFT_END, 0.5, SIDE_CRUISE_END, LOWER_START, SIDE_INSERT_START, 1]) {
        const b = transformBox(body, flightPose(mv, u, new THREE.Matrix4()));
        flightBox[mv.unit] = flightBox[mv.unit] ? unionBox(flightBox[mv.unit]!, b) : b;
      }
    }

  units.forEach((u, i) => (u.box = flightBox[i]));

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
const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();

function flightPose(m: Move, u: number, out: THREE.Matrix4): THREE.Matrix4 {
  u = clamp01((u - m.hold) / (1 - m.hold));
  m.from.decompose(_p0, _q0, _s0);
  m.to.decompose(_p1, _q1, _s1);
  const lateral = m.entry[0] !== 0 || m.entry[2] !== 0;
  if (u < LIFT_END) {
    _p0.y = lerp(_p0.y, m.skyY, easeInOutCubic(clamp01(u / LIFT_END)));
    out.compose(_p0, _q0, _s0);
  } else if (lateral) {
    if (u < SIDE_CRUISE_END) {
      const e = easeInOutCubic(clamp01((u - LIFT_END) / (SIDE_CRUISE_END - LIFT_END)));
      _p0.set(lerp(_p0.x, _p1.x + m.entry[0], e), m.skyY, lerp(_p0.z, _p1.z + m.entry[2], e));
      _q0.slerp(_q1, e);
      _s0.lerp(_s1, e);
      out.compose(_p0, _q0, _s0);
    } else if (u < SIDE_INSERT_START) {
      const e = easeInOutCubic(clamp01((u - SIDE_CRUISE_END) / (SIDE_INSERT_START - SIDE_CRUISE_END)));
      _p1.set(_p1.x + m.entry[0], lerp(m.skyY, _p1.y, e), _p1.z + m.entry[2]);
      out.compose(_p1, _q1, _s1);
    } else {
      const e = easeInOutCubic(clamp01((u - SIDE_INSERT_START) / (1 - SIDE_INSERT_START)));
      _p1.set(_p1.x + m.entry[0] * (1 - e), _p1.y, _p1.z + m.entry[2] * (1 - e));
      out.compose(_p1, _q1, _s1);
    }
  } else if (u < LOWER_START) {
    const e = easeInOutCubic(clamp01((u - LIFT_END) / (LOWER_START - LIFT_END)));
    _p0.set(lerp(_p0.x, _p1.x, e), m.skyY, lerp(_p0.z, _p1.z, e));
    _q0.slerp(_q1, e);
    _s0.lerp(_s1, e);
    out.compose(_p0, _q0, _s0);
  } else {
    _p1.y = lerp(m.skyY, _p1.y, easeInOutCubic(clamp01((u - LOWER_START) / (1 - LOWER_START))));
    out.compose(_p1, _q1, _s1);
  }
  if (m.rel) out.multiply(m.rel);
  return out;
}

/** Static time-window that a flying member must not cross. */
type RestingBlock = { box: Box; start: number; end: number };

function routeHitsResting(
  unit: Unit,
  members: { key: string; move: Move; body: Box }[],
  destinations: Box[],
  blockers: RestingBlock[],
): boolean {
  if (!blockers.length) return false;
  // Most LEGO builds are top-down stacks whose settled pieces lie BELOW the
  // last segment of the flight. A conservative phase-AABB check handles these
  // quickly; fine swept samples run only near possible obstruction.
  const lateral = members[0].move.entry[0] !== 0 || members[0].move.entry[2] !== 0;
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
  const rotates = members.some(({ move }) => {
    const a = move.from.elements;
    const b = move.to.elements;
    return [0, 1, 2, 4, 5, 6, 8, 9, 10].some((j) => Math.abs(a[j] - b[j]) > 0.001);
  });
  if (!rotates && blockers.every(({ box }) => coarse.every((path) => !boxIntersects(box, path)))) return false;
  const steps = ROUTE_SAMPLES;
  let previous = members.map(({ move, body }) => transformBox(body, flightPose(move, 0, new THREE.Matrix4())));
  for (let n = 1; n <= steps; n++) {
    const u = n / steps;
    const left = unit.start + (n - 1) / steps * unit.dur;
    const right = unit.start + u * unit.dur;
    const next = members.map(({ move, body }) => transformBox(body, flightPose(move, u, new THREE.Matrix4())));
    for (const block of blockers) {
      if (block.end <= left || block.start >= right) continue;
      for (let k = 0; k < next.length; k++) {
        if (!boxIntersects(unionBox(previous[k], next[k]), block.box)) continue;
        // Existing intersections at the assembled target are connectors and
        // hollow parts, not evidence of a collision (bbox cannot model holes).
        // Allow these ONLY on the last, aligned insertion segment; a route
        // still cannot pass through the rest of the car on the way there.
        const insertion = members[k].move.entry.some((n) => n !== 0) ? SIDE_INSERT_START : LOWER_START;
        if ((n - 1) / steps >= insertion - 1e-6 && boxIntersects(destinations[k], block.box)) continue;
        return true;
      }
    }
    previous = next;
  }
  return false;
}

/** Ignore mere face contact / LDraw stud tolerance when checking body volumes. */
const boxIntersects = (a: Box, b: Box, tolerance = 2) =>
  [0, 1, 2].every((axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > tolerance);

const xyIntersects = (a: Box, b: Box) =>
  [0, 2].every((axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > 2);

/** Check overlapping flight times and real member boxes, not group envelopes. */
function flightsIntersect(
  units: Unit[],
  members: { key: string; move: Move; body: Box }[][],
  i: number,
  j: number,
): boolean {
  const a = units[i];
  const b = units[j];
  if (a.hidden || b.hidden) return false;
  const t0 = Math.max(a.start, b.start);
  const t1 = Math.min(a.start + a.dur, b.start + b.dur);
  if (t1 <= t0) return false;
  // Conservative swept-box checks between frames catch very brief contacts
  // that point-sampling at even 120/240 fps can miss. Each interval includes
  // both endpoint boxes, so two pieces cannot simply "swap places" between
  // the inspected times without registering a conflict.
  const samples = Math.max(24, Math.ceil((t1 - t0) * 160));
  const boxesAt = (index: number, u: Unit, t: number) => members[index].map(({ move, body }) =>
    transformBox(body, flightPose(move, clamp01((t - u.start) / u.dur), new THREE.Matrix4())),
  );
  let ba = boxesAt(i, a, t0);
  let bb = boxesAt(j, b, t0);
  for (let n = 1; n <= samples; n++) {
    const t = lerp(t0, t1, n / samples);
    const nextA = boxesAt(i, a, t);
    const nextB = boxesAt(j, b, t);
    if (ba.some((box, k) => nextB.some((other, m) => boxIntersects(unionBox(box, nextA[k]), unionBox(bb[m], other))))) return true;
    ba = nextA;
    bb = nextB;
  }
  return false;
}

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
      const m = tr.floor.clone();
      if (Number.isFinite(tr.appear) && t < tr.appear + DROP_TIME) {
        const u = easeOutCubic(clamp01((t - tr.appear) / DROP_TIME));
        m.elements[13] -= 3 * BRICK * (1 - u);
      }
      return m;
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
