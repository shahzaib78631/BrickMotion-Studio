import type { TransitionSettings } from './types';

/**
 * How far a camera move swings around the model, in degrees, positive clockwise. This is the
 * one rule the sampler and the editor share: the end key's azimuth, the chosen direction, and
 * any whole extra turns decide the total.
 */
export function orbitDegreesOf(startAzimuth: number, endAzimuth: number, s: Pick<TransitionSettings, 'orbit' | 'extraTurns'>): number {
  const pos = (((endAzimuth - startAzimuth) % 360) + 360) % 360;
  // a chosen direction between two keys facing the same way circles all the way round
  if (s.orbit === 'cw') return (pos === 0 ? 360 : pos) + 360 * Math.max(0, Math.floor(s.extraTurns));
  if (s.orbit === 'ccw') return -(pos === 0 ? 360 : 360 - pos) - 360 * Math.max(0, Math.floor(s.extraTurns));
  return pos > 180 ? pos - 360 : pos;
}

/**
 * The end azimuth and orbit settings that make a move turn exactly `degrees` around the model —
 * so "orbit around 90°", "a full turn", "three quarters the long way" are all expressible.
 * `extraTurns` carries whole revolutions; the direction decides which way the rest is covered.
 */
export function orbitTurn(startAzimuth: number, degrees: number): { azimuth: number; orbit: TransitionSettings['orbit']; extraTurns: number } {
  const total = Number.isFinite(degrees) ? degrees : 0;
  const turns = Math.max(0, Math.floor(Math.abs(total) / 360));
  const rest = Math.abs(total) - turns * 360;
  if (Math.abs(total) < 1e-9) return { azimuth: startAzimuth, orbit: 'shortest', extraTurns: 0 };
  if (total > 0) return { azimuth: startAzimuth + rest, orbit: 'cw', extraTurns: turns };
  return { azimuth: startAzimuth - rest, orbit: 'ccw', extraTurns: turns };
}

/** A whole number of degrees, for display and for the field. */
export const roundDegrees = (v: number) => Math.round(v * 10) / 10;
