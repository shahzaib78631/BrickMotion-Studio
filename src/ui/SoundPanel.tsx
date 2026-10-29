import { useRef } from 'react';
import { previewSnap, type SnapVoice } from '../audio/snapSound';
import { DEFAULT_SOUND, SOUND_PRESETS, SOUND_RANGES, type SoundSettings } from '../audio/soundSettings';
import { useAppSettings } from '../state/appSettings';
import { Section } from './MaterialsPanel';

/** Parts to try the sound on. */
const TEST_PARTS: { label: string; voice: SnapVoice }[] = [
  { label: '1×1 plate', voice: { count: 1, studs: 1, height: 8 } },
  { label: '2×2 brick', voice: { count: 1, studs: 4, height: 24 } },
  { label: '2×4 brick', voice: { count: 1, studs: 8, height: 24 } },
  { label: '4×8 plate', voice: { count: 1, studs: 32, height: 8 } },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `×${v.toFixed(2)}`;
const same = (a: SoundSettings, b: SoundSettings) => (Object.keys(a) as (keyof SoundSettings)[]).every((k) => a[k] === b[k]);

/** Sound: the click each time pieces connect. Playback and the MP4 both use these settings. */
export function SoundPanel() {
  const s = useAppSettings();
  const snd = s.sound;
  const lastTest = useRef(TEST_PARTS[1].voice);
  const set = (patch: Partial<SoundSettings>) => s.set({ sound: { ...snd, ...patch } });
  const test = (voice = lastTest.current, sound = useAppSettings.getState().sound) => {
    lastTest.current = voice;
    void previewSnap(voice, sound);
  };
  const preset = SOUND_PRESETS.find((p) => same(p.sound, snd));
  const off = !s.snapSound;
  const recorded = snd.source === 'recorded';

  /** A slider that plays the last test part when let go, so each change can be heard. */
  const slider = (key: keyof typeof SOUND_RANGES, label: string, show: (v: number) => string, disabled = false) => {
    const [min, max, step] = SOUND_RANGES[key];
    return (
      <label className="bm-mat-slider">{label} <span>{show(snd[key])}</span>
        <input type="range" min={min} max={max} step={step} value={snd[key]} disabled={off || disabled} aria-label={label}
          onChange={(e) => set({ [key]: Number(e.target.value) })}
          onPointerUp={() => test()} onKeyUp={(e) => e.key.startsWith('Arrow') && test()} />
      </label>
    );
  };

  return (
    <div className="nx-pane bm-materials bm-sound" aria-label="Sound">
      <div className="nx-pane-head"><h3>Sound</h3></div>

      <Section title="Snap sound" value={off ? 'Off' : preset?.label ?? 'Custom'}>
        <div className="bm-mat-row">
          <label className="nx-check"><input type="checkbox" checked={s.snapSound} onChange={(e) => s.set({ snapSound: e.target.checked })} /> Play a click when pieces connect</label>
        </div>
        {slider('volume', 'Volume', pct)}
        <div className="nx-sub">Try it</div>
        <div className="bm-sound-tests">
          {TEST_PARTS.map((p) => (
            <button key={p.label} type="button" className="nx-btn" disabled={off} onClick={() => test(p.voice)}>▶ {p.label}</button>
          ))}
        </div>
        <span className="nx-hint">Sliders play the last part you tried when you let go. Playback in the viewport and the MP4 use the same sound.</span>
      </Section>

      <Section title="Presets" value={preset?.label ?? 'Custom'}>
        <div className="bm-sound-presets">
          {SOUND_PRESETS.map((p) => (
            <button key={p.id} type="button" title={p.hint} disabled={off} className={`nx-btn${preset?.id === p.id ? ' on' : ''}`} aria-pressed={preset?.id === p.id}
              onClick={() => { s.set({ sound: p.sound }); test(undefined, p.sound); }}>{p.label}</button>
          ))}
        </div>
      </Section>

      <Section title="Click" value={recorded ? 'Recorded' : 'Synthesised'}>
        <div className="nx-seg" role="radiogroup" aria-label="Click source">
          {([['recorded', 'Recorded'], ['synth', 'Synthesised']] as const).map(([v, l]) => (
            <button key={v} role="radio" disabled={off} aria-checked={snd.source === v} className={snd.source === v ? 'on' : ''}
              onClick={() => { set({ source: v }); test(undefined, { ...snd, source: v }); }}>{l}</button>
          ))}
        </div>
        <label className="nx-field">
          Recordings
          <select aria-label="Recordings" value={snd.library} disabled={off || !recorded} onChange={(e) => { const library = e.target.value as SoundSettings['library']; set({ library }); test(undefined, { ...snd, library }); }}>
            <option value="all">All recordings</option>
            <option value="freesound">Freesound clicks (short, clean)</option>
            <option value="opengameart">OpenGameArt presses (longer, rattly)</option>
          </select>
        </label>
        {slider('click', 'Level', pct)}
        {slider('brightness', 'Brightness', (v) => `${(v / 1000).toFixed(1)} kHz`)}
        {slider('pitch', 'Pitch', times)}
        <label className="nx-check"><input type="checkbox" disabled={off} checked={snd.sizeMatch} onChange={(e) => set({ sizeMatch: e.target.checked })} /> Match the click to the part size</label>
        <label className="nx-check"><input type="checkbox" disabled={off} checked={snd.sizePitch} onChange={(e) => set({ sizePitch: e.target.checked })} /> Bigger parts sound lower</label>
        <span className="nx-hint">Brightness cuts everything below it: higher is a thinner, sharper tick; lower keeps more of the plastic's body. With size matching, small parts click once and big parts press in with several clicks.</span>
      </Section>

      <Section title="Body (the low “dhup”)" value={snd.thump === 0 ? 'Off' : pct(snd.thump)}>
        {slider('thump', 'Level', (v) => (v === 0 ? 'Off' : pct(v)))}
        {slider('thumpPitch', 'Pitch', times, snd.thump === 0)}
        {slider('thumpLength', 'Length', times, snd.thump === 0)}
        <span className="nx-hint">A low tone under each click that gives it weight, like the deep knock in product videos. Turn the level to 0 for clicks only, or lower the pitch and shorten it for a tighter knock.</span>
      </Section>

      <Section title="Space & feel" value={`Room ${pct(snd.room)}`}>
        {slider('room', 'Room echo', pct)}
        {slider('stereo', 'Stereo spread', pct)}
        {slider('variation', 'Variation', pct)}
        {slider('together', 'Pieces heard together', (v) => `${v}`)}
        <span className="nx-hint">Variation keeps a run of the same part from sounding machine-made. When several pieces land at once, up to this many are heard, each a touch later and softer.</span>
      </Section>

      <div className="bm-mat-row">
        <button type="button" className="nx-btn" disabled={same(snd, DEFAULT_SOUND)} onClick={() => { s.set({ sound: DEFAULT_SOUND }); test(undefined, DEFAULT_SOUND); }}>Reset sound to defaults</button>
      </div>
    </div>
  );
}
