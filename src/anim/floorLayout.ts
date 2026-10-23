export type FloorItem = { id: string; w: number; d: number; group: number };
/** A rectangle on the floor, in studs (LDraw x/z axes). */
export type Region = { x0: number; z0: number; width: number; depth: number };

/**
 * Shelf-packs items into rows, left to right, grouped by `group` and then
 * deepest first, largest footprint next (ties keep the caller's order). Rows of
 * like depth waste less floor, so a small model's pieces fit the front band. Once an item does not
 * fit, it and everything after it overflow. An item larger than the region is
 * still placed when it is the first one, so a window always makes progress.
 */
export function layoutFloor(items: FloorItem[], region: Region, gap = 1) {
  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.group - b.it.group || b.it.d - a.it.d || b.it.w * b.it.d - a.it.w * a.it.d || a.i - b.i)
    .map((e) => e.it);
  const pos = new Map<string, { x: number; z: number }>();
  const overflow: string[] = [];
  const xEnd = region.x0 + region.width;
  const zEnd = region.z0 + region.depth;
  let x = region.x0;
  let z = region.z0;
  let rowDepth = 0;
  for (const it of sorted) {
    if (overflow.length) {
      overflow.push(it.id);
      continue;
    }
    if (x > region.x0 && x + it.w > xEnd) {
      z += rowDepth + gap;
      x = region.x0;
      rowDepth = 0;
    }
    const first = pos.size === 0;
    if (!first && z + it.d > zEnd) {
      overflow.push(it.id);
      continue;
    }
    pos.set(it.id, { x, z });
    x += it.w + gap;
    rowDepth = Math.max(rowDepth, it.d);
  }
  return { pos, overflow };
}
