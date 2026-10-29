import { useEffect, useRef, useState, type ReactNode } from 'react';
import { viewportApi } from './viewportApi';
import { exportLDraw } from '../io/ldrawExport';
import { readStudioIo } from '../io/studioIo';
import { planToJson, readPlanFile, attachAssemblyArtifact } from '../io/planFile';
import { isAssemblyArtifact } from '../anim/assemblyPlan/artifact';
import { isProjectFile, readProjectFile, PROJECT_EXTENSION } from '../io/projectFile';
import { animOptions, useAppSettings } from '../state/appSettings';
import { adoptTimeline, forgetTimelines, optsKey, settingsFromOptsKey } from '../state/timelineService';
import { regenerateSteps } from '../plan/regenerate';
import { saveProjectFile, type SaveProgress } from '../state/projectActions';
import { splitPlanComponents } from '../plan/components';
import { ensureIds } from '../plan/ids';
import { autoStepPlan, modelsWithoutSteps } from '../plan/autoSteps';
import { ensureParts, getColors, metricsOf, registerInlineParts } from '../state/partService';
import { allPartIds } from '../state/useModel';
import { newProject, useSaveStatus } from '../state/persistence';
import { applyImportTemplate } from '../state/templates';
import { useStudio } from '../state/store';
import { saveBlob, safeFileName } from './download';
import { Ic, type IconName } from './icons';

export function pieceCount(plan = useStudio.getState().plan): number {
  return [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((s) => s.steps)].reduce((n, s) => n + s.pieces.length, 0);
}

export type MenuItem = { icon: IconName; label: string; onClick(): void; disabled?: boolean; hint?: string; danger?: boolean; current?: boolean } | 'sep';

/** A button that opens a kit-style menu under it. */
export function DropMenu({
  trigger,
  items,
  className,
  align = 'left',
  label,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  className: string;
  align?: 'left' | 'right';
  label: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.target instanceof Node && (menu.current?.contains(e.target) || btn.current?.contains(e.target))) return;
      setPos(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [pos]);
  return (
    <>
      <button
        ref={btn}
        className={`${className} ${pos ? 'on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        aria-label={label}
        onClick={() => {
          if (pos) return setPos(null);
          const r = btn.current!.getBoundingClientRect();
          setPos({ x: align === 'right' ? r.right : r.left, y: r.bottom + 6 });
        }}
      >
        {trigger}
      </button>
      {pos && (
        <div
          ref={menu}
          className="nx-menu"
          role="menu"
          style={align === 'right' ? { right: window.innerWidth - pos.x, top: pos.y } : { left: pos.x, top: pos.y }}
          onClick={() => setPos(null)}
        >
          {items.map((it, i) =>
            it === 'sep' ? (
              <hr key={i} />
            ) : (
              <button key={i} role="menuitem" disabled={it.disabled} onClick={it.onClick}>
                <Ic name={it.icon} />
                <span>{it.label}</span>
                {it.hint && <kbd>{it.hint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </>
  );
}

type Props = {
  theme: 'light' | 'dark';
  onTheme(): void;
  onProjects(): void;
  onTemplates(): void;
  onAbout(): void;
  onExportVideo(): void;
  canPreview: boolean;
  onNavigate(panel: 'models' | 'parts' | 'assembly' | 'steps' | 'checks' | 'mechanisms' | 'ai' | 'video' | 'materials' | 'sound' | 'staging' | 'settings'): void;
};

export function Toolbar({ theme, onTheme, onProjects, onTemplates, onAbout, onExportVideo, canPreview, onNavigate }: Props) {
  const plan = useStudio((s) => s.plan);
  const mode = useStudio((s) => s.mode);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const status = useSaveStatus((s) => s.status);
  const st = useStudio.getState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingProject, setSavingProject] = useState<SaveProgress | null>(null);
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  useEffect(() => {
    if (!templateNote) return;
    const id = setTimeout(() => setTemplateNote(null), 4000);
    return () => clearTimeout(id);
  }, [templateNote]);
  const pieces = pieceCount(plan);
  const editingModel = useStudio((s) => s.editingModel);
  const [regenerating, setRegenerating] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  useEffect(() => {
    const onKeys = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCommandOpen((x) => !x); }
      if (e.key === 'Escape') setCommandOpen(false);
    };
    window.addEventListener('keydown', onKeys);
    return () => window.removeEventListener('keydown', onKeys);
  }, []);
  /**
   * Plans the model being edited again: its build steps (undoable), its animation
   * (the saved one is discarded), or both.
   */
  const regenerate = async (what: 'both' | 'steps' | 'animation') => {
    if (regenerating) return;
    setRegenerating(true);
    try {
      const s = useStudio.getState();
      let next = s.plan;
      if (what !== 'animation') {
        registerInlineParts(next.parts);
        await ensureParts(allPartIds(next));
        next = regenerateSteps(next, s.editingModel, metricsOf, getColors());
        s.apply(() => next);
      }
      if (what !== 'steps') {
        await forgetTimelines(next, [s.editingModel], animOptions(useAppSettings.getState(), s.plan.sceneSetup)).catch(() => {});
        s.replan();
      }
    } catch (e) {
      alert(`Couldn't regenerate:\n\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRegenerating(false);
    }
  };

  const openProjectFile = async (f: File) => {
    const r = readProjectFile(await f.text());
    if (!r.ok) return alert(`Couldn't open ${f.name}:\n\n${r.errors.slice(0, 8).join('\n')}`);
    if (pieceCount() > 0 && !confirm('Replace the current set with this project? (You can undo.)')) return;
    const plan = ensureIds(r.plan);
    // Use the video settings the animations were planned with, or they would not match and be planned again.
    const main = r.timelines.find((t) => t.model === '') ?? r.timelines[0];
    const saved = main ? settingsFromOptsKey(main.opts) : null;
    if (saved) useAppSettings.getState().set(saved);
    const current = optsKey(animOptions(useAppSettings.getState(), plan.sceneSetup));
    // Store the planned timelines first, so the preview finds them instead of planning again.
    // A file saved by an older version keys its settings differently; also file it under today's key.
    await Promise.all(r.timelines.flatMap((t) => [t.opts, ...(saved && t.opts === main!.opts && t.opts !== current ? [current] : [])]
      .map((opts) => adoptTimeline(plan, t.model, opts, t.timeline).catch(() => {}))));
    st.setPlan(plan);
    st.setEditingModel('');
    if (r.skipped) alert(`${r.skipped} saved animation timeline(s) in ${f.name} were damaged and will be planned again.`);
  };
  const importFile = async (f: File) => {
    if (isProjectFile(f.name)) return openProjectFile(f);
    let text: string;
    try { text = f.name.toLowerCase().endsWith('.io') ? await readStudioIo(await f.arrayBuffer()) : await f.text(); }
    catch (e) { return alert(`Couldn't extract ${f.name}:\n\n${e instanceof Error ? e.message : String(e)}`); }
    // An artifact arriving on its own attaches to the open plan instead of
    // replacing it, so the user can keep their waiting spots and animation.
    if (f.name.toLowerCase().endsWith('.json')) {
      let json: unknown;
      try { json = JSON.parse(text); } catch { /* readPlanFile reports it */ }
      if (isAssemblyArtifact(json)) {
        const current = useStudio.getState().plan;
        if (pieceCount(current) === 0) {
          const embedded = (json as { appPlan?: unknown })?.appPlan;
          if (!embedded || typeof embedded !== 'object') return alert(`Open the model plan first, then import ${f.name} to attach it.`);
        } else if (!confirm(`Attach the assembly artifact to the current set? (You can undo.)`)) return;
        const r = attachAssemblyArtifact(current, json);
        if (!r.ok) return alert(`Couldn't attach ${f.name}:\n\n${r.errors.slice(0, 8).join('\n')}`);
        st.apply(() => r.plan);
        return;
      }
    }
    const r = readPlanFile(text, f.name.toLowerCase().endsWith('.io') ? f.name.replace(/\.io$/i, '.ldr') : f.name);
    if (!r.ok) return alert(`Couldn't open ${f.name}:\n\n${r.errors.slice(0, 8).join('\n')}`);
    if (pieceCount() > 0 && !confirm('Replace the current set with this file? (You can undo.)')) return;
    let plan = ensureIds(r.plan);
    // LDraw files without STEP lines put hundreds of parts in one step. Give those
    // models bottom-up layer steps so the build reads like real instructions.
    if (modelsWithoutSteps(plan).length) {
      registerInlineParts(plan.parts);
      await ensureParts(allPartIds(plan));
      // big step-less models (a train) build their bogies and roof aside first
      plan = splitPlanComponents(plan, metricsOf, getColors()).plan;
      plan = autoStepPlan(plan, metricsOf, getColors()).plan;
    }
    st.setPlan(plan);
    st.setEditingModel('');
    // the template chosen "for imports" dresses every newly imported model
    try {
      const applied = await applyImportTemplate(plan);
      if (applied) setTemplateNote(`Template "${applied}" applied`);
    } catch (e) {
      alert(`The import template could not be applied:\n\n${e instanceof Error ? e.message : String(e)}`);
    }
  };
  /** The whole set with every build animation (planned now if needed). */
  const downloadProject = () => saveProjectFile(plan, '', setSavingProject);
  const downloadPlan = () => saveBlob(`${safeFileName(plan.name)}.plan.json`, new Blob([planToJson(plan)], { type: 'application/json' }));
  const downloadLDraw = () => saveBlob(`${safeFileName(plan.name)}.mpd`, new Blob([exportLDraw(plan, metricsOf, getColors())], { type: 'text/plain' }));

  const commands: { icon: IconName; label: string; subtitle: string; action(): void }[] = [
    { icon: 'box', label: 'Go to Models', subtitle: 'Browse the project hierarchy', action: () => onNavigate('models') },
    { icon: 'parts', label: 'Go to Parts', subtitle: 'Search and place bricks', action: () => onNavigate('parts') },
    { icon: 'spot', label: 'Go to Assembly', subtitle: 'Set how the model fits together', action: () => onNavigate('assembly') },
    { icon: 'steps', label: 'Go to Animation', subtitle: 'Edit build steps', action: () => onNavigate('steps') },
    { icon: 'rotate', label: 'Open Mechanism Lab', subtitle: 'Inspect connectors, joints and gears; preview motion', action: () => onNavigate('mechanisms') },
    { icon: 'video', label: 'Go to Render', subtitle: 'Export settings and video', action: () => onNavigate('video') },
    { icon: 'palette', label: 'Go to Materials', subtitle: 'Scenes, brick finishes, textures and floors', action: () => onNavigate('materials') },
    { icon: 'sound', label: 'Go to Sound', subtitle: 'Snap click, body thump, room echo and volume', action: () => onNavigate('sound') },
    { icon: 'layout', label: 'Go to Staging', subtitle: 'How waiting pieces are laid out, and the build order', action: () => onNavigate('staging') },
    { icon: 'folder', label: 'Open Assets & AI', subtitle: 'Assisted workflows and assets', action: () => onNavigate('ai') },
    { icon: 'checks', label: 'Review model checks', subtitle: 'Warnings and verification', action: () => onNavigate('checks') },
    { icon: 'settings', label: 'Open Settings', subtitle: 'Workspace and animation preferences', action: () => onNavigate('settings') },
    { icon: 'upload', label: 'Import a model', subtitle: 'Studio .io, LDraw, MPD, JSON, project file', action: () => fileRef.current?.click() },
    { icon: 'folder', label: 'Browse projects', subtitle: 'Open a saved project', action: onProjects },
    { icon: 'layout', label: 'Templates', subtitle: 'Save this project as a template, or apply one to this model', action: onTemplates },
    { icon: 'fit', label: 'Fit the viewport', subtitle: 'Frame all model pieces', action: () => viewportApi.fit() },
    { icon: 'components', label: 'Lay out all parts', subtitle: 'Organize the parts on the grid', action: () => st.setLaidOut(true) },
    { icon: 'rotate', label: 'Regenerate steps & animation', subtitle: 'Rebuild the construction timeline', action: () => void regenerate('both') },
    { icon: 'moon', label: 'Switch color theme', subtitle: 'Light or dark workspace', action: onTheme },
    { icon: 'palette', label: 'Theme and accent colour', subtitle: 'Light, dark or system; accent colour; surface tone', action: () => onNavigate('settings') },
  ];
  const filteredCommands = commands.filter((c) => `${c.label} ${c.subtitle}`.toLowerCase().includes(commandQuery.toLowerCase()));
  const runPaletteCommand = (action: () => void) => { setCommandOpen(false); setCommandQuery(''); action(); };

  return (
    <>
      <header className="nx-head bm-reference-head">
        <div className="nx-head-left">
          <span className="nx-brand" aria-label="BrickMotion">
            <span className="nx-brand-mark"><Ic name="box" /></span>
            <span className="nx-brand-name">BrickMotion</span>
            <span className="bm-pro-badge">Pro</span>
          </span>
          <span className="nx-sep" />
          <DropMenu
            className="nx-file bm-project-nav"
            label="Project menu"
            trigger={<>Projects <Ic name="right" /></>}
            items={[
              { icon: 'plus', label: 'New project', onClick: () => void newProject() },
              { icon: 'folder', label: 'Open projects…', onClick: onProjects },
              { icon: 'upload', label: 'Import model or project…', hint: `.${PROJECT_EXTENSION} .io .mpd .ldr`, onClick: () => fileRef.current?.click() },
              'sep',
              { icon: 'download', label: `Save project (.${PROJECT_EXTENSION})`, disabled: pieces === 0 || !!savingProject, onClick: () => void downloadProject() },
              { icon: 'file', label: 'Download plan (.json)', onClick: downloadPlan },
              { icon: 'file', label: 'Download LDraw (.mpd)', onClick: downloadLDraw },
              'sep',
              { icon: 'layout', label: 'Templates…', hint: 'save or apply a look', onClick: onTemplates },
              'sep',
              { icon: 'info', label: 'About BrickMotion', onClick: onAbout },
            ]}
          />
          <input className="nx-title" value={plan.name} aria-label="Project name" title="Click to rename this project"
            placeholder="Untitled project" onChange={(e) => st.apply((p) => ({ ...p, name: e.target.value }))} />
          <span className={`nx-save bm-header-save ${status === 'saved' ? '' : status}`} role="status"
            title="Changes save automatically on this device">
            <span className="nx-dot" />
            {status === 'saved' ? 'Autosaved' : status === 'dirty' ? 'Saving…' : 'Save error'}
            {status === 'saved' && <Ic name="check" />}
          </span>
          <input ref={fileRef} type="file" accept={`.${PROJECT_EXTENSION},.json,.ldr,.mpd,.dat,.io`} hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        </div>
        <button className="bm-command-trigger" aria-label="Search or run a command (Command K)"
          onClick={() => setCommandOpen(true)}>
          <Ic name="search" /> <span>Search or run a command…</span> <kbd>⌘K</kbd>
        </button>
        <div className="nx-head-right">
          {templateNote && <span className="bm-saving-progress" role="status">{templateNote}</span>}
          {savingProject && <span className="bm-saving-progress" role="status">Saving {savingProject.done + 1}/{savingProject.total}…</span>}
          <DropMenu className="nx-icon bm-history-button" label="Project tools" align="right"
            trigger={<Ic name="history" />} items={[
              { icon: 'undo', label: 'Undo', disabled: !canUndo, onClick: st.undo, hint: '⌘Z' },
              { icon: 'redo', label: 'Redo', disabled: !canRedo, onClick: st.redo, hint: '⇧⌘Z' },
              'sep',
              { icon: 'rotate', label: 'Rebuild steps and animation', disabled: !pieces || regenerating, onClick: () => void regenerate('both') },
              { icon: 'steps', label: 'Regenerate steps only', disabled: !pieces || regenerating, onClick: () => void regenerate('steps') },
              { icon: 'video', label: 'Regenerate animation only', disabled: !pieces || regenerating, onClick: () => void regenerate('animation') },
              'sep',
              { icon: theme === 'dark' ? 'sun' : 'moon', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', onClick: onTheme },
            ]} />
          <span className="bm-head-divider" />
          <button className="nx-icon" disabled={!canUndo} onClick={st.undo} title="Undo (⌘Z)" aria-label="Undo"><Ic name="undo" /></button>
          <button className="nx-icon" disabled={!canRedo} onClick={st.redo} title="Redo (⇧⌘Z)" aria-label="Redo"><Ic name="redo" /></button>
          <span className="bm-head-divider" />
          <button className="nx-btn bm-preview-button" disabled={!canPreview}
            onClick={() => st.setMode(mode === 'edit' ? 'preview' : 'edit')}>
            <Ic name={mode === 'edit' ? 'play' : 'edit'} />{mode === 'edit' ? 'Preview' : 'Back to editor'} <Ic name="right" />
          </button>
          <DropMenu className="nx-btn nx-primary bm-export-button" label="Export" align="right"
            trigger={<><Ic name="download" /> Export <Ic name="chevron" /></>}
            items={[
              { icon: 'video', label: 'Export video (MP4)…', disabled: pieces === 0, onClick: onExportVideo },
              'sep',
              { icon: 'download', label: `Project with animation (.${PROJECT_EXTENSION})`, disabled: pieces === 0 || !!savingProject, onClick: () => void downloadProject() },
              { icon: 'file', label: 'Plan (.json)', onClick: downloadPlan },
              { icon: 'file', label: 'LDraw (.mpd)', onClick: downloadLDraw },
            ]} />
        </div>
      </header>
      {commandOpen && <div className="bm-command-backdrop" role="presentation" onMouseDown={(e) => {
        if (e.target === e.currentTarget) { setCommandOpen(false); setCommandQuery(''); }
      }}>
        <div className="bm-command-dialog" role="dialog" aria-modal="true" aria-label="Search or run a command">
          <div className="bm-command-search-row"><Ic name="search" /><input autoFocus aria-label="Search commands"
            placeholder="Where would you like to go?" value={commandQuery} onChange={(e) => setCommandQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && filteredCommands[0]) runPaletteCommand(filteredCommands[0].action); }} />
            <kbd>ESC</kbd></div>
          <div className="bm-command-results"><span className="bm-command-results-label">{commandQuery ? 'Matching commands' : 'Quick actions'}</span>
            {filteredCommands.map((c) => <button key={c.label} onClick={() => runPaletteCommand(c.action)}>
              <span className="bm-command-result-icon"><Ic name={c.icon} /></span>
              <span><strong>{c.label}</strong><small>{c.subtitle}</small></span>
              <Ic name="right" />
            </button>)}
            {!filteredCommands.length && <div className="bm-command-no-results">No matching actions. Try “import”, “models”, or “export”.</div>}
          </div>
          <footer>Use <kbd>Enter</kbd> to open the first result <span>BrickMotion Command Center</span></footer>
        </div>
      </div>}
    </>
  );
}
