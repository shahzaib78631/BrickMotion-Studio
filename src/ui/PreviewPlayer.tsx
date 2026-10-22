import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { cameraAt, worldBox3 } from '../anim/camera';
import { buildTimeline, poseAt } from '../anim/timeline';
import { useAppSettings } from '../state/appSettings';
import { metricsOf } from '../state/partService';
import { useStudio } from '../state/store';
import type { ModelState } from '../state/useModel';
import { ExportDialog } from './ExportDialog';
import { viewportApi } from './viewportApi';

const ASPECT = 9 / 16;

/** Plays the build animation on the editor's canvas inside a 9:16 frame. */
export function PreviewPlayer({ model }: { model: ModelState }) {
  const s = useAppSettings();
  const planName = useStudio((st) => st.plan.name);
  const asm = model.assembly;
  const tl = useMemo(
    () => buildTimeline(asm, metricsOf, { targetSeconds: s.targetSeconds, heroOrbit: s.heroOrbit, mode: s.mode === 'auto' ? undefined : s.mode }),
    [asm, s.targetSeconds, s.heroOrbit, s.mode],
  );
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const tRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // take over the canvas: full assembly, own camera; restore the editor camera on exit
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio) return;
    const saved = { pos: studio.camera.position.clone(), target: viewportApi.controls?.target.clone(), fov: studio.camera.fov };
    studio.bricks.setHighlight(new Set(), 'select');
    studio.bricks.setHighlight(new Set(), 'warn');
    return () => {
      studio.camera.position.copy(saved.pos);
      studio.camera.fov = saved.fov;
      studio.camera.updateProjectionMatrix();
      if (saved.target && viewportApi.controls) viewportApi.controls.target.copy(saved.target);
    };
  }, []);

  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio) return;
    studio.bricks.setInstances(asm.instances);
    studio.fitTo(worldBox3(tl.sceneBox), -tl.ground / 20);
    tRef.current = Math.min(tRef.current, tl.duration);
    setT(tRef.current);
  }, [asm, tl]);

  // render loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const studio = viewportApi.studio;
      const wrap = wrapRef.current;
      if (!studio || !wrap) return;
      const dt = (now - last) / 1000;
      last = now;
      if (playing) {
        tRef.current = Math.min(tl.duration, tRef.current + dt);
        if (tRef.current >= tl.duration) setPlaying(false);
        setT(tRef.current);
      }
      // the 9:16 frame fills the height (or the width on very narrow screens)
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const fh = Math.min(H, W / ASPECT);
      const fw = fh * ASPECT;
      setFrame((f) => (f.width === fw && f.height === fh ? f : { left: (W - fw) / 2, top: (H - fh) / 2, width: fw, height: fh }));
      const cam = cameraAt(tl, tRef.current, ASPECT);
      studio.bricks.setMatrices(poseAt(tl, tRef.current));
      studio.camera.position.copy(cam.position);
      studio.camera.lookAt(cam.target);
      const half = THREE.MathUtils.degToRad(cam.fov) / 2;
      studio.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(half) * H) / fh));
      studio.camera.updateProjectionMatrix();
      studio.render();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tl, playing]);

  const togglePlay = () => {
    if (!playing && tRef.current >= tl.duration) tRef.current = 0;
    setPlaying(!playing);
  };
  const pieces = asm.instances.length;

  return (
    <div className="preview" ref={wrapRef}>
      <div className="frame-mask" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }} />
      <div className="preview-controls">
        <button onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <input
          type="range"
          aria-label="Scrub"
          min={0}
          max={tl.duration}
          step={1 / 30}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            tRef.current = Number(e.target.value);
            setT(tRef.current);
          }}
        />
        <span className="mono small">
          {t.toFixed(1)}s / {tl.duration.toFixed(1)}s
        </span>
        <label className="small" title="Video length">
          Length {s.targetSeconds}s
          <input type="range" min={5} max={60} step={1} value={s.targetSeconds} onChange={(e) => s.set({ targetSeconds: Number(e.target.value) })} />
        </label>
        <select aria-label="Arrival" value={s.mode} onChange={(e) => s.set({ mode: e.target.value as typeof s.mode })}>
          <option value="auto">Auto ({tl.pacing.mode})</option>
          <option value="piece">One by one</option>
          <option value="batch">Batches</option>
          <option value="step">By step</option>
        </select>
        <label className="small">
          <input type="checkbox" checked={s.heroOrbit} onChange={(e) => s.set({ heroOrbit: e.target.checked })} /> Hero orbit
        </label>
        <label className="small" title={s.logo ? '' : 'Choose a logo in Settings first'}>
          <input type="checkbox" checked={s.logoEnabled} disabled={!s.logo} onChange={(e) => s.set({ logoEnabled: e.target.checked })} /> Logo
        </label>
        <button className="primary" disabled={pieces === 0} title={pieces === 0 ? 'Add some pieces first' : 'Export MP4'} onClick={() => setExporting(true)}>
          ⬇ Export MP4
        </button>
      </div>
      {exporting && (
        <ExportDialog
          name={planName}
          timeline={tl}
          instances={asm.instances}
          logo={s.logoEnabled && s.logo ? { image: s.logo, corner: s.logoCorner } : null}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
