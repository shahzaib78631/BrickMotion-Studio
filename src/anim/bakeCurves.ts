import type { AnimationKey } from '../plan/types';

type Sample = { frame: number; value: number };
/** Ramer-Douglas-Peucker compression with an explicit interpolation-error bound.
 * Every authored FPS sample stays within the per-channel tolerance. */
export function simplifyChannel(samples: readonly Sample[], tolerance: number): AnimationKey[] {
  if (!samples.length) return [];
  if (samples.every((s) => Math.abs(s.value - samples[0].value) <= 1e-8))
    return [{ frame: samples[0].frame, value: samples[0].value, interpolation: 'linear' }];
  const keep = new Set([0, samples.length - 1]);
  const regions: [number, number][] = [[0, samples.length - 1]];
  while (regions.length) {
    const [start, end] = regions.pop()!;
    if (end - start <= 1) continue;
    let error = tolerance, worst = -1;
    const a = samples[start], b = samples[end];
    for (let i = start + 1; i < end; i++) {
      const u = (samples[i].frame - a.frame) / (b.frame - a.frame);
      const diff = Math.abs(samples[i].value - (a.value + u * (b.value - a.value)));
      if (diff > error) { error = diff; worst = i; }
    }
    if (worst !== -1) {
      keep.add(worst);
      regions.push([start, worst], [worst, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => ({ frame: samples[i].frame, value: samples[i].value, interpolation: 'linear' }));
}

