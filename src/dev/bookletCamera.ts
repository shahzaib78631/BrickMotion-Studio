/**
 * Dev-only: fits a three.js camera to a booklet step picture with the real LDraw parts of the teacher-verified
 * model (public/_booklet/<set>/, written by scripts/teach_export_camera.py), then shows
 * picture | render | overlay | difference per step.
 *
 * Camera: orthographic or perspective, looking at the model centre from (yaw, pitch) with roll, `up` = LDraw up
 * or down (a model turned over in the booklet), a scale in pixels per LDU and the image position of the centre.
 * Fit: coarse grid on silhouette IoU, then Nelder-Mead on (1 - IoU) + edge chamfer distance.
 *
 * /booklet-camera.html?set=21065&steps=2,3,4
 */
import * as THREE from 'three';
import { auditBookletAssembly } from './bookletAssembly';
import { bookletCamera as camera, perspectiveRadii, screenOffset, rasterScale, type BookletCamera as Cam } from './bookletCameraMath';
import { ensureParts, geometryOf, getColors, initPartService, metricsOf } from '../state/partService';

const QS = new URLSearchParams(location.search);
const SET = QS.get('set') ?? '21065';
const ZOOM = Math.max(0.25, Math.min(4, Number(QS.get('zoom') ?? 1)));
/** ?basecam=1: fit the camera to the model so far only (new parts hidden, red-outlined areas ignored) */
const BASECAM = QS.get('basecam') === '1';
/** ?cands=1 (with prior): each new part goes to the connection candidate (step-NNNN-cands.json, written by
 * scripts/teach_cands.py) whose render matches the picture best, the camera held */
const CANDS = QS.get('cands') === '1';
/** ?place=1 (with names=step-NNNN of a draft from scripts/teach_export_draft.py, prior and lock=1): the step's new
 * parts go to the connection candidates (step-NNNN-cands.json) whose outline matches the booklet's red outline */
const PLACE = QS.get('place') === '1';
/** ?fit=1: the page's own camera fit. By default each step whose camera CoordNet solved (public/_booklet/<set>/
 * coordnet.json, from `python -m coordnet.evaluate --export`) is shown with that camera and its model centre;
 * the page only fits steps CoordNet has not solved, and exploded parts' screen offsets. */
const OWN_FIT = QS.get('fit') === '1';
type CoordnetStep = {
  cam: { yaw: number; pitch: number; roll: number; scale: number; cx: number; cy: number; eye: number; turned: boolean };
  centre: number[];
};
async function loadCoordnet(): Promise<Record<string, CoordnetStep> | null> {
  if (OWN_FIT) return null;
  try {
    const r = await fetch(`/_booklet/${SET}/coordnet.json`);
    return r.ok ? ((await r.json()).steps ?? null) : null;
  } catch {
    return null;      // missing (the dev server answers with its HTML page) or unreadable: fit here
  }
}
const st = document.getElementById('st')!;
let STEPNAME = '';
const rows = document.getElementById('rows')!;

type PartRow = { part: string; color: number; matrix: number[]; new: boolean };
type StepData = { name?: string; draft?: boolean; step: number; page: number; width: number; height: number; ptsPerPx?: number; exploded?: boolean; flipped: boolean; parts: PartRow[] };


const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);

// ------------------------------------------------------------------ scene from the verified model

function colorHex(code: number): string {
  return code === 0 ? '#303438' : getColors().get(code)?.hex ?? '#888888';
}

function buildScenes(d: StepData) {
  const mask = new THREE.Scene();
  const look = new THREE.Scene();
  const edges = new THREE.Scene();
  look.background = new THREE.Color('#888c90');
  look.add(new THREE.AmbientLight(0xffffff, 2.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-1, -3, 1.5);
  look.add(sun);
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  // black (not depth-only), so edges behind a part stay hidden whatever order three.js draws them in
  const occluder = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const ink = new THREE.LineBasicMaterial({ color: 0xffffff });
  const box = new THREE.Box3();
  // each new part hangs in its own group per scene: an exploded picture draws it away from its place
  // fresh: the new parts in white, the earlier parts only hiding them -> the visible area of the new parts,
  // which the booklet outlines in red
  const fresh = new THREE.Scene();
  fresh.background = new THREE.Color(0x000000);
  // black, not depth-only: a depth-only hider drawn after a new part would leave that part showing through
  const hider = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const scenes = [mask, look, edges, fresh];
  const groups: THREE.Group[][] = [];       // groups[k] = [mask, look, edges] group of new part k
  const newParts: PartRow[] = [];
  const into = (scene: THREE.Scene, p: PartRow): THREE.Object3D => (p.new ? groups[newParts.indexOf(p)][scenes.indexOf(scene)] : scene);
  for (const p of d.parts) if (p.new) {
    newParts.push(p);
    groups.push(scenes.map((sc) => { const g = new THREE.Group(); sc.add(g); return g; }));
  }
  for (const p of d.parts) {
    const g = geometryOf(p.part);
    if (!g) continue;
    const m = new THREE.Matrix4().fromArray(p.matrix);
    const geoms = [g.main, g.mainDoubleSided, ...g.fixed.map((f) => f.geometry)].filter(Boolean) as THREE.BufferGeometry[];
    for (const geo of geoms) {
      for (const [scene, mat] of [[mask, white], [edges, occluder], [fresh, p.new ? white : hider]] as const) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(m);
        into(scene, p).add(mesh);
      }
      const shade = new THREE.MeshLambertMaterial({ color: colorHex(p.color), side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const mesh = new THREE.Mesh(geo, shade);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      into(look, p).add(mesh);
      geo.computeBoundingBox();
      box.union(geo.boundingBox!.clone().applyMatrix4(m));
    }
    if (g.edges) {
      for (const [scene, mat] of [[edges, ink], [look, new THREE.LineBasicMaterial({ color: p.color === 0 ? 0xbbbbbb : 0x111111 })]] as const) {
        const line = new THREE.LineSegments(g.edges, mat);
        line.matrixAutoUpdate = false;
        line.matrix.copy(m);
        into(scene, p).add(line);
      }
    }
  }
  mask.background = new THREE.Color(0x000000);
  edges.background = new THREE.Color(0x000000);
  if (BASECAM) groups.forEach((gs) => gs.forEach((g) => { g.visible = false; }));
  const setOffsets = (o: number[][]) => groups.forEach((gs, k) => gs.forEach((g) => {
    const v = o[k] ?? [0, 0, 0]; g.position.set(v[0], v[1], v[2]); g.updateMatrixWorld(true);
  }));
  // a new part at a pose of its own (a connection candidate), or hidden (null)
  const setPose = (k: number, m: number[] | null) => {
    const rel = m ? new THREE.Matrix4().fromArray(m).multiply(new THREE.Matrix4().fromArray(newParts[k].matrix).invert()) : null;
    for (const g of groups[k]) {
      g.visible = !!rel;
      if (rel) { g.matrixAutoUpdate = false; g.matrix.copy(rel); }
      g.updateMatrixWorld(true);
    }
  };
  const setNewVisible = (visible: boolean) => groups.forEach((gs) => gs.forEach((g) => { g.visible = visible; }));
  // off: the new parts' own silhouette, nothing hiding them
  const setHiding = (on: boolean) => { hider.visible = on; };
  return { mask, look, edges, fresh, setHiding, setOffsets, setPose, setNewVisible, newParts, centre: box.getCenter(new THREE.Vector3()), radius: box.getSize(new THREE.Vector3()).length() / 2 };
}

// ------------------------------------------------------------------ camera from parameters

// ------------------------------------------------------------------ pixels

function readScene(scene: THREE.Scene, cam: THREE.Camera, W: number, H: number, target: THREE.WebGLRenderTarget): Uint8Array {
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, buf);
  renderer.setRenderTarget(null);
  // flip rows (GL origin is bottom-left), keep one channel
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = buf[((H - 1 - y) * W + x) * 4];
  return out;
}

function pictureMasks(img: ImageData) {
  const { width: W, height: H, data } = img;
  // background: most common border colour
  const counts = new Map<number, number>();
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) {
    const i = (y * W + x) * 4, k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const bk = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const bg = [((bk >> 10) & 31) * 8 + 4, ((bk >> 5) & 31) * 8 + 4, (bk & 31) * 8 + 4];
  const fg = new Uint8Array(W * H);
  const lum = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
    // red outlines / arrows and white pointer lines are not the model
    const red = data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 90;
    fg[p] = d > 30 && !red ? 1 : 0;
    lum[p] = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
  }
  // edges: strong luminance gradient inside the model
  const edge = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    const gx = lum[p + 1] - lum[p - 1], gy = lum[p + W] - lum[p - W];
    edge[p] = Math.hypot(gx, gy) > 60 ? 1 : 0;
  }
  // the step's new parts: what the booklet encloses in red outlines (flood fill from the border over
  // non-red pixels; what it cannot reach is inside an outline)
  const redM = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) { const i = p * 4; redM[p] = data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 90 ? 1 : 0; }
  const thick = new Uint8Array(W * H);          // close 1-px gaps in the outline
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let r = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) r |= redM[(y + dy) * W + x + dx];
    thick[y * W + x] = r;
  }
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p] || thick[p]) continue;
    seen[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) stack.push(p - 1); if (x < W - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - W); if (y < H - 1) stack.push(p + W);
  }
  const newRegion = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) newRegion[p] = seen[p] ? 0 : 1;
  let redCount = 0;
  for (let p = 0; p < W * H; p++) redCount += redM[p];
  return { fg, edge, dist: distanceTransform(edge, W, H), newRegion, red: redM, redCount, redDist: distanceTransform(redM, W, H) };
}

/** Two-pass chamfer distance (pixels) to the nearest set pixel. */
function distanceTransform(m: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e6, d = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) d[p] = m[p] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (x > 0) d[p] = Math.min(d[p], d[p - 1] + a);
    if (y > 0) {
      d[p] = Math.min(d[p], d[p - W] + a);
      if (x > 0) d[p] = Math.min(d[p], d[p - W - 1] + b);
      if (x < W - 1) d[p] = Math.min(d[p], d[p - W + 1] + b);
    }
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const p = y * W + x;
    if (x < W - 1) d[p] = Math.min(d[p], d[p + 1] + a);
    if (y < H - 1) {
      d[p] = Math.min(d[p], d[p + W] + a);
      if (x < W - 1) d[p] = Math.min(d[p], d[p + W + 1] + b);
      if (x > 0) d[p] = Math.min(d[p], d[p + W - 1] + b);
    }
  }
  return d;
}

// ------------------------------------------------------------------ fit

async function fit(d: StepData, img: ImageData, orthographicOnly = false) {
  const W = d.width, H = d.height;
  const sc = buildScenes(d);
  const pic = pictureMasks(img);
  const target = new THREE.WebGLRenderTarget(W, H);
  renderer.setSize(W, H, false);
  let fgCount = 0, minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pic.fg[y * W + x]) {
    fgCount++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const iou = (c: Cam) => {
    sc.setOffsets(c.offsets);
    const m = readScene(sc.mask, camera(c, sc.centre, sc.radius, W, H), W, H, target);
    let inter = 0, uni = 0;
    for (let p = 0; p < W * H; p++) {
      if (BASECAM && pic.newRegion[p]) continue;
      const a = m[p] > 127, b = pic.fg[p] === 1; if (a && b) inter++; if (a || b) uni++;
    }
    return inter / Math.max(uni, 1);
  };
  const chamfer = (c: Cam) => {
    sc.setOffsets(c.offsets);
    const e = readScene(sc.edges, camera(c, sc.centre, sc.radius, W, H), W, H, target);
    let s = 0, n = 0;
    for (let p = 0; p < W * H; p++) if (e[p] > 127 && !(BASECAM && pic.newRegion[p])) { s += Math.min(pic.dist[p], 6); n++; }
    return n ? s / n : 6;
  };
  const loss = (c: Cam) => (1 - iou(c)) + 0.03 * chamfer(c);
  const N = sc.newParts.length;
  const zero = () => Array.from({ length: N }, () => [0, 0, 0]);
  const base: Cam = { yaw: 0, pitch: 30, roll: 0, scale: 1, cx: W / 2, cy: H / 2, up: 1, persp: 0, offsets: zero() };
  /** silhouette box of the render at scale s, centred, -> (scale factor to the picture's box, centre). */
  const boxAt = (c: Cam, s: number) => {
    sc.setOffsets(c.offsets);
    const m = readScene(sc.mask, camera({ ...c, scale: s, cx: W / 2, cy: H / 2 }, sc.centre, sc.radius, W, H), W, H, target);
    let x0 = W, x1 = 0, y0 = H, y1 = 0, any = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x] > 127) { any = true; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (!any) return null;
    return { k: 0.5 * ((maxX - minX + 1) / (x1 - x0 + 1) + (maxY - minY + 1) / (y1 - y0 + 1)), mx: (x0 + x1) / 2 - W / 2, my: (y0 + y1) / 2 - H / 2 };
  };
  const placeAt = (c: Cam, s: number): Cam => {        // scale and centre from the silhouette box
    const b = boxAt(c, s);
    if (!b) return { ...c, scale: s };
    return { ...c, scale: s * b.k, cx: (minX + maxX) / 2 - b.mx * b.k, cy: (minY + maxY) / 2 - b.my * b.k };
  };
  const centreAt = (c: Cam): Cam => {                   // fixed scale: centre only
    const b = boxAt(c, c.scale);
    if (!b) return c;
    return { ...c, cx: (minX + maxX) / 2 - b.mx, cy: (minY + maxY) / 2 - b.my };
  };
  const prior = QS.get('prior')?.split(',').map(Number);
  let fitted: Cam;
  let coarse = -1;
  if (!prior) {
    // 1. camera: coarse grid on silhouette IoU (turned over = camera below, picture up = LDraw down), refine
    const s0 = Math.min(W, H) / (sc.radius * 2.2);
    const ups: (1 | -1)[] = d.flipped ? [-1, 1] : [1, -1];
    let best = { score: -1, cam: base };
    // ?fix=scale,pitch: the booklet's scale and tilt are known (they do not change when the model is turned)
    const fix = QS.get('fix')?.split(',').map(Number);
    const pitches = fix ? [fix[1]] : [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
    for (const up of ups) for (let yaw = 0; yaw < 360; yaw += fix ? 2.5 : 7.5) for (const p of pitches) {
      const c = fix ? centreAt({ ...base, yaw, pitch: up > 0 ? p : -p, up, scale: fix[0] }) : placeAt({ ...base, yaw, pitch: up > 0 ? p : -p, up }, s0);
      const s = iou(c);
      if (s > best.score) best = { score: s, cam: c };
    }
    coarse = best.score;
    const toVec = (c: Cam) => [c.yaw, c.pitch, c.roll, Math.log(c.scale), c.cx, c.cy];
    const fromVec = (v: number[], c: Cam): Cam => ({ ...c, yaw: v[0], pitch: v[1], roll: v[2], scale: Math.exp(v[3]), cx: v[4], cy: v[5] });
    const steps = fix ? [2, 1e-6, 2, 1e-6, 2, 2] : [3, 3, 2, 0.03, 2, 2];
    fitted = fromVec(nelderMead((v) => loss(fromVec(v, best.cam)), toVec(best.cam), steps, 260), best.cam);
    let bestLoss = loss(fitted);
    if (!fix && !orthographicOnly) for (const persp of [30, 15, 8, 5]) {
      const c = fromVec(nelderMead((x) => loss(fromVec(x, { ...fitted, persp })), toVec(fitted), steps.map((s) => s / 2), 120), { ...fitted, persp });
      const l = loss(c);
      if (l < bestLoss - 1e-4) { bestLoss = l; fitted = c; }
    }
  } else {
    // 2. the section's camera held (booklets keep one): the new parts are placed where the picture draws
    // them (an exploded step draws them away from their place). Coarse: a shared lift along LDraw up,
    // then each new part's offset (x, y, z in LDU) and the image centre refined together.
    const cam0: Cam = { ...base, yaw: prior[0], pitch: prior[1], roll: prior[2], scale: prior[3], up: prior[1] < 0 ? -1 : 1 };
    let best = { score: Infinity, cam: cam0 };
    for (let lift = 0; lift <= 200; lift += 4) {
      const c = centreAt({ ...cam0, offsets: Array.from({ length: N }, () => [0, -lift, 0]) });
      const l = loss(c);
      if (l < best.score) best = { score: l, cam: c };
    }
    coarse = best.score;
    const toVec = (c: Cam) => [c.cx, c.cy, ...c.offsets.flat()];
    const fromVec = (v: number[], c: Cam): Cam => ({ ...c, cx: v[0], cy: v[1], offsets: Array.from({ length: N }, (_, k) => v.slice(2 + 3 * k, 5 + 3 * k)) });
    const steps = [2, 2, ...Array.from({ length: 3 * N }, () => 6)];
    fitted = best.cam;
    for (let round = 0; round < 3; round++) {
      fitted = fromVec(nelderMead((v) => loss(fromVec(v, fitted)), toVec(fitted), steps.map((s) => s / (round + 1)), 300 + 60 * N), fitted);
    }
  }
  let chosen: (number[] | null)[] = [];
  const candReport: { part: string; score: number; margin: number; index: number; of: number }[] = [];
  if (CANDS) {
    const cands = (await (await fetch(`/_booklet/${SET}/${STEPNAME}-cands.json`)).json() as { parts: number[][][] }).parts;
    fitted = { ...fitted, offsets: zero() };
    sc.setOffsets(fitted.offsets);
    chosen = Array.from({ length: N }, () => null);
    chosen.forEach((_, k) => sc.setPose(k, null));
    // two rounds: placed in order with the earlier choices shown, then each again with all the others shown
    for (let round = 0; round < 2; round++) for (let k = 0; k < N; k++) {
      const list = cands[k] ?? [];
      const quick = list.map((m, i) => { sc.setPose(k, m); return { i, s: iou(fitted) }; }).sort((a, b) => b.s - a.s);
      const top = quick.slice(0, 10).map(({ i }) => { sc.setPose(k, list[i]); return { i, l: loss(fitted) }; }).sort((a, b) => a.l - b.l);
      if (!top.length) { sc.setPose(k, chosen[k]); continue; }
      chosen[k] = list[top[0].i];
      sc.setPose(k, chosen[k]);
      candReport[k] = { part: sc.newParts[k].part, score: 1 - top[0].l, margin: top.length > 1 ? top[1].l - top[0].l : 1, index: top[0].i, of: list.length };
      st.textContent = `candidates: round ${round + 1}, part ${k + 1}/${N}`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  sc.setOffsets(fitted.offsets);
  // the new parts' poses as drawn (offset applied), for snapping to a real connection afterwards
  const drawn = sc.newParts.map((p, k) => {
    const m = new THREE.Matrix4().fromArray(p.matrix);
    const o = fitted.offsets[k] ?? [0, 0, 0];
    m.elements[12] += o[0]; m.elements[13] += o[1]; m.elements[14] += o[2];
    return { part: p.part, color: p.color, matrix: chosen[k] ?? Array.from(m.elements) };
  });
  const result = { cam: fitted, iou: iou(fitted), chamfer: chamfer(fitted), coarse, fgCount, drawn, candReport };
  return { result, sc, pic, target };
}

function nelderMead(f: (v: number[]) => number, x0: number[], step: number[], iters: number): number[] {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[i] : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iters; it++) {
    simplex.sort((a, b) => a.f - b.f);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i].x[j] / n;
    const worst = simplex[n];
    const at = (t: number) => c.map((v, j) => v + t * (worst.x[j] - v));
    const r = at(-1), fr = f(r);
    if (fr < simplex[0].f) {
      const e = at(-2), fe = f(e);
      simplex[n] = fe < fr ? { x: e, f: fe } : { x: r, f: fr };
    } else if (fr < simplex[n - 1].f) {
      simplex[n] = { x: r, f: fr };
    } else {
      const k = at(0.5), fk = f(k);
      if (fk < worst.f) simplex[n] = { x: k, f: fk };
      else simplex = simplex.map((s, i) => (i === 0 ? s : { x: s.x.map((v, j) => simplex[0].x[j] + 0.5 * (v - simplex[0].x[j])), f: 0 })).map((s, i) => (i === 0 ? s : { x: s.x, f: f(s.x) }));
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  return simplex[0].x;
}

// ------------------------------------------------------------------ show

function canvasOf(W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.style.width = `${W * ZOOM}px`; c.style.height = `${H * ZOOM}px`;
  return c;
}

async function show(d: StepData, img: HTMLImageElement, picData: ImageData) {
  const W = d.width, H = d.height;
  const t0 = performance.now();
  const { result, sc, pic, target } = await fit(d, picData);
  const cam = camera(result.cam, sc.centre, sc.radius, W, H);
  sc.setOffsets(result.cam.offsets);
  // booklet-style render
  renderer.setRenderTarget(target);
  renderer.render(sc.look, cam);
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, buf);
  renderer.setRenderTarget(null);
  const render = canvasOf(W, H);
  const rimg = render.getContext('2d')!.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) rimg.data[(y * W + x) * 4 + k] = buf[((H - 1 - y) * W + x) * 4 + k];
  render.getContext('2d')!.putImageData(rimg, 0, 0);
  // overlay: picture with the render's edges in magenta, the new parts' edges in yellow
  const edges = readScene(sc.edges, cam, W, H, target);
  const over = canvasOf(W, H);
  const oc = over.getContext('2d')!;
  oc.drawImage(img, 0, 0);
  const od = oc.getImageData(0, 0, W, H);
  for (let p = 0; p < W * H; p++) if (edges[p] > 127) { od.data[p * 4] = 255; od.data[p * 4 + 1] = 0; od.data[p * 4 + 2] = 255; }
  oc.putImageData(od, 0, 0);
  // difference: green = both, red = picture only, blue = render only
  const mask = readScene(sc.mask, cam, W, H, target);
  const diff = canvasOf(W, H);
  const dc = diff.getContext('2d')!;
  const dd = dc.createImageData(W, H);
  for (let p = 0; p < W * H; p++) {
    const a = mask[p] > 127, b = pic.fg[p] === 1;
    dd.data[p * 4] = b && !a ? 230 : 30; dd.data[p * 4 + 1] = a && b ? 170 : 30; dd.data[p * 4 + 2] = a && !b ? 230 : 30; dd.data[p * 4 + 3] = 255;
  }
  dc.putImageData(dd, 0, 0);
  // after the move: offsets removed, i.e. the parts at their snapped place; the picture with the drawn
  // pose (magenta) and the snapped pose (cyan) edges, and the snapped model rendered
  const moved = result.cam.offsets.some((o) => Math.hypot(o[0], o[1], o[2]) > 1);
  const snapPanels: [HTMLElement, string][] = [];
  if (moved) {
    sc.setOffsets(result.cam.offsets.map(() => [0, 0, 0]));
    const finalEdges = readScene(sc.edges, cam, W, H, target);
    const both = canvasOf(W, H);
    const bc = both.getContext('2d')!;
    bc.drawImage(img, 0, 0);
    const bd = bc.getImageData(0, 0, W, H);
    for (let p = 0; p < W * H; p++) {
      if (edges[p] > 127) { bd.data[p * 4] = 255; bd.data[p * 4 + 1] = 0; bd.data[p * 4 + 2] = 255; }
      if (finalEdges[p] > 127) { bd.data[p * 4] = 0; bd.data[p * 4 + 1] = 230; bd.data[p * 4 + 2] = 255; }
    }
    bc.putImageData(bd, 0, 0);
    renderer.setRenderTarget(target);
    renderer.render(sc.look, cam);
    const fb = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(target, 0, 0, W, H, fb);
    renderer.setRenderTarget(null);
    const fin = canvasOf(W, H);
    const fimg = fin.getContext('2d')!.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) fimg.data[(y * W + x) * 4 + k] = fb[((H - 1 - y) * W + x) * 4 + k];
    fin.getContext('2d')!.putImageData(fimg, 0, 0);
    snapPanels.push([both, 'magenta: where drawn · cyan: snapped along the arrow'], [fin, 'snapped model (three.js)']);
    sc.setOffsets(result.cam.offsets);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const c = result.cam;
  const info = document.createElement('div');
  info.className = 'info';
  info.textContent = `step ${d.step} (p${d.page})\n${d.parts.length} parts, ${d.parts.filter((p) => p.new).length} new\n\n` +
    `silhouette IoU ${result.iou.toFixed(3)}\nedge distance ${result.chamfer.toFixed(2)} px\n\n` +
    `yaw ${c.yaw.toFixed(1)}  pitch ${c.pitch.toFixed(1)}\nroll ${c.roll.toFixed(1)}  up ${c.up > 0 ? 'upright' : 'turned over'}\n` +
    `scale ${c.scale.toFixed(3)} px/LDU\n${c.persp > 0 ? `perspective, ${c.persp} radii` : 'orthographic'}\nnew-part offsets (LDU):\n${c.offsets.map((o) => '  ' + o.map((x) => x.toFixed(1)).join(', ')).join('\n')}\n` +
    (result.candReport.length ? `\nchosen connections (score, margin):\n${result.candReport.map((r) => `  ${r.part.replace('.dat', '')} ${r.score.toFixed(3)} +${r.margin.toFixed(3)}`).join('\n')}\n` : '') +
    `${((performance.now() - t0) / 1000).toFixed(1)} s`;
  (window as unknown as { fits: unknown[] }).fits.push({ step: d.step, ...result });
  for (const [el, cap] of [[img.cloneNode() as HTMLElement, 'booklet'], [render, 'three.js render'], [over, 'overlay (render edges)'], [diff, 'green both · red picture only · blue render only'], ...snapPanels] as [HTMLElement, string][]) {
    const box = document.createElement('div');
    if (el instanceof HTMLImageElement) { el.style.width = `${W * ZOOM}px`; el.style.height = `${H * ZOOM}px`; }
    box.append(el);
    const cp = document.createElement('div'); cp.className = 'cap'; cp.textContent = cap; box.append(cp);
    row.append(box);
  }
  row.prepend(info);
  rows.append(row);
}

// ------------------------------------------------------------------ one camera for the whole section

/** Calibrate the shared camera, then solve framing, turnover and explosions independently.
 * The camera is perspective: one eye distance in LDU for the whole section (?dist=, default 6850, fitted with the
 * rest), so the end nearest the viewer is drawn larger. ?ortho=1 keeps the orthographic fit for comparison. */
async function joint(steps: { d: StepData; img: HTMLImageElement; data: ImageData }[], visible: Set<StepData>) {
  if (!steps.length) throw new Error('No reference steps selected');
  const pause = () => new Promise((r) => setTimeout(r, 0));
  const trust = new Set((QS.get('trust') ?? '').split(',').filter(Boolean).map(Number));
  // A small early assembly avoids letting a later exploded drawing define the camera.
  const anchor = steps.find((s) => s.d.step === Number(QS.get('anchor'))) ??
    steps.find((s) => !s.d.flipped && s.d.parts.length >= 4) ?? steps[0];
  let prior = QS.get('prior')?.split(',').map(Number);
  if (prior && (prior.length < 4 || prior.length > 5 || prior.some((n) => !Number.isFinite(n)) || prior[3] <= 0)) throw new Error('prior must be yaw,pitch,roll,positiveScale[,eyeDistanceLdu]');
  const CN = await loadCoordnet();
  const cnOf = (d: StepData) => (CN && d.name && !d.draft ? CN[d.name] : undefined);
  // the shared camera (for steps CoordNet has not solved) starts from the anchor's CoordNet camera
  const anchorCN = cnOf(anchor.d);
  if (!prior && anchorCN && !QS.get('refpts')) prior = [anchorCN.cam.yaw, anchorCN.cam.pitch, anchorCN.cam.roll, anchorCN.cam.scale, anchorCN.cam.eye];
  const ORTHO = QS.get('ortho') === '1';
  const dist0 = ORTHO ? 0 : prior?.[4] ?? Number(QS.get('dist') ?? 6850);
  if (QS.get('lock') === '1' && !prior) throw new Error('lock=1 requires prior=yaw,pitch,roll,scale');
  if (!prior) {
    st.textContent = `calibrating camera from step ${anchor.d.step}…`;
    await pause();
    const seed = await fit(anchor.d, anchor.data, true);
    const c = seed.result.cam;
    // Express a below-model camera as an upright camera with the model turned over.
    prior = c.up === 1 ? [c.yaw, c.pitch, c.roll, c.scale] : [180 - c.yaw, -c.pitch, c.roll, c.scale];
    seed.target.dispose();
  }
  trust.add(anchor.d.step);
  // ?refpts=: the points per pixel the prior's scale belongs to, when its anchor step is not loaded
  const referencePts = Number(QS.get('refpts')) || anchor.d.ptsPerPx;
  const S = steps.map(({ d, data }) => {
    const sc = buildScenes(d), pic = pictureMasks(data);
    const hasBase = d.parts.some((p) => !p.new);
    const hideNew = hasBase && !trust.has(d.step) && d.exploded !== false;
    // the red outline is the booklet's own trace of the new parts; a step of only new parts has red arrows, not outlines
    const useRed = hasBase && pic.redCount > 50;
    sc.setNewVisible(!hideNew);
    const cn = cnOf(d);
    // CoordNet's camera looks at the centre it was solved with (its own part geometry's box), not this scene's box
    const base = cn ? new THREE.Vector3(cn.centre[0], cn.centre[1], cn.centre[2]) : sc.centre.clone();
    return { d, sc, pic, cn, base, target: new THREE.WebGLRenderTarget(d.width, d.height), centre: base.clone(),
      hideNew, useRed, turned: d.flipped, W: d.width, H: d.height, offsets: sc.newParts.map(() => [0, 0, 0]),
      screen: sc.newParts.map(() => [0, 0]) };
  });
  const turn = (i: number, turned: boolean) => {
    const s = S[i]; s.turned = turned;
    for (const scene of [s.sc.mask, s.sc.look, s.sc.edges, s.sc.fresh]) { scene.rotation.x = turned ? Math.PI : 0; scene.updateMatrixWorld(true); }
    s.centre.copy(s.base).applyAxisAngle(new THREE.Vector3(1, 0, 0), turned ? Math.PI : 0);
  };
  S.forEach((s, i) => turn(i, s.turned));
  // shared: yaw, pitch, roll, log scale, log eye distance (LDU); then each step's image position
  const P0 = 5;
  const eye = (v: number[]) => (ORTHO ? 0 : Math.exp(v[4]));
  const camOf = (v: number[], i: number): Cam => ({ yaw: v[0], pitch: v[1], roll: v[2],
    scale: rasterScale(Math.exp(v[3]), referencePts, S[i].d.ptsPerPx),
    cx: v[P0 + 2 * i], cy: v[P0 + 1 + 2 * i], up: 1, persp: perspectiveRadii(eye(v), S[i].sc.radius), offsets: S[i].offsets });
  const lossOf = (i: number, c: Cam) => {
    const s = S[i]; renderer.setSize(s.W, s.H, false);
    s.sc.setOffsets(s.offsets);
    const cam = camera(c, s.centre, s.sc.radius, s.W, s.H);
    const m = readScene(s.sc.mask, cam, s.W, s.H, s.target);
    let inter = 0, uni = 0;
    for (let p = 0; p < s.W * s.H; p++) {
      if (s.hideNew && s.pic.newRegion[p]) continue;
      const a = m[p] > 127, b = s.pic.fg[p] === 1; if (a && b) inter++; if (a || b) uni++;
    }
    const e = readScene(s.sc.edges, cam, s.W, s.H, s.target);
    let sum = 0, n = 0;
    for (let p = 0; p < s.W * s.H; p++) if (e[p] > 127 && !(s.hideNew && s.pic.newRegion[p])) { sum += Math.min(s.pic.dist[p], 8); n++; }
    // and back: every printed line on or near the model needs a rendered line close by. One way only, a render
    // shifted by a plate or a stud still lands its lines on other printed stud rows and plate edges.
    const inkD = distanceTransform(e.map((x) => (x > 127 ? 1 : 0)), s.W, s.H);
    const nearD = distanceTransform(m.map((x) => (x > 127 ? 1 : 0)), s.W, s.H);
    let bsum = 0, bn = 0;
    for (let p = 0; p < s.W * s.H; p++) if (s.pic.edge[p] && nearD[p] <= 12 && !(s.hideNew && s.pic.newRegion[p])) { bsum += Math.min(inkD[p], 8); bn++; }
    let red = null;
    if (s.useRed && !s.hideNew) {
      const seen = readScene(s.sc.fresh, cam, s.W, s.H, s.target);
      s.sc.setHiding(false);
      const own = readScene(s.sc.fresh, cam, s.W, s.H, s.target);
      s.sc.setHiding(true);
      red = redOutline(s, seen, own);
    }
    return { iou: inter / Math.max(uni, 1), edge: n ? sum / n : 8, back: bn ? bsum / bn : 8, m, e, red };
  };
  /** The new parts' outline against the booklet's red outline, both ways (pixels, capped at 12): how far the
   * render's outline lies from the red line, and how far the red line lies from the render's. The booklet draws red
   * only where a new part's own outline ends (its contour), not where an earlier part in front hides it, so a rim
   * pixel of the visible area counts only when the pixel beyond it is outside the new parts' own silhouette. */
  function redOutline(s: { W: number; H: number; pic: ReturnType<typeof pictureMasks> }, f: Uint8Array, own: Uint8Array) {
    const { W, H, pic } = s;
    const rim = new Uint8Array(W * H);
    let toRed = 0, nRim = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (f[p] <= 127) continue;
      const ends = (q: number) => f[q] <= 127 && own[q] <= 127;
      const out = x === 0 || y === 0 || x === W - 1 || y === H - 1 || ends(p - 1) || ends(p + 1) || ends(p - W) || ends(p + W);
      if (out) { rim[p] = 1; toRed += Math.min(pic.redDist[p], 12); nRim++; }
    }
    if (!nRim) return { toRed: 12, fromRed: 12, rim };
    const rd = distanceTransform(rim, W, H);
    let fromRed = 0;
    for (let p = 0; p < W * H; p++) if (pic.red[p]) fromRed += Math.min(rd[p], 12);
    return { toRed: toRed / nRim, fromRed: fromRed / Math.max(pic.redCount, 1), rim };
  }
  const score = (i: number, c: Cam) => {
    const r = lossOf(i, c);
    return 1 - r.iou + 0.035 * (r.edge + r.back) + (r.red ? 0.03 * (r.red.toRed + r.red.fromRed) : 0);
  };
  const placed = new Map<number, { part: string; color: number; matrix: number[] }[]>();
  const placeLog = new Map<number, string[]>();
  /** Choose each new part's pose among its connection candidates by the red outline: score every candidate alone
   * (its outline's distance to red, the red it explains, its area on background), pick greedily the set that
   * explains the most red, then swap single parts and re-fit the crop on everything while the whole score drops. */
  async function place(i: number, v: number[]): Promise<number[]> {
    const s = S[i], N = s.sc.newParts.length, log: string[] = [];
    placeLog.set(i, log);
    const types = (await (await fetch(`/_booklet/${SET}/${s.d.name}-cands.json`)).json() as { types: Record<string, number[][]> }).types;
    const typeOf = (k: number) => `${s.sc.newParts[k].part}|${s.sc.newParts[k].color}`;
    let xy = [v[P0 + 2 * i], v[P0 + 1 + 2 * i]];
    const camAt = () => ({ ...camOf(v, i), cx: xy[0], cy: xy[1] });
    const W = s.W, H = s.H;
    type Cand = { type: string; m: number[]; toRed: number; explained: Int32Array; off: number; seen: Int32Array };
    const single = (k: number, m: number[]): Cand | null => {
      for (let j = 0; j < N; j++) s.sc.setPose(j, j === k ? m : null);
      const cam = camera(camAt(), s.centre, s.sc.radius, W, H);
      const seen = readScene(s.sc.fresh, cam, W, H, s.target);
      let area = 0; for (let p = 0; p < W * H; p++) if (seen[p] > 127) area++;
      if (area < 5) return null;
      s.sc.setHiding(false); const own = readScene(s.sc.fresh, cam, W, H, s.target); s.sc.setHiding(true);
      const r = redOutline(s, seen, own);
      const rd = distanceTransform(r.rim, W, H);
      const ex: number[] = [], vis: number[] = []; let off = 0;
      for (let p = 0; p < W * H; p++) {
        if (s.pic.red[p] && rd[p] <= 2.5) ex.push(p);
        if (seen[p] > 127) { if (!s.pic.fg[p] && !s.pic.red[p]) off++; else if ((p % W) % 2 === 0 && ((p / W) | 0) % 2 === 0) vis.push(p); }
      }
      return { type: typeOf(k), m, toRed: r.toRed, explained: Int32Array.from(ex), off: off / area, seen: Int32Array.from(vis) };
    };
    const pool: Cand[] = [];
    /** ?probe=x,y,z: log what happens to the candidates at this position (debugging a wrong pick) */
    const probe = QS.get('probe')?.split(',').map(Number);
    for (const [t, list] of Object.entries(types)) {
      const k = s.sc.newParts.findIndex((_p, j) => typeOf(j) === t);
      if (k < 0) continue;
      for (let c = 0; c < list.length; c++) {
        const r = single(k, list[c]);
        if (r && r.off < 0.12) pool.push(r);       // drawn on the model, not on background
        if (probe && Math.abs(list[c][12] - probe[0]) < 1 && Math.abs(list[c][13] - probe[1]) < 1 && Math.abs(list[c][14] - probe[2]) < 1)
          log.push(`probe ${t} rot ${list[c][0]},${list[c][2]}: ${r ? `off ${r.off.toFixed(3)} toRed ${r.toRed.toFixed(2)} red ${r.explained.length} ${r.off < 0.12 ? 'in pool' : 'FILTERED'}` : 'not visible'}`);
        if (c % 50 === 0) { st.textContent = `step ${s.d.step}: scoring ${t} candidate ${c}/${list.length}`; await pause(); }
      }
    }
    log.push(`${pool.length} candidates on the drawn model`);
    const need = new Map<string, number>(); s.sc.newParts.forEach((_p, k) => need.set(typeOf(k), (need.get(typeOf(k)) ?? 0) + 1));
    const asParts = (sel: Cand[]) => [...s.d.parts.filter((p) => !p.new), ...sel.map((c) => ({ part: c.type.split('|')[0], matrix: c.m, new: true }))];
    const clear = (sel: Cand[]) => auditBookletAssembly(asParts(sel), metricsOf).collisions.every((c) => c.b < s.d.parts.filter((p) => !p.new).length);
    // greedy: shortlist by the picture area a candidate fills that nothing rendered explains yet (and red it
    // explains), choose among the shortlist by the whole page score (lines both ways, silhouette, red outline)
    for (let j = 0; j < N; j++) s.sc.setPose(j, null);
    const baseMask = readScene(s.sc.mask, camera(camAt(), s.centre, s.sc.radius, W, H), W, H, s.target);
    const covered = new Uint8Array(W * H), redCovered = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) covered[p] = baseMask[p] > 127 ? 1 : 0;
    let chosen: Cand[] = [];
    const show = (sel: Cand[]) => {
      const free = sel.slice();
      for (let k = 0; k < N; k++) { const j = free.findIndex((c) => c.type === typeOf(k)); s.sc.setPose(k, j >= 0 ? free.splice(j, 1)[0].m : null); }
    };
    for (;;) {
      const short = pool.filter((c) => need.get(c.type) && !chosen.includes(c)).map((c) => {
        let fill = 0, red = 0;
        for (const p of c.seen) if (!covered[p]) fill += 4;
        for (const p of c.explained) if (!redCovered[p]) red++;
        return { c, g: fill + 20 * red };
      }).sort((a, b) => b.g - a.g).slice(0, 24);
      if (!short.length) break;
      let best: { l: number; c: Cand } | null = null;
      for (const { c } of short) {
        const trial = [...chosen, c];
        show(trial); const l = score(i, camAt());
        if ((!best || l < best.l) && clear(trial)) best = { l, c };
      }
      if (!best) break;
      chosen.push(best.c); need.set(best.c.type, need.get(best.c.type)! - 1);
      for (const p of best.c.seen) covered[p] = 1;
      for (const p of best.c.explained) redCovered[p] = 1;
      log.push(`pick ${best.c.type} score ${best.l.toFixed(4)}`);
      st.textContent = `step ${s.d.step}: placed ${chosen.length}/${N}`; await pause();
    }
    if ([...need.values()].some((n) => n > 0)) log.push(`MISSING ${[...need.entries()].filter(([, n]) => n > 0).map(([t, n]) => `${n}x ${t}`).join(', ')}`);
    // the crop for a set of parts: a grid of +-30 px (a plate or a stud is ~15-35 px, so a fixed crop would trap a
    // wrong part that compensates for a crop one plate off), then Nelder-Mead
    const fitCrop = (sel: Cand[], from: number[], wide: boolean) => {
      show(sel);
      const f = (x: number[]) => score(i, { ...camOf(v, i), cx: x[0], cy: x[1] });
      let best = { l: f(from), x: from };
      if (wide) for (let dx = -30; dx <= 30; dx += 6) for (let dy = -30; dy <= 30; dy += 6) {
        const x = [from[0] + dx, from[1] + dy], l = f(x); if (l < best.l) best = { l, x };
      }
      const x = nelderMead(f, best.x, [2, 2], 60);
      return { x, l: f(x) };
    };
    let fitted = fitCrop(chosen, xy, true); xy = fitted.x;
    let cur = fitted.l;
    log.push(`crop ${xy.map((n) => n.toFixed(1)).join(', ')} score ${cur.toFixed(4)}`);
    for (let round = 0; round < 10; round++) {
      st.textContent = `step ${s.d.step}: placement round ${round + 1}, score ${cur.toFixed(4)}`; await pause();
      // single swaps at the held crop shortlist; the best few are judged with the crop re-fitted
      const trials: { l: number; k: number; c: Cand }[] = [];
      for (let k = 0; k < chosen.length; k++) for (const c of pool) {
        if (c.type !== chosen[k].type || chosen.includes(c)) continue;
        const trial = chosen.slice(); trial[k] = c;
        show(trial); trials.push({ l: score(i, camAt()), k, c });
      }
      trials.sort((a, b) => a.l - b.l);
      let swapped = false;
      for (const t of trials.slice(0, 12)) {
        const trial = chosen.slice(); trial[t.k] = t.c;
        const r = fitCrop(trial, xy, true);
        if (r.l < cur - 1e-4 && clear(trial)) { chosen = trial; cur = r.l; xy = r.x; swapped = true; log.push(`swap ${t.k} -> ${t.c.type} at ${t.c.m.slice(12, 15).join(',')}: ${cur.toFixed(4)}, crop ${xy.map((n) => n.toFixed(1)).join(', ')}`); break; }
      }
      if (!swapped) break;
    }
    if (probe) for (let k = 0; k < chosen.length; k++) for (const c of pool) {
      if (c.type !== chosen[k].type || Math.hypot(c.m[12] - probe[0], c.m[13] - probe[1], c.m[14] - probe[2]) > 1) continue;
      const trial = chosen.slice(); trial[k] = c; const r = fitCrop(trial, xy, true);
      log.push(`probe swap into ${k}: score ${r.l.toFixed(4)} (crop re-fitted ${r.x.map((n) => n.toFixed(1)).join(', ')}) vs ${cur.toFixed(4)}, clear ${clear(trial)}`);
    }
    show(chosen);
    // the step now holds the chosen poses as its assembled new parts
    const free = chosen.slice();
    s.d.parts.forEach((p) => { if (!p.new) return; const j = free.findIndex((c) => c.type === `${p.part}|${p.color}`); if (j >= 0) p.matrix = free.splice(j, 1)[0].m; });
    // (the scene keeps showing them through setPose; its centre stays the one the crop was fitted with)
    placed.set(i, s.d.parts.filter((p) => p.new).map((p) => ({ part: p.part, color: p.color, matrix: p.matrix })));
    return xy;
  }
  let v = [prior[0], prior[1], prior[2], Math.log(prior[3]), Math.log(Math.max(dist0, 1)), ...S.flatMap((s) => [s.W / 2, s.H / 2])];
  // Frame and test model turnover without allowing camera drift.
  for (let i = 0; i < S.length; i++) {
    const cn = S[i].cn;
    if (cn) {                     // framing and turnover come with the CoordNet camera
      turn(i, cn.cam.turned); v[P0 + 2 * i] = cn.cam.cx; v[P0 + 1 + 2 * i] = cn.cam.cy;
      continue;
    }
    const s = S[i], hideNew = s.hideNew, draft = PLACE && !!s.d.draft, useRed = s.useRed;
    s.hideNew = false; s.sc.setNewVisible(!draft);
    if (draft) s.useRed = false;
    let best = { loss: Infinity, xy: [s.W / 2, s.H / 2], turned: s.turned };
    for (const flipped of s.d.parts.every((p) => p.new) || draft ? [s.d.flipped] : [s.d.flipped, !s.d.flipped]) {
      turn(i, flipped);
      let xy = [s.W / 2, s.H / 2], bestCoarse = Infinity;
      for (let dx = -s.W / 3; dx <= s.W / 3; dx += 12) for (let dy = -s.H / 3; dy <= s.H / 3; dy += 12) {
        const c = { ...camOf(v, i), cx: s.W / 2 + dx, cy: s.H / 2 + dy };
        const l = score(i, c); if (l < bestCoarse) { bestCoarse = l; xy = [c.cx, c.cy]; }
      }
      const loss = (x: number[]) => score(i, { ...camOf(v, i), cx: x[0], cy: x[1] });
      xy = nelderMead(loss, xy, [4, 4], 100);
      if (loss(xy) < best.loss - 0.035) best = { loss: loss(xy), xy, turned: flipped };
    }
    s.hideNew = hideNew; s.sc.setNewVisible(!hideNew); s.useRed = useRed;
    turn(i, best.turned); v[P0 + 2 * i] = best.xy[0]; v[P0 + 1 + 2 * i] = best.xy[1];
    if (draft) {
      const xy = await place(i, v);
      v[P0 + 2 * i] = xy[0]; v[P0 + 1 + 2 * i] = xy[1];
    }
    st.textContent = `registered step ${s.d.step}; calibrating shared camera…`; await pause();
  }
  const calibration = S.map((s, i) => !s.cn && !s.d.draft && (s.d.parts.some((p) => !p.new) || trust.has(s.d.step)) ? i : -1).filter((i) => i >= 0);
  const total = (x: number[]) => calibration.reduce((sum, i) => sum + score(i, camOf(x, i)), 0) / Math.max(calibration.length, 1);
  for (const [k, iters] of (QS.get('lock') === '1' || !calibration.length ? [] : [[1, 220], [0.3, 180]]) as [number, number][]) {
    v = nelderMead(total, v, [2 * k, 2 * k, k, 0.02 * k, ORTHO ? 1e-9 : 0.3 * k, ...S.flatMap(() => [2 * k, 2 * k])], iters);
    st.textContent = `shared camera refined; fitting exploded parts…`; await pause();
  }
  // Only image-plane displacement is observable. Keep it separate from shared extrinsics.
  const out = [];
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    if (!visible.has(s.d)) { s.target.dispose(); continue; }
    const W = s.W, H = s.H;
    const c: Cam = s.cn
      ? { yaw: s.cn.cam.yaw, pitch: s.cn.cam.pitch, roll: s.cn.cam.roll, scale: s.cn.cam.scale, cx: s.cn.cam.cx,
          cy: s.cn.cam.cy, up: 1, persp: perspectiveRadii(s.cn.cam.eye, s.sc.radius), offsets: s.offsets }
      : camOf(v, i);
    const baseStats = lossOf(i, c);
    s.hideNew = false; s.sc.setNewVisible(true);
    let cam = camera(c, s.centre, s.sc.radius, W, H);
    const assembly = auditBookletAssembly(s.d.parts, metricsOf);
    const assembledOnly = s.d.exploded === false;
    const apply = () => { s.offsets = s.screen.map(([dx, dy]) => screenOffset(cam, c.scale, dx, dy, s.turned)); };
    const evaluate = () => { apply(); return score(i, c) + 0.0003 * s.screen.reduce((sum, p) => sum + Math.hypot(...p), 0) / Math.max(s.screen.length, 1); };
    const assembledLoss = evaluate();
    if (!assembledOnly) {
    // A common lift is a useful start for parts that are exploded as a group.
    let best = assembledLoss, shared = [0, 0];
    for (let dy = -120; dy <= 120; dy += 8) {
      s.screen = s.screen.map(() => [0, dy]); const l = evaluate();
      if (l < best) { best = l; shared = [0, dy]; }
    }
    s.screen = s.screen.map(() => shared.slice());
    for (let round = 0; round < 2; round++) for (let k = 0; k < s.screen.length; k++) {
      let xy = s.screen[k].slice(), l0 = evaluate();
      let coarseXY = xy.slice();
      if (round === 0) for (const dx of [-72, -48, -24, 0, 24, 48, 72]) for (const dy of [-96, -72, -48, -24, 0, 24, 48, 72, 96]) {
        s.screen[k] = [xy[0] + dx, xy[1] + dy];
        if (Math.abs(s.screen[k][0]) > W / 2 || Math.abs(s.screen[k][1]) > H / 2) continue;
        const l = evaluate();
        if (l < l0) { l0 = l; coarseXY = s.screen[k].slice(); }
      }
      xy = coarseXY;
      s.screen[k] = xy;
      const fn = (p: number[]) => {
        if (Math.abs(p[0]) > W / 2 || Math.abs(p[1]) > H / 2) return 10;
        s.screen[k] = p; return evaluate();
      };
      const result = nelderMead(fn, xy, [3, 3], 90);
      s.screen[k] = result; best = evaluate();
      st.textContent = `step ${s.d.step}: exploded part ${k + 1}/${s.screen.length}, pass ${round + 1}`; await pause();
    }
    // Nearby assembled parts can occlude each other. Move these pairs together so a
    // coordinate search cannot trap one part behind its neighbour.
    for (let k = 0; k < s.screen.length; k++) for (let j = k + 1; j < s.screen.length; j++) {
      const p = s.sc.newParts[k].matrix, q = s.sc.newParts[j].matrix;
      if (Math.hypot(p[12] - q[12], p[13] - q[13], p[14] - q[14]) > 60) continue;
      const start = [...s.screen[k], ...s.screen[j]];
      let pair = start.slice(), pairLoss = evaluate();
      const loss = (x: number[]) => {
        if (Math.abs(x[0]) > W / 2 || Math.abs(x[2]) > W / 2 || Math.abs(x[1]) > H / 2 || Math.abs(x[3]) > H / 2) return 10;
        s.screen[k] = x.slice(0, 2); s.screen[j] = x.slice(2, 4); return evaluate();
      };
      for (const dy of [-72, -48, -24, 0, 24, 48, 72]) for (const ey of [-72, -48, -24, 0, 24, 48, 72]) {
        const x = [start[0], start[1] + dy, start[2], start[3] + ey], l = loss(x);
        if (l < pairLoss) { pairLoss = l; pair = x; }
      }
      pair = nelderMead(loss, pair, [3, 3, 3, 3], 180); loss(pair);
      st.textContent = `step ${s.d.step}: refining neighbouring exploded parts`; await pause();
    }
    } else if (!s.cn) {
      // An assembled drawing cannot change part transforms to improve a pixel score.
      // Refine the crop translation with the whole assembly visible instead.
      const frameLoss = (xy: number[]) => {
        c.cx = xy[0]; c.cy = xy[1]; cam = camera(c, s.centre, s.sc.radius, W, H); return evaluate();
      };
      frameLoss(nelderMead(frameLoss, [c.cx, c.cy], [2, 2], 160));
    }
    apply(); c.offsets = s.offsets;
    const r = lossOf(i, c);
    const rd = distanceTransform(r.e.map((x) => x > 127 ? 1 : 0), W, H);
    const a: number[] = [], b: number[] = [];
    for (let p = 0; p < W * H; p++) {
      if (r.e[p] > 127) a.push(s.pic.dist[p]);
      if (s.pic.edge[p] && r.m[p] > 127) b.push(rd[p]);
    }
    const q = (xs: number[], f: number) => { const t = xs.slice().sort((x, y) => x - y); return t.length ? t[Math.floor(f * (t.length - 1))] : null; };
    const stats = { iou: r.iou, renderToPic: { median: q(a, .5), p90: q(a, .9) }, picToRender: { median: q(b, .5), p90: q(b, .9) },
      redOutline: r.red ? { toRed: r.red.toRed, fromRed: r.red.fromRed } : null };
    out.push({ step: s.d.step, placed: placed.get(i), placeLog: placeLog.get(i), cam: c, turned: s.turned, screenOffsets: s.screen, presentation: assembledOnly ? 'assembled' : 'exploded-fit', assembly, baseIou: baseStats.iou, ...stats });
    const render = canvasOf(W, H); renderer.setRenderTarget(s.target); renderer.render(s.sc.look, cam);
    const pixels = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(s.target, 0, 0, W, H, pixels); renderer.setRenderTarget(null);
    const rc = render.getContext('2d')!, ri = rc.createImageData(W, H);
    for (let y = 0; y < H; y++) ri.data.set(pixels.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    rc.putImageData(ri, 0, 0);
    const over = canvasOf(W, H), oc = over.getContext('2d')!; oc.drawImage(steps[i].img, 0, 0);
    const od = oc.getImageData(0, 0, W, H);
    for (let p = 0; p < W * H; p++) if (r.e[p] > 127) { od.data[p * 4] = 255; od.data[p * 4 + 1] = 0; od.data[p * 4 + 2] = 255; }
    // the outline of the new parts' visible area (green), to compare with the booklet's red outline
    if (r.red) for (let p = 0; p < W * H; p++) if (r.red.rim[p]) { od.data[p * 4] = 0; od.data[p * 4 + 1] = 255; od.data[p * 4 + 2] = 0; }
    oc.putImageData(od, 0, 0);
    const diff = canvasOf(W, H), dc = diff.getContext('2d')!, dd = dc.createImageData(W, H);
    for (let p = 0; p < W * H; p++) {
      const A = r.m[p] > 127, B = s.pic.fg[p] === 1;
      dd.data[p * 4] = B && !A ? 230 : 30; dd.data[p * 4 + 1] = A && B ? 170 : 30; dd.data[p * 4 + 2] = A && !B ? 230 : 30; dd.data[p * 4 + 3] = 255;
    }
    dc.putImageData(dd, 0, 0);
    const row = document.createElement('div'); row.className = 'row'; row.dataset.step = String(s.d.step);
    const info = document.createElement('div'); info.className = 'info';
    const fmt = (n: number | null) => n === null ? 'n/a' : n.toFixed(2);
    info.textContent = `Step ${s.d.step} · page ${s.d.page}\nCamera: ${s.cn ? 'CoordNet' : 'page fit'}${s.turned ? '\nModel turned over' : ''}${assembledOnly ? '\nAssembled poses held fixed' : ''}\nAssembly check: ${assembly.collisions.length} collision pairs\nMissing meshes: ${assembly.missingGeometry.length}\nNew-part connector mates: ${assembly.newPartContacts.map((p) => p.mates.length).join(', ')}\n\nSilhouette IoU ${r.iou.toFixed(3)}\nEdge error: median / p90\nRender → picture ${fmt(stats.renderToPic.median)} / ${fmt(stats.renderToPic.p90)} px\nPicture → render ${fmt(stats.picToRender.median)} / ${fmt(stats.picToRender.p90)} px\n${stats.redOutline ? `Red outline (mean)\n  render → red ${stats.redOutline.toRed.toFixed(2)} px\n  red → render ${stats.redOutline.fromRed.toFixed(2)} px\n` : 'Red outline: not used\n'}\n${stats.renderToPic.p90 !== null && stats.renderToPic.p90 <= 1 && stats.picToRender.p90 !== null && stats.picToRender.p90 <= 1 && stats.iou >= .98 ? 'Within 1 px (p90)' : 'Residual mismatch — inspect overlay'}\n\nExploded offsets (image px)\n${s.screen.map((p, k) => `${s.sc.newParts[k].part}: ${p.map((n) => n.toFixed(1)).join(', ')}`).join('\n')}`;
    row.append(info);
    const ref = steps[i].img.cloneNode() as HTMLImageElement; ref.style.width = `${W * ZOOM}px`; ref.style.height = `${H * ZOOM}px`;
    for (const [el, cap] of [[ref, 'Booklet reference'], [render, 'Three.js · fitted exploded pose'], [over, r.red ? 'Overlay · rendered edges magenta · new parts\' outline green (booklet: red)' : 'Overlay · rendered edges in magenta'], [diff, 'Difference · green overlap / red reference / blue render']] as [HTMLElement, string][]) {
      const box = document.createElement('div'); box.append(el); const cp = document.createElement('div'); cp.className = 'cap'; cp.textContent = cap; box.append(cp); row.append(box);
    }
    rows.append(row); s.target.dispose();
  }
  const shared = { yaw: v[0], pitch: v[1], roll: v[2], scale: Math.exp(v[3]), eyeDistanceLdu: eye(v), referencePtsPerPx: referencePts };
  const report = { set: SET, projection: ORTHO ? 'orthographic' : 'perspective', anchor: anchor.d.step, calibrationSteps: S.map((s) => s.d.step), shared, steps: out,
    limitations: 'Known part geometry and assembled poses required. Explosion depth is unobservable; offsets use the camera plane. Rotated sections require separate calibration.' };
  const head = document.createElement('div'); head.className = 'summary';
  const nCN = S.filter((s) => s.cn).length;
  head.textContent = nCN === S.length
    ? `Cameras from CoordNet (coordnet.json), one per step, for all ${S.length} steps; displaying ${out.length}. ?fit=1 runs the page's own fit.`
    : `Shared camera · yaw ${shared.yaw.toFixed(2)}° · pitch ${shared.pitch.toFixed(2)}° · roll ${shared.roll.toFixed(2)}° · ${shared.scale.toFixed(4)} px/LDU · ${ORTHO ? 'orthographic' : `perspective, eye ${shared.eyeDistanceLdu.toFixed(0)} LDU`}. Calibrated across ${calibration.length} reference steps; ${nCN} of ${S.length} steps use CoordNet cameras; displaying ${out.length}.`;
  const download = document.createElement('a'); download.textContent = 'Download camera + per-step poses';
  download.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); download.download = `${SET}-camera.json`; head.append(document.createElement('br'), download); rows.prepend(head);
  (window as unknown as { joint: unknown }).joint = report;
}

async function main() {
  (window as unknown as { fits: unknown[] }).fits = [];
  await initPartService();
  const index = await (await fetch(`/_booklet/${SET}/index.json`)).json() as { steps: { step: number; name: string }[] };
  const want = QS.get('steps')?.trim() ? QS.get('steps')!.split(',').map(Number) : undefined;
  const names = QS.get('names')?.split(',');
  const todo = names ? names.map((n) => ({ step: 0, name: n })) : index.steps.filter((s) => !want || want.includes(s.step));
  if (QS.get('joint') !== '0') {
    // The view selection must never change the calibration anchor, camera objective,
    // or optimizer dimension. Calibrate against the complete indexed booklet.
    const references = names ? todo : index.steps;
    const selectedNames = new Set(todo.map((s) => s.name));
    const visible = new Set<StepData>();
    const loaded = [];
    for (const s of references) {
      const d = await (await fetch(`/_booklet/${SET}/${s.name}.json`)).json() as StepData;
      d.name = s.name;
      await ensureParts([...new Set(d.parts.map((p) => p.part))]);
      const img = new Image(); img.src = `/_booklet/${SET}/${s.name}.png`; await img.decode();
      const c = document.createElement('canvas'); c.width = d.width; c.height = d.height;
      const cx = c.getContext('2d')!; cx.drawImage(img, 0, 0);
      loaded.push({ d, img, data: cx.getImageData(0, 0, d.width, d.height) });
      if (selectedNames.has(s.name)) visible.add(d);
    }
    if (!visible.size) throw new Error('No reference steps selected');
    await joint(loaded, visible);
    st.textContent = `done: booklet camera calibrated from ${references.length} references; showing ${todo.length} steps of ${SET}`;
    (window as unknown as { done: boolean }).done = true;
    return;
  }
  for (const s of todo) {
    st.textContent = `fitting step ${s.step}…`;
    STEPNAME = s.name;
    const d = await (await fetch(`/_booklet/${SET}/${s.name}.json`)).json() as StepData;
    await ensureParts([...new Set(d.parts.map((p) => p.part))]);
    const img = new Image();
    img.src = `/_booklet/${SET}/${s.name}.png`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = d.width; c.height = d.height;
    const cx = c.getContext('2d')!;
    cx.drawImage(img, 0, 0);
    await show(d, img, cx.getImageData(0, 0, d.width, d.height));
  }
  st.textContent = `done: ${todo.length} steps of ${SET}`;
  (window as unknown as { done: boolean }).done = true;
}

main().catch((e) => { (window as unknown as { error: string }).error = String(e); st.textContent = `error: ${e?.stack ?? e}`; console.error(e); });
