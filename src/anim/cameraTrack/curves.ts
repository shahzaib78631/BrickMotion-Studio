import type { SpeedCurve } from './types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Progress 0..1 of a move at time fraction `u`, for a speed curve. Always 0 at 0 and 1 at 1, never decreasing. */
export function curveAt(c: SpeedCurve, u: number): number {
  const x = clamp01(u);
  const s = clamp01(c.strength);
  const p = 1 + 2 * s;
  switch (c.kind) {
    case 'linear': return x;
    case 'easeIn': return Math.pow(x, p);
    case 'easeOut': return 1 - Math.pow(1 - x, p);
    case 'easeInOut': return x < 0.5 ? 0.5 * Math.pow(2 * x, p) : 1 - 0.5 * Math.pow(2 - 2 * x, p);
    case 'holdThenMove': {
      // still for the first part, then a smooth move
      const hold = 0.25 + 0.25 * s;
      if (x <= hold) return 0;
      const v = (x - hold) / (1 - hold);
      return v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) * (1 - v);
    }
    case 'snap': return 1 - Math.pow(1 - x, 2 + 6 * s);
  }
}

/** Extra progress that pushes a move past its end and lets it settle back: 0 at both ends. */
export function overshootAt(u: number, amount: number): number {
  if (amount <= 0) return 0;
  const x = clamp01(u);
  if (x === 0) return 0;
  return amount * 0.2 * Math.sin(Math.PI * x * x);
}
