/**
 * Connectors measured from part geometry, for joints the LDCad connector data
 * does not describe:
 *  - designed slides: a part that fills another's bore slides along it (a
 *    shock absorber rod in its cylinder, a piston in its engine cylinder);
 *  - seats: a part with no connectors of its own (a tyre) sits on a round
 *    surface of the same radius (its rim) and moves with it.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import type { MechanicalJoint } from '../../construction/mechanicalConstraintGraph';
import { partFunctions, partId, type PartFunctions } from './partFunctions';
import type { V3 } from './teeth';

/** Axes compare as lines: 4 degrees; centres 1 LDU off a bore axis, 2 off a seat axis. */
const PARALLEL = Math.cos((4 * Math.PI) / 180), ON_BORE = 1, ON_SEAT = 2;
/**
 * A rod fits a bore up to 0.5 LDU wider (LDraw rounding) and fills it to
 * within 1.5 LDU. LDraw shapes overlap where parts meet (a shock rod's stopper
 * is drawn inside the cylinder's solid end), so a wider stretch is allowed if
 * the fitting length is at least twice as long.
 */
const FIT = 0.5, FILL = 1.5, OVERSIZE = 0.5;
/** Least length inside the bore, and how much must stay engaged at full travel. */
const INSERTED = 8, ENGAGED = 4;
/**
 * LDCad describes pin and axle fits (up to the 8 LDU pin-hole counterbore).
 * In a bore no wider than that, a pair LDCad already joins is held (a pin in a
 * pin joiner); a wider bore is a designed slide even where LDCad joins the
 * pair (an engine piston's cylinder snap).
 */
const PIN_FIT = 8;
/** Seat radii agree within 1 LDU and overlap along the axis by half the narrower. */
const SEAT_FIT = 1, SEAT_OVERLAP = 0.5;

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addScaled = (a: readonly number[], b: readonly number[], s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
type Box = { min: readonly number[]; max: readonly number[] };
const overlaps = (a: Box, b: Box) => [0, 1, 2].every(i => a.min[i] <= b.max[i] && b.min[i] <= a.max[i]);

type Placed = { key: string; part: string; world: THREE.Matrix4; box: Box; f: PartFunctions };
const point = (p: V3, m: THREE.Matrix4) => new THREE.Vector3(...p).applyMatrix4(m).toArray() as V3;
const direction = (d: V3, m: THREE.Matrix4) => new THREE.Vector3(...d).transformDirection(m).toArray() as V3;
/** Distance from point p to the line through `o` along unit `u`, and p's position along it. */
function onLine(p: readonly number[], o: readonly number[], u: readonly number[]) {
  const d = sub(p, o), t = dot(d, u);
  return { t, off: Math.hypot(d[0] - u[0] * t, d[1] - u[1] * t, d[2] - u[2] * t) };
}

/**
 * Measured connectors between placed parts. `existing` are the connectors
 * already found (LDCad), which decide whether a pin-sized bore holds its part.
 */
export function libraryConnectors(asm: Assembly, metrics: Metrics, existing: readonly MechanicalJoint[] = []): MechanicalJoint[] {
  const joined = new Set(existing.map(j => pairKey(j.male, j.female)));
  const placed: Placed[] = asm.instances.flatMap(i => {
    const f = partFunctions(i.part);
    return f && (f.bores.length || f.rods.length || f.seats.length) ? [{ key: i.key, part: i.part, world: i.world, box: i.worldBox, f }] : [];
  });
  return [...designedSlides(placed, joined), ...seats(placed, metrics)];
}

/**
 * The known connectors with the measured ones added. A designed slide replaces
 * whatever else joins its two parts: LDCad's turn-only cylinder snap would
 * otherwise lock it.
 */
export function withLibraryConnectors(known: readonly MechanicalJoint[], measured: readonly MechanicalJoint[]): MechanicalJoint[] {
  const slid = new Set(measured.filter(c => c.designedSlide).map(c => pairKey(c.male, c.female)));
  return [...known.filter(j => !slid.has(pairKey(j.male, j.female))), ...measured];
}

function designedSlides(placed: Placed[], joined: Set<string>): MechanicalJoint[] {
  const out: MechanicalJoint[] = [];
  for (const host of placed) for (const bore of host.f.bores) {
    const axis = direction(bore.axis, host.world), start = addScaled(point(bore.centre, host.world), axis, bore.travel[0]);
    const length = bore.travel[1] - bore.travel[0], end = addScaled(start, axis, length), reach = bore.radius + 1;
    const box = { min: [0, 1, 2].map(i => Math.min(start[i], end[i]) - reach), max: [0, 1, 2].map(i => Math.max(start[i], end[i]) + reach) };
    for (const occupant of placed) {
      if (occupant === host || (bore.radius <= PIN_FIT && joined.has(pairKey(occupant.key, host.key))) || !overlaps(occupant.box, box)) continue;
      for (const rod of occupant.f.rods) {
        const along = dot(direction(rod.axis, occupant.world), axis);
        if (Math.abs(along) < PARALLEL) continue;
        const { t, off } = onLine(point(rod.centre, occupant.world), start, axis);
        if (off > ON_BORE) continue;
        // The rod's stretches in bore coordinates (0 .. length along the bore).
        let inside = 0, oversize = 0, widest = 0, deep = Infinity, high = -Infinity, outLow = false, outHigh = false;
        for (const [a, b, r] of rod.segments) {
          const lo = t + Math.min(a * Math.sign(along), b * Math.sign(along)), hi = t + Math.max(a * Math.sign(along), b * Math.sign(along));
          if (lo < -0.25) outLow = true;
          if (hi > length + 0.25) outHigh = true;
          const from = Math.max(lo, 0), to = Math.min(hi, length);
          if (to - from <= 0.25) continue;
          if (r > bore.radius + FIT) { oversize += to - from; continue; }
          inside += to - from; widest = Math.max(widest, r); deep = Math.min(deep, from); high = Math.max(high, to);
        }
        if (inside < INSERTED || oversize > OVERSIZE * inside || widest < bore.radius - FILL) continue;
        // A linear actuator's input axle turns the screw in its bore rather than sliding.
        if (host.f.actuator?.input && partId(occupant.part) === host.f.actuator.input) {
          out.push({ id: `screw:${occupant.key}:${host.key}`, male: occupant.key, female: host.key, type: 'cylindrical',
            axis, centre: addScaled(start, axis, (deep + high) / 2), engagement: inside, motion: 'revolute', rotates: true });
          break;
        }
        // It may move until its inner end reaches the bore's end, or (where it
        // comes out of the bore) until only ENGAGED LDU are left inside.
        const travel: [number, number] = [outLow ? ENGAGED - high : -deep, outHigh ? length - ENGAGED - deep : length - high];
        out.push({
          id: `slide:${occupant.key}:${host.key}`, male: occupant.key, female: host.key, type: 'cylindrical',
          axis, centre: addScaled(start, axis, (deep + high) / 2), engagement: inside,
          motion: 'sliding', rotates: false, designedSlide: true, travel,
        });
        break;
      }
    }
  }
  return out;
}

function seats(placed: Placed[], metrics: Metrics): MechanicalJoint[] {
  const out: MechanicalJoint[] = [];
  // Only a part with no connectors of its own beyond generic seats (a tyre) is held by a seat.
  const loose = placed.filter(p => p.f.seats.some(s => s.gender === 'F') && (metrics(p.part).snaps ?? []).every(s => s.kind === 'gen'));
  const seated = new Set<string>();
  for (const tyre of loose) for (const f of tyre.f.seats) {
    if (f.gender !== 'F') continue;
    const axis = direction(f.axis, tyre.world), centre = point(f.centre, tyre.world);
    for (const rim of placed) {
      if (rim === tyre || seated.has(pairKey(rim.key, tyre.key)) || !overlaps(rim.box, tyre.box)) continue;
      const m = rim.f.seats.find(s => {
        if (s.gender !== 'M' || Math.abs(s.radius - f.radius) > SEAT_FIT) return false;
        if (Math.abs(dot(direction(s.axis, rim.world), axis)) < PARALLEL) return false;
        const { t, off } = onLine(point(s.centre, rim.world), centre, axis);
        const overlap = Math.min(t + s.width / 2, f.width / 2) - Math.max(t - s.width / 2, -f.width / 2);
        return off <= ON_SEAT && overlap >= SEAT_OVERLAP * Math.min(s.width, f.width);
      });
      if (!m) continue;
      seated.add(pairKey(rim.key, tyre.key));
      out.push({ id: `seat:${rim.key}:${tyre.key}`, male: rim.key, female: tyre.key, type: 'cylindrical', axis, centre, engagement: Math.min(m.width, f.width), motion: 'fixed', rotates: false });
      break;
    }
  }
  return out;
}
