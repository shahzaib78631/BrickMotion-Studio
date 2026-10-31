import type { ColorDef } from '../ldraw/colors';
import type { Metrics } from '../model/assemble';
import { exportLDraw } from '../io/ldrawExport';
import { importLDraw } from '../io/ldrawImport';
import { modelSteps, type ModelName } from './ops';
import { isSub, type Plan, type PlanItem, type Submodel } from './types';

/**
 * Copied pieces: plan items without ids (they get fresh ones when pasted), with the
 * submodels they use. On the system clipboard they travel as LDraw text, so other
 * LDraw editors can paste them and BrickMotion can paste theirs.
 */
export type Clip = { items: PlanItem[]; submodels: Record<string, Submodel> };

function strip(item: PlanItem): PlanItem {
  const { id: _id, assembly, ...rest } = item;
  return (assembly?.group ? { ...rest, assembly: { group: assembly.group } } : rest) as PlanItem;
}

export function copyItems(plan: Plan, m: ModelName, ids: string[]): Clip {
  const want = new Set(ids);
  const items = modelSteps(plan, m).flatMap((s) => s.pieces.filter((i) => i.id && want.has(i.id))).map(strip);
  const submodels: Record<string, Submodel> = {};
  const walk = (list: readonly PlanItem[]) => {
    for (const it of list) {
      if (!isSub(it) || submodels[it.submodel] || !plan.submodels?.[it.submodel]) continue;
      submodels[it.submodel] = plan.submodels[it.submodel];
      walk(plan.submodels[it.submodel].steps.flatMap((s) => s.pieces));
    }
  };
  walk(items);
  return { items, submodels };
}

export function clipToLDraw(clip: Clip, metrics: Metrics, colors: Map<number, ColorDef>): string {
  return exportLDraw({ name: 'clipboard', steps: [{ pieces: clip.items }], submodels: clip.submodels } as Plan, metrics, colors);
}

/** Pieces from LDraw text (ours or another editor's), or null when the text has none. */
export function clipFromLDraw(text: string): Clip | null {
  if (!/^\s*1\s/m.test(text)) return null;
  let plan: Plan;
  try {
    plan = importLDraw(text, 'clipboard.ldr');
  } catch {
    return null;
  }
  const items = plan.steps.flatMap((s) => s.pieces).map(strip);
  return items.length ? { items, submodels: plan.submodels ?? {} } : null;
}

const sameSteps = (a: Submodel, b: Submodel) => JSON.stringify(a.steps) === JSON.stringify(b.steps);

/**
 * Adds a clip's submodels to the plan. One with the same name and content is reused; one
 * whose name is taken by different content is added as "name (2)", "name (3)"… and the clip's
 * references follow. Nothing already in the plan is ever overwritten.
 */
export function mergeSubmodels(plan: Plan, clip: Clip): { plan: Plan; clip: Clip } {
  const existing = plan.submodels ?? {};
  const rename = new Map<string, string>();
  const taken = new Set([...Object.keys(existing), ...Object.keys(clip.submodels)]);
  const ref = (it: PlanItem): PlanItem => (isSub(it) && rename.has(it.submodel) ? { ...it, submodel: rename.get(it.submodel)! } : it);
  const withRefs = (sm: Submodel): Submodel => ({ ...sm, steps: sm.steps.map((s) => ({ ...s, pieces: s.pieces.map(ref) })) });
  // a parent counts as the same only once its children's renames are applied, so repeat until stable
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, sm] of Object.entries(clip.submodels)) {
      if (rename.has(name) || !existing[name] || sameSteps(existing[name], withRefs(sm))) continue;
      let n = 2;
      while (taken.has(`${name} (${n})`)) n++;
      rename.set(name, `${name} (${n})`);
      taken.add(`${name} (${n})`);
      changed = true;
    }
  }
  // only new names go back: a reused submodel is already in the plan and must not be replaced
  const added: Record<string, Submodel> = {};
  for (const [name, sm] of Object.entries(clip.submodels)) {
    const to = rename.get(name) ?? name;
    if (!existing[to]) added[to] = withRefs(sm);
  }
  return {
    plan: Object.keys(added).length ? { ...plan, submodels: { ...existing, ...added } } : plan,
    clip: { items: clip.items.map(ref), submodels: added },
  };
}
