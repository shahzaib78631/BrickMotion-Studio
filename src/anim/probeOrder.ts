/** A deterministic permutation of area-ordered surface probes. A coprime stride
 * visits every probe exactly once while spreading the prefix over the surface.
 * This changes rejection latency, never coverage or collision tolerance. */
export function spreadProbeOrder(count: number): Uint32Array {
  const order = new Uint32Array(count);
  if (!count) return order;
  const gcd = (a: number, b: number): number => { while (b) { const r = a % b; a = b; b = r; } return a; };
  let stride = Math.max(1, Math.floor(count * 0.6180339887498949));
  while (gcd(stride, count) !== 1) stride++;
  const used = new Uint8Array(count);
  let next = 0;
  // A small dispersed prefix catches obstructions early; the remainder stays
  // in triangle order to retain BVH/data locality for genuinely clear sweeps.
  for (let i = 0; i < Math.min(32, count); i++) {
    const index = i * stride % count; order[next++] = index; used[index] = 1;
  }
  for (let i = 0; i < count; i++) if (!used[i]) order[next++] = i;
  return order;
}
