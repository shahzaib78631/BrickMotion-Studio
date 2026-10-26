import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { cameraAt, worldBox3 } from '../anim/camera';
import { poseAt, type Timeline } from '../anim/timeline';
import { formatAspect } from '../export/formats';
import { useAppSettings } from '../state/appSettings';
import { useStudio } from '../state/store';
import { applySceneCamera, applyCameraCrop, sceneSetupOf } from '../render/sceneSetup';
import { advancePlayback, usePlayback } from '../state/playback';
import { soundSnaps } from '../audio/snapSound';
import type { ModelState } from '../state/useModel';
import { viewportApi } from './viewportApi';

/** Plays the build animation on the editor's canvas inside the output frame (9:16, 1:1, …); the timeline below drives play and scrub. */
export function PreviewPlayer({ model, timeline: tl }: { model: ModelState; timeline: Timeline }) {
  const s = useAppSettings();
  const setup = useStudio((st) => st.plan.sceneSetup);
  // the model on screen: the whole set, or the open submodel on its own
  const asm = model.view;
  const ASPECT = formatAspect(s.format);
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);

  // take over the canvas: full assembly, own camera; restore the editor camera on exit
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio) return;
    // the preview renders through the perspective camera; if the editor was in an
    // ortho view, carry its pose over so leaving the preview restores it exactly
    if (studio.projection === 'ortho') {
      studio.perspective.position.copy(studio.ortho.position);
      studio.perspective.quaternion.copy(studio.ortho.quaternion);
    }
    const oldProjection = studio.projection;
    studio.setProjection('perspective');
    const saved = { pos: studio.perspective.position.clone(), target: viewportApi.controls?.target.clone(), fov: studio.perspective.fov,
      aspect: studio.perspective.aspect, near: studio.perspective.near, far: studio.perspective.far,
      oldProjection };
    studio.bricks.setHighlight(new Set(), 'select');
    studio.bricks.setHighlight(new Set(), 'warn');
    return () => {
      usePlayback.getState().set({ playing: false });
      studio.perspective.position.copy(saved.pos);
      studio.perspective.fov = saved.fov;
      studio.perspective.aspect = saved.aspect;
      studio.perspective.near = saved.near;
      studio.perspective.far = saved.far;
      studio.perspective.clearViewOffset();
      studio.perspective.updateProjectionMatrix();
      studio.setProjection(saved.oldProjection);
      studio.lighting.setHelpersVisible(true);
      if (saved.target && viewportApi.controls) viewportApi.controls.target.copy(saved.target);
    };
  }, []);

  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio) return;
    studio.bricks.setInstances(asm.instances);
    studio.fitTo(worldBox3(tl.sceneBox), -tl.ground / 20);
    studio.setSceneSetup(setup, false, null, ASPECT);
    const pb = usePlayback.getState();
    if (pb.t > tl.duration) pb.set({ t: tl.duration });
  }, [asm, tl, setup]);

  // render loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const placed = new Map(asm.instances.map((inst) => [inst.key, inst.world]));
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const studio = viewportApi.studio;
      const wrap = wrapRef.current;
      if (!studio || !wrap) return;
      const dt = (now - last) / 1000;
      last = now;
      const wasPlaying = usePlayback.getState().playing;
      const t = advancePlayback(dt, tl.duration);
      soundSnaps(tl, t, wasPlaying, useAppSettings.getState().snapSound);
      // the 9:16 frame fills the height (or the width on very narrow screens)
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const fh = Math.min(H, W / ASPECT);
      const fw = fh * ASPECT;
      setFrame((f) => (f.width === fw && f.height === fh ? f : { left: (W - fw) / 2, top: (H - fh) / 2, width: fw, height: fh }));
      const cam = cameraAt(tl, t, ASPECT, s.cameraFraming, s.camera);
      // A piece the timeline does not know (the plan changed under it) is shown in place rather
      // than dropped: a preview that silently draws nothing is impossible to diagnose. Pieces
      // the timeline does know still arrive, wait and hide as it says.
      const at = poseAt(tl, t);
      studio.bricks.setMatrices((key) => at(key) ?? (tl.tracks.has(key) ? null : placed.get(key) ?? null));
      studio.perspective.position.copy(cam.position);
      studio.perspective.lookAt(cam.target);
      studio.perspective.fov = cam.fov;
      studio.perspective.aspect = ASPECT;
      studio.perspective.updateProjectionMatrix();
      const sceneCamera = applySceneCamera(studio.perspective, setup);
      if (!sceneCamera) applyCameraCrop(studio.perspective, setup);
      studio.render({ x: (W - fw) / 2, y: (H - fh) / 2, width: fw, height: fh });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [asm, tl, s.cameraFraming, s.camera, ASPECT, setup]);

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!s.logo) return setLogoUrl(null);
    const u = URL.createObjectURL(s.logo);
    setLogoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [s.logo]);

  const unit = Math.min(frame.width, frame.height);
  /** A saved scene camera is meant to be the video's camera. */
  const sceneInCharge = setup?.useCameraForVideo === true && !!setup?.activeCameraId;
  /** Pieces this timeline has no track for: the plan changed under it. */
  const missingTracks = useMemo(() => asm.instances.filter((inst) => !tl.tracks.has(inst.key)).length, [asm, tl]);
  return (
    <div className="preview" ref={wrapRef}>
      <div className="frame-mask" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }} />
      {s.logoEnabled && logoUrl && (
        <img
          className="frame-logo"
          src={logoUrl}
          alt=""
          style={{
            // matches drawLogo(): sized and inset relative to the frame's short side
            width: unit * 0.22,
            left: s.logoCorner.endsWith('r') ? frame.left + frame.width - unit * (0.22 + 48 / 1080) : frame.left + (unit * 48) / 1080,
            ...(s.logoCorner.startsWith('t') ? { top: frame.top + (unit * 48) / 1080 } : { bottom: frame.top + (unit * 48) / 1080 }),
          }}
        />
      )}
      {sceneInCharge || missingTracks > 0 ? (
        <div className="preview-notes">
          {sceneInCharge && (
            <div className="preview-scene-camera" role="status">
              <span>
                The video uses the saved scene camera <b>{setup?.cameras.find((c) => c.id === setup.activeCameraId)?.name ?? 'Camera'}</b>.
                If the frame looks empty, that camera is probably inside the model or aimed away from it.
              </span>
              <div className="preview-scene-camera-actions">
                <button className="nx-btn nx-sm" onClick={() => useStudio.getState().apply((p) => ({
                  ...p,
                  sceneSetup: { ...sceneSetupOf(p.sceneSetup), useCameraForVideo: false },
                }))}>Use the video camera</button>
              </div>
            </div>
          )}
          {missingTracks > 0 && (
            <div className="preview-scene-camera" role="status">
              <span>
                <b>{missingTracks.toLocaleString()}</b> of {asm.instances.length.toLocaleString()} pieces are not in this
                timeline, so they are shown where they belong. Press <b>Play</b> in the Animation Editor to plan the build again.
              </span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
