import { create } from 'zustand';
import type { ModelName } from '../plan/ops';
import { emptyPlan, type Plan } from '../plan/types';

const HISTORY_LIMIT = 200;

export type StudioState = {
  plan: Plan;
  past: Plan[];
  future: Plan[];
  selection: { model: ModelName; ids: string[] };
  editingModel: ModelName;
  mode: 'edit' | 'preview';
  /** null = show every step */
  currentStep: number | null;
  apply(fn: (p: Plan) => Plan): void;
  undo(): void;
  redo(): void;
  setPlan(p: Plan, opts?: { resetHistory: boolean }): void;
  select(ids: string[], additive?: boolean): void;
  setEditingModel(m: ModelName): void;
  setMode(mode: 'edit' | 'preview'): void;
  setCurrentStep(s: number | null): void;
};

export const useStudio = create<StudioState>((set, get) => ({
  plan: emptyPlan(),
  past: [],
  future: [],
  selection: { model: '', ids: [] },
  editingModel: '',
  mode: 'edit',
  currentStep: null,
  apply(fn) {
    const { plan, past } = get();
    const next = fn(plan);
    if (next === plan) return;
    set({ plan: next, past: [...past, plan].slice(-HISTORY_LIMIT), future: [] });
  },
  undo() {
    const { plan, past, future } = get();
    if (!past.length) return;
    set({ plan: past[past.length - 1], past: past.slice(0, -1), future: [plan, ...future] });
  },
  redo() {
    const { plan, past, future } = get();
    if (!future.length) return;
    set({ plan: future[0], past: [...past, plan], future: future.slice(1) });
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
}));
