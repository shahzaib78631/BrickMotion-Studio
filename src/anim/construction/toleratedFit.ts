/**
 * A fit accepted only within a tolerance. LDraw files are hand placed and
 * often a fraction of a unit off; we accept small errors so the model still
 * works, and report each one so the file can be corrected.
 */
export type ToleratedFit = {
  /** Which allowance was used. */
  rule: 'axis-offset' | 'axis-angle' | 'section-misfit' | 'bore-offset' | 'seat-offset' | 'mesh-error';
  /** How far off the file is, and the most we accept, in `unit`. */
  measured: number;
  allowed: number;
  unit: 'LDU' | 'deg';
  /** What is off, in words, and what to correct. */
  detail: string;
};

/**
 * Below these the file is as exact as LDraw's own rounding (coordinates are
 * usually written to 2-3 decimals): not worth reporting.
 */
export const REPORT_LDU = 0.1, REPORT_DEG = 0.5;

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * How far apart two connector axis lines are, as tolerated fits: the second
 * line's start point off the first line, and the angle between them.
 */
export function axisLineFits(
  start: readonly number[], axis: readonly number[], otherStart: readonly number[], otherAxis: readonly number[],
  allowedLdu: number, allowedDeg: number, what: string,
): ToleratedFit[] {
  const out: ToleratedFit[] = [];
  const d = [0, 1, 2].map(k => otherStart[k] - start[k]), t = dot(d, axis);
  const off = Math.hypot(d[0] - axis[0] * t, d[1] - axis[1] * t, d[2] - axis[2] * t);
  if (off > REPORT_LDU) out.push({ rule: 'axis-offset', measured: off, allowed: allowedLdu, unit: 'LDU',
    detail: `${what}: axes ${off.toFixed(2)} LDU apart (accepted up to ${allowedLdu}); move one part onto the other's axis` });
  const angle = (Math.acos(Math.min(1, Math.abs(dot(axis, otherAxis)))) * 180) / Math.PI;
  if (angle > REPORT_DEG) out.push({ rule: 'axis-angle', measured: angle, allowed: allowedDeg, unit: 'deg',
    detail: `${what}: axes ${angle.toFixed(1)}° out of line (accepted up to ${allowedDeg}°); square up the part's rotation` });
  return out;
}
