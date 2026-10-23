import { useEffect, useRef, useState, type ReactNode } from 'react';
import { exportLDraw } from '../io/ldrawExport';
import { planToJson, readPlanFile } from '../io/planFile';
import { isProjectFile, projectToJson, readProjectFile, PROJECT_EXTENSION, type SavedTimeline } from '../io/projectFile';
import { animOptions, useAppSettings } from '../state/appSettings';
import { adoptTimeline, optsKey, savedTimeline } from '../state/timelineService';
import { splitPlanComponents } from '../plan/components';
import { ensureIds } from '../plan/ids';
import { autoStepPlan, modelsWithoutSteps } from '../plan/autoSteps';
import { ensureParts, getColors, metricsOf, registerInlineParts } from '../state/partService';
import { allPartIds } from '../state/useModel';
import { newProject, useSaveStatus } from '../state/persistence';
import { useStudio } from '../state/store';
import { saveBlob, safeFileName } from './download';
import { Ic, type IconName } from './icons';

export function pieceCount(plan = useStudio.getState().plan): number {
  return [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((s) => s.steps)].reduce((n, s) => n + s.pieces.length, 0);
}

export type MenuItem = { icon: IconName; label: string; onClick(): void; disabled?: boolean; hint?: string } | 'sep';

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
  onAbout(): void;
  onExportVideo(): void;
  canPreview: boolean;
};

export function Toolbar({ theme, onTheme, onProjects, onAbout, onExportVideo, canPreview }: Props) {
  const plan = useStudio((s) => s.plan);
  const mode = useStudio((s) => s.mode);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const status = useSaveStatus((s) => s.status);
  const tool = useStudio((s) => s.tool);
  const st = useStudio.getState();
  const fileRef = useRef<HTMLInputElement>(null);
  const pieces = pieceCount(plan);

  const openProjectFile = async (f: File) => {
    const r = readProjectFile(await f.text());
    if (!r.ok) return alert(`Couldn't open ${f.name}:\n\n${r.errors.slice(0, 8).join('\n')}`);
    if (pieceCount() > 0 && !confirm('Replace the current set with this project? (You can undo.)')) return;
    const plan = ensureIds(r.plan);
    // Store the planned timelines first, so the preview finds them instead of planning again.
    await Promise.all(r.timelines.map((t) => adoptTimeline(plan, t.model, t.opts, t.timeline).catch(() => {})));
    st.setPlan(plan);
    st.setEditingModel('');
    if (r.skipped) alert(`${r.skipped} saved animation timeline(s) in ${f.name} were damaged and will be planned again.`);
  };
  const importFile = async (f: File) => {
    if (isProjectFile(f.name)) return openProjectFile(f);
    const r = readPlanFile(await f.text(), f.name);
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
  };
  /** The model plus every build animation already planned for it with the current video settings. */
  const downloadProject = async () => {
    const opts = animOptions(useAppSettings.getState());
    const models = ['', ...Object.keys(plan.submodels ?? {})];
    const timelines: SavedTimeline[] = [];
    for (const model of models) {
      const timeline = await savedTimeline(plan, model, opts).catch(() => null);
      if (timeline) timelines.push({ model, opts: optsKey(opts), timeline });
    }
    if (!timelines.some((t) => t.model === '') && !confirm('The build animation for this set has not been planned yet (open Preview first to plan it).\n\nSave the project without it? It will be planned when the file is opened.')) return;
    saveBlob(`${safeFileName(plan.name)}.${PROJECT_EXTENSION}`, new Blob([projectToJson(plan, timelines)], { type: 'application/json' }));
  };
  const downloadPlan = () => saveBlob(`${safeFileName(plan.name)}.plan.json`, new Blob([planToJson(plan)], { type: 'application/json' }));
  const downloadLDraw = () => saveBlob(`${safeFileName(plan.name)}.mpd`, new Blob([exportLDraw(plan, metricsOf, getColors())], { type: 'text/plain' }));

  return (
    <header className="nx-head">
      <div className="nx-head-left">
        <span className="nx-brand">
          <span className="nx-brand-mark">
            <Ic name="brick" />
          </span>
          <span>BrickMotion</span>
        </span>
        <span className="nx-sep" />
        <DropMenu
          className="nx-file"
          label="Project menu"
          trigger={
            <>
              <Ic name="folder" /> Projects <Ic name="chevron" />
            </>
          }
          items={[
            { icon: 'plus', label: 'New project', onClick: () => void newProject() },
            { icon: 'folder', label: 'Open project…', onClick: onProjects },
            { icon: 'upload', label: 'Import file…', hint: `.${PROJECT_EXTENSION} .json .ldr .mpd`, onClick: () => fileRef.current?.click() },
            'sep',
            { icon: 'download', label: `Save project with animation (.${PROJECT_EXTENSION})`, disabled: pieces === 0, onClick: () => void downloadProject() },
            { icon: 'file', label: 'Download plan (.json)', onClick: downloadPlan },
            { icon: 'file', label: 'Download LDraw (.mpd)', onClick: downloadLDraw },
            'sep',
            { icon: 'info', label: 'About BrickMotion', onClick: onAbout },
          ]}
        />
        <input
          className="nx-title"
          value={plan.name}
          aria-label="Set name"
          placeholder="Untitled set"
          onChange={(e) => st.apply((p) => ({ ...p, name: e.target.value }))}
        />
        <input
          ref={fileRef}
          type="file"
          accept={`.${PROJECT_EXTENSION},.json,.ldr,.mpd`}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
      </div>
      <div className="bm-tools" role="radiogroup" aria-label="Tools">
        <button
          className={`nx-icon ${tool === 'select' ? 'on' : ''}`}
          role="radio"
          aria-checked={tool === 'select'}
          aria-label="Select tool"
          title="Select (V): click to select, drag to turn the view"
          onClick={() => st.setTool('select')}
        >
          <Ic name="pointer" />
        </button>
        <button
          className={`nx-icon ${tool === 'move' ? 'on' : ''}`}
          role="radio"
          aria-checked={tool === 'move'}
          aria-label="Move tool"
          title="Move (M): drag a piece to move it on the floor"
          onClick={() => st.setTool('move')}
        >
          <Ic name="move" />
        </button>
      </div>
      <div className="nx-head-right">
        <button className="nx-icon" onClick={st.undo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">
          <Ic name="undo" />
        </button>
        <button className="nx-icon" onClick={st.redo} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
          <Ic name="redo" />
        </button>
        <span className={`nx-save ${status === 'saved' ? '' : status}`} title="Projects save in this browser">
          <span className="nx-dot" />
          {status === 'saved' ? 'Saved' : status === 'dirty' ? 'Saving…' : "Couldn't save"}
        </span>
        <button className="nx-icon" onClick={onTheme} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Toggle theme">
          <Ic name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="nx-btn" disabled={!canPreview} onClick={() => st.setMode(mode === 'edit' ? 'preview' : 'edit')}>
          <Ic name={mode === 'edit' ? 'eye' : 'edit'} /> {mode === 'edit' ? 'Preview' : 'Edit'}
        </button>
        <DropMenu
          className="nx-btn nx-primary"
          label="Export"
          align="right"
          trigger={
            <>
              <Ic name="download" /> Export <Ic name="chevron" />
            </>
          }
          items={[
            { icon: 'video', label: 'Video (MP4)…', disabled: pieces === 0, onClick: onExportVideo },
            'sep',
            { icon: 'download', label: `Project with animation (.${PROJECT_EXTENSION})`, disabled: pieces === 0, onClick: () => void downloadProject() },
            { icon: 'file', label: 'Plan (.json)', onClick: downloadPlan },
            { icon: 'file', label: 'LDraw (.mpd)', onClick: downloadLDraw },
          ]}
        />
      </div>
    </header>
  );
}
