import { ensureIds } from './ids';
import { modelSteps } from './ops';
import { isSub, type Plan, type Step } from './types';

/** The submodels a model builds, directly or inside its own submodels, in first-use order. */
export function reachableSubmodels(plan: Plan, model: string): string[] {
  const out: string[] = [];
  const walk = (m: string) => {
    for (const s of modelSteps(plan, m))
      for (const i of s.pieces)
        if (isSub(i) && plan.submodels?.[i.submodel] && !out.includes(i.submodel) && i.submodel !== model) {
          out.push(i.submodel);
          walk(i.submodel);
        }
  };
  walk(model);
  return out;
}

/** One model of the set as a set of its own: its steps on top, only the submodels it uses. '' is the whole set. */
export function standalonePlan(plan: Plan, model: string): Plan {
  if (!model) return plan;
  const subs = reachableSubmodels(plan, model);
  // A submodel on its own is built at its origin: the main spot and the "loose pieces
  // follow" switch belong to the root model and do not come along.
  const { assemblySpot: _a, loosePiecesFollow: _f, ...rest } = plan;
  return {
    ...rest,
    name: model,
    steps: modelSteps(plan, model),
    submodels: subs.length ? Object.fromEntries(subs.map((s) => [s, plan.submodels![s]])) : undefined,
  };
}

/** A submodel name not used in the plan yet, based on `base`. */
export function freeSubmodelName(plan: Plan, base: string): string {
  const taken = new Set(Object.keys(plan.submodels ?? {}));
  const clean = base.trim() || 'imported';
  if (!taken.has(clean)) return clean;
  let n = 2;
  while (taken.has(`${clean} ${n}`)) n++;
  return `${clean} ${n}`;
}

/**
 * Adds another set to `target` as a new submodel: its top-level steps become the
 * submodel's steps, its own submodels come along (renamed if a name is taken), and
 * `target` gets a new last step that places it at the origin.
 */
export function importAsSubmodel(plan: Plan, target: string, incoming: Plan, name: string): { plan: Plan; name: string } {
  const rename = new Map<string, string>();
  let draft: Plan = { ...plan, submodels: { ...(plan.submodels ?? {}) } };
  const subName = freeSubmodelName(draft, name);
  draft.submodels![subName] = { steps: [] };
  for (const s of Object.keys(incoming.submodels ?? {})) {
    const free = freeSubmodelName(draft, s);
    rename.set(s, free);
    draft.submodels![free] = { steps: [] };
  }
  const remap = (steps: Step[]): Step[] =>
    steps.map((st) => ({ ...st, pieces: st.pieces.map((i) => (isSub(i) ? { ...i, submodel: rename.get(i.submodel) ?? i.submodel } : i)) }));
  draft.submodels![subName] = { steps: remap(incoming.steps) };
  for (const [s, m] of Object.entries(incoming.submodels ?? {})) draft.submodels![rename.get(s)!] = { steps: remap(m.steps) };
  const ref: Step = { title: `Add ${subName}`, pieces: [{ submodel: subName, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] };
  if (target) draft.submodels![target] = { ...draft.submodels![target], steps: [...modelSteps(plan, target), ref] };
  else draft.steps = [...plan.steps, ref];
  if (incoming.parts) draft = { ...draft, parts: { ...(plan.parts ?? {}), ...incoming.parts } };
  return { plan: ensureIds(draft), name: subName };
}
