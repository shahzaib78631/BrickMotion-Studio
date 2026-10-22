import { useMemo, useState } from 'react';
import { searchCatalog } from '../catalog/catalog';
import { COMMON_PARTS } from '../catalog/common';
import { addPart } from '../state/editing';
import { getCatalog } from '../state/partService';
import { PartThumb } from './PartThumb';

export function PartsPanel() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const catalog = getCatalog();
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of catalog) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([c]) => c).sort();
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
    <aside className="panel parts">
      <h2>Parts</h2>
      <input type="search" placeholder="Search: 2x4, slope 45, 3001…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select value={cat} onChange={(e) => setCat(e.target.value)}>
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {!q.trim() && !cat && <p className="muted small">Common parts — search to see all {catalog.length.toLocaleString()}.</p>}
      <div className="part-grid">
        {results.map((e) => (
          <button key={e.id} className="part-tile" title={`${e.name} (${e.id}) — click to add`} onClick={() => addPart(e.id)}>
            <PartThumb id={e.id} />
            <span className="part-name">{e.name}</span>
            <span className="part-id">{e.id}</span>
          </button>
        ))}
        {results.length === 0 && <p className="muted">No parts match.</p>}
      </div>
    </aside>
  );
}
