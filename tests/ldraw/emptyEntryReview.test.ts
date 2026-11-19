import { expect, it } from 'vitest';
import { matchesEmptyEntryReview } from '../../scripts/lib/empty-entry-review';

const review = { id: '6637b', status: 'reviewed-intentionally-empty-file', connectorCount: 0,
  sources: { 'parts/6637b.dat': 'root-hash', 'p/empty.dat': 'empty-hash' } };
const measured = { id: '6637b', status: 'incomplete', sources: review.sources, issues: ['No measurable geometry'], measurements: null };
it('accepts only the exact intentionally empty source closure', () => {
  expect(matchesEmptyEntryReview(review, measured)).toBe(true);
  expect(matchesEmptyEntryReview(review, { ...measured, sources: { ...measured.sources, 'p/other.dat': 'extra' } })).toBe(false);
  expect(matchesEmptyEntryReview(review, { ...measured, sources: { ...measured.sources, 'p/empty.dat': 'changed' } })).toBe(false);
});
it('never turns missing or truncated geometry into a reviewed empty part', () => {
  expect(matchesEmptyEntryReview(review, { ...measured, issues: ['Missing file: empty.dat'] })).toBe(false);
  expect(matchesEmptyEntryReview(review, { ...measured, issues: ['No measurable geometry', 'Depth limit'] })).toBe(false);
  expect(matchesEmptyEntryReview(review, { ...measured, status: 'measured', measurements: {} })).toBe(false);
  expect(matchesEmptyEntryReview(review, { ...measured, id: 'bl_8411' })).toBe(false);
});
