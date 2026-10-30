/** A gearbox's modes (spec §4.2): ratio, neutral or lock-up, each with a button that shifts into it. */
import type { GearRow } from '../anim/motion/gearbox/shiftModes';

const reading = (r: GearRow) => (r.state === 'locked' ? 'locks' : r.state === 'neutral' ? 'neutral' : r.ratio !== undefined ? `${r.ratio.toFixed(2)}:1` : 'turns');

export function GearboxTable({ rows, current, onShift }: { rows: readonly GearRow[]; current?: string; onShift(row: GearRow): void }) {
  return <table className="bm-gearbox">
    <thead><tr><th>Gear</th><th>Ratio</th><th /></tr></thead>
    <tbody>{rows.map(r => <tr key={r.id} className={r.id === current ? 'on' : r.state === 'locked' ? 'locked' : undefined}>
      <td>{r.label}</td>
      <td>{reading(r)}</td>
      <td><button className="nx-btn nx-sm" aria-label={`Shift to ${r.label}`} disabled={r.state === 'locked' || r.id === current}
        title={r.state === 'locked' ? 'These clutches together would lock the gearbox' : ''} onClick={() => onShift(r)}>Shift</button></td>
    </tr>)}</tbody>
  </table>;
}
