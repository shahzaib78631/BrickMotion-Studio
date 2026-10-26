import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { inlineSubmodelUse, movePartsToModel } from '../plan/crossModel';
import { createSubmodel } from '../plan/createSubmodel';
import { nextGroupName, setGroup, ungroupSelection } from '../plan/groups';
import { modelFrames } from '../plan/modelFrames';
import { findItem, modelSteps } from '../plan/ops';
import { movePiecesToNewStep, movePiecesToStep } from '../plan/pieceActions';
import { getColors, partName } from '../state/partService';
import { useStudio } from '../state/store';
import type { ModelState } from '../state/useModel';
import { Ic } from './icons';
import { NewSubmodelDialog } from './NewSubmodelDialog';
import { PartThumb } from './PartThumb';
import { stepParts } from './StepCallout';

const label = (name: string) => name || 'Main model';

/** Cross-surface drag of part rows, following the same custom-MIME convention as
 * `PART_DRAG_TYPE` in PartsPanel: the payload names the source model and the ids. */
export const PARTS_DRAG_TYPE = 'application/x-brickmotion-parts';
type DragPayload = { model: string; ids: string[] };

/** Where a dropped row lands. `sameModel` reuses the step op, which also drops a
 * step the move empties; everything else crosses a model frame. */
type DropSpot = { key: string; to: string; step: number; viaUse?: string; sameModel: boolean };

/**
 * Every part of one model (or submodel), as a bulk-editing surface: tick parts to
 * group them, turn them into a submodel, or move them to another step. Rows are
 * grouped by part and colour like a printed step's part callout; a row expands to
 * its individual instances when one of several identical pieces must be singled
 * out. Rows can be dragged onto a step, a submodel row or a breadcrumb crumb, and
 * a submodel use can be extracted into the model that places it.
 */
export function PartsDialog({ model, onClose }: { model: ModelState; onClose(): void }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  // Drill trail for the breadcrumb. The plan does not record nesting, so the
  // path the user took is kept here; opening a model is the app's normal edit scope.
  const [trail, setTrail] = useState<string[]>([editingModel]);
  const [selected, setSelected] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [naming, setNaming] = useState(false);
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => { dialog.current?.focus(); }, []);

  const steps = modelSteps(plan, editingModel);
  const groups = steps.map((step) => stepParts(step));
  const colors = getColors();
  const picked = useMemo(() => new Set(selected), [selected]);
  const dragging = useMemo(() => new Set(drag?.ids ?? []), [drag]);
  const anyGrouped = selected.some((id) => !!findItem(plan, editingModel, id)?.item.assembly?.group);
  /** Models that accept a drop: everything placed in the set except the one shown. */
  const otherModels = useMemo(
    () => [...modelFrames(model.assembly).keys()].filter((name) => name !== editingModel),
    [model.assembly, editingModel],
  );
  /** Submodels this model places, with the first use's id for an exact transform. */
  const placedSubmodels = useMemo(() => {
    const out = new Map<string, string>();
    for (const entry of groups.flat()) {
      if (entry.submodel && entry.ids[0] && !out.has(entry.submodel)) out.set(entry.submodel, entry.ids[0]);
    }
    return out;
  }, [groups]);

  /** The dialog's ticks and the viewport selection are one thing: the store's
   * selection drives the highlight and framing, so every change is pushed there. */
  const applySelection = (next: Iterable<string>) => {
    const list = [...new Set(next)];
    setSelected(list);
    useStudio.getState().select(list);
  };
  const setPicked = (ids: string[], on: boolean) => {
    const next = new Set(picked);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    applySelection(next);
    if (on && ids.length) useStudio.getState().requestFocus(ids);
  };
  const allPicked = (ids: string[]) => ids.length > 0 && ids.every((id) => picked.has(id));
  const somePicked = (ids: string[]) => !allPicked(ids) && ids.some((id) => picked.has(id));

  /** Opening a model is how the app scopes selection and assembling; the parts
   * list follows it, so a drilled submodel browses its own parts. */
  const showModel = (name: string) => {
    useStudio.getState().setEditingModel(name);
    setSelected([]);
  };
  const drill = (submodel: string) => {
    setTrail([...trail, submodel]);
    showModel(submodel);
  };
  const goTo = (index: number) => {
    if (index >= trail.length - 1) return;
    const name = trail[index];
    setTrail(trail.slice(0, index + 1));
    showModel(name);
  };
  /** Keep the breadcrumb in step with a cross-model move: pop to an ancestor, push a child. */
  const follow = (target: string) => {
    const at = trail.indexOf(target);
    setTrail(at >= 0 ? trail.slice(0, at + 1) : [...trail, target]);
  };

  const canEdit = model.ready;
  const lastStep = (name: string) => Math.max(0, modelSteps(useStudio.getState().plan, name).length - 1);

  const group = () => {
    const st = useStudio.getState();
    const name = nextGroupName(st.plan, editingModel);
    st.apply((p) => setGroup(p, editingModel, selected, name));
    st.select(selected);
  };
  const ungroup = () => {
    const st = useStudio.getState();
    st.apply((p) => ungroupSelection(p, editingModel, selected));
    st.select(selected);
  };

  /** Cross-model move, then follow the parts so they stay selected and visible. */
  const crossMove = (payload: DragPayload, spot: DropSpot) => {
    setNotice('');
    const st = useStudio.getState();
    const result = movePartsToModel(st.plan, model.assembly, {
      from: payload.model, to: spot.to, ids: payload.ids, step: spot.step, viaUse: spot.viaUse,
    });
    if ('error' in result) { setNotice(result.error); return; }
    st.apply(() => result.plan);
    // The selection is model-scoped, so follow the parts into their new model.
    st.setEditingModel(spot.to);
    st.select(result.moved);
    st.setCurrentStep(result.step);
    setSelected(result.moved);
    follow(spot.to);
  };

  /** Move to an existing step, a new step, a submodel, or another model. */
  const moveTo = (value: string) => {
    setNotice('');
    const st = useStudio.getState();
    if (!selected.length) return;
    if (value === 'new' || value.startsWith('step:')) {
      const moved = value === 'new'
        ? movePiecesToNewStep(st.plan, editingModel, selected, modelSteps(st.plan, editingModel).length)
        : movePiecesToStep(st.plan, editingModel, selected, Number(value.slice(5)));
      st.apply(() => moved.plan);
      st.setCurrentStep(moved.step);
      st.select(selected);
      return;
    }
    const payload = { model: editingModel, ids: selected };
    if (value.startsWith('sub:')) {
      const submodel = value.slice(4);
      crossMove(payload, { key: '', to: submodel, step: lastStep(submodel), viaUse: placedSubmodels.get(submodel), sameModel: false });
      return;
    }
    if (value.startsWith('model:')) {
      const target = value.slice(6);
      crossMove(payload, { key: '', to: target, step: lastStep(target), sameModel: false });
    }
  };

  const makeSubmodel = (name: string, ids: string[]): boolean => {
    const st = useStudio.getState();
    if (st.editingModel !== editingModel || !model.ready) return false;
    const result = createSubmodel(st.plan, editingModel, ids, model.view.nodes, name);
    if (!result) return false;
    st.apply(() => result.plan);
    st.select([result.referenceId]);
    st.setCurrentStep(null);
    setSelected([result.referenceId]);
    return true;
  };

  /** Replace one submodel use with its parts, in place. */
  const extractAll = (useId: string) => {
    setNotice('');
    const st = useStudio.getState();
    const result = inlineSubmodelUse(st.plan, model.assembly, editingModel, useId);
    if ('error' in result) { setNotice(result.error); return; }
    st.apply(() => result.plan);
    st.select(result.moved);
    st.setCurrentStep(result.step);
    setSelected(result.moved);
  };

  const readDrag = (e: DragEvent): DragPayload | null => {
    try {
      const raw = e.dataTransfer.getData(PARTS_DRAG_TYPE);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as DragPayload;
      return Array.isArray(parsed?.ids) && parsed.ids.length && typeof parsed.model === 'string' ? parsed : null;
    } catch {
      return null;
    }
  };
  /** Dragging a row that is part of the selection carries the whole selection. */
  const startDrag = (e: DragEvent, ids: string[]) => {
    const chosen = ids.some((id) => picked.has(id)) ? selected : ids;
    if (!chosen.length) { e.preventDefault(); return; }
    if (!ids.some((id) => picked.has(id))) applySelection(chosen);
    const payload: DragPayload = { model: editingModel, ids: chosen };
    e.dataTransfer.setData(PARTS_DRAG_TYPE, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    setDrag(payload);
    setNotice('');
  };
  const dropZone = (spot: DropSpot) => ({
    onDragOver: (e: DragEvent) => {
      if (!readDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(spot.key);
    },
    onDragLeave: () => setOver((current) => (current === spot.key ? null : current)),
    onDrop: (e: DragEvent) => {
      const payload = readDrag(e);
      if (!payload) return;
      e.preventDefault();
      setOver(null);
      setDrag(null);
      const st = useStudio.getState();
      const ids = payload.ids.filter((id) => !!findItem(st.plan, payload.model, id));
      if (!ids.length) return;
      if (spot.sameModel && payload.model === spot.to) {
        const moved = movePiecesToStep(st.plan, spot.to, ids, spot.step);
        st.apply(() => moved.plan);
        st.setCurrentStep(moved.step);
        st.select(ids);
        return;
      }
      crossMove({ ...payload, ids }, spot);
    },
    className: over === spot.key ? ' bm-parts-over' : '',
  });

  const total = steps.reduce((n, step) => n + step.pieces.length, 0);

  return (
    <div className="bm-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} className="bm-parts-dialog" role="dialog" aria-modal="true"
        aria-label={`Parts of ${label(editingModel)}`}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
        <div className="bm-parts-top">
          <span className="bm-submodel-dialog-icon"><Ic name="parts" /></span>
          <div className="bm-parts-heading">
            <h3>Parts — {label(editingModel)}</h3>
            <nav className="bm-parts-crumbs" aria-label="Model path">
              {trail.map((name, i) => (
                <span key={`${name}:${i}`}
                  {...(i < trail.length - 1
                    ? dropZone({ key: `crumb:${i}`, to: name, step: lastStep(name), sameModel: false })
                    : {})}>
                  {i > 0 && <span aria-hidden="true"> › </span>}
                  <button type="button" className="nx-link" disabled={i === trail.length - 1}
                    onClick={() => goTo(i)}>{label(name)}</button>
                </span>
              ))}
            </nav>
          </div>
          <button type="button" className="nx-icon" title="Close" aria-label="Close" onClick={onClose}><Ic name="x" /></button>
        </div>

        {notice && <p className="nx-hint bm-parts-notice" role="alert">{notice}</p>}

        {!model.ready ? (
          <p className="nx-hint" role="status">Loading the parts of {label(editingModel)}…</p>
        ) : total === 0 ? (
          <p className="nx-hint">This model has no parts yet. Add pieces or steps first.</p>
        ) : (
          <ul className="bm-parts-list" aria-label={`Steps and parts of ${label(editingModel)}`}>
            {steps.map((step, si) => {
              const stepIds = groups[si].flatMap((entry) => entry.ids);
              const shut = collapsed.has(si);
              const zone = dropZone({ key: `step:${si}`, to: editingModel, step: si, sameModel: true });
              return (
                <li key={si} className={`bm-parts-step${zone.className}`}
                  onDragOver={zone.onDragOver} onDragLeave={zone.onDragLeave} onDrop={zone.onDrop}>
                  <div className="bm-parts-step-head">
                    <button type="button" className="nx-icon" aria-expanded={!shut}
                      aria-label={`${shut ? 'Show' : 'Hide'} step ${si + 1}`}
                      onClick={() => setCollapsed((prev) => {
                        const next = new Set(prev);
                        shut ? next.delete(si) : next.add(si);
                        return next;
                      })}><Ic name={shut ? 'right' : 'chevron'} /></button>
                    <span className="bm-parts-step-name">Step {si + 1}</span>
                    <span className="nx-hint">{step.pieces.length} {step.pieces.length === 1 ? 'part' : 'parts'}</span>
                    {stepIds.length > 0 && (
                      <label className="nx-check bm-parts-step-pick">
                        <input type="checkbox" checked={allPicked(stepIds)}
                          ref={(el) => { if (el) el.indeterminate = somePicked(stepIds); }}
                          onChange={(e) => setPicked(stepIds, e.currentTarget.checked)}
                          aria-label={`Select all parts in step ${si + 1}`} />
                        Select all
                      </label>
                    )}
                  </div>
                  {!shut && (
                    <ul className="bm-parts-entries">
                      {groups[si].map((entry) => {
                        const name = entry.part ? partName(entry.part) : `Submodel · ${entry.submodel}`;
                        const all = allPicked(entry.ids);
                        const open = expanded.has(entry.key);
                        const sub = entry.submodel
                          ? dropZone({ key: `sub:${entry.key}`, to: entry.submodel, step: lastStep(entry.submodel), viaUse: entry.ids[0], sameModel: false })
                          : null;
                        const lifted = entry.ids.some((id) => dragging.has(id));
                        return (
                          <li key={entry.key}
                            className={`bm-parts-row${all ? ' sel' : ''}${lifted ? ' dragging' : ''}${sub?.className ?? ''}`}
                            draggable={entry.ids.length > 0}
                            onDragStart={(e) => startDrag(e, entry.ids)}
                            onDragEnd={() => { setDrag(null); setOver(null); }}
                            onDragOver={sub?.onDragOver} onDragLeave={sub?.onDragLeave} onDrop={sub?.onDrop}>
                            <label className="bm-parts-pick">
                              <input type="checkbox" checked={all} disabled={entry.ids.length === 0}
                                ref={(el) => { if (el) el.indeterminate = somePicked(entry.ids); }}
                                onChange={(e) => setPicked(entry.ids, e.currentTarget.checked)}
                                aria-label={`Select ${name} (${entry.count})`} />
                              {entry.part
                                ? <PartThumb id={entry.part} color={entry.color} size={26} />
                                : <span className="bm-parts-sub-icon"><Ic name="components" /></span>}
                              <span className="bm-parts-name">{name}</span>
                              {entry.ids.length === 0 && <span className="nx-hint">no id — save the project first</span>}
                              <span className="bm-parts-dot" style={{ background: colors.get(entry.color)?.hex }} aria-hidden="true" />
                              <span className="bm-parts-count">×{entry.count}</span>
                            </label>
                            {entry.count > 1 && (
                              <button type="button" className="nx-icon" aria-expanded={open}
                                aria-label={`${open ? 'Hide' : 'Show'} the ${entry.count} individual ${name} pieces`}
                                onClick={() => setExpanded((prev) => {
                                  const next = new Set(prev);
                                  open ? next.delete(entry.key) : next.add(entry.key);
                                  return next;
                                })}><Ic name={open ? 'chevron' : 'right'} /></button>
                            )}
                            {entry.submodel && (
                              <>
                                <button type="button" className="nx-btn nx-sm"
                                  aria-label={`Open ${entry.submodel}`}
                                  onClick={() => drill(entry.submodel!)}>Open</button>
                                <button type="button" className="nx-btn nx-sm"
                                  aria-label={`Extract ${entry.submodel} into ${label(editingModel)}`}
                                  title="Replace this use with its parts"
                                  onClick={() => extractAll(entry.ids[0])}>Extract all</button>
                              </>
                            )}
                            {open && (
                              <ul className="bm-parts-instances">
                                {entry.ids.map((id) => (
                                  <li key={id}>
                                    <label className="bm-parts-pick">
                                      <input type="checkbox" checked={picked.has(id)}
                                        onChange={(e) => setPicked([id], e.currentTarget.checked)}
                                        aria-label={`Select piece ${id}`} />
                                      <span className="bm-parts-id">{id}</span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="bm-parts-actions">
          <span className="nx-hint" role="status">
            {selected.length ? `${selected.length} selected` : 'Tick or drag parts to group, submodel or move them'}
          </span>
          {selected.length > 0 && (
            <button type="button" className="nx-link" onClick={() => applySelection([])}>Clear</button>
          )}
          <span className="bm-parts-spacer" />
          <button type="button" className="nx-btn" disabled={!canEdit || selected.length < 2} onClick={group}>
            <Ic name="components" /> Group
          </button>
          <button type="button" className="nx-btn" disabled={!canEdit || !anyGrouped} onClick={ungroup}>
            Ungroup
          </button>
          <button type="button" className="nx-btn" disabled={!canEdit || selected.length < 2} onClick={() => setNaming(true)}>
            <Ic name="box" /> Make submodel…
          </button>
          <label className="nx-field bm-parts-move">
            Move to
            <select aria-label="Move selected parts to step" value="" disabled={!canEdit || selected.length === 0}
              onChange={(e) => { moveTo(e.currentTarget.value); e.currentTarget.value = ''; }}>
              <option value="" disabled>Step…</option>
              {steps.map((_, i) => (
                <option key={i} value={`step:${i}`}>Step {i + 1}</option>
              ))}
              <option value="new">New step</option>
              {[...placedSubmodels.keys()].map((name) => (
                <option key={`sub:${name}`} value={`sub:${name}`}>→ {name} (submodel)</option>
              ))}
              {otherModels.map((name) => (
                <option key={`model:${name}`} value={`model:${name}`}>→ {label(name)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {naming && (
        <NewSubmodelDialog plan={plan} count={selected.length}
          onClose={() => setNaming(false)}
          onCreate={(name) => makeSubmodel(name, selected)} />
      )}
    </div>
  );
}
