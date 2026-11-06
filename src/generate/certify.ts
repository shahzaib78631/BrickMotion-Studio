import { assemble } from '../model/assemble';
import type { Plan } from '../plan/types';
import { ensureParts, getColors, metricsOf } from '../state/partService';
import { allChecks } from '../state/useModel';

/**
 * A generated model's certificate: what the editor's own checks say about it. It is
 * buildable when it is one piece (brickify's count) and nothing floats, overlaps or is
 * an unknown part. Weak joints (a big part held by one stud) are counted, not failed.
 */
export type Certificate = {
  buildable: boolean;
  pieces: number;
  /** separate parts it falls into (1 = holds together) */
  parts: number;
  floating: number;
  overlapping: number;
  unknown: number;
  weak: number;
};

export async function certify(plan: Plan, parts: number): Promise<Certificate> {
  const ids = [...new Set(plan.steps.flatMap((s) => s.pieces).flatMap((p) => ('part' in p ? [p.part] : [])))];
  await ensureParts(ids);
  const warnings = allChecks(assemble(plan, metricsOf, getColors()));
  const count = (k: string) => warnings.filter((w) => w.kind === k).length;
  const c = {
    pieces: plan.steps.reduce((n, s) => n + s.pieces.length, 0),
    parts,
    floating: count('floating'),
    overlapping: count('overlap'),
    unknown: count('unknown-part'),
    weak: count('weak'),
  };
  return { ...c, buildable: parts === 1 && c.floating === 0 && c.overlapping === 0 && c.unknown === 0 };
}
