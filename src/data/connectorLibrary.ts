import type { Vec3 } from '../ldraw/parse';
import type { Snap } from '../ldraw/shadow';
import { wheelSeats, type WheelSeat } from './wheelSeats.generated';

/**
 * Connectors measured from the LDraw geometry of parts whose LDCad shadow
 * entries do not describe the joint. LDCad data always wins: these entries only
 * add groups that the shadow library has no connector for.
 */
export type SupplementaryConnector = {
  part: string;
  /** SNAP_GEN group; the tyre and its rim share one group. */
  group: string;
  gender: 'M' | 'F';
  /** centre of the cylindrical seat, in part space (LDU) */
  position: Vec3;
  axis: Vec3;
  /** length along the axis and the seat radius measured from the meshes */
  length: number;
  radius: number;
  note: string;
};

const canonical = (part: string) => part.toLowerCase().replace(/\.dat$/, '').split('/').pop() ?? '';

export const connectorLibrary: readonly SupplementaryConnector[] = [
  {
    part: '51011',
    group: 'rim51011_42610',
    gender: 'F',
    position: [0, 0, 0],
    axis: [0, 0, 1],
    length: 6,
    radius: 14,
    note: 'Tyre 51011: the bead at |z| <= 3 is a 14 LDU bore; its profile closes to r=12 at z=±2 and r=10 at z=±1.',
  },
  {
    part: '42610',
    group: 'rim51011_42610',
    gender: 'M',
    position: [0, 0, 0],
    axis: [0, 0, 1],
    length: 6,
    radius: 14,
    note: 'Rim 42610: outer face r=14 at z=±3, narrowing to r=12/r=10 at z=±2/±1, so it seats in the 51011 bead.',
  },
  {
    part: '61254',
    group: 'rim61254_13971',
    gender: 'F',
    position: [0, 0, 0],
    axis: [0, 0, 1],
    length: 8,
    radius: 21,
    note: 'Tyre 61254: the inner bore is r≈20-22 at |z| <= 4 and opens to r=22..24.7 toward the sidewalls.',
  },
  {
    part: '13971',
    group: 'rim61254_13971',
    gender: 'M',
    position: [0, 0, 0],
    axis: [0, 0, 1],
    length: 8,
    radius: 21,
    note: 'Rim 13971: outer face reaches r=21 at z=±4..9, filling the 61254 bore.',
  },
];

/**
 * Measured tyre/rim seats from the LDraw geometry. Parts with LDCad shadow
 * "rim…" groups are not in this table: LDCad stays authoritative. The tolerance
 * below was tuned by scripts/measure-wheels.ts against those shadow pairings.
 */
export const wheelSeatTolerance = 4;
export const measuredWheelSeats: readonly WheelSeat[] = wheelSeats;
const measuredByPart = new Map(wheelSeats.map((seat) => [canonical(seat.part), seat]));

export function wheelSeatFor(part: string): WheelSeat | undefined {
  return measuredByPart.get(canonical(part));
}

/** Generated seats share a group with their mates; this is only a bucket. */
const measuredGroup = (seat: WheelSeat) => `measured${Math.floor((seat.radius + 0.001) / (2 * wheelSeatTolerance))}`;

/**
 * A tyre can still be recognised as seated when only its own connector data is
 * available (the window-pane case). The rim must have the measured outer radius
 * and its centre must lie on the tyre seat within one LDU.
 */
export type RimSeat = {
  tyre: string;
  rim: string;
  group: string;
  radius: number;
  /** measured part-space wheel axis, used to read the rim radius from its body box */
  axis: Vec3;
  tolerance: number;
  note: string;
};

export const rimSeats: readonly RimSeat[] = [
  { tyre: '51011', rim: '42610', group: 'rim51011_42610', radius: 14, axis: [0, 0, 1], tolerance: 1, note: 'Small aircraft/technic wheel: 51011 tyre on 42610 rim.' },
  { tyre: '61254', rim: '13971', group: 'rim61254_13971', radius: 21, axis: [0, 0, 1], tolerance: 1, note: 'Large 61254 tyre on 13971 rim.' },
];

export function supplementarySnapsFor(part: string): Snap[] {
  const id = canonical(part);
  const hand = connectorLibrary.filter((entry) => canonical(entry.part) === id);
  // The hand groups keep their historical names and are what the two known
  // pairs use; a generated seat must not add a second connector to those parts.
  if (hand.length) return hand.map((entry) => {
    const length = Math.hypot(...entry.axis) || 1;
    const axis: Vec3 = [entry.axis[0] / length, entry.axis[1] / length, entry.axis[2] / length];
    const half = entry.length / 2;
    return {
      kind: 'gen',
      group: entry.group,
      gender: entry.gender,
      start: [entry.position[0] - axis[0] * half, entry.position[1] - axis[1] * half, entry.position[2] - axis[2] * half],
      axis,
      length: entry.length,
      radius: entry.radius,
      shapes: ['GEN:cyl'],
      slide: false,
    };
  });
  const seat = measuredByPart.get(id);
  if (!seat) return [];
  const length = Math.hypot(...seat.axis) || 1;
  const axis: Vec3 = [seat.axis[0] / length, seat.axis[1] / length, seat.axis[2] / length];
  const half = seat.width / 2;
  return [{
    kind: 'gen',
    group: measuredGroup(seat),
    gender: seat.role === 'tyre' ? 'F' : 'M',
    start: [-axis[0] * half, -axis[1] * half, -axis[2] * half],
    axis,
    length: seat.width,
    radius: seat.radius,
    shapes: ['GEN:cyl'],
    slide: false,
  }];
}
