import { useEffect, useState } from 'react';
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
  return (
    <div className="app">
      <TopBar
        extra={
          <button className={mode === 'preview' ? '' : 'primary'} disabled={!model.ready} onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}>
            {mode === 'edit' ? '▶ Preview' : '✎ Back to editor'}
          </button>
        }
      />
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
