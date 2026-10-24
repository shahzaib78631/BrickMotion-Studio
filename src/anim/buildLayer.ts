import type { BuildAnimationLayer, KeyframeAnimation } from '../plan/types';

/** The Build clip is sampled in seconds and never overwritten by authored keys. */
export function buildLayerAt(animation: KeyframeAnimation | undefined, model: string): BuildAnimationLayer | undefined {
  return animation?.buildLayers?.[model];
}

/** Frame-to-time mapping shared by viewport and offline MP4 renderer. */
export function buildTimeAt(animation: KeyframeAnimation, model: string, frame: number): number | null {
  const layer = buildLayerAt(animation, model);
  return layer ? Math.max(0, ((frame - layer.startFrame) / animation.fps) * layer.speed) : null;
}

/** Link the generated Build as a procedural base for authored object-key offsets.
 * Expands the frame range instead of cutting off existing keys or the build. */
export function linkBuildLayer(animation: KeyframeAnimation, model: string, duration: number): KeyframeAnimation {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Generate a valid Build animation before linking it.');
  const current = buildLayerAt(animation, model);
  const layer = current ?? { startFrame: animation.startFrame, speed: 1 };
  const endFrame = Math.max(animation.endFrame, layer.startFrame + Math.ceil((duration / layer.speed) * animation.fps));
  if (endFrame > 20000) throw new Error('The Build exceeds the 20,000-frame scene limit. Raise playback speed or reduce the construction length.');
  return { ...animation, endFrame, buildLayers: { ...animation.buildLayers, [model]: layer } };
}

/** Non-destructive unlink; authored keyframes and other models' links survive. */
export function unlinkBuildLayer(animation: KeyframeAnimation, model: string): KeyframeAnimation {
  if (!buildLayerAt(animation, model)) return animation;
  const next = { ...animation.buildLayers };
  delete next[model];
  return { ...animation, buildLayers: Object.keys(next).length ? next : undefined };
}

/** Editing speed never discards existing keys; optionally extends the scene to
 * fit all of the regenerated build motion. */
export function updateBuildLayer(animation: KeyframeAnimation, model: string, layer: BuildAnimationLayer, duration: number): KeyframeAnimation {
  if (!Number.isInteger(layer.startFrame) || layer.startFrame < animation.startFrame || layer.startFrame > animation.endFrame)
    throw new Error('The Build start frame must lie within the scene.');
  if (!Number.isFinite(layer.speed) || layer.speed < 0.1 || layer.speed > 4)
    throw new Error('Build speed must be between 0.1x and 4x.');
  const required = layer.startFrame + Math.ceil(duration / layer.speed * animation.fps);
  if (required > 20000) throw new Error('Reduce the Build length or increase the playback speed.');
  return { ...animation, endFrame: Math.max(animation.endFrame, required), buildLayers: { ...animation.buildLayers, [model]: layer } };
}
