/** Dev-only: draws one frame of a project with the viewport renderer next to an EyeSight reference. */
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
import { DEFAULT_MATERIALS, paletteOf } from '../render/looks';
import { DEFAULT_REFERENCE_LIGHTING } from '../render/referenceLighting';
import * as looks from '../render/looks';
import * as ps from '../state/partService';
import { CALIB_PIECES, calibCamera } from './calibScene';
import type { Instance } from '../model/assemble';

const QS = new URLSearchParams(location.search);
/** ?palette=ldraw renders with the LDraw colour table, ?palette=studio (the default) with BrickLink Studio's. */
const PALETTE = paletteOf(QS.get('palette') ?? undefined);
const CALIB = QS.get('scene') === 'calib';
const W = CALIB ? 960 : 540, H = CALIB ? 540 : 960;
const st = document.getElementById('st')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;
canvas.width = W; canvas.height = H;
if (CALIB) for (const id of ['c', 'ref', 'd']) { const e = document.getElementById(id)!; e.style.width = '640px'; e.style.height = '360px'; }
if (CALIB) { const d = document.getElementById('d') as HTMLCanvasElement; d.width = W; d.height = H; }

async function mainCalib() {
  await initPartService();
  if (QS.has('reference')) await ps.setStudLogos(false);
  const az = Number(QS.get('az') ?? 0);
  (document.getElementById('ref') as HTMLImageElement).src = `/_calib/calib_az${az}.png`;
  await ensureParts([...new Set(CALIB_PIECES.map((p) => p.part))]);
  const instances = CALIB_PIECES.map((p) => ({
    key: p.key, itemId: p.key, model: '', part: p.part, color: p.color, placeholder: false, grid: false,
    world: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationY(((p.rotY ?? 0) * Math.PI) / 180)),
  })) as unknown as Instance[];
  const cam = calibCamera(az);
  const shot = { position: new THREE.Vector3(...cam.position), target: new THREE.Vector3(...cam.target), fov: cam.fov, roll: 0 };
  const studio = createStudio(canvas, { preserveDrawingBuffer: true });
  studio.setSize(W, H);
  studio.renderer.setPixelRatio(1);
  studio.bricks.setInstances(instances);
  const mats = new Map(instances.map((i) => [i.key, i.world] as const));
  const setup: { look: StudioLook; materials: Materials; scene?: undefined } = { look: 'bricklink-white', materials: { ...DEFAULT_MATERIALS, studLogos: !QS.has('reference'), palette: PALETTE.id, finish: PALETTE.finish } };
  const draw = async (o: { look?: StudioLook; materials?: Partial<Materials> } = {}) => {
    if (o.look) setup.look = o.look;
    if (o.materials) Object.assign(setup.materials, o.materials);
    studio.setRenderOptions?.({ edges: false, linearColors: true });
    studio.setLook?.(setup.look);
    studio.setMaterials?.(setup.materials);
    await studio.ready?.();
    studio.setSceneSetup(undefined, false, null, W / H);
    studio.bricks.setMatrices((k: string) => mats.get(k) ?? null);
    const ground = -24 / 20;
    studio.fitTo(new THREE.Box3(new THREE.Vector3(-190 / 20, ground, -20 / 20), new THREE.Vector3(120 / 20, 80 / 20, 140 / 20)), ground);
    const p = studio.perspective;
    p.position.copy(shot.position); p.up.set(0, 1, 0); p.lookAt(shot.target);
    p.fov = shot.fov; p.aspect = W / H; p.updateProjectionMatrix();
    // Diagnostic ablation: ?light=side removes ambient/key illumination so the
    // side light's cast silhouette can be distinguished from a reflection.
    if (QS.get('light') === 'side') {
      const directions = studio.scene.children.filter((o): o is THREE.DirectionalLight => (o as THREE.DirectionalLight).isDirectionalLight);
      const side = directions[QS.get('lamp') === 'rim' ? 2 : 1];
      for (const object of studio.scene.children) if ((object as THREE.Light).isLight) object.visible = object === side;
      studio.scene.environment = null;
      if (side && QS.get('sideShadow') === '0') side.castShadow = false;
    }
    studio.render();
  };
  const setAz = async (a: number) => {
    const c = calibCamera(a);
    shot.position.set(...c.position); shot.target.set(...c.target);
    const img = document.getElementById('ref') as HTMLImageElement;
    img.src = `/_calib/calib_az${a}.png`; await img.decode();
    await draw();
  };
  (window as unknown as Record<string, unknown>).calib = { studio, draw, setAz, shot, setup, THREE, looks, ps, instances };
  await draw();
  st.textContent = `calib scene · az ${az} · ${instances.length} pieces`;
}

async function main() {
  if (CALIB) return mainCalib();
  await initPartService();
  if (QS.has('reference')) await ps.setStudLogos(false);
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
  const qs = QS;
  const seconds = qs.has('t') ? Number(qs.get('t')) : animationDuration(animation) - 1e-3;
  if (qs.has('ref')) (document.getElementById('ref') as HTMLImageElement).src = `/_calib/${qs.get('ref')}`;
  const shot = cameraTrackAt(track, seconds, ctx)!;
  const evaluated = pose(animationFrameAtVideoTime(animation, seconds));

  const studio = createStudio(canvas, { preserveDrawingBuffer: true });
  studio.setSize(W, H);
  studio.renderer.setPixelRatio(1);
  studio.bricks.setInstances(instances);
  const mats = new Map<string, THREE.Matrix4 | null>();
  const poses = new Map<string, THREE.Matrix4>();
  for (const i of instances) {
    const w = evaluated.has(i.key) ? evaluated.get(i.key) : placements.get(i.key)?.clone().multiply(i.world) ?? i.world;
    mats.set(i.key, w ?? null);
  }
  void poses;
  const setup: { look: StudioLook; materials: Materials; scene?: typeof plan.sceneSetup } = { look: 'bricklink-white' as StudioLook, materials: { ...DEFAULT_MATERIALS, studLogos: !QS.has('reference'), palette: PALETTE.id, finish: PALETTE.finish } as Materials };
  const draw = async (o: { look?: StudioLook; materials?: Partial<Materials> } = {}) => {
    if (o.look) setup.look = o.look;
    if (o.materials) Object.assign(setup.materials, o.materials);
    studio.setRenderOptions?.({ edges: false, linearColors: true });
    studio.setLook?.(setup.look);
    studio.setMaterials?.(setup.materials);
    await studio.ready?.();
    studio.setSceneSetup(setup.scene ?? plan.sceneSetup, false, null, W / H);
    studio.bricks.setMatrices((k: string) => mats.get(k) ?? null);
    const b = asm.bounds!;
    const ground = -b.max[1] / 20;
    studio.fitTo(new THREE.Box3(new THREE.Vector3(b.min[0] / 20, ground, -b.max[2] / 20), new THREE.Vector3(b.max[0] / 20, -b.min[1] / 20, -b.min[2] / 20)), ground);
    const p = studio.perspective;
    p.position.copy(shot.position); p.up.set(0, 1, 0); p.lookAt(shot.target);
    if (shot.roll) p.rotateZ(THREE.MathUtils.degToRad(shot.roll));
    p.fov = shot.fov; p.aspect = W / H; p.updateProjectionMatrix();
    if (QS.get('light') === 'side') {
      const directions = studio.scene.children.filter((o): o is THREE.DirectionalLight => (o as THREE.DirectionalLight).isDirectionalLight);
      const side = directions[QS.get('lamp') === 'rim' ? 2 : 1];
      for (const object of studio.scene.children) if ((object as THREE.Light).isLight) object.visible = object === side;
      studio.scene.environment = null;
      if (side && QS.get('sideShadow') === '0') side.castShadow = false;
    }
    studio.render();
  };
  (window as unknown as Record<string, unknown>).calib = { studio, draw, shot, bounds, setup, THREE, plan, asm, looks, ps, instances };
  await draw();
  st.textContent = `ok · ${instances.length} pieces · fov ${shot.fov.toFixed(1)}`;
}
main().then(async () => {
  const base = document.getElementById('d') as HTMLCanvasElement;
  base.width = W; base.height = H;
  base.getContext('2d')!.drawImage(canvas, 0, 0, W, H);
  if (QS.has('reference')) {
    const { studio } = (window as unknown as { calib: { studio: ReturnType<typeof createStudio> } }).calib;
    studio.setReferenceLighting?.(DEFAULT_REFERENCE_LIGHTING);
    studio.render();
  }
  const neuralModel = QS.get('neural');
  if (neuralModel) {
    if (!/^shadenet_[a-z0-9]+$/.test(neuralModel)) throw new Error('Invalid neural model name');
    const { studio } = (window as unknown as { calib: { studio: ReturnType<typeof createStudio> } }).calib;
    st.textContent = `Comparing ${neuralModel}: left neural · middle EyeSight · right base viewport…`;
    const debug = (window as unknown as { __neuralDebug?: { spec?: number; edge?: number } });
    if (QS.get('ablate') === 'spec') debug.__neuralDebug = { spec: 0 };
    if (QS.get('ablate') === 'edge') debug.__neuralDebug = { edge: 0 };
    await studio.setNeural?.(`/models/${neuralModel}`);
    // Let the visibility history settle; every displayed output uses the same camera.
    for (let i = 0; i < 16; i++) {
      studio.render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    studio.renderer.getContext().finish();
    st.textContent = `${neuralModel}${QS.has('ablate') ? ` (${QS.get('ablate')} contribution off)` : ''} · left: neural · middle: EyeSight · right: base viewport`;
  }
  if (QS.has('reference') && QS.has('tile')) st.textContent = 'left: reference rig · middle: EyeSight · right: base viewport';
  if (QS.has('tile')) {
    // Identical source-pixel crop, enlarged by CSS only; no image enhancement.
    const ref = document.getElementById('ref') as HTMLImageElement;
    await ref.decode();
    for (const source of [canvas, ref, base]) {
      const full = document.createElement('canvas'); full.width = W; full.height = H;
      full.getContext('2d')!.drawImage(source, 0, 0, W, H);
      const crop = document.createElement('canvas'); crop.width = 150; crop.height = 240;
      crop.getContext('2d')!.drawImage(full, 255, 275, 150, 240, 0, 0, 150, 240);
      crop.style.width = '360px'; crop.style.height = '576px';
      source.replaceWith(crop);
    }
  }
  if (!QS.has('measure')) return;
  const api = window as unknown as { calib: { studio: ReturnType<typeof createStudio> }; metrics: () => Promise<Record<string, unknown>> };
  const { studio } = api.calib;
  const gl = studio.renderer.getContext();
  for (let i = 0; i < 3; i++) studio.render();
  gl.finish();
  const times: number[] = [];
  for (let batch = 0; batch < 5; batch++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const start = performance.now();
    for (let i = 0; i < 8; i++) studio.render();
    gl.finish();
    times.push((performance.now() - start) / 8);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const metrics = await api.metrics();
  st.style.whiteSpace = 'pre-wrap';
  st.textContent += `\n${W}×${H}: median ${sorted[2].toFixed(2)} ms/frame (CPU + GPU sync; 5 batches × 8 frames)\n${JSON.stringify({ times, metrics }, null, 2)}`;
}).catch((e) => { st.textContent = String(e?.stack ?? e); console.error(e); });

/** Error of the viewport canvas against the EyeSight reference, per colour class. */
(window as unknown as Record<string, unknown>).metrics = async () => {
  const c = document.getElementById('c') as HTMLCanvasElement, ref = document.getElementById('ref') as HTMLImageElement, d = document.getElementById('d') as HTMLCanvasElement;
  const a = document.createElement('canvas'); a.width = W; a.height = H; const ax = a.getContext('2d')!; ax.drawImage(c, 0, 0);
  const b = document.createElement('canvas'); b.width = W; b.height = H; const bx = b.getContext('2d')!; bx.drawImage(ref, 0, 0, W, H);
  const A = ax.getImageData(0, 0, W, H).data, B = bx.getImageData(0, 0, W, H).data;
  const dx = d.getContext('2d')!; const out = dx.createImageData(W, H);
  let se = 0, n = 0; const bins: Record<string, { n: number; a: number[]; b: number[] }> = {};
  const cls = (r: number, g: number, bl: number) => (r < 60 && g < 60 && bl < 60) ? 'black' : (r > g * 2 && r > bl * 2) ? 'red' : (r > 150 && g > 130 && bl > 90 && r - bl > 25) ? 'tan' : (r > 235 && g > 235 && bl > 235) ? 'bg' : 'other';
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; const dr = A[o] - B[o], dg = A[o + 1] - B[o + 1], db = A[o + 2] - B[o + 2];
    se += dr * dr + dg * dg + db * db; n += 3;
    const k = cls(B[o], B[o + 1], B[o + 2]); const t = bins[k] ?? (bins[k] = { n: 0, a: [0, 0, 0], b: [0, 0, 0] });
    t.n++; for (let j = 0; j < 3; j++) { t.a[j] += A[o + j]; t.b[j] += B[o + j]; }
    out.data[o] = Math.min(255, Math.abs(dr) * 3); out.data[o + 1] = Math.min(255, Math.abs(dg) * 3); out.data[o + 2] = Math.min(255, Math.abs(db) * 3); out.data[o + 3] = 255;
  }
  dx.putImageData(out, 0, 0);
  const r: Record<string, unknown> = { rmse: +Math.sqrt(se / n).toFixed(2) };
  for (const k in bins) { const t = bins[k]; r[k] = `n=${t.n} viewport(${t.a.map((v) => Math.round(v / t.n))}) eyesight(${t.b.map((v) => Math.round(v / t.n))})`; }
  return r;
};

/**
 * Mean colour per surface direction (world ±x/±y/±z, or "other") and per colour of piece,
 * for the viewport and the EyeSight reference, found by raycasting every 3rd pixel.
 */
(window as unknown as Record<string, unknown>).normalStats = async (step = 3) => {
  const calib = (window as unknown as { calib: { studio: ReturnType<typeof createStudio>; THREE: typeof THREE } }).calib;
  const studio = calib.studio;
  const c = document.getElementById('c') as HTMLCanvasElement, ref = document.getElementById('ref') as HTMLImageElement;
  const grab = (src: CanvasImageSource) => { const a = document.createElement('canvas'); a.width = W; a.height = H; const x = a.getContext('2d')!; x.drawImage(src, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
  const A = grab(c), B = grab(ref);
  studio.perspective.updateMatrixWorld(true); studio.bricks.root.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  const stats: Record<string, { n: number; a: number[]; b: number[] }> = {};
  const m = new THREE.Matrix4(), im = new THREE.Matrix4(), nm = new THREE.Matrix3(), n = new THREE.Vector3();
  const axes: [string, THREE.Vector3][] = [['+x', new THREE.Vector3(1, 0, 0)], ['-x', new THREE.Vector3(-1, 0, 0)], ['+y', new THREE.Vector3(0, 1, 0)], ['-y', new THREE.Vector3(0, -1, 0)], ['+z', new THREE.Vector3(0, 0, 1)], ['-z', new THREE.Vector3(0, 0, -1)]];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -((y / H) * 2 - 1)), studio.perspective);
    const h = rc.intersectObjects(studio.bricks.root.children, true).find((i) => (i.object as THREE.Mesh).isMesh && i.face);
    if (!h) continue;
    const o = h.object as THREE.InstancedMesh;
    m.copy(o.matrixWorld);
    if (o.isInstancedMesh && h.instanceId !== undefined) { o.getMatrixAt(h.instanceId, im); m.multiply(im); }
    nm.getNormalMatrix(m); n.copy(h.face!.normal).applyMatrix3(nm).normalize();
    let dir = 'other', best = 0.93;
    for (const [name, v] of axes) { const d = n.dot(v); if (d > best) { best = d; dir = name; } }
    const col = ((o.material as THREE.MeshPhysicalMaterial).color?.getHexString?.() ?? '?');
    const key = `${col} ${dir}`;
    const s = stats[key] ?? (stats[key] = { n: 0, a: [0, 0, 0], b: [0, 0, 0] });
    const p = (y * W + x) * 4; s.n++;
    for (let j = 0; j < 3; j++) { s.a[j] += A[p + j]; s.b[j] += B[p + j]; }
  }
  return Object.entries(stats).filter(([, s]) => s.n > 30).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, s]) => `${k.padEnd(14)} n=${String(s.n).padStart(5)} vp(${s.a.map((v) => Math.round(v / s.n)).join(',')}) es(${s.b.map((v) => Math.round(v / s.n)).join(',')})`).join('\n');
};
