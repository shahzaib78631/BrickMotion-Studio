import { create } from 'zustand';
import type { Vec3 } from '../ldraw/parse';
import { assemble, type ANode, type Instance } from '../model/assemble';
import { collisionWorld, solidsFor, type Solid } from '../plan/collision';
import { addPosedItems, commitPose } from '../plan/commitPose';
import { partConnectors, worldConnectors, type Connector } from '../plan/connectors';
import { newId } from '../plan/ids';
import { addItem, findItem, modelSteps, type ModelName } from '../plan/ops';
import { findPose, freeTargets, handleCount, type Pose, type PoseQuery, type Quarter } from '../plan/placementEngine';
import type { Aim } from '../plan/aim';
import * as THREE from 'three';
import type { Plan, PlanItem, Submodel } from '../plan/types';
import { useAppSettings } from './appSettings';
import { bodyFor } from './editing';
import { getColors, metricsOf } from './partService';
import { useStudio } from './store';
import { visibleItemIds } from '../plan/visible';

/**
 * One Studio-style placing gesture: moving pieces already built, or placing new ones
 * (palette, paste, clone). The pieces live in the plan for the whole gesture, at the pose
 * the mouse picks, so the viewport just draws the plan; commit keeps it as one undo step,
 * cancel puts the plan back. The mouse ray is in the model's own LDraw frame.
 */
export type PlacingSource =
  | { kind: 'move'; model: ModelName; ids: string[] }
  | { kind: 'new'; model: ModelName; items: PlanItem[]; submodels?: Record<string, Submodel> };
/** `lock`: the grip Tab pinned (index into the moving connectors); null = automatic. */
export type PlacingState = { source: PlacingSource; ids: string[]; pose: Pose | null; lock: number | null; yaw: Quarter } | null;
export const usePlacing = create<{ state: PlacingState }>(() => ({ state: null }));

type Session = {
  model: ModelName;
  ids: string[];
  base: Plan;
  plan0: Plan;
  nodes0: ANode[];
  query: Omit<PoseQuery, 'aim' | 'lock' | 'yaw' | 'prev'> & { floor: number };
  visible: Set<string>;
  stepOf: (owner: string) => number;
  newItems: PlanItem[] | null;
  step: number;
  selection: string[];
  lastAim: Aim | null;
};
let session: Session | null = null;

const top = (key: string) => key.split('/')[0];

function connectorsOf(inst: Instance): Connector[] {
  return worldConnectors(partConnectors(metricsOf(inst.part)), inst.world.elements);
}

/** The centre of the bottom face of what is placed (box centre x / z, box bottom; Y down). */
function undersideOf(solids: readonly Solid[]): Vec3 {
  const box = new THREE.Box3();
  for (const s of solids) box.union(new THREE.Box3(new THREE.Vector3(...s.body.min), new THREE.Vector3(...s.body.max)).applyMatrix4(new THREE.Matrix4().fromArray(Array.from(s.world))));
  if (box.isEmpty()) return [0, 0, 0];
  const c = box.getCenter(new THREE.Vector3());
  return [c.x, box.max.y, c.z];
}

/** Ids of the model's top-level items visible at the current step and not hidden. */
function visibleIds(plan: Plan, m: ModelName): Set<string> {
  const { currentStep, hidden } = useStudio.getState();
  return visibleItemIds(plan, m, currentStep, hidden[m] ?? []);
}

export function beginPlacing(src: PlacingSource, grab?: Vec3): void {
  if (session) cancelPlacing();
  const st = useStudio.getState();
  const m = src.model;
  const steps = modelSteps(st.plan, m);
  const step = st.currentStep ?? Math.max(0, steps.length - 1);
  st.beginGesture();
  st.ownGesture(cancelPlacing);
  const base = st.plan;
  let plan0 = base, ids: string[] = [], newItems: PlanItem[] | null = null;
  if (src.kind === 'move') ids = [...src.ids];
  else {
    // never replace a submodel the plan already has
    const fresh = Object.entries(src.submodels ?? {}).filter(([n]) => !plan0.submodels?.[n]);
    if (fresh.length) plan0 = { ...plan0, submodels: { ...plan0.submodels, ...Object.fromEntries(fresh) } };
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
  // the parts are held where they were grabbed; a new part by the centre of its underside
  const ref: Vec3 = grab ?? undersideOf(solids);
  if (plan0 !== base) st.gestureApply(() => plan0);
  session = {
    model: m, ids, base, plan0, nodes0: view.nodes, visible, newItems, step,
    // the drawn floor (the model's lowest point), fixed for the whole gesture
    query: { moving: { solids, connectors }, targets, ref, world, before, floor: view.bounds?.max[1] ?? 0 },
    stepOf: (o) => findItem(plan0, m, o)?.step ?? 0,
    selection: st.selection.ids,
    lastAim: null,
  };
  if (newItems) st.select(ids);
  usePlacing.setState({ state: { source: src, ids, pose: null, lock: null, yaw: 0 } });
}

function apply(pose: Pose): void {
  const s = session!;
  const st = useStudio.getState();
  if (s.newItems) {
    // new pieces are re-added from the base plan at the pose (their step stays the current one)
    const without = s.base.submodels === s.plan0.submodels ? s.base : { ...s.base, submodels: s.plan0.submodels };
    st.gestureApply(() => addPosedItems(without, s.model, s.step, s.newItems!, pose, bodyFor(s.plan0)));
  } else st.gestureApply(() => commitPose(s.plan0, s.model, s.ids, s.nodes0, pose, s.stepOf));
}

/** Follows the mouse: the best pose for the mouse ray, in the model's LDraw frame. */
export function updatePlacing(aim: Aim): Pose | null {
  const s = session, cur = usePlacing.getState().state;
  if (!s || !cur) return null;
  s.lastAim = aim;
  const pose = findPose({ ...s.query, aim, lock: cur.lock, yaw: cur.yaw, prev: cur.pose });
  if (pose !== cur.pose) {
    apply(pose);
    usePlacing.setState({ state: { ...cur, pose } });
  }
  return pose;
}

function refresh(): void {
  const s = session;
  if (s?.lastAim) updatePlacing(s.lastAim);
}

/** Tab / Shift+Tab: pin the next (or previous) grip; past the last one is back to automatic. */
export function cycleHandle(dir: 1 | -1): void {
  const s = session, cur = usePlacing.getState().state;
  if (!s || !cur) return;
  const n = handleCount(s.query.moving);
  if (!n) return;
  // positions 0..n: 0 = automatic, k = grip k - 1
  const at = cur.lock === null ? 0 : cur.lock + 1;
  const next = (at + dir + n + 1) % (n + 1);
  usePlacing.setState({ state: { ...cur, lock: next === 0 ? null : next - 1, pose: null } });
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
  session = null;
  st.ownGesture(null);
  st.endGesture();
  st.select(s.ids);
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
  st.ownGesture(null);
  st.gestureApply(() => s.base);
  st.endGesture();
  if (s.newItems) st.select(s.selection);
}

export const isPlacing = () => session !== null;
/** LDraw height of the floor the open session places onto (null when not placing). */
export const placingFloor = (): number | null => session?.query.floor ?? null;

/** The part being dragged from the Parts panel (HTML drag and drop hides its data until the drop). */
let palettePart: string | null = null;
export const paletteDrag = () => palettePart;
export function setPaletteDrag(part: string | null): void {
  palettePart = part;
  // a drag that ended anywhere but the view leaves nothing behind
  if (!part && session?.newItems) cancelPlacing();
}
