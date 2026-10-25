import * as THREE from 'three';
import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_MEDIUM, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { snapsOf, type Snap } from '../anim/snaps';
import { renderSnapTrack } from '../audio/snapSound';
import { cameraAt, cameraFov, fitDistance, sphericalPosition, worldBox3, DEFAULT_CAMERA_SETTINGS, type CamPose, type CameraFraming, type CameraSettings } from '../anim/camera';
import { buildLayerAt } from '../anim/buildLayer';
import { makeKeyframePose } from '../anim/keyframePose';
import type { StudioLook, RenderOptions } from '../render/studio';
import { applySceneCamera, applyCameraCrop, type SceneSetup } from '../render/sceneSetup';
import { poseAt, type Timeline } from '../anim/timeline';
import type { Instance } from '../model/assemble';
import type { KeyframeAnimation } from '../plan/types';
import type { createStudio } from '../render/studio';

export type LogoCorner = 'tl' | 'tr' | 'bl' | 'br';
type CommonExportOpts = {
  instances: Instance[];
  width: number;
  height: number;
  fps: number;
  studioLook?: StudioLook;
  cameraFraming?: CameraFraming;
  camera?: CameraSettings;
  sceneSetup?: SceneSetup;
  /** Edge lines and colour response; the studio's defaults when left out. */
  render?: RenderOptions;
  logo: { image: ImageBitmap; corner: LogoCorner } | null;
  snapSound?: boolean;
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
};
export type ExportOpts = CommonExportOpts & { timeline: Timeline };
/** Export the same authored object animation that the Dope Sheet displays.
 * A linked Build is evaluated underneath the authored keyframe offsets. */
export type KeyframeExportOpts = CommonExportOpts & {
  animation: KeyframeAnimation;
  editingModel: string;
  placements: ReadonlyMap<string, THREE.Matrix4>;
  buildTimeline?: Timeline | null;
};

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type ExportDeps = { createStudio: typeof createStudio; createCanvas?: (w: number, h: number) => AnyCanvas };

const LOGO_WIDTH = 0.22;
const LOGO_MARGIN = 48;
const LOGO_ALPHA = 0.9;

export const frameCount = (duration: number, fps: number) => Math.max(1, Math.ceil(duration * fps - 1e-6));
/** Both frame ends are included; export samples fractions of an animation frame
 * when the chosen output FPS differs from the authored FPS. */
export const animationDuration = (animation: KeyframeAnimation) =>
  (animation.endFrame - animation.startFrame + 1) / animation.fps;
export const animationFrameAtVideoTime = (animation: KeyframeAnimation, seconds: number) =>
  Math.min(animation.endFrame, animation.startFrame + seconds * animation.fps);

export const canExportMp4 = (width = 1080, height = 1920, fps = 30) => canEncodeVideo('avc', { width, height, frameRate: fps });
const abortError = () => new DOMException('Export cancelled', 'AbortError');

function defaultCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function drawLogo(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, img: ImageBitmap, corner: LogoCorner, w: number, h: number) {
  const unit = Math.min(w, h);
  const lw = unit * LOGO_WIDTH;
  const lh = (lw * img.height) / Math.max(1, img.width);
  const margin = (LOGO_MARGIN * unit) / 1080;
  const x = corner.endsWith('r') ? w - margin - lw : margin;
  const y = corner.startsWith('t') ? margin : h - margin - lh;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = LOGO_ALPHA;
  ctx.drawImage(img, x, y, lw, lh);
  ctx.globalAlpha = prev;
}

/** Connect clicks as audio, or null where AAC can't be encoded. */
async function snapAudio(snaps: Snap[], duration: number): Promise<AudioBuffer | null> {
  if (typeof OfflineAudioContext === 'undefined') return null;
  const ok = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false);
  if (!ok) return null;
  return renderSnapTrack(snaps, duration).catch(() => null);
}

type FrameSampler = {
  duration: number;
  box: THREE.Box3;
  groundY: number;
  at: (seconds: number) => (key: string) => THREE.Matrix4 | null;
  camera: (seconds: number, aspect: number) => CamPose;
  snaps?: Snap[];
};

/** Shared H.264 pipeline: Build and Timeline use identical encoder, lighting,
 * logo, cancellation, timestamps and video settings. Only the pose source differs. */
async function encodeMp4(opts: CommonExportOpts, deps: ExportDeps, samples: FrameSampler): Promise<Blob> {
  const { width: w, height: h, fps, signal } = opts;
  if (signal.aborted) throw abortError();
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Choose a valid FPS setting.');
  const makeCanvas = deps.createCanvas ?? defaultCanvas;
  const renderCanvas = makeCanvas(w, h);
  const composite = opts.logo ? makeCanvas(w, h) : renderCanvas;
  const ctx = opts.logo ? (composite.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null) : null;
  if (opts.logo && !ctx) throw new Error('Could not create a 2D canvas for the logo overlay.');

  const studio = deps.createStudio(renderCanvas, { preserveDrawingBuffer: true });
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  let started = false;
  try {
    studio.setLook?.(opts.studioLook ?? 'soft');
    if (opts.render) studio.setRenderOptions?.(opts.render);
    studio.setSceneSetup(opts.sceneSetup, false, null, w / h);
    studio.setSize(w, h);
    studio.bricks.setInstances(opts.instances);
    studio.fitTo(samples.box, samples.groundY);
    const source = new CanvasSource(composite, { codec: 'avc', bitrate: QUALITY_HIGH, latencyMode: 'quality' });
    output.addVideoTrack(source, { frameRate: fps });
    const sound = opts.snapSound && samples.snaps ? await snapAudio(samples.snaps, samples.duration) : null;
    const audio = sound ? new AudioBufferSource({ codec: 'aac', bitrate: QUALITY_MEDIUM }) : null;
    if (audio) output.addAudioTrack(audio);
    await output.start();
    started = true;
    const audioDone = audio && sound ? audio.add(sound) : null;
    audioDone?.catch(() => {});
    const total = frameCount(samples.duration, fps);
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw abortError();
      const seconds = Math.min(i / fps, samples.duration);
      studio.bricks.setMatrices(samples.at(seconds));
      const cam = samples.camera(seconds, w / h);
      studio.perspective.position.copy(cam.position);
      studio.perspective.lookAt(cam.target);
      studio.perspective.fov = cam.fov;
      studio.perspective.updateProjectionMatrix();
      if (!applySceneCamera(studio.perspective, opts.sceneSetup)) applyCameraCrop(studio.perspective, opts.sceneSetup);
      studio.render();
      if (opts.logo && ctx) {
        ctx.drawImage(renderCanvas as CanvasImageSource, 0, 0, w, h);
        drawLogo(ctx, opts.logo.image, opts.logo.corner, w, h);
      }
      await source.add(i / fps, 1 / fps);
      opts.onProgress(i + 1, total);
    }
    if (signal.aborted) throw abortError();
    await audioDone;
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } catch (e) {
    if (started) await output.cancel().catch(() => {});
    throw e;
  } finally {
    studio.dispose();
  }
}

/** Existing collision-certified construction video, unchanged in semantics. */
export function exportVideo(opts: ExportOpts, deps: ExportDeps): Promise<Blob> {
  const tl = opts.timeline;
  return encodeMp4(opts, deps, {
    duration: tl.duration,
    box: worldBox3(tl.sceneBox),
    groundY: -tl.ground / 20,
    at: (seconds) => poseAt(tl, seconds),
    camera: (seconds, aspect) => cameraAt(tl, seconds, aspect, opts.cameraFraming ?? 'cinematic', opts.camera),
    snaps: snapsOf(tl),
  });
}

const TO_VIEW = new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20);
/** Calculate a conservative framing envelope for manually animated motion.
 * Sample exact keyed positions, representative intermediate turns and the
 * procedural Build envelope. Bound the sample budget for complex scenes so
 * starting an export does not lock up the entire editor. */
export function keyframeSceneBounds(opts: Pick<KeyframeExportOpts, 'animation' | 'editingModel' | 'instances' | 'placements' | 'buildTimeline'>): THREE.Box3 {
  const { animation, editingModel, instances, placements, buildTimeline } = opts;
  if (buildLayerAt(animation, editingModel) && !buildTimeline)
    throw new Error('This Timeline is linked to Build, but construction planning failed. Fix the Build route, or unlink it in the Dope Sheet.');
  const sample = makeKeyframePose(instances, placements, animation, editingModel, buildTimeline);
  const keys = animation.tracks.filter((t) => t.model === editingModel)
    .flatMap((t) => Object.values(t.channels).flatMap((ks) => (ks ?? []).map((k) => k.frame)));
  const samples = new Set<number>([animation.startFrame, animation.endFrame]);
  const sorted = [...new Set(keys)].sort((a, b) => a - b);
  const every = Math.max(1, Math.ceil(sorted.length / 100));
  const representative = sorted.filter((_, i) => i === 0 || i === sorted.length - 1 || i % every === 0);
  for (const frame of representative) samples.add(frame);
  for (let i = 1; i < representative.length; i++) for (const mix of [0.25, 0.5, 0.75])
    samples.add(representative[i - 1] + (representative[i] - representative[i - 1]) * mix);
  // Uniform samples cover hand-authored bends between distant keys, including
  // the unkeyed procedural parts of a linked Build scene.
  const step = Math.max(1, Math.ceil((animation.endFrame - animation.startFrame) / 240));
  for (let frame = animation.startFrame; frame <= animation.endFrame; frame += step) samples.add(frame);
  const out = new THREE.Box3();
  const base = new Map(instances.map((inst) => [inst.key, placements.get(inst.key)?.clone().multiply(inst.world) ?? inst.world]));
  const inverse = new Map(instances.map((inst) => [inst.key, inst.world.clone().invert()]));
  const boxes = new Map(instances.map((inst) => [inst.key,
    new THREE.Box3(new THREE.Vector3(...inst.worldBox.min), new THREE.Vector3(...inst.worldBox.max))]));
  for (const frame of [...samples].sort((a, b) => a - b)) {
    const poses = sample(frame);
    for (const inst of instances) {
      const matrix = poses.has(inst.key) ? poses.get(inst.key) : base.get(inst.key);
      if (!matrix) continue;
      const delta = matrix.clone().multiply(inverse.get(inst.key)!);
      out.union(boxes.get(inst.key)!.clone().applyMatrix4(delta).applyMatrix4(TO_VIEW));
    }
  }
  if (buildLayerAt(animation, editingModel) && buildTimeline) out.union(worldBox3(buildTimeline.sceneBox));
  if (out.isEmpty()) {
    for (const inst of instances) out.union(boxes.get(inst.key)!.clone().applyMatrix4(TO_VIEW));
  }
  if (out.isEmpty()) out.set(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 5, 4));
  out.expandByScalar(Math.max(0.5, out.getSize(new THREE.Vector3()).length() * .025));
  return out;
}

/** Renders manually authored transforms, or authored offsets on top of Build,
 * without needing construction planning for static-scene keyframes. */
export async function exportKeyframeVideo(opts: KeyframeExportOpts, deps: ExportDeps): Promise<Blob> {
  if (opts.signal.aborted) return Promise.reject(abortError());
  const { animation, instances, editingModel, buildTimeline } = opts;
  const bounds = keyframeSceneBounds(opts);
  const pose = makeKeyframePose(instances, opts.placements, animation, editingModel, buildTimeline);
  const base = new Map(instances.map((inst) => [inst.key, opts.placements.get(inst.key)?.clone().multiply(inst.world) ?? inst.world]));
  const camera: CameraSettings = opts.camera ?? DEFAULT_CAMERA_SETTINGS;
  const az = camera.buildAzimuth, el = camera.buildElevation;
  const fov = cameraFov(camera, opts.width / opts.height);
  const target = bounds.getCenter(new THREE.Vector3());
  const margin = (opts.cameraFraming === 'wide' ? 1.22 : 1.08) * camera.buildMargin;
  const dist = fitDistance(bounds, fov, opts.width / opts.height, az, el) * margin;
  const cam: CamPose = { position: sphericalPosition(target, dist, az, el), target, fov };
  const layer = buildLayerAt(animation, editingModel);
  /** Motion baked from a Build (or still linked to one) follows the Build camera:
   * it frames the assembled model instead of the whole staging floor and keeps
   * the configured hero orbit. Fully hand-keyed clips stay on the stable camera. */
  const cameraAtTime = buildTimeline
    ? (seconds: number, aspect: number) => {
        const frame = animation.startFrame + seconds * animation.fps;
        const buildSeconds = layer
          ? Math.max(0, ((frame - layer.startFrame) / animation.fps) * layer.speed)
          : seconds;
        return cameraAt(buildTimeline, buildSeconds, aspect, opts.cameraFraming ?? 'cinematic', opts.camera);
      }
    : () => cam;
  const snaps = layer && buildTimeline ? snapsOf(buildTimeline).map((s) => ({
    ...s, t: (layer.startFrame - animation.startFrame) / animation.fps + s.t / layer.speed,
  })).filter((s) => s.t >= 0 && s.t < animationDuration(animation)) : undefined;
  let groundY = 0;
  if (layer && buildTimeline) groundY = -buildTimeline.ground / 20;
  else for (const inst of instances) {
    const box = new THREE.Box3(new THREE.Vector3(...inst.worldBox.min), new THREE.Vector3(...inst.worldBox.max));
    const delta = opts.placements.get(inst.key);
    if (delta) box.applyMatrix4(delta);
    box.applyMatrix4(TO_VIEW);
    groundY = Math.min(groundY, box.min.y);
  }
  return encodeMp4(opts, deps, {
    duration: animationDuration(animation),
    box: bounds,
    groundY,
    at: (seconds) => {
      const evaluated = pose(animationFrameAtVideoTime(animation, seconds));
      return (key) => evaluated.has(key) ? evaluated.get(key)! : base.get(key) ?? null;
    },
    camera: cameraAtTime,
    snaps,
  });
}
