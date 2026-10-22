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
const SETTLE = 0.12;
const CAM_KEY_STEP = 0.2;
const SIDE_REACH = 1.5;

/** One thing that flies: a single piece, or a finished submodel chunk (the attach). */
export type Unit = { kind: 'piece' | 'attach'; keys: string[]; start: number; dur: number; step: number };
export type SubBuild = { key: string; name: string; start: number; attachStart: number; attachEnd: number; focus: Box };
/** What the build camera must keep in view at time t (LDU): the model plus the pieces still on the floor. */
export type CamKey = { t: number; box: Box };

type Move = { unit: number; from: THREE.Matrix4; to: THREE.Matrix4; rel: THREE.Matrix4 | null; peak: number };
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
type PlayStep = { units: (PlayPiece | PlayAttach)[] ; model: string; index: number };
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
  const subInfo: { key: string; name: string; firstStep: number; spot: Box; ctx: number }[] = [];
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
      let step: PlayStep = { units: [], model, index: s };
      const push = (u: PlayPiece | PlayAttach) => {
        if (pending.length) ((u.after = pending), (pending = []));
        step.units.push(u);
      };
      for (const n of inStep) {
        if (n.kind === 'sub') {
          // the submodel is built aside and attached right away; the rest of the step follows
          if (step.units.length) steps.push(step);
          step = { units: [], model, index: s };
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
    const spot = transformBox(n.body, from);
    const bands = bandsAround(spot, padArea(n.children));
    const focus = unionBox(unionBox(spot, regionBox(bands[0], ground)), regionBox(bands[1], ground)); // the scene bounds; the camera uses the occupied part
    sceneBox = unionBox(sceneBox, focus);
    const savedRight = sideRight;
    sideRight = Math.max(spot.max[0], focus.max[0]);
    const ctx = ctxs.length;
    ctxs.push({ bands, pieces: [], group: new Map() });
    const sub = subInfo.length;
    subInfo.push({ key, name: n.submodel, firstStep: steps.length, spot, ctx: ctxs.length - 1 });
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
  const buildEnd = intro + pacing.build + (steps.length > 1 ? stepPause * (steps.length - 1) : 0);

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
  const schedule = (c: number, dur: number) => {
    const s: number[] = [];
    let end = intro;
    flat.forEach((_, i) => {
      let t = intro + (raw[i] - intro) * c;
      if (i > 0) t = Math.max(t, s[i - 1]); // keep play order
      for (const d of deps[i]) t = Math.max(t, s[d] + dur);
      s.push(t);
      end = Math.max(end, t + dur);
    });
    return { s, end };
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
    // re-layout each window in colour order so similar pieces sit together
    // a copy that reuses a side spot drops its pieces in once the previous copy's floor is empty
    let appear = ctx.after === undefined ? -Infinity : ctxs[ctx.after].pieces.reduce((m, k) => Math.max(m, pieceStart.get(k) ?? 0), -Infinity);
    windows.forEach((win, wi) => {
      const set = new Set(win.ids);
      const r = layoutBands(
        ordered.filter((it) => set.has(it.id)).map(({ id, w, d, group }) => ({ id, w, d, group })),
        ctx.bands,
      );
      const pos = r.overflow.length ? win.pos : r.pos;
      if (wi > 0) {
        const prev = windows[wi - 1].ids;
        appear = prev.reduce((m, k) => Math.max(m, pieceStart.get(k) ?? 0), -Infinity);
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
      tr.moves.push({ unit: i, from: tr.floor, to: f.u.target, rel: null, peak: 0 });
      current.set(f.u.key, f.u.target);
      return;
    }
    const inv = f.u.from.clone().invert();
    for (const k of f.u.keys) {
      const cur = current.get(k);
      const tr = tracks.get(k);
      if (!cur || !tr) continue;
      const rel = inv.clone().multiply(cur);
      tr.moves.push({ unit: i, from: f.u.from, to: f.u.to, rel, peak: 0 });
      current.set(k, f.u.to.clone().multiply(rel));
    }
  });
  for (const tr of tracks.values()) {
    for (const m of tr.moves) {
      const a = new THREE.Vector3().setFromMatrixPosition(m.from);
      const b = new THREE.Vector3().setFromMatrixPosition(m.to);
      m.peak = Math.max(3 * BRICK, 0.15 * Math.hypot(b.x - a.x, b.z - a.z));
    }
  }

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
      start: firstIdx >= 0 ? starts[firstIdx] : attachStart,
      attachStart,
      attachEnd: attachStart + flightDur,
      focus: occupied(s.ctx).reduce((b, tr) => unionBox(b, tr.floorBox), s.spot),
    };
  });

  // the space each flight sweeps: both ends, raised by its arc
  const flightBox: (Box | null)[] = units.map(() => null);
  for (const [key, tr] of tracks) {
    const body = metrics(byKey.get(key)!.part).body;
    for (const mv of tr.moves) {
      let b = unionBox(transformBox(body, restPose(mv.from, mv.rel)), transformBox(body, restPose(mv.to, mv.rel)));
      b = { min: [b.min[0], b.min[1] - mv.peak, b.min[2]], max: [b.max[0], b.max[1] + 2, b.max[2]] };
      flightBox[mv.unit] = flightBox[mv.unit] ? unionBox(flightBox[mv.unit]!, b) : b;
    }
  }

  // The build camera never cuts to close-ups: it keeps the model, the pieces still on the
  // floor, every flight in progress and any side spot in use in view. A side spot is kept
  // from SIDE_REACH before its build until SIDE_REACH after its attach, so submodels built
  // one after another widen the view once instead of pumping in and out.
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
  m.from.decompose(_p0, _q0, _s0);
  m.to.decompose(_p1, _q1, _s1);
  if (u < 1 - SETTLE) {
    const e = easeInOutCubic(u / (1 - SETTLE));
    const y = lerp(_p0.y, _p1.y, e) - 4 * e * (1 - e) * (m.peak + Math.abs(_p0.y - _p1.y) / 2);
    _p0.set(lerp(_p0.x, _p1.x, e), y, lerp(_p0.z, _p1.z, e));
    _q0.slerp(_q1, e);
    _s0.lerp(_s1, e);
    out.compose(_p0, _q0, _s0);
  } else {
    const s = (u - (1 - SETTLE)) / SETTLE;
    _p1.y += 2 * Math.sin(Math.PI * s); // settle: dip 2 LDU (LDraw +y is down), then back
    out.compose(_p1, _q1, _s1);
  }
  if (m.rel) out.multiply(m.rel);
  return out;
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
      if (t < u.start + u.dur) return flightPose(mv, (t - u.start) / u.dur, new THREE.Matrix4());
    }
    return tr.final.clone();
  };
}
