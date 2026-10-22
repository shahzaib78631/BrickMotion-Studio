import type { Box } from '../ldraw/flatten';

/** Uniform-grid broad phase over axis-aligned boxes. */
export class SpatialHash {
  private cells = new Map<string, number[]>();
  constructor(private cell = 40) {}

  private range(b: Box, pad: number) {
    const c = this.cell;
    return [0, 1, 2].map((i) => [Math.floor((b.min[i] - pad) / c), Math.floor((b.max[i] + pad) / c)]);
  }

  insert(index: number, b: Box, pad = 0): void {
    const [[x0, x1], [y0, y1], [z0, z1]] = this.range(b, pad);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const k = `${x},${y},${z}`;
          const list = this.cells.get(k);
          if (list) list.push(index);
          else this.cells.set(k, [index]);
        }
  }

  /** Unique index pairs (i < j) that share at least one cell. */
  pairs(): [number, number][] {
    const seen = new Set<number>();
    const out: [number, number][] = [];
    for (const list of this.cells.values()) {
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          const i = Math.min(list[a], list[b]);
          const j = Math.max(list[a], list[b]);
          if (i === j) continue;
          const k = i * 1_000_003 + j;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push([i, j]);
        }
    }
    return out;
  }
}
