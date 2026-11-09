/// <reference lib="webworker" />
import { decodeCodes, sampleCodes, ShapeWeights } from './shapeModel';

/**
 * Runs the shape model off the page's thread: sampling the codes takes seconds, and the
 * editor should stay responsive meanwhile.
 *
 * in:  { id, url, clip: Float32Array, seed, guidance? }
 * out: { id, progress: [done, total] } … then { id, grid: Uint8Array, config } or { id, error }
 */

const cache = new Map<string, Promise<ShapeWeights>>();

function load(url: string): Promise<ShapeWeights> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`The shape model is not installed (${url}).`);
      return r.arrayBuffer();
    }).then(ShapeWeights.parse);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

self.onmessage = async (e: MessageEvent<{ id: number; url: string; clip: Float32Array; seed: number; guidance?: number }>) => {
  const { id, url, clip, seed, guidance } = e.data;
  try {
    const m = await load(url);
    let last = 0;
    const codes = await sampleCodes(m, clip, {
      guidance,
      random: mulberry32(seed),
      progress: (done, total) => {
        if (done - last >= 4 || done === total) { last = done; postMessage({ id, progress: [done, total] }); }
      },
    });
    const grid = decodeCodes(m, codes);
    postMessage({ id, grid, config: m.config }, { transfer: [grid.buffer] });
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
