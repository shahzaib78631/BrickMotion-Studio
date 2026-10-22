import { useMemo, useState } from 'react';
import { searchCatalog } from '../catalog/catalog';
import { resolveColor } from '../ldraw/colors';
import { findItem, modelSteps, moveItemsToStep, setColor, setPart } from '../plan/ops';
import { isGrid, isSub } from '../plan/types';
import { ensureParts, getCatalog, getColors, partName } from '../state/partService';
import { useStudio } from '../state/store';

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

export function Inspector() {
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
    return (
      <section className="inspector">
        <h2>Inspector</h2>
        <p className="muted">Click a piece to select it. Shift+click adds to the selection. Arrow keys move, PageUp/PageDown change height, R rotates, Delete removes.</p>
        <h3>Color for new pieces</h3>
        <ColorSwatches value={code} onPick={(c) => st.setPaintColor(c)} />
      </section>
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
    <section className="inspector">
      <h2>Inspector</h2>
      {found.length > 1 ? (
        <p>
          <strong>{found.length} pieces selected</strong>
        </p>
      ) : isSub(first) ? (
        <>
          <p>
            <strong>Submodel “{first.submodel}”</strong>
          </p>
          <button onClick={() => st.setEditingModel(first.submodel)}>Edit submodel</button>
        </>
      ) : (
        <>
          <p>
            <strong>{partName(first.part)}</strong> <span className="muted">{first.part}</span>
          </p>
          <PartPicker
            onPick={async (id) => {
              await ensureParts([id]);
              st.apply((p) => setPart(p, editingModel, [first.id!], id));
            }}
          />
          <p className="muted small">Color: {firstColor !== undefined ? colors.get(firstColor)!.name.replace(/_/g, ' ') : `unknown (${String(first.color)})`}</p>
        </>
      )}
      {pieceIds.length > 0 && <ColorSwatches value={firstColor} onPick={pickColor} />}
      <label className="row">
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
          <p className="muted small mono">
            x {first.x} · y {first.y} · z {first.z} · {first.rot}°
          </p>
        ) : (
          <p className="muted small">Exact position (imported) — moves in whole studs and plates.</p>
        ))}
    </section>
  );
}

