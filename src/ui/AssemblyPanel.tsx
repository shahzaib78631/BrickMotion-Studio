import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { Timeline } from '../anim/timeline';
import type { WorkBay } from '../anim/construction/types';
import { autoCentre, centre2, footprints, formatSpot, isMainSpot, overlaps, spotOf, storedSpot, submodelUses, type SpotRef, type SpotUse } from '../plan/assemblySpots';
import type { AssemblySpot } from '../plan/types';
import type { ModelState } from '../state/useModel';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { PaneHead } from './PaneHead';

/** Drag contract between the Assembly panel and viewport floor. */
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
  const bays = useMemo(() => timeline?.construction?.workBays ?? [], [timeline]);
  const collisions = useMemo(() => model.ready ? overlaps(footprints(plan, model.assembly, timeline)) : [], [plan, model.assembly, model.ready, timeline]);
  const conflicts = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of collisions) for (const ref of [entry.ref, entry.other]) {
      const k = keyOf(ref);
      map.set(k, [...(map.get(k) ?? []), entry.message]);
    }
    return map;
  }, [collisions]);
  // One selection at a time. Generated bays are panel-local because they have
  // no viewport marker; a model spot selected anywhere always takes precedence,
  // so a stale bay key can never shadow it.
  const [bayKey, setBayKey] = useState<string | null>(null);
  const selectedBay = !selected && bayKey ? bays.find((bay) => bay.key === bayKey) ?? null : null;
  const current = uses.find((use) => selected && keyOf(selected) === keyOf(use.ref));
  const placed = uses.filter((use) => !!spotOf(plan, use)).length;
  const placedBays = bays.filter((bay) => !!plan.workBaySpots?.[bay.key]).length;

  return (
    <div className="nx-pane bm-assembly">
      <PaneHead id="assembly" title="Assembly" count={uses.length}
        help="Select a model, then drag its row onto the floor. Drag a marker to move it, or enable the gizmo to translate or rotate. Generated construction subassemblies appear below after a V2/V3 plan and use the same numeric fields. Positions are saved in studs; unset spots use automatic placement." />
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
                onClick={() => { setBayKey(null); useStudio.getState().selectSpot(use.ref); }}
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
      <div className="bm-spot-section-title">CONSTRUCTION SUBASSEMBLIES <span>{bays.length ? `${placedBays}/${bays.length} PLACED` : 'AFTER PLANNING'}</span></div>
      {bays.length ? (
        <ul className="bm-spots" aria-label="Construction subassembly work bays">
          {bays.map((bay) => {
            const placedSpot = plan.workBaySpots?.[bay.key];
            const active = !selected && bayKey === bay.key;
            return (
              <li key={bay.key} className={`bm-spot-row ${active ? 'active' : ''}`}>
                <button type="button" className="bm-spot-main bm-spot-main-static" style={{ paddingLeft: 10 }}
                  onClick={() => { useStudio.getState().selectSpot(null); setBayKey(bay.key); }}
                  aria-pressed={active}
                  title={`${bay.label}${bay.model ? ` (${bay.model})` : ''} — ${placedSpot ? formatSpot(placedSpot) : 'Automatic placement'}. Parts: ${bay.parts.join(', ') || '—'}.`}>
                  <span className="bm-spot-object"><Ic name="box" /></span>
                  <span className="bm-spot-text">
                    <strong>{bay.label}</strong>
                    <span>{placedSpot ? formatSpot(placedSpot) : 'Automatic placement'}</span>
                  </span>
                  <span className={`bm-spot-status ${placedSpot ? 'placed' : ''}`} aria-label={placedSpot ? 'Placed' : 'Auto'}>{placedSpot ? 'Set' : 'Auto'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="nx-fine">Generated upper/lower/head/mechanical work bays appear here after a Construction V2 or V3 plan succeeds.</p>
      )}
      {current && selected ? <SpotFields key={keyOf(current.ref)} use={current} model={model} timeline={timeline} /> :
        selectedBay ? <WorkBayFields key={selectedBay.key} bay={selectedBay} /> :
        <div className="bm-spot-empty"><Ic name="pointer" /><strong>Select a build location</strong><span>Choose a model or a construction subassembly above to edit its placement and orientation.</span></div>}
      <div className="bm-spot-options" aria-label="Main model placement options">
        <div className="bm-spot-section-title">VIEW &amp; ANIMATION</div>
        <label className="bm-spot-follow">
          <input type="checkbox" checked={plan.showModelAtSpot === true} onChange={(e) => useStudio.getState().setShowModelAtSpot(e.target.checked)} />
          <span><strong>Show models at build spots in viewport</strong><small>Display each placed main model or submodel on its own build footprint while editing. Final brick connections remain unchanged; the video still uses the chosen build spots.</small></span>
        </label>
        <label className="bm-spot-follow">
          <input type="checkbox" checked={plan.loosePiecesFollow !== false} onChange={(e) => useStudio.getState().setFollow(e.target.checked)} />
          <span><strong>Loose pieces follow the model</strong><small>When off, waiting parts stay in the original floor layout during the animation.</small></span>
        </label>
      </div>
      {editingModel && <p className="nx-fine">Submodel editing is local. Main assembly placement applies only to the full set.</p>}
    </div>
  );
}

/** Shared transform editor. Values are in the plan-space studs the planner consumes. */
function SpotEditor({ label, chosen, base, autoNote, onApply, onReset }: {
  label: string;
  chosen: boolean;
  base: AssemblySpot;
  autoNote?: string;
  onApply: (spot: AssemblySpot) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(() => strings(base));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(strings(base)); setInvalid(false); }, [base.x, base.z, base.angle, label]);
  const parsed = { x: Number(draft.x), z: Number(draft.z), angle: Number(draft.angle) };
  const valid = Object.values(draft).every((v) => v.trim() !== '') && Object.values(parsed).every(Number.isFinite);
  const dirty = valid && (parsed.x !== base.x || parsed.z !== base.z || parsed.angle !== base.angle || !chosen);
  const commit = () => {
    if (!valid) { setInvalid(true); return; }
    onApply(parsed);
    setInvalid(false);
  };
  const fields = [
    { axis: 'x' as const, label: 'X POSITION', unit: 'studs', step: 1 },
    { axis: 'z' as const, label: 'Z POSITION', unit: 'studs', step: 1 },
    { axis: 'angle' as const, label: 'Y ROTATION', unit: '°', step: 15 },
  ];
  return (
    <section className="bm-spot-editor" aria-label={`Placement of ${label}`}>
      <div className="bm-spot-editor-head">
        <div><span className="bm-spot-section-title">TRANSFORM</span><strong>{label}</strong></div>
        <span className={`bm-spot-editor-state ${chosen ? 'on' : ''}`}><span />{chosen ? 'Placed' : 'Automatic'}</span>
      </div>
      <div className="bm-spot-fields">
        {fields.map(({ axis, label: fieldLabel, unit, step }) => (
          <label className="bm-spot-number" key={axis}>
            <span>{fieldLabel}</span>
            <div className="bm-spot-number-entry">
              <input type="number" inputMode="decimal" step={step} value={draft[axis]}
                aria-label={`Spot ${fieldLabel.toLowerCase()} in ${unit}`} aria-invalid={invalid && !valid}
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
        <button type="button" className="nx-btn nx-sm" onClick={onReset} disabled={!chosen} title="Remove the manual placement"><Ic name="undo" /> Auto</button>
      </div>
      {!chosen && <p className="nx-fine">{autoNote ?? 'Automatic position available after planning. Applying the fields creates a fixed build spot.'}</p>}
    </section>
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
  return (
    <SpotEditor label={use.label} chosen={!!chosen} base={base}
      autoNote={`Automatic position${auto ? ' detected from the timeline' : ' available after planning'}. Applying the fields creates a fixed build spot.`}
      onApply={(spot) => useStudio.getState().setSpot(use.ref, spot)}
      onReset={() => useStudio.getState().setSpot(use.ref, null)} />
  );
}

function WorkBayFields({ bay }: { bay: WorkBay }) {
  const plan = useStudio((s) => s.plan);
  const chosen = plan.workBaySpots?.[bay.key] ?? null;
  return (
    <SpotEditor label={bay.label} chosen={!!chosen} base={chosen ?? bay.spot}
      autoNote={`Automatic work bay${bay.parts.length ? ` for ${bay.parts.join(', ')}` : ''}. The planner keeps the fixture clear of the table where a joint needs downward withdrawal.`}
      onApply={(spot) => useStudio.getState().setWorkBaySpot(bay.key, spot)}
      onReset={() => useStudio.getState().setWorkBaySpot(bay.key, null)} />
  );
}
