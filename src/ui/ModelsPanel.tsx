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
import { ContextMenu, type ContextItem } from './ContextMenu';
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
export function ModelsPanel({ model, onExport }: { model: ModelState; onExport(jobs: ExportJob[]): void }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const rows = useMemo(() => modelOutline(plan), [plan]);
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
    <div className="nx-pane">
      <div className="nx-pane-head">
        <h3>
          Models <span className="nx-count">{rows.length}</span>
        </h3>
      </div>
      <p className="nx-fine">Each model has its own build timeline. Open one to edit, preview and export it on its own; the main model builds every submodel aside and attaches it. Right-click a model for more.</p>
      {saving && (
        <p className="nx-hint" role="status">
          Planning animations for {label(saving.name)}'s project file ({saving.progress.done + 1} of {saving.progress.total})…
        </p>
      )}
      <input ref={fileInput} type="file" hidden accept={`.${PROJECT_EXTENSION},.json,.ldr,.mpd,.dat`} onChange={(e) => {
        const f = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (f) void importFile(f);
      }} />
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`${label(menu.name)} menu`} items={menuItems(menu.name)} onClose={closeMenu} />}
      <ul className="bm-models" aria-label="Models in this set">
        {rows.map((r) => {
          const active = editingModel === r.name;
          return (
            <li key={r.name || '(main)'} className={`bm-model-row ${active ? 'active' : ''} ${r.used ? '' : 'unused'} ${menu?.name === r.name ? 'menu-open' : ''}`} style={{ paddingLeft: 8 + r.depth * 14 }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, name: r.name }); }}>
              <button className="bm-model-main" onClick={() => open(r.name)} aria-current={active} title={`Open ${label(r.name)}`}>
                <Ic name={r.name ? 'box' : 'brick'} />
                <span className="bm-model-text">
                  <strong>{label(r.name)}</strong>
                  <span className="nx-hint">
                    {r.total} part{r.total === 1 ? '' : 's'} · {r.steps} step{r.steps === 1 ? '' : 's'}
                    {r.name && r.uses > 1 ? ` · used ×${r.uses}` : ''}
                    {!r.used ? ' · not used' : ''}
                  </span>
                </span>
              </button>
              <div className="bm-model-actions">
                {r.bigStep && (
                  <button className="nx-icon" title={`All ${r.direct} parts are in one step. Split into bottom-up layer steps`} aria-label={`Auto-split ${label(r.name)} into steps`} onClick={() => split(r.name)}>
                    <Ic name="wand" />
                  </button>
                )}
                {r.splittable && (
                  <button className="nx-icon" title={`Build in components: the underside groups and the roof of ${label(r.name)} are built aside as their own submodels, then attached`} aria-label={`Build ${label(r.name)} in components`} disabled={!model.ready} onClick={() => components(r.name)}>
                    <Ic name="components" />
                  </button>
                )}
                <button className="nx-icon" title={`Play ${label(r.name)}'s build on its own`} aria-label={`Play ${label(r.name)}`} disabled={!model.ready || r.total === 0} onClick={() => play(r.name)}>
                  <Ic name="play" />
                </button>
                <button className="nx-icon" title={`Export ${label(r.name)} as its own MP4`} aria-label={`Export ${label(r.name)} as MP4`} disabled={!model.ready || r.total === 0} onClick={() => onExport([{ model: r.name, label: label(r.name) }])}>
                  <Ic name="download" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {subs.length > 0 && (
        <div className="bm-models-batch">
          <button className="nx-btn nx-sm" disabled={!model.ready} onClick={() => onExport(subs.map((r) => ({ model: r.name, label: r.name })))}>
            <Ic name="video" /> Export all {subs.length} submodels
          </button>
          <button className="nx-btn nx-sm" disabled={!model.ready} onClick={() => onExport([{ model: '', label: 'Main model' }, ...subs.map((r) => ({ model: r.name, label: r.name }))])}>
            <Ic name="download" /> Export everything
          </button>
          <p className="nx-fine">One MP4 per model, rendered one after another with your Video settings.</p>
        </div>
      )}
    </div>
  );
}
