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

/** One thing that flies: a single piece, or a finished submodel chunk (the attach). */
export type Unit = { kind: 'piece' | 'attach'; keys: string[]; start: number; dur: number; step: number };
export type SubBuild = { key: string; start: number; attachStart: number; attachEnd: number; focus: Box };

type Move = { unit: number; from: THREE.Matrix4; to: THREE.Matrix4; rel: THREE.Matrix4 | null; peak: number };
type Track = { appear: number; floor: THREE.Matrix4; moves: Move[]; final: THREE.Matrix4 };

export type Timeline = {
  duration: number;
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
  ground: number;
  tracks: Map<string, Track>;
};

const EMPTY_BOX: Box = { min: [0, -24, 0], max: [20, 0, 20] };

/** A rotation-free basis, mirrored when the target is mirrored so slerp stays valid. */
const naturalBasis = (target: THREE.Matrix4) => (target.determinant() < 0 ? new THREE.Matrix4().makeScale(-1, 1, 1) : new THREE.Matrix4());

/** The two floor bands in front of and behind a footprint, together 3× its area. */
function bandsAround(box: Box): Region[] {
  const bx0 = Math.floor(box.min[0] / STUD);
  const bx1 = Math.ceil(box.max[0] / STUD);
  const bz0 = Math.floor(box.min[2] / STUD);
  const bz1 = Math.ceil(box.max[2] / STUD);
  const W = Math.max(1, bx1 - bx0);
  const D = Math.max(1, bz1 - bz0);
  const width = Math.max(W + 2 * FLOOR_MARGIN, 12);
  const depth = Math.max(4, Math.ceil((1.5 * W * D) / width));
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

function layoutBands(items: FloorItem[], bands: Region[]) {
  const pos = new Map<string, { x: number; z: number }>();
  let rest = items;
  for (const band of bands) {
    if (!rest.length) break;
    const r = layoutFloor(rest, band);
    r.pos.forEach((v, k) => pos.set(k, v));
    const left = new Set(r.overflow);
    rest = rest.filter((i) => left.has(i.id));
  }
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

type PlayPiece = { kind: 'piece'; key: string; target: THREE.Matrix4; ctx: number };
type PlayAttach = { kind: 'attach'; key: string; keys: string[]; from: THREE.Matrix4; to: THREE.Matrix4; sub: number };
type PlayStep = { units: (PlayPiece | PlayAttach)[] };
type Ctx = { bands: Region[]; pieces: string[]; group: Map<string, number> };

export function buildTimeline(asm: Assembly, metrics: Metrics, opts: AnimOptions): Timeline {
  const byKey = new Map<string, Instance>(asm.instances.map((i) => [i.key, i]));
  const ground = asm.instances.length ? Math.max(...asm.instances.map((i) => i.worldBox.max[1])) : 0;
  const modelBox = asm.bounds ?? EMPTY_BOX;
  const mainBands = bandsAround(modelBox);

  const steps: PlayStep[] = [];
  const ctxs: Ctx[] = [{ bands: mainBands, pieces: [], group: new Map() }];
  const subInfo: { key: string; firstStep: number; focus: Box }[] = [];
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
      const attaches = new Map<ANode, PlayAttach>();
      for (const n of inStep) if (n.kind === 'sub') attaches.set(n, buildSub(n, frame, prefix));
      const step: PlayStep = { units: [] };
      for (const n of inStep) {
        if (n.kind === 'sub') {
          const a = attaches.get(n)!;
          if (a.keys.length) step.units.push(a);
          continue;
        }
        const key = keyOf(prefix, n.itemId);
        const inst = byKey.get(key);
        if (!inst) continue;
        const target = ctx === 0 ? inst.world.clone() : frame.clone().multiply(placementMatrix(n.local));
        step.units.push({ kind: 'piece', key, target, ctx });
        ctxs[ctx].pieces.push(key);
        ctxs[ctx].group.set(key, steps.length);
      }
      if (step.units.length) steps.push(step);
    }
  };

  const buildSub = (n: Extract<ANode, { kind: 'sub' }>, parentFrame: THREE.Matrix4, prefix: string): PlayAttach => {
    const key = keyOf(prefix, n.itemId);
    const to = parentFrame.clone().multiply(placementMatrix(n.local));
    const basis = naturalBasis(to);
    const b = transformBox(n.body, basis);
    const zMid = (modelBox.min[2] + modelBox.max[2]) / 2;
    const tx = sideRight + SIDE_GAP * STUD - b.min[0];
    const from = new THREE.Matrix4().makeTranslation(tx, ground - b.max[1], zMid - (b.min[2] + b.max[2]) / 2).multiply(basis);
    const spot = transformBox(n.body, from);
    const bands = bandsAround(spot);
    const focus = unionBox(unionBox(spot, regionBox(bands[0], ground)), regionBox(bands[1], ground));
    sceneBox = unionBox(sceneBox, focus);
    const savedRight = sideRight;
    sideRight = Math.max(spot.max[0], focus.max[0]);
    const ctx = ctxs.length;
    ctxs.push({ bands, pieces: [], group: new Map() });
    const sub = subInfo.length;
    subInfo.push({ key, firstStep: steps.length, focus });
    play(n.children, from, key, ctx);
    sideRight = savedRight;
    return { kind: 'attach', key, keys: keysUnder(n, prefix), from, to, sub };
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
      s.units.forEach((_, k) => raw[i++] = intro + si * (slot + stepPause) + (n > 1 ? (k / (n - 1)) * 0.4 * slot : 0));
    });
  } else {
    flat.forEach((f, i) => {
      const b = Math.floor(i / pacing.batchSize);
      raw.push(intro + b * slot + ((i % pacing.batchSize) / pacing.batchSize) * 0.3 * slot + f.step * stepPause);
    });
  }

  // which units an attach waits for: every earlier unit that moves one of its keys
  const deps: number[][] = flat.map(() => []);
  const lastUnitOf = new Map<string, number>();
  flat.forEach((f, i) => {
    const keys = f.u.kind === 'piece' ? [f.u.key] : f.u.keys;
    const d = new Set<number>();
    for (const k of keys) {
      const prev = lastUnitOf.get(k);
      if (prev !== undefined) d.add(prev);
      lastUnitOf.set(k, i);
    }
    deps[i] = [...d];
  });
  const schedule = (c: number) => {
    const s: number[] = [];
    let end = intro;
    flat.forEach((_, i) => {
      let t = intro + (raw[i] - intro) * c;
      for (const d of deps[i]) t = Math.max(t, s[d] + flight);
      s.push(t);
      end = Math.max(end, t + flight);
    });
    return { s, end };
  };
  let starts: number[] = [];
  let actualEnd = buildEnd;
  if (flat.length) {
    let lo = 0;
    let hi = 1;
    while (schedule(hi).end < buildEnd && hi < 1e6) hi *= 2;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (schedule(mid).end <= buildEnd) lo = mid;
      else hi = mid;
    }
    const r = schedule(lo);
    starts = r.s;
    actualEnd = Math.max(buildEnd, r.end);
  }
  const units: Unit[] = flat.map((f, i) => ({
    kind: f.u.kind,
    keys: f.u.kind === 'piece' ? [f.u.key] : f.u.keys,
    start: starts[i],
    dur: flight,
    step: f.step,
  }));
  const pieceStart = new Map<string, number>();
  flat.forEach((f, i) => f.u.kind === 'piece' && pieceStart.set(f.u.key, starts[i]));

  // --- floor poses, windows ---
  const tracks = new Map<string, Track>();
  for (const ctx of ctxs) {
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
    const ordered = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.group - b.it.group || a.it.color - b.it.color || a.i - b.i).map((e) => e.it);
    const playOrder = new Map(ctx.pieces.map((k, i) => [k, i]));
    const windows = windowed(
      [...ordered].sort((a, b) => playOrder.get(a.id)! - playOrder.get(b.id)!).map(({ id, w, d, group }) => ({ id, w, d, group })),
      ctx.bands,
    );
    // re-layout each window in colour order so similar pieces sit together
    let appear = -Infinity;
    windows.forEach((win, wi) => {
      const set = new Set(win.ids);
      const r = layoutBands(ordered.filter((it) => set.has(it.id)).map(({ id, w, d, group }) => ({ id, w, d, group })), ctx.bands);
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
        tracks.set(key, { appear, floor, moves: [], final: inst.world.clone() });
      }
    });
  }

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

  const subBuilds: SubBuild[] = subInfo.map((s) => {
    const attachIdx = flat.findIndex((f) => f.u.kind === 'attach' && f.u.key === s.key);
    const firstIdx = flat.findIndex((f) => f.step >= s.firstStep);
    const attachStart = attachIdx >= 0 ? starts[attachIdx] : buildEnd;
    return { key: s.key, start: firstIdx >= 0 ? starts[firstIdx] : attachStart, attachStart, attachEnd: attachStart + flight, focus: s.focus };
  });

  const buildBox = unionBox(unionBox(modelBox, regionBox(mainBands[0], ground)), regionBox(mainBands[1], ground));
  return {
    duration: (flat.length ? actualEnd : intro) + outro,
    pacing,
    heroOrbit: opts.heroOrbit,
    intro,
    buildEnd: flat.length ? actualEnd : intro,
    units,
    subBuilds,
    buildBox,
    modelBox,
    sceneBox,
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
