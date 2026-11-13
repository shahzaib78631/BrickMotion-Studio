import { resolve as resolvePath } from 'node:path';
import { matchForStep } from './assessment';
import type { Resolved } from './rebrickable';
import type { Booklet, Matches } from './types';

/** Lossless handoff to placement. Unknown parts remain unknown; no placeholder bricks. */
export function placementJob(name: string, models: Booklet[][], matches: Matches,
  resolve: (element: string) => Resolved, bookletDir: string) {
  return {
    format: 'brickmotion-placement-job' as const, version: 1 as const, name,
    completeModel: false,
    // These may be foundations omitted from the callouts, spares, or extraction
    // misses. They are evidence to resolve, never automatically placed pieces.
    unassignedInventory: matches.unused.map(row => ({...row, ...resolve(row.element)})),
    models: models.map((booklets, mi) => ({
      name: models.length === 1 ? name : `${name} ${mi + 1}`,
      sources: booklets.map(b => ({booklet:b.id, hash:b.sourceHash ?? null})),
      steps: booklets.flatMap(b => b.steps.map(s => ({
        id: `${b.id}:p${s.page}:s${s.number}`,
        booklet: b.id, page: s.page, number: s.number,
        image: s.picture ? resolvePath(bookletDir,b.id,s.picture) : null,
        substeps: s.substeps, repeat: s.repeat ?? 1,
        parts: s.callout.map((c,index) => {
          const match = matchForStep(matches,b.id,s.page,s.number,index);
          const r = match?.element ? resolve(match.element) : null;
          return {index, count:c.count, countVerified:c.countFound,
            image:resolvePath(bookletDir,b.id,c.crop), element:match?.element ?? null,
            part:r?.part || null, color:r?.color ?? null,
            matchScore:match?.score ?? 0,
            issues:[...(!r ? ['unidentified part'] : r.flags), ...(!c.countFound ? ['unverified quantity'] : [])]};
        }),
        issues: (b.diagnostics ?? []).filter(d=>d.page===s.page).map(d=>d.message),
      }))),
    })),
  };
}
