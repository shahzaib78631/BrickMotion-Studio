import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeVideo } from 'mediabunny';
import { cameraAt, worldBox3 } from '../anim/camera';
import { poseAt, type Timeline } from '../anim/timeline';
import type { Instance } from '../model/assemble';
import type { createStudio } from '../render/studio';

export type LogoCorner = 'tl' | 'tr' | 'bl' | 'br';
export type ExportOpts = {
  timeline: Timeline;
  instances: Instance[];
  width: number;
  height: number;
  fps: number;
  logo: { image: ImageBitmap; corner: LogoCorner } | null;
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
};
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type ExportDeps = { createStudio: typeof createStudio; createCanvas?: (w: number, h: number) => AnyCanvas };

const LOGO_WIDTH = 0.22;
const LOGO_MARGIN = 48;
const LOGO_ALPHA = 0.9;

export const frameCount = (duration: number, fps: number) => Math.max(1, Math.ceil(duration * fps - 1e-6));

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
  const lw = w * LOGO_WIDTH;
  const lh = (lw * img.height) / Math.max(1, img.width);
  const x = corner.endsWith('r') ? w - LOGO_MARGIN - lw : LOGO_MARGIN;
  const y = corner.startsWith('t') ? LOGO_MARGIN : h - LOGO_MARGIN - lh;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = LOGO_ALPHA;
  ctx.drawImage(img, x, y, lw, lh);
  ctx.globalAlpha = prev;
}

/** Renders the timeline frame by frame into an H.264 MP4. */
export async function exportVideo(opts: ExportOpts, deps: ExportDeps): Promise<Blob> {
  const { timeline: tl, width: w, height: h, fps, signal } = opts;
  if (signal.aborted) throw abortError();
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Choose a valid FPS setting.');
  const makeCanvas = deps.createCanvas ?? defaultCanvas;
  const renderCanvas = makeCanvas(w, h);
  // With no logo, encode directly from the WebGL canvas. The old full-HD GPU
  // readback to a second 2D canvas on EVERY frame was a major export bottleneck.
  const composite = opts.logo ? makeCanvas(w, h) : renderCanvas;
  const ctx = opts.logo ? (composite.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null) : null;
  if (opts.logo && !ctx) throw new Error('Could not create a 2D canvas for the logo overlay.');

  const studio = deps.createStudio(renderCanvas, { preserveDrawingBuffer: true });
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  let started = false;
  try {
    studio.setSize(w, h);
    studio.bricks.setInstances(opts.instances);
    studio.fitTo(worldBox3(tl.sceneBox), -tl.ground / 20);
    const source = new CanvasSource(composite, { codec: 'avc', bitrate: QUALITY_HIGH, latencyMode: 'quality' });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    started = true;
    const total = frameCount(tl.duration, fps);
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw abortError();
      const t = Math.min(i / fps, tl.duration);
      studio.bricks.setMatrices(poseAt(tl, t));
      const cam = cameraAt(tl, t, w / h);
      studio.camera.position.copy(cam.position);
      studio.camera.lookAt(cam.target);
      studio.camera.fov = cam.fov;
      studio.camera.updateProjectionMatrix();
      studio.render();
      if (opts.logo && ctx) {
        ctx.drawImage(renderCanvas as CanvasImageSource, 0, 0, w, h);
        drawLogo(ctx, opts.logo.image, opts.logo.corner, w, h);
      }
      await source.add(i / fps, 1 / fps);
      opts.onProgress(i + 1, total);
    }
    if (signal.aborted) throw abortError();
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } catch (e) {
    if (started) await output.cancel().catch(() => {});
    throw e;
  } finally {
    studio.dispose();
  }
}
