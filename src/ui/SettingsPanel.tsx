import { AI_MODELS } from '../ai/claude';
import { useAppSettings } from '../state/appSettings';
import { Ic } from './icons';

/** App settings: the Claude API key and model. */
export function SettingsPanel({ onAbout }: { onAbout(): void }) {
  const s = useAppSettings();
  return (
    <div className="nx-pane" aria-label="Settings">
      <div className="nx-pane-head">
        <h3>Settings</h3>
      </div>
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
