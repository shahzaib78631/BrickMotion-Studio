/** A vehicle at one steering position (spec §5.3-5.4): turning radius, Ackermann error, and each wheel's steer, slip and spin. */
import type { VehicleReport } from '../anim/motion/vehicle/vehicleReport';

const angle = (d: number) => `${d.toFixed(1)}°`;

export function VehicleTable({ report, label = t => t }: { report: VehicleReport; label?(tyre: string): string }) {
  const { turn } = report;
  return <div className="bm-vehicle">
    <p className="nx-fine">{turn.icr ? `Turning radius ${Math.round(turn.radius)} LDU · Ackermann error ${turn.ackermannError.toFixed(1)} LDU` : 'Driving straight'}</p>
    <table className="bm-gearbox">
      <thead><tr><th>Wheel</th><th>Steer</th><th>Slip</th><th title="Wheel turns per 1000 LDU the vehicle travels">Turns / 1000 LDU</th></tr></thead>
      <tbody>{report.wheels.map(w => <tr key={w.tyre}>
        <td>{label(w.tyre)}</td><td>{angle(w.steerDeg)}</td><td>{angle(w.slipDeg)}</td>
        <td>{((w.spinPerLdu * 1000) / (2 * Math.PI)).toFixed(2)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
