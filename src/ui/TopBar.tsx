import { useRef, useState, type ReactNode } from 'react';
import { exportLDraw } from '../io/ldrawExport';
import { planToJson, readPlanFile } from '../io/planFile';
import { ensureIds } from '../plan/ids';
import { getColors, metricsOf } from '../state/partService';
import { newProject } from '../state/persistence';
import { useStudio } from '../state/store';
import { saveBlob, safeFileName } from './download';

export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu" onMouseLeave={() => setOpen(false)}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label} ▾
      </button>
      {open && (
        <div className="menu-items" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function pieceCount(plan = useStudio.getState().plan): number {
  return [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((s) => s.steps)].reduce((n, s) => n + s.pieces.length, 0);
}

export function TopBar({ extra }: { extra?: ReactNode }) {
  const plan = useStudio((s) => s.plan);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const st = useStudio.getState();
  const fileRef = useRef<HTMLInputElement>(null);

  const importFile = async (f: File) => {
    const r = readPlanFile(await f.text(), f.name);
    if (!r.ok) return alert(`Couldn't open ${f.name}:\n\n${r.errors.slice(0, 8).join('\n')}`);
    if (pieceCount() > 0 && !confirm('Replace the current set with this file? (You can undo.)')) return;
    st.setPlan(ensureIds(r.plan));
    st.setEditingModel('');
  };

  return (
    <header className="topbar">
      <span className="logo">🧱 BrickMotion</span>
      <input className="title" value={plan.name} aria-label="Set name" onChange={(e) => st.apply((p) => ({ ...p, name: e.target.value }))} />
      <button title="Start a new project (the current one stays saved)" onClick={() => void newProject()}>
        New
      </button>
      <button onClick={() => fileRef.current?.click()}>Import…</button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.ldr,.mpd"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f);
          e.target.value = '';
        }}
      />
      <Menu label="Export">
        <button onClick={() => saveBlob(`${safeFileName(plan.name)}.plan.json`, new Blob([planToJson(plan)], { type: 'application/json' }))}>
          Plan (.json)
        </button>
        <button
          onClick={() =>
            saveBlob(
              `${safeFileName(plan.name)}.mpd`,
              new Blob([exportLDraw(plan, metricsOf, getColors())], {
                type: 'text/plain',
              }),
            )
          }
        >
          LDraw (.mpd)
        </button>
      </Menu>
      <span className="sep" />
      <button onClick={st.undo} disabled={!canUndo} title="Undo (⌘Z)">
        ↶
      </button>
      <button onClick={st.redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
        ↷
      </button>
      <span className="spacer" />
      {extra}
    </header>
  );
}
