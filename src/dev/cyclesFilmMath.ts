/** Cycles 2.79b render/film.cpp Blackman–Harris window.
 * Copyright 2011–2013 Blender Foundation, Apache-2.0; adapted to TypeScript.
 * https://github.com/blender/blender/blob/v2.79b/intern/cycles/render/film.cpp
 * Coefficients also verified in the installed EyeSight native helper at
 * 0x100d35070 (supplemental disassembly and read-only constant extraction).
 * Cycles doubles filter_width before building the window, so support is ±width.
 */
export function blackmanHarrisWeight(offset: number, width: number): number {
  if (!(width > 0)) throw new Error('Film width must be positive');
  if (Math.abs(offset) > width) return 0;
  const phase = Math.PI * (offset / width + 1);
  return Math.max(0, 0.35875 - 0.48829 * Math.cos(phase) + 0.14128 * Math.cos(2 * phase) - 0.01168 * Math.cos(3 * phase));
}
export function blackmanHarrisCDF(offset: number, width: number): number {
  if (!(width > 0)) throw new Error('Film width must be positive');
  if (offset <= -width) return 0;
  if (offset >= width) return 1;
  const phase = Math.PI * (offset / width + 1), k = Math.PI / width;
  return (0.35875 * (offset + width) - 0.48829 * Math.sin(phase) / k + 0.14128 * Math.sin(2 * phase) / (2 * k) - 0.01168 * Math.sin(3 * phase) / (3 * k)) / (2 * width * 0.35875);
}
export function blackmanHarrisInverseTable(width: number, intervals = 1024): Float32Array {
  const values = new Float32Array(intervals + 1);
  for (let i = 0; i <= intervals; i++) {
    let lo = -width, hi = width;
    for (let j = 0; j < 40; j++) {
      const mid = (lo + hi) / 2;
      if (blackmanHarrisCDF(mid, width) < i / intervals) lo = mid; else hi = mid;
    }
    values[i] = (lo + hi) / 2;
  }
  values[0] = -width; values[intervals] = width;
  return values;
}
