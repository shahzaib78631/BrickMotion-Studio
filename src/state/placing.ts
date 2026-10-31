import { create } from 'zustand';
import type { Vec3 } from '../ldraw/parse';
import { assemble, type ANode, type Instance } from '../model/assemble';
import { collisionWorld, solidsFor, type Solid } from '../plan/collision';
import { addPosedItems, commitPose } from '../plan/commitPose';
import { partConnectors, worldConnectors, type Connector } from '../plan/connectors';
import { newId } from '../plan/ids';
import { addItem, findItem, modelSteps, type ModelName } from '../plan/ops';
import { findPose, freeTargets, handleCount, type Pose, type PoseQuery, type Quarter } from '../plan/placementEngine';
import type { Plan, PlanItem, Submodel } from '../plan/types';
import { useAppSettings } from './appSettings';
import { bodyFor } from './editing';
import { getColors, metricsOf } from './partService';
import { useStudio } from './store';

/**
 * One Studio-style placing gesture: moving pieces already built, or placing new ones
 * (palette, paste, clone). The pieces live in the plan for the whole gesture, at the pose
 * the mouse picks, so the viewport just draws the plan; commit keeps it as one undo step,
 * cancel puts the plan back. Hits are in the model's own LDraw frame.
 */
export type PlacingSource =
  | { kind: 'move'; model: ModelName; ids: string[] }
  | { kind: 'new'; model: ModelName; items: PlanItem[]; submodels?: Record<string, Submodel> };
export type PlacingState = { source: PlacingSource; ids: string[]; pose: Pose | null; handle: number; yaw: Quarter } | null;
export const usePlacing = create<{ state: PlacingState }>(() => ({ state: null }));

type Session = {
  model: ModelName;
  ids: string[];
  base: Plan;
  plan0: Plan;
  nodes0: ANode[];
  query: Omit<PoseQuery, 'hit' | 'handle' | 'yaw' | 'prev'>;
  visible: Set<string>;
  stepOf: (owner: string) => number;
  newItems: PlanItem[] | null;
  step: number;
  selection: string[];
  lastHit: PoseQuery['hit'] | null;
};
let session: Session | null = null;

const top = (key: string) => key.split('/')[0];

function connectorsOf(inst: Instance): Connector[] {
  return worldConnectors(partConnectors(metricsOf(inst.part)), inst.world.elements);
}

/** Ids of the model's top-level items visible at the current step and not hidden. */
function visibleIds(plan: Plan, m: ModelName): Set<string> {
  const { currentStep, hidden } = useStudio.getState();
  const gone = new Set(hidden[m] ?? []);
  const out = new Set<string>();
  modelSteps(plan, m).forEach((s, i) => {
    if (currentStep !== null && i > currentStep) return;
    for (const it of s.pieces) if (it.id && !gone.has(it.id)) out.add(it.id);
  });
  return out;
}

export function beginPlacing(src: PlacingSource, grab?: Vec3): void {
  if (session) cancelPlacing();
  const st = useStudio.getState();
  const m = src.model;
  const steps = modelSteps(st.plan, m);
  const step = st.currentStep ?? Math.max(0, steps.length - 1);
  st.beginGesture();
  const base = st.plan;
  let plan0 = base, ids: string[] = [], newItems: PlanItem[] | null = null;
  if (src.kind === 'move') ids = [...src.ids];
  else {
    if (src.submodels) plan0 = { ...plan0, submodels: { ...plan0.submodels, ...src.submodels } };
    newItems = [];
    for (const it of src.items) {
      const placed = { ...it, id: newId(plan0) };
      newItems.push(placed);
      plan0 = addItem(plan0, m, step, placed);
    }
    ids = newItems.map((it) => it.id!);
  }
  const view = assemble({ ...plan0, steps: modelSteps(plan0, m) }, metricsOf, getColors());
  const moving = new Set(ids);
  const mine = view.instances.filter((i) => moving.has(top(i.key)));
  const rest = view.instances.filter((i) => !moving.has(top(i.key)) && !i.placeholder);
  const visible = visibleIds(plan0, m);
  const shown = rest.filter((i) => visible.has(top(i.key)));
  // free targets are worked out per placed part, then owned by their top-level item
  const keyed: Solid[] = shown.map((i) => ({ ...solidsFor([i], metricsOf)[0], id: i.key }));
  const targets = freeTargets(shown.map((i) => ({ list: connectorsOf(i), owner: i.key })), keyed).map((t) => ({ ...t, owner: top(t.owner) }));
  const solids = solidsFor(mine, metricsOf);
  const connectors = mine.flatMap(connectorsOf);
  const world = useAppSettings.getState().collision ? collisionWorld(solidsFor(rest, metricsOf)) : null;
  const before = src.kind === 'move' && world ? world.hits(solids) : new Set<string>();
  // default handle: the connector nearest where the piece was grabbed; a new part hangs from its first socket
  let handle = Math.max(0, connectors.findIndex((c) => c.gender === 'F'));
  if (grab) {
    // grabbed pieces go on top of things: the nearest underside socket, else the nearest connector (Tab for the rest)
    const down = connectors.some((c) => c.gender === 'F' && c.axis[1] > 0.9);
    let d = Infinity;
    connectors.forEach((c, i) => {
      if (down && !(c.gender === 'F' && c.axis[1] > 0.9)) return;
      const e = Math.hypot(c.pos[0] - grab[0], c.pos[1] - grab[1], c.pos[2] - grab[2]);
      if (e < d) { d = e; handle = i; }
    });
  }
  if (plan0 !== base) st.apply(() => plan0);
  session = {
    model: m, ids, base, plan0, nodes0: view.nodes, visible, newItems, step,
    query: { moving: { solids, connectors }, targets, world, before },
    stepOf: (o) => findItem(plan0, m, o)?.step ?? 0,
    selection: st.selection.ids,
    lastHit: null,
  };
  if (newItems) st.select(ids);
  usePlacing.setState({ state: { source: src, ids, pose: null, handle, yaw: 0 } });
}

function apply(pose: Pose): void {
  const s = session!;
  const st = useStudio.getState();
  if (s.newItems) {
    // new pieces are re-added from the base plan at the pose (their step stays the current one)
    const without = s.base.submodels === s.plan0.submodels ? s.base : { ...s.base, submodels: s.plan0.submodels };
    st.apply(() => addPosedItems(without, s.model, s.step, s.newItems!, pose, bodyFor(s.plan0)));
  } else st.apply(() => commitPose(s.plan0, s.model, s.ids, s.nodes0, pose, s.stepOf));
}

/** Follows the mouse: the best pose for a hit in the model's LDraw frame (owner = top-level item id, null = floor). */
export function updatePlacing(hit: { point: Vec3; owner: string | null }): Pose | null {
  const s = session, cur = usePlacing.getState().state;
  if (!s || !cur) return null;
  const owner = hit.owner && s.visible.has(hit.owner) && !s.ids.includes(hit.owner) ? hit.owner : null;
  s.lastHit = { point: hit.point, owner };
  const pose = findPose({ ...s.query, hit: s.lastHit, handle: cur.handle, yaw: cur.yaw, prev: cur.pose });
  if (pose !== cur.pose) {
    apply(pose);
    usePlacing.setState({ state: { ...cur, pose } });
  }
  return pose;
}

function refresh(): void {
  const s = session;
  if (s?.lastHit) updatePlacing(s.lastHit);
}

/** Tab / Shift+Tab: hold the parts by the next (or previous) connection. */
export function cycleHandle(dir: 1 | -1): void {
  const s = session, cur = usePlacing.getState().state;
  if (!s || !cur) return;
  const n = handleCount(s.query.moving);
  if (n < 2) return;
  usePlacing.setState({ state: { ...cur, handle: (cur.handle + dir + n) % n, pose: null } });
  refresh();
}

/** R / Shift+R while placing: a quarter turn about the target's axis. */
export function turnInHand(dir: 1 | -1): void {
  const cur = usePlacing.getState().state;
  if (!session || !cur) return;
  usePlacing.setState({ state: { ...cur, yaw: (((cur.yaw + dir * 90) % 360) + 360) % 360 as Quarter, pose: null } });
  refresh();
}

/** Release: keeps a valid pose as one undo step and selects the pieces; an invalid one cancels. */
export function commitPlacing(): string[] | null {
  const s = session, cur = usePlacing.getState().state;
  if (!s || !cur) return null;
  if (!cur.pose || !cur.pose.valid) {
    cancelPlacing();
    return null;
  }
  const st = useStudio.getState();
  st.endGesture();
  st.select(s.ids);
  session = null;
  usePlacing.setState({ state: null });
  return s.ids;
}

/** Esc: puts everything back as it was before the gesture. */
export function cancelPlacing(): void {
  const s = session;
  session = null;
  usePlacing.setState({ state: null });
  if (!s) return;
  const st = useStudio.getState();
  st.apply(() => s.base);
  st.endGesture();
  if (s.newItems) st.select(s.selection);
}

export const isPlacing = () => session !== null;

/** The part being dragged from the Parts panel (HTML drag and drop hides its data until the drop). */
let palettePart: string | null = null;
export const paletteDrag = () => palettePart;
export function setPaletteDrag(part: string | null): void {
  palettePart = part;
  // a drag that ended anywhere but the view leaves nothing behind
  if (!part && session?.newItems) cancelPlacing();
}
