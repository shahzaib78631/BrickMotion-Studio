import type { Box } from '../ldraw/flatten';

/** Uniform-grid broad phase over axis-aligned boxes. */
export class SpatialHash {
  private cells = new Map<string, number[]>();
  private allIndices = new Set<number>();
  /** Bounds occupying too many cells are conservatively tested everywhere. */
  private oversized = new Set<number>();
  constructor(private cell = 40) {}

  private range(b: Box, pad: number) {
    const c = this.cell;
    return [0, 1, 2].map((i) => [Math.floor((b.min[i] - pad) / c), Math.floor((b.max[i] + pad) / c)]);
  }

  insert(index: number, b: Box, pad = 0): void {
    this.allIndices.add(index);
    const [[x0, x1], [y0, y1], [z0, z1]] = this.range(b, pad);
    const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (!Number.isFinite(volume) || volume > 8192) {
      this.oversized.add(index);
      return;
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const k = `${x},${y},${z}`;
          const list = this.cells.get(k);
          if (list) list.push(index);
          else this.cells.set(k, [index]);
        }
  }

  /** Candidate occupants of a query AABB. The caller still performs an
   * exact box overlap check. This also handles huge sweep bounds without
   * allocating millions of empty hash buckets. */
  query(b: Box, pad = 0): number[] {
    const [[x0, x1], [y0, y1], [z0, z1]] = this.range(b, pad);
    const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (!Number.isFinite(volume) || volume > 8192) return [...this.allIndices];
    const unique = new Set<number>(this.oversized);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (const index of this.cells.get(`${x},${y},${z}`) ?? []) unique.add(index);
    return [...unique];
  }

  /** Unique index pairs (i < j) that share at least one cell. */
  pairs(): [number, number][] {
    const seen = new Set<string>();
    const out: [number, number][] = [];
    const add = (i: number, j: number) => {
      if (i === j) return;
      const a = Math.min(i, j), b = Math.max(i, j);
      const k = `${a},${b}`;
      if (seen.has(k)) return;
      seen.add(k); out.push([a, b]);
    };
    // Global occupants are candidate contacts with every part, even when a
    // small query/pair lives in a different hash cell.
    for (const huge of this.oversized) for (const index of this.allIndices) add(huge, index);
    for (const list of this.cells.values()) {
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          add(list[a], list[b]);
        }
    }
    return out;
  }
}
