import type { Booklet, Matches } from './types';

/** Evidence about extraction only. Passing this is not a placement/buildability certificate. */
export function assessExtraction(booklets: Booklet[]) {
  const issues: { booklet: string; page?: number; code: string; message: string }[] = [];
  for (const b of booklets) {
    for (const d of b.diagnostics ?? []) issues.push({ booklet: b.id, ...d });
    if (!b.steps.length) issues.push({ booklet: b.id, code: 'no-steps', message: 'No steps extracted.' });
    const seen = new Set<string>();
    for (const [i, s] of b.steps.entries()) {
      const key = `${s.page}|${s.number}`;
      if (seen.has(key)) issues.push({ booklet: b.id, page: s.page, code: 'duplicate-step', message: `Duplicate step ${s.number} on the same page.` });
      seen.add(key);
      if (!s.picture) issues.push({ booklet: b.id, page: s.page, code: 'missing-picture', message: `Step ${s.number} has no model image.` });
      if (i && s.number !== b.steps[i - 1].number + 1 && !(b.diagnostics ?? []).some(d => d.page === s.page && d.code === 'step-sequence')) {
        issues.push({ booklet: b.id, page: s.page, code: 'step-sequence', message: `Step ${b.steps[i - 1].number} followed by ${s.number}.` });
      }
      s.callout.forEach((c, j) => {
        if (!c.countFound) issues.push({ booklet: b.id, page: s.page, code: 'uncertain-count', message: `Step ${s.number}, callout ${j + 1}: quantity requires review.` });
      });
    }
  }
  return {
    stage: 'extracted' as const, completeModel: false,
    steps: booklets.reduce((n, b) => n + b.steps.length, 0),
    callouts: booklets.reduce((n, b) => n + b.steps.reduce((k, s) => k + s.callout.length, 0), 0),
    issues,
    unparsedPages: booklets.flatMap(b => (b.unparsedPages ?? []).map(page => ({ booklet: b.id, page }))),
  };
}

/** Page is part of a step's identity: sub-assemblies can restart numbering. */
export function matchForStep(matches: Matches, booklet: string, page: number, step: number, index: number) {
  const candidates = matches.matches.filter(m => m.booklet === booklet && m.step === step && m.index === index);
  return candidates.find(m => m.page === page) ?? (candidates.length === 1 && candidates[0].page === undefined ? candidates[0] : undefined);
}
