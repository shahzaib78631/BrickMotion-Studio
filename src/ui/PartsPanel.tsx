import { useMemo, useState } from 'react';
import { searchCatalog } from '../catalog/catalog';
import { COMMON_PARTS } from '../catalog/common';
import { addPart } from '../state/editing';
import { ensureParts } from '../state/partService';
import { setPaletteDrag } from '../state/placing';
import { useAppSettings } from '../state/appSettings';
import { getCatalog } from '../state/partService';
import { PaneHead } from './PaneHead';
import { PartThumb } from './PartThumb';
import { PART_DRAG_TYPE } from './PartsLane';

export function PartsPanel() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const referenceHints = useAppSettings((s) => s.referenceHints);
  const mirrorPoses = useAppSettings((s) => s.mirrorReferencePlacements);
  const catalog = getCatalog();
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of catalog) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([c]) => c)
      .sort();
  }, [catalog]);
  const results = useMemo(() => {
    if (!q.trim() && !cat) {
      const byId = new Map(catalog.map((e) => [e.id, e]));
      return COMMON_PARTS.map((id) => byId.get(id)).filter((e) => !!e);
    }
    const pool = cat ? catalog.filter((e) => e.category === cat) : catalog;
    return searchCatalog(pool, q, 60);
  }, [catalog, q, cat]);

  return (
    <div className="nx-pane">
      <PaneHead id="parts" title="Parts" count={catalog.length.toLocaleString()}
        help="Drag a part into the view to snap it onto the model, or click to add it beside the model. Drag onto the timeline's Parts lane to add it at that moment." />
      <input type="search" aria-label="Search parts" placeholder="Search: 2x4, slope 45, 3001…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <div className="nx-sub">Attachment precision</div>
      <label className="nx-hint" title="Suggest unreviewed LDraw !HELP placement examples. These are not verified connections." style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={referenceHints} onChange={(e) => useAppSettings.getState().set({ referenceHints: e.target.checked })} />
        Preview unreviewed part placement hints
      </label>
      <label className="nx-hint" title="A mirrored LDraw instance is not a physical rigid rotation; visual display only, and must still pass collision checks." style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={mirrorPoses} onChange={(e) => useAppSettings.getState().set({ mirrorReferencePlacements: e.target.checked })} />
        Allow mirrored LDraw reference poses
      </label>
      <div className="nx-sub">{!q.trim() && !cat ? 'Common parts' : `${results.length} found`}</div>
      <div className="part-grid">
        {results.map((e) => (
          <button
            key={e.id}
            className="part-tile"
            title={`${e.name} (${e.id}) — drag into the view to snap it on, click to add, or drag onto the timeline's Parts lane`}
            onClick={() => addPart(e.id)}
            draggable
            onDragStart={(ev) => {
              ev.dataTransfer.setData(PART_DRAG_TYPE, e.id);
              ev.dataTransfer.effectAllowed = 'copy';
              setPaletteDrag(e.id);
              void ensureParts([e.id]);
            }}
            onDragEnd={() => setPaletteDrag(null)}
          >
            <PartThumb id={e.id} />
            <span className="part-name">{e.name}</span>
            <span className="part-id">{e.id}</span>
          </button>
        ))}
        {results.length === 0 && <p className="nx-hint">No parts match.</p>}
      </div>
    </div>
  );
}
