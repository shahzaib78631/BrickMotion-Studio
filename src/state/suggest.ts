import { create } from 'zustand';
import * as THREE from 'three';
import type { Instance } from '../model/assemble';
import { newId } from '../plan/ids';
import { addItem, modelSteps } from '../plan/ops';
import type { PlanItem } from '../plan/types';
import { suggest, type Placed, type Suggestion } from '../suggest/engine';
import { fitsAt, loadHabits, openSpots, type Habits, type Spot } from '../suggest/fitsAt';
import { ensureParts, isLoaded, metricsOf, partName } from './partService';
import { useStudio } from './store';

/**
 * Build autocomplete: after every edit or selection change, the suggestion engine
 * (src/suggest/engine.ts) proposes what to place next, shown as ghost pieces. Tab takes
 * the highlighted one, ` (backquote) steps to the next, Esc hides them until the next edit.
 */
type SuggestState = {
  /** the feature switch (Suggestions panel) */
  on: boolean;
  list: Suggestion[];
  /** the highlighted suggestion (its ghost is drawn) */
  index: number;
  /** hidden until the next edit (Esc) */
  dismissed: boolean;
  busy: boolean;
  /** "What fits here?": the spot asked about; the list then holds what fits it */
  spot: Spot | null;
  /** free Technic holes, pins, clips… on the pieces suggestions follow */
  spots: Spot[];
};
export const useSuggest = create<SuggestState>(() => ({ on: true, list: [], index: 0, dismissed: false, busy: false, spot: null, spots: [] }));

let habits: Habits | null = null;
void loadHabits().then((h) => {
  habits = h;
  if (h) schedule(0);
});
const metrics = (p: string) => (isLoaded(p) ? metricsOf(p) : null);
const name = (p: string) => partName(p) || p;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastInput: { instances: readonly Instance[]; selection: readonly string[] } | null = null;
let generation = 0;

const top = (key: string) => key.split('/')[0];

function placedOf(instances: readonly Instance[]): Placed[] {
  return instances.filter((i) => !i.placeholder).map((i) => ({ key: i.key, part: i.part, color: i.color, world: i.world }));
}

function run(): void {
  const input = lastInput;
  if (!input || !useSuggest.getState().on) return;
  const gen = ++generation;
  const pieces = placedOf(input.instances);
  const spot = useSuggest.getState().spot;
  if (spot) return runSpot(gen, pieces, spot);
  const sel = new Set(input.selection);
  const anchors = pieces.filter((p) => sel.has(top(p.key))).map((p) => p.key);
  const out = suggest({ pieces, anchors, metrics, name, limit: 8, budgetMs: 60 });
  // open connections on what suggestions follow; the best fit of the first two joins the list
  const on = anchors.length ? anchors : pieces.slice(-1).map((p) => p.key);
  const spots = openSpots(pieces, on, metrics);
  const wanted = new Set(out.wanted);
  const extra: Suggestion[] = [];
  if (habits) {
    for (const sp of spots.slice(0, 2)) {
      const f = fitsAt({ pieces, key: sp.key, spot: sp.conn, metrics, habits, name, limit: 1, budgetMs: 40 });
      f.wanted.forEach((w) => wanted.add(w));
      if (f.fits[0]) extra.push({ ...f.fits[0], title: `${f.fits[0].title} in the open ${sp.label}` });
    }
  }
  const list = out.suggestions.slice(0, 1).concat(extra, out.suggestions.slice(1)).slice(0, 8);
  useSuggest.setState({ list, index: 0, spots, busy: wanted.size > 0 });
  loadThenRetry(gen, [...wanted]);
}

/** Parts the engine wanted but were not loaded: load them, then think again. */
function loadThenRetry(gen: number, wanted: string[]): void {
  if (!wanted.length) return;
  void ensureParts(wanted).then(() => {
    if (gen === generation) schedule(0);
  }).catch(() => useSuggest.setState({ busy: false }));
}

function runSpot(gen: number, pieces: Placed[], spot: Spot): void {
  const out = fitsAt({ pieces, key: spot.key, spot: spot.conn, metrics, habits, name, limit: 10, budgetMs: 400 });
  useSuggest.setState({ list: out.fits, index: 0, busy: out.wanted.length > 0 || !habits, dismissed: false });
  loadThenRetry(gen, out.wanted);
}

/**
 * The free connection of a piece nearest a point on it (model LDU, from the viewport's pick),
 * for "What fits here?". Null when the piece has none free (or is not loaded yet).
 */
export function spotAt(key: string, point: readonly number[]): Spot | null {
  const input = lastInput;
  if (!input) return null;
  const pieces = placedOf(input.instances);
  const piece = pieces.find((p) => p.key === key) ?? pieces.find((p) => top(p.key) === top(key));
  if (!piece || !isLoaded(piece.part)) return null;
  return fitsAt({ pieces, key: piece.key, point, metrics, habits: null, limit: 0, budgetMs: 0 }).spot;
}

/** Show what fits one open spot. */
export function askSpot(spot: Spot): void {
  useSuggest.setState({ on: true, spot, list: [], index: 0, dismissed: false, busy: true });
  schedule(0);
}

/** Back to the usual next-piece suggestions. */
export function clearSpot(): void {
  useSuggest.setState({ spot: null, list: [] });
  schedule(0);
}

function schedule(ms = 150): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // off the input path: the engine runs when the browser is idle
    // (with a deadline: a background tab may never be idle)
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(run, { timeout: 300 });
    else run();
  }, ms);
}

/** Whether the pieces differ (the viewport hands over a new list often, mostly with the same pieces). */
function changed(a: readonly Instance[], b: readonly Instance[]): boolean {
  if (a === b) return false;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].part !== b[i].part) return true;
    const x = a[i].world.elements, y = b[i].world.elements;
    for (let k = 0; k < 16; k++) if (x[k] !== y[k]) return true;
  }
  return false;
}

/** The viewport tells us what it shows; suggestions follow (debounced). */
export function noteBuild(instances: readonly Instance[], selection: readonly string[]): void {
  if (lastInput && lastInput.instances === instances && lastInput.selection.join() === selection.join()) return;
  // a spot asked about holds until the model changes or the selection leaves its piece
  const spot = useSuggest.getState().spot;
  if (spot && lastInput && (changed(lastInput.instances, instances) || (selection.length && !selection.includes(top(spot.key))))) useSuggest.setState({ spot: null });
  lastInput = { instances, selection: [...selection] };
  useSuggest.setState({ dismissed: false });
  schedule();
}

export function setSuggestionsOn(on: boolean): void {
  useSuggest.setState({ on, list: on ? useSuggest.getState().list : [] });
  if (on) schedule(0);
}

export function cycleSuggestion(dir: 1 | -1): void {
  const { list, index } = useSuggest.getState();
  if (!list.length) return;
  useSuggest.setState({ index: (index + dir + list.length) % list.length, dismissed: false });
}

export function highlightSuggestion(index: number): void {
  useSuggest.setState({ index, dismissed: false });
}

export function dismissSuggestions(): void {
  useSuggest.setState({ dismissed: true });
}

/** The highlighted suggestion, if it is showing. */
export function shownSuggestion(): Suggestion | null {
  const s = useSuggest.getState();
  return s.on && !s.dismissed ? s.list[s.index] ?? null : null;
}

/** Row-major 3×3 and LDU position of a column-major 4×4. */
function rawOf(e: readonly number[]): { ldu: [number, number, number]; matrix: [number, number, number, number, number, number, number, number, number] } {
  const r = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) || 0 : v);
  return {
    ldu: [r(e[12]), r(e[13]), r(e[14])],
    matrix: [r(e[0]), r(e[4]), r(e[8]), r(e[1]), r(e[5]), r(e[9]), r(e[2]), r(e[6]), r(e[10])],
  };
}

/**
 * Place a suggestion's pieces in the model being edited, in the current step, as one undo
 * step; they become the selection, so the next suggestions build on them.
 */
export function acceptSuggestion(index = useSuggest.getState().index): string[] | null {
  const s = useSuggest.getState().list[index];
  if (!s) return null;
  const st = useStudio.getState();
  const m = st.editingModel;
  const ids: string[] = [];
  st.apply((plan) => {
    let p = plan;
    const step = st.currentStep ?? Math.max(0, modelSteps(p, m).length - 1);
    for (const g of s.pieces) {
      const item = { id: newId(p), part: g.part, color: g.color, ...rawOf(g.world) } as PlanItem;
      ids.push(item.id!);
      p = addItem(p, m, step, item);
    }
    return p;
  });
  st.select(ids);
  useSuggest.setState({ list: [], index: 0, spot: null });
  return ids;
}

/** World matrices of the shown ghost pieces (model LDU), for tests and the renderer. */
export function ghostMatrices(s: Suggestion): THREE.Matrix4[] {
  return s.pieces.map((g) => new THREE.Matrix4().fromArray(g.world));
}
