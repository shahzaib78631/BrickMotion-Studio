/**
 * Rolling in the ground plane (spec §5.2-5.5). Points are (x, z).
 *
 * The turning centre (ICR) is the least-squares meet of the wheels' axle
 * lines; how far the lines miss it is the Ackermann error. Each contact point
 * moves square to the line from the ICR: the angle between that and the
 * wheel's heading is its slip (scrub). A wheel spins by the part of its
 * contact's travel along its heading, so it rolls without sliding forward or
 * back; the sideways part is the scrub. Wheels on one solid axle must spin
 * together: they take the mean, and the difference is longitudinal scrub.
 */
export type P2 = [number, number];
export type WheelPose = { contact: P2; heading: P2; radius: number; axle: number };
export type Turn = {
  icr: P2 | null;
  /** Of the reference point, LDU; Infinity when straight. */
  radius: number;
  /** RMS distance of the axle lines from the ICR, LDU. */
  ackermannError: number;
  /** +1 or −1 by turning direction (sign of forward × (icr − ref)); 0 straight. */
  sense: 1 | -1 | 0;
};
export type WheelRoll = {
  /** Signed angle from heading to contact velocity, radians in (−π/2, π/2]. */
  slip: number;
  /** Radians of spin per LDU the reference point travels. */
  spinPerLdu: number;
  /** Fraction of a solid-axle wheel's own rolling it is forced off by its axle-mates; 0 when free. */
  longitudinalScrub: number;
};

/** Parallel lines (no meet) below this eigenvalue ratio, or a meet farther than FAR, mean driving straight. */
const DEGENERATE = 1e-9, FAR = 1e6;

const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: P2) => Math.hypot(a[0], a[1]);

/** Least squares over the axle lines (through each contact, square to its heading): Σ (h·(p − c))². */
export function instantCentre(wheels: readonly WheelPose[]): { icr: P2 | null; ackermannError: number } {
  let a = 0, b = 0, d = 0, rx = 0, rz = 0;
  for (const w of wheels) {
    const [hx, hz] = w.heading, k = dot(w.heading, w.contact);
    a += hx * hx; b += hx * hz; d += hz * hz; rx += hx * k; rz += hz * k;
  }
  const det = a * d - b * b, trace = a + d, disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const small = trace / 2 - disc, large = trace / 2 + disc;
  if (!(large > 0) || small < DEGENERATE * large) return { icr: null, ackermannError: 0 };
  const icr: P2 = [(d * rx - b * rz) / det, (a * rz - b * rx) / det];
  if (len(icr) > FAR) return { icr: null, ackermannError: 0 };
  const err = Math.sqrt(wheels.reduce((s, w) => s + dot(w.heading, sub(icr, w.contact)) ** 2, 0) / wheels.length);
  return { icr, ackermannError: err };
}

export function rolling(wheels: readonly WheelPose[], ref: P2, solidAxles: ReadonlySet<number>): { turn: Turn; wheels: WheelRoll[]; yawPerLdu: number } {
  const { icr, ackermannError } = instantCentre(wheels);
  const sum = wheels.reduce((s, w) => [s[0] + w.heading[0], s[1] + w.heading[1]] as P2, [0, 0] as P2);
  const forward: P2 = [sum[0] / len(sum), sum[1] / len(sum)];
  let rolls: WheelRoll[], turn: Turn;
  if (!icr || len(sub(ref, icr)) < 1e-9) {
    turn = { icr: null, radius: Infinity, ackermannError: 0, sense: 0 };
    rolls = wheels.map(w => ({ slip: 0, spinPerLdu: 1 / w.radius, longitudinalScrub: 0 }));
  } else {
    const radius = len(sub(ref, icr));
    // Velocities are square to the radius, all turning one way: the way that moves the reference forward.
    const perp = (p: P2): P2 => { const r = sub(p, icr); return [-r[1], r[0]]; };
    const way = Math.sign(dot(perp(ref), forward)) || 1;
    const sense = Math.sign(cross(forward, sub(icr, ref))) as 1 | -1;
    turn = { icr, radius, ackermannError, sense };
    rolls = wheels.map(w => {
      const v = perp(w.contact).map(x => x * way) as P2;
      let slip = Math.atan2(cross(w.heading, v), dot(w.heading, v));
      // A wheel whose contact moves backward along its heading is rolling backward, not slipping past 90°.
      if (slip > Math.PI / 2) slip -= Math.PI; else if (slip <= -Math.PI / 2) slip += Math.PI;
      const along = dot(w.heading, v) / len(v);
      return { slip, spinPerLdu: (len(v) / radius) * Math.sign(along) * Math.abs(Math.cos(slip)) / w.radius, longitudinalScrub: 0 };
    });
  }
  // Solid axles: one spin, the mean; each wheel's difference is scrub.
  for (const axle of solidAxles) {
    const ids = wheels.flatMap((w, i) => (w.axle === axle ? [i] : []));
    if (ids.length < 2) continue;
    const mean = ids.reduce((s, i) => s + rolls[i].spinPerLdu * wheels[i].radius, 0) / ids.length;
    for (const i of ids) {
      const own = rolls[i].spinPerLdu * wheels[i].radius;
      rolls[i] = { ...rolls[i], spinPerLdu: mean / wheels[i].radius, longitudinalScrub: own === 0 ? 0 : (own - mean) / own };
    }
  }
  return { turn, wheels: rolls, yawPerLdu: turn.sense === 0 ? 0 : turn.sense / turn.radius };
}

/** Kinematic bicycle fallback when no steering mechanism is recognised. */
export function bicycle(wheelbase: number, steer: number): { radius: number } {
  const t = Math.tan(steer);
  return { radius: t === 0 ? Infinity : Math.abs(wheelbase / t) };
}
