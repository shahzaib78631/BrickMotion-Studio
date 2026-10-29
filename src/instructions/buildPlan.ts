import type { Plan, PlanItem, Step } from '../plan/types';
import type { Resolved } from './rebrickable';
import type { Booklet, Matches } from './types';

export type Flag = { step?: number; message: string };

const PLACEHOLDER = '3001';
const DEFAULT_COLOR = 16;
/** studs between pieces in a step's row, and between figures in the main model */
const PITCH = 8;
const FIGURE_GAP = 24;
const rowZ = (stepIndex: number) => -(8 + 4 * stepIndex);

function modelSteps(booklets: Booklet[], matches: Matches, resolve: (element: string) => Resolved, flags: Flag[]): Step[] {
  const byKey = new Map(matches.matches.map((m) => [`${m.booklet}|${m.step}|${m.index}`, m]));
  const steps: Step[] = [];
  for (const b of booklets) {
    for (const s of b.steps) {
      const k = steps.length;
      const flag = (message: string) => flags.push({ step: s.number, message: `step ${s.number}: ${message}` });
      const pieces: PlanItem[] = [];
      let x = 0;
      s.callout.forEach((c, i) => {
        const m = byKey.get(`${b.id}|${s.number}|${i}`);
        let part = PLACEHOLDER;
        let color: number = DEFAULT_COLOR;
        if (!m?.element) {
          const closest = m?.alternatives[0];
          flag(`callout part ${i + 1} not identified (${closest ? `closest ${closest.element} at ${closest.score}` : 'no candidates'}); placeholder ${PLACEHOLDER}`);
        } else {
          const r = resolve(m.element);
          for (const f of r.flags) flag(r.part ? f : `${f}; placeholder ${PLACEHOLDER}`);
          if (r.part) {
            part = r.part;
            color = r.color ?? DEFAULT_COLOR;
          }
        }
        if (!c.countFound) flag(`callout part ${i + 1} has no readable count; using 1`);
        for (let n = 0; n < c.count; n++) {
          pieces.push({ part, color, x, y: 0, z: rowZ(k), rot: 0 });
          x += PITCH;
        }
      });
      if (!s.callout.length) {
        flags.push({ step: s.number, message: `step ${s.number} adds no new parts (attaches a sub-build or turns the model); BrickMotion merges it into the next step until Phase 2 places sub-builds` });
      }
      if (s.substeps.length) {
        flags.push({ step: s.number, message: `step ${s.number} has a sub-build (sub-steps ${s.substeps.join(', ')}${s.repeat ? `, built ${s.repeat}×` : ''}) kept inline` });
      }
      const step: Step = { pieces, notes: `booklet ${b.id} page ${s.page}` };
      if (s.section !== undefined) step.title = `Section ${s.section}`;
      steps.push(step);
    }
  }
  return steps;
}

/**
 * The booklets as a BrickMotion plan: official steps in order, each step's new parts laid out
 * in a row beside the model (Phase 2 places them). Several figures become submodels side by side.
 */
export function planFromBooklets(name: string, models: Booklet[][], matches: Matches, resolve: (element: string) => Resolved): { plan: Plan; flags: Flag[] } {
  const flags: Flag[] = [];
  const base = { format: 'brickmotion-plan' as const, version: 1 as const, name };
  if (models.length === 1) return { plan: { ...base, steps: modelSteps(models[0], matches, resolve, flags) }, flags };
  const submodels: Plan['submodels'] = {};
  const steps: Step[] = models.map((booklets, i) => {
    const sub = `${name} ${i + 1}`;
    submodels[sub] = { steps: modelSteps(booklets, matches, resolve, flags) };
    return { pieces: [{ submodel: sub, x: FIGURE_GAP * i, y: 0, z: 0, rot: 0 }] };
  });
  return { plan: { ...base, submodels, steps }, flags };
}
