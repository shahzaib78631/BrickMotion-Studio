/** Deterministic sweep-and-prune contact broad phase.
 *
 * The completed placement audit previously checked every pair of parts, even
 * when assemblies were hundreds of studs apart. In dense models, this meant
 * O(n^2) box checks before a single triangle could be inspected. Sorting one
 * axis and maintaining active intervals keeps the broad phase bounded by the
 * number of nearby pairs. We use precisely the same overlap predicate as the
 * mesh oracle: this is an acceleration only, NEVER a contact exemption.
 */
import type { ConstructionNode } from './types';
import { overlaps } from './math';

export function* possibleFinalContacts(parts: readonly ConstructionNode[]): Generator<readonly [ConstructionNode, ConstructionNode]> {
  const ordered = parts.map((part, index) => ({ part, index })).sort((a, b) =>
    a.part.bounds.min[0] - b.part.bounds.min[0] || a.index - b.index);
  const active: typeof ordered = [];
  const EPS = 1e-6;
  for (const entry of ordered) {
    // Remove only intervals that CANNOT overlap on X with the new entry. An
    // epsilon-marginal touch remains a candidate and is decided by the same
    // three-axis predicate used before this optimisation.
    const x = entry.part.bounds.min[0];
    for (let i = active.length - 1; i >= 0; i--)
      if (active[i].part.bounds.max[0] <= x - EPS) active.splice(i, 1);
    for (const other of active) {
      if (overlaps(other.part.bounds, entry.part.bounds, -EPS))
        yield other.index < entry.index
          ? [other.part, entry.part] as const
          : [entry.part, other.part] as const;
    }
    active.push(entry);
  }
}
