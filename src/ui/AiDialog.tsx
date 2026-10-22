import { useEffect, useRef, useState } from 'react';
import { AiError, generatePlan } from '../ai/claude';
import { PALETTE, paletteEntries } from '../ai/palette';
import { parsePastedPlan } from '../ai/parsePasted';
import { buildCopyPrompt, buildFixMessage, buildGenerateMessage, buildSystemPrompt } from '../ai/prompt';
import type { Warning } from '../model/validate';
import { isGrid, type Plan } from '../plan/types';
import { useAppSettings } from '../state/appSettings';
import { ensureParts, getColors, metricsOf, partName } from '../state/partService';
import { useStudio } from '../state/store';
import { pieceCount } from './TopBar';

export type AiTab = 'generate' | 'fix' | 'paste' | 'copy';

const TABS: [AiTab, string][] = [
  ['generate', 'Generate'],
  ['fix', 'Fix with AI'],
  ['paste', 'Paste plan'],
  ['copy', 'Copy AI prompt'],
];

async function promptParts() {
  await ensureParts(PALETTE);
  return { palette: paletteEntries(PALETTE, metricsOf, partName), colors: getColors().values() };
}

const allGrid = (p: Plan) => [...p.steps, ...Object.values(p.submodels ?? {}).flatMap((m) => m.steps)].every((s) => s.pieces.every((i) => isGrid(i)));

/** Replaces the current plan (undoable), asking first when there is work to lose. */
function loadPlan(plan: Plan, keepName = false): boolean {
  const st = useStudio.getState();
  if (pieceCount() > 0 && !confirm('Replace the current set with the new plan? (You can undo.)')) return false;
  st.setPlan(keepName ? { ...plan, name: st.plan.name } : plan);
  st.setEditingModel('');
  return true;
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(i);
  }, []);
  return <>{Math.floor((Date.now() - since) / 1000)} s</>;
}

export function AiDialog({ initial, warnings, onClose, onOpenSettings }: { initial: AiTab; warnings: Warning[]; onClose(): void; onOpenSettings?(): void }) {
  const [tab, setTab] = useState<AiTab>(initial);
  const { apiKey, model } = useAppSettings();
  const plan = useStudio((s) => s.plan);
  const [idea, setIdea] = useState('');
  const [maxPieces, setMaxPieces] = useState(80);
  const [note, setNote] = useState('');
  const [pasted, setPasted] = useState('');
  const [busySince, setBusySince] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    void promptParts(); // warm the palette so "Copy prompt" stays within the click's clipboard permission
    return () => abort.current?.abort();
  }, []);

  const canFix = allGrid(plan) && pieceCount(plan) > 0;

  const run = async (user: string, keepName: boolean) => {
    setError('');
    const ac = new AbortController();
    abort.current = ac;
    setBusySince(Date.now());
    try {
      const { palette, colors } = await promptParts();
      const result = await generatePlan({ apiKey, model, system: buildSystemPrompt(palette, colors), user, signal: ac.signal });
      if (ac.signal.aborted) return;
      if (loadPlan(result, keepName)) onClose();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof AiError ? e.message : `Something went wrong: ${(e as Error).message}`);
    } finally {
      if (abort.current === ac) setBusySince(null);
    }
  };

  const needKey = (
    <p className="error">
      Add your Claude API key in Settings.{' '}
      {onOpenSettings && (
        <button className="link" onClick={onOpenSettings}>
          Open Settings
        </button>
      )}
    </p>
  );

  const busy = busySince !== null;
  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label="AI">
        <h2>✨ AI build plans</h2>
        <div className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} disabled={busy} onClick={() => (setTab(id), setError(''))}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'generate' && (
          <>
            <label className="field">
              Describe the set
              <textarea value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="A tiny orange seaplane with twin floats and a striped tail" disabled={busy} />
            </label>
            <label className="field">
              Max pieces
              <input type="number" min={5} max={400} value={maxPieces} onChange={(e) => setMaxPieces(Number(e.target.value) || 80)} disabled={busy} />
            </label>
            {!apiKey && needKey}
          </>
        )}

        {tab === 'fix' && (
          <>
            {!canFix && <p className="muted">Fix works on sets built on the stud grid (made here or by AI). Imported LDraw models can't be fixed with AI.</p>}
            <label className="field">
              What should change? (optional)
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Make the wings longer and fix the floating pieces" disabled={busy} />
            </label>
            <div className="small">
              <strong>Checks sent along:</strong>
              {warnings.length === 0 ? (
                <span className="muted"> none</span>
              ) : (
                <ul className="warn-list">
                  {warnings.slice(0, 30).map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                  {warnings.length > 30 && <li className="muted">…and {warnings.length - 30} more</li>}
                </ul>
              )}
            </div>
            {!apiKey && needKey}
          </>
        )}

        {tab === 'paste' && (
          <label className="field">
            Paste a plan from ChatGPT, Claude or a file
            <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"name": "…", "steps": [ … ]}' style={{ minHeight: 200 }} />
          </label>
        )}

        {tab === 'copy' && (
          <>
            <p className="muted small">Copy a prompt for any chat assistant, then paste its answer under "Paste plan".</p>
            <label className="field">
              Set idea
              <input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="A mini fighter jet with swept wings" />
            </label>
            {copied && <textarea readOnly value={copied} style={{ minHeight: 120 }} onFocus={(e) => e.target.select()} />}
          </>
        )}

        {busy && (
          <p className="muted">
            <span className="spinner" /> Claude is designing… <Elapsed since={busySince!} />
          </p>
        )}
        {error && <p className="error" style={{ whiteSpace: 'pre-wrap' }}>{error}</p>}

        <div className="actions">
          {busy ? (
            <button onClick={() => abort.current?.abort()}>Cancel</button>
          ) : (
            <button onClick={onClose}>Close</button>
          )}
          {tab === 'generate' && (
            <button className="primary" disabled={busy || !apiKey || !idea.trim()} onClick={() => run(buildGenerateMessage(idea, { maxPieces }), false)}>
              Generate
            </button>
          )}
          {tab === 'fix' && (
            <button className="primary" disabled={busy || !apiKey || !canFix} onClick={() => run(buildFixMessage(plan, warnings, note), true)}>
              Fix
            </button>
          )}
          {tab === 'paste' && (
            <button
              className="primary"
              disabled={!pasted.trim()}
              onClick={() => {
                const r = parsePastedPlan(pasted);
                if (!r.ok) return setError(r.error);
                if (loadPlan(r.plan)) onClose();
              }}
            >
              Load
            </button>
          )}
          {tab === 'copy' && (
            <button
              className="primary"
              disabled={!idea.trim()}
              onClick={async () => {
                const { palette, colors } = await promptParts();
                const text = buildCopyPrompt(palette, colors, idea);
                setCopied(text);
                await navigator.clipboard.writeText(text).catch(() => setError('Could not copy automatically. Select the text below and copy it.'));
              }}
            >
              {copied ? 'Copied ✓ Copy again' : 'Copy prompt'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
