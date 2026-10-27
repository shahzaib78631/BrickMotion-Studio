export type FloorItem = { id: string; w: number; d: number; group: number };
/** A rectangle on the floor, in studs (LDraw x/z axes). */
export type Region = {
  x0: number; z0: number; width: number; depth: number;
  /** which edge faces the model, so the used rows are pushed against it: its max z (in front), its min z (behind), or neither (a side) */
  near?: 'front' | 'behind';
};

/** Floor arrangement styles, see FloorStyle in pacing.ts. */
export type LayoutStyle = 'packed' | 'spaced' | 'grid' | 'rows' | 'scattered' | 'showcase' | 'gallery' | 'fan' | 'camera-frame';

/** How much more floor a style needs than tight packing (the bands are sized by it). */
export const STYLE_AREA: Record<LayoutStyle, number> = { packed: 1, spaced: 2.2, grid: 2.3, rows: 1.7, scattered: 2.5, showcase: 2.7, gallery: 2.9, fan: 3.4, 'camera-frame': 3.1 };

/** A small deterministic hash in [0, 1) of a string, so a layout is the same every time. */
export function hash01(id: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * Shelf-packs items into rows, left to right, grouped by `group` and then
 * deepest first, largest footprint next (ties keep the caller's order). Rows of
 * like depth waste less floor, so a small model's pieces fit the front band. Once an item does not
 * fit, it and everything after it overflow. An item larger than the region is
 * still placed when it is the first one, so a window always makes progress.
 *
 * Styles: 'packed' (1-stud gaps), 'spaced' (3-stud gaps), 'rows' (a new row for
 * every group), 'grid' (every piece centred in an even grid of cells) and
 * 'scattered' (spaced, each piece nudged a little off the grid).
 */
export function layoutFloor(items: FloorItem[], region: Region, gap = 1, style: LayoutStyle = 'packed', aspect = 1) {
  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.group - b.it.group || b.it.d - a.it.d || b.it.w * b.it.d - a.it.w * a.it.d || a.i - b.i)
    .map((e) => e.it);
  const composed = style === 'showcase' || style === 'gallery' || style === 'fan' || style === 'camera-frame';
  const g = style === 'spaced' || style === 'scattered' || composed ? Math.max(gap, 3) : style === 'rows' ? Math.max(gap, 2) : gap;
  // grid cells fit most pieces; a bigger piece takes several cells
  let cell = 0;
  if (style === 'grid' && sorted.length) {
    const sizes = sorted.map((it) => Math.max(it.w, it.d)).sort((a, b) => a - b);
    cell = Math.max(2, sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.75))]);
  }
  const slot = (it: FloorItem) => {
    if (!cell) return { w: it.w, d: it.d, ox: 0, oz: 0 };
    const cw = Math.ceil(it.w / cell), cd = Math.ceil(it.d / cell);
    const w = cw * cell + (cw - 1) * g, d = cd * cell + (cd - 1) * g;
    return { w, d, ox: Math.floor((w - it.w) / 2), oz: Math.floor((d - it.d) / 2) };
  };
  const pos = new Map<string, { x: number; z: number }>();
  // Composed rows may contain thousands of parts. Looking up each width by an
  // items.find() during row centering was quadratic in the piece count.
  const widths = new Map(sorted.map((it) => [it.id, it.w]));
  const overflow: string[] = [];
  // Set the *occupied* row width by the chosen output ratio, while respecting
  // the available band. Portrait formats keep tighter, centered rows; wide
  // formats use more horizontal space. Positions remain in model/world studs.
  const footprint = sorted.reduce((a, it) => a + (it.w + g) * (it.d + g), 0);
  const widest = sorted.reduce((a, it) => Math.max(a, it.w), 0);
  const targetWidth = style === 'camera-frame'
    ? Math.max(widest, Math.min(region.width, Math.sqrt(footprint * Math.max(0.3, Math.min(3, aspect)))))
    : region.width;
  const xEnd = region.x0 + targetWidth;
  const zEnd = region.z0 + region.depth;
  let x = region.x0;
  let z = region.z0;
  let rowDepth = 0;
  let lastGroup: number | null = null;
  let rowIds: string[] = [];
  const rowStart = region.x0;
  // Centre each completed shelf around the build, not against a band edge.
  const finishRow = () => {
    if (!composed || !rowIds.length) return;
    const occupied = x - g - rowStart;
    const offset = Math.max(0, (region.width - occupied) / 2);
    const mid = rowStart + occupied / 2;
    for (const id of rowIds) {
      const p = pos.get(id)!;
      const width = widths.get(id)!;
      const distance = Math.abs(p.x + width / 2 - mid) / Math.max(1, occupied / 2);
      p.x += offset;
      // Fan: outer pieces recede slightly, yielding a camera-facing arc.
      if (style === 'fan') p.z += Math.round(distance * 2) / 2;
    }
    rowIds = [];
  };
  for (const it of sorted) {
    if (overflow.length) {
      overflow.push(it.id);
      continue;
    }
    const s = slot(it);
    const newGroupRow = (style === 'rows' || style === 'gallery') && lastGroup !== null && it.group !== lastGroup;
    if (x > region.x0 && (x + s.w > xEnd || newGroupRow)) {
      finishRow();
      z += rowDepth + g;
      x = region.x0;
      rowDepth = 0;
    }
    const first = pos.size === 0;
    if (!first && z + s.d + (style === 'fan' ? 2 : 0) > zEnd) {
      overflow.push(it.id);
      continue;
    }
    let jx = 0, jz = 0;
    if (style === 'scattered') {
      // stay inside the gap so neighbours never touch
      jx = Math.round((hash01(it.id, 1) - 0.5) * 2 * 2) / 2;
      jz = Math.round((hash01(it.id, 2) - 0.5) * 2 * 2) / 2;
    }
    pos.set(it.id, { x: x + s.ox + jx, z: z + s.oz + jz });
    x += s.w + g;
    rowIds.push(it.id);
    rowDepth = Math.max(rowDepth, s.d + (style === 'fan' ? 2 : 0));
    lastGroup = it.group;
  }
  finishRow();
  return { pos, overflow };
}
