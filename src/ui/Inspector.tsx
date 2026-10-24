import { useMemo, useState, type ReactNode } from 'react';
import { searchCatalog } from '../catalog/catalog';
import { resolveColor } from '../ldraw/colors';
import { findItem, modelSteps, moveItemsToStep, setColor, setPart } from '../plan/ops';
import { isGrid, isSub } from '../plan/types';
import { ensureParts, getCatalog, getColors, partName } from '../state/partService';
import { useStudio } from '../state/store';
import type { Timeline } from '../anim/timeline';
import { EditPad } from './EditPad';
import { Ic } from './icons';
import { HelpNote } from './PaneHead';
import { viewportApi } from './viewportApi';
import { pieceCount } from './Toolbar';

export function ColorSwatches({ value, onPick }: { value?: number; onPick: (code: number) => void }) {
  const colors = useMemo(() => {
    const all = [...getColors().values()].filter((c) => c.code !== 16 && c.code !== 24 && c.code < 10000);
    const order = { solid: 0, trans: 1, pearl: 2, metal: 2, chrome: 2, rubber: 3 } as const;
    return all.sort((a, b) => order[a.finish] - order[b.finish] || a.name.localeCompare(b.name));
  }, []);
  return (
    <div className="swatches">
      {colors.map((c) => (
        <button
          key={c.code}
          className={`swatch ${value === c.code ? 'active' : ''} ${c.finish}`}
          style={{ background: c.hex }}
          title={`${c.name.replace(/_/g, ' ')} (${c.code})`}
          aria-label={c.name.replace(/_/g, ' ')}
          onClick={() => onPick(c.code)}
        />
      ))}
    </div>
  );
}

function PartPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const results = q.length >= 2 ? searchCatalog(getCatalog(), q, 8) : [];
  return (
    <div className="part-picker">
      <input type="search" placeholder="Change part…" value={q} onChange={(e) => setQ(e.target.value)} />
      {results.length > 0 && (
        <ul>
          {results.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => {
                  onPick(r.id);
                  setQ('');
                }}
              >
                {r.name} <span className="muted">{r.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Right-hand inspector: the selected step's card (when given) on top, then the selection's
 * part, colour and step, or the set's numbers when nothing is selected.
 */
export function Inspector({ timeline, checks, stepCard }: { timeline: Timeline | null; checks: number; stepCard?: ReactNode }) {
  const plan = useStudio((s) => s.plan);
  const selection = useStudio((s) => s.selection);
  const editingModel = useStudio((s) => s.editingModel);
  const paintColor = useStudio((s) => s.paintColor);
  const st = useStudio.getState();
  const ids = selection.model === editingModel ? selection.ids : [];
  const found = ids.map((id) => findItem(plan, editingModel, id)).filter((x) => !!x);
  const steps = modelSteps(plan, editingModel);
  const colors = getColors();

  if (found.length === 0) {
    const code = resolveColor(colors, paintColor);
    const subs = Object.keys(plan.submodels ?? {}).length;
    return (
      <aside className="nx-inspector" aria-label="Inspector">
        {stepCard}
        <div className="nx-insp-head">
          <h4>{plan.name || 'Untitled set'}</h4>
        </div>
        <div className="nx-stat">
          <div>
            <b>{pieceCount(plan)}</b>
            <small>Pieces</small>
          </div>
          <div>
            <b>{plan.steps.length}</b>
            <small>Steps</small>
          </div>
          <div>
            <b>{subs}</b>
            <small>Submodels</small>
          </div>
          <div>
            <b>{timeline ? `${timeline.duration.toFixed(1)}s` : '–'}</b>
            <small>Video</small>
          </div>
          <div>
            <b className={checks ? 'bm-bad' : ''}>{checks}</b>
            <small>Checks</small>
          </div>
        </div>
        <div className="nx-sub">Colour for new pieces</div>
        <ColorSwatches value={code} onPick={(c) => st.setPaintColor(c)} />
        <div className="nx-sub">Keys</div>
        <div className="nx-kbd">
          <kbd>Click</kbd>
          <span>Select · Shift adds</span>
          <kbd>← ↑ → ↓</kbd>
          <span>Move one stud</span>
          <kbd>PgUp PgDn</kbd>
          <span>Up or down a plate</span>
          <kbd>R</kbd>
          <span>Rotate</span>
          <kbd>Delete</kbd>
          <span>Remove</span>
          <kbd>A</kbd>
          <span>Select all · Alt+A none</span>
          <kbd>F</kbd>
          <span>Fit the view</span>
          <kbd>⌘Z</kbd>
          <span>Undo</span>
        </div>
      </aside>
    );
  }

  const first = found[0]!.item;
  const pieceIds = found.filter((f) => !isSub(f!.item)).map((f) => f!.item.id!);
  const firstColor = !isSub(first) ? resolveColor(colors, first.color) : undefined;
  const pickColor = (code: number) => {
    st.apply((p) => setColor(p, editingModel, pieceIds, code));
    st.setPaintColor(code);
  };

  return (
    <aside className="nx-inspector" aria-label="Inspector">
      {stepCard}
      {found.length > 1 ? (
        <div className="nx-insp-head">
          <h4>{found.length} pieces selected</h4>
          <button className="nx-icon" aria-label="Clear selection" title="Clear selection" onClick={() => st.select([])}>
            <Ic name="x" />
          </button>
        </div>
      ) : isSub(first) ? (
        <>
          <div className="nx-insp-head">
            <Ic name="box" />
            <h4>Submodel “{first.submodel}”</h4>
          </div>
          <button className="nx-btn" onClick={() => st.setEditingModel(first.submodel)}>
            <Ic name="edit" /> Edit submodel
          </button>
        </>
      ) : (
        <>
          <div className="nx-insp-head">
            <h4>{partName(first.part)}</h4>
            <span className="nx-chip">{first.part}</span>
          </div>
          <div className="nx-sub">Part</div>
          <PartPicker
            onPick={async (id) => {
              await ensureParts([id]);
              st.apply((p) => setPart(p, editingModel, [first.id!], id));
            }}
          />
        </>
      )}
      {pieceIds.length > 0 && (
        <div className="nx-sub">
          Colour{' '}
          {found.length === 1 && !isSub(first) && (
            <span className="nx-hint">{firstColor !== undefined ? colors.get(firstColor)!.name.replace(/_/g, ' ') : `unknown (${String(first.color)})`}</span>
          )}
        </div>
      )}
      {pieceIds.length > 0 && <ColorSwatches value={firstColor} onPick={pickColor} />}
      <label className="nx-field">
        Step
        <select value={found[0]!.step} onChange={(e) => st.apply((p) => moveItemsToStep(p, editingModel, ids, Number(e.target.value)))}>
          {steps.map((_, i) => (
            <option key={i} value={i}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
      {found.length === 1 &&
        (isGrid(first) ? (
          <div className="nx-stat bm-pos">
            <div>
              <b>{first.x}</b>
              <small>X stud</small>
            </div>
            <div>
              <b>{first.z}</b>
              <small>Z stud</small>
            </div>
            <div>
              <b>{first.y}</b>
              <small>Height (plates)</small>
            </div>
            <div>
              <b>{first.rot}°</b>
              <small>Rotation</small>
            </div>
          </div>
        ) : (
          <p className="nx-fine">Exact position (imported). Moves in whole studs and plates.</p>
        ))}
      <EditPad azimuth={() => ((viewportApi.controls?.getAzimuthalAngle() ?? 0) * 180) / Math.PI} />
      <HelpNote id="inspector">
        Arrows move one stud relative to the view; <kbd>PgUp</kbd> / <kbd>PgDn</kbd> one plate. Or pick the Move tool (M) and drag the piece.
        For Blender-style handles, turn on Gizmo above the 3D view. Scale changes the real LDraw part size, so use it only for non-standard geometry.
      </HelpNote>
    </aside>
  );
}
