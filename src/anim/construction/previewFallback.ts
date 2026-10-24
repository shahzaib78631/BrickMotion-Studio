/** The automatic preview is opt-in. Never turn invalid data, missing geometry,
 * cancellation or unexpected application errors into "successful" plans. */
import { ConstructionError, type PlannerFailureCode } from './types';
import type { PlanningFallback } from '../timelineData';

const recoverable = new Set<PlannerFailureCode>([
  'unresolved-final-contact', 'no-supported-rigid-route',
  'search-budget-exhausted', 'unsupported-articulation',
  'unknown-connector', 'ambiguous-connector',
  // Replay may reject a V2 motion on complex mechanisms. We may show the
  // Standard preview, but must retain the failed replay certificate.
  'invalid-plan',
]);

export const eligibleForPreview = (code: PlannerFailureCode): boolean => recoverable.has(code);

export function previewProvenance(error: ConstructionError, planner: 'construction-v2' | 'construction-v3' = 'construction-v2'): PlanningFallback {
  return {
    planner, mode: 'uncertified-preview',
    code: error.code, message: error.message,
    scope: error.details.scope, phase: error.details.phase, searchStates: error.details.stats?.states,
    contacts: error.details.blockages?.slice(0, 12).map(({ moving, obstacle, stage }) => ({ moving, obstacle, stage })),
  };
}
