import { AssemblyPlanningError } from './assemblyGraph';

/** Thrown only by a retry's work-budget guard; never treated as route success. */
export class AccessBudgetExceeded extends Error {}

export type AccessEdge = { before: string; after: string };
export type AccessFailure = {
  moving: string; blockers: string[]; completed: number; total: number;
  /** pieces of the same step that sit on the same side of the blockers, likely blocked the same way */
  peers?: string[];
  /**
   * Look-ahead, per blocker: how many flights already certified the moving piece
   * would cut through if it went before that blocker. Lower is a better reorder.
   */
  harm?: Record<string, number>;
  /** blockers the moving piece is attached to or rests on: putting it first is never a fix */
  needs?: string[];
};

/** score cost of one flight a reorder would cut; below one unit of progress on any real model, so it only ranks reorders of the same failure */
export const HARM_WEIGHT = 1e-4;
const MAX_HARM = 9;

/** Lift a blocked constituent pair to siblings in their least common model scope. */
export function siblingAccessEdge(moving: string, blocker: string): AccessEdge | null {
  const a = moving.split('/'), b = blocker.split('/');
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  if (k === a.length || k === b.length) return null;
  return { before: a.slice(0, k + 1).join('/'), after: b.slice(0, k + 1).join('/') };
}
const signature = (edges: AccessEdge[]) => edges.map((e) => `${e.before}>${e.after}`).sort().join('|');

/**
 * A bounded search over access precedence, not a collision relaxation. Every
 * candidate is replanned from staging through final insertion. All original
 * dependencies stay active, so an incompatible reorder fails with a cycle.
 * The caller and source model are never mutated. No partial timeline is returned.
 */
export function searchAccessOrder<T>(
  attempt: (edges: AccessEdge[]) => T, limit = 12,
): T {
  const budget = Number.isFinite(limit) ? Math.max(1, Math.min(32, Math.floor(limit))) : 1;
  const pending: { edges: AccessEdge[]; score: number; seq: number }[] = [{ edges: [], score: 0, seq: 0 }];
  const seen = new Set<string>(['']);
  let best: AssemblyPlanningError | undefined, bestEdges: AccessEdge[] = [], bestProgress = -1, serial = 1, tries = 0, timedOut = false;
  while (pending.length && tries < budget) {
    pending.sort((a,b) => b.score - a.score || a.edges.length - b.edges.length || a.seq - b.seq);
    const state = pending.shift()!; tries++;
    try { return attempt(state.edges); }
    catch (error) {
      if (error instanceof AccessBudgetExceeded && best) { timedOut = true; break; }
      if (!(error instanceof AssemblyPlanningError)) throw error;
      const blocked = error.issues.find((i) => i.code === 'blocked-route');
      if (!blocked?.access) {
        // Reordered branches may conflict with mandatory attachment edges.
        // A problem in the original graph must not be concealed by a retry.
        if (!state.edges.length || !error.issues.every((i) => i.code === 'dependency-cycle')) throw error;
        continue;
      }
      const { moving, blockers, completed, total, peers = [], harm = {}, needs = [] } = blocked.access;
      const progress = completed / Math.max(1, total);
      if (progress > bestProgress) { bestProgress = progress; best = error; bestEdges = state.edges; }
      // Look-ahead: a piece never goes on before what holds it, so those reorders are
      // not tried at all; when only holders block it, no reorder can help this piece.
      const usable = blockers.filter((key) => !needs.includes(key) && siblingAccessEdge(moving, key));
      const choices = usable.map((key) => siblingAccessEdge(moving, key)!);
      /** what putting the moving piece ahead of these blockers would cut through */
      const cost = (keys: string[]) => HARM_WEIGHT * Math.min(MAX_HARM, keys.reduce((n, k) => n + (harm[k] ?? 0), 0));
      const add = (newEdges: AccessEdge[], bonus = 0) => {
        const edges = [...state.edges];
        for (const e of newEdges) if (!edges.some((o) => o.before === e.before && o.after === e.after)) edges.push(e);
        const key = signature(edges);
        if (seen.has(key) || edges.length > 16) return;
        seen.add(key); pending.push({edges, score: progress + bonus, seq: serial++});
      };
      // Pieces of one step blocked the same way (three wheel holders under one
      // chassis) move together, so each replan clears a whole group, not one piece.
      const grouped = usable.length ? peers.flatMap((p) => usable.map((key) => siblingAccessEdge(p, key))).filter((e): e is AccessEdge => !!e) : [];
      if (grouped.length) add([...choices, ...grouped], 1e-6 - cost(usable));
      // Otherwise the smallest change first, the reorder that cuts fewest certified
      // flights ahead of the rest; combined candidates handle two-sided enclosures.
      choices.forEach((e, n) => add([e], -cost([usable[n]])));
      if (choices.length > 1) add(choices, -cost(usable));
    }
  }
  if (best) {
    for (const issue of best.issues) if (issue.code === 'blocked-route') issue.search = { attempts: tries, limit: budget, edges: bestEdges, ...(timedOut ? { timedOut: true } : {}) };
    throw best;
  }
  throw new Error('Access-order search produced no valid timeline.');
}

/**
 * The reorders a repair pass applies for pieces that stayed uncertified: for each,
 * put it before every blocker it is not held by, unless that would cut through
 * certified flights. Edges already present, and repeats, are skipped.
 */
export function repairEdges(failures: AccessFailure[], existing: AccessEdge[]): AccessEdge[] {
  const out: AccessEdge[] = [];
  const has = (e: AccessEdge) => [...existing, ...out].some((o) => o.before === e.before && o.after === e.after);
  for (const f of failures) {
    const needs = f.needs ?? [];
    for (const key of f.blockers) {
      if (needs.includes(key) || (f.harm?.[key] ?? 0) > 0) continue;
      const e = siblingAccessEdge(f.moving, key);
      // the reverse order is already required: the two would only form a cycle
      if (!e || has(e) || [...existing, ...out].some((o) => o.before === e.after && o.after === e.before)) continue;
      out.push(e);
    }
  }
  return out;
}
