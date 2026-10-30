/**
 * Shift elements (spec §4.1): a driving ring that slides along its shaft and
 * couples a clutch gear to it when its dogs enter the gear's socket.
 *
 * Found from measured geometry, not part numbers:
 *   - a ring is a part with a long male seat (the dog sleeve, at least 30 LDU
 *     wide) lying on a rod of a part in another body: that body is its shaft;
 *   - a clutch gear is a toothed part in a third body with a female seat on
 *     the same line, a little wider than the dogs (the socket).
 * Positions along the ring axis are measured from the dogs' centre at rest.
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import type { Recognition } from '../mobility/recognise';
import { partFunctions } from '../parts/partFunctions';

type V3 = [number, number, number];
/** [from, to] along the ring axis, LDU, at rest. */
export type Span = [number, number];
/** LDU of dog overlap that counts as engaged. */
export const ENGAGE_MIN = 2;
/** Dogs per ring: the alignment pitch is 2π / DOGS. */
export const DOGS = 4;
/** A dog sleeve is at least this wide (a bush or gear hub seat is narrower). */
const DOG_WIDTH = 30;
/** A socket is at most this much wider in radius than the dogs. */
const SOCKET_PLAY = 4;
/** A rod the ring rides on is at least this thick. */
const ROD_MIN_RADIUS = 8;
const ON_LINE = 2.5;
const PARALLEL = Math.cos((4 * Math.PI) / 180);

export type ShiftCoupling = { gear: string; gearBody: number; side: 1 | -1; engageAt: number };
export type ShiftElement = {
  ring: string; ringBody: number; shaftBody: number;
  axis: V3; centre: V3;
  travel: Span; couplings: ShiftCoupling[]; dogs: number;
};

/** How far the dogs reach into a socket after sliding `s` LDU. */
export function dogOverlap(dogs: Span, socket: Span, s: number): number {
  return Math.max(0, Math.min(dogs[1] + s, socket[1]) - Math.max(dogs[0] + s, socket[0]));
}

/** The ring's slide: on each side, until the dogs bottom out in a socket; a side with none mirrors the other. */
export function ringTravel(dogs: Span, sockets: readonly Span[]): Span {
  const centre = (x: Span) => (x[0] + x[1]) / 2 - (dogs[0] + dogs[1]) / 2;
  const plus = sockets.filter(x => centre(x) > 0).map(x => x[1] - dogs[1]);
  const minus = sockets.filter(x => centre(x) < 0).map(x => x[0] - dogs[0]);
  const max = plus.length ? Math.min(...plus) : null, min = minus.length ? Math.max(...minus) : null;
  if (max === null && min === null) return [0, 0];
  return [min ?? -max!, max ?? -min!];
}

const v = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const arr = (a: THREE.Vector3): V3 => [a.x, a.y, a.z];
const offLine = (p: THREE.Vector3, point: THREE.Vector3, axis: THREE.Vector3) => {
  const d = p.clone().sub(point);
  return d.addScaledVector(axis, -d.dot(axis)).length();
};

export function findShiftElements(asm: Assembly, rec: Recognition): ShiftElement[] {
  const placed = asm.instances.map(i => ({ i, f: partFunctions(i.part), body: rec.bodyOf.get(i.key) }));
  const world = (m: THREE.Matrix4, centre: readonly number[], axis: readonly number[]) =>
    ({ centre: v(centre).applyMatrix4(m), axis: v(axis).transformDirection(m) });
  const out: ShiftElement[] = [];
  for (const ring of placed) {
    if (ring.body === undefined || !ring.f) continue;
    for (const seat of ring.f.seats) {
      if (seat.gender !== 'M' || seat.width < DOG_WIDTH) continue;
      const dog = world(ring.i.world, seat.centre, seat.axis);
      const dogs: Span = [-seat.width / 2, seat.width / 2];
      const coaxial = (c: THREE.Vector3, a: THREE.Vector3) => Math.abs(a.dot(dog.axis)) >= PARALLEL && offLine(c, dog.centre, dog.axis) <= ON_LINE;
      // The shaft: a rod of another body running through the ring.
      const shaft = placed.find(p => p.body !== undefined && p.body !== ring.body && p.f?.rods.some(r => {
        const rod = world(p.i.world, r.centre, r.axis);
        if (!coaxial(rod.centre, rod.axis)) return false;
        const t = dog.centre.clone().sub(rod.centre).dot(rod.axis);
        return r.segments.some(([from, to, radius]) => from <= t && t <= to && radius >= ROD_MIN_RADIUS && radius <= seat.radius);
      }));
      if (!shaft) continue;
      // Clutch gears: toothed parts of a third body with a socket on the dogs' line.
      const couplings: ShiftCoupling[] = [], sockets: Span[] = [];
      for (const g of placed) {
        if (g.body === undefined || g.body === ring.body || g.body === shaft.body || !g.f?.teeth.length) continue;
        for (const s of g.f.seats) {
          if (s.gender !== 'F' || s.radius < seat.radius || s.radius > seat.radius + SOCKET_PLAY) continue;
          const socket = world(g.i.world, s.centre, s.axis);
          if (!coaxial(socket.centre, socket.axis)) continue;
          const c = socket.centre.clone().sub(dog.centre).dot(dog.axis), span: Span = [c - s.width / 2, c + s.width / 2];
          // Within the dogs' reach: no further than one socket depth past their end.
          if (Math.abs(c) > dogs[1] + s.width + SOCKET_PLAY) continue;
          const side = c > 0 ? 1 : -1;
          const engageAt = side > 0 ? span[0] - dogs[1] + ENGAGE_MIN : span[1] - dogs[0] - ENGAGE_MIN;
          couplings.push({ gear: g.i.key, gearBody: g.body, side, engageAt });
          sockets.push(span);
          break;
        }
      }
      if (!couplings.length) continue;
      out.push({ ring: ring.i.key, ringBody: ring.body, shaftBody: shaft.body!, axis: arr(dog.axis), centre: arr(dog.centre),
        travel: ringTravel(dogs, sockets), couplings, dogs: DOGS });
      break;
    }
  }
  return out;
}
