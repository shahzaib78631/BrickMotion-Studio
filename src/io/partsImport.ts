import type { BomRow } from '../plan/types';

/** One line of a Rebrickable parts export: an LDraw part, its colour, a quantity and whether it is spare. */
export type RebrickablePartRow = BomRow;

/** A part bin entry: the LDraw part file, where it came from, its colour and how many are needed. */
export type PartsBinItem = { part: string; sourceInv: string; color: number; count: number };

/** A parts bin document: its options, caption and the `<items>` the bin holds. */
export type PartsBinFile = { kind: string; caption: string; sortOn: string; items: PartsBinItem[] };

const stripBom = (text: string) => text.replace(/^\uFEFF/, '');

const isSpareFlag = (value: string | undefined): boolean => /^(true|yes|1|spare)$/i.test((value ?? '').trim());

/**
 * Reads a Rebrickable **Export Parts → Rebrickable CSV** bill of materials: the
 * `Part,Color,Quantity,Is Spare` header, then one row per part and colour. Part ids are
 * LDraw part numbers (`3070b`); the colour is an LDraw colour code. Spares are kept on
 * the row so the caller can drop them.
 */
export function parseRebrickablePartsCsv(text: string): RebrickablePartRow[] {
  const rows: RebrickablePartRow[] = [];
  const lines = stripBom(text).split(/\r?\n/);
  let sawHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (!sawHeader) {
      sawHeader = true;
      const head = cells.join(',').toLowerCase();
      if (head.includes('part') && head.includes('color')) continue; // the export header row
    }
    if (cells.length < 3) continue;
    const part = cells[0].replace(/\.dat$/i, '').trim();
    if (!part) continue;
    const color = Number(cells[1]);
    const quantity = Math.max(0, Math.floor(Number(cells[2]) || 0));
    rows.push({ part, color: Number.isFinite(color) ? color : 0, quantity, spare: isSpareFlag(cells[3]) });
  }
  return rows;
}

/**
 * Reads a parts bin document: an INI-like `[options]` block (kind, caption, sortOn) and an
 * `<items>` block of `part.dat:[sourceInv=…] [color=…] [count=…]` lines. One line is one
 * needed unit group; `count` is how many of that part and colour the bin carries.
 */
export function parsePartsBin(text: string): PartsBinFile {
  const bin: PartsBinFile = { kind: '', caption: '', sortOn: '', items: [] };
  let section = '';
  let inItems = false;
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      inItems = section === 'items';
      continue;
    }
    if (line.toLowerCase() === '<items>') {
      section = 'items';
      inItems = true;
      continue;
    }
    if (section === 'options') {
      const eq = line.split('=');
      const key = eq[0].trim().toLowerCase();
      const value = eq.slice(1).join('=').trim();
      if (key === 'kind') bin.kind = value;
      else if (key === 'caption') bin.caption = value;
      else if (key === 'sorton') bin.sortOn = value;
      continue;
    }
    if (!inItems) continue;
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const part = line.slice(0, sep).trim().replace(/\.dat$/i, '').trim();
    if (!part) continue;
    const attrs = new Map<string, string>();
    for (const token of line.slice(sep + 1).replace(/\[/g, '').replace(/\]/g, '').split(/\s+/).filter(Boolean)) {
      const eq = /^([^=]+)=(.*)$/.exec(token);
      if (eq) attrs.set(eq[1].trim().toLowerCase(), eq[2].trim());
    }
    const color = Number(attrs.get('color') ?? 0);
    const count = Math.max(1, Math.floor(Number(attrs.get('count') ?? 1)) || 1);
    bin.items.push({ part, sourceInv: attrs.get('sourceinv') ?? '', color: Number.isFinite(color) ? color : 0, count });
  }
  return bin;
}

/** Turns a parts bin into the same bill of materials rows a Rebrickable parts export gives. */
export function partsBinToRows(bin: PartsBinFile): BomRow[] {
  const rows: BomRow[] = [];
  for (const item of bin.items) {
    const n = Math.max(0, Math.floor(item.count));
    for (let i = 0; i < n; i++) rows.push({ part: item.part, color: item.color, quantity: 1 });
  }
  return rows;
}
