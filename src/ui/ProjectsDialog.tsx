import { useEffect, useState } from 'react';
import { currentProjectId, flushSave, newProject, openProject } from '../state/persistence';
import { deleteProject, listProjects, type ProjectMeta } from '../storage/projects';

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

export function ProjectsDialog({ onClose }: { onClose(): void }) {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const refresh = () => listProjects().then(setList);
  useEffect(() => {
    void flushSave().then(refresh);
  }, []);
  const current = currentProjectId();
  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Projects">
        <h2>📁 Projects</h2>
        {!list && <p className="muted">Loading…</p>}
        {list?.length === 0 && <p className="muted">No saved projects yet.</p>}
        <ul className="project-list">
          {list?.map((p) => (
            <li key={p.id} className={p.id === current ? 'current' : ''}>
              <div>
                <strong>{p.name || 'Untitled set'}</strong>
                <div className="muted small">
                  {p.pieceCount} pieces · {ago(p.updatedAt)}
                  {p.id === current && ' · open now'}
                </div>
              </div>
              <span className="spacer" />
              <button disabled={p.id === current} onClick={() => openProject(p.id).then(onClose)}>
                Open
              </button>
              <button
                title="Delete project"
                disabled={p.id === current}
                onClick={async () => {
                  if (!confirm(`Delete "${p.name}"? This can't be undone.`)) return;
                  await deleteProject(p.id);
                  await refresh();
                }}
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={() => newProject().then(onClose)}>
            New project
          </button>
        </div>
      </div>
    </div>
  );
}
