import { useState } from 'react';
import type { NativeBridgeState } from '../hooks/useNativeBridge';
import type { NativeBuildTimeline, NativeCliResult, NativeMotionAuditResult } from '../../electron/types';

interface Props {
  bridge: NativeBridgeState;
}

export function NativeEnginePanel({ bridge }: Props) {
  const api = window.brickMotionNative;
  const { engineInfo, snapshot, playback, assemblyReport, syncing, lastError } = bridge;

  const [busy, setBusy] = useState<string | null>(null);
  const [timelineInfo, setTimelineInfo] = useState<NativeBuildTimeline | null>(null);
  const [motionAudit, setMotionAudit] = useState<NativeMotionAuditResult | null>(null);
  const [cliOutput, setCliOutput] = useState<NativeCliResult | null>(null);

  // Render still options
  const [stillWidth, setStillWidth] = useState(1920);
  const [stillHeight, setStillHeight] = useState(1080);
  const [stillSamples, setStillSamples] = useState(64);
  const [pathTrace, setPathTrace] = useState(true);

  // Sound export options
  const [soundStyle, setSoundStyle] = useState<'physics' | 'web'>('physics');
  const [webPreset, setWebPreset] = useState<'balanced' | 'product' | 'click' | 'soft' | 'synth'>('balanced');

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bm-native-panel">
      <div className="bm-native-panel-head">
        <h2>Native C++/Metal Engine</h2>
        <span className={`bm-native-badge ${engineInfo?.available ? 'ok' : 'warn'}`}>
          {engineInfo?.available ? `v${engineInfo.version}` : 'Offline'}
        </span>
      </div>

      {lastError && <div className="bm-native-alert error">{lastError}</div>}

      <section className="bm-native-card">
        <h3>Runtime Status</h3>
        <dl className="bm-native-kv">
          <dt>Addon (bmapp)</dt>
          <dd>{engineInfo?.available ? 'Loaded' : 'Not built'}</dd>
          <dt>Metal GPU</dt>
          <dd>{engineInfo?.metalAvailable ? 'Active (Apple Silicon)' : 'Unavailable'}</dd>
          <dt>Synced Pieces</dt>
          <dd>{syncing ? 'Syncing…' : snapshot ? snapshot.pieces.toLocaleString() : '—'}</dd>
          <dt>CLI Tools</dt>
          <dd>
            {[
              engineInfo?.cliAvailable.bm && 'bm',
              engineInfo?.cliAvailable.bmshot && 'bmshot',
              engineInfo?.cliAvailable.bmexport && 'bmexport',
            ]
              .filter(Boolean)
              .join(', ') || 'None found'}
          </dd>
        </dl>
        <div className="bm-native-row">
          <button
            className="bm-native-btn"
            disabled={!engineInfo?.available || !!busy}
            onClick={() => void runAction('Syncing', () => bridge.syncNow())}
          >
            Force Sync
          </button>
          <button className="bm-native-btn" onClick={() => void bridge.openNativeFile()}>
            Open Local File…
          </button>
          <button className="bm-native-btn" onClick={() => void bridge.saveNativeProject(false)}>
            Save…
          </button>
        </div>
      </section>

      <section className="bm-native-card">
        <h3>Native C++ Planner</h3>
        <p className="bm-native-hint">
          Runs the C++20 collision-certified construction planner (`bmcore`) directly in native code.
        </p>
        <div className="bm-native-row">
          <button
            className="bm-native-btn primary"
            disabled={!engineInfo?.available || !!busy}
            onClick={() =>
              void runAction('Planning', async () => {
                await bridge.requestNativePlan(false);
                if (api) {
                  const tl = await api.viewportBuildTimeline();
                  setTimelineInfo(tl);
                }
              })
            }
          >
            {busy === 'Planning' ? 'Planning…' : 'Plan Build (C++)'}
          </button>
          <button
            className="bm-native-btn"
            disabled={!engineInfo?.available || !!busy}
            onClick={() =>
              void runAction('Auditing', async () => {
                if (!api) return;
                const res = await api.auditMotion(-1);
                setMotionAudit(res);
              })
            }
          >
            Audit Motion
          </button>
        </div>
        {playback && (
          <div className="bm-native-meta">
            State: <strong>{playback.planState}</strong> · Stage: {playback.planStage} · Duration:{' '}
            {playback.duration.toFixed(2)}s
          </div>
        )}
        {timelineInfo && timelineInfo.flights.length > 0 && (
          <div className="bm-native-meta">
            {timelineInfo.flights.length} flights planned in {timelineInfo.planningMilliseconds.toFixed(0)} ms
          </div>
        )}
        {motionAudit && (
          <div className="bm-native-meta">
            Motion Audit: {motionAudit.testedFrames} frames checked ·{' '}
            <strong>{motionAudit.contacts.length}</strong> contact(s)
            {motionAudit.error ? ` · ${motionAudit.error}` : ''}
          </div>
        )}
      </section>

      <section className="bm-native-card">
        <h3>Assembly Inspection (C++)</h3>
        <p className="bm-native-hint">
          Computes LDCad + Studio joints, rigid groups, and true-surface interpenetrations via `bmcore`.
        </p>
        <button
          className="bm-native-btn"
          disabled={!engineInfo?.available || !!busy}
          onClick={() => void runAction('Inspecting', async () => void (await bridge.runAssemblyInspect()))}
        >
          {busy === 'Inspecting' ? 'Inspecting…' : 'Inspect Joints & Overlaps'}
        </button>
        {assemblyReport && (
          <dl className="bm-native-kv" style={{ marginTop: 8 }}>
            <dt>Joints</dt>
            <dd>{assemblyReport.jointCount.toLocaleString()}</dd>
            <dt>Overlaps</dt>
            <dd>{assemblyReport.overlaps.length.toLocaleString()}</dd>
            <dt>No Connectors</dt>
            <dd>{assemblyReport.withoutConnectorsCount.toLocaleString()}</dd>
          </dl>
        )}
      </section>

      <section className="bm-native-card">
        <h3>Metal Still Render (bmshot)</h3>
        <div className="bm-native-grid">
          <label>
            Width
            <input type="number" value={stillWidth} onChange={(e) => setStillWidth(Number(e.target.value) || 1920)} />
          </label>
          <label>
            Height
            <input type="number" value={stillHeight} onChange={(e) => setStillHeight(Number(e.target.value) || 1080)} />
          </label>
          <label>
            Samples
            <input type="number" value={stillSamples} onChange={(e) => setStillSamples(Number(e.target.value) || 32)} />
          </label>
          <label className="bm-native-check">
            <input type="checkbox" checked={pathTrace} onChange={(e) => setPathTrace(e.target.checked)} />
            Path Trace
          </label>
        </div>
        <button
          className="bm-native-btn primary"
          disabled={!engineInfo?.cliAvailable.bmshot || !!busy}
          onClick={() =>
            void runAction('Rendering Still', async () => {
              if (!api) return;
              await bridge.syncNow();
              const res = await api.renderNativeStill({
                width: stillWidth,
                height: stillHeight,
                samples: stillSamples,
                pathTrace,
              });
              setCliOutput(res);
            })
          }
        >
          {busy === 'Rendering Still' ? 'Rendering…' : 'Render Metal PNG…'}
        </button>
      </section>

      <section className="bm-native-card">
        <h3>Native Export (bmexport)</h3>
        <div className="bm-native-grid">
          <label>
            Sound Style
            <select value={soundStyle} onChange={(e) => setSoundStyle(e.target.value as 'physics' | 'web')}>
              <option value="physics">Physics (Hertz Impact)</option>
              <option value="web">Web Snap Library</option>
            </select>
          </label>
          {soundStyle === 'web' && (
            <label>
              Preset
              <select
                value={webPreset}
                onChange={(e) => setWebPreset(e.target.value as typeof webPreset)}
              >
                <option value="balanced">Balanced</option>
                <option value="product">Product</option>
                <option value="click">Click</option>
                <option value="soft">Soft</option>
                <option value="synth">Synth</option>
              </select>
            </label>
          )}
        </div>
        <div className="bm-native-row">
          <button
            className="bm-native-btn"
            disabled={!engineInfo?.cliAvailable.bmexport || !!busy}
            onClick={() =>
              void runAction('Exporting Sound', async () => {
                if (!api) return;
                await bridge.syncNow();
                const res = await api.exportNativeSound({ style: soundStyle, webPreset });
                setCliOutput(res);
              })
            }
          >
            {busy === 'Exporting Sound' ? 'Exporting…' : 'Export WAV Sound…'}
          </button>
          <button
            className="bm-native-btn"
            disabled={!engineInfo?.cliAvailable.bmexport || !!busy}
            onClick={() =>
              void runAction('Exporting Video', async () => {
                if (!api) return;
                await bridge.syncNow();
                const res = await api.exportNativeVideo({ width: 1920, height: 1080, fps: 30 });
                setCliOutput(res);
              })
            }
          >
            {busy === 'Exporting Video' ? 'Exporting…' : 'Export Metal Video…'}
          </button>
        </div>
      </section>

      {cliOutput && (
        <section className="bm-native-card">
          <h3>Last Native Job</h3>
          <div className={`bm-native-alert ${cliOutput.ok ? 'ok' : 'error'}`}>
            {cliOutput.ok ? 'Completed successfully' : cliOutput.stderr || `Exit code ${cliOutput.exitCode}`}
          </div>
          {cliOutput.ok && cliOutput.outputPath && api && (
            <button
              className="bm-native-btn"
              style={{ marginTop: 6 }}
              onClick={() => void api.revealInFinder(cliOutput.outputPath!)}
            >
              Reveal in Finder
            </button>
          )}
        </section>
      )}
    </div>
  );
}
