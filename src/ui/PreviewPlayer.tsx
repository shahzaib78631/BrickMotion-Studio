import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { cameraAt, worldBox3 } from '../anim/camera';
import { poseAt, type Timeline } from '../anim/timeline';
import { useAppSettings } from '../state/appSettings';
import { usePlayback } from '../state/playback';
import type { ModelState } from '../state/useModel';
import { viewportApi } from './viewportApi';

const ASPECT = 9 / 16;

/** Plays the build animation on the editor's canvas inside a 9:16 frame; the timeline below drives play and scrub. */
export function PreviewPlayer({ model, timeline: tl }: { model: ModelState; timeline: Timeline }) {
  const s = useAppSettings();
  const asm = model.assembly;
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);

  // take over the canvas: full assembly, own camera; restore the editor camera on exit
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio) return;
    const saved = { pos: studio.camera.position.clone(), target: viewportApi.controls?.target.clone(), fov: studio.camera.fov };
    studio.bricks.setHighlight(new Set(), 'select');
    studio.bricks.setHighlight(new Set(), 'warn');
    return () => {
      usePlayback.getState().set({ playing: false });
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
    const pb = usePlayback.getState();
    if (pb.t > tl.duration) pb.set({ t: tl.duration });
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
      const pb = usePlayback.getState();
      let t = Math.min(pb.t, tl.duration);
      if (pb.playing) {
        t = Math.min(tl.duration, t + dt);
        pb.set({ t, playing: t < tl.duration });
      }
      // the 9:16 frame fills the height (or the width on very narrow screens)
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const fh = Math.min(H, W / ASPECT);
      const fw = fh * ASPECT;
      setFrame((f) => (f.width === fw && f.height === fh ? f : { left: (W - fw) / 2, top: (H - fh) / 2, width: fw, height: fh }));
      const cam = cameraAt(tl, t, ASPECT);
      studio.bricks.setMatrices(poseAt(tl, t));
      studio.camera.position.copy(cam.position);
      studio.camera.lookAt(cam.target);
      const half = THREE.MathUtils.degToRad(cam.fov) / 2;
      studio.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(half) * H) / fh));
      studio.camera.updateProjectionMatrix();
      studio.render();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tl]);

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!s.logo) return setLogoUrl(null);
    const u = URL.createObjectURL(s.logo);
    setLogoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [s.logo]);

  return (
    <div className="preview" ref={wrapRef}>
      <div className="frame-mask" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }} />
      {s.logoEnabled && logoUrl && (
        <img
          className="frame-logo"
          src={logoUrl}
          alt=""
          style={{
            width: frame.width * 0.22,
            left: s.logoCorner.endsWith('r') ? frame.left + frame.width * (1 - 0.22 - 48 / 1080) : frame.left + (frame.width * 48) / 1080,
            ...(s.logoCorner.startsWith('t') ? { top: frame.top + (frame.width * 48) / 1080 } : { bottom: frame.top + (frame.width * 48) / 1080 }),
          }}
        />
      )}
    </div>
  );
}
