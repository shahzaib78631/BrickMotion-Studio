/**
 * Mesh-level certification of a BrickHeadz plan (Phase 3).
 *
 * Reuses the studio's triangle-SAT collision oracle (`MeshOracle`) to decide real
 * interpenetration on the meshes — not bounding boxes — and the studio's own
 * `validate()` for connection/floating. A model is CLEAR only when no pair of
 * pieces interpenetrates and nothing floats.
 *
 * Pure: the caller supplies measured parts and a colour table, so both the node
 * CLI and tests can drive it.
 */
import type { ColorDef } from '../../ldraw/colors';
import type { PartMetrics } from '../../ldraw/metrics';
import type { Plan } from '../../plan/types';
import { modelFromPlan } from '../construction';
import { MeshOracle } from '../construction/collision';
import { possibleFinalContacts } from '../construction/contactBroadphase';
import { assemble } from '../../model/assemble';
import { validate } from '../../model/validate';

export type MeshOverlap = { a: string; b: string; parts: string };

export type MeshReport = {
  pieces: number;
  overlaps: MeshOverlap[];
  floating: string[];
  verdict: 'CLEAR' | 'BLOCKED' | 'ERROR';
  note?: string;
};

export function certifyModel(plan: Plan, measures: Map<string, PartMetrics>, colors: Map<number, ColorDef>): MeshReport {
  const metrics = (id: string): PartMetrics => {
    const m = measures.get(id);
    if (!m) throw new Error(`unmeasured part ${id}`);
    return m;
  };
  let model;
  try {
    model = modelFromPlan(plan, metrics);
  } catch (error) {
    return { pieces: 0, overlaps: [], floating: [], verdict: 'ERROR', note: (error as Error).message };
  }
  const oracle = new MeshOracle(model, { states: 0, candidates: 0, backtracks: 0, meshPairs: 0, trianglePairs: 0, cacheHits: 0, milliseconds: 0 });
  const overlaps: MeshOverlap[] = [];
  for (const [a, b] of possibleFinalContacts([...model.parts.values()])) {
    if (!oracle.clear(a.id, b.id, [0, 0, 0], [0, 0, 0], [0, 0, 0])) overlaps.push({ a: a.id, b: b.id, parts: `${a.part} / ${b.part}` });
  }
  const warnings = validate(assemble(plan, metrics, colors));
  const floating = warnings.filter((w) => w.kind === 'floating').flatMap((w) => w.instanceKeys);
  return { pieces: model.parts.size, overlaps, floating, verdict: overlaps.length === 0 && floating.length === 0 ? 'CLEAR' : 'BLOCKED' };
}

/** Node ids the validator would drop to make a BLOCKED model CLEAR. */
export function offendingIds(report: MeshReport): string[] {
  const ids = new Set<string>();
  for (const o of report.overlaps) {
    ids.add(o.a);
    ids.add(o.b);
  }
  for (const f of report.floating) ids.add(f);
  return [...ids];
}
