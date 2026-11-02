import type { AttachmentHint } from '../ldraw/attachmentHints';
import { orthogonalBasisParity } from '../ldraw/attachmentHints';
import { attachmentSlotsFor, declaredSlotInterface, reviewedAttachmentSlots, canonicalAttachmentPart, type AttachmentSlot } from '../ldraw/attachments';
import { partConnectors } from '../plan/connectors';
import type { PartMetrics } from '../ldraw/metrics';
import type { Mat3, Vec3 } from '../ldraw/parse';

/** Independent of three.js, including in offline imports, diagnostics and tests.
 * Matrices are 4x4 column-major and points are measured in LDraw units.
 * No mesh/contact constraints are inferred or relaxed here. */
export type PlacedAttachmentPart = {
  id: string;
  part: string;
  world: readonly number[];
  hints?: readonly AttachmentHint[];
};
export type AttachmentMatch = {
  host: string;
  insert: string;
  slot: AttachmentSlot;
  positionError: number; // LDU
  rotationError: number; // degrees
};
export type AttachmentTarget = {
  owner: string;
  slot: AttachmentSlot;
  /** Exact inserted-part pose, in the model's shared LDraw frame. */
  world: number[];
  /** Slot's reference point in that frame (used for cursor picking). */
  anchor: Vec3;
};

/**
 * Two joint columns are in the same place when they are this close, pointing this alike.
 * A documented slot only ever positions that interface, so an insert whose interface sits
 * exactly where the documented insert's does can stand in for it — 21459's katana grip is in
 * the same place, and the same way round, as 30173a's.
 */
const TOUCH_RADIUS = 0.6;
const TOUCH_ANGLE = 0.996;

export function sameSlotInterface(host: string, documented: string, insert: string, metricsOf: (part: string) => PartMetrics): boolean {
  const have = partConnectors(metricsOf(insert));
  // the declared interface first: the documented part need not be loaded to know what it presents
  const declared = declaredSlotInterface(host, documented);
  if (declared) {
    if (!declared.length || declared.length !== have.length) return false;
    return declared.every((column) => have.some((c) =>
      c.type === column.type && c.gender === column.gender &&
      Math.hypot(c.pos[0] - column.pos[0], c.pos[1] - column.pos[1], c.pos[2] - column.pos[2]) <= TOUCH_RADIUS &&
      Math.abs(c.axis[0] * column.axis[0] + c.axis[1] * column.axis[1] + c.axis[2] * column.axis[2]) >= TOUCH_ANGLE));
  }
  const want = partConnectors(metricsOf(documented));
  if (!want.length || want.length !== have.length) return false;
  const taken = new Set<number>();
  for (const column of want) {
    const at = have.findIndex((c, i) => !taken.has(i) && c.type === column.type && c.gender === column.gender &&
      Math.hypot(c.pos[0] - column.pos[0], c.pos[1] - column.pos[1], c.pos[2] - column.pos[2]) <= TOUCH_RADIUS &&
      Math.abs(c.axis[0] * column.axis[0] + c.axis[1] * column.axis[1] + c.axis[2] * column.axis[2]) >= TOUCH_ANGLE);
    if (at < 0) return false;
    taken.add(at);
  }
  return true;
}

export const DEFAULT_POSITION_TOLERANCE = 0.45; // authoring roundoff; not collision clearance
export const DEFAULT_ANGLE_TOLERANCE = 1.5; // degrees; not a flexible or rotating joint

/** Convert the row-major LDraw type-1 3x3 and position to a column-major 4x4. */
export function attachmentLocalMatrix(s: Pick<AttachmentSlot, 'pos' | 'm'>): number[] {
  const [a,b,c,d,e,f,g,h,i] = s.m;
  return [a,d,g,0,b,e,h,0,c,f,i,0,...s.pos,1];
}

/** Multiplication in the exact matrix convention used by THREE.Matrix4. */
export function multiplyAttachmentMatrices(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
      a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

const basisOf = (e: readonly number[]): Mat3 =>
  [e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]];

/** An LDraw instance can be mirrored but cannot be stretched/sheared and
 * still count as an actual-size fixed-pose connection. */
const worldMatrix = (e: readonly number[]): number[] | null => {
  if (e.length !== 16 || !e.every(Number.isFinite) ||
    Math.abs(e[3]) > 1e-8 || Math.abs(e[7]) > 1e-8 ||
    Math.abs(e[11]) > 1e-8 || Math.abs(e[15] - 1) > 1e-8 ||
    !orthogonalBasisParity(basisOf(e), .005)) return null;
  return Array.from(e);
};

/** Numerically stable for all orthogonal bases (including det=-1). The
 * transpose is the inverse rotation/reflection; does not re-orthogonalise
 * an author's rounded coefficients. */
export function inverseAttachmentWorldMatrix(world: readonly number[]): number[] | null {
  const e = worldMatrix(world);
  if (!e) return null;
  const out = [e[0],e[4],e[8],0,e[1],e[5],e[9],0,e[2],e[6],e[10],0,0,0,0,1];
  out[12] = -(out[0] * e[12] + out[4] * e[13] + out[8] * e[14]);
  out[13] = -(out[1] * e[12] + out[5] * e[13] + out[9] * e[14]);
  out[14] = -(out[2] * e[12] + out[6] * e[13] + out[10] * e[14]);
  return out;
}

/** Exact authored reference pose verification: position, orientation, and
 * handedness. Does not prove geometry clearance, friction or a valid motion. */
export function attachmentFit(hostWorld: readonly number[], insertWorld: readonly number[], slot: AttachmentSlot,
  positionTolerance = DEFAULT_POSITION_TOLERANCE, angleTolerance = DEFAULT_ANGLE_TOLERANCE):
  { positionError: number; rotationError: number } | null {
  const hi = inverseAttachmentWorldMatrix(hostWorld), insert = worldMatrix(insertWorld);
  if (!hi || !insert) return null;
  const relative = multiplyAttachmentMatrices(hi, insert);
  if (orthogonalBasisParity(basisOf(relative), .01) !== (slot.mirrored ? -1 : 1)) return null;
  const positionError = Math.hypot(relative[12] - slot.pos[0], relative[13] - slot.pos[1], relative[14] - slot.pos[2]);
  if (positionError > positionTolerance) return null;
  const expectedInverse = inverseAttachmentWorldMatrix(attachmentLocalMatrix(slot));
  if (!expectedInverse) return null;
  const error = multiplyAttachmentMatrices(expectedInverse, relative);
  const cos = Math.max(-1, Math.min(1, (error[0] + error[5] + error[10] - 1) / 2));
  const rotationError = Math.acos(cos) * 180 / Math.PI;
  return rotationError <= angleTolerance ? { positionError, rotationError } : null;
}

export function matchAttachments(host: PlacedAttachmentPart, insert: PlacedAttachmentPart,
  includeUnreviewed = false): AttachmentMatch[] {
  if (host.id === insert.id || !host.part || !insert.part) return [];
  return attachmentSlotsFor(host.part, insert.part, host.hints, includeUnreviewed).flatMap((slot) => {
    const fit = attachmentFit(host.world, insert.world, slot);
    return fit ? [{ host: host.id, insert: insert.id, slot, ...fit }] : [];
  });
}

/** Linear index by canonical part ID; ordinary models are almost always
 * skipped. Enforce two one-to-one constraints: at most one insert per host slot,
 * and one slot per inserted part. Ambiguity is not silently resolved by order. */
export function discoverPlacedAttachments(parts: readonly PlacedAttachmentPart[], includeUnreviewed = false): AttachmentMatch[] {
  const byPart = new Map<string, PlacedAttachmentPart[]>();
  for (const p of parts) {
    const key = canonicalAttachmentPart(p.part);
    (byPart.get(key) ?? byPart.set(key, []).get(key)!).push(p);
  }
  const known = reviewedAttachmentSlots();
  const hosts = new Set(known.map((slot) => canonicalAttachmentPart(slot.host)));
  const all: AttachmentMatch[] = [];
  for (const host of parts) {
    const hostKey = canonicalAttachmentPart(host.part);
    if (!hosts.has(hostKey) && !(includeUnreviewed && host.hints?.length)) continue;
    const insertKeys = new Set(known.filter((s) => canonicalAttachmentPart(s.host) === hostKey)
      .map((s) => canonicalAttachmentPart(s.insert)));
    if (includeUnreviewed) for (const hint of host.hints ?? []) insertKeys.add(canonicalAttachmentPart(hint.part));
    for (const insertKey of insertKeys) for (const insert of byPart.get(insertKey) ?? [])
      if (insert.id !== host.id) all.push(...matchAttachments(host, insert, includeUnreviewed));
  }
  const occupancy = new Map<string, number>(), insertUses = new Map<string, number>();
  for (const m of all) {
    const key = `${m.host}\u0000${m.slot.id}`;
    occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
    insertUses.set(m.insert, (insertUses.get(m.insert) ?? 0) + 1);
  }
  return all.filter((m) => occupancy.get(`${m.host}\u0000${m.slot.id}`) === 1 && insertUses.get(m.insert) === 1);
}

/** Available exact slot poses for a single move; the caller must separately
 * validate swept collisions and floor/mesh contact. All stationary pieces,
 * including those beyond the current editor step, occupy their slots.
 * Reflected instances require explicit opt-in; unreviewed !HELP is opt-in. */
export function availableAttachmentTargets(moving: PlacedAttachmentPart,
  stationary: readonly PlacedAttachmentPart[], includeUnreviewed = false,
  allowMirrored = false): AttachmentTarget[] {
  const out: AttachmentTarget[] = [];
  const candidateHosts = new Set(reviewedAttachmentSlots()
    .filter((s) => canonicalAttachmentPart(s.insert) === canonicalAttachmentPart(moving.part))
    .map((s) => canonicalAttachmentPart(s.host)));
  for (const host of stationary) {
    if (!candidateHosts.has(canonicalAttachmentPart(host.part)) &&
        !(includeUnreviewed && host.hints?.length)) continue;
    const m = worldMatrix(host.world);
    if (!m) continue;
    for (const slot of attachmentSlotsFor(host.part, moving.part, host.hints, includeUnreviewed)) {
      if (slot.mirrored && !allowMirrored) continue;
      const world = multiplyAttachmentMatrices(m, attachmentLocalMatrix(slot));
      const occupied = stationary.some((other) => other.id !== host.id &&
        canonicalAttachmentPart(other.part) === canonicalAttachmentPart(slot.insert) &&
        !!attachmentFit(host.world, other.world, slot));
      if (occupied) continue;
      out.push({ owner: host.id, slot, world, anchor: [world[12],world[13],world[14]] });
    }
  }
  return out;
}
