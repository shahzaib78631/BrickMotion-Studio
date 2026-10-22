import type { Plan, Step } from './types';

/** Returns a copy of the plan where every item has an id unique across the whole plan. */
export function ensureIds(plan: Plan): Plan {
  const used = new Set<string>();
  const all = [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((s) => s.steps)];
  for (const s of all) for (const i of s.pieces) if (i.id) used.add(i.id);
  let n = 0;
  const next = () => {
    let id: string;
    do id = 'i' + (n++).toString(36);
    while (used.has(id));
    used.add(id);
    return id;
  };
  const seen = new Set<string>();
  const fix = (steps: Step[]): Step[] =>
    steps.map((s) => ({
      ...s,
      pieces: s.pieces.map((i) => {
        if (i.id && !seen.has(i.id)) {
          seen.add(i.id);
          return i;
        }
        return { ...i, id: next() };
      }),
    }));
  const out: Plan = { ...plan, steps: fix(plan.steps) };
  if (plan.submodels) {
    out.submodels = Object.fromEntries(Object.entries(plan.submodels).map(([k, v]) => [k, { steps: fix(v.steps) }]));
  }
  return out;
}

/** Creates an id not used anywhere in the plan. */
export function newId(plan: Plan): string {
  const used = new Set<string>();
  for (const s of [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((x) => x.steps)])
    for (const i of s.pieces) if (i.id) used.add(i.id);
  let id: string;
  do id = 'n' + Math.random().toString(36).slice(2, 8);
  while (used.has(id));
  return id;
}
