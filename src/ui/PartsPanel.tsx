import { useMemo, useState } from 'react';
import { searchCatalog } from '../catalog/catalog';
import { COMMON_PARTS } from '../catalog/common';
import { recentPartIds } from '../catalog/recentParts';
import { catalogEntries, frequentParts, getPartUsage, usageSources } from '../catalog/usage';
import { addPart } from '../state/editing';
import { ensureParts } from '../state/partService';
import { setPaletteDrag } from '../state/placing';
import { useAppSettings } from '../state/appSettings';
import { getCatalog } from '../state/partService';
import { PaneHead } from './PaneHead';
import { PartThumb } from './PartThumb';
import { PART_DRAG_TYPE } from './PartsLane';

/** Which starter list the Parts panel shows while the search box is empty. */
type PartsTab = 'frequent' | 'common' | 'recent';

const TABS: [PartsTab, string, string][] = [
  ['frequent', 'Frequently used', 'The parts that appear in the most official sets'],
  ['common', 'Common', 'Everyday parts picked by hand'],
  ['recent', 'Recent', 'Parts you added last'],
];
const TAB_KEY = 'bm.parts-tab';
/** How many parts a starter list shows at once. */
const LIST_MAX = 60;

function loadTab(): PartsTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return TABS.some(([id]) => id === v) ? (v as PartsTab) : 'frequent';
  } catch {
    return 'frequent';
  }
}

export function PartsPanel() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [tab, setTab] = useState<PartsTab>(loadTab);
  const [recent, setRecent] = useState<string[]>(recentPartIds);
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
  // A search or a category browses the whole catalog; otherwise the tab picks the list.
  const browsing = !!q.trim() || !!cat;
  const results = useMemo(() => {
    if (browsing) return searchCatalog(cat ? catalog.filter((e) => e.category === cat) : catalog, q, LIST_MAX);
    if (tab === 'common') return catalogEntries(catalog, COMMON_PARTS);
    if (tab === 'recent') return catalogEntries(catalog, recent);
    return frequentParts(catalog, LIST_MAX);
  }, [catalog, q, cat, tab, recent, browsing]);

  const usage = getPartUsage();
  const sources = usageSources();
  const caption = browsing
    ? `${results.length} found`
    : tab === 'frequent'
      ? `Most-used parts${sources.omrSets ? ` · ${sources.omrSets.toLocaleString()} official sets` : ''}`
      : tab === 'common'
        ? 'Everyday parts'
        : 'Recently added';

  const pickTab = (t: PartsTab) => {
    setTab(t);
    if (t === 'recent') setRecent(recentPartIds());
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  const add = (id: string) => {
    void addPart(id);
    setRecent(recentPartIds());
  };

  return (
    <div className="nx-pane">
      <PaneHead id="parts" title="Parts" count={catalog.length.toLocaleString()}
        help="Drag a part into the view to snap it onto the model, or click to add it beside the model. Drag onto the timeline's Parts lane to add it at that moment." />
      <div className="nx-seg" role="tablist" aria-label="Part lists">
        {TABS.map(([id, label, hint]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} title={hint} onClick={() => pickTab(id)}>
            {label}
          </button>
        ))}
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
      <div className="nx-sub">Attachment precision</div>
      <label className="nx-hint" title="Suggest unreviewed LDraw !HELP placement examples. These are not verified connections." style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={referenceHints} onChange={(e) => useAppSettings.getState().set({ referenceHints: e.target.checked })} />
        Preview unreviewed part placement hints
      </label>
      <label className="nx-hint" title="A mirrored LDraw instance is not a physical rigid rotation; visual display only, and must still pass collision checks." style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={mirrorPoses} onChange={(e) => useAppSettings.getState().set({ mirrorReferencePlacements: e.target.checked })} />
        Allow mirrored LDraw reference poses
      </label>
      <div className="nx-sub">{caption}</div>
      <div className="part-grid">
        {results.map((e) => {
          const u = !browsing && tab === 'frequent' ? usage.get(e.id) : undefined;
          const stats = u ? `${u.sets ? `${u.sets.toLocaleString()} official sets` : `${u.models.toLocaleString()} models`}` : '';
          return (
            <button
              key={e.id}
              className="part-tile"
              title={`${e.name} (${e.id})${stats ? ` — ${stats}` : ''} — drag into the view to snap it on, click to add, or drag onto the timeline's Parts lane`}
              onClick={() => add(e.id)}
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
              {u && <span className="part-uses">{stats}</span>}
            </button>
          );
        })}
        {results.length === 0 && (
          <p className="nx-hint">
            {browsing
              ? 'No parts match.'
              : tab === 'frequent'
                ? 'No usage data yet — build it with "npm run data:part-usage".'
                : tab === 'recent'
                  ? 'The parts you add show up here.'
                  : 'No parts match.'}
          </p>
        )}
      </div>
    </div>
  );
}
