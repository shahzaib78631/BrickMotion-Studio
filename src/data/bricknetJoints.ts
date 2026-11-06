import type { Vec3 } from '../ldraw/parse';
import type { Snap } from '../ldraw/shadow';
import { bricknetAliases, bricknetConnectors, type BricknetRow } from './bricknetConnectors.generated';
import { isHingePin } from '../plan/sockets';

/**
 * Fallback hinge and ball connectors from BrickNet's catalogue, for smart joints only.
 *
 * LDCad shadow snaps stay the primary source: a part gets BrickNet hinges only when its own
 * snaps have no hinge finger (SNAP_FGR), and BrickNet balls only when it has no ball
 * (SNAP_GEN sph). `detectEditorJoints` also drops BrickNet-derived mates between two parts
 * that LDCad snaps already join. The snaps returned here are never put into PartMetrics.snaps,
 * so collision columns, stud/pin/bar targets and build animation do not see them. They tell
 * smart joints that two parts turn about a shared axis (hinge) or centre (ball), and become
 * hinge and ball placement connectors through `jointConnectors` in plan/connectors.ts.
 *
 * BrickNet hinges mate only BrickNet hinges of the same type: its hinge types do not map onto
 * LDCad finger groups with a consistent gender. BrickNet balls use LDCad's own ball groups
 * and sizes, so they also mate LDCad balls.
 */

/** BrickNet ball types in LDCad's terms: type 0 is the Technic ball joint, type 1 the 8 LDU ball. */
const BALLS: Record<number, { group?: string; radius: number }> = {
  0: { group: 'techBallJnt', radius: 12.7 },
  1: { radius: 8 },
};
/** Hinge finger radius given to BrickNet hinges (LDCad's most common); only their own group mates them. */
const HINGE_RADIUS = 4;
/**
 * Length given to a BrickNet hinge point (centred on it). Two finger snaps join when their
 * centres are within half the sum of their lengths along the axis, so this keeps BrickNet's
 * own 3 LDU matching tolerance; across the axis snapMates allows 1.2 LDU.
 */
export const HINGE_SPAN = 2.5;

const canonical = (part: string) => part.toLowerCase().replace(/\\/g, '/').split('/').pop()!.replace(/\.dat$/, '');

/** Our part id -> BrickNet stem (as python/brickheadz/connectors.py: aliases, then print suffixes stripped). */
export function bricknetStem(part: string): string | null {
  const p = canonical(part);
  for (let c of [p, p.replace(/p[0-9a-z]{2,4}$/, ''), p.replace(/(p|pr|pat)[0-9a-z]+$/, '')]) {
    c = bricknetAliases[c] ?? c;
    if (bricknetConnectors[c]) return c;
  }
  return null;
}

/** The hinge axis of a BrickNet frame: its -Y after pitch (about x) then roll (about z). */
export function hingeAxis(pitchDeg: number, rollDeg: number): Vec3 {
  const x = (pitchDeg * Math.PI) / 180, z = (rollDeg * Math.PI) / 180;
  const cx = Math.cos(x), sx = Math.sin(x), cz = Math.cos(z), sz = Math.sin(z);
  // frame rows [cz,-sz,0], [cx*sz, cx*cz, -sx], [sx*sz, sx*cz, cx]; column 1 is +Y
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return [clean(sz), clean(-cx * cz), clean(-sx * cz)];
}

function toSnap(row: BricknetRow): Snap {
  const [family, type, on, x, y, z, pitch = 0, roll = 0] = row;
  // BrickNet "in" is the male half (the ball, the inner hinge), "on" the female (socket, outer).
  const gender = on ? 'F' : 'M';
  if (family === 'ball') {
    const ball = BALLS[type] ?? { group: `bricknet-ball${type}`, radius: 8 };
    return { kind: 'gen', gender, start: [x, y, z], axis: [0, -1, 0], length: 0, radius: ball.radius,
      shapes: ['GEN:sph'], slide: false, center: true, match: 'size', placement: 'free',
      ...(ball.group ? { group: ball.group } : {}), source: 'bricknet' };
  }
  const axis = hingeAxis(pitch, roll);
  const half = HINGE_SPAN / 2;
  return { kind: 'fgr', gender, group: `bricknet-hinge${type}`,
    start: [x - axis[0] * half, y - axis[1] * half, z - axis[2] * half], axis, length: HINGE_SPAN,
    radius: HINGE_RADIUS, shapes: ['FGR'], slide: false, center: true, source: 'bricknet' };
}

// a finger hinge, or a hinge brick's pin (3830 / 3831): LDCad already describes that hinge
const isHinge = (s: Snap) => s.kind === 'fgr' || isHingePin(s);
export const isBall = (s: Snap) => s.kind === 'gen' && s.shapes.some((x) => x === 'GEN:sph' || x === 'GEN:pnt');

const cache = new Map<string, Snap[]>();

/** BrickNet fallback snaps for a part, given the snaps it already has (part space). */
export function bricknetJointSnaps(part: string, have: readonly Snap[] | undefined): Snap[] {
  const stem = bricknetStem(part);
  if (!stem) return [];
  let all = cache.get(stem);
  if (!all) cache.set(stem, (all = bricknetConnectors[stem].map(toSnap)));
  const own = have ?? [];
  const hinges = !own.some(isHinge), balls = !own.some(isBall);
  return all.filter((s) => (s.kind === 'fgr' ? hinges : balls));
}

/** A part's snaps with the BrickNet fallback joints added. */
export function withBricknetJoints(part: string, have: Snap[] | undefined): Snap[] | undefined {
  const extra = bricknetJointSnaps(part, have);
  return extra.length ? [...(have ?? []), ...extra] : have;
}
