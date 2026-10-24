import { useMemo } from 'react';
import type { Timeline } from '../anim/timeline';
import { autoCentre, footprints, formatSpot, isMainSpot, overlaps, spotOf, submodelUses, type SpotRef, type SpotUse } from '../plan/assemblySpots';
import type { ModelState } from '../state/useModel';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { PaneHead } from './PaneHead';

/** What the Assembly panel and the toolbar put on a dragged spot tile. */
export const SPOT_DRAG_TYPE = 'application/x-brickmotion-spot';

const refKey = (r: SpotRef) => `${r.model}\u0000${r.id}`;

function startSpotDrag(ev: React.DragEvent, ref: SpotRef) {
  ev.dataTransfer.setData(SPOT_DRAG_TYPE, JSON.stringify(ref));
  ev.dataTransfer.effectAllowed = 'copy';
}

/** Ref of the tile dragged off a drop target (the custom type survives `dragover`). */
export function draggedSpot(ev: React.DragEvent): SpotRef | null {
  const raw = ev.dataTransfer.getData(SPOT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const ref = JSON.parse(raw) as SpotRef;
    return ref && typeof ref.model === 'string' && typeof ref.id === 'string' ? ref : null;
  } catch {
    return null;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * The Assembly tab: one tile per model — the main model first, then each submodel use in
 * build order. Drag a tile onto the viewport floor to place its spot, or edit its numbers.
 */
export function AssemblyPanel({ model, timeline }: { model: ModelState; timeline: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const selected = useStudio((s) => s.spot);
  const uses = useMemo(() => submodelUses(plan), [plan]);
  const conflicts = useMemo(
    () => (model.ready ? overlaps(footprints(plan, model.assembly, timeline)) : []),
    [plan, model.assembly, model.ready, timeline],
  );
  const bad = useMemo(() => new Set(conflicts.flatMap((c) => [refKey(c.ref), refKey(c.other)])), [conflicts]);
  const st = useStudio.getState;
  const select = (use: SpotUse) => st().selectSpot(use.ref);

  const tile = (use: SpotUse) => {
    const spot = spotOf(plan, use);
    const sel = selected ? refKey(selected) === refKey(use.ref) : false;
    return (
      <li key={refKey(use.ref)} className={`bm-spot-row ${sel ? 'active' : ''} ${bad.has(refKey(use.ref)) ? 'bad' : ''}`} style={{ marginLeft: use.depth * 14 }}>
        <button
          className="bm-spot-main"
          aria-current={sel}
          title={`${use.label} — ${spot ? formatSpot(spot) : 'Auto'}. Click to select, or drag onto the floor to place it.`}
          onClick={() => select(use)}
          draggable
          onDragStart={(ev) => startSpotDrag(ev, use.ref)}
        >
          <Ic name={isMainSpot(use.ref) ? 'brick' : 'box'} />
          <span className="bm-spot-text">
            <strong>{use.label}</strong>
            <span className="nx-hint">
              {spot ? formatSpot(spot) : 'Auto'}
              {bad.has(refKey(use.ref)) && <span className="bm-spot-bad"> · overlaps another spot</span>}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const current = selected && uses.find((u) => refKey(u.ref) === refKey(selected));
  return (
    <div className="nx-pane bm-assembly">
      <PaneHead
        id="assembly"
        title="Assembly"
        count={uses.length}
        help="Each model is built where its spot says. Click a tile to select it, drag it onto the floor to choose the spot, or type its X, Z and facing. A model left on Auto is placed automatically, as before. Spots are saved in the project."
      />
      <ul className="bm-spots" aria-label="Assembly spots">
        {uses.map(tile)}
      </ul>
      {current && <SpotFields model={model} use={current} timeline={timeline} />}
      {!current && <p className="nx-hint">Select a model to edit its spot, or drag a tile onto the viewport floor.</p>}
      {editingModel && <p className="nx-fine">Editing a submodel on its own: the main spot applies to the whole set.</p>}
    </div>
  );
}

function SpotFields({ model, use, timeline }: { model: ModelState; use: SpotUse; timeline: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const spot = spotOf(plan, use);
  const auto = autoCentre(timeline ?? null, use);
  const base = spot ?? { x: round((auto?.[0] ?? 0) / 20), z: round((auto?.[1] ?? 0) / 20), angle: 0 };
  const st = useStudio.getState;
  const commit = (patch: Partial<typeof base>) => st().setSpot(use.ref, { ...base, ...patch });
  const main = isMainSpot(use.ref);
  return (
    <div className="bm-spot-editor">
      <div className="nx-sub">
        {use.label}
        <span className="nx-count">{spot ? 'Placed' : 'Auto'}</span>
      </div>
      <div className="bm-spot-fields">
        <label className="nx-field">
          X <b>{base.x}</b>
          <input type="number" step={1} value={base.x} onChange={(e) => Number.isFinite(Number(e.target.value)) && commit({ x: Number(e.target.value) })} aria-label="Spot X in studs" />
        </label>
        <label className="nx-field">
          Z <b>{base.z}</b>
          <input type="number" step={1} value={base.z} onChange={(e) => Number.isFinite(Number(e.target.value)) && commit({ z: Number(e.target.value) })} aria-label="Spot Z in studs" />
        </label>
        <label className="nx-field">
          Facing <b>{base.angle}°</b>
          <input type="number" step={15} value={base.angle} onChange={(e) => Number.isFinite(Number(e.target.value)) && commit({ angle: Number(e.target.value) })} aria-label="Spot facing in degrees" />
        </label>
      </div>
      <div className="bm-spot-actions">
        <button className="nx-btn nx-sm" disabled={!spot} onClick={() => st().setSpot(use.ref, null)}>
          <Ic name="undo" /> Reset to auto
        </button>
      </div>
      {main && (
        <label className="nx-check" title="Off: the loose pieces stay where the automatic layout put them, and only the build spot moves.">
          <input type="checkbox" checked={plan.loosePiecesFollow !== false} onChange={(e) => st().setFollow(e.target.checked)} />
          Loose pieces move with the model
        </label>
      )}
      {model.ready && model.assembly.instances.length === 0 && <p className="nx-hint">This model has no parts yet.</p>}
    </div>
  );
}

/** The compact strip over the viewport in Build view: the same spots as chips, drag them onto the floor. */
export function AssemblyToolbar({ timeline }: { timeline: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const selected = useStudio((s) => s.spot);
  const uses = useMemo(() => submodelUses(plan), [plan]);
  const st = useStudio.getState;
  if (editingModel) return null;
  return (
    <div className="bm-spot-bar" role="toolbar" aria-label="Assembly spots">
      <span className="bm-spot-bar-title">
        <Ic name="box" /> Assembly
      </span>
      <div className="bm-spot-bar-chips">
        {uses.map((use) => {
          const spot = spotOf(plan, use);
          const sel = selected ? refKey(selected) === refKey(use.ref) : false;
          return (
            <button
              key={refKey(use.ref)}
              type="button"
              className={`bm-spot-chip ${sel ? 'sel' : ''} ${spot ? 'placed' : 'auto'}`}
              aria-pressed={sel}
              title={`${use.label} — ${spot ? formatSpot(spot) : 'Auto'}. Drag onto the floor, or click to select.`}
              draggable
              onDragStart={(ev) => startSpotDrag(ev, use.ref)}
              onClick={() => st().selectSpot(use.ref)}
            >
              {use.label}
              <span className="bm-spot-chip-state">{spot ? 'placed' : 'Auto'}</span>
            </button>
          );
        })}
      </div>
      <span className="bm-spot-bar-hint">{timeline ? 'Drag a chip onto the floor' : 'Planning…'}</span>
    </div>
  );
}
