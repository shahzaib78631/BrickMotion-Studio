/**
 * Dev-only: Cycles-like rendering in a live WebGPU path tracer, instead of the
 * viewport's WebGL rasteriser. Real light transport — bounce light, soft area-light
 * shadows, glossy reflections of the actual scene — accumulated progressively. The
 * camera is interactive; while it moves the tracer shows a fast low-resolution preview,
 * and once it settles the full-resolution image converges, as Blender's Cycles viewport does.
 *
 * This is the first brick of the new render core (PathCache): the substrate is WebGPU
 * compute (three-gpu-pathtracer's wavefront tracer, one BVH per part into a TLAS), not
 * WebGL2 fragment shaders. Neural radiance caching and ReSTIR layer on top of it.
 *
 * Two scenes:
 *   default          the calibration set, beside its EyeSight reference (/_calib/calib_az<az>.png)
 *   ?project=1       a real project model, finishing pose, beside its EyeSight still (/_calib/ref_end.png)
 *
 * Query knobs: az, w, h, key, envint, bounces, env, hdr, lowres, delay, maxsamples.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import { WebGPUPathTracer, OIDNDenoiser, FSRUpscaler, RANDOM_BLUE_DITHER } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-webgpu';
import { Upscaler } from '@pmndrs/upscaler';
import { assemble } from '../model/assemble';
import { readProjectFile } from '../io/projectFile';
import { brickHex } from '../render/materials';
import { ensureParts, geometryOf, getColors, initPartService, metricsOf } from '../state/partService';
import { CALIB_CENTER, CALIB_PIECES, calibCamera } from './calibScene';
import { animationOf } from '../anim/keyframes';
import { decodeTimeline } from '../anim/timelineCodec';
import { makeKeyframePose } from '../anim/keyframePose';
import { animationDuration, animationFrameAtVideoTime, keyframeSceneBounds } from '../export/exportVideo';
import { cameraTrackAt } from '../anim/cameraTrack/sample';
import { timelineCameraContext } from '../anim/cameraTrack/context';
import { instancePlacements } from '../ui/modelPlacement';
import { BUILD_FL_DIRECTIONS, DEFAULT_REFERENCE_LIGHTING } from '../render/referenceLighting';
import { applyToneFilter, curveRmse, fitChannelCurves, gatherObservations, type ToneCurves } from './toneCurve';

const QS = new URLSearchParams(location.search);
const PROJECT_QS = QS.get('project');
const PROJECT = QS.has('project') ? (PROJECT_QS && PROJECT_QS !== '1' ? PROJECT_QS : '/_calib/hellboy.brickmotion') : null;
const AZ = Number(QS.get('az') ?? 0);
// The project reference still is a portrait 9:16 frame; the calibration references are landscape.
const W = Number(QS.get('w') ?? (PROJECT ? 540 : 960));
const H = Number(QS.get('h') ?? (PROJECT ? 960 : 540));
const BOUNCES = Number(QS.get('bounces') ?? 8);
const KEY = Number(QS.get('key') ?? 30);
const ENVINT = Number(QS.get('envint') ?? 0.9);
const USE_ENV = QS.get('env') ?? 'hdr';
const HDR_FILE = QS.get('hdr') ?? 'white.hdr';
// The fitted EyeSight BUILD_FL four-softbox rig (referenceLighting.ts), and its global gain
// into the tracer's area-light radiance units.
const RIG = QS.get('rig') !== '0';
const RIG_GAIN = Number(QS.get('gain') ?? 0.1);
// Global albedo multiplier: a look-fit knob standing in for EyeSight's stronger self-occlusion.
const ALBEDO = Number(QS.get('alb') ?? 0.65);
// Denoise once the render settles: it turns a low-sample (fast) image into a clean one.
const DENOISE = QS.get('denoise') !== '0';
const DENOISE_SAMPLES = Number(QS.get('samples') ?? 24);
// FSR upscaling: render below the canvas size and upscale — a speed/quality dial.
const UPSCALE = QS.get('upscale') === '1';
const RENDER_SCALE = Number(QS.get('scale') ?? 0.75);
// The tracer renders linear light; the display transform is a fitted per-channel tone curve
// (?tm=aces restores ACES for comparison). ?fit=1 fits the curve against the reference.
const TONE = QS.get('tm') ?? 'none';
const EXPOSURE = Number(QS.get('exposure') ?? 1);
const BACKDROP = Number(QS.get('bg') ?? 0.85);
const FIT = QS.get('fit') === '1';
// A render-only backdrop (emissive, so its brightness is independent of the world that lights
// the model) plus a floor lift decouple the background from the model's lighting — EyeSight's
// bright studio set behind a darker, occluded model. Fitted by RMSE like the rest.
const BG_WALL = QS.get('bgwall') === '1';
const BG_TOP = Number(QS.get('bgtop') ?? 0.97);
const BG_BOTTOM = Number(QS.get('bgbot') ?? 0.82);
const COMPOSITE = QS.get('composite') === '1';
const FLOOR_LIFT = Number(QS.get('floorlift') ?? 0);

/** EyeSight's plastic, from the fitted reference rig. */
const FINISH = { roughness: DEFAULT_REFERENCE_LIGHTING.roughness, clearcoat: DEFAULT_REFERENCE_LIGHTING.clearcoat, clearcoatRoughness: DEFAULT_REFERENCE_LIGHTING.coatRoughness };
const FLOOR_SIZE = 2000;

const status = document.getElementById('st') as HTMLElement;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const gpuCanvas = document.getElementById('gpu') as HTMLCanvasElement;
const ref = document.getElementById('ref') as HTMLImageElement;
const caption = document.getElementById('reflabel') as HTMLElement;

/** Read by the headless screenshot harness (not shipped). */
const telemetry = { ready: false, error: null as string | null, avgSamples: 0, samplesPerSecond: 0, seconds: 0, fps: 0, rmseBefore: 0, rmseAfter: 0, sceneMean: 0, refMean: 0, diag: null as unknown, curves: null as ToneCurves | null };
(window as unknown as { __pathTrace?: typeof telemetry }).__pathTrace = telemetry;

/** The per-channel display curve, baked from a `?fit=1` run against the EyeSight stills.
 * Null renders linear and ungraded. */
const BAKED_CURVES: ToneCurves | null = null;

function fail(error: unknown): void {
  telemetry.error = String((error as Error)?.stack ?? error);
  status.textContent = telemetry.error;
  console.error(error);
}

/** A uniform white equirect HDR (public/hdri/white.hdr): EyeSight's flat white world, as both
 * the environment and the backdrop, so the render and the reference share a white world. */
async function applyEnvironment(scene: THREE.Scene): Promise<void> {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  if (USE_ENV === '0' || USE_ENV === 'none') {
    scene.background = new THREE.Color(BACKDROP, BACKDROP, BACKDROP);
    return;
  }
  const hdr = await new HDRLoader().loadAsync(`${base}hdri/${HDR_FILE}`);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  // Environment (lights the model) and background (the backdrop) use the same white world at
  // separate intensities, so shading and backdrop brightness are independent — as in EyeSight,
  // where the white backdrop is brighter than the fill that reaches the model.
  scene.environment = hdr;
  scene.environmentIntensity = ENVINT;
  scene.background = hdr;
  scene.backgroundIntensity = BACKDROP;
}

const linearToSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

/** A seamless bright backdrop behind the model, as emissive bands (unlit, so it does not feed
 * the world that lights the model). Faces the camera. */
function addBackdrop(scene: THREE.Scene, camera: THREE.Camera, center: THREE.Vector3, radius: number): void {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const g = new THREE.Group();
  g.position.copy(center).addScaledVector(forward, radius * 6);
  g.lookAt(camera.position); // a regular object's +Z faces the lookAt target, so the bands face the camera
  const width = radius * 24;
  const height = radius * 18;
  const bands = 20;
  const band = height / bands;
  for (let i = 0; i < bands; i++) {
    const t = (i + 0.5) / bands; // 0 bottom .. 1 top
    const em = BG_BOTTOM + (BG_TOP - BG_BOTTOM) * t;
    const mat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, metalness: 0, emissive: new THREE.Color(em, em, em), emissiveIntensity: 1 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, band + 1e-3), mat);
    mesh.position.set(0, -height / 2 + (i + 0.5) * band, 0);
    g.add(mesh);
  }
  scene.add(g);
}

async function main(): Promise<void> {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');

  // RectAreaLight needs its LTC BRDF data initialised for the WebGPU node renderer; the
  // denoiser rasterises guide buffers through it, so it must be ready before the first frame.
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());

  // ---- gather the model -------------------------------------------------------------------
  type Piece = { part: string; color: number; world: THREE.Matrix4 };
  const pieces: Piece[] = [];
  let center = new THREE.Vector3(...CALIB_CENTER).clone();
  let radius = 13;
  let groundY = -24 / 20;
  let modelShot: { position: THREE.Vector3; target: THREE.Vector3; fov: number; roll?: number } | null = null;
  if (PROJECT) {
    await initPartService();
    const read = readProjectFile(await (await fetch(PROJECT)).text());
    if (!read.ok) throw new Error(read.errors.join('\n'));
    const parts = new Set<string>();
    for (const s of [...read.plan.steps, ...Object.values(read.plan.submodels ?? {}).flatMap((m) => m.steps)])
      for (const p of s.pieces as { part?: string }[]) if (p.part) parts.add(p.part);
    await ensureParts([...parts]);
    const asm = assemble(read.plan, metricsOf, getColors());
    const instances = asm.instances.filter((i) => !i.placeholder && geometryOf(i.part));
    // The reference is the animation's last frame: reproduce its camera and its pose exactly,
    // so the path trace and the EyeSight still are the same view.
    const animation = animationOf(read.plan.animation);
    const saved = read.timelines.find((t) => t.model === '');
    const buildTimeline = saved ? decodeTimeline(saved.timeline) : null;
    const placements = instancePlacements(read.plan, '', asm);
    const bounds = keyframeSceneBounds({ animation, editingModel: '', instances, placements, buildTimeline });
    const pose = makeKeyframePose(instances, placements, animation, '', buildTimeline);
    const tracks = read.plan.cameraTracks?.[''];
    const track = [tracks?.timeline, tracks?.build].find((t) => t?.keys.length);
    const ctx = timelineCameraContext(animation, bounds, buildTimeline, '', W / H, 36);
    const seconds = animationDuration(animation) - 1e-3;
    const shot = track ? cameraTrackAt(track, seconds, ctx) : null;
    const evaluated = pose(animationFrameAtVideoTime(animation, seconds));
    for (const inst of instances) {
      const world = evaluated.get(inst.key) ?? placements.get(inst.key)?.clone().multiply(inst.world) ?? inst.world;
      pieces.push({ part: inst.part, color: inst.color, world: world.clone() });
    }
    if (shot) modelShot = { position: shot.position.clone(), target: shot.target.clone(), fov: shot.fov, roll: shot.roll };
    const b = asm.bounds!;
    const box = new THREE.Box3(
      new THREE.Vector3(b.min[0] / 20, -b.max[1] / 20, -b.max[2] / 20),
      new THREE.Vector3(b.max[0] / 20, -b.min[1] / 20, -b.min[2] / 20),
    );
    center = box.getCenter(new THREE.Vector3());
    radius = Math.max(4, box.getSize(new THREE.Vector3()).length() / 2);
    groundY = -b.max[1] / 20;
  } else {
    await initPartService();
    await ensureParts([...new Set(CALIB_PIECES.map((p) => p.part))]);
    for (const p of CALIB_PIECES) {
      pieces.push({
        part: p.part, color: p.color,
        world: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)
          .multiply(new THREE.Matrix4().makeRotationY(((p.rotY ?? 0) * Math.PI) / 180)),
      });
    }
  }
  const colors = getColors();

  // ---- renderer + scene -------------------------------------------------------------------
  const renderer = new WebGPURenderer({ canvas: gpuCanvas });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.toneMapping = TONE === 'none' ? THREE.NoToneMapping : TONE === 'aces' ? THREE.ACESFilmicToneMapping : THREE.LinearToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  await renderer.init();

  const dw = W / 2, dh = H / 2;
  canvas.width = W; canvas.height = H;
  canvas.style.width = `${dw}px`; canvas.style.height = `${dh}px`;
  if (ref) { ref.style.width = `${dw}px`; ref.style.height = `${dh}px`; }

  const scene = new THREE.Scene();
  await applyEnvironment(scene);

  // The bricks: same world layout as the viewport (LDraw space, flipped and scaled to studs).
  const model = new THREE.Group();
  model.rotation.x = Math.PI;
  model.scale.setScalar(1 / 20);
  scene.add(model);

  const materials = new Map<number, THREE.MeshPhysicalMaterial>();
  const materialFor = (code: number): THREE.MeshPhysicalMaterial => {
    let m = materials.get(code);
    if (!m) {
      const def = colors.get(code);
      m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(def ? brickHex(def) : '#cccccc'), ...FINISH });
      m.color.multiplyScalar(ALBEDO);
      m.side = THREE.FrontSide;
      materials.set(code, m);
    }
    return m;
  };
  // The tracer writes generation data onto the geometry it is handed; clone once per unique
  // part so the live viewport's shared geometry is never touched.
  const clones = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  const cloneGeometry = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    let c = clones.get(g);
    if (!c) { c = g.clone(); clones.set(g, c); }
    return c;
  };
  const addPiece = (piece: Piece): void => {
    const geo = geometryOf(piece.part);
    if (!geo) return;
    const subs: [THREE.BufferGeometry | null, number][] = [
      [geo.main, piece.color],
      [geo.mainDoubleSided, piece.color],
      ...geo.fixed.map((f) => [f.geometry, f.color] as [THREE.BufferGeometry, number]),
    ];
    for (const [geometry, code] of subs) {
      if (!geometry) continue;
      const mesh = new THREE.Mesh(cloneGeometry(geometry), materialFor(code));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(piece.world);
      model.add(mesh);
    }
  };
  for (const piece of pieces) addPiece(piece);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  if (FLOOR_LIFT > 0) floorMat.emissive = new THREE.Color(FLOOR_LIFT, FLOOR_LIFT, FLOOR_LIFT);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = groundY;
  scene.add(floor);

  // ---- camera (needed before the camera-relative reference rig) ----------------------------
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 4000);
  camera.up.set(0, 1, 0);
  if (modelShot) {
    camera.fov = modelShot.fov;
    camera.position.copy(modelShot.position);
    camera.lookAt(modelShot.target);
    if (modelShot.roll) camera.rotateZ(THREE.MathUtils.degToRad(modelShot.roll));
  } else if (PROJECT) {
    camera.position.copy(center).addScaledVector(new THREE.Vector3(0.55, 0.42, 0.75).normalize(), (radius / Math.tan(THREE.MathUtils.degToRad(15))) * 1.15);
    camera.lookAt(center);
  } else {
    const shot = calibCamera(AZ);
    camera.position.set(...shot.position);
    camera.lookAt(new THREE.Vector3(...shot.target));
  }
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  if (BG_WALL) addBackdrop(scene, camera, center, radius);

  // ---- lights: the fitted EyeSight BUILD_FL rig (four softboxes that follow the camera) ----
  const rig = DEFAULT_REFERENCE_LIGHTING;
  if (RIG) {
    const forward = camera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const dist = radius * 3;
    const size = 2 * dist * Math.tan(rig.diameter / 2);
    BUILD_FL_DIRECTIONS.forEach(([x, y, z], i) => {
      const dir = right.clone().multiplyScalar(x).addScaledVector(forward, y).addScaledVector(up, z).normalize();
      const panel = new THREE.RectAreaLight(0xffffff, rig.strengths[i] * RIG_GAIN, size, size);
      panel.position.copy(center).addScaledVector(dir, dist);
      panel.lookAt(center);
      scene.add(panel);
    });
  } else {
    const key = new THREE.RectAreaLight(0xffffff, KEY, radius * 1.1, radius * 1.1);
    key.position.copy(center).addScaledVector(new THREE.Vector3(0.45, 0.82, 0.5).normalize(), radius * 2.2);
    key.lookAt(center);
    scene.add(key);
  }

  // ---- tracer -----------------------------------------------------------------------------
  const tracer = new WebGPUPathTracer(renderer);
  tracer.setRandom(RANDOM_BLUE_DITHER);
  tracer.maxBounces = BOUNCES;
  tracer.filterGlossyFactor = 1;
  tracer.dynamicLowRes = QS.get('lowres') !== '0';
  tracer.renderDelay = Number(QS.get('delay') ?? 300);
  tracer.fadeDuration = 400;
  tracer.minSamples = 1;
  // With the denoiser, stop after a low sample count: it cleans the image from there.
  tracer.maxSamples = DENOISE ? DENOISE_SAMPLES : Number(QS.get('maxsamples') ?? 0);
  try {
    tracer.setScene(scene, camera);
  } catch (error) {
    throw new Error(`The path tracer could not build the scene: ${(error as Error).message}`);
  }
  if (DENOISE) {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    tracer.setDenoiser(new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: `${base}weights/rt_hdr_alb_nrm.tza` }));
  }
  if (UPSCALE) {
    tracer.renderScale = RENDER_SCALE;
    tracer.setUpscaler(new FSRUpscaler({ Upscaler }));
  }
  telemetry.ready = true;

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enableDamping = false;
  controls.addEventListener('change', () => tracer.updateCamera());
  controls.update();

  if (ref) {
    const src = PROJECT ? '/_calib/ref_end.png' : `/_calib/calib_az${AZ}.png`;
    if (caption) caption.textContent = `EyeSight reference (${src.split('/').pop()})`;
    ref.src = src;
    ref.addEventListener('error', () => { ref.style.visibility = 'hidden'; });
  }

  // ---- tone: apply the fitted curve, or fit one against the reference ----------------------
  let tone: ToneCurves | null = BAKED_CURVES;
  const applyTone = (): void => {
    if (tone && TONE === 'none') { applyToneFilter(canvas, tone); telemetry.curves = tone; }
  };
  applyTone();

  // ---- backdrop composite -----------------------------------------------------------------
  // The tracer renders to an offscreen GPU canvas; the displayed image replaces the uniform
  // sky (ray misses = the flat white world colour) with a fitted bright gradient. This is the
  // only way to decouple the backdrop from the world that lights the model: an emissive backdrop
  // mesh would light the model too.
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
  const outCtx = canvas.getContext('2d')!;
  const BG_DISPLAY = Math.round(linearToSrgb(ENVINT) * 255);
  const composite = (): void => {
    if (!COMPOSITE) { outCtx.drawImage(gpuCanvas, 0, 0, W, H); return; }
    tctx.drawImage(gpuCanvas, 0, 0, W, H);
    const img = tctx.getImageData(0, 0, W, H);
    const d = img.data;
    // The ray-miss sky is the flat world colour; take it from a top corner rather than assume it.
    const c0 = (2 * W + 2) * 4;
    const b0 = d[c0], b1 = d[c0 + 1], b2 = d[c0 + 2];
    const tol = 6;
    for (let y = 0; y < H; y++) {
      const t = 1 - y / (H - 1);
      const c = Math.round((BG_BOTTOM + (BG_TOP - BG_BOTTOM) * t) * 255);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(d[i] - b0) <= tol && Math.abs(d[i + 1] - b1) <= tol && Math.abs(d[i + 2] - b2) <= tol) {
          d[i] = c; d[i + 1] = c; d[i + 2] = c; d[i + 3] = 255;
        }
      }
    }
    outCtx.putImageData(img, 0, 0);
  };

  const readRgba = (source: CanvasImageSource): Uint8ClampedArray => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(source, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H).data;
  };

  const doFit = (): void => {
    if (!ref?.complete || !ref.naturalWidth) throw new Error('the reference image is not loaded');
    const reference = readRgba(ref);
    // Weight model and mid-tones over the large, near-white background.
    const weightOf = (i: number) => (Math.max(reference[i], reference[i + 1], reference[i + 2]) < 232 ? 1 : 0.12);
    // Read the raw canvas (CSS filters are visual only) inside the frame, after renderSample,
    // while the drawing buffer is still valid.
    const scene = readRgba(canvas);
    const mean = (a: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += (a[i] + a[i + 1] + a[i + 2]) / 3; return s / (a.length / 4); };
    telemetry.sceneMean = Math.round(mean(scene) * 10) / 10;
    telemetry.refMean = Math.round(mean(reference) * 10) / 10;
    const before = curveRmse(scene, reference, null, weightOf);
    const fitted = fitChannelCurves(gatherObservations(scene, reference, weightOf));
    const after = curveRmse(scene, reference, fitted, weightOf);
    // Diagnostics: is the error on the backdrop, on the model, or a whole-frame misalignment?
    const rmseRegion = (pred: (i: number) => boolean): number => {
      let s = 0, n = 0;
      for (let i = 0; i < scene.length; i += 4) {
        if (!pred(i)) continue;
        for (let c = 0; c < 3; c++) { const d = scene[i + c] - reference[i + c]; s += d * d; n++; }
      }
      return n ? Math.sqrt(s / n) : 0;
    };
    const isModel = (i: number) => Math.max(reference[i], reference[i + 1], reference[i + 2]) < 200;
    let modelN = 0;
    const mS = [0, 0, 0], mR = [0, 0, 0];
    for (let i = 0; i < scene.length; i += 4) if (isModel(i)) { modelN++; for (let c = 0; c < 3; c++) { mS[c] += scene[i + c]; mR[c] += reference[i + c]; } }
    let bx = 0, by = 0, bv = Infinity;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      let s = 0, n = 0;
      for (let y = 8; y < H - 8; y += 2) for (let x = 8; x < W - 8; x += 2) {
        const i = (y * W + x) * 4, j = ((y + dy) * W + (x + dx)) * 4;
        for (let c = 0; c < 3; c++) { const d = scene[j + c] - reference[i + c]; s += d * d; n++; }
      }
      const v = s / n;
      if (v < bv) { bv = v; bx = dx; by = dy; }
    }
    telemetry.diag = {
      all: +rmseRegion(() => true).toFixed(2),
      model: +rmseRegion(isModel).toFixed(2),
      background: +rmseRegion((i) => !isModel(i)).toFixed(2),
      modelFraction: +(modelN / (scene.length / 4)).toFixed(3),
      modelScene: mS.map((v) => Math.round(v / Math.max(1, modelN))),
      modelRef: mR.map((v) => Math.round(v / Math.max(1, modelN))),
      topLeft: [scene[0], scene[1], scene[2]],
      bgDisplay: BG_DISPLAY,
      bestShift: { dx: bx, dy: by, rmse: +Math.sqrt(bv).toFixed(2) },
    };
    tone = fitted; applyTone();
    telemetry.rmseBefore = Math.round(before.before * 100) / 100;
    telemetry.rmseAfter = Math.round(after.after * 100) / 100;
    status.textContent += `\nfit RMSE ${before.before.toFixed(2)} → ${after.after.toFixed(2)}\nR ${fitted.r.map((v) => v.toFixed(4)).join(',')}\nG ${fitted.g.map((v) => v.toFixed(4)).join(',')}\nB ${fitted.b.map((v) => v.toFixed(4)).join(',')}`;
  };

  // ---- loop + HUD -------------------------------------------------------------------------
  const fitAt = FIT ? Number(QS.get('fitdelay') ?? 6000) : Infinity;
  const started = performance.now();
  let fitDone = false;
  let frames = 0, lastFrames = 0, lastFpsTime = performance.now();
  let lastComposite = 0;
  const loop = (): void => {
    requestAnimationFrame(loop);
    tracer.renderSample();
    const now = performance.now();
    if (now - lastComposite >= 120) { lastComposite = now; composite(); }
    // The fit reads the composited canvas, so it runs in-frame after a fresh composite.
    if (!fitDone && now - started >= fitAt) {
      fitDone = true;
      composite();
      try { doFit(); } catch (error) { fail(error); }
    }
    frames++;
    if (now - lastFpsTime >= 1000) {
      telemetry.fps = Math.round(((frames - lastFrames) * 1000) / (now - lastFpsTime));
      lastFrames = frames; lastFpsTime = now;
    }
  };
  loop();

  const hud = (): void => {
    tracer.getSampleCountsAsync().then((c) => {
      telemetry.avgSamples = c.avg;
      telemetry.samplesPerSecond = c.samplesPerSecond;
      telemetry.seconds = tracer.getRenderTime() / 1000;
      status.textContent =
        `WebGPU path trace  ·  ${W}×${H}  ·  ${tracer.lowResMode ? 'low-res (moving)' : 'full-res'}  ·  ${BOUNCES} bounces\n` +
        `${c.avg.toFixed(0)} spp avg  ·  ${c.min} spp min  ·  ${c.samplesPerSecond.toFixed(0)} spp/s  ·  ${telemetry.fps} fps  ·  ${(tracer.getRenderTime() / 1000).toFixed(0)} s\n` +
        `${PROJECT ? `model: ${PROJECT}` : `calib az ${AZ}°`}  ·  orbit to re-aim (restarts and re-converges)`;
    }).catch(() => { /* a measurement in flight; try again next tick */ });
  };
  hud();
  setInterval(hud, 1000);
}

main().catch(fail);
