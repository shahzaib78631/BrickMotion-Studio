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

/**
 * When no booklet has an inventory page: how often each part + colour appears in the callouts
 * (count × matched element) against the Rebrickable set quantities. Spares are ignored.
 */
export function calloutUseDiffs(
  booklets: Booklet[],
  matches: { booklet: string; step: number; index: number; element: string | null }[],
  parts: SetPart[],
  extra: Map<string, SetPart>,
): Flag[] {
  const byElement = new Map(parts.filter((p) => p.element).map((p) => [p.element!, p]));
  const used = new Map<string, number>();
  for (const m of matches) {
    if (!m.element) continue;
    const step = booklets.find((b) => b.id === m.booklet)?.steps.find((s) => s.number === m.step);
    const count = step?.callout[m.index]?.count ?? 1;
    const p = byElement.get(m.element) ?? extra.get(m.element);
    const k = p ? key(p) : `element ${m.element}`;
    used.set(k, (used.get(k) ?? 0) + count);
  }
  const fromApi = new Map<string, number>();
  for (const p of parts) if (!p.spare) fromApi.set(key(p), (fromApi.get(key(p)) ?? 0) + p.quantity);
  const flags: Flag[] = [];
  for (const k of new Set([...used.keys(), ...fromApi.keys()])) {
    const a = used.get(k) ?? 0;
    const b = fromApi.get(k) ?? 0;
    if (a !== b) flags.push({ message: `inventory: ${k} is used ${a}× in the steps but the set has ${b}×` });
  }
  return flags;
}
