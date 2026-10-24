/**
 * Negative-only, exact-scope route-search pruning.
 *
 * If a continuous straight sweep collided against a concrete obstacle at
 * distance d, its longer extension along that *same* direction necessarily
 * crosses the same forbidden prefix. No collision-free path is ever inferred
 * from this cache. Cached failures are valid only while the witness remains
 * at the identical assembled or staged position.
 *
 * It is deliberate that a formerly assembled obstacle that moves into staging
 * invalidates its old witness, even though the object ID still exists.
 */
export type BlockedNearRay = Readonly<{
  depth: number;
  obstacleId: string;
  staged: boolean;
}>;

export function mayReuseBlockedNearRay(
  witness: BlockedNearRay | undefined,
  attemptedDistance: number,
  remainsAssembled: (id: string) => boolean,
  remainsStaged: (id: string) => boolean,
): boolean {
  if (!witness || !Number.isFinite(attemptedDistance) || attemptedDistance + 1e-6 < witness.depth) return false;
  if (witness.obstacleId === 'floor') return true;
  return witness.staged ? remainsStaged(witness.obstacleId) : remainsAssembled(witness.obstacleId);
}
