import { plannedWay, type Way } from '../anim/flightDirection';
import type { Timeline } from '../anim/timeline';
import { findItem, setItemsInsertionAxis } from '../plan/ops';
import type { Plan } from '../plan/types';
import { useStudio } from './store';
import type { ModelState } from './useModel';

/** The animation key of an item in the edited model: the piece itself, or a submodel's first piece. */
export function keyForItem(model: ModelState, editingModel: string, id: string): string | null {
  const own = model.view.instances.find((i) => i.model === editingModel && i.itemId === id);
  if (own) return own.key;
  // a submodel use: its pieces' keys start with its id
  return model.view.instances.find((i) => i.key === id || i.key.startsWith(`${id}/`))?.key ?? null;
}

export type WayState = {
  /** what the editor shows: the way set by hand, else the planned one */
  way: Way | null;
  /** set by hand (on the first selected item) */
  own: boolean;
  /** the selected items do not all share one hand-set way */
  mixed: boolean;
};

export function wayState(plan: Plan, editingModel: string, ids: string[], model: ModelState, timeline: Timeline | null | undefined): WayState {
  const axes = ids.map((id) => findItem(plan, editingModel, id)?.item.assembly?.insertionAxis);
  const first = axes[0];
  const mixed = axes.some((a) => (a ? a.join() : '') !== (first ? first.join() : ''));
  if (first) return { way: [...first] as Way, own: true, mixed };
  const key = ids[0] ? keyForItem(model, editingModel, ids[0]) : null;
  return { way: key ? plannedWay(timeline, key) : null, own: false, mixed };
}

/** Sets (or with null returns to automatic) the way the selected items come in. One undo step. */
export function applyWay(ids: string[], way: Way | null): void {
  const st = useStudio.getState();
  if (!ids.length) return;
  st.apply((p) => setItemsInsertionAxis(p, st.editingModel, ids, way));
}
