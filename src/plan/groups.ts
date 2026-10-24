/** Selection groups are editorial objects, not submodels: they don't change
 * geometry, build order, or construction dependencies. Group names live on the
 * pieces and remain scoped to their containing model. */
import { findItem, modelSteps } from './ops';
import type { Plan, PlanItem } from './types';

export function membersOfGroup(plan: Plan, model: string, group: string): string[] {
  return modelSteps(plan, model).flatMap(step => step.pieces.flatMap(item =>
    item.id && item.assembly?.group === group ? [item.id] : []));
}

/** Clicking a grouped part selects the group. Alt-click may still pick one part. */
export function selectionForHit(plan: Plan, model: string, id: string, single = false): string[] {
  const group = findItem(plan, model, id)?.item.assembly?.group;
  return group && !single ? membersOfGroup(plan, model, group) : [id];
}

export function nextGroupName(plan: Plan, model: string): string {
  const names = new Set(modelSteps(plan, model).flatMap(s => s.pieces.flatMap(i => i.assembly?.group ? [i.assembly.group] : [])));
  let n = 1;
  while (names.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

/** A group change is one immutable, undoable store edit. */
export function setGroup(plan: Plan, model: string, ids: string[], group: string | null): Plan {
  const wanted = new Set(ids);
  if (!wanted.size || (group !== null && !group.trim())) return plan;
  let changed = false;
  const steps = modelSteps(plan, model).map(step => ({
    ...step,
    pieces: step.pieces.map(item => {
      if (!item.id || !wanted.has(item.id) || (item.assembly?.group ?? null) === group) return item;
      changed = true;
      const assembly = { ...item.assembly };
      if (group === null) delete assembly.group;
      else assembly.group = group;
      const next = { ...item, assembly } as PlanItem;
      if (!Object.keys(assembly).length) delete next.assembly;
      return next;
    }),
  }));
  if (!changed) return plan;
  return model === '' ? { ...plan, steps } : {
    ...plan,
    submodels: { ...plan.submodels, [model]: { ...plan.submodels![model], steps } },
  };
}

export function ungroupSelection(plan: Plan, model: string, ids: string[]): Plan {
  const groups = new Set(ids.flatMap(id => {
    const group = findItem(plan, model, id)?.item.assembly?.group;
    return group ? [group] : [];
  }));
  return setGroup(plan, model, [...groups].flatMap(g => membersOfGroup(plan, model, g)), null);
}
