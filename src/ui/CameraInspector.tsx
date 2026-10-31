/**
 * The Inspector's Camera tab: edits the selected camera key (where the camera is) or the
 * selected move (how it gets to the next key). Every change is one undo step.
 */
import { useId } from 'react';
import * as THREE from 'three';
import { selectedKeyIds, useStudio, type CameraSelection } from '../state/store';
import { useAppSettings } from '../state/appSettings';
import { choosePreset, deleteCameraKeys, setTrackOptions, setTransition, trackOf, updateCameraKey, updateCameraKeys, type TrackRef } from '../anim/cameraTrack/ops';
import { BUILT_IN_PRESETS, presetById, type TransitionPreset } from '../anim/cameraTrack/presets';
import type { CameraKey, CameraTarget, CameraTransition, CurveKind, SpeedCurve, TransitionSettings } from '../anim/cameraTrack/types';
import { viewportApi } from './viewportApi';
import './cameraTrack.css';

const CURVES: { id: CurveKind; label: string }[] = [
  { id: 'easeInOut', label: 'Ease in and out' },
  { id: 'easeIn', label: 'Ease in (starts slow)' },
  { id: 'easeOut', label: 'Ease out (lands soft)' },
  { id: 'linear', label: 'Even speed' },
  { id: 'holdThenMove', label: 'Hold, then move' },
  { id: 'snap', label: 'Snap (fast start, soft landing)' },
];
const TARGETS: { id: CameraTarget['kind']; label: string }[] = [
  { id: 'model', label: 'Whole model' },
  { id: 'build', label: 'What is being built' },
  { id: 'piece', label: 'Landing piece' },
  { id: 'point', label: 'Fixed point' },
];

function Slider({ label, value, min, max, step, onChange, fmt }: {
  label: string; value: number; min: number; max: number; step: number; onChange(v: number): void; fmt?: (v: number) => string;
}) {
  const id = useId();
  return (
    <div className="nx-field bm-cam-slider">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="bm-cam-value">{fmt ? fmt(value) : value}</span>
    </div>
  );
}

function Num({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange(v: number): void }) {
  return (
    <label className="nx-field">
      {label}
      <input type="number" min={min} max={max} step={step} value={Math.round(value * 100) / 100}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }} />
    </label>
  );
}

function CurveFields({ name, curve, onChange }: { name: string; curve: SpeedCurve; onChange(c: SpeedCurve): void }) {
  return (
    <>
      <label className="nx-field">{name}
        <select value={curve.kind} onChange={(e) => onChange({ ...curve, kind: e.target.value as CurveKind })}>
          {CURVES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>
      {curve.kind !== 'linear' && <Slider label={`${name} strength`} value={curve.strength} min={0} max={1} step={0.05} onChange={(strength) => onChange({ ...curve, strength })} fmt={(v) => `${Math.round(v * 100)}%`} />}
    </>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const deg = (v: number) => `${Math.round(v)}°`;

/** What differs between several keys, by the name the panel shows it under. */
function differences(ks: CameraKey[]): string[] {
  const same = (f: (k: CameraKey) => unknown) => ks.every((x) => JSON.stringify(f(x)) === JSON.stringify(f(ks[0])));
  const checks: [string, (k: CameraKey) => unknown][] = [
    ['Aim', (k) => k.target], ['Angle', (k) => k.azimuth], ['Height', (k) => k.elevation], ['Distance', (k) => k.distance],
    ['Roll', (k) => k.roll], ['Lens', (k) => k.lensMm], ['Focus', (k) => k.focus], ['Blur', (k) => k.blur],
  ];
  return checks.filter(([, f]) => !same(f)).map(([n]) => n);
}

/** One key, or several chosen together: the values shown are the last-clicked key's, and a change sets it on all. */
function KeyPanel({ refT, k, ids = [k.id], all = [k] }: { refT: TrackRef; k: CameraKey; ids?: string[]; all?: CameraKey[] }) {
  const st = useStudio.getState;
  const many = ids.length > 1;
  const set = (patch: Partial<Omit<CameraKey, 'id'>>) => st().apply((p) => (many
    ? updateCameraKeys(p, refT, ids, patch as Partial<Omit<CameraKey, 'id' | 't'>>)
    : updateCameraKey(p, refT, k.id, patch)));
  const differ = many ? differences(all) : [];
  const setTarget = (kind: CameraTarget['kind']) => {
    if (kind !== 'point') return set({ target: { kind } as CameraTarget });
    const at = viewportApi.controls?.target ?? new THREE.Vector3();
    set({ target: { kind: 'point', at: [at.x, at.y, at.z] } });
  };
  return (
    <>
      <section className="bm-inspector-section">
        {many ? <>
          <h4>{ids.length} camera keys</h4>
          <p className="bm-cam-hint">
            Showing the key at {k.t.toFixed(2)} s. A change here is made on all {ids.length} keys.
            {differ.length > 0 && <> {differ.join(', ')} {differ.length === 1 ? 'differs' : 'differ'} between them.</>}
          </p>
          <button type="button" className="nx-btn nx-sm bm-danger" onClick={() => {
            st().apply((p) => deleteCameraKeys(p, refT, ids));
            st().selectCamera(null);
          }}>Delete {ids.length} camera keys</button>
        </> : <h4>Camera key · {k.t.toFixed(2)} s{k.origin === 'auto' ? ' · automatic' : ''}</h4>}
        <label className="nx-field">Aim at
          <select value={k.target.kind} onChange={(e) => setTarget(e.target.value as CameraTarget['kind'])}>
            {TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <Slider label="Angle around" value={k.azimuth} min={-180} max={180} step={1} onChange={(azimuth) => set({ azimuth })} fmt={deg} />
        <Slider label="Height" value={k.elevation} min={-85} max={89} step={1} onChange={(elevation) => set({ elevation })} fmt={deg} />
        <label className="nx-field bm-cam-check">
          <input type="checkbox" checked={k.distance.fit} aria-label="Auto-fit distance"
            onChange={(e) => set({ distance: e.target.checked ? { fit: true, margin: 1.15 } : { fit: false, value: 30 } })} />
          Auto-fit distance
        </label>
        {k.distance.fit
          ? <Slider label="Framing margin" value={k.distance.margin} min={0.6} max={3} step={0.01} onChange={(margin) => set({ distance: { fit: true, margin } })} fmt={(v) => `${v.toFixed(2)}×`} />
          : <Num label="Distance (studs)" value={k.distance.value} min={0.5} max={2000} step={0.5} onChange={(value) => set({ distance: { fit: false, value } })} />}
        <Slider label="Dutch roll" value={k.roll} min={-45} max={45} step={1} onChange={(roll) => set({ roll })} fmt={deg} />
      </section>
      <section className="bm-inspector-section">
        <h4>Lens</h4>
        <Num label="Lens (mm)" value={k.lensMm} min={12} max={300} step={1} onChange={(lensMm) => set({ lensMm })} />
        <label className="nx-field bm-cam-check">
          <input type="checkbox" checked={k.focus === 'target'} onChange={(e) => set({ focus: e.target.checked ? 'target' : 0.5 })} />
          Focus on the target
        </label>
        {k.focus !== 'target' && <Slider label="Focus depth" value={k.focus} min={0} max={1} step={0.01} onChange={(focus) => set({ focus })} fmt={pct} />}
        <Slider label="Background blur" value={k.blur} min={0} max={1} step={0.01} onChange={(blur) => set({ blur })} fmt={pct} />
      </section>
    </>
  );
}

function MovePanel({ refT, tr, presets, gap }: { refT: TrackRef; tr: CameraTransition; presets: readonly TransitionPreset[]; gap: number }) {
  const st = useStudio.getState;
  const s = tr.settings;
  const set = (patch: Partial<TransitionSettings>) => st().apply((p) => setTransition(p, refT, tr.from, { settings: { ...s, ...patch } }));
  const choose = (id: string) => {
    const preset = presetById(id, presets);
    st().apply((p) => choosePreset(p, refT, tr.from, preset, viewDistance()));
  };
  const save = () => {
    const name = window.prompt('Name this camera move', `${presetById(tr.preset, presets).label} (mine)`)?.trim();
    if (!name) return;
    const preset: TransitionPreset = { id: `user-${Date.now().toString(36)}`, label: name, hint: 'Saved from the Camera inspector', settings: structuredClone(s) };
    const app = useAppSettings.getState();
    app.set({ cameraPresets: [...app.cameraPresets, preset] });
    st().apply((p) => setTransition(p, refT, tr.from, { preset: preset.id }));
  };
  const known = presets.some((p) => p.id === tr.preset) || BUILT_IN_PRESETS.some((p) => p.id === tr.preset);
  return (
    <>
      <section className="bm-inspector-section">
        <h4>Camera move{tr.origin === 'auto' ? ' · automatic' : ''}</h4>
        <label className="nx-field">Preset
          <select value={known ? tr.preset : 'glide'} onChange={(e) => choose(e.target.value)}>
            <optgroup label="Built in">
              {BUILT_IN_PRESETS.map((p) => <option key={p.id} value={p.id} title={p.hint}>{p.label}</option>)}
            </optgroup>
            {presets.length > 0 && (
              <optgroup label="Saved">
                {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <p className="bm-cam-hint">{presetById(tr.preset, presets).hint}
          {presetById(tr.preset, presets).key && <> · Choosing it sets the end key from the start key.</>}</p>
        <label className="nx-field bm-cam-check"><input type="checkbox" checked={s.cut} onChange={(e) => set({ cut: e.target.checked })} /> Hard cut</label>
        {!s.cut && <>
          <label className="nx-field bm-cam-check"><input type="checkbox" checked={s.flowThrough} onChange={(e) => set({ flowThrough: e.target.checked })} /> Flow through keys (no stop)</label>
          {!s.flowThrough && <CurveFields name="Speed" curve={s.curve} onChange={(curve) => set({ curve })} />}
          {!s.flowThrough && gap > 0 && (
            <Slider label="Turn in the last" value={Math.min(s.turnLast ?? 0, gap)} min={0} max={Math.round(gap * 100) / 100} step={0.05}
              onChange={(v) => set({ turnLast: v > 0 ? v : undefined })} fmt={(v) => (v > 0 ? `${v.toFixed(2)} s` : 'whole move')} />
          )}
          <label className="nx-field">Path
            <select value={s.path} onChange={(e) => set({ path: e.target.value as TransitionSettings['path'] })}>
              <option value="arc">Arc around the target</option>
              <option value="straight">Straight line (truck / dolly)</option>
            </select>
          </label>
          <label className="nx-field">Orbit direction
            <select value={s.orbit} onChange={(e) => set({ orbit: e.target.value as TransitionSettings['orbit'] })}>
              <option value="shortest">Shortest way</option>
              <option value="cw">Clockwise</option>
              <option value="ccw">Counter-clockwise</option>
            </select>
          </label>
          {s.orbit !== 'shortest' && <Num label="Extra turns" value={s.extraTurns} min={0} max={5} step={1} onChange={(extraTurns) => set({ extraTurns: Math.round(extraTurns) })} />}
          <Slider label="Overshoot" value={s.overshoot} min={0} max={1} step={0.01} onChange={(overshoot) => set({ overshoot })} fmt={pct} />
          <Slider label="Motion blur" value={s.motionBlur} min={0} max={1} step={0.01} onChange={(motionBlur) => set({ motionBlur })} fmt={pct} />
          <Slider label="Handheld shake" value={s.shake.amount} min={0} max={3} step={0.05} onChange={(amount) => set({ shake: { ...s.shake, amount } })} fmt={(v) => v.toFixed(2)} />
          {s.shake.amount > 0 && <Slider label="Shake speed" value={s.shake.frequency} min={0.1} max={4} step={0.05} onChange={(frequency) => set({ shake: { ...s.shake, frequency } })} fmt={(v) => `${v.toFixed(2)} Hz`} />}
        </>}
      </section>
      {!s.cut && !s.flowThrough && (
        <details className="bm-inspector-section bm-cam-advanced">
          <summary>Advanced: separate aim and lens timing</summary>
          <label className="nx-field bm-cam-check"><input type="checkbox" checked={!!s.aimCurve} onChange={(e) => set({ aimCurve: e.target.checked ? { ...s.curve } : undefined })} /> Aim has its own timing</label>
          {s.aimCurve && <CurveFields name="Aim" curve={s.aimCurve} onChange={(aimCurve) => set({ aimCurve })} />}
          <label className="nx-field bm-cam-check"><input type="checkbox" checked={!!s.lensCurve} onChange={(e) => set({ lensCurve: e.target.checked ? { ...s.curve } : undefined })} /> Lens and focus have their own timing</label>
          {s.lensCurve && <CurveFields name="Lens" curve={s.lensCurve} onChange={(lensCurve) => set({ lensCurve })} />}
        </details>
      )}
      <section className="bm-inspector-section">
        <button type="button" className="nx-btn nx-sm" onClick={save}>Save as preset…</button>
      </section>
    </>
  );
}

/** Roughly how far the viewport camera is from what it looks at (for truck and pedestal slides). */
function viewDistance(): number {
  const cam = viewportApi.studio?.camera, target = viewportApi.controls?.target;
  return cam && target ? cam.position.distanceTo(target) : 100;
}

/** Seconds between the two keys of a move. */
function moveGap(track: { keys: { id: string; t: number }[] } | undefined, tr: CameraTransition): number {
  const a = track?.keys.find((k) => k.id === tr.from), b = track?.keys.find((k) => k.id === tr.to);
  return a && b ? Math.max(0, b.t - a.t) : 0;
}

/** The Camera tab's content for the current camera selection. */
export function CameraInspector() {
  const sel: CameraSelection | null = useStudio((s) => s.cameraSelection);
  const model = useStudio((s) => s.editingModel);
  const plan = useStudio((s) => s.plan);
  const presets = useAppSettings((s) => s.cameraPresets);
  if (!sel) return <p className="bm-cam-hint">Click a camera key or move on the Camera row of the timeline to edit it.</p>;
  const refT: TrackRef = { model, clock: sel.clock };
  const track = trackOf(plan, refT);
  const k = sel.kind === 'key' ? track?.keys.find((x) => x.id === sel.id) : undefined;
  const ids = selectedKeyIds(sel, sel.clock).filter((id) => track?.keys.some((x) => x.id === id));
  const all = (track?.keys ?? []).filter((x) => ids.includes(x.id));
  const tr = sel.kind === 'transition' ? track?.transitions.find((x) => x.from === sel.id) : undefined;
  return (
    <div className="bm-cam-inspector">
      {k && <KeyPanel refT={refT} k={k} ids={ids.length ? ids : [k.id]} all={all.length ? all : [k]} />}
      {tr && <MovePanel refT={refT} tr={tr} presets={presets} gap={moveGap(track, tr)} />}
      {!k && !tr && <p className="bm-cam-hint">That camera key is gone. Pick another one on the Camera row.</p>}
      {track && (
        <section className="bm-inspector-section">
          <h4>Whole track</h4>
          <Slider label="Motion blur when still" value={track.shutter} min={0} max={1} step={0.01}
            onChange={(shutter) => useStudio.getState().apply((p) => setTrackOptions(p, refT, { shutter }))} fmt={pct} />
        </section>
      )}
    </div>
  );
}
