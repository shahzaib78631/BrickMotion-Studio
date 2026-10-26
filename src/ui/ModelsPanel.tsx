import { useCallback, useMemo, useRef, useState } from 'react';
import { autoSplitSteps, LARGE_STEP } from '../plan/autoSteps';
import { buildInComponents, canSplitComponents } from '../plan/components';
import { modelSteps } from '../plan/ops';
import { isSub, type Plan } from '../plan/types';
import { getColors, metricsOf } from '../state/partService';
import { usePlayback } from '../state/playback';
import { useStudio } from '../state/store';
import type { ModelState } from '../state/useModel';
import type { ExportJob } from './ExportDialog';
import { Ic } from './icons';
import { availableSubmodelName } from '../plan/createSubmodel';
import { newProject } from '../state/persistence';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { PartsDialog } from './PartsDialog';
import { importAsSubmodel } from '../plan/modelFiles';
import { isProjectFile, PROJECT_EXTENSION, readProjectFile } from '../io/projectFile';
import { readPlanFile } from '../io/planFile';
import { saveLDrawFile, saveProjectFile, type SaveProgress } from '../state/projectActions';

type Row = { name: string; depth: number; steps: number; direct: number; total: number; uses: number; bigStep: boolean; used: boolean; splittable: boolean };

/** Main model first, then submodels in the order they are first built (nested ones indented); unused ones last. */
export function modelOutline(plan: Plan): Row[] {
  const totals = new Map<string, number>();
  const total = (m: string, stack: string[] = []): number => {
    if (totals.has(m)) return totals.get(m)!;
    if (stack.includes(m)) return 0;
    let n = 0;
    for (const s of modelSteps(plan, m))
      for (const i of s.pieces) n += isSub(i) ? (plan.submodels?.[i.submodel] ? total(i.submodel, [...stack, m]) : 0) : 1;
    totals.set(m, n);
    return n;
  };
  const uses = new Map<string, number>();
  for (const m of ['', ...Object.keys(plan.submodels ?? {})])
    for (const s of modelSteps(plan, m)) for (const i of s.pieces) if (isSub(i)) uses.set(i.submodel, (uses.get(i.submodel) ?? 0) + 1);
  const row = (name: string, depth: number, used: boolean): Row => {
    const steps = modelSteps(plan, name);
    const filled = steps.filter((s) => s.pieces.length);
    return {
      name,
      depth,
      steps: steps.length,
      direct: steps.reduce((n, s) => n + s.pieces.length, 0),
      total: total(name),
      uses: uses.get(name) ?? 0,
      bigStep: filled.length === 1 && filled[0].pieces.length > LARGE_STEP,
      used,
      splittable: canSplitComponents(plan, name),
    };
  };
  const rows: Row[] = [row('', 0, true)];
  const seen = new Set<string>(['']);
  const walk = (m: string, depth: number) => {
    for (const s of modelSteps(plan, m))
      for (const i of s.pieces) {
        if (!isSub(i) || seen.has(i.submodel) || !plan.submodels?.[i.submodel]) continue;
        seen.add(i.submodel);
        rows.push(row(i.submodel, depth, true));
        walk(i.submodel, depth + 1);
      }
  };
  walk('', 1);
  for (const name of Object.keys(plan.submodels ?? {})) if (!seen.has(name)) rows.push(row(name, 1, false));
  return rows;
}

/**
 * Every model of the set with its own build: open it, play its assembly on its own,
 * or export it as a separate MP4 (one at a time or all submodels in one go).
 */
export function ModelsPanel({ model, onExport, onMakeSubmodel }: { model: ModelState; onExport(jobs: ExportJob[]): void; onMakeSubmodel(): void }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const rows = useMemo(() => modelOutline(plan), [plan]);
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const selection = useStudio((s) => s.selection);
  const selectedCount = selection.model === editingModel ? selection.ids.length : 0;
  const toggleModel = (name: string) => setCollapsed((old) => {
    const next = new Set(old);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });
  const matches = rows.filter((r, index) => {
    if (query.trim()) return (r.name || 'Main model').toLowerCase().includes(query.trim().toLowerCase());
    let depth = r.depth;
    for (let at = index - 1; at >= 0 && depth > 0; at--) {
      if (rows[at].depth >= depth) continue;
      if (collapsed.has(rows[at].name)) return false;
      depth = rows[at].depth;
    }
    return true;
  });
  const hasChildren = (index: number) => index < rows.length - 1 && rows[index + 1].depth > rows[index].depth;
  const createBlankSubmodel = () => {
    const name = availableSubmodelName(useStudio.getState().plan);
    useStudio.getState().apply((p) => ({ ...p, submodels: { ...p.submodels, [name]: { steps: [{ pieces: [] }] } } }));
    setNewOpen(false);
    open(name);
  };
  const subs = rows.filter((r) => r.name && r.total > 0);
  const label = (name: string) => name || 'Main model';
  const open = (name: string) => {
    usePlayback.getState().set({ playing: false, t: 0, stopAt: null, loopFrom: null });
    const st = useStudio.getState();
    st.setMode('edit');
    if (st.editingModel !== name) st.setEditingModel(name);
  };
  const play = (name: string) => {
    open(name);
    useStudio.getState().setMode('preview');
    usePlayback.getState().set({ t: 0, playing: true });
  };
  const split = (name: string) => {
    useStudio.getState().apply((p) => autoSplitSteps(p, name, metricsOf, getColors()));
    open(name);
  };
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  /** `View parts` browses the editing model, so the row's model is opened first. */
  const [partsFor, setPartsFor] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ name: string; progress: SaveProgress } | null>(null);
  const importInto = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const saveProject = (name: string) =>
    void saveProjectFile(useStudio.getState().plan, name, (progress) => setSaving(progress ? { name, progress } : null));
  const importFile = async (f: File) => {
    const text = await f.text();
    const read = isProjectFile(f.name) ? readProjectFile(text) : readPlanFile(text, f.name);
    if (!read.ok) return alert(`Couldn't import ${f.name}:\n\n${read.errors.slice(0, 8).join('\n')}`);
    const target = importInto.current;
    const base = f.name.replace(/\.(brickmotion|plan\.json|json|mpd|ldr|dat)$/i, '');
    const r = importAsSubmodel(useStudio.getState().plan, target, read.plan, base);
    useStudio.getState().apply(() => r.plan);
    open(target);
  };
  const menuItems = (name: string): ContextItem[] => {
    const row = rows.find((r) => r.name === name);
    const empty = !row || row.total === 0;
    const others = rows.filter((r) => r.name !== name && r.name !== editingModel);
    return [
      { icon: 'eye', label: `Open ${label(name)}`, disabled: editingModel === name, onClick: () => open(name) },
      { icon: 'play', label: 'Play its build', disabled: !model.ready || empty, onClick: () => play(name) },
      { icon: 'steps', label: 'Lay out all parts', disabled: !model.ready || empty, onClick: () => { open(name); useStudio.getState().setLaidOut(true); } },
      { icon: 'parts', label: 'View parts', disabled: !model.ready || empty, onClick: () => { open(name); setPartsFor(name); } },
      'sep',
      { icon: 'video', label: 'Export as MP4', disabled: !model.ready || empty, onClick: () => onExport([{ model: name, label: label(name) }]) },
      { icon: 'download', label: `Save as project with animation (.${PROJECT_EXTENSION})`, disabled: !model.ready || empty || !!saving, onClick: () => saveProject(name) },
      { icon: 'file', label: 'Save as LDraw (.mpd)', disabled: !model.ready || empty, onClick: () => saveLDrawFile(useStudio.getState().plan, name) },
      'sep',
      { icon: 'upload', label: `Import a file into ${label(name)}…`, onClick: () => { importInto.current = name; fileInput.current?.click(); } },
      ...(others.length ? ['sep', { heading: 'Open another model' }, ...others.map((r): ContextItem => ({ icon: r.name ? 'box' : 'brick', label: label(r.name), onClick: () => open(r.name) }))] as ContextItem[] : []),
    ];
  };
  const components = (name: string) => {
    const r = buildInComponents(useStudio.getState().plan, name, metricsOf, getColors());
    if (!r.components.length) return alert(`${label(name)} has no separate parts to build aside (no underside group or roof was found).`);
    useStudio.getState().apply(() => r.plan);
    open(name);
  };

  return (
    <div className="nx-pane bm-models-pane">
      <div className="nx-pane-head bm-models-heading">
        <h3>Models <span className="nx-count">{rows.length}</span></h3>
        <div className="bm-new-wrap">
          <button className={`nx-btn nx-primary bm-new-model ${newOpen ? 'on' : ''}`} onClick={() => setNewOpen((open) => !open)}
            aria-haspopup="menu" aria-expanded={newOpen} aria-label="Create a model or submodule">
            <Ic name="plus" /> New <Ic name="chevron" />
          </button>
          {newOpen && <>
            <button className="bm-menu-scrim" aria-label="Close new model menu" onClick={() => setNewOpen(false)} />
            <div className="nx-menu bm-new-menu" role="menu" aria-label="New model">
              <button role="menuitem" onClick={() => { setNewOpen(false); void newProject(); }}><Ic name="box" /> New Model</button>
              <button role="menuitem" onClick={createBlankSubmodel}><Ic name="components" /> New Submodule</button>
              <button role="menuitem" disabled={selectedCount < 2} onClick={() => { setNewOpen(false); onMakeSubmodel(); }}>
                <Ic name="fit" /> From Selection ({selectedCount} parts)
              </button>
            </div>
          </>}
        </div>
      </div>
      <label className="bm-model-search"><Ic name="zoomIn" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models, submodules…" aria-label="Search models and submodules" />
        {query && <button className="nx-icon" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}><Ic name="x" /></button>}
      </label>
      {saving && <p className="nx-hint" role="status">Planning animations for {label(saving.name)}'s project file ({saving.progress.done + 1} of {saving.progress.total})…</p>}
      <input ref={fileInput} type="file" hidden accept={`.${PROJECT_EXTENSION},.json,.ldr,.mpd,.dat`} onChange={(e) => {
        const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void importFile(f);
      }} />
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`${label(menu.name)} menu`} items={menuItems(menu.name)} onClose={closeMenu} />}
      {partsFor !== null && <PartsDialog model={model} onClose={() => setPartsFor(null)} />}
      <div className="bm-models-scroll">
        <ul className="bm-models" aria-label="Models in this set">
          {matches.map((r) => {
            const active = editingModel === r.name;
            const at = rows.indexOf(r);
            const expandable = hasChildren(at);
            const chip = /frame/i.test(r.name) ? 'Core' : /rotor|motor|motion/i.test(r.name) ? 'Motion' : null;
            return <li key={r.name || '(main)'}
              className={`bm-model-row ${active ? 'active' : ''} ${r.used ? '' : 'unused'} ${menu?.name === r.name ? 'menu-open' : ''}`}
              style={{ paddingLeft: `${3 + r.depth * 14}px` }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, name: r.name }); }}>
              <button className={`bm-model-expand ${expandable ? '' : 'is-leaf'} ${collapsed.has(r.name) ? 'is-collapsed' : ''}`}
                aria-label={expandedLabel(r.name, collapsed.has(r.name))} aria-expanded={expandable ? !collapsed.has(r.name) : undefined}
                onClick={() => expandable && toggleModel(r.name)} tabIndex={expandable ? 0 : -1}>
                {expandable && <Ic name="chevron" />}
              </button>
              <button className="bm-model-main" onClick={() => open(r.name)} aria-current={active} title={`Open ${label(r.name)}`}>
                <span className="bm-model-cube"><Ic name={r.name ? 'box' : 'brick'} /></span>
                <span className="bm-model-text">
                  <span className="bm-model-title"><strong>{label(r.name)}</strong>{chip && <em className={`bm-model-tag ${chip.toLowerCase()}`}>{chip}</em>}</span>
                  <span className="nx-hint">{r.total.toLocaleString()} parts <b>·</b> {r.steps} steps{r.uses > 1 ? ` · ×${r.uses}` : ''}</span>
                </span>
              </button>
              <div className="bm-model-actions">
                <button className="nx-icon bm-model-eye" title={`View ${label(r.name)} in the viewport`}
                  aria-label={`Show ${label(r.name)} in viewport`} onClick={() => { open(r.name); viewportFitSoon(); }}><Ic name="eye" /></button>
                <button className="nx-icon bm-model-more" title={`Actions for ${label(r.name)}`} aria-label={`Actions for ${label(r.name)}`}
                  onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 4, name: r.name }); }}><Ic name="more" /></button>
              </div>
            </li>;
          })}
          {matches.length === 0 && <li className="bm-model-empty"><Ic name="zoomIn" /><strong>No models found</strong><span>Try another search or create a submodule.</span></li>}
        </ul>
        {rows.length === 1 && rows[0].total === 0 && <p className="bm-model-intro">Start a project by importing a model from Projects, or add a part from the Parts panel.</p>}
      </div>
      <div className="bm-models-batch">
        <h4>Quick actions</h4>
        <button className="nx-btn" disabled={!model.ready || !rows.find((r) => r.name === editingModel)?.total}
          onClick={() => onExport([{ model: editingModel, label: label(editingModel) }])}>
          <Ic name="download" /> Export selected ({(rows.find((r) => r.name === editingModel)?.total || 0).toLocaleString()} parts)
        </button>
        <button className="nx-btn" disabled={!model.ready || !subs.length}
          onClick={() => onExport(subs.map((r) => ({ model: r.name, label: r.name })))}>
          <Ic name="components" /> Export all submodules
        </button>
      </div>
    </div>
  );
}

function expandedLabel(name: string, collapsed: boolean) {
  return `${collapsed ? 'Expand' : 'Collapse'} ${name || 'Main model'}`;
}

function viewportFitSoon() {
  requestAnimationFrame(() => import('./viewportApi').then(({ viewportApi }) => viewportApi.fit()));
}
