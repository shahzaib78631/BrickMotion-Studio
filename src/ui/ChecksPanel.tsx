import type { Warning } from '../model/validate';
import { findItem } from '../plan/ops';
import { partName } from '../state/partService';
import { useStudio } from '../state/store';
import { Ic } from './icons';

const KIND: Record<Warning['kind'], string> = {
  overlap: 'Overlap',
  floating: 'Floating',
  'unknown-part': 'Unknown part',
  'unknown-color': 'Unknown colour',
  'missing-submodel': 'Missing submodel',
  'submodel-cycle': 'Loop',
  'assembly-spot': 'Assembly spot',
};

/** What each kind means, so a red piece in the viewport is not a mystery. */
const WHY: Record<Warning['kind'], string> = {
  overlap: 'Two pieces reach into each other by more than 2 LDU on every axis. Move one out; the measured depth is on each row.',
  floating: 'Nothing holds it up: no piece under it and no stud, clip or pin joining it to the model, so it would fall when the build plays.',
  'unknown-part': 'The part is not in the library, so it cannot be measured, drawn properly or collision-checked.',
  'unknown-color': 'The colour code is not in the LDraw palette; the piece is drawn in the fallback colour.',
  'missing-submodel': 'A submodel use points at a definition this file does not have.',
  'submodel-cycle': 'Submodels contain each other in a loop, so the build cannot be ordered.',
  'assembly-spot': 'Two models placed on the floor are laid on top of each other.',
};

/** Problems in the set (floating, overlapping, unknown pieces); clicking one selects and frames it. */
export function ChecksPanel({ warnings }: { warnings: Warning[] }) {
  const st = useStudio.getState();
  const blocked = useStudio((s) => s.blockedNote);
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const nameOf = (id: string) => {
    const found = findItem(plan, editingModel, id);
    return found && 'part' in found.item ? partName(found.item.part) : id;
  };
  return (
    <div className="nx-pane">
      <div className="nx-pane-head">
        <h3>
          Checks <span className="nx-count">{warnings.length}</span>
        </h3>
      </div>
      {blocked && (
        <section className="bm-check-group">
          <div className="nx-sub">Last refused edit</div>
          <p className="nx-fine">
            {blocked.ids.length === 1 ? nameOf(blocked.ids[0]) : `${blocked.ids.length} pieces`} was left where it was: {blocked.why}
            {blocked.with.length > 0 && <> — {blocked.with.map(nameOf).join(', ')}</>}. Pieces are outlined red while an edit is refused.
          </p>
          <div className="bm-check-actions">
            <button className="nx-btn nx-sm" onClick={() => { const ids = [...blocked.ids, ...blocked.with]; st.select(ids); st.requestFocus(ids); }}>
              Select those pieces
            </button>
            <button className="nx-btn nx-sm" onClick={() => st.clearBlockedNote()}>Dismiss</button>
          </div>
        </section>
      )}
      {warnings.length === 0 && !blocked && (
        <p className="bm-ok">
          <Ic name="check" /> All good: nothing floats or overlaps.
        </p>
      )}
      {warnings.length > 0 && (
        <p className="nx-fine">
          The pieces listed here are outlined red in the viewport. Click one to select and show it. AI → Fix can repair them for you.
        </p>
      )}
      {(Object.keys(KIND) as Warning['kind'][]).map((kind) => {
        const list = warnings.slice(0, 200).filter((w) => w.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} className="bm-check-group">
            <div className="nx-sub">{KIND[kind]}<span className="nx-count">{warnings.filter((w) => w.kind === kind).length}</span></div>
            <p className="nx-fine">{WHY[kind]}</p>
            <ul className="bm-checks">
              {list.map((w, i) => (
                <li key={i}>
                  <button
                    title={w.detail ? `${w.message} — ${w.detail}` : w.message}
                    onClick={() => {
                      if (w.kind === 'assembly-spot') {
                        // Spots are selected in the root Build scene, even if a
                        // nested SubItem owns their plan entry. Selecting parts
                        // here used to clear the warning without showing its marker.
                        if (st.editingModel) st.setEditingModel('');
                        st.selectSpot({ model: w.model, id: w.itemIds[0] ?? '' });
                        return;
                      }
                      if (w.model !== st.editingModel) st.setEditingModel(w.model);
                      st.select(w.itemIds);
                      st.requestFocus(w.itemIds);
                    }}
                  >
                    <span className={`bm-kind ${w.kind}`} aria-label={KIND[w.kind]} />
                    <span className="bm-check-msg">
                      {w.message}
                      {w.detail && <small>{w.detail}</small>}
                      {w.model && <small>in {w.model}</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {warnings.length > 200 && <p className="nx-hint">…and {warnings.length - 200} more</p>}
    </div>
  );
}
