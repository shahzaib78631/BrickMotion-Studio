import { useEffect, useState } from 'react';
import type { Timeline } from '../anim/timeline';
import type { LogoCorner } from '../export/exportVideo';
import { useAppSettings } from '../state/appSettings';
import { Ic } from './icons';

const CORNERS: [LogoCorner, string][] = [
  ['tl', 'Top left'],
  ['tr', 'Top right'],
  ['bl', 'Bottom left'],
  ['br', 'Bottom right'],
];
const MODES = [
  ['auto', 'Auto'],
  ['piece', 'One by one'],
  ['batch', 'Batches'],
  ['step', 'By step'],
] as const;

/** Video settings: length, how pieces arrive, the hero orbit and the logo. */
export function VideoPanel({ timeline, onExport }: { timeline: Timeline | null; onExport(): void }) {
  const s = useAppSettings();
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!s.logo) return setLogoUrl(null);
    const u = URL.createObjectURL(s.logo);
    setLogoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [s.logo]);
  const longer = timeline && timeline.duration > s.targetSeconds + 0.05;

  return (
    <div className="nx-pane">
      <div className="nx-pane-head">
        <h3>
          <Ic name="video" /> Video
        </h3>
        <span className="nx-chip">9:16 · 1080×1920 · 30 fps</span>
      </div>

      <label className="nx-field">
        Length <b>{s.targetSeconds} s</b>
        <input type="range" min={5} max={60} step={1} value={s.targetSeconds} onChange={(e) => s.set({ targetSeconds: Number(e.target.value) })} />
      </label>
      {timeline && (
        <p className="nx-fine">
          This set comes out at <strong>{timeline.duration.toFixed(1)} s</strong>
          {longer ? ': submodels that build one after another need the extra time.' : '.'}
        </p>
      )}

      <div className="nx-field">
        Pieces arrive
        <div className="nx-seg" role="radiogroup" aria-label="Pieces arrive">
          {MODES.map(([v, l]) => (
            <button key={v} role="radio" aria-checked={s.mode === v} className={s.mode === v ? 'on' : ''} onClick={() => s.set({ mode: v })}>
              {l}
            </button>
          ))}
        </div>
        {s.mode === 'auto' && timeline && (
          <span className="nx-hint">
            Picked: {timeline.pacing.mode === 'piece' ? 'one by one' : timeline.pacing.mode === 'step' ? 'step by step' : 'in batches'}
          </span>
        )}
      </div>

      <label className="nx-check">
        <input type="checkbox" checked={s.heroOrbit} onChange={(e) => s.set({ heroOrbit: e.target.checked })} /> End with a hero orbit
      </label>

      <div className="nx-sub">Logo</div>
      <div className="bm-logo-row">
        {logoUrl ? <img src={logoUrl} alt="Logo preview" className="logo-preview" /> : <div className="logo-preview nx-hint">No logo</div>}
        <div className="nx-grow" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="nx-btn nx-sm bm-file-btn">
            <Ic name="upload" /> {s.logo ? 'Replace logo' : 'Choose logo'}
            <input
              type="file"
              hidden
              accept="image/png,image/svg+xml,image/jpeg,image/webp"
              aria-label="Logo file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setError('');
                try {
                  const logoBitmap = await createImageBitmap(f);
                  s.set({ logo: f, logoBitmap, logoEnabled: true });
                } catch {
                  setError("That image couldn't be read. Try a PNG.");
                }
              }}
            />
          </label>
          {s.logo && (
            <button className="nx-link" style={{ alignSelf: 'flex-start' }} onClick={() => s.set({ logo: null, logoBitmap: null, logoEnabled: false })}>
              Remove logo
            </button>
          )}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <label className="nx-check">
        <input type="checkbox" checked={s.logoEnabled} disabled={!s.logoBitmap} onChange={(e) => s.set({ logoEnabled: e.target.checked })} /> Show the logo on
        the video
      </label>
      <label className="nx-field">
        Corner
        <select value={s.logoCorner} disabled={!s.logoBitmap} onChange={(e) => s.set({ logoCorner: e.target.value as LogoCorner })}>
          {CORNERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>

      <button className="nx-btn nx-primary" disabled={!timeline || timeline.units.length === 0} onClick={onExport}>
        <Ic name="download" /> Export MP4
      </button>
      <p className="nx-fine">Rendered frame by frame in this browser (Chrome), so it can take a minute.</p>
    </div>
  );
}
