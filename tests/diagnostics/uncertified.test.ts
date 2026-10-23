/**
 * Diagnostic for the LEGACY planner: why does a piece get `uncertified: true`?
 *
 * This test does not change the planner. It plans the real 31039 model with the
 * real LDraw library and LDCad shadow pack, caches the encoded timeline under
 * tests/diagnostics/ (gitignore-worthy), and then re-runs the planner's own
 * collision queries against each uncertified unit.
 *
 * Run:
 *   npx vitest run tests/diagnostics/uncertified.test.ts --silent=false
 * Re-plan (ignore the cache):
 *   FORCE_REPLAN=1 npx vitest run tests/diagnostics/uncertified.test.ts --silent=false
 * Add the directional route probes (slower):
 *   PROBES=1 npx vitest run tests/diagnostics/uncertified.test.ts --silent=false
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { importLDraw } from '../../src/io/ldrawImport';
import { assemble, transformBox, unionBox, type Instance, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { parseLDConfig } from '../../src/ldraw/colors';
import { parseLDraw, normalizeName } from '../../src/ldraw/parse';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { buildTimeline, flightPose, type Move, type Timeline } from '../../src/anim/timeline';
import { encodeTimeline, decodeTimeline } from '../../src/anim/timelineCodec';
import { allPartIds } from '../../src/state/useModel';
import { mateAxes, plugAxes, worldSnaps, type WorldSnap } from '../../src/anim/snapMates';
import {
  CLEAR, UP, crossings, nudged, shapeOf, slopNudges, translationClear,
  type Placed, type Way,
} from '../../src/anim/shapes';
import { cupGripContact, hairContact, wristContact } from '../../src/anim/jointContact';
import { clamp01, easeInOutCubic } from '../../src/anim/easing';
import { rotationPadding, sweptIntersects } from '../../src/anim/sweptBounds';
import { factorAffine } from '../../src/anim/affineTransform';
import type { Box } from '../../src/ldraw/flatten';
import type { Unit } from '../../src/anim/timelineData';

const ROOT = join(__dirname, '..', '..', 'public', 'ldraw');
const DATA = join(__dirname, '..', '..', 'public', 'data');
const MODEL = '/Users/mac/Downloads/31039_Blue_Power_Jet_LOGICAL_SUBMODELS_v4.mpd';
const CACHE = join(__dirname, 'uncertified-timeline.cache.json');
const ANALYSIS = join(__dirname, 'uncertified-analysis.json');
const FORCE = process.env.FORCE_REPLAN === '1';
const DO_PROBES = process.env.PROBES === '1';

const fetchText = async (p: string) => {
  const f = join(ROOT, p);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

// ---------- planner primitives reproduced for diagnosis (not used by the app) ----------

const NEAR = 1;
const boxesTouch = (a: Box, b: Box) => [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > -NEAR);
const boxIntersects = (a: Box, b: Box) => [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > 0.3);
const xyIntersects = (a: Box, b: Box) => [0, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > 0.3);
const restPose = (m: THREE.Matrix4, rel: THREE.Matrix4 | null) => (rel ? m.clone().multiply(rel) : m.clone());
const overlapDepth = (a: Box, b: Box) => [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
const unit = (v: readonly number[]): Way => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const fmtVec = (v: readonly number[]) => v.map((x) => Math.round(x * 1000) / 1000).join(',');

type Member = { key: string; move: Move; body: Box };
type RestingBlock = { key: string; box: Box; start: number; end: number; pose: THREE.Matrix4; part: string; assembled: boolean; unit: number };

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

/** Same narrow-phase decision as timeline.ts verifiedInsertion. */
function insertionAllowed(
  member: Member, block: RestingBlock, metrics: Metrics, byKey: Map<string, Instance>, holder: boolean,
): { allowed: boolean; score: number; cap: number } {
  if (!block.assembled) return { allowed: false, score: Infinity, cap: 0 };
  const wayRaw: Way = member.move.entry.some((n) => n !== 0) ? unit(member.move.entry) : UP;
  if (studSeat(member, block, wayRaw, metrics, byKey)) return { allowed: true, score: 0, cap: CLEAR };
  const own = metrics(byKey.get(member.key)!.part), other = metrics(block.part);
  if (!own.mesh?.length || !other.mesh?.length || own.placeholder || other.placeholder) return { allowed: false, score: Infinity, cap: 0 };
  const world = restPose(member.move.to, member.move.rel);
  const piece: Placed = { shape: shapeOf(own.mesh, own.meshTwoSidedFrom), world, box: transformBox(own.full, world) };
  const neighbour: Placed = { shape: shapeOf(other.mesh, other.meshTwoSidedFrom), world: block.pose, box: block.box };
  const entryLength = Math.hypot(...member.move.entry) || Infinity;
  const cap = holder ? CLEAR : 0;
  const rel = block.pose.clone().invert().multiply(world);
  const localWay = new THREE.Vector3(...wayRaw).transformDirection(block.pose.clone().invert()).toArray() as Way;
  const joint = holder
    ? (wristContact(byKey.get(member.key)!.part, block.part, rel.elements, localWay)
      ?? hairContact(byKey.get(member.key)!.part, block.part, rel.elements, localWay)
      ?? cupGripContact(byKey.get(member.key)!.part, block.part, rel.elements, localWay)) ?? undefined
    : undefined;
  const scratch = { inv: new THREE.Matrix4(), rel: new THREE.Matrix4() };
  let score = crossings(piece, [neighbour], wayRaw, scratch, cap, entryLength, joint);
  if (score <= cap) return { allowed: true, score, cap };
  const slop = slopNudges(wayRaw).some((offset) => {
    score = Math.min(score, crossings(nudged(piece, offset), [neighbour], wayRaw, scratch, cap, entryLength, joint));
    return score <= cap;
  });
  return { allowed: slop, score, cap };
}

/** Same blocker windows as the final loop in timeline.ts. */
function blockersAt(tl: Timeline, i: number, byKey: Map<string, Instance>, metrics: Metrics): RestingBlock[] {
  const u = tl.units[i];
  const arrival = u.start + u.dur;
  const blocks: RestingBlock[] = [];
  for (const [key, tr] of tl.tracks) {
    if (u.keys.includes(key)) continue;
    const inst = byKey.get(key);
    if (!inst) continue;
    const part = inst.part;
    let previousEnd = tr.appear;
    let pose = tr.floor;
    let rest = tr.floorBox;
    let restAt: unknown = null;
    let restUnit = -1;
    const addRest = (end: number) => {
      if (end > previousEnd && end > u.start && previousEnd < arrival)
        blocks.push({ key, box: rest, start: previousEnd, end, pose, part, assembled: restAt !== null, unit: restUnit });
    };
    for (const mv of tr.moves) {
      if (mv.unit >= i) break;
      const flight = tl.units[mv.unit];
      addRest(flight.start);
      previousEnd = flight.start + flight.dur;
      const p = restPose(mv.to, mv.rel);
      pose = p;
      rest = transformBox(metrics(part).full, p);
      restAt = mv;
      restUnit = mv.unit;
    }
    addRest(Infinity);
  }
  return blocks;
}

function membersOf(tl: Timeline, i: number, byKey: Map<string, Instance>, metrics: Metrics): Member[] {
  const out: Member[] = [];
  for (const key of tl.units[i].keys) {
    const tr = tl.tracks.get(key);
    const inst = byKey.get(key);
    if (!tr || !inst) continue;
    for (const mv of tr.moves) if (mv.unit === i) out.push({ key, move: mv, body: metrics(inst.part).full });
  }
  return out;
}

// ---- faithful copy of timeline.ts routeHitsResting, with stage reporting ----

const LIFT_END = 0.24;
const LOWER_START = 0.76;
const SIDE_CRUISE_END = 0.56;
const SIDE_INSERT_START = 0.8;
const ROUTE_SAMPLES = 48;

type Decomposed = { p0: THREE.Vector3; q0: THREE.Quaternion; p1: THREE.Vector3; q1: THREE.Quaternion; shape: THREE.Matrix4 };

function endpointPairDiag(from: THREE.Matrix4, to: THREE.Matrix4): Decomposed {
  const a = factorAffine(from.elements), b = factorAffine(to.elements);
  if (!a || !b) throw new Error('invalid affine transform in diagnostic');
  return {
    p0: new THREE.Vector3(...a.position),
    p1: new THREE.Vector3(...b.position),
    q0: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(a.rotation)).normalize(),
    q1: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(b.rotation)).normalize(),
    shape: new THREE.Matrix4().fromArray(b.shape),
  };
}

const turnsDiag = (move: Move) => {
  const d = endpointPairDiag(move.from, move.to);
  return d.q0.angleTo(d.q1) > 1e-7;
};

function memberRadiusDiag(body: Box, move: Move): number {
  const shape = endpointPairDiag(move.from, move.to).shape;
  const local = transformBox(body, move.rel ? shape.clone().multiply(move.rel) : shape);
  return Math.hypot(...local.min.map((x, k) => Math.max(Math.abs(x), Math.abs(local.max[k]))));
}

function intervalPadDiag(move: Move, body: Box, local0: number, local1: number): number {
  const end = move.entry.some((v) => v !== 0) ? SIDE_CRUISE_END : LOWER_START;
  const progress = (u: number) => easeInOutCubic(clamp01((u - LIFT_END) / (end - LIFT_END)));
  const d = endpointPairDiag(move.from, move.to);
  return rotationPadding(memberRadiusDiag(body, move), d.q0.angleTo(d.q1) * Math.abs(progress(local1) - progress(local0)));
}

type RouteBlocker = { stage: string; key: string; part: string; start: number; end: number; member: string; unit: number };

function routeHitsDiag(
  unit: Timeline['units'][number],
  members: Member[],
  destinations: Box[],
  blockers: RestingBlock[],
  allowInsertion: (member: Member, block: RestingBlock) => boolean,
  allowTranslation?: (member: Member, block: RestingBlock, from: THREE.Matrix4, to: THREE.Matrix4) => boolean,
): { hit: boolean; blocked: RouteBlocker[] } {
  const blocked: RouteBlocker[] = [];
  if (!blockers.length) return { hit: false, blocked };
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
  const rotates = members.some(({ move }) => turnsDiag(move));
  if (!rotates && blockers.every(({ box }) => coarse.every((path) => !boxIntersects(box, path)))) return { hit: false, blocked };

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
        const pad = intervalPadDiag(move, body, local0, local1);
        const envelope = unionBox(previous[k], next[k]);
        for (let axis = 0; axis < 3; axis++) { envelope.min[axis] -= pad; envelope.max[axis] += pad; }
        if (!boxIntersects(envelope, block.box)) continue;
        if (pad < 1e-9 && !sweptIntersects(previous[k], next[k], block.box)) continue;
        const insertion = move.entry.some((v) => v !== 0) ? SIDE_INSERT_START : LOWER_START;
        if (local0 >= insertion - 1e-6 && boxIntersects(destinations[k], block.box) && allowInsertion(members[k], block)) continue;
        if (pad < 1e-9 && allowTranslation) {
          const phase = cuts.findIndex((end, index) => index > 0 && local0 >= cuts[index - 1] - 1e-8 && local1 <= end + 1e-8);
          if (phase > 0) {
            const id = `${k}|${block.key}|${block.start}|${phase}`;
            let clear = translationCache.get(id);
            if (clear === undefined) {
              const t0 = move.hold + (1 - move.hold) * cuts[phase - 1];
              const t1 = move.hold + (1 - move.hold) * cuts[phase];
              clear = allowTranslation(members[k], block, flightPose(move, t0, new THREE.Matrix4()), flightPose(move, t1, new THREE.Matrix4()));
              translationCache.set(id, clear);
            }
            if (clear) continue;
          }
        }
        blocked.push({
          stage: local0 >= insertion - 1e-6 ? 'insertion corridor' : local0 < LIFT_END ? 'takeoff' : 'transit',
          key: block.key, part: block.part, start: block.start, end: block.end, member: members[k].key, unit: block.unit,
        });
        return { hit: true, blocked };
      }
    }
    previous = next;
  }
  return { hit: false, blocked };
}

function translationAllowedDiag(
  member: Member, block: RestingBlock, from: THREE.Matrix4, to: THREE.Matrix4,
  byKey: Map<string, Instance>, metrics: Metrics,
): boolean {
  const own = metrics(byKey.get(member.key)!.part), other = metrics(block.part);
  if (!own.mesh?.length || !other.mesh?.length || own.placeholder || other.placeholder) return false;
  if ([0, 1, 2, 4, 5, 6, 8, 9, 10].some((k) => Math.abs(from.elements[k] - to.elements[k]) > 1e-8)) return false;
  const piece: Placed = { shape: shapeOf(own.mesh, own.meshTwoSidedFrom), world: from, box: transformBox(own.full, from) };
  const neighbour: Placed = { shape: shapeOf(other.mesh, other.meshTwoSidedFrom), world: block.pose, box: block.box };
  const delta: Way = [12, 13, 14].map((k) => to.elements[k] - from.elements[k]) as Way;
  if (translationClear(piece, neighbour, delta)) return true;
  return Math.hypot(...delta) > 1e-7 && slopNudges(delta).some((offset) => translationClear(nudged(piece, offset), neighbour, delta));
}

function mateAxesFor(a: string, b: string, snapsAt: (k: string) => WorldSnap[], byKey: Map<string, Instance>, metrics: Metrics): [number, number, number][] {
  const sa = snapsAt(a), sb = snapsAt(b);
  let axes = mateAxes(sa, sb);
  const uncovered = (k: string) => { const i = byKey.get(k); return !!i && !metrics(i.part).snaps?.length; };
  if (!axes.length && uncovered(a) !== uncovered(b)) {
    const [bare, other] = uncovered(a) ? [a, b] : [b, a];
    axes = plugAxes(snapsAt(other), byKey.get(bare)!.worldBox);
  }
  return axes;
}

// ---------- the test ----------

describe('uncertified legacy routes', () => {
  it('reproduces and diagnoses every uncertified unit', async () => {
    expect(existsSync(MODEL)).toBe(true);
    const plan = ensureIds(importLDraw(readFileSync(MODEL, 'utf8'), 'jet.mpd'));
    const lib = new PartLibrary(fetchText);
    if (plan.parts) lib.addInline(new Map(Object.entries(plan.parts).map(([n, t]) => [normalizeName(n), parseLDraw(t, normalizeName(n))])));
    // The app calls setShadowPack() from /data/ldcad-shadow.json during initPartService().
    const shadowPack = JSON.parse(readFileSync(join(DATA, 'ldcad-shadow.json'), 'utf8')) as { files: Record<string, string> };
    lib.setShadow(shadowLookupFrom(shadowPack.files));

    const partIds = allPartIds(plan);
    const map = new Map<string, PartMetrics>();
    const flats = new Map<string, Awaited<ReturnType<PartLibrary['loadPart']>>>();
    for (const id of partIds) {
      const flat = await lib.loadPart(id);
      flats.set(id, flat);
      map.set(id, measurePart(flat, id));
    }
    const metrics: Metrics = (p: string) => map.get(p) ?? measurePart(null, p);
    const asm = assemble(plan, metrics, parseLDConfig(readFileSync(join(ROOT, 'LDConfig.ldr'), 'utf8')));

    let tl: Timeline;
    if (!FORCE && existsSync(CACHE)) {
      const raw = JSON.parse(readFileSync(CACHE, 'utf8'));
      tl = decodeTimeline({ ...raw, mats: Float64Array.from(raw.mats as number[]) });
      console.log(`[diagnostic] loaded cached timeline (${tl.units.length} units, shadow=yes)`);
    } else {
      const started = Date.now();
      tl = buildTimeline(asm, metrics, {
        targetSeconds: 15,
        heroOrbit: true,
        accessSearchAttempts: Number(process.env.ACCESS_ATTEMPTS ?? 12),
        accessSearchMilliseconds: Number(process.env.ACCESS_MS ?? 4000),
      });
      const enc = encodeTimeline(tl);
      writeFileSync(CACHE, JSON.stringify({ ...enc, mats: Array.from(enc.mats) }));
      console.log(`[diagnostic] planned in ${((Date.now() - started) / 1000).toFixed(1)}s, cached to ${CACHE}`);
    }

    const byKey = new Map<string, Instance>(asm.instances.map((i) => [i.key, i]));
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
    const nameOf = (part: string) => (flats.get(part)?.description ?? '').replace(/^=+/, '').trim() || part;

    const uncertified = tl.units
      .map((u, i) => ({ u, i }))
      .filter(({ u }) => u.uncertified);
    console.log(`[diagnostic] uncertified units: ${uncertified.length} / ${tl.units.length}`);

    const closureCache = new Map<number, Set<number>>();
    const dependencyClosure = (index: number): Set<number> => {
      const cached = closureCache.get(index);
      if (cached) return cached;
      const seen = new Set<number>();
      const stack = [index];
      while (stack.length) {
        const n = stack.pop()!;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const d of tl.units[n]?.dependsOn ?? []) stack.push(d);
      }
      closureCache.set(index, seen);
      return seen;
    };

    const analysis = uncertified.map(({ u, i }) => {
      const members = membersOf(tl, i, byKey, metrics);
      const blocks = blockersAt(tl, i, byKey, metrics);
      const arrival = u.start + u.dur;
      const finalSeat = blocks.filter((b) => b.assembled && b.start <= arrival && b.end >= arrival);
      const depsKeys = new Set((u.dependsOn ?? []).flatMap((j) => tl.units[j].keys));
      const depsClosure = dependencyClosure(i);
      const memberInfo = members.map((member) => {
        const inst = byKey.get(member.key)!;
        const own = metrics(inst.part);
        const dst = transformBox(own.full, restPose(member.move.to, member.move.rel));
        const touching = finalSeat.filter((b) => boxesTouch(dst, b.box));
        const seat = touching.filter((b) => boxIntersects(dst, b.box)).map((b) => {
          const axes = mateAxesFor(member.key, b.key, snapsAt, byKey, metrics);
          const connected = axes.length > 0;
          const holder = connected || depsKeys.has(b.key);
          const check = insertionAllowed(member, b, metrics, byKey, holder);
          return {
            key: b.key,
            part: b.part,
            name: nameOf(b.part),
            connected,
            connectorAxes: axes.map(fmtVec),
            dependency: depsClosure.has(b.unit),
            directDependency: depsKeys.has(b.key),
            tolerated: check.allowed,
            score: Number.isFinite(check.score) ? Math.round(check.score * 1000) / 1000 : null,
            cap: check.cap,
            overlapLdu: overlapDepth(dst, b.box).map((x) => Math.round(x * 100) / 100),
            assembled: b.assembled,
          };
        });
        const connectorAxes: [number, number, number][] = [];
        for (const b of finalSeat) {
          for (const a of mateAxesFor(member.key, b.key, snapsAt, byKey, metrics))
            if (!connectorAxes.some((o) => Math.abs(o[0] * a[0] + o[1] * a[1] + o[2] * a[2]) > Math.cos((4 * Math.PI) / 180))) connectorAxes.push(a);
        }
        return {
          key: member.key,
          part: inst.part,
          name: nameOf(inst.part),
          model: inst.model,
          shadowConnectorCount: own.snaps?.length ?? 0,
          shadowConnectorKinds: [...new Set((own.snaps ?? []).map((s) => `${s.kind}:${s.kind === 'cyl' || s.kind === 'gen' ? s.gender : 'F'}`))],
          entry: member.move.entry,
          entryWay: fmtVec(member.move.entry.some((v) => v !== 0) ? unit(member.move.entry) : UP),
          connectorAxes: connectorAxes.map(fmtVec),
          dstBox: dst,
          overlaps: finalSeat.filter((b) => boxesTouch(dst, b.box)).map((b) => ({
            key: b.key, part: b.part, name: nameOf(b.part), touch: true,
            overlapLdu: overlapDepth(dst, b.box).map((x) => Math.round(x * 100) / 100),
          })),
          seat,
        };
      });
      const step = tl.steps[u.step];
      const destinations = members.map((member) => {
        const own = metrics(byKey.get(member.key)!.part);
        return transformBox(own.full, restPose(member.move.to, member.move.rel));
      });

      const axesCache = new Map<string, [number, number, number][]>();
      const axesFor = (member: Member, block: RestingBlock) => {
        const id = `${member.key}|${block.key}`;
        let axes = axesCache.get(id);
        if (!axes) { axes = mateAxesFor(member.key, block.key, snapsAt, byKey, metrics); axesCache.set(id, axes); }
        return axes;
      };
      const holderFor = (member: Member, block: RestingBlock) => axesFor(member, block).length > 0 || depsKeys.has(block.key);
      const insertCache = new Map<string, boolean>();
      const allowInsertion = (member: Member, block: RestingBlock) => {
        const id = `${member.key}|${block.key}|${fmtVec(member.move.entry)}|${holderFor(member, block) ? 1 : 0}`;
        let allowed = insertCache.get(id);
        if (allowed === undefined) {
          allowed = insertionAllowed(member, block, metrics, byKey, holderFor(member, block)).allowed;
          insertCache.set(id, allowed);
        }
        return allowed;
      };
      const transCache = new Map<string, boolean>();
      const allowTranslation = (member: Member, block: RestingBlock, from: THREE.Matrix4, to: THREE.Matrix4) => {
        const id = `${member.key}|${block.key}|${from.elements.map((x) => x.toFixed(2)).join(',')}|${to.elements.map((x) => x.toFixed(2)).join(',')}`;
        let clear = transCache.get(id);
        if (clear === undefined) { clear = translationAllowedDiag(member, block, from, to, byKey, metrics); transCache.set(id, clear); }
        return clear;
      };
      const runRoute = (ms: Member[], bs: RestingBlock[]) => routeHitsDiag(u, ms, destinations, bs, allowInsertion, allowTranslation);

      const actual = runRoute(members, blocks);
      const blockerChain: RouteBlocker[] = [];
      const removed = new Set<string>();
      for (let n = 0; n < 20; n++) {
        const r = runRoute(members, blocks.filter((b) => !removed.has(b.key)));
        if (!r.hit) break;
        const first = r.blocked[0];
        if (removed.has(first.key)) break;
        blockerChain.push(first);
        removed.add(first.key);
      }
      const depSet = new Set(u.dependsOn ?? []);
      const enrich = (b: RouteBlocker) => {
        const bu = b.unit >= 0 ? tl.units[b.unit] : null;
        return {
          ...b,
          blockerName: nameOf(b.part),
          blockerStep: bu?.step ?? null,
          blockerKeys: bu?.keys ?? [],
          blockerKind: bu?.kind ?? null,
          dependency: depsClosure.has(b.unit),
          directDependency: depSet.has(b.unit),
          blockerUncertified: !!bu?.uncertified,
          sameStep: bu?.step === u.step,
        };
      };
      const chainKeys = new Set(blockerChain.map((b) => b.key));
      const allChainClears = chainKeys.size > 0 && !runRoute(members, blocks.filter((b) => !chainKeys.has(b.key))).hit;
      const nonDependencyChain = blockerChain.filter((b) => !depsClosure.has(b.unit));
      const nonDependencyClears = nonDependencyChain.length > 0 &&
        !runRoute(members, blocks.filter((b) => !nonDependencyChain.some((x) => x.key === b.key))).hit;
      const singleBlockerClears = blockerChain.map((b) => ({
        key: b.key,
        part: b.part,
        stage: b.stage,
        dependency: depsClosure.has(b.unit),
        directDependency: depSet.has(b.unit),
        sameStep: tl.units[b.unit]?.step === u.step,
        clears: !runRoute(members, blocks.filter((x) => x.key !== b.key)).hit,
      }));

      let search: {
        clear: boolean; entry?: number[]; length?: number; hold?: number; skyY?: number; dir?: string;
      } | undefined;
      if (DO_PROBES) {
        const dirs: { v: number[]; label: string }[] = [];
        const addDir = (v: readonly number[], label: string) => {
          if (Math.hypot(v[0], v[1], v[2]) < 1e-8) return;
          const d = unit(v);
          if (!dirs.some((o) => Math.abs(o.v[0] * d[0] + o.v[1] * d[1] + o.v[2] * d[2]) > 1 - 1e-6)) dirs.push({ v: d, label });
        };
        for (const m of memberInfo) addDir(m.entry, 'actual');
        for (const m of memberInfo) for (const a of m.connectorAxes) {
          const v = a.split(',').map(Number);
          addDir(v, `connector ${a}`);
          addDir(v.map((x) => -x), `connector -(${a})`);
        }
        addDir([1, 0, 0], '+X'); addDir([-1, 0, 0], '-X');
        addDir([0, 1, 0], '+Y'); addDir([0, -1, 0], '-Y');
        addDir([0, 0, 1], '+Z'); addDir([0, 0, -1], '-Z');
        search = { clear: false };
        const lengths = members.length > 1 ? [4] : [12, 60];
        const holds = [...new Set([members[0].move.hold, 0])];
        const skyOffsets = members.length > 1 ? [0] : [0, 80];
        outer: for (const { v, label } of dirs) {
          for (const length of lengths) {
            for (const hold of holds) {
              for (const off of skyOffsets) {
                const entry = v.map((x) => Math.round(x * length * 1000) / 1000) as [number, number, number];
                const ms = members.map((m) => ({ ...m, move: { ...m.move, entry, hold, skyY: m.move.skyY + off } }));
                if (!runRoute(ms, blocks).hit) {
                  search = { clear: true, entry, length, hold, skyY: members[0].move.skyY + off, dir: label };
                  break outer;
                }
              }
            }
          }
        }
      }

      return {
        index: i,
        kind: u.kind,
        keys: u.keys,
        step: u.step,
        stepLabel: step ? { model: step.model, index: step.index } : null,
        start: u.start,
        dependsOn: u.dependsOn ?? [],
        members: memberInfo,
        blockerCount: blocks.length,
        finalSeatKeys: finalSeat.map((b) => b.key),
        hardSeatCount: memberInfo.reduce((n, m) => n + m.seat.filter((s) => !s.tolerated).length, 0),
        toleratedSeatCount: memberInfo.reduce((n, m) => n + m.seat.filter((s) => s.tolerated).length, 0),
        membersWithoutShadowConnectors: memberInfo.filter((m) => m.shadowConnectorCount === 0).length,
        routeOnlyBlockers: [...new Set(blocks.filter((b) => !(b.start <= arrival && b.end >= arrival)).map((b) => b.key))],
        route: {
          actualEntry: members[0]?.move.entry ?? [0, 0, 0],
          actualHold: members[0]?.move.hold ?? 0,
          actualSkyY: members[0]?.move.skyY ?? 0,
          hit: actual.hit,
          firstBlocked: actual.blocked[0] ? enrich(actual.blocked[0]) : null,
          blockerChain: blockerChain.map(enrich),
          singleBlockerClears,
          allChainClears,
          nonDependencyClears,
          search,
        },
      };
    });

    writeFileSync(ANALYSIS, JSON.stringify(analysis, null, 2));
    console.log(`[diagnostic] wrote ${ANALYSIS}`);

    // Compact console view so the run itself is reproducible evidence.
    for (const a of analysis) {
      const first = a.members[0];
      const hard = first?.seat.filter((s) => !s.tolerated) ?? [];
      console.log([
        `#${a.index}`,
        a.keys.join('&'),
        first ? `${first.part} "${first.name}"` : 'subassembly',
        `step ${a.step}${a.stepLabel ? ` (${a.stepLabel.model || 'main'}#${a.stepLabel.index})` : ''}`,
        `entry=${fmtVec(first?.entry ?? [0, 0, 0])}`,
        `snaps=${first?.shadowConnectorCount ?? 0}`,
        `axes=${first?.connectorAxes.join(';') || '-'}`,
        `hardSeat=${hard.map((s) => `${s.key}[${s.overlapLdu.join(',')}]${s.connected ? ' mate' : ''}${s.dependency ? ' dep' : ''}`).join(';') || '-'}`,
      ].join(' | '));
    }

    expect(uncertified.length).toBeGreaterThan(0);
  }, 900_000);
});
