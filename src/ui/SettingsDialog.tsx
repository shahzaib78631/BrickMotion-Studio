import { useEffect, useState } from 'react';
import { AI_MODELS } from '../ai/claude';
import type { LogoCorner } from '../export/exportVideo';
import { useAppSettings } from '../state/appSettings';

const CORNERS: [LogoCorner, string][] = [
  ['tl', 'Top left'],
  ['tr', 'Top right'],
  ['bl', 'Bottom left'],
  ['br', 'Bottom right'],
];

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const s = useAppSettings();
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!s.logo) return setLogoUrl(null);
    const u = URL.createObjectURL(s.logo);
    setLogoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [s.logo]);

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Settings">
        <h2>⚙ Settings</h2>
        <h3>Claude</h3>
        <label className="field">
          API key
          <input type="password" autoComplete="off" value={s.apiKey} placeholder="sk-ant-…" onChange={(e) => s.set({ apiKey: e.target.value.trim() })} />
          <span className="muted small">Stored only in this browser. Requests go straight from this page to the Claude API.</span>
        </label>
        <label className="field">
          Model
          <select value={s.model} onChange={(e) => s.set({ model: e.target.value })}>
            {AI_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <h3>Logo</h3>
        <div className="logo-row">
          {logoUrl ? <img src={logoUrl} alt="Logo preview" className="logo-preview" /> : <div className="logo-preview muted small">No logo</div>}
          <div className="field">
            <input
              type="file"
              accept="image/png,image/svg+xml,image/jpeg,image/webp"
              aria-label="Logo file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
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
            {s.logo && (
              <button className="link" onClick={() => s.set({ logo: null, logoBitmap: null, logoEnabled: false })}>
                Remove logo
              </button>
            )}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <label className="small">
          <input type="checkbox" checked={s.logoEnabled} disabled={!s.logoBitmap} onChange={(e) => s.set({ logoEnabled: e.target.checked })} /> Show the logo on exported videos
        </label>
        <label className="field">
          Corner
          <select value={s.logoCorner} onChange={(e) => s.set({ logoCorner: e.target.value as LogoCorner })}>
            {CORNERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <h3>Video defaults</h3>
        <label className="field">
          Length: {s.targetSeconds} s
          <input type="range" min={5} max={60} value={s.targetSeconds} onChange={(e) => s.set({ targetSeconds: Number(e.target.value) })} />
        </label>
        <label className="field">
          Pieces arrive
          <select value={s.mode} onChange={(e) => s.set({ mode: e.target.value as typeof s.mode })}>
            <option value="auto">Automatically</option>
            <option value="piece">One by one</option>
            <option value="batch">In batches</option>
            <option value="step">Step by step</option>
          </select>
        </label>
        <label className="small">
          <input type="checkbox" checked={s.heroOrbit} onChange={(e) => s.set({ heroOrbit: e.target.checked })} /> End with a hero orbit
        </label>
        <div className="actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
