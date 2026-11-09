import * as THREE from 'three';
import { readProjectFile } from '../io/projectFile';
import { decodeTimeline } from '../anim/timelineCodec';
import { animationOf } from '../anim/keyframes';
import { makeKeyframePose } from '../anim/keyframePose';
import { animationDuration, animationFrameAtVideoTime, keyframeSceneBounds } from '../export/exportVideo';
import { cameraTrackAt } from '../anim/cameraTrack/sample';
import { timelineCameraContext } from '../anim/cameraTrack/context';
import { instancePlacements } from '../ui/modelPlacement';
import { assemble } from '../model/assemble';
import { ensureParts, geometryOf, getColors, initPartService, metricsOf } from '../state/partService';
import { createStudio, type Materials, type StudioLook } from '../render/studio';
import { DEFAULT_MATERIALS } from '../render/looks';
import { CALIB_PIECES, calibCamera } from './calibScene';
import { SurfaceLightingCache } from '../render/surfaceCache';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Instance } from '../model/assemble';

const QS = new URLSearchParams(location.search);
const CALIB = QS.get('scene') === 'calib';
const W = Number(QS.get('w') ?? (CALIB ? 960 : 540)), H = Number(QS.get('h') ?? (CALIB ? 540 : 960));
const st = document.getElementById('st')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;
type Shot = { position: THREE.Vector3; target: THREE.Vector3; fov: number; roll?: number };
type Scene = { instances: Instance[]; mats: Map<string, THREE.Matrix4 | null>; shot: Shot; box: THREE.Box3; ground: number; sceneSetup?: unknown };

async function loadCalib(): Promise<Scene> {
  const az = Number(QS.get('az') ?? 0);
  (document.getElementById('ref') as HTMLImageElement).src = `/_calib/calib_az${az}.png`;
  await ensureParts([...new Set(CALIB_PIECES.map((p) => p.part))]);
  const instances = CALIB_PIECES.map((p) => ({
    key: p.key, itemId: p.key, model: '', part: p.part, color: p.color, placeholder: false, grid: false,
    world: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationY(((p.rotY ?? 0) * Math.PI) / 180)),
  })) as unknown as Instance[];
  const cam = calibCamera(az);
  const shot = { position: new THREE.Vector3(...cam.position), target: new THREE.Vector3(...cam.target), fov: cam.fov };
  const ground = -24 / 20;
  return { instances, mats: new Map(instances.map((i) => [i.key, i.world] as const)), shot, ground,
    box: new THREE.Box3(new THREE.Vector3(-190 / 20, ground, -20 / 20), new THREE.Vector3(120 / 20, 80 / 20, 140 / 20)) };
}

async function loadHellboy(): Promise<Scene> {
  const read = readProjectFile(await (await fetch('/_calib/hellboy.brickmotion')).text());
  if (!read.ok) throw new Error(read.errors.join());
  const { plan, timelines } = read;
  const parts = new Set<string>();
  for (const s of [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((m) => m.steps)]) for (const p of s.pieces as { part?: string }[]) if (p.part) parts.add(p.part);
  await ensureParts([...parts]);
  const asm = assemble(plan, metricsOf, getColors());
  const instances = asm.instances.filter((i) => !i.placeholder && geometryOf(i.part));
  const animation = animationOf(plan.animation);
  const saved = timelines.find((t) => t.model === '');
  const buildTimeline = saved ? decodeTimeline(saved.timeline) : null;
  const placements = instancePlacements(plan, '', asm);
  const pose = makeKeyframePose(instances, placements, animation, '', buildTimeline);
  const bounds = keyframeSceneBounds({ animation, editingModel: '', instances, placements, buildTimeline });
  const tracks = plan.cameraTracks?.[''];
  const track = [tracks?.timeline, tracks?.build].find((t) => t?.keys.length)!;
  const ctx = timelineCameraContext(animation, bounds, buildTimeline, '', W / H, 36);
  const seconds = QS.has('t') ? Number(QS.get('t')) : animationDuration(animation) - 1e-3;
  if (QS.has('ref')) (document.getElementById('ref') as HTMLImageElement).src = `/_calib/${QS.get('ref')}`;
  const shot = cameraTrackAt(track, seconds, ctx)!;
  const evaluated = pose(animationFrameAtVideoTime(animation, seconds));
  const mats = new Map<string, THREE.Matrix4 | null>();
  for (const i of instances) mats.set(i.key, (evaluated.has(i.key) ? evaluated.get(i.key) : placements.get(i.key)?.clone().multiply(i.world) ?? i.world) ?? null);
  const b = asm.bounds!;
  const ground = -b.max[1] / 20;
  return { instances, mats, shot, ground, sceneSetup: plan.sceneSetup,
    box: new THREE.Box3(new THREE.Vector3(b.min[0] / 20, ground, -b.max[2] / 20), new THREE.Vector3(b.max[0] / 20, -b.min[1] / 20, -b.min[2] / 20)) };
}

async function main() {
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1 || W > 4096 || H > 4096) throw new Error('Invalid resolution');
  await initPartService();
  const sc = CALIB ? await loadCalib() : await loadHellboy();
  const studio = createStudio(canvas, { preserveDrawingBuffer: true });
  studio.renderer.setPixelRatio(1); studio.setSize(W, H);
  studio.setRenderOptions?.({ edges: false, linearColors: true, ao: false });
  studio.setLook?.('bricklink-white');
  studio.setMaterials?.({ ...DEFAULT_MATERIALS, ao: { enabled: false, strength: null, radius: null } });
  await studio.ready?.();
  studio.setSceneSetup(sc.sceneSetup as never, false, null, W / H);
  studio.bricks.setInstances(sc.instances);
  studio.bricks.setMatrices((key) => sc.mats.get(key) ?? null);
  studio.fitTo(sc.box, sc.ground);
  const camera = studio.perspective;
  const controls = new OrbitControls(camera, canvas);
  const reset = () => {
    camera.position.copy(sc.shot.position); camera.up.set(0, 1, 0); camera.lookAt(sc.shot.target);
    if (sc.shot.roll) camera.rotateZ(THREE.MathUtils.degToRad(sc.shot.roll));
    camera.fov = sc.shot.fov; camera.aspect = W / H; camera.updateProjectionMatrix();
    controls.target.copy(sc.shot.target); controls.update();
  };
  reset();
  const cache = new SurfaceLightingCache();
  let enabled = true;
  const strength = document.getElementById('strength') as HTMLInputElement;
  const caption = document.getElementById('caption')!;
  const bakeButton = document.getElementById('bake') as HTMLButtonElement;
  const modeButton = document.getElementById('mode') as HTMLButtonElement;
  const benchButton = document.getElementById('bench') as HTMLButtonElement;
  const resetButton = document.getElementById('reset') as HTMLButtonElement;
  const render = () => {
    cache.validate();
    cache.setStrength(enabled ? Number(strength.value) : 0);
    studio.render();
    caption.textContent = cache.status === 'ready' && enabled ? 'Cached surface lighting' : 'Base viewport (screen-space AO off)';
  };
  controls.addEventListener('change', render);
  render();
  const bake = async () => {
    bakeButton.disabled = true; benchButton.disabled = true;
    st.textContent = 'Baking on a background CPU worker; orbit remains available…';
    try {
      await cache.bake(studio.bricks.root, studio.renderer, { rays: Number(QS.get('rays') ?? 64),
        onProgress: (fraction) => { st.textContent = `Baking ${(fraction * 100).toFixed(0)}% — camera-independent visibility`; } });
      const s = cache.stats!;
      st.textContent = `${W}×${H} · ${s.samples.toLocaleString()} surface samples · ${s.rays.toLocaleString()} rays\nBake ${(s.elapsedMs / 1000).toFixed(1)} s · texture ${(s.textureBytes / 1048576).toFixed(2)} MiB · no additional draw passes\nExperimental: vertex interpolation, opaque surfaces only; no colour bounce or reflected scene geometry.`;
      modeButton.disabled = false; benchButton.disabled = false; render();
    } finally { bakeButton.disabled = false; }
  };
  bakeButton.disabled = false; resetButton.disabled = false;
  bakeButton.onclick = () => { void bake().catch((error) => { st.textContent = String(error); }); };
  modeButton.onclick = () => { enabled = !enabled; modeButton.textContent = enabled ? 'Show base viewport' : 'Show cached lighting'; render(); };
  strength.oninput = render;
  resetButton.onclick = () => { reset(); render(); };
  // A hidden browser panel may suspend rAF; timers still let the benchmark yield between batches.
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 16));
  /** Full-frame CPU+GPU completion latency, alternating batches. Not a GPU-only timer. */
  const bench = async (runs = 5, frames = 8) => {
    if (cache.status !== 'ready') throw new Error('Bake the cache before benchmarking');
    benchButton.disabled = true; bakeButton.disabled = true; controls.enabled = false;
    const rows: { mode: string; ms: number }[] = [];
    const installed = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    // True baseline uses the original material, not a shader with a zero-strength texture fetch.
    studio.bricks.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) installed.set(mesh, mesh.material);
    });
    // Cache exposes original materials for this controlled A/B, without changing cache ownership.
    for (const [mesh, material] of cache.originalMaterials()) originals.set(mesh, material);
    const gl = studio.renderer.getContext();
    const setMode = (cached: boolean) => {
      for (const [mesh, material] of (cached ? installed : originals)) mesh.material = material;
      cache.setStrength(Number(strength.value));
    };
    try {
      for (const cached of [false, true]) { setMode(cached); for (let i = 0; i < 3; i++) studio.render(); gl.finish(); await tick(); }
      for (let run = 0; run < runs; run++) {
        for (const cached of (run % 2 ? [true, false] : [false, true])) {
          setMode(cached); await tick(); gl.finish();
          const started = performance.now();
          for (let i = 0; i < frames; i++) { if (cached) cache.validate(); studio.render(); }
          gl.finish();
          rows.push({ mode: cached ? 'cached' : 'base', ms: (performance.now() - started) / frames });
        }
      }
    } finally { setMode(true); controls.enabled = true; bakeButton.disabled = false; benchButton.disabled = false; render(); }
    const median = (mode: string) => { const values = rows.filter((r) => r.mode === mode).map((r) => r.ms).sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; };
    const result = { width: W, height: H, baseMs: median('base'), cachedMs: median('cached'), rows };
    document.getElementById('timing')!.textContent = JSON.stringify(result, null, 2);
    return result;
  };
  benchButton.onclick = () => { void bench().catch((error) => { st.textContent = String(error); }); };
  (window as unknown as Record<string, unknown>).surfaceLab = { studio, cache, bake, bench, render, reset };
  st.textContent = 'Ready. Bake once, then orbit without recomputing lighting. Base and cached modes both disable screen-space AO.';
  window.addEventListener('pagehide', () => { cache.dispose(); controls.dispose(); studio.dispose(); }, { once: true });
  if (QS.has('auto')) await bake();
  if (QS.has('bench') && cache.status === 'ready') await bench();
}

main().catch((error) => { st.textContent = error instanceof Error ? error.stack ?? error.message : String(error); });
