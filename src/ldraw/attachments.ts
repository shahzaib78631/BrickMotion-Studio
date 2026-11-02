import type { AttachmentHint } from './attachmentHints';
import { orthogonalBasisParity } from './attachmentHints';
import type { Mat3, Vec3 } from './parse';

/** Connection knowledge which is deliberately distinct from !LDCAD SNAP_CYL.
 * `reviewed` means the compatibility and intended pose have been audited by
 * a human; it is NOT a mesh collision or route clearance certificate. */
export type AttachmentEvidence = 'reviewed-ldraw-help' | 'reviewed-profile' | 'unreviewed-ldraw-help';
export type AttachmentType = 'friction-slot' | 'reference-placement';
export type AttachmentSlot = {
  id: string;
  host: string;
  insert: string;
  pos: Vec3;
  m: Mat3;
  /** A reflected LDraw reference pose (determinant -1), NOT a physical
   * rotation. Requires explicit opt-in for interactive placement. */
  mirrored: boolean;
  type: AttachmentType;
  evidence: AttachmentEvidence;
  /** Public source documenting the actual placement. */
  source: string;
  /** Written source line, or zero for external profiles. */
  line: number;
  context: string;
  /** Mandatory for owner-curated profiles (not official LDraw source entries). */
  reviewer?: string;
  /** YYYY-MM-DD, mandatory for owner-curated profiles. */
  reviewedAt?: string;
};

/** The reviewed source is official LDraw 19141.dat UPDATE 2018-02.
 * Sword 30173 is now an LDraw alias of 30173a (same local frame).
 * Both poses are examples in !HELP, NOT cylindrical snap connectors.
 * Do not infer insertion direction, friction coefficient, surface clearance,
 * or compatibility with other sword moulds from these two lines. */
const REVIEWED: readonly AttachmentSlot[] = [
  {
    id: '19141:sword:1', host: '19141', insert: '30173a',
    pos: [-0.174, -9, 35.1], m: [0, -0.01745, -0.99985, -1, 0, 0, 0, 0.99985, -0.01745],
    mirrored: false,
    type: 'friction-slot', evidence: 'reviewed-ldraw-help',
    source: 'https://library.ldraw.org/parts/1388', line: 8, context: 'Positioning of Swords',
  },
  {
    id: '19141:sword:2', host: '19141', insert: '30173a',
    pos: [-35.1, -5, 0.174], m: [0, -0.99985, 0.01745, -1, 0, 0, 0, 0.01745, 0.99985],
    mirrored: true,
    type: 'friction-slot', evidence: 'reviewed-ldraw-help',
    source: 'https://library.ldraw.org/parts/1388', line: 9, context: 'Positioning of Swords',
  },
];

/**
 * The joint interface a reviewed slot positions, measured from the part its LDraw example names:
 * 30173a's sword is a 4 LDU bar grip whose base is at (0, −14, 0) pointing +Y. A slot only ever
 * positions that interface, so an insert presenting the same one can stand in for the documented
 * part — and that stays true whether or not the documented part happens to be loaded in the
 * current model, which is what a mesh-free planner needs. `AttachmentSlotInterface` is structural
 * so this stays in the LDraw data layer.
 */
export type AttachmentSlotInterface = { type: string; gender: 'M' | 'F'; pos: readonly number[]; axis: readonly number[] };
const INTERFACES: Readonly<Record<string, readonly AttachmentSlotInterface[]>> = {
  '19141:30173a': [{ type: 'bar', gender: 'M', pos: [0, -14, 0], axis: [0, 1, 0] }],
};

/** The interface a documented pair was written for, or null when only measurement can tell. */
export function declaredSlotInterface(host: string, insert: string): readonly AttachmentSlotInterface[] | null {
  return INTERFACES[`${canonicalAttachmentPart(host)}:${canonicalAttachmentPart(insert)}`] ?? null;
}

/** Alias table is limited to genuinely identical LDraw coordinate frames.
 * Distinct variants (e.g. 30173b) must NOT be treated as equivalent. */
const ALIASES: Readonly<Record<string, string>> = { '30173': '30173a' };
export const canonicalAttachmentPart = (part: string): string => {
  // Only strip the standard official-LDraw `parts/` prefix. A project-local
  // `s/19141.dat` or `custom/19141.dat` must NOT inherit the official part's
  // physical compatibility merely because it shares a basename.
  const path = part.trim().toLowerCase().replace(/\\/g, '/').replace(/\.dat$/, '');
  const id = path.startsWith('parts/') ? path.slice(6) : path;
  return ALIASES[id] ?? id;
};

/** Optional project/application profiles can be registered separately without
 * modifying the LDCad shadow pack. A registered profile is reviewed by the
 * application owner, not promoted from an arbitrary user's !HELP comments. */
let additional: readonly AttachmentSlot[] = [];

const poseDistance = (a: Pick<AttachmentSlot, 'pos' | 'm'>, b: Pick<AttachmentSlot, 'pos' | 'm'>): number =>
  Math.hypot(...a.pos.map((v, i) => v - b.pos[i])) +
  Math.max(...a.m.map((v, i) => Math.abs(v - b.m[i]))) * 20;
const cloneSlot = (p: AttachmentSlot): AttachmentSlot =>
  ({ ...p, pos: [...p.pos] as Vec3, m: [...p.m] as Mat3 });

export function setReviewedAttachmentProfiles(profiles: readonly AttachmentSlot[]): void {
  const seen = new Set<string>();
  const validated = profiles.map((p, index) => {
    if (p.evidence !== 'reviewed-profile' ||
      !/^[a-z0-9][a-z0-9:_.-]{0,119}$/i.test(p.id) ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(canonicalAttachmentPart(p.host)) ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(canonicalAttachmentPart(p.insert)) ||
      !p.reviewer?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.reviewedAt ?? '') ||
      !['friction-slot', 'reference-placement'].includes(p.type) ||
      !p.pos || p.pos.length !== 3 || !p.pos.every(Number.isFinite) ||
      !orthogonalBasisParity(p.m) || p.mirrored !== (orthogonalBasisParity(p.m) === -1) ||
      !/^https:\/\//i.test(p.source) || !Number.isSafeInteger(p.line) || p.line < 0 ||
      typeof p.context !== 'string')
      throw new Error(`Invalid reviewed attachment profile: ${p.id ?? '?'}`);
    const host = canonicalAttachmentPart(p.host), insert = canonicalAttachmentPart(p.insert);
    const key = `${host}:${p.id}`;
    if (seen.has(key) || REVIEWED.some((r) => `${canonicalAttachmentPart(r.host)}:${r.id}` === key))
      throw new Error(`Duplicate attachment slot: ${key}`);
    if ([...REVIEWED, ...profiles.slice(0, index)].some((r) =>
      canonicalAttachmentPart(r.host) === host && canonicalAttachmentPart(r.insert) === insert &&
      poseDistance(r, p) < .1))
      throw new Error(`Duplicate attachment pose: ${key}`);
    seen.add(key);
    return cloneSlot(p);
  });
  // Atomic replacement: failed validation cannot partially install a profile.
  additional = validated;
}

/** Defaults to ONLY reviewed compatibility rules. Unreviewed !HELP examples
 * are opt-in preview suggestions, never automatic assembly connections. */
export function attachmentSlotsFor(host: string, insert: string, hints: readonly AttachmentHint[] = [],
  includeUnreviewed = false): AttachmentSlot[] {
  const hostId = canonicalAttachmentPart(host), insertId = canonicalAttachmentPart(insert);
  const trusted = [...REVIEWED, ...additional].filter((p) =>
    canonicalAttachmentPart(p.host) === hostId && canonicalAttachmentPart(p.insert) === insertId).map(cloneSlot);
  if (!includeUnreviewed) return trusted;
  const learned = hints.filter((h) => canonicalAttachmentPart(h.part) === insertId &&
    !trusted.some((r) => poseDistance(r, h) < .1))
    .map((h, i): AttachmentSlot => ({
      id: `${hostId}:help:${h.line}:${i}`, host: hostId, insert: insertId,
      pos: [...h.pos] as Vec3, m: [...h.m] as Mat3, mirrored: h.mirrored, type: 'reference-placement', evidence: 'unreviewed-ldraw-help',
      source: `LDraw ${hostId}.dat !HELP line ${h.line}`, line: h.line, context: h.context,
    }));
  return [...trusted, ...learned];
}

/** Do not turn a placement suggestion into a virtual SNAP_CYL. */
export const reviewedAttachmentSlots = (): readonly AttachmentSlot[] => [...REVIEWED, ...additional].map(cloneSlot);
