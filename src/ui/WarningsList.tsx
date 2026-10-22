import type { Warning } from '../model/validate';
import { useStudio } from '../state/store';

const ICON: Record<Warning['kind'], string> = {
  overlap: '⧉',
  floating: '☁',
  'unknown-part': '?',
  'unknown-color': '🎨',
  'missing-submodel': '∅',
  'submodel-cycle': '↻',
};

export function WarningsList({ warnings }: { warnings: Warning[] }) {
  const st = useStudio.getState();
  return (
    <section className="warnings">
      <h2>
        Checks {warnings.length > 0 ? <span className="badge">{warnings.length}</span> : <span className="ok">✓ all good</span>}
      </h2>
      <ul>
        {warnings.slice(0, 200).map((w, i) => (
          <li key={i}>
            <button
              onClick={() => {
                if (w.model !== st.editingModel) st.setEditingModel(w.model);
                st.select(w.itemIds);
                st.requestFocus(w.itemIds);
              }}
            >
              <span className="icon">{ICON[w.kind]}</span> {w.message}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
