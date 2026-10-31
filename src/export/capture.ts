/** Viewport capture: stills and turntable video.
 *
 * The editor's renderer is created without `preserveDrawingBuffer`, so the live
 * canvas can only be read in the same task it was drawn — which is exactly what the
 * opaque still does (render, then read). Everything that needs a different size,
 * transparency or a deterministic frame sequence renders into its own studio, using
 * the pose the live renderer is actually showing rather than a guess.
 */
import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import type { Instance } from '../model/assemble';
import {
  cameraFov, fitDistance, sphericalPosition, worldBox3,
  DEFAULT_CAMERA_SETTINGS, type CameraSettings,
} from '../anim/camera';
import { activeSceneCamera, applyCameraCrop, type SceneSetup } from '../render/sceneSetup';
import { createStudio, disposeOffscreenStudio, type RenderOptions, type Studio, type StudioLook, type Materials } from '../render/studio';
import { safeFileName } from '../ui/download';
import { encodeMp4, type ExportDeps, type FrameSampler } from './exportVideo';

export type StillType = 'image/png' | 'image/jpeg';
export type StillResult = { blob: Blob; width: number; height: number };

/** The camera pose a transparent still should reproduce, copied from the live one. */
export type StillCamera = {
  ortho: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  near: number;
  far: number;
  /** frustum height for the orthographic view */
  orthoHeight: number;
  /** the scene-camera crop, when one is active */
  view: { enabled: boolean; fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number } | null;
};

function canvasBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: StillType, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas)
    return canvas.convertToBlob({ type, quality: type === 'image/jpeg' ? quality : undefined });
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The viewport could not be captured.'))), type, quality));
}

/**
 * The viewport exactly as drawn, at `scale` times its backing-store resolution.
 * Scaling keeps the aspect ratio, so the camera needs no adjustment at all and the
 * image cannot differ from the screen.
 */
export async function captureViewportStill(
  studio: Studio, scale = 1, type: StillType = 'image/png', quality = 0.92,
): Promise<StillResult> {
  const renderer = studio.renderer;
  const canvas = renderer.domElement as HTMLCanvasElement;
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const ratio = renderer.getPixelRatio();
  const factor = scale === 2 || scale === 3 ? scale : 1;
  // The backing store already includes the device pixel ratio: keep every pixel.
  const width = Math.max(1, Math.round(canvas.width * factor));
  const height = Math.max(1, Math.round(canvas.height * factor));
  try {
    renderer.setPixelRatio(1);
    studio.setSize(width, height);
    studio.render();
    // Read in the same task as the render: without preserveDrawingBuffer the
    // buffer is only valid until the browser composites.
    const blob = await canvasBlob(canvas, type, quality);
    return { blob, width, height };
  } finally {
    renderer.setPixelRatio(ratio);
    studio.setSize(size.x, size.y);
  }
}

export type TransparentStillOpts = {
  instances: Instance[];
  width: number;
  height: number;
  /** key → matrix; null hides the piece (see BrickRenderer.readMatrices) */
  pose: ReadonlyMap<string, THREE.Matrix4 | null>;
  camera: StillCamera;
  box: THREE.Box3;
  groundY: number;
  type?: StillType;
  studioLook?: StudioLook;
  render?: RenderOptions;
  materials?: Materials;
  sceneSetup?: SceneSetup;
};

export function applyStillCamera(studio: Studio, camera: StillCamera): void {
  studio.setProjection(camera.ortho ? 'ortho' : 'perspective');
  const target = camera.ortho ? studio.ortho : studio.perspective;
  target.position.copy(camera.position);
  target.quaternion.copy(camera.quaternion);
  target.near = camera.near;
  target.far = camera.far;
  if (camera.ortho) {
    studio.setOrthoHeight(Math.max(0.001, camera.orthoHeight));
  } else {
    const perspective = target as THREE.PerspectiveCamera;
    perspective.fov = camera.fov;
    perspective.clearViewOffset();
    if (camera.view?.enabled)
      perspective.setViewOffset(camera.view.fullWidth, camera.view.fullHeight,
        camera.view.offsetX, camera.view.offsetY, camera.view.width, camera.view.height);
  }
  target.updateProjectionMatrix();
}

/**
 * A still with an alpha background, rendered offscreen at an explicit size. The
 * live pose and camera are replayed so it matches the viewport, minus the studio
 * backdrop (there is no shadow floor and no scene background).
 */
export function captureTransparentStill(opts: TransparentStillOpts, deps: ExportDeps): Promise<Blob> {
  return captureOffscreenStill(opts, deps, true);
}

/**
 * A still rendered offscreen at an explicit size from `opts.camera`, with the studio
 * backdrop and floor (or, `transparent`, on an alpha background). Used for shots
 * through a scene camera, which the viewport may not be showing.
 */
export async function captureOffscreenStill(opts: TransparentStillOpts, deps: ExportDeps, transparent = false): Promise<Blob> {
  const type = opts.type ?? 'image/png';
  const makeCanvas = deps.createCanvas ?? defaultStillCanvas;
  const canvas = makeCanvas(opts.width, opts.height);
  const studio = deps.createStudio(canvas, { preserveDrawingBuffer: true, transparent });
  try {
    // exactly the asked size: the screen's pixel ratio would scale the canvas up
    studio.renderer.setPixelRatio?.(1);
    studio.setLook?.(opts.studioLook ?? 'soft');
    if (opts.render) studio.setRenderOptions?.(opts.render);
    if (opts.materials) studio.setMaterials?.(opts.materials);
    await studio.ready?.();
    studio.setSceneSetup(opts.sceneSetup, false, null, opts.width / opts.height);
    studio.setSize(opts.width, opts.height);
    studio.bricks.setInstances(opts.instances);
    studio.bricks.setMatrices((key) => opts.pose.get(key) ?? null);
    studio.fitTo(opts.box, opts.groundY);
    applyStillCamera(studio, opts.camera);
    studio.render();
    return await canvasBlob(canvas, type, 0.92);
  } finally {
    disposeOffscreenStudio(studio);
  }
}

/**
 * The active scene camera as a still pose for an image of `aspect`, with the render
 * border's crop when "crop to border" is on — the shot the MP4 takes through it.
 * Null when the project has no usable scene camera.
 */
export function sceneCameraStill(setup: SceneSetup | undefined, aspect: number): StillCamera | null {
  const active = activeSceneCamera(setup);
  if (!active) return null;
  const position = new THREE.Vector3(...active.position);
  const target = new THREE.Vector3(...active.target);
  if (position.distanceToSquared(target) < 1e-8) return null;
  const camera = new THREE.PerspectiveCamera(active.fov, aspect, active.near, active.far);
  camera.position.copy(position);
  camera.lookAt(target);
  applyCameraCrop(camera, setup);
  const view = camera.view?.enabled ? camera.view : null;
  return {
    ortho: false, position, quaternion: camera.quaternion.clone(), fov: active.fov,
    near: active.near, far: active.far, orthoHeight: 0,
    view: view && {
      enabled: true, fullWidth: view.fullWidth, fullHeight: view.fullHeight,
      offsetX: view.offsetX, offsetY: view.offsetY, width: view.width, height: view.height,
    },
  };
}

function defaultStillCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export type TurntableOpts = {
  instances: Instance[];
  bounds: Box;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  /** degrees above the horizon; defaults to a raised three-quarter view */
  elevation?: number;
  margin?: number;
  camera?: CameraSettings;
  studioLook?: StudioLook;
  render?: RenderOptions;
  materials?: Materials;
  sceneSetup?: SceneSetup;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
};

/**
 * One full turn of the finished model. The radius is the widest fit over a whole
 * turn, so the model does not drift toward and away from the camera while it orbits.
 */
export function turntableSampler(opts: TurntableOpts): FrameSampler {
  const box = worldBox3(opts.bounds);
  const target = box.getCenter(new THREE.Vector3());
  const aspect = opts.width / opts.height;
  const settings = opts.camera ?? DEFAULT_CAMERA_SETTINGS;
  const elevation = opts.elevation ?? Math.min(45, Math.max(5, settings.buildElevation * 0.6));
  const fov = cameraFov(settings, aspect);
  let distance = 0;
  for (let i = 0; i < 8; i++) distance = Math.max(distance, fitDistance(box, fov, aspect, i * 45, elevation));
  distance *= opts.margin ?? 1.12;
  const pose = new Map(opts.instances.map((instance) => [instance.key, instance.world.clone()]));
  const get = (key: string) => pose.get(key) ?? null;
  const duration = Math.max(0.5, opts.seconds);
  return {
    duration,
    box,
    // `|| 0` keeps a ground at zero from becoming -0.
    groundY: -opts.bounds.max[1] / 20 || 0,
    at: () => get,
    camera: (seconds) => ({
      position: sphericalPosition(target, distance, settings.buildAzimuth + 360 * (seconds / duration), elevation),
      target: target.clone(),
      fov,
    }),
  };
}

export function exportTurntable(opts: TurntableOpts, deps: ExportDeps): Promise<Blob> {
  return encodeMp4({
    instances: opts.instances,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    studioLook: opts.studioLook,
    camera: opts.camera,
    sceneSetup: opts.sceneSetup,
    render: opts.render,
    materials: opts.materials,
    logo: null,
    snapSound: false,
    onProgress: opts.onProgress ?? (() => {}),
    signal: opts.signal,
  }, deps, turntableSampler(opts));
}

/** `<set> - <model> - <suffix>.<ext>`, sanitised like every other saved file. */
export function captureFileName(name: string, model: string, suffix: string, ext: string): string {
  return `${safeFileName([name, model, suffix].filter(Boolean).join(' - '))}.${ext}`;
}

const RECORDER_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** The first WebM flavour this browser can record, or null when it cannot record. */
export function recorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? null;
}

export function canRecordViewport(canvas?: HTMLCanvasElement | null): boolean {
  return !!canvas && typeof canvas.captureStream === 'function' && recorderMime() !== null;
}

/**
 * Records the live canvas — orbit, zoom, playback, whatever is on screen — through
 * `captureStream`, which reads the composited frames, so the missing
 * `preserveDrawingBuffer` does not matter.
 */
export function startViewportRecording(canvas: HTMLCanvasElement, fps: number): { mime: string; stop(): Promise<Blob> } {
  const mime = recorderMime();
  if (!mime) throw new Error('This browser cannot record the viewport.');
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
  const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
  recorder.start();
  return {
    mime,
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      for (const track of stream.getTracks()) track.stop();
      return new Blob(chunks, { type: mime });
    },
  };
}
