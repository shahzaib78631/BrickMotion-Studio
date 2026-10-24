import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { Timeline } from '../anim/timeline';
import { autoCentre, centre2, footprints, formatSpot, isMainSpot, overlaps, spotOf, storedSpot, submodelUses, type SpotRef, type SpotUse } from '../plan/assemblySpots';
import type { AssemblySpot } from '../plan/types';
import type { ModelState } from '../state/useModel';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { PaneHead } from './PaneHead';

/** Shared drag contract for the left pane and the scene's contextual chip bar. */
export const SPOT_DRAG_TYPE = 'application/x-brickmotion-spot';
const keyOf = (ref: SpotRef) => `${ref.model}\u0000${ref.id}`;

function startSpotDrag(event: DragEvent, ref: SpotRef) {
  event.dataTransfer.setData(SPOT_DRAG_TYPE, JSON.stringify(ref));
  event.dataTransfer.effectAllowed = 'copy';
}

export function draggedSpot(event: DragEvent): SpotRef | null {
  try {
    const ref: unknown = JSON.parse(event.dataTransfer.getData(SPOT_DRAG_TYPE));
    return ref && typeof ref === 'object' && 'model' in ref && 'id' in ref &&
      typeof ref.model === 'string' && typeof ref.id === 'string'
      ? { model: ref.model, id: ref.id } : null;
  } catch { return null; }
}

const numberText = (n: number): string => String(Math.round(n * 100) / 100);
const strings = (spot: AssemblySpot) => ({ x: numberText(spot.x), z: numberText(spot.z), angle: numberText(spot.angle) });

/** Model spots are project objects, never temporary animation coordinates. */
export function AssemblyPanel({ model, timeline }: { model: ModelState; timeline: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const selected = useStudio((s) => s.spot);
  const editingModel = useStudio((s) => s.editingModel);
  const uses = useMemo(() => submodelUses(plan), [plan]);
  const collisions = useMemo(() => model.ready ? overlaps(footprints(plan, model.assembly, timeline)) : [], [plan, model.assembly, model.ready, timeline]);
  const conflicts = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of collisions) for (const ref of [entry.ref, entry.other]) {
      const k = keyOf(ref);
      map.set(k, [...(map.get(k) ?? []), entry.message]);
    }
    return map;
  }, [collisions]);
  const current = uses.find((use) => selected && keyOf(selected) === keyOf(use.ref));
  const placed = uses.filter((use) => !!spotOf(plan, use)).length;

  return (
    <div className="nx-pane bm-assembly">
      <PaneHead id="assembly" title="Assembly" count={uses.length}
        help="Select a model, then drag its row or viewport chip onto the floor. Drag a marker to move it, or enable the gizmo to translate or rotate. Positions are saved in studs; unset spots use automatic placement." />
      <div className="bm-assembly-overview">
        <span className="bm-assembly-overview-icon"><Ic name="spot" /></span>
        <div><strong>Build locations</strong><span>{placed} placed · {uses.length - placed} automatic</span></div>
        <span className="bm-assembly-count">{placed}/{uses.length}</span>
      </div>
      <div className="bm-spot-section-title">SCENE OUTLINER <span>DRAG TO PLACE</span></div>
      <ul className="bm-spots" aria-label="Assembly locations">
        {uses.map((use, index) => {
          const spot = spotOf(plan, use);
          const active = !!selected && keyOf(selected) === keyOf(use.ref);
          const issues = conflicts.get(keyOf(use.ref));
          return (
            <li key={keyOf(use.ref)} className={`bm-spot-row ${active ? 'active' : ''} ${issues ? 'bad' : ''}`}>
              <button type="button" className="bm-spot-main" style={{ paddingLeft: 10 + use.depth * 12 }}
                onClick={() => useStudio.getState().selectSpot(use.ref)}
                aria-pressed={active} draggable onDragStart={(ev) => startSpotDrag(ev, use.ref)}
                title={`${use.label} — ${spot ? formatSpot(spot) : 'Automatic placement'}. Drag onto the viewport to place.`}>
                <span className="bm-spot-drag" aria-hidden="true"><Ic name="grip" /></span>
                <span className={`bm-spot-object ${isMainSpot(use.ref) ? 'root' : ''}`}><Ic name={isMainSpot(use.ref) ? 'brick' : 'box'} /></span>
                <span className="bm-spot-text">
                  <strong>{use.label}</strong>
                  <span>{spot ? formatSpot(spot) : 'Automatic placement'}</span>
                </span>
                <span className={`bm-spot-status ${spot ? 'placed' : ''}`} aria-label={spot ? 'Placed' : 'Auto'}>{spot ? 'Set' : 'Auto'}</span>
              </button>
              {issues && <div className="bm-spot-warning" role="status"><Ic name="checks" /> {issues[0]}</div>}
              {index === 0 && uses.length > 1 && <span className="bm-spot-tree-line" />}
            </li>
          );
        })}
      </ul>
      {current ? <SpotFields key={keyOf(current.ref)} use={current} model={model} timeline={timeline} /> :
        <div className="bm-spot-empty"><Ic name="pointer" /><strong>Select a build location</strong><span>Choose a model above to edit its placement and orientation.</span></div>}
      {editingModel && <p className="nx-fine">Submodel editing is local. Main assembly placement applies only to the full set.</p>}
    </div>
  );
}

function SpotFields({ use, model, timeline }: { use: SpotUse; model: ModelState; timeline: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const chosen = spotOf(plan, use);
  const auto = autoCentre(timeline, use);
  const fallbackWorld: AssemblySpot = auto
    ? { x: auto[0] / 20, z: auto[1] / 20, angle: 0 }
    : isMainSpot(use.ref) && model.assembly.bounds
      ? { x: centre2(model.assembly.bounds)[0] / 20, z: centre2(model.assembly.bounds)[1] / 20, angle: 0 }
      : { x: 0, z: 0, angle: 0 };
  // The viewport displays *world* coordinates; submodel uses are saved relative
  // to the unmoved root. Convert the automatic centre before editing the fields.
  const base = chosen ?? storedSpot(plan, model.assembly.bounds, use.ref, fallbackWorld);
  const [draft, setDraft] = useState(() => strings(base));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(strings(base)); setInvalid(false); }, [base.x, base.z, base.angle, use.ref.model, use.ref.id]);
  const parsed = { x: Number(draft.x), z: Number(draft.z), angle: Number(draft.angle) };
  const valid = Object.values(draft).every((v) => v.trim() !== '') && Object.values(parsed).every(Number.isFinite);
  const dirty = valid && (parsed.x !== base.x || parsed.z !== base.z || parsed.angle !== base.angle || !chosen);
  const commit = () => {
    if (!valid) { setInvalid(true); return; }
    useStudio.getState().setSpot(use.ref, parsed);
    setInvalid(false);
  };
  const fields = [
    { axis: 'x' as const, label: 'X POSITION', unit: 'studs', step: 1 },
    { axis: 'z' as const, label: 'Z POSITION', unit: 'studs', step: 1 },
    { axis: 'angle' as const, label: 'Y ROTATION', unit: '°', step: 15 },
  ];
  return (
    <section className="bm-spot-editor" aria-label={`Placement of ${use.label}`}>
      <div className="bm-spot-editor-head">
        <div><span className="bm-spot-section-title">TRANSFORM</span><strong>{use.label}</strong></div>
        <span className={`bm-spot-editor-state ${chosen ? 'on' : ''}`}><span />{chosen ? 'Placed' : 'Automatic'}</span>
      </div>
      <div className="bm-spot-fields">
        {fields.map(({ axis, label, unit, step }) => (
          <label className="bm-spot-number" key={axis}>
            <span>{label}</span>
            <div className="bm-spot-number-entry">
              <input type="number" inputMode="decimal" step={step} value={draft[axis]}
                aria-label={`Spot ${label.toLowerCase()} in ${unit}`} aria-invalid={invalid && !valid}
                onChange={(e) => { setDraft((d) => ({ ...d, [axis]: e.target.value })); setInvalid(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur(); } if (e.key === 'Escape') { setDraft(strings(base)); e.currentTarget.blur(); } }} />
              <span>{unit}</span>
            </div>
          </label>
        ))}
      </div>
      {invalid && <p className="bm-spot-error" role="alert">Enter a finite number in every field.</p>}
      <div className="bm-spot-actions">
        <button type="button" className="nx-btn nx-sm bm-spot-apply" onClick={commit} disabled={!dirty || !valid}><Ic name="check" /> Apply transform</button>
        <button type="button" className="nx-btn nx-sm" onClick={() => useStudio.getState().setSpot(use.ref, null)} disabled={!chosen} title="Remove the manual placement"><Ic name="undo" /> Auto</button>
      </div>
      {!chosen && <p className="nx-fine">Automatic position{auto ? ' detected from the timeline' : ' available after planning'}. Applying the fields creates a fixed build spot.</p>}
      {isMainSpot(use.ref) && (
        <label className="bm-spot-follow">
          <input type="checkbox" checked={plan.loosePiecesFollow !== false} onChange={(e) => useStudio.getState().setFollow(e.target.checked)} />
          <span><strong>Loose pieces follow the model</strong><small>When off, the waiting parts stay in their original layout.</small></span>
        </label>
      )}
    </section>
  );
}

/** Contextual shortcuts in Build view, never included in an exported frame. */
export function AssemblyToolbar({ timeline }: { timeline: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const selected = useStudio((s) => s.spot);
  const editing = useStudio((s) => s.editingModel);
  const uses = useMemo(() => submodelUses(plan), [plan]);
  if (editing) return null;
  return (
    <div className="bm-spot-bar" role="toolbar" aria-label="Assembly spot shortcuts">
      <span className="bm-spot-bar-title"><Ic name="spot" /> <span>Assembly</span></span>
      <div className="bm-spot-bar-chips">
        {uses.map((use) => {
          const chosen = spotOf(plan, use);
          const active = !!selected && keyOf(selected) === keyOf(use.ref);
          return (
            <button key={keyOf(use.ref)} type="button" aria-pressed={active} className={`bm-spot-chip ${active ? 'sel' : ''} ${chosen ? 'placed' : 'auto'}`}
              title={`${use.label}: ${chosen ? formatSpot(chosen) : 'Auto'}. Drag onto the floor to place.`}
              draggable onDragStart={(ev) => startSpotDrag(ev, use.ref)} onClick={() => useStudio.getState().selectSpot(use.ref)}>
              <Ic name={isMainSpot(use.ref) ? 'brick' : 'box'} />{use.label}
              <span className="bm-spot-chip-state">{chosen ? 'Set' : 'Auto'}</span>
            </button>
          );
        })}
      </div>
      <span className="bm-spot-bar-hint"><Ic name={timeline ? 'moveHere' : 'info'} /> {timeline ? 'Drag to floor' : 'Planning'}</span>
    </div>
  );
}
