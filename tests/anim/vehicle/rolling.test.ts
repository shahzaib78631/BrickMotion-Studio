/** Rolling geometry in the ground plane (spec §5.2-5.5). Ground plane points are (x, z). */
import { describe, expect, it } from 'vitest';
import { bicycle, instantCentre, rolling, type P2, type WheelPose } from '../../../src/anim/motion/vehicle/rolling';

const R = 10;
/** A wheel at `c` whose heading is square to the line from `icr`, pointing toward +z. */
const toward = (c: P2, icr: P2, axle: number): WheelPose => {
  const d: P2 = [c[0] - icr[0], c[1] - icr[1]];
  let h: P2 = [-d[1], d[0]];
  if (h[1] < 0) h = [-h[0], -h[1]];
  const n = Math.hypot(...h);
  return { contact: c, heading: [h[0] / n, h[1] / n], radius: R, axle };
};
const straight = (c: P2, axle: number): WheelPose => ({ contact: c, heading: [0, 1], radius: R, axle });

describe('turning centre and slip', () => {
  // Wheelbase 100, track 60; rear axle on z = 0 with the reference at its middle; ICR at (200, 0).
  const icr: P2 = [200, 0];
  const car = [straight([-30, 0], 0), straight([30, 0], 0), toward([-30, 100], icr, 1), toward([30, 100], icr, 1)];

  it('a perfect Ackermann car turns about the meet of its axle lines with no slip', () => {
    const c = instantCentre(car);
    expect(c.icr![0]).toBeCloseTo(200, 9);
    expect(c.icr![1]).toBeCloseTo(0, 9);
    expect(c.ackermannError).toBeLessThan(1e-9);
    const r = rolling(car, [0, 0], new Set());
    expect(r.turn.radius).toBeCloseTo(200, 9);
    expect(r.wheels.every(w => Math.abs(w.slip) < 1e-9)).toBe(true);
    // The outer (left, farther from the ICR) wheels roll further.
    expect(r.wheels[0].spinPerLdu).toBeGreaterThan(r.wheels[1].spinPerLdu);
    expect(r.wheels[0].spinPerLdu).toBeCloseTo(230 / 200 / R, 9);
    expect(Math.abs(r.yawPerLdu)).toBeCloseTo(1 / 200, 12);
  });

  it('turning the other way mirrors the yaw', () => {
    const mirror = car.map(w => ({ ...w, contact: [-w.contact[0], w.contact[1]] as P2, heading: [-w.heading[0], w.heading[1]] as P2 }));
    expect(rolling(mirror, [0, 0], new Set()).yawPerLdu).toBeCloseTo(-rolling(car, [0, 0], new Set()).yawPerLdu, 12);
  });

  it('driving straight has no centre, no slip, no yaw and no NaN', () => {
    const r = rolling([straight([-30, 0], 0), straight([30, 0], 0), straight([-30, 100], 1), straight([30, 100], 1)], [0, 0], new Set());
    expect(r.turn.icr).toBeNull();
    expect(r.turn.radius).toBe(Infinity);
    expect(r.turn.sense).toBe(0);
    expect(r.yawPerLdu).toBe(0);
    for (const w of r.wheels) {
      expect(w.slip).toBe(0);
      expect(w.spinPerLdu).toBe(1 / R);
      expect(w.longitudinalScrub).toBe(0);
    }
  });

  it('tandem axles either side of the turning centre slip in opposite senses', () => {
    const icr2: P2 = [300, 0];
    const truck = [straight([-30, 60], 0), straight([30, 60], 0), straight([-30, -60], 1), straight([30, -60], 1),
      toward([-30, 200], icr2, 2), toward([30, 200], icr2, 2)];
    const r = rolling(truck, [0, 0], new Set());
    expect(r.turn.icr![0]).toBeCloseTo(300, 6);
    expect(r.turn.icr![1]).toBeCloseTo(0, 6);
    expect(r.turn.ackermannError).toBeCloseTo(Math.sqrt((4 * 60 * 60) / 6), 6);
    const slip = r.wheels.map(w => w.slip);
    expect(Math.abs(slip[0])).toBeCloseTo(Math.atan(60 / 330), 9);
    expect(Math.abs(slip[1])).toBeCloseTo(Math.atan(60 / 270), 9);
    expect(Math.sign(slip[0])).toBe(-Math.sign(slip[2]));
    expect(Math.sign(slip[1])).toBe(-Math.sign(slip[3]));
    expect(slip.every(s => Math.abs(s) < Math.PI / 2)).toBe(true);
  });

  it('wheels on a solid axle share one spin and report the mismatch as scrub', () => {
    const icr2: P2 = [300, 0];
    const truck = [straight([30, 0], 0), straight([-30, 0], 0), toward([-30, 100], icr2, 1), toward([30, 100], icr2, 1)];
    const r = rolling(truck, [0, 0], new Set([0]));
    expect(r.wheels[0].spinPerLdu).toBeCloseTo(r.wheels[1].spinPerLdu, 12);
    expect(r.wheels[0].spinPerLdu).toBeCloseTo(1 / R, 9);
    expect(r.wheels[0].longitudinalScrub).toBeCloseTo((270 - 300) / 270, 9);
    expect(r.wheels[1].longitudinalScrub).toBeCloseTo((330 - 300) / 330, 9);
    expect(r.wheels[2].longitudinalScrub).toBe(0);
  });
});

it('bicycle model: radius = wheelbase / tan(steer)', () => {
  expect(bicycle(100, Math.atan(0.5)).radius).toBeCloseTo(200, 9);
  expect(bicycle(100, 0).radius).toBe(Infinity);
});
