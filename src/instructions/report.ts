import type { Plan, Step } from '../plan/types';
import type { Flag } from './buildPlan';
import type { Matches } from './types';

const isPiece = (p: object) => 'part' in p;

/** Markdown report: what was built and everything that needs a human look. */
export function instructionsReport(name: string, plan: Plan, flags: Flag[], matches: Matches, opts: { inventoryPage?: boolean } = {}): string {
  const models: Step[][] = plan.submodels && Object.keys(plan.submodels).length ? Object.values(plan.submodels).map((s) => s.steps) : [plan.steps];
  const steps = models.reduce((n, m) => n + m.length, 0);
  const pieces = models.reduce((n, m) => n + m.reduce((k, s) => k + s.pieces.filter(isPiece).length, 0), 0);
  const out: string[] = [`# ${name}: instructions → MPD report`, '', `Steps: ${steps} · Pieces: ${pieces} · Flags: ${flags.length}`];
  if (matches.scale) out.push(`Callout-to-inventory scale: ${matches.scale.toFixed(3)}`);

  out.push('', '## Flags', '');
  if (!flags.length) out.push('None.');
  for (const f of flags) out.push(`- ${f.message}`);

  out.push('', '## Inventory check', '');
  if (opts.inventoryPage === false) out.push('No inventory page in these booklets: part counts were checked against Rebrickable instead (see Flags).');
  else if (!matches.overUse.length && !matches.unused.length) out.push('Every inventory part is used exactly as often as the booklets need it.');
  if (matches.overUse.length) {
    out.push('Used more often than the inventory has:', '', '| element | used | inventory |', '|---|---|---|');
    for (const o of matches.overUse) out.push(`| ${o.element} | ${o.used} | ${o.inventory} |`);
    out.push('');
  }
  if (matches.unused.length) {
    out.push('Left over (spares, or parts a step missed):', '', '| element | left |', '|---|---|');
    for (const u of matches.unused) out.push(`| ${u.element} | ${u.left} |`);
  }

  out.push('', '## Steps', '', '| booklet | step | parts | lowest match |', '|---|---|---|---|');
  const groups = new Map<string, number[]>();
  for (const m of matches.matches) {
    const key = `${m.booklet}|${m.step}`;
    groups.set(key, [...(groups.get(key) ?? []), m.element ? m.score : 0]);
  }
  for (const [key, scores] of groups) {
    const [booklet, step] = key.split('|');
    out.push(`| ${booklet} | ${step} | ${scores.length} | ${Math.min(...scores).toFixed(3)} |`);
  }
  return out.join('\n') + '\n';
}
