import type { Flag } from './buildPlan';
import type { SetPart } from './rebrickable';
import type { Booklet } from './types';

const key = (p: SetPart) => `${p.ldrawPart} colour ${p.color ?? '?'}`;

/**
 * Booklet inventory vs the Rebrickable set inventory, compared by LDraw part + colour (booklets
 * may print an alternate element id for the same piece). `extra` holds looked-up ids that are
 * not in the set list. Spares are ignored.
 */
export function inventoryDiffs(booklets: Booklet[], parts: SetPart[], extra: Map<string, SetPart>): Flag[] {
  const byElement = new Map(parts.filter((p) => p.element).map((p) => [p.element!, p]));
  const fromBooklets = new Map<string, number>();
  for (const b of booklets) {
    for (const e of b.inventory) {
      const p = byElement.get(e.element) ?? extra.get(e.element);
      const k = p ? key(p) : `element ${e.element}`;
      fromBooklets.set(k, (fromBooklets.get(k) ?? 0) + e.count);
    }
  }
  if (!fromBooklets.size) return [];
  const fromApi = new Map<string, number>();
  for (const p of parts) if (!p.spare) fromApi.set(key(p), (fromApi.get(key(p)) ?? 0) + p.quantity);
  const flags: Flag[] = [];
  for (const k of new Set([...fromBooklets.keys(), ...fromApi.keys()])) {
    const a = fromBooklets.get(k) ?? 0;
    const b = fromApi.get(k) ?? 0;
    if (a !== b) flags.push({ message: `inventory: ${k} is ${a}× in the booklets but ${b}× on Rebrickable` });
  }
  return flags;
}
