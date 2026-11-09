/**
 * Renders a BrickMotion project's finished animation, frame by frame, with BrickLink Studio's
 * photorealistic engine (EyeSight): the project's own baked piece animation and Camera track,
 * sampled exactly the way the app's MP4 export samples them.
 *
 *   npm run render:eyesight-anim -- "Hellboy.brickmotion" --fps 30 --samples 64
 *   npm run render:eyesight-anim -- project.brickmotion --frames 0-10          # a test strip
 *   npm run render:eyesight-anim -- project.brickmotion --every 30             # one frame per second
 *   npm run render:eyesight-anim -- project.brickmotion --encode               # frames → mp4 (ffmpeg)
 *
 * Frames land in <out>/frames/frame_000000.png. Existing frames are skipped, so an
 * interrupted render resumes where it stopped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import { readProjectFile } from '../src/io/projectFile';
import { decodeTimeline } from '../src/anim/timelineCodec';
import { animationOf } from '../src/anim/keyframes';
import { makeKeyframePose } from '../src/anim/keyframePose';
import { animationDuration, animationFrameAtVideoTime, keyframeSceneBounds } from '../src/export/exportVideo';
import { cameraTrackAt } from '../src/anim/cameraTrack/sample';
import { timelineCameraContext } from '../src/anim/cameraTrack/context';
import type { CameraContext, CameraTrack } from '../src/anim/cameraTrack/types';
import { instancePlacements } from '../src/ui/modelPlacement';
import { buildCollada, type ColladaPiece } from '../src/export/collada';
import { DEFAULT_RENDER, STUDIO, loadScene, runEyesight, type RenderOpts } from './lib/eyesight';

type Args = {
  project: string; out?: string; fps: number; render: RenderOpts;
  from: number; to: number; every: number; encode: boolean; daeOnly: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { project: '', fps: 30, render: { ...DEFAULT_RENDER, samples: 64 }, from: 0, to: Infinity, every: 1, encode: false, daeOnly: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v === '--fps') a.fps = Number(argv[++i]);
    else if (v === '--width') a.render.width = Number(argv[++i]);
    else if (v === '--height') a.render.height = Number(argv[++i]);
    else if (v === '--samples') a.render.samples = Number(argv[++i]);
    else if (v === '--frames') { const [x, y] = argv[++i].split('-').map(Number); a.from = x; a.to = y ?? x; }
    else if (v === '--every') a.every = Math.max(1, Number(argv[++i]));
    else if (v === '--light') a.render.light = argv[++i];
    else if (v === '--light-rotz') a.render.lightRotZ = Number(argv[++i]);
    else if (v === '--light-intensity') a.render.lightIntensity = Number(argv[++i]);
    else if (v === '--bg') a.render.bg = [Number(argv[++i]), Number(argv[++i]), Number(argv[++i])];
    else if (v === '--encode') a.encode = true;
    else if (v === '--dae-only') a.daeOnly = true;
    else if (!v.startsWith('--')) positional.push(v);
  }
  a.project = positional[0] ?? '';
  return a;
}

const pad = (n: number) => String(n).padStart(6, '0');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error('Usage: npm run render:eyesight-anim -- <project.brickmotion> [--fps 30 --samples 64 --width 1080 --height 1920 --frames a-b --every n --encode]');
    process.exit(1);
  }
  const projectPath = resolve(args.project);
  const read = readProjectFile(readFileSync(projectPath, 'utf8'));
  if (!read.ok) { console.error(read.errors.join('\n')); process.exit(1); }
  const { plan, timelines, settings } = read;
  if (read.stale || read.skipped) console.warn(`  note: ${read.stale} stale and ${read.skipped} unreadable saved timelines were not reused`);

  const animation = animationOf(plan.animation);
  if (!animation.tracks.length) { console.error('This project has no baked animation (Timeline). Bake one in the app first.'); process.exit(1); }
  const editingModel = '';
  const saved = timelines.find((t) => t.model === editingModel);
  const buildTimeline = saved ? decodeTimeline(saved.timeline) : null;

  const { colors, geometry, asm } = await loadScene(plan);
  const instances = asm.instances.filter((i) => !i.placeholder && geometry.has(i.part));
  const placements = instancePlacements(plan, editingModel, asm);
  const base = new Map(instances.map((inst) => [inst.key, placements.get(inst.key)?.clone().multiply(inst.world) ?? inst.world]));
  const pose = makeKeyframePose(instances, placements, animation, editingModel, buildTimeline);
  const bounds = keyframeSceneBounds({ animation, editingModel, instances, placements, buildTimeline });

  // --- camera: the Camera track the app's MP4 uses, else the saved scene camera ----------------
  const tracks = plan.cameraTracks?.[editingModel];
  const track: CameraTrack | undefined = [tracks?.timeline, tracks?.build].find((t) => t?.keys.length);
  const sensorMm = settings?.video.camera?.sensorWidthMm ?? 36;
  const aspect = args.render.width / args.render.height;
  const ctx: CameraContext = timelineCameraContext(animation, bounds, buildTimeline, editingModel, aspect, sensorMm);
  const setup = plan.sceneSetup;
  const savedCam = setup?.cameras?.find((c) => c.id === setup.activeCameraId) ?? setup?.cameras?.[0];
  if (!track && !savedCam) { console.error('The project has neither a Camera track nor a saved scene camera.'); process.exit(1); }
  console.log(`… camera: ${track ? `Camera track (${track.keys.length} keys)` : `saved scene camera "${savedCam!.name}"`}`);

  const duration = animationDuration(animation);
  const total = Math.max(1, Math.ceil(duration * args.fps - 1e-6));
  const last = Math.min(args.to, total - 1);
  const frames: number[] = [];
  for (let f = args.from; f <= last; f += args.every) frames.push(f);
  console.log(`… ${duration.toFixed(2)} s at ${args.fps} fps = ${total} frames; rendering ${frames.length} (${args.render.width}×${args.render.height}, ${args.render.samples} samples, light ${args.render.light})`);

  const out = args.out ? resolve(args.out) : join(dirname(projectPath), `${basename(projectPath).replace(/\.brickmotion$/i, '')}-eyesight-anim`);
  const framesDir = join(out, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const dae = join(out, 'frame.dae');

  const started = Date.now();
  let done = 0;
  for (const f of frames) {
    const png = join(framesDir, `frame_${pad(f)}.png`);
    if (existsSync(png)) { done++; continue; }
    const seconds = f / args.fps;
    const evaluated = pose(animationFrameAtVideoTime(animation, seconds));
    const pieces: ColladaPiece[] = [];
    for (const inst of instances) {
      const world = evaluated.has(inst.key) ? evaluated.get(inst.key) : base.get(inst.key);
      if (world) pieces.push({ key: inst.key, part: inst.part, color: inst.color, world });
    }
    const shot = track ? cameraTrackAt(track, seconds, ctx)! : null;
    const camera = shot
      ? { position: shot.position, target: shot.target, fov: shot.fov, roll: shot.roll }
      : { position: new THREE.Vector3(...savedCam!.position), target: new THREE.Vector3(...savedCam!.target), fov: savedCam!.fov, roll: 0 };
    writeFileSync(dae, buildCollada({
      name: `${basename(projectPath)} frame ${f}`, pieces, geometryOf: (id) => geometry.get(id) ?? null, colors,
      camera: { ...camera, near: savedCam?.near ?? 0.05, far: savedCam?.far ?? 5000, width: args.render.width, height: args.render.height },
      matrixOrder: 'row',
    }));
    if (args.daeOnly) { console.log(`✓ ${dae} (frame ${f}, ${pieces.length} pieces)`); return; }
    await runEyesight(args.render, dae, png, true);
    done++;
    const rate = (Date.now() - started) / Math.max(1, frames.indexOf(f) + 1);
    const left = Math.max(0, frames.length - done);
    console.log(`✓ frame ${f} (${done}/${frames.length}) · ${(rate / 1000).toFixed(1)} s/frame · ~${Math.round((left * rate) / 60000)} min left`);
  }
  try { unlinkSync(dae); } catch { /* already gone */ }

  if (args.encode) {
    const mp4 = join(out, `${basename(projectPath).replace(/\.brickmotion$/i, '')}.mp4`);
    const ffmpeg = existsSync(join(STUDIO, 'ffmpeg')) ? join(STUDIO, 'ffmpeg') : 'ffmpeg';
    const r = spawnSync(ffmpeg, ['-y', '-framerate', String(args.fps / args.every), '-pattern_type', 'glob', '-i', join(framesDir, 'frame_*.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', mp4], { stdio: 'inherit' });
    if (r.status === 0) console.log(`✓ ${mp4}`); else console.error(`ffmpeg failed (${r.status})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
