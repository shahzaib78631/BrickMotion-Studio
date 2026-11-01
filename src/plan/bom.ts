import type { BomRow } from './types';

/**
 * The units a bill of materials asks for: spares drop out and equal part-and-colour
 * entries are summed, so a colour needed by two sub-builds of one MOC still counts once.
 */
export function neededBomRows(rows: BomRow[]): BomRow[] {
  const byKey = new Map<string, BomRow>();
  const order: string[] = [];
  for (const row of rows) {
    const quantity = Math.max(0, Math.floor(row.quantity));
    if (row.spare || quantity <= 0) continue;
    const key = `${row.part}|${row.color}`;
    const seen = byKey.get(key);
    if (seen) seen.quantity += quantity;
    else {
      const fresh: BomRow = { part: row.part, color: row.color, quantity };
      byKey.set(key, fresh);
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key) as BomRow);
}
