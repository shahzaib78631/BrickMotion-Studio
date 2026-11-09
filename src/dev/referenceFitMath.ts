/** Bounded nonnegative least squares on the sufficient statistics AᵀWA and AᵀWb.
 * Coordinate descent solves each one-dimensional quadratic exactly; no optimizer dependency.
 */
export function solveLighting(gram: number[][], cross: number[], upper: number[], iterations = 400): number[] {
  const n = cross.length, x = new Array<number>(n).fill(0);
  for (let step = 0; step < iterations; step++) {
    let change = 0;
    for (let i = 0; i < n; i++) {
      if (gram[i][i] < 1e-12) continue;
      let residual = cross[i];
      for (let j = 0; j < n; j++) if (j !== i) residual -= gram[i][j] * x[j];
      const value = Math.max(0, Math.min(upper[i], residual / gram[i][i]));
      change = Math.max(change, Math.abs(value - x[i])); x[i] = value;
    }
    if (change < 1e-8) break;
  }
  return x;
}
export function linearChannel(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
export function displayChannel(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(value, 0) ** (1 / 2.4) - 0.055;
}

export const TONE_ABSCISSAE = [0, 0.004, 0.012, 0.03, 0.07, 0.15, 0.35, 1] as const;
export function toneAt(value: number, curve: readonly number[]): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  for (let i = 0; i < 7; i++) if (value <= TONE_ABSCISSAE[i + 1]) {
    const t = (value - TONE_ABSCISSAE[i]) / (TONE_ABSCISSAE[i + 1] - TONE_ABSCISSAE[i]);
    return curve[i] * (1 - t) + curve[i + 1] * t;
  }
  return 1;
}
export function inverseTone(value: number, curve: readonly number[]): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (toneAt(mid, curve) < value) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Monotone piecewise-linear transfer, parameterized by seven nonnegative increments.
 * A small identity prior regularizes poorly observed intensities; endpoints are anchored.
 */
export function fitTone(observations: Iterable<{ x: number; y: number; weight: number }>): number[] {
  const gram = Array.from({ length: 7 }, () => new Array<number>(7).fill(0)), cross = new Array<number>(7).fill(0);
  for (const { x, y, weight } of observations) {
    const row = Array.from({ length: 7 }, (_, i) => Math.max(0, Math.min(1, (x - TONE_ABSCISSAE[i]) / (TONE_ABSCISSAE[i + 1] - TONE_ABSCISSAE[i]))));
    for (let i = 0; i < 7; i++) {
      cross[i] += weight * row[i] * y;
      for (let j = 0; j < 7; j++) gram[i][j] += weight * row[i] * row[j];
    }
  }
  for (let i = 0; i < 7; i++) {
    gram[i][i] += 0.1; cross[i] += 0.1 * (TONE_ABSCISSAE[i + 1] - TONE_ABSCISSAE[i]);
    cross[i] += 100;
    for (let j = 0; j < 7; j++) gram[i][j] += 100;
  }
  const increments = solveLighting(gram, cross, new Array(7).fill(1), 4000);
  const sum = increments.reduce((a, b) => a + b, 0) || 1;
  const curve = [0];
  for (const increment of increments) curve.push(curve[curve.length - 1] + increment / sum);
  curve[7] = 1;
  return curve;
}
