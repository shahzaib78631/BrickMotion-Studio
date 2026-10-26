import { useMemo, useState, type ReactNode } from 'react';
import { searchCatalog } from '../catalog/catalog';
import { resolveColor } from '../ldraw/colors';
import { findItem, modelSteps, moveItems, moveItemsToStep, setColor, setPart } from '../plan/ops';
import { movePartsToModel } from '../plan/crossModel';
import { nextGroupName, setGroup, ungroupSelection } from '../plan/groups';
import { isGrid, isSub } from '../plan/types';
import { DEFAULT_COLOR } from '../model/assemble';
import { runCommand } from '../state/editing';
import { ensureParts, getCatalog, getColors, partName } from '../state/partService';
import type { ModelState } from '../state/useModel';
import { useStudio } from '../state/store';
import type { Timeline } from '../anim/timeline';
import { EditPad } from './EditPad';
import { Ic } from './icons';
import { HelpNote } from './PaneHead';
import { PartThumb } from './PartThumb';
import { viewportApi } from './viewportApi';
import { pieceCount } from './Toolbar';

export function ColorSwatches({ value, onPick }: { value?: number; onPick: (code: number) => void }) {
  const colors = useMemo(() => {
    const all = [...getColors().values()].filter((c) => c.code !== 16 && c.code !== 24 && c.code < 10000);
    const order = { solid: 0, trans: 1, pearl: 2, metal: 2, chrome: 2, rubber: 3 } as const;
    return all.sort((a, b) => order[a.finish] - order[b.finish] || a.name.localeCompare(b.name));
  }, []);
  return <div className="swatches">
    {colors.map((c) => <button key={c.code} className={`swatch ${value === c.code ? 'active' : ''} ${c.finish}`}
      style={{ background: c.hex }} title={`${c.name.replace(/_/g, ' ')} (${c.code})`}
      aria-label={c.name.replace(/_/g, ' ')} onClick={() => onPick(c.code)} />)}
  </div>;
}

function PartPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const results = q.length >= 2 ? searchCatalog(getCatalog(), q, 8) : [];
  return <div className="part-picker">
    <input type="search" placeholder="Search parts to replace…" value={q} onChange={(e) => setQ(e.target.value)} />
    {results.length > 0 && <ul>{results.map((r) => <li key={r.id}><button onClick={() => { onPick(r.id); setQ(''); }}>
      {r.name} <span className="muted">{r.id}</span>
    </button></li>)}</ul>}
  </div>;
}

type InspectorTab = 'selection' | 'part' | 'submodule';

type PartEntry = { part: string; color: number; count: number };

/** The real part thumbnails of a selection: one tile per distinct part + colour,
 * so a multi-part selection shows every part that is selected in the viewport. */
function PartThumbs({ parts, size }: { parts: PartEntry[]; size?: number }) {
  if (!parts.length) return null;
  return <div className={`bm-part-thumbs${parts.length > 1 ? ' many' : ''}`} aria-label="Selected part thumbnails">
    {parts.map((entry) => (
      <figure className="bm-part-thumb" key={`${entry.part}|${entry.color}`} title={`${partName(entry.part)} · ${entry.count}`}>
        <PartThumb id={entry.part} color={entry.color} size={size ?? (parts.length === 1 ? 64 : 40)} />
        {entry.count > 1 && <figcaption>×{entry.count}</figcaption>}
      </figure>
    ))}
  </div>;
}

/** Contextual Selection / Part / Submodule inspector, wired to the original editing engine. */
export function Inspector({ timeline, checks, stepCard, model, onMakeSubmodel }: {
  timeline: Timeline | null;
  checks: number;
  stepCard?: ReactNode;
  model: ModelState;
  onMakeSubmodel(): void;
}) {
  const plan = useStudio((s) => s.plan);
  const selection = useStudio((s) => s.selection);
  const editingModel = useStudio((s) => s.editingModel);
  const paintColor = useStudio((s) => s.paintColor);
  const [tab, setTab] = useState<InspectorTab>('selection');
  const [moveOpen, setMoveOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [moveDraft, setMoveDraft] = useState({ x: '0', y: '0', z: '0' });
  const st = useStudio.getState();
  const ids = selection.model === editingModel ? selection.ids : [];
  const found = ids.map((id) => findItem(plan, editingModel, id))
    .filter((v): v is NonNullable<typeof v> => v !== null);
  const first = found[0]?.item;
  const pieceIds = found.filter((f) => !isSub(f.item)).map((f) => f.item.id!);
  const firstColor = first && !isSub(first) ? resolveColor(getColors(), first.color) : undefined;
  /** Every distinct part in the selection, so multi-select shows all of them. */
  const selectedParts: PartEntry[] = [];
  if (found.some((entry) => !isSub(entry.item))) {
    const byPart = new Map<string, PartEntry>();
    for (const entry of found) {
      if (isSub(entry.item)) continue;
      const raw = entry.item.color;
      const color = raw === 16 || raw === '16' ? DEFAULT_COLOR : (resolveColor(getColors(), raw) ?? DEFAULT_COLOR);
      const key = `${entry.item.part}|${color}`;
      const known = byPart.get(key);
      if (known) known.count++;
      else byPart.set(key, { part: entry.item.part, color, count: 1 });
    }
    selectedParts.push(...byPart.values());
  }
  const singlePart = selectedParts.length === 1 && selectedParts[0].count === 1 ? selectedParts[0] : null;
  const group = first?.assembly?.group;
  const steps = modelSteps(plan, editingModel);
  const selectedSub = first && isSub(first) ? first.submodel : editingModel;
  const submodels = Object.keys(plan.submodels ?? {});
  const pickColor = (code: number) => { st.apply((p) => setColor(p, editingModel, pieceIds, code)); st.setPaintColor(code); };
  const extractTo = (name: string) => {
    if (!ids.length || name === editingModel) return;
    const result = movePartsToModel(useStudio.getState().plan, model.assembly, {
      from: editingModel, to: name, ids, step: modelSteps(useStudio.getState().plan, name).length,
    });
    if ('error' in result) return alert(result.error);
    st.apply(() => result.plan);
    st.setEditingModel(name);
    st.select(result.moved);
    setMoveOpen(false);
  };
  const groupSelected = () => {
    if (ids.length < 2) return;
    st.apply((p) => setGroup(p, editingModel, ids, nextGroupName(p, editingModel)));
  };
  const commitMove = (direction: 'x' | 'y' | 'z') => {
    const delta = Number(moveDraft[direction]);
    if (Number.isFinite(delta) && delta !== 0 && ids.length) {
      st.apply((p) => moveItems(p, editingModel, ids, {
        x: direction === 'x' ? delta : 0,
        y: direction === 'y' ? delta : 0,
        z: direction === 'z' ? delta : 0,
      }));
    }
    setMoveDraft((draft) => ({ ...draft, [direction]: '0' }));
  };
  const axis = (label: 'X' | 'Y' | 'Z', direction: 'x' | 'y' | 'z') => <label className="bm-axis-field" key={direction}>
    <span>{label}</span>
    <input type="number" step={1} aria-label={`Move selected parts by ${label} (relative)`}
      value={moveDraft[direction]}
      onChange={(e) => setMoveDraft((draft) => ({ ...draft, [direction]: e.target.value }))}
      onBlur={() => commitMove(direction)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') { setMoveDraft((draft) => ({ ...draft, [direction]: '0' })); e.currentTarget.blur(); }
      }} />
  </label>;

  return <aside className="nx-inspector bm-reference-inspector" aria-label="Inspector">
    <div className="bm-inspector-tabs" role="tablist" aria-label="Inspector views">
      <button role="tab" aria-selected={tab === 'selection'} className={tab === 'selection' ? 'active' : ''} onClick={() => setTab('selection')}>
        Selection <span className="bm-tab-count">({ids.length})</span>
      </button>
      <button role="tab" aria-selected={tab === 'part'} className={tab === 'part' ? 'active' : ''} onClick={() => setTab('part')}>Part</button>
      <button role="tab" aria-selected={tab === 'submodule'} className={tab === 'submodule' ? 'active' : ''} onClick={() => setTab('submodule')}>Submodule</button>
    </div>
    <div className="bm-inspector-scroll">
      {tab === 'selection' && <>
        <div className={`bm-selection-summary ${ids.length ? 'has-pieces' : ''}`}>
          <div className="bm-summary-icon"><Ic name={ids.length ? 'components' : 'pointer'} /></div>
          <div className="bm-summary-text">
            <strong>{ids.length ? `${ids.length} ${ids.length === 1 ? 'part' : 'parts'} selected` : 'Nothing selected'}</strong>
            <span>{ids.length ? `${new Set(found.map((f) => f.step)).size} build ${new Set(found.map((f) => f.step)).size === 1 ? 'step' : 'steps'} · ${new Set(found.map((f) => f.item.assembly?.group).filter(Boolean)).size} marks` : 'Click a part in the viewport to inspect it'}</span>
          </div>
          {ids.length > 0 && <button className="nx-icon" aria-label="Clear selection" title="Clear selection" onClick={() => st.select([])}><Ic name="x" /></button>}
        </div>
        {ids.length > 0 ? <>
          <section className="bm-inspector-section">
            <h4>Actions</h4>
            <div className="bm-selection-actions">
              <button className="bm-action-primary" disabled={ids.length < 2} onClick={onMakeSubmodel}><Ic name="box" /> Make Submodule <kbd>⌘G</kbd></button>
              <button onClick={() => extractTo('')} disabled={!editingModel}><Ic name="upload" /> Extract to Parent</button>
              <div className="bm-select-action-wrap">
                <button onClick={() => setMoveOpen((o) => !o)} aria-expanded={moveOpen}><Ic name="moveHere" /> Move to… <Ic name="right" /></button>
                {moveOpen && <div className="bm-inspector-dropdown" role="menu">
                  {['', ...submodels].filter((m) => m !== editingModel).map((name) => <button role="menuitem" key={name} onClick={() => extractTo(name)}><Ic name="box" /> {name || 'Main model'}</button>)}
                  {submodels.length === 0 && editingModel === '' && <p>No other models yet. Create a submodule first.</p>}
                </div>}
              </div>
              <div className="bm-inline-actions">
                <button disabled={ids.length < 2} onClick={groupSelected}><Ic name="components" /> Group</button>
                <button disabled={!group} onClick={() => st.apply((p) => ungroupSelection(p, editingModel, ids))}><Ic name="x" /> Ungroup</button>
              </div>
              <div className="bm-inline-actions">
                <button onClick={() => runCommand({ kind: 'duplicate' })}><Ic name="copy" /> Duplicate <kbd>⌘D</kbd></button>
                <button className="danger" onClick={() => runCommand({ kind: 'delete' })}><Ic name="trash" /> Delete</button>
              </div>
            </div>
          </section>
          <section className="bm-inspector-section">
            <h4>Marks (Tags) <button className="bm-section-plus" title="Add a mark to selected parts" aria-label="Add a mark" onClick={() => setTagOpen((x) => !x)}><Ic name="plus" /></button></h4>
            <div className="bm-tags">
              {group ? <button className="bm-tag" title="Remove this mark" onClick={() => st.apply((p) => ungroupSelection(p, editingModel, ids))}>{group} <Ic name="x" /></button>
                : <span className="bm-tag-placeholder">No marks on this selection</span>}
            </div>
            {tagOpen && <div className="bm-tag-entry"><input aria-label="New tag name" placeholder="New mark name" id="bm-add-tag-input" onKeyDown={(e) => {
              if (e.key === 'Enter') { const name = e.currentTarget.value.trim(); if (name) { st.apply((p) => setGroup(p, editingModel, ids, name)); setTagOpen(false); } }
              if (e.key === 'Escape') setTagOpen(false);
            }} /> <button onClick={() => { const el = document.getElementById('bm-add-tag-input') as HTMLInputElement; const name = el?.value.trim(); if (name) { st.apply((p) => setGroup(p, editingModel, ids, name)); setTagOpen(false); } }}>Add</button></div>}
            <label className="bm-select-by-tag">Select by mark <select aria-label="Select by mark" value="" onChange={(e) => {
              const name = e.target.value;
              if (name) st.select(steps.flatMap((s) => s.pieces.filter((p) => p.id && p.assembly?.group === name).map((p) => p.id!)));
            }}><option value="">Choose a mark…</option>
              {[...new Set(steps.flatMap((s) => s.pieces.map((p) => p.assembly?.group).filter((v): v is string => !!v)))].map((name) => <option key={name}>{name}</option>)}
            </select></label>
          </section>
          <section className="bm-inspector-section">
            <h4>Transform <small>(relative)</small></h4>
            <div className="bm-transform-row"><span>Move</span><div className="bm-axis-group">{axis('X', 'x')}{axis('Y', 'y')}{axis('Z', 'z')}</div></div>
            <div className="bm-transform-row"><span>Rotate</span><div className="bm-axis-group">
              <label className="bm-axis-field"><span>X</span><button title="For arbitrary axis rotation, use the viewport gizmo" onClick={() => st.setGizmoMode('rotate')}>0°</button></label>
              <label className="bm-axis-field"><span>Y</span><button title="Rotate by 90 degrees" onClick={() => runCommand({ kind: 'rotate' })}>{first && isGrid(first) && ids.length === 1 ? first.rot : 0}°</button></label>
              <label className="bm-axis-field"><span>Z</span><button title="For arbitrary axis rotation, use the viewport gizmo" onClick={() => st.setGizmoMode('rotate')}>0°</button></label>
            </div></div>
            <button className="bm-more-link" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>{moreOpen ? 'Less' : 'More…'}</button>
            {moreOpen && <div className="bm-inspector-more"><EditPad azimuth={() => ((viewportApi.controls?.getAzimuthalAngle() ?? 0) * 180) / Math.PI} />
              <label className="nx-field">Build step<select value={found[0]?.step ?? 0} onChange={(e) => st.apply((p) => moveItemsToStep(p, editingModel, ids, Number(e.target.value)))}>
                {steps.map((_, i) => <option key={i} value={i}>Step {i + 1}</option>)}
              </select></label></div>}
          </section>
          <section className="bm-inspector-section bm-info-collapsible">
            <button className="bm-collapse-heading" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((o) => !o)}>Part info <Ic name="chevron" /></button>
            {detailsOpen && <div className="bm-part-meta">
              {singlePart ? <>
                <div className="bm-part-heading">
                  <PartThumb id={singlePart.part} color={singlePart.color} size={56} />
                  <div><strong>{partName(singlePart.part)}</strong><small>{getColors().get(singlePart.color)?.name.replace(/_/g, ' ')}</small></div>
                </div>
                <span>Part ID: {singlePart.part}</span>
              </> : <>
                <PartThumbs parts={selectedParts} size={38} />
                <p>{selectedParts.length} distinct {selectedParts.length === 1 ? 'part' : 'parts'} · {pieceIds.length} pieces selected</p>
              </>}
              <span>Selected model: {editingModel || 'Main model'}</span>
              <span>Step: {(found[0]?.step ?? 0) + 1}</span>
            </div>}
          </section>
        </> : <>
          <div className="bm-empty-inspector">
            <div className="bm-empty-selection-illustration"><Ic name="box" /><span className="dot one"/><span className="dot two"/></div>
            <strong>Select a part to get started</strong>
            <p>Click pieces on the canvas, or hold Shift to select multiple parts and create submodules.</p>
            <button className="nx-btn nx-sm" onClick={() => st.select(steps.flatMap((s) => s.pieces.map((p) => p.id).filter((id): id is string => !!id)))}><Ic name="components" /> Select all parts</button>
          </div>
          <div className="bm-inspector-section bm-project-stats"><h4>Model overview</h4>
            <div className="nx-stat"><div><b>{pieceCount(plan)}</b><small>Parts</small></div><div><b>{steps.length}</b><small>Steps</small></div>
              <div><b>{submodels.length}</b><small>Submodules</small></div><div><b>{timeline ? timeline.duration.toFixed(1) + 's' : '—'}</b><small>Duration</small></div></div>
            {checks > 0 && <p className="bm-inspector-warning">{checks} model checks to review</p>}
          </div>
        </>}
      </>}
      {tab === 'part' && <>
        {pieceIds.length ? <div className="bm-inspector-section">
          {selectedParts.length > 1 && <PartThumbs parts={selectedParts} />}
          <div className="bm-part-heading">
            {singlePart ? <PartThumb id={singlePart.part} color={singlePart.color} size={46} />
              : <span className="bm-part-heading-icon"><Ic name="brick" /></span>}
            <div><strong>{singlePart ? partName(singlePart.part) : 'Multiple parts'}</strong><small>{singlePart ? singlePart.part : `${pieceIds.length} pieces · ${selectedParts.length} types`}</small></div>
          </div>
          {pieceIds.length === 1 && <><h4>Replace part</h4><PartPicker onPick={async (id) => { await ensureParts([id]); st.apply((p) => setPart(p, editingModel, pieceIds, id)); }} /></>}
          <h4>Part color {firstColor !== undefined && <small>{getColors().get(firstColor)?.name.replace(/_/g, ' ')}</small>}</h4>
          <ColorSwatches value={firstColor} onPick={pickColor} />
          <label className="nx-field">Step<select value={found[0]?.step ?? 0} onChange={(e) => st.apply((p) => moveItemsToStep(p, editingModel, ids, Number(e.target.value)))}>{steps.map((_, i) => <option key={i} value={i}>Step {i + 1}</option>)}</select></label>
        </div> : <div className="bm-empty-inspector"><Ic name="brick" /><strong>No part selected</strong><p>Select a brick in the viewport to change its geometry, color or build step.</p>
          <h4>Color for new parts</h4><ColorSwatches value={resolveColor(getColors(), paintColor)} onPick={(c) => st.setPaintColor(c)} /></div>}
      </>}
      {tab === 'submodule' && <div className="bm-inspector-section">
        <div className="bm-part-heading"><span className="bm-part-heading-icon"><Ic name="box" /></span><div><strong>{selectedSub || 'Main model'}</strong><small>{selectedSub && plan.submodels?.[selectedSub] ? `${modelSteps(plan, selectedSub).length} build steps` : 'Model structure'}</small></div></div>
        {selectedSub && plan.submodels?.[selectedSub] && <button className="nx-btn bm-inspector-open-model" onClick={() => st.setEditingModel(selectedSub)}><Ic name="edit" /> Open submodule</button>}
        <h4>Structure</h4><div className="bm-structure-list"><button onClick={() => st.setEditingModel('')} className={!editingModel ? 'current' : ''}><Ic name="brick" /> Main model</button>
          {submodels.map((name) => <button key={name} className={editingModel === name ? 'current' : ''} onClick={() => st.setEditingModel(name)}><Ic name="box" /> {name}<Ic name="right" /></button>)}
        </div>
        {ids.length >= 2 && <button className="nx-btn nx-primary" onClick={onMakeSubmodel}><Ic name="plus" /> Make submodule from selection</button>}
      </div>}
      {stepCard && <div className="bm-step-card-container"><details><summary>Current build step <Ic name="chevron" /></summary>{stepCard}</details></div>}
      <HelpNote id="inspector">Select with click or Shift-click. Use the viewport gizmo to manipulate the parts directly. All edits support Undo and are saved to this project.</HelpNote>
    </div>
  </aside>;
}
