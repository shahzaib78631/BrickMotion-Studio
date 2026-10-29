import { useEffect, useRef, useState } from 'react';
import { TEMPLATE_EXTENSION } from '../plan/template';
import { useStudio } from '../state/store';
import {
  applyTemplate, deleteTemplate, downloadTemplate, importTemplateFile, importTemplateId, listTemplates,
  loadTemplate, saveCurrentAsTemplate, setImportTemplate, type TemplateMeta,
} from '../state/templates';

/**
 * Project templates: save the open project's look and motion (video, staging, camera,
 * materials, sound, scene cameras and lights) without its model, then apply it to any
 * other model — by hand, or automatically to every model you import.
 */
export function TemplatesDialog({ onClose }: { onClose(): void }) {
  const planName = useStudio((s) => s.plan.name);
  const [list, setList] = useState<TemplateMeta[] | null>(null);
  const [forImports, setForImports] = useState<string | null>(null);
  const [name, setName] = useState(`${planName || 'My'} template`);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    setList(await listTemplates());
    setForImports(await importTemplateId());
  };
  useEffect(() => { void refresh(); }, []);

  const run = async (label: string, job: () => Promise<string | void>) => {
    setBusy(label);
    setNote(null);
    try {
      const done = await job();
      if (done) setNote(done);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog bm-templates" role="dialog" aria-label="Templates">
        <h2>Templates</h2>
        <p className="muted small">
          A template keeps this project&rsquo;s video, staging, camera, materials and sound settings, and its scene
          cameras, lights and render border — everything except the model. Apply it to another model and the
          cameras and lights are fitted to that model&rsquo;s size.
        </p>

        <div className="bm-template-save">
          <input value={name} aria-label="Template name" placeholder="Template name" onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!!busy || !name.trim()}
            onClick={() => run('save', async () => `Saved "${(await saveCurrentAsTemplate(name)).name}".`)}>
            Save current project as template
          </button>
        </div>

        {!list && <p className="muted">Loading…</p>}
        {list?.length === 0 && <p className="muted">No templates yet.</p>}
        <ul className="project-list">
          {list?.map((t) => (
            <li key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <div className="muted small">
                  {new Date(t.createdAt).toLocaleDateString()}
                  {forImports === t.id && ' · used for imports'}
                </div>
              </div>
              <span className="spacer" />
              <label className="small bm-template-imports" title="Apply this template automatically to every model you import">
                <input type="checkbox" checked={forImports === t.id} disabled={!!busy}
                  onChange={(e) => run('default', async () => setImportTemplate(e.target.checked ? t.id : null))} />
                For imports
              </label>
              <button disabled={!!busy} title="Apply to the open project (the scene change can be undone)"
                onClick={() => run('apply', async () => {
                  const full = await loadTemplate(t.id);
                  if (!full) throw new Error('This template could not be read.');
                  await applyTemplate(full);
                  return `Applied "${full.name}" to this project.`;
                })}>
                Apply
              </button>
              <button disabled={!!busy} title={`Download as a .${TEMPLATE_EXTENSION} file to share or back up`}
                onClick={() => run('download', async () => {
                  const full = await loadTemplate(t.id);
                  if (full) downloadTemplate(full);
                })}>
                Download
              </button>
              <button disabled={!!busy} title="Delete template"
                onClick={() => confirm(`Delete the template "${t.name}"?`) && run('delete', () => deleteTemplate(t.id))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        {note && <p className="small" role="status">{note}</p>}

        <input ref={fileRef} type="file" accept={`.${TEMPLATE_EXTENSION},.json`} hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void run('import', async () => `Added "${(await importTemplateFile(f)).name}".`);
          }} />
        <div className="actions">
          <button disabled={!!busy} onClick={() => fileRef.current?.click()}>Import template file…</button>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
