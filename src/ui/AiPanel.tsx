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
import { Ic, type IconName } from './icons';
import { pieceCount } from './Toolbar';

export type AiTab = 'generate' | 'fix' | 'paste' | 'copy';

const TABS: [AiTab, string][] = [
  ['generate', 'Generate'],
  ['fix', 'Fix'],
  ['paste', 'Paste'],
  ['copy', 'Prompt'],
];
const HINT: Record<AiTab, [IconName, string]> = {
  generate: ['ai', 'Describe a set and Claude designs it, step by step.'],
  fix: ['wand', 'Claude repairs the set using the checks and your note.'],
  paste: ['paste', 'Load a plan from ChatGPT, Claude.ai or a file.'],
  copy: ['copy', 'Copy a prompt for any chat assistant, then paste its answer under Paste.'],
};

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

/** The AI side panel: generate, fix, paste or copy a prompt. */
export function AiPanel({ warnings, onOpenSettings }: { warnings: Warning[]; onOpenSettings?(): void }) {
  const [tab, setTab] = useState<AiTab>('generate');
  const [done, setDone] = useState('');
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
      if (loadPlan(result, keepName)) setDone(`Loaded “${result.name}”.`);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof AiError ? e.message : `Something went wrong: ${(e as Error).message}`);
    } finally {
      if (abort.current === ac) setBusySince(null);
    }
  };

  const needKey = (
    <p className="nx-fine">
      Add your Claude API key in Settings first.{' '}
      {onOpenSettings && (
        <button className="nx-link" onClick={onOpenSettings}>
          Open Settings
        </button>
      )}
    </p>
  );

  const busy = busySince !== null;
  const [hintIcon, hint] = HINT[tab];
  return (
    <div className="nx-pane" aria-label="AI">
      <div className="nx-pane-head">
        <h3>
          <Ic name="ai" /> AI build plans
        </h3>
      </div>
      <div className="nx-seg" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'on' : ''}
            disabled={busy}
            onClick={() => (setTab(id), setError(''), setDone(''))}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="nx-fine bm-hint-row">
        <Ic name={hintIcon} /> {hint}
      </p>

      {tab === 'generate' && (
        <>
          <label className="nx-field">
            Describe the set
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="A tiny orange seaplane with twin floats and a striped tail"
              disabled={busy}
              rows={5}
            />
          </label>
          <label className="nx-field">
            Max pieces <b>{maxPieces}</b>
            <input type="range" min={5} max={400} step={5} value={maxPieces} onChange={(e) => setMaxPieces(Number(e.target.value))} disabled={busy} />
          </label>
          {!apiKey && needKey}
        </>
      )}

      {tab === 'fix' && (
        <>
          {!canFix && <p className="nx-fine">Fix works on sets built on the stud grid (made here or by AI). Imported LDraw models can't be fixed with AI.</p>}
          <label className="nx-field">
            What should change? (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Make the wings longer and fix the floating pieces"
              disabled={busy}
              rows={4}
            />
          </label>
          <div className="nx-card">
            <div className="nx-card-title">
              Checks sent along <span className="nx-count">{warnings.length}</span>
            </div>
            {warnings.length === 0 ? (
              <span className="nx-hint">None — the set passes every check.</span>
            ) : (
              <ul className="warn-list">
                {warnings.slice(0, 30).map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
                {warnings.length > 30 && <li className="nx-hint">…and {warnings.length - 30} more</li>}
              </ul>
            )}
          </div>
          {!apiKey && needKey}
        </>
      )}

      {tab === 'paste' && (
        <label className="nx-field">
          Paste a plan
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"name": "…", "steps": [ … ]}' rows={12} className="bm-mono" />
        </label>
      )}

      {tab === 'copy' && (
        <>
          <label className="nx-field">
            Set idea
            <input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="A mini fighter jet with swept wings" />
          </label>
          {copied && <textarea readOnly value={copied} rows={8} className="bm-mono" onFocus={(e) => e.target.select()} />}
        </>
      )}

      {busy && (
        <p className="nx-fine">
          <span className="spinner" /> Claude is designing… <Elapsed since={busySince!} />
        </p>
      )}
      {error && (
        <p className="error" style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </p>
      )}
      {done && !busy && (
        <p className="bm-ok">
          <Ic name="check" /> {done}
        </p>
      )}

      <div className="nx-row">
        {busy && (
          <button className="nx-btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
        {tab === 'generate' && (
          <button
            className="nx-btn nx-primary nx-grow"
            disabled={busy || !apiKey || !idea.trim()}
            onClick={() => run(buildGenerateMessage(idea, { maxPieces }), false)}
          >
            <Ic name="ai" /> Generate
          </button>
        )}
        {tab === 'fix' && (
          <button className="nx-btn nx-primary nx-grow" disabled={busy || !apiKey || !canFix} onClick={() => run(buildFixMessage(plan, warnings, note), true)}>
            <Ic name="wand" /> Fix the set
          </button>
        )}
        {tab === 'paste' && (
          <button
            className="nx-btn nx-primary nx-grow"
            disabled={!pasted.trim()}
            onClick={() => {
              const r = parsePastedPlan(pasted);
              if (!r.ok) return setError(r.error);
              setError('');
              if (loadPlan(r.plan)) setDone(`Loaded “${r.plan.name}”.`);
            }}
          >
            Load plan
          </button>
        )}
        {tab === 'copy' && (
          <button
            className="nx-btn nx-primary nx-grow"
            disabled={!idea.trim()}
            onClick={async () => {
              const { palette, colors } = await promptParts();
              const text = buildCopyPrompt(palette, colors, idea);
              setCopied(text);
              await navigator.clipboard.writeText(text).catch(() => setError('Could not copy automatically. Select the text below and copy it.'));
            }}
          >
            <Ic name="copy" /> {copied ? 'Copied — copy again' : 'Copy prompt'}
          </button>
        )}
      </div>
    </div>
  );
}
