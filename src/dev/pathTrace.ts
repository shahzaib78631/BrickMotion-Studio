/**
 * Dev-only: Cycles-like rendering in a live WebGPU path tracer, instead of the
 * viewport's WebGL rasteriser. Real light transport — bounce light, soft area-light
 * shadows, glossy reflections of the actual scene — accumulated progressively. The
 * camera is interactive; while it moves the tracer shows a fast low-resolution preview,
 * and once it settles the full-resolution image converges, as Blender's Cycles viewport does.
 *
 * This is the first brick of the new render core (PathCache): the substrate is WebGPU
 * compute (three-gpu-pathtracer's wavefront tracer, one BVH per part into a TLAS), not
 * WebGL2 fragment shaders. Neural radiance caching and ReSTIR are not implemented here.
 *
 * Two scenes:
 *   default          the calibration set, beside its EyeSight reference (/_calib/calib_az<az>.png)
 *   ?project=1       a real project model, finishing pose, beside its EyeSight still (/_calib/ref_end.png)
 *
 * Query knobs: az, w, h, key, envint, bounces, env, hdr, lowres, delay, maxsamples.
 */
import * as THREE from 'three';
import { cyclesPrincipledDiffuse } from './cyclesDiffuse';
import { ShadowGround } from './shadowGround';
import { withCyclesFilm } from './cyclesFilm';
import { EYESIGHT_PIPELINE } from '../data/eyesightPipeline.generated';
import { EYESIGHT_BUILD_STRENGTHS, EYESIGHT_WORLD_STRENGTH, EYESIGHT_IOR, EYESIGHT_NATIVE_SOLID_ROUGHNESS, EYESIGHT_SOLID_ROUGHNESS, EYESIGHT_SOLID_DIFFUSE_GAIN, EYESIGHT_SCRATCH_DIFFUSE, EYESIGHT_AO_STRENGTH, EYESIGHT_BLUR, EYESIGHT_SUN_DIAMETER, diskRadiance, bakeMouldNormals, pathTraceColor } from './eyesightScene';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import { WebGPUPathTracer, OIDNDenoiser, FSRUpscaler, RANDOM_BLUE_DITHER } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-webgpu';
import { Upscaler } from '@pmndrs/upscaler';
import { assemble } from '../model/assemble';
import { readProjectFile } from '../io/projectFile';
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
import { applyToneFilter, curveRmse, fitChannelCurves, gatherObservations, anchoredMap, type ToneCurves, type Lut } from './toneCurve';

const QS = new URLSearchParams(location.search);
// Source reconstruction is opt-in until both brick and ground errors improve.
let livePalette: 'studio' | 'ldraw' = QS.get('palette') === 'ldraw' ? 'ldraw' : 'studio';
const NATIVE_SCENE = QS.get('profile') === 'native';
const SOURCE_SCENE = NATIVE_SCENE || QS.get('profile') === 'source';
const SHADOW_GROUND = QS.get('ground') === 'catcher';
const FILM = QS.get('film') ?? (NATIVE_SCENE ? 'blackman-harris' : 'box');
const PROJECT_QS = QS.get('project');
const PROJECT = QS.has('project') ? (PROJECT_QS && PROJECT_QS !== '1' ? PROJECT_QS : '/_calib/hellboy.brickmotion') : null;
const AZ = Number(QS.get('az') ?? 0);
// The project reference still is a portrait 9:16 frame; the calibration references are landscape.
const W = Number(QS.get('w') ?? (PROJECT ? 540 : 960));
const H = Number(QS.get('h') ?? (PROJECT ? 960 : 540));
const BOUNCES = Number(QS.get('bounces') ?? 8);
const KEY = Number(QS.get('key') ?? 30);
const ENVINT = Number(QS.get('envint') ?? (SOURCE_SCENE ? EYESIGHT_WORLD_STRENGTH : 0.65));
const USE_ENV = QS.get('env') ?? 'hdr';
const HDR_FILE = QS.get('hdr') ?? 'white.hdr';
// The visible backdrop is its own equirect (an elevation gradient), separate from the uniform
// world light, so the backdrop's tone/gradient is independent of the lighting that hits bricks.
const BACKDROP_HDR = QS.get('bghdr') ?? 'studio_backdrop.hdr';
// The fitted EyeSight BUILD_FL four-softbox rig (referenceLighting.ts), and its global gain
// into the tracer's area-light radiance units.
const RIG = QS.get('rig') !== '0';
const RIG_GAIN = Number(QS.get('gain') ?? (SOURCE_SCENE ? 0.7 : 0.35));
// EyeSight's SOLID-GROUP DirtOnScratch mix: base*(1-SCRATCH) + 0.12*SCRATCH (see eyesightScene).
// Off by default — it compresses p95 but lifts p5 the wrong way; the uniform gain below wins.
const SCRATCH = Number(QS.get('scratch') ?? 0);
const SCRATCH_COLOR = new THREE.Color(EYESIGHT_SCRATCH_DIFFUSE, EYESIGHT_SCRATCH_DIFFUSE, EYESIGHT_SCRATCH_DIFFUSE);
// Uniform diffuse multiplier matching the model's overall level to EyeSight's.
const ALBEDO = Number(QS.get('alb') ?? (NATIVE_SCENE ? 1 : SOURCE_SCENE ? EYESIGHT_SOLID_DIFFUSE_GAIN : 0.65));
// Experimental fitted sky-visibility multiplier, not a port of AO-guided denoising. Its
// strength. 0 disables it and keeps the fast direct-present path (no per-frame readback).
const AO = Number(QS.get('ao') ?? (SOURCE_SCENE && !NATIVE_SCENE ? EYESIGHT_AO_STRENGTH : 0));
// Reconstruction filter: stands in for EyeSight's Blackman-Harris film filter (see
// EYESIGHT_BLUR). 0 disables it and keeps the fast direct-present path.
const BLUR = Number(QS.get('blur') ?? (SOURCE_SCENE && !NATIVE_SCENE ? EYESIGHT_BLUR : 0));
// Denoise once the render settles: it turns a low-sample (fast) image into a clean one.
const DENOISE = QS.get('denoise') !== '0';
const DENOISE_SAMPLES = Number(QS.get('samples') ?? 64);
// The guided OIDN model (albedo+normal) darkens silhouettes around pieces; the color-only model
// avoids that halo, so it is the default. ?noguide=0 restores the guided (sharper) model.
const NOGUIDE = QS.get('noguide') !== '0';
// FSR upscaling: render below the canvas size and upscale — a speed/quality dial.
const UPSCALE = QS.get('upscale') === '1';
const RENDER_SCALE = Number(QS.get('scale') ?? 0.75);
// The tracer renders linear light; the display transform is a fitted per-channel tone curve
// (?tm=aces restores ACES for comparison). ?fit=1 fits the curve against the reference.
const TONE = QS.get('tm') ?? 'none';
const EXPOSURE = Number(QS.get('exposure') ?? 1);
const BACKDROP = Number(QS.get('bg') ?? (SOURCE_SCENE ? 1 : 0.85));
const FIT = QS.get('fit') === '1';
// Grade the render to the reference's tonal distribution. Off by default: without a model-silhouette
// mask it cannot serve the model and the floor separately (global blows the model's highlights,
// per-region seams the floor shadow). Use ?match=1 to preview; a coverage mask is the real fix.
const MATCH = QS.get('match') === '1';
// Readbacks are reserved for explicit reference diagnostics and legacy grading; the AO pass and
// the reconstruction blur force the composite path since they blend into the presented image.
const DIRECT_PRESENT = QS.get('present') !== 'cpu' && !MATCH && !AO && !BLUR && QS.get('composite') !== '1';
// A render-only backdrop (emissive, so its brightness is independent of the world that lights
// the model) plus a floor lift decouple the background from the model's lighting — EyeSight's
// bright studio set behind a darker, occluded model. Fitted by RMSE like the rest.
const BG_WALL = QS.get('bgwall') === '1';
const BG_TOP = Number(QS.get('bgtop') ?? 0.97);
const BG_BOTTOM = Number(QS.get('bgbot') ?? 0.82);
const COMPOSITE = QS.get('composite') === '1';
const FLOOR_LIFT = Number(QS.get('floorlift') ?? 0);

/** EyeSight's plastic, from the fitted reference rig — all overridable for gloss/detail fit. */
const ROUGH = Number(QS.get('rough') ?? (NATIVE_SCENE ? EYESIGHT_NATIVE_SOLID_ROUGHNESS : SOURCE_SCENE ? EYESIGHT_SOLID_ROUGHNESS : 0.2));
const CLEARCOAT = Number(QS.get('clearcoat') ?? (NATIVE_SCENE ? 0.25 : SOURCE_SCENE ? 0 : 0.6));
const COAT_ROUGH = Number(QS.get('coatrough') ?? (SOURCE_SCENE ? 0 : DEFAULT_REFERENCE_LIGHTING.coatRoughness));
/** Angular diameter of each rig softbox (radians). Smaller = tighter specular highlights and
 * sharper shadows; a 90 deg panel fills the frame and hides the world backdrop. */
const DIAMETER = Number(QS.get('diameter') ?? (SOURCE_SCENE ? EYESIGHT_SUN_DIAMETER : 0.35));
const FINISH = { roughness: ROUGH, clearcoat: CLEARCOAT, clearcoatRoughness: COAT_ROUGH };
const FLOOR_SIZE = 2000;

const status = document.getElementById('st') as HTMLElement;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const gpuCanvas = document.getElementById('gpu') as HTMLCanvasElement;
const ref = document.getElementById('ref') as HTMLImageElement;
const caption = document.getElementById('reflabel') as HTMLElement;

/** Read by the headless screenshot harness (not shipped). */
const telemetry = { ready: false, error: null as string | null, avgSamples: 0, samplesPerSecond: 0, seconds: 0, fps: 0, rmseBefore: 0, rmseAfter: 0, sceneMean: 0, refMean: 0, maskFrac: 0, diag: null as unknown, curves: null as ToneCurves | null };
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
  // `environment` is the world light that reaches the bricks (uniform white.hdr); `background`
  // is the backdrop the camera sees. A THREE.Color background renders black in this tracer, so
  // the backdrop is a texture — for the source profile a subtle elevation gradient so its tone
  // reads independently of the world light.
  scene.environment = hdr;
  scene.environmentIntensity = ENVINT;
  const backdrop = SOURCE_SCENE ? await new HDRLoader().loadAsync(`${base}hdri/${BACKDROP_HDR}`) : hdr;
  backdrop.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = backdrop;
  scene.backgroundIntensity = BACKDROP;
}

const linearToSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

/** Separable Gaussian blur of an RGBA buffer in place — the reconstruction-filter stand-in for
 * EyeSight's Blackman-Harris film filter (see EYESIGHT_BLUR). */
function gaussianBlur(d: Uint8ClampedArray, w: number, h: number, sigma: number): void {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let cr = 0, cg = 0, cb = 0;
    for (let i = -r; i <= r; i++) {
      const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
      const j = (y * w + xx) * 4, wt = k[i + r];
      cr += d[j] * wt; cg += d[j + 1] * wt; cb += d[j + 2] * wt;
    }
    const t = (y * w + x) * 3; tmp[t] = cr; tmp[t + 1] = cg; tmp[t + 2] = cb;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let cr = 0, cg = 0, cb = 0;
    for (let i = -r; i <= r; i++) {
      const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
      const t = (yy * w + x) * 3, wt = k[i + r];
      cr += tmp[t] * wt; cg += tmp[t + 1] * wt; cb += tmp[t + 2] * wt;
    }
    const j = (y * w + x) * 4; d[j] = cr; d[j + 1] = cg; d[j + 2] = cb;
  }
}

/** p5 (cavity darkness), p95 (highlights) and grad (fine detail) over the model pixels. */
function detailOf(a: Uint8ClampedArray, reference: Uint8ClampedArray, mask?: Uint8ClampedArray): { p5: number; p95: number; grad: number } {
  const isModel = (i: number) => mask ? mask[i + 1] > 250 : Math.max(reference[i], reference[i + 1], reference[i + 2]) < 200;
  const hist = new Float64Array(256); let n = 0, grad = 0, gn = 0;
  const lum = (k: number) => (0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2]) / 255;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4;
    if (!isModel(i)) continue;
    const l = lum(i); hist[Math.min(255, Math.round(l * 255))]++; n++;
    grad += Math.abs(lum(i + 4) - l) + Math.abs(lum(i + W * 4) - l); gn++;
  }
  const pct = (p: number) => { let acc = 0; const t = n * p; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return +(v / 255).toFixed(3); } return 1; };
  return { p5: pct(0.05), p95: pct(0.95), grad: +(grad / Math.max(1, gn)).toFixed(4) };
}

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
  gpuCanvas.style.width = `${dw}px`; gpuCanvas.style.height = `${dh}px`;
  if (DIRECT_PRESENT) {
    gpuCanvas.style.position = 'relative'; gpuCanvas.style.left = '0';
    canvas.style.display = 'none';
  }
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
      const base = def ? pathTraceColor(def, livePalette) : new THREE.Color('#cccccc');
      m = new THREE.MeshPhysicalMaterial({ color: base.clone().lerp(SCRATCH_COLOR, SCRATCH).multiplyScalar(ALBEDO), ...FINISH, ior: SOURCE_SCENE ? EYESIGHT_IOR : 1.5 });
      m.userData.baseColor = base;
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
    if (!c) { c = g.clone(); if (SOURCE_SCENE) bakeMouldNormals(c, Number(QS.get('mould') ?? 0)); clones.set(g, c); }
    return c;
  };
  const modelMeshes: THREE.Mesh[] = [];
  const addPiece = (piece: Piece): void => {
    const geo = geometryOf(piece.part);
    if (!geo) return;
    const subs: [THREE.BufferGeometry | null, number][] = [
      [geo.main, piece.color],
      [geo.mainDoubleSided, piece.color],
      ...geo.fixed.map((f) => [f.geometry, f.color === 16 ? piece.color : f.color] as [THREE.BufferGeometry, number]),
    ];
    for (const [geometry, code] of subs) {
      if (!geometry) continue;
      const mesh = new THREE.Mesh(cloneGeometry(geometry), materialFor(code));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(piece.world);
      model.add(mesh);
      modelMeshes.push(mesh);
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

  // ---- lights: fitted finite rectangles, oriented from the initial camera heading ----
  const rig = DEFAULT_REFERENCE_LIGHTING;
  const rigPanels: THREE.RectAreaLight[] = [];
  if (RIG) {
    const forward = camera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const dist = radius * (SOURCE_SCENE ? 1000 : 3);
    const size = 2 * dist * Math.tan(DIAMETER / 2);
    BUILD_FL_DIRECTIONS.forEach(([x, y, z], i) => {
      const dir = right.clone().multiplyScalar(x).addScaledVector(forward, y).addScaledVector(up, z).normalize();
      const radiance = SOURCE_SCENE ? diskRadiance(EYESIGHT_BUILD_STRENGTHS[i] * RIG_GAIN, DIAMETER) : rig.strengths[i] * RIG_GAIN;
      const panel = new THREE.RectAreaLight(0xffffff, radiance, size, size);
      if (SOURCE_SCENE) Object.assign(panel, { isCircular: true });
      panel.position.copy(center).addScaledVector(dir, dist);
      panel.lookAt(center);
      scene.add(panel);
      rigPanels.push(panel);
    });
  } else {
    const key = new THREE.RectAreaLight(0xffffff, KEY, radius * 1.1, radius * 1.1);
    key.position.copy(center).addScaledVector(new THREE.Vector3(0.45, 0.82, 0.5).normalize(), radius * 2.2);
    key.lookAt(center);
    scene.add(key);
  }

  // ---- tracer -----------------------------------------------------------------------------
  const tracer = new WebGPUPathTracer(renderer);
  if (SOURCE_SCENE && QS.get('bsdf') !== 'gltf') {
    // Replaces the diffuse evaluation in both BSDF and next-event-estimation
    // paths. Existing sampling/PDF stays paired; it remains unbiased for this lobe.
    const material = tracer.getMaterial();
    material.diffuseBrdf = cyclesPrincipledDiffuse;
    tracer.setMaterial(material);
  }
  const filmSampler = FILM === 'blackman-harris' ? withCyclesFilm(RANDOM_BLUE_DITHER, EYESIGHT_PIPELINE.film.filterWidth) : null;
  tracer.setRandom(filmSampler?.random ?? RANDOM_BLUE_DITHER);
  window.addEventListener('pagehide', (event) => { if (!event.persisted) filmSampler?.dispose(); });
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
  let denoiser: OIDNDenoiser | null = null;
  if (DENOISE) {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    denoiser = new OIDNDenoiser({
      initUNetFromURL,
      auxWeightsUrl: `${base}weights/rt_hdr_alb_nrm.tza`,
      colorWeightsUrl: `${base}weights/rt_hdr.tza`,
      useAuxiliaryBuffers: !NOGUIDE,
    });
    tracer.setDenoiser(denoiser);
  }
  if (UPSCALE) {
    tracer.renderScale = RENDER_SCALE;
    tracer.setUpscaler(new FSRUpscaler({ Upscaler }));
  }
  telemetry.ready = true;

  const shadowGround = SHADOW_GROUND ? new ShadowGround(renderer, scene, model, floor, rigPanels, camera, W, H, tracer.getMaterial()) : null;
  window.addEventListener('pagehide', (event) => { if (!event.persisted) shadowGround?.dispose(); });
  const controls = new OrbitControls(camera, DIRECT_PRESENT ? gpuCanvas : canvas);
  // Controls.update() calls lookAt(target). Preserve the reference target instead
  // of silently aiming the exported camera at the assembly bounding-box centre.
  controls.target.copy(modelShot?.target ?? (PROJECT ? center : new THREE.Vector3(...calibCamera(AZ).target)));
  controls.enableDamping = false;
  const clearComparison = (): void => { const output = document.getElementById('comparison'); if (output) output.textContent = ''; };
  controls.addEventListener('change', () => { tracer.updateCamera(); shadowGround?.invalidate(); clearComparison(); });
  controls.update();
  const referencePosition = camera.position.clone();
  const referenceTarget = controls.target.clone();
  document.getElementById('reset-camera')?.addEventListener('click', () => {
    camera.position.copy(referencePosition); controls.target.copy(referenceTarget);
    controls.update(); tracer.updateCamera();
  });

  if (ref) {
    const src = PROJECT ? '/_calib/ref_end.png' : `/_calib/calib_az${AZ}.png`;
    if (caption) caption.textContent = `EyeSight reference (${src.split('/').pop()})`;
    ref.src = src;
    ref.addEventListener('error', () => { ref.style.visibility = 'hidden'; });
  }

  // ---- tone: apply the fitted curve, or fit one against the reference ----------------------
  let tone: ToneCurves | null = BAKED_CURVES;
  const applyTone = (): void => {
    if (tone && TONE === 'none') { applyToneFilter(canvas, tone); if (DIRECT_PRESENT) applyToneFilter(gpuCanvas, tone); telemetry.curves = tone; }
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
  // Per-region grade keyed off the model-silhouette coverage mask (geometry, not brightness), so
  // the floor and its shadows stay smooth while the model is matched to the reference.
  let modelMask: Uint8Array | null = null;
  let modelLut: Lut | null = null;
  let bgLut: Lut | null = null;
  // Experimental baked sky-visibility map, applied at strength AO in the fitted profile.
  let aoMap: Uint8ClampedArray | null = null;
  const composite = (): void => {
    if (!COMPOSITE && !aoMap && !(modelMask && modelLut && bgLut)) {
      // Diagnostic snapshots need no pixel readback, either.
      outCtx.drawImage(gpuCanvas, 0, 0, W, H);
      return;
    }
    tctx.drawImage(gpuCanvas, 0, 0, W, H);
    const img = tctx.getImageData(0, 0, W, H);
    const d = img.data;
    // Reconstruction filter first, on the render (model + backdrop), before any grade.
    if (BLUR > 0) gaussianBlur(d, W, H, BLUR);
    if (COMPOSITE) {
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
    }
    if (modelMask && modelLut && bgLut) {
      const ml = modelLut, bl = bgLut;
      for (let p = 0, i = 0; p < W * H; p++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (modelMask[p]) { d[i] = ml.r[r] * 255; d[i + 1] = ml.g[g] * 255; d[i + 2] = ml.b[b] * 255; }
        else { d[i] = bl.r[r] * 255; d[i + 1] = bl.g[g] * 255; d[i + 2] = bl.b[b] * 255; }
      }
    }
    if (aoMap) {
      const s = AO, map = aoMap;
      for (let p = 0, i = 0; p < W * H; p++, i += 4) {
        const a = (map[i] + map[i + 1] + map[i + 2]) / 765; // 0..1 sky visibility
        const k = 1 - s * (1 - a);
        d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      }
    }
    outCtx.putImageData(img, 0, 0);
  };

  // ---- live settings panel ------------------------------------------------------------------
  const bindRange = (id: string, value: number, apply: (v: number) => void): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    const out = el.parentElement?.querySelector('span') ?? null;
    el.value = String(value);
    const show = () => { if (out) out.textContent = Number(el.value).toFixed(2); };
    show();
    el.addEventListener('input', () => {
      clearComparison();
      show(); apply(Number(el.value));
      const keys: Record<string, string> = { 'p-env': 'envint', 'p-gain': 'gain', 'p-diameter': 'diameter', 'p-rough': 'rough', 'p-coat': 'clearcoat', 'p-alb': 'alb', 'p-samples': 'samples' };
      const key = keys[id];
      if (key) { const url = new URL(location.href); url.searchParams.set(key, el.value); history.replaceState(null, '', url); }
    });
  };
  bindRange('p-env', ENVINT, (v) => { scene.environmentIntensity = v; tracer.updateEnvironment(); shadowGround?.invalidate(); });
  let liveGain = RIG_GAIN, liveDiameter = DIAMETER;
  const setRig = (gain: number, diameter: number): void => {
    liveGain = gain; liveDiameter = diameter;
    const distance = radius * (SOURCE_SCENE ? 1000 : 3);
    rigPanels.forEach((panel, i) => {
      panel.width = panel.height = 2 * distance * Math.tan(diameter / 2);
      panel.intensity = SOURCE_SCENE ? diskRadiance(EYESIGHT_BUILD_STRENGTHS[i] * gain, diameter) : rig.strengths[i] * gain;
    });
    tracer.updateLights(); shadowGround?.invalidate();
  };
  bindRange('p-gain', liveGain, (v) => setRig(v, liveDiameter));
  bindRange('p-diameter', liveDiameter, (v) => setRig(liveGain, v));
  let liveRough = ROUGH, liveCoat = CLEARCOAT, liveAlb = ALBEDO;
  const setFinish = (rough: number, coat: number, alb: number): void => {
    for (const m of materials.values()) {
      m.roughness = rough; m.clearcoat = coat;
      const base = m.userData.baseColor as THREE.Color | undefined;
      if (base) m.color.copy(base).lerp(SCRATCH_COLOR, SCRATCH).multiplyScalar(alb);
    }
    tracer.updateMaterials();
  };
  const paletteControl = document.getElementById('p-palette') as HTMLSelectElement | null;
  if (paletteControl) {
    paletteControl.value = livePalette;
    paletteControl.addEventListener('change', () => {
      clearComparison();
      livePalette = paletteControl.value === 'ldraw' ? 'ldraw' : 'studio';
      const url = new URL(location.href); url.searchParams.set('palette', livePalette); history.replaceState(null, '', url);
      for (const [code, m] of materials) {
        const def = colors.get(code);
        m.userData.baseColor = def ? pathTraceColor(def, livePalette) : new THREE.Color('#cccccc');
      }
      setFinish(liveRough, liveCoat, liveAlb);
    });
  }
  bindRange('p-rough', ROUGH, (v) => { liveRough = v; setFinish(liveRough, liveCoat, liveAlb); });
  bindRange('p-coat', CLEARCOAT, (v) => { liveCoat = v; setFinish(liveRough, liveCoat, liveAlb); });
  bindRange('p-alb', ALBEDO, (v) => { liveAlb = v; setFinish(liveRough, liveCoat, liveAlb); });
  bindRange('p-samples', DENOISE ? DENOISE_SAMPLES : 0, (v) => { tracer.maxSamples = v; });

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
    const detail = (a: Uint8ClampedArray, isM: (i: number) => boolean): { p5: number; p95: number; grad: number } => {
      const hist = new Float64Array(256);
      let n = 0, grad = 0, gn = 0;
      const lum = (k: number) => (0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2]) / 255;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        if (!isM(i)) continue;
        const l = lum(i);
        hist[Math.min(255, Math.round(l * 255))]++; n++;
        grad += Math.abs(lum(i + 4) - l) + Math.abs(lum(i + W * 4) - l); gn++;
      }
      const pct = (p: number) => { let acc = 0; const target = n * p; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return +(v / 255).toFixed(3); } return 1; };
      return { p5: pct(0.05), p95: pct(0.95), grad: +(grad / Math.max(1, gn)).toFixed(4) };
    };
    // The reference-luminance heuristic calls any pixel the reference darkens "model". The baked
    // coverage mask (?match=1) is the true silhouette, so detail is reported over both.
    const geoModel = modelMask ? (i: number) => modelMask![i >> 2] === 1 : null;
    let geoN = 0;
    if (geoModel) for (let p = 0; p < W * H; p++) geoN += modelMask![p];
    telemetry.diag = {
      detailScene: detail(scene, isModel),
      detailRef: detail(reference, isModel),
      detailSceneGeo: geoModel ? detail(scene, geoModel) : null,
      detailRefGeo: geoModel ? detail(reference, geoModel) : null,
      modelFractionGeo: geoModel ? +(geoN / (W * H)).toFixed(3) : null,
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

  let measurePending = false;
  document.getElementById('measure-reference')?.addEventListener('click', () => {
    void tracer.getSampleCountsAsync().then((counts) => {
      const threshold = tracer.maxSamples > 0 ? tracer.maxSamples : 16;
      if ((shadowGround && !shadowGround.ready) || tracer.lowResMode || counts.min < threshold || (denoiser && tracer.maxSamples > 0 && !denoiser.complete)) {
        document.getElementById('comparison')!.textContent = 'Image is still refining. Measure after accumulation and denoising finish.';
        return;
      }
      measurePending = true;
    }).catch((error) => { document.getElementById('comparison')!.textContent = String(error); });
  });
  const measureReference = (): void => {
    if (!ref.complete || !ref.naturalWidth) return;
    const actual = readRgba(gpuCanvas), expected = readRgba(ref);
    let geometryMask: Uint8ClampedArray | undefined;
    if (shadowGround?.ready) {
      shadowGround.showMask(); geometryMask = readRgba(gpuCanvas);
      const presented = (denoiser?.complete ? denoiser.texture : null) ?? tracer.target;
      if (presented) shadowGround.render(presented as THREE.Texture);
    }
    let geometryError = 0, geometryCount = 0;
    if (geometryMask) for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if ([i, i - 4, i + 4, i - W * 4, i + W * 4].some((k) => geometryMask![k + 1] < 250)) continue;
      for (let c = 0; c < 3; c++) { geometryError += (actual[i + c] - expected[i + c]) ** 2; geometryCount++; }
    }
    let full = 0, brick = 0, count = 0;
    for (let i = 0; i < actual.length; i += 4) {
      const interior = Math.max(expected[i], expected[i + 1], expected[i + 2]) < 200;
      for (let c = 0; c < 3; c++) {
        const error = (actual[i + c] - expected[i + c]) ** 2;
        full += error; if (interior) { brick += error; count++; }
      }
    }
    document.getElementById('comparison')!.textContent = JSON.stringify({
      profile: NATIVE_SCENE ? 'native' : SOURCE_SCENE ? 'source' : 'legacy',
      ground: SHADOW_GROUND ? 'catcher' : 'physical', diameter: liveDiameter,
      film: FILM, palette: livePalette, albedoMultiplier: liveAlb,
      detail: detailOf(actual, expected), referenceDetail: detailOf(expected, expected),
      ...(geometryMask ? { modelRMSE255: +Math.sqrt(geometryError / Math.max(1, geometryCount)).toFixed(2), modelDetail: detailOf(actual, expected, geometryMask), referenceModelDetail: detailOf(expected, expected, geometryMask) } : {}),
      fullRMSE255: +Math.sqrt(full / (W * H * 3)).toFixed(2),
      darkReferenceRegionRMSE255: +Math.sqrt(brick / Math.max(1, count)).toFixed(2),
      note: 'Same saved camera required. Dark reference region includes shadows; not a geometry mask. No colour fitting applied.',
    }, null, 2);
  };

  // ---- coverage mask (model silhouette), rendered once -------------------------------------
  // Render the model with an emissive-white override against a black world (floor hidden): the
  // bright pixels are exactly the model. This is the geometry mask the tone grade, AO and backdrop
  // all need — a brightness threshold cannot separate the model from the floor.
  if (MATCH) {
    const white = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1, roughness: 1, metalness: 0 });
    const saved = modelMeshes.map((m) => m.material);
    const fv = floor.visible, ei = scene.environmentIntensity, bg = scene.background, env = scene.environment;
    const lights: THREE.Object3D[] = [];
    scene.traverse((o) => { if ((o as THREE.Light).isLight && o.visible) { o.visible = false; lights.push(o); } });
    try {
      for (const m of modelMeshes) m.material = white;
      floor.visible = false;
      // Kill every source of background light so a miss is black: the only bright thing is the
      // emissive model.
      scene.environment = null; scene.environmentIntensity = 0; scene.background = new THREE.Color(0, 0, 0);
      tracer.setScene(scene, camera);
      for (let i = 0; i < 3; i++) { tracer.renderSample(); await new Promise<void>((r) => requestAnimationFrame(() => r())); }
      tracer.renderSample();
      const px = readRgba(gpuCanvas);
      const mask = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) mask[p] = (px[p * 4] + px[p * 4 + 1] + px[p * 4 + 2]) > 60 ? 1 : 0;
      modelMask = mask;
      let on = 0; for (let p = 0; p < W * H; p++) on += mask[p];
      telemetry.maskFrac = +(on / (W * H)).toFixed(3);
    } finally {
      modelMeshes.forEach((m, i) => { m.material = saved[i]; });
      floor.visible = fv; scene.environment = env; scene.environmentIntensity = ei; scene.background = bg;
      for (const l of lights) l.visible = true;
      tracer.setScene(scene, camera);
      white.dispose();
    }
  }

  // ---- experimental fitted visibility pass, baked once -----------------------------------
  // Sky visibility: every surface white diffuse under a uniform white world with the rigs off.
  // Exposed/up-facing areas return ~1; concave and contact regions less. The composite multiplies
  // the render by mix(1, aoMap, AO); this is not EyeSight's AO-guided denoiser.
  if (AO > 0) {
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    const saved = modelMeshes.map((m) => m.material);
    const ei = scene.environmentIntensity;
    const rigVis = rigPanels.map((p) => p.visible);
    try {
      for (const m of modelMeshes) m.material = white;
      for (const p of rigPanels) p.visible = false;
      scene.environmentIntensity = 1;
      tracer.setScene(scene, camera);
      for (let i = 0; i < 6; i++) { tracer.renderSample(); await new Promise<void>((r) => requestAnimationFrame(() => r())); }
      tracer.renderSample();
      aoMap = readRgba(gpuCanvas);
    } finally {
      modelMeshes.forEach((m, i) => { m.material = saved[i]; });
      rigPanels.forEach((p, i) => { p.visible = rigVis[i]; });
      scene.environmentIntensity = ei;
      tracer.setScene(scene, camera);
      white.dispose();
    }
  }

  // ---- loop + HUD -------------------------------------------------------------------------
  const fitAt = FIT ? Number(QS.get('fitdelay') ?? 6000) : Infinity;
  const matchAt = MATCH ? Number(QS.get('matchdelay') ?? 6000) : Infinity;
  const started = performance.now();
  let fitDone = false;
  let graded = false;
  const doGrade = (): void => {
    if (!ref?.complete || !ref.naturalWidth || !modelMask) return;
    const reference = readRgba(ref);
    const scene = readRgba(canvas);
    const isModel = (i: number) => modelMask![i >> 2] === 1;
    modelLut = anchoredMap(scene, reference, isModel);
    bgLut = anchoredMap(scene, reference, (i) => !isModel(i));
    composite();
    // Verify: the model is matched to the reference; the floor keeps one continuous map.
    const m = new Uint8ClampedArray(scene);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      const lut = modelMask[p] ? modelLut : bgLut;
      m[i] = lut.r[m[i]] * 255; m[i + 1] = lut.g[m[i + 1]] * 255; m[i + 2] = lut.b[m[i + 2]] * 255;
    }
    telemetry.diag = { matched: detailOf(m, reference), refDetail: detailOf(reference, reference) };
  };
  let frames = 0, lastFrames = 0, lastFpsTime = performance.now();
  let lastComposite = 0;
  const loop = (): void => {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    if (!tracer.lowResMode) shadowGround?.update();
    tracer.renderSample();
    const presented = (denoiser?.complete ? denoiser.texture : null) ?? tracer.target;
    if (presented && !tracer.lowResMode) shadowGround?.render(presented as THREE.Texture);
    if (measurePending) { measurePending = false; if (!tracer.lowResMode) measureReference(); }
    const now = performance.now();
    if (!DIRECT_PRESENT && now - lastComposite >= 120) { lastComposite = now; composite(); }
    // The fit reads the composited canvas, so it runs in-frame after a fresh composite.
    if (!fitDone && now - started >= fitAt) {
      fitDone = true;
      composite();
      try { doFit(); } catch (error) { fail(error); }
    }
    if (!graded && now - started >= matchAt) {
      graded = true;
      composite();
      try { doGrade(); } catch (error) { fail(error); }
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
        `${c.avg.toFixed(0)} spp avg  ·  ${c.min} spp min  ·  ${c.samplesPerSecond.toFixed(0)} spp/s  ·  ${telemetry.fps} loop Hz (not render fps)  ·  ${(tracer.getRenderTime() / 1000).toFixed(0)} s\n` +
        `ground: ${SHADOW_GROUND ? (shadowGround?.ready ? 'GPU catcher' : 'GPU catcher warming') : 'physical floor'}\n` +
        `film: ${FILM} (camera sampling)\n` +
        `palette: ${livePalette} · albedo multiplier ${liveAlb.toFixed(2)}\n` +
        `${SOURCE_SCENE && QS.get('bsdf') !== 'gltf' ? 'Cycles diffuse / glTF glossy' : 'glTF material'}\n` +
        `${NATIVE_SCENE ? 'native constants / approximate distant lights' : SOURCE_SCENE ? 'fitted source-inspired rig' : 'legacy fitted rectangles'}\n` +
        `${DIRECT_PRESENT ? 'direct GPU display' : 'CPU composite display'} · ${DENOISE ? 'OIDN denoise' : 'raw samples'}\n` +
        `${PROJECT ? `model: ${PROJECT}` : `calib az ${AZ}°`}  ·  orbit to re-aim (restarts and re-converges)`;
    }).catch(() => { /* a measurement in flight; try again next tick */ });
  };
  hud();
  setInterval(hud, 1000);
}

main().catch(fail);
