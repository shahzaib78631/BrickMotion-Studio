import { create } from 'zustand';
import { modelSteps, reorderStep, type ModelName } from '../plan/ops';
import type { Tool } from './keymap';
import { emptyPlan, type Plan } from '../plan/types';

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
  editingModel: ModelName;
  mode: 'edit' | 'preview';
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
  editingModel: '',
  mode: 'edit',
  currentStep: null,
  focus: { ids: [], tick: 0 },
  paintColor: 71,
  tool: 'select',
  gizmoEnabled: false,
  gizmoMode: 'translate',
  gesture: null,
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
    if (opts?.resetHistory) set({ plan: p, past: [], future: [], selection: { model: '', ids: [] }, editingModel: '', currentStep: null });
    else get().apply(() => p);
  },
  select(ids, additive) {
    const { selection, editingModel } = get();
    if (!additive) return set({ selection: { model: editingModel, ids } });
    const cur = new Set(selection.ids);
    for (const id of ids) cur.has(id) ? cur.delete(id) : cur.add(id);
    set({ selection: { model: editingModel, ids: [...cur] } });
  },
  setEditingModel(m) {
    set({ editingModel: m, selection: { model: m, ids: [] }, currentStep: null });
  },
  setMode(mode) {
    set({ mode });
  },
  setCurrentStep(s) {
    set({ currentStep: s });
  },
  requestFocus(ids) {
    set({ focus: { ids, tick: get().focus.tick + 1 } });
  },
  setPaintColor(c) {
    set({ paintColor: c });
  },
}));
