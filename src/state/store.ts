import { create } from 'zustand';
import { usePlayback } from './playback';
import { useKeyframePlayback } from './keyframePlayback';
import { modelSteps, reorderStep, type ModelName } from '../plan/ops';
import { setAssemblySpot, setLoosePiecesFollow, setSubmodelBuildSpot, setWorkBaySpot as applyWorkBaySpot } from '../plan/pieceActions';
import { isMainSpot, type SpotRef } from '../plan/assemblySpots';
import type { Tool } from './keymap';
import type { StepView } from '../model/stepLayout';
import { emptyPlan, type AssemblySpot, type Plan } from '../plan/types';

const HISTORY_LIMIT = 200;

/** Keep the preview focused on the same group when Undo/Redo changes step indices. */
function remapStep(from: Plan, to: Plan, model: ModelName, index: number | null): number | null {
  if (index === null) return null;
  const source = modelSteps(from, model)[index];
  const candidates = modelSteps(to, model);
  if (!candidates.length) return null;
  if (!source) return Math.min(index, candidates.length - 1);
  const exact = candidates.indexOf(source);
  if (exact >= 0) return exact;
  const firstId = source.pieces.find((p) => p.id)?.id;
  if (firstId) {
    const match = candidates.findIndex((s) => s.pieces.some((p) => p.id === firstId));
    if (match >= 0) return match;
  }
  return Math.min(index, candidates.length - 1);
}

export type StudioState = {
  plan: Plan;
  past: Plan[];
  future: Plan[];
  selection: { model: ModelName; ids: string[] };
  /** the Assembly tile whose spot is selected (null: none) */
  spot: SpotRef | null;
  selectSpot(ref: SpotRef | null): void;
  /** Sets one assembly spot (null = Auto) as a single undoable edit. */
  setSpot(ref: SpotRef, spot: AssemblySpot | null): void;
  /** Places one planner-generated work bay (null = Auto) as an undoable edit. */
  setWorkBaySpot(key: string, spot: AssemblySpot | null): void;
  /** The main model's "loose pieces move with the model" switch. */
  setFollow(follow: boolean): void;
  /** Controls only the Build editor preview; never edits original LDraw poses. */
  setShowModelAtSpot(show: boolean): void;
  editingModel: ModelName;
  mode: 'edit' | 'preview';
  /** Build clips and Dope Sheet remain independent workflows. */
  timelineEditor: 'build' | 'timeline';
  setTimelineEditor(mode: 'build' | 'timeline'): void;
  /** null = show every step */
  currentStep: number | null;
  /** item ids the viewport should frame; tick changes on every request */
  focus: { ids: string[]; tick: number };
  /** color used for the next added piece */
  paintColor: string | number;
  /** Select: dragging orbits the view. Move: dragging a piece moves it on the floor. */
  tool: Tool;
  /** Optional three-axis Blender-like transform handles. */
  gizmoEnabled: boolean;
  gizmoMode: 'translate' | 'rotate' | 'scale';
  /** the plan before a drag; while set, edits replace the plan without adding undo steps */
  gesture: Plan | null;
  /** how the Build view shows the current step's new parts */
  stepView: StepView;
  /** every piece of the open model laid out on the floor (no step selected) */
  laidOut: boolean;
  /**
   * Pieces hidden in the Build view, per model (item ids). Only a viewing aid: not
   * saved, not undoable, and the animation and video still build every piece.
   */
  hidden: Record<ModelName, string[]>;
  /** Hides pieces of the model being edited (and drops them from the selection). */
  hide(ids: string[]): void;
  /** Hides every piece of the model being edited except these. */
  isolate(ids: string[], all: string[]): void;
  /** Shows every hidden piece of the model being edited. */
  showAll(): void;
  setStepView(v: StepView): void;
  /** Lay every piece of the open model out on the floor, or put them back. */
  setLaidOut(on: boolean): void;
  setTool(t: Tool): void;
  setGizmo(enabled: boolean): void;
  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void;
  beginGesture(): void;
  endGesture(): void;
  apply(fn: (p: Plan) => Plan): void;
  /** Reorder, update the preview cursor, and record the move as a single undoable edit. */
  reorderBuildStep(model: ModelName, from: number, to: number): void;
  undo(): void;
  redo(): void;
  setPlan(p: Plan, opts?: { resetHistory: boolean }): void;
  /** Bumped to make the preview plan its animation again. */
  replans: number;
  replan(): void;
  select(ids: string[], additive?: boolean): void;
  setEditingModel(m: ModelName): void;
  setMode(mode: 'edit' | 'preview'): void;
  setCurrentStep(s: number | null): void;
  requestFocus(ids: string[]): void;
  setPaintColor(c: string | number): void;
};

export const useStudio = create<StudioState>((set, get) => ({
  plan: emptyPlan(),
  past: [],
  future: [],
  selection: { model: '', ids: [] },
  spot: null,
  selectSpot(ref) {
    // selecting a spot also makes it the transform gizmo's target, not the pieces
    set(ref ? { spot: ref, selection: { model: get().editingModel, ids: [] } } : { spot: null });
  },
  setSpot(ref, spot) {
    // Any manually dropped model, including a nested submodel, must become
    // visible at its new workbench immediately, even after a prior scrub.
    if (get().plan.showModelAtSpot)
      usePlayback.getState().set({ follow: false, playing: false });
    get().apply((p) => (isMainSpot(ref) ? setAssemblySpot(p, spot) : setSubmodelBuildSpot(p, ref.model, ref.id, spot)));
  },
  setWorkBaySpot(key, spot) {
    get().apply((p) => applyWorkBaySpot(p, key, spot));
  },
  setFollow(follow) {
    get().apply((p) => setLoosePiecesFollow(p, follow));
  },
  setShowModelAtSpot(show) {
    if (show) {
      // Switching to a finished-model placement preview must not appear inert
      // merely because the user previously scrubbed the animation.
      usePlayback.getState().set({ follow: false, playing: false });
      set({ currentStep: null, laidOut: false });
    }
    get().apply((p) => p.showModelAtSpot === show ? p : { ...p, showModelAtSpot: show });
  },
  editingModel: '',
  replans: 0,
  replan() { set({ replans: get().replans + 1 }); },
  mode: 'edit',
  timelineEditor: 'build',
  setTimelineEditor(timelineEditor) {
    if (get().timelineEditor === timelineEditor) return;
    usePlayback.getState().set({ playing: false, follow: false });
    useKeyframePlayback.getState().set({ playing: false });
    set({ timelineEditor, mode: 'edit', currentStep: null, laidOut: false, spot: null });
  },
  currentStep: null,
  focus: { ids: [], tick: 0 },
  paintColor: 71,
  tool: 'select',
  gizmoEnabled: false,
  gizmoMode: 'translate',
  gesture: null,
  stepView: 'separated',
  laidOut: false,
  hidden: {},
  hide(ids) {
    const { hidden, editingModel, selection } = get();
    const next = [...new Set([...(hidden[editingModel] ?? []), ...ids])];
    const gone = new Set(ids);
    set({ hidden: { ...hidden, [editingModel]: next }, selection: { model: selection.model, ids: selection.ids.filter((i) => !gone.has(i)) } });
  },
  isolate(ids, all) {
    const { hidden, editingModel } = get();
    const keep = new Set(ids);
    set({ hidden: { ...hidden, [editingModel]: all.filter((i) => !keep.has(i)) } });
  },
  showAll() {
    const { hidden, editingModel } = get();
    if (!hidden[editingModel]?.length) return;
    const { [editingModel]: _, ...rest } = hidden;
    set({ hidden: rest });
  },
  setStepView(stepView) {
    set({ stepView });
  },
  setLaidOut(laidOut) {
    // laying out stops following the timeline, like picking a step view
    if (laidOut) usePlayback.getState().set({ follow: false, playing: false });
    set(laidOut ? { laidOut, currentStep: null } : { laidOut });
  },
  setTool(tool) {
    set({ tool });
  },
  setGizmo(enabled) {
    set({ gizmoEnabled: enabled });
  },
  setGizmoMode(mode) {
    set({ gizmoMode: mode, gizmoEnabled: true });
  },
  beginGesture() {
    set({ gesture: get().plan });
  },
  endGesture() {
    const { gesture, plan, past } = get();
    if (!gesture) return;
    if (plan === gesture) return set({ gesture: null });
    set({ gesture: null, past: [...past, gesture].slice(-HISTORY_LIMIT), future: [] });
  },
  apply(fn) {
    const { plan, past, gesture } = get();
    const next = fn(plan);
    if (next === plan) return;
    if (gesture) return set({ plan: next });
    set({ plan: next, past: [...past, plan].slice(-HISTORY_LIMIT), future: [] });
  },
  reorderBuildStep(model, from, to) {
    const { plan, editingModel, currentStep } = get();
    const len = modelSteps(plan, model).length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= len || to >= len || from === to) return;
    get().apply((p) => reorderStep(p, model, from, to));
    if (editingModel === model && currentStep !== null) {
      const next = currentStep === from ? to : from < to && currentStep > from && currentStep <= to ? currentStep - 1 : from > to && currentStep >= to && currentStep < from ? currentStep + 1 : currentStep;
      set({ currentStep: next });
    }
  },
  undo() {
    const { plan, past, future, editingModel, currentStep } = get();
    if (!past.length) return;
    const previous = past[past.length - 1];
    set({ plan: previous, past: past.slice(0, -1), future: [plan, ...future], currentStep: remapStep(plan, previous, editingModel, currentStep) });
  },
  redo() {
    const { plan, past, future, editingModel, currentStep } = get();
    if (!future.length) return;
    const next = future[0];
    set({ plan: next, past: [...past, plan], future: future.slice(1), currentStep: remapStep(plan, next, editingModel, currentStep) });
  },
  setPlan(p, opts) {
    // a different set: its pieces may reuse ids, so nothing stays hidden
    if (opts?.resetHistory) set({ plan: p, past: [], future: [], selection: { model: '', ids: [] }, spot: null, editingModel: '', currentStep: null, hidden: {} });
    else {
      get().apply(() => p);
      set({ hidden: {} });
    }
  },
  select(ids, additive) {
    const { selection, editingModel } = get();
    if (!additive) return set({ selection: { model: editingModel, ids } });
    const cur = new Set(selection.ids);
    for (const id of ids) cur.has(id) ? cur.delete(id) : cur.add(id);
    set({ selection: { model: editingModel, ids: [...cur] } });
  },
  setEditingModel(m) {
    usePlayback.getState().set({ follow: false, playing: false });
    useKeyframePlayback.getState().set({ playing: false });
    set({ editingModel: m, selection: { model: m, ids: [] }, spot: null, currentStep: null, laidOut: false });
  },
  setMode(mode) {
    if (mode === 'preview') useKeyframePlayback.getState().set({ playing: false });
    // coming back to Build while the preview plays: keep playing, now in the Build view
    if (mode === 'edit') usePlayback.getState().set({ follow: usePlayback.getState().playing });
    set({ mode });
  },
  setCurrentStep(s) {
    // picking a step lays it out (separated/exploded/assembled) instead of following the timeline
    usePlayback.getState().set({ follow: false, playing: false });
    set({ currentStep: s, laidOut: false });
  },
  requestFocus(ids) {
    set({ focus: { ids, tick: get().focus.tick + 1 } });
  },
  setPaintColor(c) {
    set({ paintColor: c });
  },
}));
