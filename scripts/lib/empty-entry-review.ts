export type EmptyEntryReview = {
  id: string; status: string; sources: Record<string, string>; connectorCount: number;
};

/** An authored review is usable only for the exact complete source closure it
 * reviewed. Missing geometry, placeholders and changed files cannot pass. */
export function matchesEmptyEntryReview(review: EmptyEntryReview, measured: {
  id: string; status: string; sources: Record<string, string>; issues: string[]; measurements: unknown;
}): boolean {
  if (review.status !== 'reviewed-intentionally-empty-file' || review.connectorCount !== 0 ||
    review.id !== measured.id || measured.status !== 'incomplete' || measured.measurements !== null ||
    measured.issues.length !== 1 || measured.issues[0] !== 'No measurable geometry') return false;
  const names = Object.keys(review.sources);
  return names.length > 0 && names.length === Object.keys(measured.sources).length &&
    names.every(name => review.sources[name] === measured.sources[name]);
}
