import type { ANode } from '../model/assemble';
import { placementMatrix, transformBox, unionBox } from '../model/assemble';
import type { Mat3, Vec3 } from '../ldraw/parse';
import { modelSteps } from './ops';
import type { AssemblyHints, Plan, PlanItem, Step, SubItem } from './types';

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const tidy = (n: number): number => Math.abs(n) < 1e-8 ? 0 : Math.round(n * 1e7) / 1e7;

export function availableSubmodelName(plan: Plan, preferred = 'Submodel'): string {
  const clean = preferred.trim().replace(/[\\/]/g, '-').replace(/\.(ldr|mpd)$/i, '').slice(0, 65) || 'Submodel';
  let name = clean, n = 2;
  while (plan.submodels?.[name] || name === plan.name) name = `${clean} ${n++}`;
  return name;
}

/**
 * Convert picked top-level items into a reusable submodel without moving a
 * single brick. Each child is made local to a snapped parent-space anchor;
 * the new SubItem applies exactly that anchor to restore the original pose.
 * The selected pieces' step order, IDs and in-group hints are preserved.
 *
 * `nodes` MUST be the current model's assembled *top-level* nodes, not flattened
 * leaf instances: it is the source of truth for imported/raw and grid poses.
 */
export function createSubmodel(plan: Plan, model: string, ids: string[], nodes: ANode[], preferred = 'Submodel'):
  { plan: Plan; referenceId: string; name: string; step: number } | null {
  const wanted = new Set(ids);
  const original = modelSteps(plan, model);
  if (wanted.size < 2) return null;
  const chosen = original.flatMap((step, index) => step.pieces
    .filter(item => item.id && wanted.has(item.id))
    .map(item => ({ item, step: index })));
  if (chosen.length < 2 || chosen.length !== wanted.size) return null;
  const lookup = new Map(nodes.map(n => [n.itemId, n]));
  if (chosen.some(({ item }) => !item.id || !lookup.has(item.id))) return null;

  // Reject unresolved cross-boundary attachTo constraints instead of deleting
  // them silently. All selected pieces may share one external attachment;
  // that constraint moves onto the new submodel use itself.
  const externalParents = new Set(chosen.flatMap(({ item }) => {
    const parent = item.assembly?.attachTo;
    return parent && !wanted.has(parent) ? [parent] : [];
  }));
  if (externalParents.size > 1) return null;

  const name = availableSubmodelName(plan, preferred);
  const box = chosen.reduce((out, { item }) => {
    const n = lookup.get(item.id!)!;
    return unionBox(out, transformBox(n.body, placementMatrix(n.local)));
  }, null as import('../ldraw/flatten').Box | null)!;
  // The snapped pivot makes the reference comfortable to move with the gizmo;
  // all child matrices stay exact, including off-grid custom LDraw placements.
  const anchor: Vec3 = [
    Math.round((box.min[0] + box.max[0]) / 40) * 20,
    Math.round(box.max[1] / 8) * 8,
    Math.round((box.min[2] + box.max[2]) / 40) * 20,
  ];
  const child = (item: PlanItem): PlanItem => {
    const n = lookup.get(item.id!)!;
    const hints = { ...item.assembly };
    if (hints.attachTo && !wanted.has(hints.attachTo)) delete hints.attachTo;
    if (hints.after) hints.after = hints.after.filter(id => wanted.has(id));
    const out: Record<string, unknown> = { ...item };
    for (const key of ['x', 'y', 'z', 'rot', 'ldu', 'matrix']) delete out[key];
    const result = {
      ...out,
      ldu: n.local.pos.map((v, k) => tidy(v - anchor[k])) as Vec3,
      matrix: [...n.local.m] as Mat3,
    } as PlanItem;
    if (Object.keys(hints).length) result.assembly = hints;
    else delete result.assembly;
    return result;
  };
  const childSteps: Step[] = original.flatMap(step => {
    const selected = step.pieces.filter(item => item.id && wanted.has(item.id));
    if (!selected.length) return [];
    // Metadata belongs with the submodel only when the entire original step
    // moved; otherwise it still describes the remaining parent pieces.
    const whole = selected.length === step.pieces.length;
    return [{ pieces: selected.map(child), ...(whole ? {
      title: step.title, notes: step.notes, pauseAfter: step.pauseAfter, auto: step.auto,
    } : {}) }];
  });
  const used = new Set([...original, ...Object.values(plan.submodels ?? {}).flatMap(s => s.steps)]
    .flatMap(step => step.pieces.map(item => item.id)));
  let index = 1, referenceId = `sub${index}`;
  while (used.has(referenceId)) referenceId = `sub${++index}`;
  const first = chosen[0];
  const referenceAssembly: AssemblyHints = {};
  const externalParent = [...externalParents][0];
  if (externalParent) referenceAssembly.attachTo = externalParent;
  const externalAfter = [...new Set(chosen.flatMap(({ item }) =>
    item.assembly?.after?.filter(id => !wanted.has(id)) ?? []))];
  // An external item that waits for a selected item cannot also be a
  // prerequisite of the new submodel: that would introduce a dependency cycle.
  const externalDependents = new Set(original.flatMap(step => step.pieces.flatMap(item =>
    item.id && !wanted.has(item.id) &&
    (wanted.has(item.assembly?.attachTo ?? '') || item.assembly?.after?.some(dep => wanted.has(dep)))
      ? [item.id] : [])));
  if ([...externalAfter, ...externalParents].some(id => externalDependents.has(id))) return null;
  if (externalAfter.length) referenceAssembly.after = externalAfter;
  const reference: SubItem = { id: referenceId, submodel: name, ldu: anchor, matrix: IDENTITY,
    ...(Object.keys(referenceAssembly).length ? { assembly: referenceAssembly } : {}) };
  const firstId = first.item.id!;
  const parentSteps = original.map((step, index) => {
    // References TO pieces moved into the submodel must now point to its use.
    const pieces = step.pieces.flatMap(item => {
      if (item.id && wanted.has(item.id)) return item.id === firstId ? [reference] : [];
      const hints = item.assembly;
      if (!hints) return [item];
      const parent = hints.attachTo && wanted.has(hints.attachTo) ? referenceId : hints.attachTo;
      const after = hints.after?.map(id => wanted.has(id) ? referenceId : id);
      const dedup = after && [...new Set(after.filter(id => id !== item.id))];
      return [{ ...item, assembly: { ...hints, attachTo: parent, after: dedup } }];
    });
    // Retain explicit step timing/order as-is; empty steps with authored
    // metadata are useful anchors in the Steps pane.
    return { ...step, pieces };
  });
  const next: Plan = {
    ...plan,
    submodels: { ...plan.submodels, [name]: { steps: childSteps } },
    ...(model === '' ? { steps: parentSteps } : { submodels: {
      ...plan.submodels, [name]: { steps: childSteps }, [model]: { ...plan.submodels![model], steps: parentSteps },
    } }),
  };
  return { plan: next, referenceId, name, step: first.step };
}
