import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { worldBox3 } from '../anim/camera';
import {
  canRecordViewport, captureFileName, captureOffscreenStill, captureTransparentStill, captureViewportStill, exportTurntable,
  sceneCameraStill, startViewportRecording, type StillCamera, type StillType,
} from '../export/capture';
import { canExportMp4 } from '../export/exportVideo';
import { capturePathTracedStill } from '../export/pathTracedStill';
import { buildCollada, type ColladaPiece } from '../export/collada';
import { getColors, geometryOf } from '../state/partService';
import { poseAt } from '../anim/timeline';
import { planTimeline } from '../state/timelineService';
import { sceneOf } from '../render/looks';
import { FPS_OPTIONS } from '../export/frameRates';
import { VIDEO_FORMATS, type VideoFormat } from '../export/formats';
import { activeSceneCamera } from '../render/sceneSetup';
import { createStudio, type Studio } from '../render/studio';
import { animOptions, useAppSettings } from '../state/appSettings';
import { useStudio } from '../state/store';
import type { ModelState } from '../state/useModel';
import { saveBlob } from './download';
import { Ic } from './icons';
import { PaneHead } from './PaneHead';
import { viewportApi } from './viewportApi';

/** How long a live recording may run before it stops itself. */
const RECORD_LIMIT_MS = 60_000;
const SCALES = [1, 2, 3] as const;

/** Sizes offered for a transparent still: the video formats, and each at 2×. */
const STILL_SIZES = (Object.keys(VIDEO_FORMATS) as VideoFormat[]).flatMap((key) => {
  const { width, height } = VIDEO_FORMATS[key];
  return [
    { key: `${key}:1`, label: `${width} × ${height} (${key})`, width, height },
    { key: `${key}:2`, label: `${width * 2} × ${height * 2} (${key} at 2×)`, width: width * 2, height: height * 2 },
  ];
});

const liveCamera = (studio: Studio): StillCamera => {
  const camera = studio.camera;
  const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
  const view = !ortho && (camera as THREE.PerspectiveCamera).view?.enabled
    ? (camera as THREE.PerspectiveCamera).view!
    : null;
  return {
    ortho,
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    fov: (camera as THREE.PerspectiveCamera).fov ?? 30,
    near: camera.near,
    far: camera.far,
    orthoHeight: ortho ? (camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom : 0,
    view: view && {
      enabled: view.enabled, fullWidth: view.fullWidth, fullHeight: view.fullHeight,
      offsetX: view.offsetX, offsetY: view.offsetY, width: view.width, height: view.height,
    },
  };
};

/**
 * Viewport capture tools: an exact still, a transparent still for compositing, a
 * clipboard copy, a deterministic turntable video and a live recording of the
 * canvas. Everything saves through the same download helper as the other exports.
 */
export function CapturePanel({ model }: { model: ModelState }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const settings = useAppSettings();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [scale, setScale] = useState<number>(1);
  const [type, setType] = useState<StillType>('image/png');
  const [transparent, setTransparent] = useState(false);
  const [stillSize, setStillSize] = useState(STILL_SIZES[0].key);
  const [format, setFormat] = useState<VideoFormat>(settings.format);
  const [daeBusy, setDaeBusy] = useState<'model' | 'animation' | null>(null);
  const [fps, setFps] = useState<number>(settings.fps);
  const [seconds, setSeconds] = useState(6);
  const [elevation, setElevation] = useState(28);
  const [busy, setBusy] = useState<'still' | 'transparent' | 'turntable' | 'final' | null>(null);
  const [finalSamples, setFinalSamples] = useState(256);
  const [finalSize, setFinalSize] = useState(STILL_SIZES[0].key);
  const [finalAlpha, setFinalAlpha] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [mp4, setMp4] = useState<boolean | null>(null);
  const [recording, setRecording] = useState<{ stop(): Promise<Blob>; startedAt: number; mime: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  /** where stills are taken from: what the viewport shows, or the active scene camera */
  const [source, setSource] = useState<'viewport' | 'camera'>('viewport');
  const [notice, setNotice] = useState('');
  const abort = useRef<AbortController | null>(null);

  // The renderer is a live singleton, so pick the canvas up after mount. When the app opens
  // on this panel the viewport may not have created it yet: keep looking until it has.
  useEffect(() => {
    let frame = 0;
    const find = () => {
      const found = (viewportApi.studio?.renderer.domElement ?? null) as HTMLCanvasElement | null;
      if (found) setCanvas(found);
      else frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, []);

  const video = VIDEO_FORMATS[format];
  const sceneCamera = activeSceneCamera(plan.sceneSetup);
  const fromCamera = source === 'camera' && !!sceneCamera;
  // through the camera, stills come out at the video's output size (times the scale)
  const output = VIDEO_FORMATS[settings.format];
  /** The camera a still is taken from, framed for an image of `aspect`. */
  const stillCamera = (studio: Studio, aspect: number): StillCamera => {
    if (!fromCamera) return liveCamera(studio);
    const shot = sceneCameraStill(plan.sceneSetup, aspect);
    if (!shot) throw new Error('The scene camera has no usable view: set a camera in Scene first.');
    return shot;
  };
  const size = STILL_SIZES.find((entry) => entry.key === stillSize) ?? STILL_SIZES[0];
  const stillSizePx = useMemo(() => fromCamera
    ? { width: output.width * scale, height: output.height * scale }
    : { width: Math.max(1, Math.round((canvas?.width ?? 1) * scale)), height: Math.max(1, Math.round((canvas?.height ?? 1) * scale)) },
  [canvas, scale, fromCamera, output.width, output.height]);

  useEffect(() => {
    let alive = true;
    canExportMp4(video.width, video.height, fps).then((ok) => alive && setMp4(ok)).catch(() => alive && setMp4(false));
    return () => { alive = false; };
  }, [video.width, video.height, fps]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed(Date.now() - recording.startedAt), 200);
    return () => clearInterval(id);
  }, [recording]);

  const deps = { createStudio };
  const name = (suffix: string, ext: string) => captureFileName(plan.name, editingModel, suffix, ext);
  const stillExt = type === 'image/jpeg' ? 'jpg' : 'png';

  /** The still as chosen: the viewport's own pixels, or rendered through the scene camera. */
  const takeStill = async (studio: Studio, as: StillType) => {
    if (!fromCamera) return captureViewportStill(studio, scale, as);
    const bounds = model.view.bounds ?? model.assembly.bounds;
    if (!bounds) throw new Error('This model has nothing to capture yet.');
    const { width, height } = stillSizePx;
    const blob = await captureOffscreenStill({
      instances: model.view.instances, width, height,
      pose: studio.bricks.readMatrices(),
      camera: stillCamera(studio, width / height),
      box: worldBox3(bounds), groundY: -bounds.max[1] / 20,
      type: as, studioLook: settings.studioLook,
      render: { edges: settings.edgeLines, linearColors: settings.linearColors },
      materials: settings.materials, sceneSetup: plan.sceneSetup,
    }, deps);
    return { blob, width, height };
  };

  const saveStill = async () => {
    setError(''); setNotice('');
    const studio = viewportApi.studio;
    if (!studio) return setError('The viewport is not ready yet.');
    setBusy('still');
    try {
      const { blob, width, height } = await takeStill(studio, type);
      saveBlob(name(fromCamera ? 'camera' : 'capture', stillExt), blob);
      setNotice(`Saved a ${width} × ${height} ${stillExt.toUpperCase()} ${fromCamera ? `through ${sceneCamera!.name}` : 'of the viewport'}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  };

  const saveTransparent = async () => {
    setError(''); setNotice('');
    const studio = viewportApi.studio;
    if (!studio) return setError('The viewport is not ready yet.');
    const bounds = model.view.bounds ?? model.assembly.bounds;
    if (!bounds) return setError('This model has nothing to capture yet.');
    setBusy('transparent');
    try {
      const blob = await captureTransparentStill({
        instances: model.view.instances,
        width: size.width,
        height: size.height,
        pose: studio.bricks.readMatrices(),
        camera: stillCamera(studio, size.width / size.height),
        box: worldBox3(bounds),
        groundY: -bounds.max[1] / 20,
        type: 'image/png',
        studioLook: settings.studioLook,
        render: { edges: settings.edgeLines, linearColors: settings.linearColors },
        materials: settings.materials,
        sceneSetup: plan.sceneSetup,
      }, deps);
      saveBlob(name(fromCamera ? 'camera-transparent' : 'capture-transparent', 'png'), blob);
      setNotice(`Saved a transparent ${size.width} × ${size.height} PNG.`);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  };

  const copyStill = async () => {
    setError(''); setNotice('');
    const studio = viewportApi.studio;
    if (!studio) return setError('The viewport is not ready yet.');
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      return setError('This browser cannot copy images to the clipboard.');
    }
    setBusy('still');
    try {
      const { blob } = await takeStill(studio, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setNotice(`Copied the ${fromCamera ? `${sceneCamera!.name} view` : 'viewport image'} to the clipboard.`);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  };

  const renderTurntable = async () => {
    setError(''); setNotice(''); setProgress(null);
    const bounds = model.assembly.bounds;
    if (!bounds) return setError('This model has nothing to capture yet.');
    const ac = new AbortController();
    abort.current = ac;
    setBusy('turntable');
    try {
      const blob = await exportTurntable({
        instances: model.assembly.instances,
        bounds,
        width: video.width,
        height: video.height,
        fps,
        seconds,
        elevation,
        camera: settings.camera,
        studioLook: settings.studioLook,
        render: { edges: settings.edgeLines, linearColors: settings.linearColors },
        materials: settings.materials,
        sceneSetup: plan.sceneSetup,
        signal: ac.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      }, deps);
      saveBlob(name('turntable', 'mp4'), blob);
      setNotice(`Saved a ${seconds}s turntable at ${video.width} × ${video.height}.`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(null); setProgress(null); abort.current = null;
    }
  };

  const renderFinal = async () => {
    setError(''); setNotice(''); setProgress(null);
    const studio = viewportApi.studio;
    if (!studio) return setError('The viewport is not ready yet.');
    const bounds = model.view.bounds ?? model.assembly.bounds;
    if (!bounds) return setError('This model has nothing to capture yet.');
    const out = STILL_SIZES.find((entry) => entry.key === finalSize) ?? STILL_SIZES[0];
    const ac = new AbortController();
    abort.current = ac;
    setBusy('final');
    const started = performance.now();
    try {
      const blob = await capturePathTracedStill({
        instances: model.view.instances,
        width: out.width,
        height: out.height,
        pose: studio.bricks.readMatrices(),
        camera: stillCamera(studio, out.width / out.height),
        box: worldBox3(bounds),
        groundY: -bounds.max[1] / 20,
        type: 'image/png',
        studioLook: settings.studioLook,
        render: { edges: settings.edgeLines, linearColors: settings.linearColors },
        materials: settings.materials,
        sceneSetup: plan.sceneSetup,
        samples: finalSamples,
        transparent: finalAlpha,
        signal: ac.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      }, deps);
      saveBlob(name('final-render', 'png'), blob);
      setNotice(`Saved a path-traced ${out.width} × ${out.height} PNG (${finalSamples} samples, ${Math.round((performance.now() - started) / 1000)}s).`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(null); setProgress(null); abort.current = null;
    }
  };

  const stopRecording = async () => {
    const current = recording;
    if (!current) return;
    setRecording(null); setElapsed(0);
    try {
      const blob = await current.stop();
      if (!blob.size) return setError('The recording was empty.');
      saveBlob(name('recording', 'webm'), blob);
      setNotice('Saved the viewport recording.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startRecording = () => {
    setError(''); setNotice('');
    if (!canvas) return setError('The viewport is not ready yet.');
    try {
      const started = { ...startViewportRecording(canvas, fps), startedAt: Date.now() };
      setRecording(started);
      setElapsed(0);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // A recording stops itself so a forgotten tab cannot run forever.
  useEffect(() => {
    if (recording && elapsed >= RECORD_LIMIT_MS) void stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, recording]);

  const recordable = canRecordViewport(canvas);
  const working = busy !== null;
  const clipboard = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;


  /** A camera for the .dae: the viewport's pose, aimed at the model. */
  const colladaCamera = (width: number, height: number) => {
    const studio = viewportApi.studio;
    if (!studio) return undefined;
    const cam = studio.camera as THREE.PerspectiveCamera;
    const bounds = model.view.bounds ?? model.assembly.bounds;
    const center = bounds
      ? new THREE.Vector3((bounds.min[0] + bounds.max[0]) / 40, -(bounds.min[1] + bounds.max[1]) / 40, -(bounds.min[2] + bounds.max[2]) / 40)
      : new THREE.Vector3();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const distance = Math.max(1, cam.position.distanceTo(center));
    return { position: cam.position.clone(), target: cam.position.clone().addScaledVector(dir, distance), fov: cam.fov ?? 30, near: cam.near, far: cam.far, width, height };
  };

  /** The current look's three lamps, as COLLADA lights. */
  const rigLights = () => {
    const look = sceneOf(settings.studioLook);
    const lamps: { name: string; dir: readonly [number, number, number]; size: number; intensity: number }[] = [
      { name: 'Key', dir: look.keyDirection ?? [-0.5, 1.2, 0.7], size: 0.5, intensity: look.key },
      { name: 'Fill', dir: look.fillDirection ?? [0.8, 1.2, -0.9], size: 0.8, intensity: look.fill },
    ];
    if (look.rim) lamps.push({ name: 'Rim', dir: look.rimDirection ?? [0.5, 1.2, -1.1], size: 0.4, intensity: look.rim });
    return lamps;
  };

  const exportPieces = (): ColladaPiece[] =>
    model.assembly.instances.filter((i) => !i.placeholder).map((i) => ({ key: i.key, part: i.part, color: i.color, world: i.world }));

  const saveColladaModel = () => {
    setError(''); setNotice('');
    const pieces = exportPieces();
    if (!pieces.length) return setError('This model has nothing to export yet.');
    const out = STILL_SIZES.find((entry) => entry.key === finalSize) ?? STILL_SIZES[0];
    try {
      const text = buildCollada({ name: plan.name, pieces, geometryOf, colors: getColors(), camera: colladaCamera(out.width, out.height), lights: rigLights() });
      saveBlob(name('model', 'dae'), new Blob([text], { type: 'model/vnd.collada+xml' }));
      setNotice(`Saved a COLLADA model (.dae): ${pieces.length} pieces, ${Math.round(text.length / 1024)} KB.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveColladaAnimation = async () => {
    setError(''); setNotice('');
    const pieces = exportPieces();
    if (!pieces.length) return setError('This model has nothing to export yet.');
    setDaeBusy('animation');
    try {
      const timeline = await planTimeline(plan, editingModel, animOptions(settings, plan.sceneSetup), 'export');
      const out = STILL_SIZES.find((entry) => entry.key === finalSize) ?? STILL_SIZES[0];
      const text = buildCollada({
        name: plan.name, pieces, geometryOf, colors: getColors(), camera: colladaCamera(out.width, out.height), lights: rigLights(),
        animation: {
          fps: settings.fps, duration: timeline.duration,
          sample: (t) => {
            const pose = poseAt(timeline, t);
            const map = new Map<string, THREE.Matrix4 | null>();
            for (const piece of pieces) map.set(piece.key, pose(piece.key));
            return map;
          },
        },
      });
      saveBlob(name('animation', 'dae'), new Blob([text], { type: 'model/vnd.collada+xml' }));
      setNotice(`Saved a COLLADA animation (.dae): ${pieces.length} pieces, ${timeline.duration.toFixed(1)} s at ${settings.fps} fps, ${Math.round(text.length / 1024)} KB.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDaeBusy(null);
    }
  };

  return (
    <div className="nx-pane">
      <PaneHead id="capture" title="Capture"
        help="Save a still of exactly what the viewport shows or through the scene camera, copy it, render a deterministic 360° turntable MP4, or record the live viewport. Stills use the viewport's own pixels; transparent stills are rendered offscreen with an alpha background." />

      {error && <p className="bm-spot-error" role="alert">{error}</p>}
      {notice && <p className="nx-hint" role="status">{notice}</p>}

      <section className="bm-capture-group" aria-label="Capture from">
        <h4>Capture from</h4>
        <div className="bm-capture-row" role="radiogroup" aria-label="Capture from">
          <button type="button" role="radio" aria-checked={!fromCamera} className={`nx-btn${!fromCamera ? ' bm-capture-on' : ''}`}
            disabled={working} onClick={() => setSource('viewport')}>Viewport</button>
          <button type="button" role="radio" aria-checked={fromCamera} className={`nx-btn${fromCamera ? ' bm-capture-on' : ''}`}
            disabled={working || !sceneCamera} title={sceneCamera ? undefined : 'Add a camera in Scene first'}
            onClick={() => setSource('camera')}><Ic name="camera" /> {sceneCamera?.name ?? 'Camera'}</button>
        </div>
        <p className="nx-hint">
          {!sceneCamera
            ? 'Add a camera from the viewport\'s Scene menu to capture through it.'
            : fromCamera
              ? `Stills, transparent stills and final renders are taken through ${sceneCamera.name}, framed like the video (${settings.format}${plan.sceneSetup?.cropToRegion && plan.sceneSetup.region ? ', cropped to the render border' : ''}), whatever the viewport shows.`
              : 'Stills, transparent stills and final renders are taken from what the viewport shows.'}
        </p>
      </section>

      <section className="bm-capture-group" aria-label="Still image">
        <h4><Ic name="camera" /> Still image</h4>
        <p className="nx-hint">{fromCamera
          ? `Through ${sceneCamera!.name} at the video size (${output.width} × ${output.height}), 1×, 2× or 3×.`
          : 'The viewport as drawn, at 1×, 2× or 3× its pixel size.'}</p>
        <div className="bm-capture-row">
          {SCALES.map((value) => (
            <button key={value} type="button" className={`nx-btn${scale === value ? ' bm-capture-on' : ''}`}
              aria-pressed={scale === value} onClick={() => setScale(value)}>{value}×</button>
          ))}
          <span className="nx-hint">{stillSizePx.width} × {stillSizePx.height} px</span>
        </div>
        <label className="nx-field">File type
          <select aria-label="Still image file type" value={type} onChange={(e) => setType(e.currentTarget.value as StillType)}>
            <option value="image/png">PNG</option>
            <option value="image/jpeg">JPEG</option>
          </select>
        </label>
        <div className="bm-capture-row">
          <button type="button" className="nx-btn nx-primary" disabled={working || !canvas} onClick={() => void saveStill()}>
            {busy === 'still' ? 'Capturing…' : 'Save image'}
          </button>
          <button type="button" className="nx-btn" disabled={working || !canvas || !clipboard} onClick={() => void copyStill()}>
            Copy
          </button>
        </div>
        {!clipboard && <p className="nx-hint">Copying images needs a secure context (https or localhost).</p>}
      </section>

      <section className="bm-capture-group" aria-label="Transparent still">
        <h4>Transparent still</h4>
        <label className="nx-check">
          <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.currentTarget.checked)} />
          Transparent background
        </label>
        {transparent && (
          <>
            <p className="nx-hint">Rendered offscreen with an alpha channel from the current view; the finished model is shown, without the studio backdrop or floor shadow.</p>
            <label className="nx-field">Size
              <select aria-label="Transparent still size" value={stillSize} onChange={(e) => setStillSize(e.currentTarget.value)}>
                {STILL_SIZES.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
              </select>
            </label>
            <button type="button" className="nx-btn" disabled={working || !canvas} onClick={() => void saveTransparent()}>
              {busy === 'transparent' ? 'Rendering…' : 'Save transparent PNG'}
            </button>
          </>
        )}
      </section>

      <section className="bm-capture-group" aria-label="Final render">
        <h4>Final render (path traced)</h4>
        <p className="nx-hint">Traces real light bounces from the current view, like Blender's Cycles: soft area-light shadows, colour bleeding between parts and true reflections of the environment. Takes from a few seconds to a minute.</p>
        <div className="bm-capture-row">
          <label className="nx-field">Quality
            <select aria-label="Final render quality" value={finalSamples} disabled={working} onChange={(e) => setFinalSamples(Number(e.currentTarget.value))}>
              <option value={64}>Draft · 64 samples</option>
              <option value={256}>Good · 256 samples</option>
              <option value={1024}>Best · 1024 samples</option>
            </select>
          </label>
          <label className="nx-field">Size
            <select aria-label="Final render size" value={finalSize} disabled={working} onChange={(e) => setFinalSize(e.currentTarget.value)}>
              {STILL_SIZES.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
            </select>
          </label>
        </div>
        <label className="nx-check">
          <input type="checkbox" checked={finalAlpha} disabled={working} onChange={(e) => setFinalAlpha(e.currentTarget.checked)} />
          Transparent background (keeps the floor shadow)
        </label>
        <div className="bm-capture-row">
          <button type="button" className="nx-btn nx-primary" disabled={working || !canvas} onClick={() => void renderFinal()}>
            {busy === 'final' ? 'Rendering…' : 'Render final PNG'}
          </button>
          {busy === 'final' && <button type="button" className="nx-btn" onClick={() => abort.current?.abort()}>Cancel</button>}
          {busy === 'final' && progress && <span className="nx-hint">{Math.round((progress.done / progress.total) * 100)}%</span>}
        </div>
      </section>


      <section className="bm-capture-group" aria-label="COLLADA export">
        <h4><Ic name="download" /> COLLADA (.dae)</h4>
        <p className="nx-hint">The finished model — or the build animation as sampled keyframes — as a standard COLLADA scene with parts, colours, the camera and the studio rig. Opens in Blender, three.js or BrickLink Studio.</p>
        <div className="bm-capture-row">
          <button type="button" className="nx-btn" onClick={saveColladaModel}>Save model .dae</button>
          <button type="button" className="nx-btn" disabled={daeBusy !== null} onClick={() => void saveColladaAnimation()}>
            {daeBusy === 'animation' ? 'Planning animation…' : 'Save animation .dae'}
          </button>
        </div>
        <p className="nx-hint">The animation samples the planned build at {settings.fps} fps; pieces that never move stay static nodes.</p>
      </section>
      <section className="bm-capture-group" aria-label="Turntable video">
        <h4><Ic name="video" /> Turntable video</h4>
        <p className="nx-hint">One full turn of the finished model, rendered frame by frame.</p>
        <label className="nx-field">Size
          <select aria-label="Turntable size" value={format} onChange={(e) => setFormat(e.currentTarget.value as VideoFormat)}>
            {(Object.keys(VIDEO_FORMATS) as VideoFormat[]).map((key) => (
              <option key={key} value={key}>{VIDEO_FORMATS[key].label}</option>
            ))}
          </select>
        </label>
        <div className="bm-capture-row">
          <label className="nx-field">Seconds
            <input type="number" min={1} max={30} step={1} aria-label="Turntable seconds" value={seconds}
              onChange={(e) => setSeconds(Math.max(1, Math.min(30, Math.round(Number(e.currentTarget.value) || 1))))} />
          </label>
          <label className="nx-field">FPS
            <select aria-label="Turntable FPS" value={fps} onChange={(e) => setFps(Number(e.currentTarget.value))}>
              {FPS_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="nx-field">Elevation
            <input type="number" min={0} max={85} step={1} aria-label="Turntable elevation" value={elevation}
              onChange={(e) => setElevation(Math.max(0, Math.min(85, Math.round(Number(e.currentTarget.value) || 0))))} />
          </label>
        </div>
        {mp4 === false && <p className="nx-hint" role="alert">This browser cannot encode MP4 at {video.width} × {video.height} and {fps} fps.</p>}
        <div className="bm-capture-row">
          <button type="button" className="nx-btn nx-primary" disabled={working || mp4 !== true} onClick={() => void renderTurntable()}>
            {busy === 'turntable' ? 'Rendering…' : 'Render turntable'}
          </button>
          {busy === 'turntable' && (
            <button type="button" className="nx-btn" onClick={() => abort.current?.abort()}>Cancel</button>
          )}
          {busy === 'turntable' && progress && <span className="nx-hint">{Math.round((progress.done / progress.total) * 100)}%</span>}
        </div>
      </section>

      <section className="bm-capture-group" aria-label="Record viewport">
        <h4>Record viewport</h4>
        <p className="nx-hint">Records the canvas while you orbit, zoom or play; stops itself after {RECORD_LIMIT_MS / 1000}s. Saved as WebM.</p>
        <div className="bm-capture-row">
          <label className="nx-field">FPS
            <select aria-label="Recording FPS" value={fps} onChange={(e) => setFps(Number(e.currentTarget.value))} disabled={!!recording}>
              {FPS_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {recording
            ? <button type="button" className="nx-btn nx-primary" onClick={() => void stopRecording()}>
              Stop · {(elapsed / 1000).toFixed(1)}s
            </button>
            : <button type="button" className="nx-btn" disabled={!recordable} onClick={startRecording}>Start recording</button>}
        </div>
        {!recordable && <p className="nx-hint">This browser cannot record the canvas.</p>}
      </section>
    </div>
  );
}
