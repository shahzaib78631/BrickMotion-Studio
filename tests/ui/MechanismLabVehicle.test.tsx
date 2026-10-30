// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { VehicleTable } from '../../src/ui/VehicleTable';
import type { VehicleReport } from '../../src/anim/motion/vehicle/vehicleReport';

afterEach(cleanup);

const wheel = (tyre: string, steerDeg: number, slip: number, spinPerLdu: number) =>
  ({ tyre, steerDeg, slipDeg: (slip * 180) / Math.PI, spinPerLdu, longitudinalScrub: 0 });
const turning: VehicleReport = { model: 'steering', yawPerLdu: 1 / 300,
  turn: { icr: [300, 0], radius: 300, ackermannError: 2.25, sense: 1 },
  wheels: [wheel('front', 21, 0, 0.02), wheel('rear', 0, 0.197, (2 * Math.PI) / 1000)] };

test('a turning vehicle: radius, Ackermann error, and a row per wheel', () => {
  render(<VehicleTable report={turning} label={t => `${t} tyre`} />);
  expect(screen.getByText('Turning radius 300 LDU · Ackermann error 2.3 LDU')).toBeTruthy();
  expect(screen.getByText('rear tyre')).toBeTruthy();
  expect(screen.getByText('11.3°')).toBeTruthy();
  expect(screen.getByText('21.0°')).toBeTruthy();
  // One turn per 1000 LDU of travel.
  expect(screen.getByText('1.00')).toBeTruthy();
});

test('a straight vehicle says so', () => {
  render(<VehicleTable report={{ ...turning, model: 'straight', turn: { icr: null, radius: Infinity, ackermannError: 0, sense: 0 } }} />);
  expect(screen.getByText('Driving straight')).toBeTruthy();
});
