import { useEffect, useState } from 'react';
import { FROM_ABOVE, fromShown, toShown, wayLabel, type Way } from '../anim/flightDirection';
import type { Timeline } from '../anim/timeline';
import { applyWay, wayState } from '../state/flightWay';
import { useStudio } from '../state/store';
import type { ModelState } from '../state/useModel';
import { Ic } from './icons';

const PRESETS: { label: string; title: string; way: Way }[] = [
  { label: 'Above', title: 'Drop on from above', way: FROM_ABOVE },
  { label: '+X', title: 'Come in from the +X side', way: [1, 0, 0] },
  { label: '−X', title: 'Come in from the −X side', way: [-1, 0, 0] },
  { label: '+Z', title: 'Come in from the +Z side', way: [0, 0, 1] },
  { label: '−Z', title: 'Come in from the −Z side', way: [0, 0, -1] },
  { label: 'Below', title: 'Come up from below', way: [0, 1, 0] },
];

const same = (a: Way | null, b: Way) => !!a && a.every((v, k) => Math.abs(v - b[k]) < 1e-3);
const fmt = (v: number) => String(Math.round(v * 100) / 100);

/**
 * "Flies in from": the way the selected pieces come in to their seat. Shows the
 * planned way until one is set; X/Y/Z (Y up) take any direction, presets snap to a
 * side, and Aim opens the arrow handle in the viewport. Auto hands it back to the planner.
 */
export function FlightWayEditor({ ids, model, timeline }: { ids: string[]; model: ModelState; timeline: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const aiming = useStudio((s) => s.aimWay);
  const { way, own, mixed } = wayState(plan, editingModel, ids, model, timeline);
  const shown = way ? toShown(way) : null;
  const [draft, setDraft] = useState<string[] | null>(null);
  // a new selection or an outside change (undo, the viewport arrow) drops a half-typed value
  useEffect(() => setDraft(null), [ids.join(), way?.join()]);

  const values = draft ?? (shown ? shown.map(fmt) : ['', '', '']);
  const commit = () => {
    if (!draft) return;
    const next = fromShown(draft.map(Number));
    setDraft(null);
    if (next && next.every(Number.isFinite)) applyWay(ids, next);
  };
  const field = (label: string, k: number) => (
    <label className="bm-axis-field" key={label}>
      <span>{label}</span>
      <input type="number" step={0.1} aria-label={`Flies in from, ${label} (Y is up)`} value={values[k]}
        onChange={(e) => { const v = [...values]; v[k] = e.target.value; setDraft(v); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
        }} />
    </label>
  );

  return (
    <section className="bm-inspector-section bm-flight-way">
      <h4>Flies in from <small>{mixed ? '(mixed)' : own ? `(set · ${way ? wayLabel(way) : ''})` : way ? `(auto · ${wayLabel(way)})` : '(auto)'}</small></h4>
      <div className="bm-transform-row"><span>Direction</span><div className="bm-axis-group">{field('X', 0)}{field('Y', 1)}{field('Z', 2)}</div></div>
      <div className="bm-way-presets" role="group" aria-label="Flies in from presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" title={p.title} className={own && same(way, p.way) ? 'selected' : ''}
            onClick={() => applyWay(ids, p.way)}>{p.label}</button>
        ))}
      </div>
      <div className="bm-inline-actions">
        <button type="button" className={aiming ? 'selected' : ''} aria-pressed={aiming}
          title="Show a handle on the piece: drag its tip, or use the arrow keys (Shift ↑/↓ above/below, Alt tilts 15°). W toggles."
          onClick={() => useStudio.getState().setAimWay(!aiming)}><Ic name="arrowUp" /> Aim in viewport <kbd>W</kbd></button>
        <button type="button" disabled={!own && !mixed} title="Let the planner choose the way in" onClick={() => applyWay(ids, null)}><Ic name="x" /> Auto</button>
      </div>
    </section>
  );
}
