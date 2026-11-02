/**
 * Bounded, deterministic angular sampling for a gesture's collision probe.
 * Returns null rather than accepting an excessively large unchecked leap.
 * This is a DISCRETE collision screen; it is not an exact swept-volume proof.
 */
export function rotationSweepAngles(
  previous: number, target: number,
  maxStep = Math.PI / 36, // 5 degrees
  maxSamples = 12,
): number[] | null {
  if (![previous, target, maxStep, maxSamples].every(Number.isFinite) ||
      maxStep <= 0 || maxSamples < 1) return null;
  const diff = target - previous;
  if (Math.abs(diff) < 1e-9) return [];
  const count = Math.ceil((Math.abs(diff) - 1e-9) / maxStep);
  if (count > Math.floor(maxSamples)) return null;
  return Array.from({ length: count }, (_, n) => previous + diff * (n + 1) / count);
}

/** Maximum angle whose outermost selected point travels at most `maxTipTravel`
 * studs between samples. Long beams need much denser angular collision steps
 * than a small hinge knob, while 5° suffices for a short selection. */
export function angularStepForRadius(radiusStuds: number, maxTipTravel = 0.35): number {
  const defaultStep = Math.PI / 36;
  if (!Number.isFinite(radiusStuds) || radiusStuds <= 0 ||
      !Number.isFinite(maxTipTravel) || maxTipTravel <= 0) return defaultStep;
  return Math.min(defaultStep, 2*Math.asin(Math.min(1,maxTipTravel/(2*radiusStuds))));
}
