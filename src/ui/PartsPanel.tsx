import { useMemo, useState } from 'react';
import { searchCatalog } from '../catalog/catalog';
import { COMMON_PARTS } from '../catalog/common';
import { addPart } from '../state/editing';
import { getCatalog } from '../state/partService';
import { PartThumb } from './PartThumb';
import { PART_DRAG_TYPE } from './PartsLane';

export function PartsPanel() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
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
      <div className="nx-pane-head">
        <h3>Parts</h3>
        <span className="nx-count">{catalog.length.toLocaleString()}</span>
      </div>
      <input type="search" aria-label="Search parts" placeholder="Search: 2x4, slope 45, 3001…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <div className="nx-sub">{!q.trim() && !cat ? 'Common parts' : `${results.length} found`}</div>
      <div className="part-grid">
        {results.map((e) => (
          <button
            key={e.id}
            className="part-tile"
            title={`${e.name} (${e.id}) — click to add, or drag onto the timeline's Parts lane to add it at that moment`}
            onClick={() => addPart(e.id)}
            draggable
            onDragStart={(ev) => {
              ev.dataTransfer.setData(PART_DRAG_TYPE, e.id);
              ev.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <PartThumb id={e.id} />
            <span className="part-name">{e.name}</span>
            <span className="part-id">{e.id}</span>
          </button>
        ))}
        {results.length === 0 && <p className="nx-hint">No parts match.</p>}
      </div>
      <p className="nx-fine">Click a part to add it in the selected colour. It lands in the current step. Or drag it onto the timeline's Parts lane to add it at that moment of the build.</p>
    </div>
  );
}
