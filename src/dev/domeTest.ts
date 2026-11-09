/**
 * Dev-only: the calibration frames (Hellboy end / ?t=55&ref=ref_mid.png, or ?scene=calib&az=…)
 * drawn three ways, to compare against the EyeSight reference with window.metrics():
 *   dome.run('a')  the viewport as is (GTAO)
 *   dome.run('b')  GTAO off, ray-traced dome visibility multiplied over the frame
 *   dome.run('c')  both
 * dome.bench(w, h) times the dome pass (GPU timer query) at a given size.
 * Setup copied from calibrate.ts (which runs on import, so it cannot be imported).
 */
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
import { DomeVisibility, type DomeComposite, type DomeOptions } from '../render/domeVisibility';
import type { Instance } from '../model/assemble';

const QS = new URLSearchParams(location.search);
const CALIB = QS.get('scene') === 'calib';
const W = CALIB ? 960 : 540, H = CALIB ? 540 : 960;
const st = document.getElementById('st')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;
canvas.width = W; canvas.height = H;
if (CALIB) for (const id of ['c', 'ref', 'd']) { const e = document.getElementById(id)!; e.style.width = '640px'; e.style.height = '360px'; }
if (CALIB) { const d = document.getElementById('d') as HTMLCanvasElement; d.width = W; d.height = H; }

/** a: GTAO, b: dome, c: both, n: neither */
type Mode = 'a' | 'b' | 'c' | 'n';
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
  await initPartService();
  const sc = CALIB ? await loadCalib() : await loadHellboy();
  const studio = createStudio(canvas, { preserveDrawingBuffer: true });
  studio.setSize(W, H);
  studio.renderer.setPixelRatio(1);
  studio.bricks.setInstances(sc.instances);
  const materials: Materials = { ...DEFAULT_MATERIALS };
  const dv = new DomeVisibility(studio.renderer, { groundY: sc.ground });
  dv.setSize(W, H);
  let built = false;
  let size = { w: W, h: H };
  /** composite settings, tuned per run */
  const comp: DomeComposite = { strength: 0.6, sides: 1, floor: 1, power: 1 };

  const prepare = async (mode: Mode) => {
    materials.ao = { enabled: mode === 'a' || mode === 'c', strength: null, radius: null };
    studio.setRenderOptions?.({ edges: false, linearColors: true });
    studio.setLook?.('bricklink-white' as StudioLook);
    studio.setMaterials?.(materials);
    await studio.ready?.();
    studio.setSceneSetup(sc.sceneSetup as never, false, null, size.w / size.h);
    studio.bricks.setMatrices((k: string) => sc.mats.get(k) ?? null);
    studio.fitTo(sc.box, sc.ground);
    const p = studio.perspective, s = sc.shot;
    p.position.copy(s.position); p.up.set(0, 1, 0); p.lookAt(s.target);
    if (s.roll) p.rotateZ(THREE.MathUtils.degToRad(s.roll));
    p.fov = s.fov; p.aspect = size.w / size.h; p.updateProjectionMatrix();
    if (!built) { dv.setScene(studio.bricks.root); built = true; }
  };
  const finish = () => {
    const r = studio.renderer;
    r.setRenderTarget(null); r.setViewport(0, 0, size.w, size.h); r.setScissorTest(false);
    dv.composite(comp);
  };
  /** draws the frame in `mode`; the dome converges over `frames` steps first */
  const run = async (mode: Mode, o: { frames?: number; comp?: Partial<DomeComposite>; dome?: Partial<DomeOptions> } = {}) => {
    if (o.comp) Object.assign(comp, o.comp);
    if (o.dome) dv.set(o.dome);
    await prepare(mode);
    if (mode === 'b' || mode === 'c') { dv.reset(); for (let i = 0; i < (o.frames ?? 48); i++) dv.render(studio.camera); }
    studio.render();
    if (mode === 'b' || mode === 'c') finish();
    return (window as unknown as { metrics: () => Promise<Record<string, unknown>> }).metrics();
  };
  /** re-composite with other settings over a fresh studio frame, without re-tracing */
  const recomp = async (mode: Mode, c: Partial<DomeComposite>) => {
    Object.assign(comp, c);
    await prepare(mode); studio.render(); finish();
    return (window as unknown as { metrics: () => Promise<Record<string, unknown>> }).metrics();
  };
  /**
   * Fair comparison: the viewport's bricks are brighter overall than these EyeSight references, so
   * any darkening lowers the error. For each brick-only gain g (a constant, no structure) report the
   * error; the best over g is what the occlusion's *structure* earns at matched brightness.
   */
  const fair = async (mode: Mode, c: Partial<DomeComposite> = {}, gains = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6]) => {
    Object.assign(comp, c, { fixed: -1 });
    await prepare(mode);
    // the brick mask comes from the dome prepass: make sure it matches this camera
    if (mode === 'a' || mode === 'n') dv.render(studio.camera);
    const res: [number, number][] = [];
    for (const g of gains) {
      studio.render();
      const r = studio.renderer;
      r.setRenderTarget(null); r.setViewport(0, 0, size.w, size.h); r.setScissorTest(false);
      if (mode === 'b' || mode === 'c') dv.composite(comp);
      dv.composite({ strength: 1, sides: 1, floor: 0, fixed: g });
      res.push([g, (await (window as unknown as { metrics: () => Promise<{ rmse: number }> }).metrics()).rmse]);
    }
    res.sort((x, y) => x[1] - y[1]);
    return { atGain1: res.find((r) => r[0] === 1)?.[1], best: res[0] };
  };
  /** visibility only (white frame × visibility) */
  const showVis = () => {
    const r = studio.renderer; r.setRenderTarget(null); r.setViewport(0, 0, size.w, size.h);
    r.setClearColor(0xffffff, 1); r.clear();
    const keep = { ...comp }; Object.assign(comp, { strength: 1, sides: 1, floor: 1, power: 1 }); dv.composite(comp); Object.assign(comp, keep);
  };

  /** GPU time (ms) of fn, median of n, with EXT_disjoint_timer_query_webgl2; null if unavailable */
  const gpuTime = async (fn: () => void, n = 8): Promise<number | null> => {
    const gl = studio.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const q = gl.createQuery()!;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q); fn(); gl.endQuery(ext.TIME_ELAPSED_EXT);
      for (let t = 0; t < 200; t++) {
        await new Promise((r) => setTimeout(r, 10));
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      }
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
    out.sort((a, b) => a - b);
    return out.length ? +out[out.length >> 1].toFixed(2) : null;
  };
  /** times the dome step (prepass+trace+filter+composite), the studio frame with and without GTAO, at w×h */
  const bench = async (w: number, h: number, dome: Partial<DomeOptions> = {}) => {
    size = { w, h };
    canvas.width = w; canvas.height = h; studio.setSize(w, h); studio.renderer.setPixelRatio(1);
    dv.setSize(w, h); if (Object.keys(dome).length) dv.set(dome);
    await prepare('a');
    const withAO = await gpuTime(() => studio.render());
    await prepare('b');
    const noAO = await gpuTime(() => studio.render());
    dv.reset();
    const domeStep = await gpuTime(() => { dv.render(studio.camera); finish(); });
    const res = { w, h, rays: dv.options.rays, scale: dv.options.scale, maxDistance: dv.options.maxDistance, frameWithGTAO: withAO, frameNoAO: noAO, gtao: withAO !== null && noAO !== null ? +(withAO - noAO).toFixed(2) : null, dome: domeStep };
    size = { w: W, h: H };
    canvas.width = W; canvas.height = H; studio.setSize(W, H); studio.renderer.setPixelRatio(1); dv.setSize(W, H);
    return res;
  };

  /** GPU ms per dome stage (median of n frames) at the current size */
  const stages = async (n = 8) => {
    const gl = studio.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const acc: Record<string, number[]> = {};
    for (let i = 0; i < n; i++) {
      const qs: [string, WebGLQuery][] = [];
      dv.stageHook = (stage, phase) => {
        if (phase === 'begin') { const q = gl.createQuery()!; gl.beginQuery(ext.TIME_ELAPSED_EXT, q); qs.push([stage, q]); } else gl.endQuery(ext.TIME_ELAPSED_EXT);
      };
      dv.render(studio.camera);
      dv.stageHook = null;
      for (let t = 0; t < 200 && !qs.every(([, q]) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)); t++) await new Promise((r) => setTimeout(r, 10));
      for (const [k, q] of qs) { (acc[k] ??= []).push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); }
    }
    return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +v.sort((a, b) => a - b)[v.length >> 1].toFixed(2)]));
  };
  /** stage timings at w×h */
  const benchStages = async (w: number, h: number, dome: Partial<DomeOptions> = {}) => {
    size = { w, h };
    canvas.width = w; canvas.height = h; studio.setSize(w, h); studio.renderer.setPixelRatio(1);
    dv.setSize(w, h); if (Object.keys(dome).length) dv.set(dome);
    await prepare('b');
    const res = { w, h, rays: dv.options.rays, scale: dv.options.scale, ...(await stages()) };
    size = { w: W, h: H };
    canvas.width = W; canvas.height = H; studio.setSize(W, H); studio.renderer.setPixelRatio(1); dv.setSize(W, H);
    return res;
  };

  (window as unknown as Record<string, unknown>).dome = { stages, benchStages, studio, dv, run, recomp, fair, showVis, bench, gpuTime, comp, sc, THREE };
  const m = await run('a');
  st.textContent = `ok · ${sc.instances.length} pieces · ${dv.stats.triangles} tris · BVH ${dv.stats.buildMs.toFixed(0)} ms · (a) rmse ${m.rmse}`;
}
main().catch((e) => { st.textContent = String(e?.stack ?? e); console.error(e); });

/** Error of the viewport canvas against the EyeSight reference (same as calibrate.ts). `gain`: a control that scales the whole frame first (does plain darkening explain a gain?). */
(window as unknown as Record<string, unknown>).metrics = async (gain = 1) => {
  const c = document.getElementById('c') as HTMLCanvasElement, ref = document.getElementById('ref') as HTMLImageElement, d = document.getElementById('d') as HTMLCanvasElement;
  await ref.decode().catch(() => undefined);
  const a = document.createElement('canvas'); a.width = W; a.height = H; const ax = a.getContext('2d')!; ax.drawImage(c, 0, 0, W, H);
  const b = document.createElement('canvas'); b.width = W; b.height = H; const bx = b.getContext('2d')!; bx.drawImage(ref, 0, 0, W, H);
  const A = ax.getImageData(0, 0, W, H).data, B = bx.getImageData(0, 0, W, H).data;
  const dx = d.getContext('2d')!; const out = dx.createImageData(W, H);
  let se = 0, n = 0; const bins: Record<string, { n: number; a: number[]; b: number[] }> = {};
  const cls = (r: number, g: number, bl: number) => (r < 60 && g < 60 && bl < 60) ? 'black' : (r > g * 2 && r > bl * 2) ? 'red' : (r > 150 && g > 130 && bl > 90 && r - bl > 25) ? 'tan' : (r > 235 && g > 235 && bl > 235) ? 'bg' : 'other';
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; if (gain !== 1) for (let j = 0; j < 3; j++) A[o + j] = Math.round(A[o + j] * gain);
    const dr = A[o] - B[o], dg = A[o + 1] - B[o + 1], db = A[o + 2] - B[o + 2];
    se += dr * dr + dg * dg + db * db; n += 3;
    const k = cls(B[o], B[o + 1], B[o + 2]); const t = bins[k] ?? (bins[k] = { n: 0, a: [0, 0, 0], b: [0, 0, 0] });
    t.n++; for (let j = 0; j < 3; j++) { t.a[j] += A[o + j]; t.b[j] += B[o + j]; }
    out.data[o] = Math.min(255, Math.abs(dr) * 3); out.data[o + 1] = Math.min(255, Math.abs(dg) * 3); out.data[o + 2] = Math.min(255, Math.abs(db) * 3); out.data[o + 3] = 255;
  }
  dx.putImageData(out, 0, 0);
  const r: Record<string, unknown> = { rmse: +Math.sqrt(se / n).toFixed(2) };
  for (const k in bins) { const t = bins[k]; r[k] = `n=${t.n} vp(${t.a.map((v) => Math.round(v / t.n))}) es(${t.b.map((v) => Math.round(v / t.n))})`; }
  return r;
};
