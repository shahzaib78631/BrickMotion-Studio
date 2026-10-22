import type { Warning } from '../model/validate';
import { useStudio } from '../state/store';
import { Ic } from './icons';

const KIND: Record<Warning['kind'], string> = {
  overlap: 'Overlap',
  floating: 'Floating',
  'unknown-part': 'Unknown part',
  'unknown-color': 'Unknown colour',
  'missing-submodel': 'Missing submodel',
  'submodel-cycle': 'Loop',
};

/** Problems in the set (floating, overlapping, unknown pieces); clicking one selects and frames it. */
export function ChecksPanel({ warnings }: { warnings: Warning[] }) {
  const st = useStudio.getState();
  return (
    <div className="nx-pane">
      <div className="nx-pane-head">
        <h3>
          Checks <span className="nx-count">{warnings.length}</span>
        </h3>
      </div>
      {warnings.length === 0 ? (
        <p className="bm-ok">
          <Ic name="check" /> All good: nothing floats or overlaps.
        </p>
      ) : (
        <p className="nx-fine">Click a problem to select and show it. AI → Fix can repair them for you.</p>
      )}
      <ul className="bm-checks">
        {warnings.slice(0, 200).map((w, i) => (
          <li key={i}>
            <button
              onClick={() => {
                if (w.model !== st.editingModel) st.setEditingModel(w.model);
                st.select(w.itemIds);
                st.requestFocus(w.itemIds);
              }}
            >
              <span className={`bm-kind ${w.kind}`}>{KIND[w.kind]}</span>
              <span>{w.message}</span>
            </button>
          </li>
        ))}
      </ul>
      {warnings.length > 200 && <p className="nx-hint">…and {warnings.length - 200} more</p>}
    </div>
  );
}
