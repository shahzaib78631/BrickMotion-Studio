/**
 * "Fit": slot one selected piece into another, in place.
 *
 * Two kinds of joint are tried, in this order:
 *
 * 1. A **documented slot** — the placement examples a part's own LDraw source carries (the two
 *    `0 !HELP Positioning of Swords` poses in 19141.dat), plus reviewed profiles. Those are
 *    audited exact poses, so they win outright over anything searched for.
 *
 *    A documented slot is also offered to a *different* insert when that insert's joint columns
 *    sit exactly where the documented insert's do: the pose positions that interface, and
 *    nothing else. 21459's katana grip is at the same place, and the same way round, as
 *    30173a's, so the documented sword pose seats it identically — and the collision verdict
 *    confirms the blade lies in the scabbard's slots rather than through them. A part whose
 *    interface is anywhere else is not offered the pose.
 *
 * 2. A **connector seat** — a free male column of one piece and a female socket of the other of
 *    the same family (stud, Technic pin, minifig bar), seated with the placement engine's own
 *    `seat`, so fitting and dragging always agree on where the joint is.
 *
 * The result is a world matrix for the insert in the model's shared LDraw frame; applying it,
 * and refusing it when it would penetrate something, is the caller's job.
 */
import * as THREE from 'three';
import type { PartMetrics } from '../ldraw/metrics';
import type { Vec3 } from '../ldraw/parse';
import { attachmentSlotsFor, canonicalAttachmentPart, reviewedAttachmentSlots, type AttachmentSlot } from '../ldraw/attachments';
import { attachmentFit, attachmentLocalMatrix, multiplyAttachmentMatrices, sameSlotInterface } from '../model/attachmentPlacements';
import { partConnectors, worldConnectors, type Connector } from './connectors';
import { seat } from './placementEngine';

export type FitPiece = { id: string; part: string; world: readonly number[] };

export type FitKind = 'documented-slot' | 'connector';

export type FitOutcome =
  | {
    ok: true; host: string; insert: string; world: number[]; kind: FitKind; detail: string;
    /**
     * The way the piece slides in, as the "way in" the animation reads (outward from the seat,
     * model frame). Only a documented slot has one the planner could not work out for itself:
     * a sword goes into a scabbard lengthways, blade first, not straight down.
     */
    axis?: Vec3;
  }
  | { ok: false; why: string };

export type FitOptions = {
  metricsOf: (part: string) => PartMetrics;
  /** what the pose must not newly sit inside; a non-empty list rejects the candidate */
  blocked?: (insertId: string, world: readonly number[]) => readonly string[];
  /** app settings: preview unreviewed LDraw `!HELP` examples, and allow reflected poses */
  referenceHints?: boolean;
  mirrored?: boolean;
  /** how many joints tie a piece to the pieces around it: the planted one stays, the loose one flies in */
  planted?: (id: string) => number;
  /**
   * Every piece in the model, the selection included. A documented slot another piece already
   * sits in is taken, and so is a socket another piece is already mated to: fitting a second
   * sword must find the *free* scabbard slot, not bury the one that is already filled.
   */
  placed?: readonly FitPiece[];
};

/** Every documented slot the host carries, for whatever insert each was written for. */
function hostSlots(host: FitPiece, metricsOf: FitOptions['metricsOf'], referenceHints: boolean): AttachmentSlot[] {
  const canon = canonicalAttachmentPart(host.part);
  const hints = metricsOf(host.part).attachmentHints ?? [];
  const inserts = new Set<string>();
  for (const slot of reviewedAttachmentSlots()) if (canonicalAttachmentPart(slot.host) === canon) inserts.add(canonicalAttachmentPart(slot.insert));
  for (const hint of hints) inserts.add(canonicalAttachmentPart(hint.part));
  const out: AttachmentSlot[] = [];
  for (const insert of inserts) out.push(...attachmentSlotsFor(host.part, insert, hints, referenceHints));
  return out;
}

const originOf = (e: ArrayLike<number>) => new THREE.Vector3(e[12], e[13], e[14]);

type Box3 = { min: Vec3; max: Vec3 };

/** How far a box has to travel along `d` before it clears `host`; Infinity if `d` never separates them. */
function leaveDistance(piece: Box3, host: Box3, d: Vec3): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) continue;
    const gap = d[i] > 0 ? host.max[i] - piece.min[i] : piece.max[i] - host.min[i];
    best = Math.min(best, Math.max(0, gap) / Math.abs(d[i]));
  }
  return best;
}

const boxAt = (body: { min: Vec3; max: Vec3 }, world: readonly number[]): Box3 => {
  const m = new THREE.Matrix4().fromArray(Array.from(world));
  const out: Box3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const x of [body.min[0], body.max[0]]) for (const y of [body.min[1], body.max[1]]) for (const z of [body.min[2], body.max[2]]) {
    const p = new THREE.Vector3(x, y, z).applyMatrix4(m);
    for (const i of [0, 1, 2]) { out.min[i] = Math.min(out.min[i], p.getComponent(i)); out.max[i] = Math.max(out.max[i], p.getComponent(i)); }
  }
  return out;
};

/**
 * The line a documented slot inserts along: the piece's own longest axis (a sword slides up its
 * blade, a bar up its shaft), taken from the side it can leave soonest — the side it comes in from.
 */
function slotSlide(insert: FitPiece, host: FitPiece, world: readonly number[], metricsOf: FitOptions['metricsOf']): Vec3 | null {
  const body = metricsOf(insert.part).body, hostBody = metricsOf(host.part).body;
  const spans = [body.max[0] - body.min[0], body.max[1] - body.min[1], body.max[2] - body.min[2]];
  const k = spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[2] ? 1 : 2;
  const m = new THREE.Matrix4().fromArray(Array.from(world));
  const here = boxAt(body, world), there = boxAt(hostBody, Array.from(host.world));
  let best: { d: Vec3; travel: number } | null = null;
  for (const sign of [1, -1]) {
    const d = new THREE.Vector3().setComponent(k, sign).transformDirection(m).toArray() as Vec3;
    const travel = leaveDistance(here, there, d);
    if (!best || travel < best.travel) best = { d, travel };
  }
  if (!best || !Number.isFinite(best.travel)) return null;
  const len = Math.hypot(...best.d) || 1;
  return best.d.map((v) => Math.round((v / len) * 1e4) / 1e4 + 0) as Vec3;
}

/** Joined: the same family, on the same line, axes opposed — the rule the engine seats by. */
const mated = (a: Connector, b: Connector) =>
  a.type === b.type && a.gender !== b.gender &&
  Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < 1 &&
  Math.abs(a.axis[0] * b.axis[0] + a.axis[1] * b.axis[1] + a.axis[2] * b.axis[2]) >= .999;

/** Everything that can bring these two pieces together, best first. */
export function fitSelection(pieces: readonly FitPiece[], options: FitOptions): FitOutcome {
  if (pieces.length < 2) return { ok: false, why: 'select the piece to slot in together with the piece it goes into' };
  const { metricsOf } = options;
  let taken = 0, reflected = 0;
  // the pieces outside the selection, and their joints: what this fit must not sit on top of
  const placed = options.placed ?? [];
  const others = placed.filter((other) => !pieces.some((piece) => piece.id === other.id));
  const theirColumns = new Map<string, Connector[]>();
  const columnsOf = (piece: FitPiece) => {
    let list = theirColumns.get(piece.id);
    if (!list) theirColumns.set(piece.id, (list = worldConnectors(partConnectors(metricsOf(piece.part)), Array.from(piece.world))));
    return list;
  };
  /** A joint another piece is already in is not free for this one to take. */
  const free = (column: Connector) => !others.some((other) => columnsOf(other).some((c) => mated(column, c)));
  const candidates: { host: string; insert: string; world: number[]; kind: FitKind; detail: string; travel: number; grip: boolean; axis?: Vec3 }[] = [];
  for (const host of pieces) for (const insert of pieces) {
    if (host.id === insert.id) continue;
    const insertWorld = new THREE.Matrix4().fromArray(Array.from(insert.world));
    const travel = (world: readonly number[]) => originOf(insertWorld.elements).distanceTo(originOf(world));
    for (const slot of hostSlots(host, metricsOf, !!options.referenceHints)) {
      if (!sameSlotInterface(host.part, canonicalAttachmentPart(slot.insert), insert.part, metricsOf)) continue;
      if (slot.mirrored && !options.mirrored) { reflected++; continue; }
      // a piece that can stand in for the documented insert can also be the one filling the slot
      if ((options.placed ?? []).some((other) => other.id !== insert.id &&
        sameSlotInterface(host.part, canonicalAttachmentPart(slot.insert), other.part, metricsOf) &&
        attachmentFit(Array.from(host.world), Array.from(other.world), slot) !== null)) { taken++; continue; }
      const world = multiplyAttachmentMatrices(Array.from(host.world), attachmentLocalMatrix(slot));
      candidates.push({
        host: host.id, insert: insert.id, world, kind: 'documented-slot', travel: travel(world),
        axis: slotSlide(insert, host, world, metricsOf) ?? undefined,
        detail: `${slot.id} — ${slot.evidence === 'unreviewed-ldraw-help' ? 'unreviewed LDraw !HELP example' : 'reviewed LDraw placement'}${slot.mirrored ? ', reflected' : ''}`,
        grip: false,
      });
    }
    const hostColumns = worldConnectors(partConnectors(metricsOf(host.part)), Array.from(host.world))
      .filter((c) => free(c));
    const insertColumns = worldConnectors(partConnectors(metricsOf(insert.part)), Array.from(insert.world));
    const joints: [Connector, Connector][] = [];
    for (const male of insertColumns) if (male.gender === 'M')
      for (const female of hostColumns) if (female.gender === 'F' && female.type === male.type) joints.push([male, female]);
    for (const male of hostColumns) if (male.gender === 'M')
      for (const female of insertColumns) if (female.gender === 'F' && female.type === male.type) joints.push([female, male]);
    for (const [handle, target] of joints) {
      const world = Array.from(seat(handle, target, 0).multiply(insertWorld).elements);
      const grip = !!(handle.grip || target.grip);
      candidates.push({
        host: host.id, insert: insert.id, world, kind: 'connector', travel: travel(world), grip,
        detail: grip ? 'held in the clip' : `${handle.type} joint`,
      });
    }
  }
  // An audited pose beats a searched one. Then the piece that is already joined to the model
  // stays put and the loose one flies in — never the other way round, which would pull a part
  // out of the build to meet the piece lying next to it. Last, the shorter journey wins.
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'documented-slot' ? -1 : 1;
    const planted = (options.planted?.(a.insert) ?? 0) - (options.planted?.(b.insert) ?? 0);
    // a clip or a grip is the interface that says "this holds that" (a hand round a blaster),
    // so it wins over a bare stud the two pieces merely share
    return planted || Number(b.grip) - Number(a.grip) || a.travel - b.travel;
  });
  let refused = '';
  for (const candidate of candidates) {
    const hits = options.blocked?.(candidate.insert, candidate.world) ?? [];
    if (hits.length) { refused ||= `the fit would put ${candidate.insert} inside ${hits.join(', ')}`; continue; }
    return {
      ok: true, host: candidate.host, insert: candidate.insert, world: candidate.world,
      kind: candidate.kind, detail: candidate.detail, ...(candidate.axis ? { axis: candidate.axis } : {}),
    };
  }
  if (refused) return { ok: false, why: refused };
  const setting = 'turn on “Allow mirrored LDraw reference poses” (Parts panel → Attachment precision)';
  if (taken) return { ok: false, why: reflected
    ? `the only free ${pieces.map((p) => p.part).join('/')} slot holds a mirrored pose, which is not a rigid rotation — ${setting} to use it`
    : `every ${pieces.map((p) => p.part).join('/')} slot that takes these pieces is already occupied` };
  if (reflected) return { ok: false, why: `the ${pieces.map((p) => p.part).join('/')} slot holds a mirrored pose, which is not a rigid rotation — ${setting} to use it` };
  return {
    ok: false,
    why: `no joint between ${pieces.map((p) => p.part).join(' and ')}: no documented slot, and no stud, pin or bar that takes the other`,
  };
}
