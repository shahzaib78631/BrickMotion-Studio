import { useEffect, useState } from 'react';
import { AiDialog, type AiTab } from './ui/AiDialog';
import { AboutDialog } from './ui/AboutDialog';
import { ProjectsDialog } from './ui/ProjectsDialog';
import { SettingsDialog } from './ui/SettingsDialog';
import { initPersistence } from './state/persistence';
import { Menu } from './ui/TopBar';
import { initPartService } from './state/partService';
import { useModel } from './state/useModel';
import { Inspector } from './ui/Inspector';
import { PartsPanel } from './ui/PartsPanel';
import { PreviewPlayer } from './ui/PreviewPlayer';
import { useStudio } from './state/store';
import { StepsTimeline } from './ui/StepsTimeline';
import { TopBar } from './ui/TopBar';
import { Viewport } from './ui/Viewport';
import { WarningsList } from './ui/WarningsList';
import './ui/app.css';

function Studio() {
  const model = useModel();
  const mode = useStudio((s) => s.mode);
  const setMode = useStudio((s) => s.setMode);
  const [aiTab, setAiTab] = useState<AiTab | null>(null);
  const [dialog, setDialog] = useState<'projects' | 'settings' | 'about' | null>(null);
  return (
    <div className="app">
      <TopBar
        extra={
          <>
            <button onClick={() => setDialog('projects')}>📁 Projects</button>
            <Menu label="☰">
              <button onClick={() => setDialog('settings')}>Settings…</button>
              <button onClick={() => setDialog('about')}>About…</button>
            </Menu>
            <Menu label="✨ AI">
              <button onClick={() => setAiTab('generate')}>Generate with Claude…</button>
              <button onClick={() => setAiTab('fix')}>Fix with Claude…</button>
              <button onClick={() => setAiTab('paste')}>Paste plan…</button>
              <button onClick={() => setAiTab('copy')}>Copy AI prompt…</button>
            </Menu>
            <button className={mode === 'preview' ? '' : 'primary'} disabled={!model.ready} onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}>
              {mode === 'edit' ? '▶ Preview' : '✎ Back to editor'}
            </button>
          </>
        }
      />
      {aiTab && (
        <AiDialog
          initial={aiTab}
          warnings={model.warnings}
          onClose={() => setAiTab(null)}
          onOpenSettings={() => {
            setAiTab(null);
            setDialog('settings');
          }}
        />
      )}
      {dialog === 'projects' && <ProjectsDialog onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      <PartsPanel />
      <main className="center">
        <Viewport model={model} />
        {mode === 'preview' && <PreviewPlayer model={model} />}
      </main>
      <aside className="panel right">
        <Inspector />
        <WarningsList warnings={model.warnings} />
      </aside>
      <footer className="bottom">
        <StepsTimeline />
      </footer>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => {
    initPartService()
      .then(() => initPersistence())
      .then(() => setState('ready'))
      .catch((e: Error) => setState(e.message));
  }, []);
  if (state === 'ready') return <Studio />;
  return (
    <div className="splash">
      <h1>🧱 BrickMotion Studio</h1>
      {state === 'loading' ? <p>Loading the parts library…</p> : <p className="error">{state}</p>}
    </div>
  );
}
