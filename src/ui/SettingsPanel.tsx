import { AI_MODELS } from '../ai/claude';
import { useAppSettings } from '../state/appSettings';
import { ACCENTS, SURFACES, resolveMode, useTheme, type ThemeMode } from '../state/theme';
import { Ic, type IconName } from './icons';

const MODES: { id: ThemeMode; label: string; icon: IconName }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'System', icon: 'view' },
];

/** Light/dark/system, the accent colour and the surface tone. */
function Appearance() {
  const t = useTheme();
  const dark = resolveMode(t.mode) === 'dark';
  return (
    <>
      <div className="nx-sub">Appearance</div>
      <div className="bm-theme-modes" role="radiogroup" aria-label="Colour mode">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={t.mode === m.id} className={t.mode === m.id ? 'on' : ''} onClick={() => t.set({ mode: m.id })}>
            <Ic name={m.icon} /> {m.label}
          </button>
        ))}
      </div>
      <div className="bm-theme-label">Accent</div>
      <div className="bm-theme-accents" role="radiogroup" aria-label="Accent colour">
        {ACCENTS.map((a) => (
          <button key={a.id} role="radio" aria-checked={t.accent === a.id} title={a.label} aria-label={a.label}
            className={t.accent === a.id ? 'on' : ''} style={{ ['--sw' as string]: dark ? a.dark : a.light }} onClick={() => t.set({ accent: a.id })}>
            {t.accent === a.id && <Ic name="check" />}
          </button>
        ))}
      </div>
      <div className="bm-theme-label">Surfaces</div>
      <div className="bm-theme-surfaces" role="radiogroup" aria-label="Surface tone">
        {SURFACES.map((sf) => {
          const [bg, panel] = dark ? sf.dark : sf.light;
          return (
            <button key={sf.id} role="radio" aria-checked={t.surface === sf.id} title={sf.hint} className={t.surface === sf.id ? 'on' : ''} onClick={() => t.set({ surface: sf.id })}>
              <span className="bm-theme-swatch" style={{ background: bg }}><i style={{ background: panel }} /><b /></span>
              {sf.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** App settings: appearance, the Claude API key and model, viewport options. */
export function SettingsPanel({ onAbout }: { onAbout(): void }) {
  const s = useAppSettings();
  return (
    <div className="nx-pane" aria-label="Settings">
      <div className="nx-pane-head">
        <h3>Settings</h3>
      </div>
      <Appearance />
      <div className="nx-sub">Claude</div>
      <label className="nx-field">
        API key
        <input type="password" autoComplete="off" value={s.apiKey} placeholder="sk-ant-…" onChange={(e) => s.set({ apiKey: e.target.value.trim() })} />
      </label>
      <p className="nx-fine">Stored only in this browser. Requests go straight from this page to the Claude API.</p>
      <label className="nx-field">
        Model
        <select value={s.model} onChange={(e) => s.set({ model: e.target.value })}>
          {AI_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <p className="nx-fine">The logo, video length and arrival style are under Video.</p>
      <div className="nx-sub">Viewport</div>
      <label className="nx-check">
        <input type="checkbox" checked={s.showSelectionBar}
          onChange={(e) => s.set({ showSelectionBar: e.currentTarget.checked })} />
        Show the selection toolbar
      </label>
      <p className="nx-fine">The floating quick-action bar (Make Submodule, Extract, Group…) that appears over the model when parts are selected. Turn it off if it covers the build.</p>
      <div className="nx-sub">App</div>
      <button className="nx-btn" onClick={onAbout}>
        <Ic name="info" /> About and credits
      </button>
    </div>
  );
}
