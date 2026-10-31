import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import { clamp01, easeInOutCubic, lerp } from './easing';
import type { Timeline } from './timeline';

export type CamPose = { position: THREE.Vector3; target: THREE.Vector3; fov: number };

export type CameraFraming = 'cinematic' | 'wide';
export type CameraSettings = {
  /** Blender-style focal length and sensor width. Three's PerspectiveCamera uses vertical FOV, derived for the output aspect. */
  lensMm: number;
  sensorWidthMm: number;
  buildAzimuth: number;
  buildElevation: number;
  buildMargin: number;
  /** 0 follows changing build bounds, 1 locks the aim to the finished model centre. */
  targetLock: number;
  /** 1 frames only the submodel being built; 0 keeps the main model in the shot as well. */
  submodelFocus: number;
  /** Maximum build-time azimuth drift, in degrees. */
  buildDrift: number;
  /** 0 reacts immediately, 1 heavily damps automatic target/zoom changes. */
  damping: number;
  heroOrbitDegrees: number;
  heroElevation: number;
  heroMargin: number;
};

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  lensMm: 52,
  sensorWidthMm: 36,
  buildAzimuth: 16,
  buildElevation: 60,
  buildMargin: 1.10,
  targetLock: 0.86,
  submodelFocus: 1,
  buildDrift: 5,
  damping: 0.82,
  heroOrbitDegrees: 120,
  heroElevation: 30,
  heroMargin: 1.14,
};

/** The reference product-shot camera: a long lens looking down at a high diagonal,
 * steady through the build and with a short, gentle hero orbit. */
export const FLAT_LAY_CAMERA: Partial<CameraSettings> = {
  lensMm: 100, buildAzimuth: 32, buildElevation: 50, buildMargin: 1.12, buildDrift: 0,
  targetLock: 1, damping: 0.95, heroOrbitDegrees: 40, heroElevation: 46, heroMargin: 1.12,
};

export function cameraFov(settings: CameraSettings, aspect: number) {
  const lens = Math.max(1, settings.lensMm);
  const sensorW = Math.max(1, settings.sensorWidthMm);
  // Treat the configured sensor dimension as the vertical gate used by the video camera.
  // This keeps portrait output from becoming ultra-wide while preserving familiar lens behaviour.
  return THREE.MathUtils.radToDeg(2 * Math.atan(sensorW / (2 * lens)));
}
/** Cinematic follows the supplied reference: a nearly overhead, less
 * diagonal build shot and a closer, lower hero reveal. Wide is the previous
 * exact full-scene style, available if a project needs maximum coverage. */
const CAMERA = {
  cinematic: { smooth: 1.035 },
  wide: { smooth: 1.08 },
} as const;
const OUTRO_BLEND = 0.8;
/** each camera key frames everything nearby in time */
const KEY_REACH = 0.6;
const rad = THREE.MathUtils.degToRad;

/** Direction from the target to the camera; azimuth from +Z towards +X. */
function viewDir(azDeg: number, elDeg: number) {
  const az = rad(azDeg);
  const el = rad(elDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

export function sphericalPosition(target: THREE.Vector3, dist: number, azDeg: number, elDeg: number) {
  return target.clone().addScaledVector(viewDir(azDeg, elDeg), dist);
}

/** Smallest distance from the box centre at which every corner is inside the frame. */
export function fitDistance(box: THREE.Box3, fovDeg: number, aspect: number, azimuthDeg: number, elevationDeg: number): number {
  const z = viewDir(azimuthDeg, elevationDeg);
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  const c = box.getCenter(new THREE.Vector3());
  const tanV = Math.tan(rad(fovDeg) / 2);
  const tanH = tanV * aspect;
  let d = 0;
  const o = new THREE.Vector3();
  for (const px of [box.min.x, box.max.x])
    for (const py of [box.min.y, box.max.y])
      for (const pz of [box.min.z, box.max.z]) {
        o.set(px, py, pz).sub(c);
        d = Math.max(d, o.dot(z) + Math.max(Math.abs(o.dot(x)) / tanH, Math.abs(o.dot(y)) / tanV));
      }
  return Math.max(d, 1);
}

/** LDU box → world box (1 unit = 1 stud, +Y up). */
export function worldBox3(b: Box): THREE.Box3 {
  const a = new THREE.Vector3(b.min[0] / 20, -b.min[1] / 20, -b.min[2] / 20);
  const c = new THREE.Vector3(b.max[0] / 20, -b.max[1] / 20, -b.max[2] / 20);
  return new THREE.Box3(a.clone().min(c), a.max(c));
}

type Rig = { target: THREE.Vector3; dist: number; az: number; el: number };

export function fitDistanceAtTarget(box: THREE.Box3, target: THREE.Vector3, fovDeg: number, aspect: number, azimuthDeg: number, elevationDeg: number): number {
  const z = viewDir(azimuthDeg, elevationDeg);
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  const tanV = Math.tan(rad(fovDeg) / 2);
  const tanH = tanV * aspect;
  let d = 0;
  const o = new THREE.Vector3();
  for (const px of [box.min.x, box.max.x])
    for (const py of [box.min.y, box.max.y])
      for (const pz of [box.min.z, box.max.z]) {
        o.set(px, py, pz).sub(target);
        d = Math.max(d, o.dot(z) + Math.max(Math.abs(o.dot(x)) / tanH, Math.abs(o.dot(y)) / tanV));
      }
  return Math.max(d, 1);
}

const fitRig = (b: Box, aspect: number, az: number, el: number, margin: number, fov: number, target?: THREE.Vector3): Rig => {
  const box = worldBox3(b);
  const aim = target?.clone() ?? box.getCenter(new THREE.Vector3());
  return { target: aim, dist: fitDistanceAtTarget(box, aim, fov, aspect, az, el) * margin, az, el };
};

const mix = (a: Rig, b: Rig, u: number): Rig => ({
  target: a.target.clone().lerp(b.target, u),
  dist: lerp(a.dist, b.dist, u),
  az: lerp(a.az, b.az, u),
  el: lerp(a.el, b.el, u),
});

const unionBoxes = (a: Box, b: Box): Box => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});
const boxCentre = (b: Box): [number, number, number] => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2) as [number, number, number];
const contains = (b: Box, p: [number, number, number], pad: number) => [0, 1, 2].every((k) => p[k] >= b.min[k] - pad && p[k] <= b.max[k] + pad);
const volume = (b: Box) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);

/** Spacing of the build camera's framing keys (seconds). */
const FOCUS_STEP = 0.2;
/** Frame where the next pieces will land this long before they arrive. */
const LOOK_AHEAD = 1.2;
/** Start moving to the next model or submodel this long before its first piece flies. */
const SWITCH_LEAD = 0.5;
/** Widest smoothing half-window (seconds); must match `reach` in frameRigs. */
const SETTLE = 0.4;
/** While a build is young, still show at least this share of its finished size (per axis). */
const MIN_FILL = 0.6;
/** how long the camera takes to move into a close-up or out of it; the planner leaves this much time before one (CLOSE_EASE in timeline.ts) */
const CLOSE_EASE = 0.6;
/** never quicker than this: a cut, not a move */
const MIN_EASE = 0.2;

/** One thing being assembled: the main model (index 0) or a submodel at its side spot. */
type Focus = { finished: Box; lands: { start: number; land: Box }[] };
/** `shots`: when the camera holds on each submodel; the main model has the rest of the time */
type FocusPlan = { groups: Focus[]; shots: { from: number; to: number; group: number; size: number; easeIn: number; easeOut: number }[] };
const focusCache = new WeakMap<Timeline, FocusPlan>();

/** Sorts every flight into the model or submodel it lands on. Floor pieces are not part of any
 * focus, so the camera frames what is being assembled and pieces fly in from outside the shot. */
function focusPlan(tl: Timeline): FocusPlan {
  const cached = focusCache.get(tl);
  if (cached) return cached;
  const subs = tl.subBuilds.map((sb, i) => ({ sb, group: i + 1 })).sort((a, b) => volume(a.sb.focus) - volume(b.sb.focus));
  const groups: Focus[] = [{ finished: tl.modelBox, lands: [] }, ...tl.subBuilds.map((sb) => ({ finished: sb.focus, lands: [] }))];
  // Legacy part keys are paths ("sub/nested/part"), so a piece belongs to the deepest submodel
  // whose key prefixes it, and an attach lands on the submodel (or main model) around that one.
  const byKey = new Map(tl.subBuilds.map((sb, i) => [sb.key, i + 1]));
  const enclosing = (path: string): number => {
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
      const g = byKey.get(path.slice(0, cut));
      if (g) return g;
    }
    return 0;
  };
  const groupOf = (u: Timeline['units'][number], land: Box): number => {
    if (u.keys.length && u.keys.every((k) => byKey.size && enclosing(k) > 0)) {
      let g = enclosing(u.keys[0]);
      if (u.kind === 'attach') {
        // the attached submodel is the deepest one holding every key; it lands on its parent
        while (g && !u.keys.every((k) => k.startsWith(`${tl.subBuilds[g - 1].key}/`))) g = enclosing(tl.subBuilds[g - 1].key);
        return g ? enclosing(tl.subBuilds[g - 1].key) : 0;
      }
      return g;
    }
    // other planners: the smallest submodel being built then whose spot holds the landing point
    const c = boxCentre(land);
    const hit = subs.find(({ sb }) => u.start >= sb.start - 1e-6 && u.start < sb.attachStart - 1e-6 && contains(sb.focus, c, 20));
    return hit ? hit.group : 0;
  };
  const order: { start: number; end: number; group: number }[] = [];
  const touched = new Set<number>();
  for (const u of tl.units) {
    const land = u.land ?? u.box;
    if (!land || u.hidden) continue;
    const group = groupOf(u, land);
    const g = groups[group];
    g.finished = touched.has(group) ? unionBoxes(g.finished, land) : land;
    touched.add(group);
    g.lands.push({ start: u.start, land });
    order.push({ start: u.start, end: u.start + u.dur, group });
  }
  if (!touched.has(0)) groups[0].finished = tl.modelBox;
  order.sort((a, b) => a.start - b.start);
  // Each submodel holds the camera from its first flight until its last piece has landed, even
  // when other flights happen meanwhile. It is entered a little early, but not before the
  // previous landing is settled, and left SETTLE after its last landing, but early enough to
  // show the next landing (usually the finished submodel being attached).
  const shots: FocusPlan['shots'] = [];
  for (let g = 1; g < groups.length; g++) {
    const own = order.filter((o) => o.group === g);
    if (!own.length) continue;
    const first = own[0];
    const lastEnd = Math.max(...own.map((o) => o.end));
    const lastStart = Math.max(...own.map((o) => o.start));
    const others = order.filter((o) => o.group !== g);
    const prevLand = Math.max(-Infinity, ...others.filter((o) => o.start < first.start).map((o) => o.end));
    const nextLand = Math.min(Infinity, ...others.filter((o) => o.start >= lastStart - 1e-6 && o.end > lastEnd).map((o) => o.end));
    const enter = Math.max(first.start - SWITCH_LEAD, Math.min(prevLand + SETTLE, first.end - SETTLE - FOCUS_STEP));
    const exit = Math.max(lastEnd, Math.min(lastEnd + SETTLE, nextLand - SETTLE - FOCUS_STEP));
    // the moves in and out are quicker when a landing elsewhere must be shown sooner
    const easeIn = Math.max(MIN_EASE, Math.min(CLOSE_EASE, enter - prevLand));
    const easeOut = Math.max(MIN_EASE, Math.min(CLOSE_EASE, nextLand - exit - 0.05));
    shots.push({ from: enter, to: exit, group: g, size: volume(groups[g].finished), easeIn, easeOut });
  }
  const plan = { groups, shots };
  focusCache.set(tl, plan);
  return plan;
}

/** What the automatic build camera frames at time t (LDU box): the part being assembled. */
export function buildFocusBox(tl: Timeline, t: number): Box {
  const plan = focusPlan(tl);
  if (!plan.groups.some((g) => g.lands.length)) return tl.modelBox;
  return focusAt(plan, t).box;
}

/** The (sub)model being assembled around time t and the part of it the camera must show. */
function focusAt(plan: FocusPlan, t: number): { group: number; box: Box; anchor: Box; hold: string; easeIn?: number; easeOut?: number } {
  const { groups, shots } = plan;
  // every submodel held at t; a nested one is built while its parent still gets pieces, so show both
  let group = 0;
  let size = Infinity;
  let held: Box | null = null;
  const holding: number[] = [];
  let easeIn = CLOSE_EASE, easeOut = CLOSE_EASE;
  for (const sh of shots)
    if (t >= sh.from - 1e-9 && t <= sh.to + 1e-9) {
      holding.push(sh.group);
      easeIn = Math.min(easeIn, sh.easeIn);
      easeOut = Math.min(easeOut, sh.easeOut);
      held = held ? unionBoxes(held, groups[sh.group].finished) : groups[sh.group].finished;
      if (sh.size < size) ((group = sh.group), (size = sh.size));
    }
  // a submodel is small: hold one steady framing of the whole thing while it is built
  if (held) return { group, box: held, anchor: held, hold: holding.join(','), easeIn, easeOut };
  const g = groups[0];
  let box: Box | null = null;
  for (const l of g.lands) if (l.start <= t + LOOK_AHEAD) box = box ? unionBoxes(box, l.land) : l.land;
  box ??= g.lands[0]?.land ?? g.finished;
  // grow a young build towards its finished size so the first bricks are not a macro shot
  const min = [...box.min] as [number, number, number];
  const max = [...box.max] as [number, number, number];
  for (let k = 0; k < 3; k++) {
    const want = (g.finished.max[k] - g.finished.min[k]) * MIN_FILL;
    const grow = Math.max(0, want - (max[k] - min[k])) / 2;
    min[k] = Math.max(g.finished.min[k], min[k] - grow);
    max[k] = Math.min(g.finished.max[k], max[k] + grow);
  }
  return { group, box: { min, max }, anchor: g.finished, hold: '' };
}

/**
 * `hold`: the submodel close-up(s) this key belongs to ('' for none). The camera
 * holds still for a whole close-up: it is smoothed only with keys of the same
 * close-up, so it moves out after the last piece has landed, never while it flies.
 */
type FrameKey = { t: number; box: Box; anchor: Box; hold?: string; easeIn?: number; easeOut?: number };

/** Cinematic: only what is being assembled. Wide: the timeline's full-scene keys (floor included). */
function frameKeys(tl: Timeline, framing: CameraFraming, settings: CameraSettings): FrameKey[] {
  if (framing === 'wide') return tl.camKeys.map((k) => ({ t: k.t, box: k.box, anchor: tl.modelBox }));
  const plan = focusPlan(tl);
  if (!plan.groups.some((g) => g.lands.length)) return [];
  const keys: FrameKey[] = [];
  const main = plan.groups[0];
  // a key at each close-up's start and end, so the camera holds right up to them
  const times = new Set<number>();
  for (let t = 0; t <= tl.buildEnd + 1e-9; t += FOCUS_STEP) times.add(t);
  for (const sh of plan.shots) for (const t of [sh.from, sh.to]) if (t >= 0 && t <= tl.buildEnd) times.add(t);
  const sorted = [...times].sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-6);
  for (const t of sorted) {
    const f = focusAt(plan, t);
    let { box, anchor } = f;
    // below full submodel focus, keep the main model's built part in the shot too
    const keepMain = f.group > 0 ? 1 - clamp01(settings.submodelFocus) : 0;
    if (keepMain > 0) {
      const built = focusAt({ groups: [main], shots: [] }, t).box;
      const both = unionBoxes(box, built);
      box = mixBox(box, both, keepMain);
      anchor = mixBox(anchor, unionBoxes(anchor, main.finished), keepMain);
    }
    keys.push({ t, box, anchor, hold: f.hold, easeIn: f.easeIn, easeOut: f.easeOut });
  }
  return keys;
}

const mixBox = (a: Box, b: Box, u: number): Box => ({
  min: [0, 1, 2].map((k) => lerp(a.min[k], b.min[k], u)) as [number, number, number],
  max: [0, 1, 2].map((k) => lerp(a.max[k], b.max[k], u)) as [number, number, number],
});

/** Camera framing is fitted and smoothed ONCE for each timeline and aspect.
 * Recomputing the neighbouring-key average every video frame was expensive and
 * caused sudden camera jumps whenever a key entered or left the time window. */
const rigCache = new WeakMap<Timeline, Map<string, { keys: FrameKey[]; rigs: Rig[] }>>();

function frameRigs(tl: Timeline, aspect: number, framing: CameraFraming, settings: CameraSettings): { keys: FrameKey[]; rigs: Rig[] } {
  const cfg = CAMERA[framing];
  const fov = cameraFov(settings, aspect);
  const cacheKey = `${aspect}:${framing}:${Object.values(settings).join(':')}`;
  let byAspect = rigCache.get(tl);
  if (!byAspect) rigCache.set(tl, (byAspect = new Map()));
  const cached = byAspect.get(cacheKey);
  if (cached) return cached;
  const keys = frameKeys(tl, framing, settings);
  const raw = keys.map((key) => {
    let box = key.box;
    if (framing === 'wide') for (const other of keys) if (other !== key && Math.abs(other.t - key.t) <= KEY_REACH + 1e-9) box = unionBoxes(box, other.box);
    const u = clamp01(key.t / Math.max(tl.buildEnd, 1e-6));
    const az = settings.buildAzimuth + settings.buildDrift * u;
    const dynamic = worldBox3(box).getCenter(new THREE.Vector3());
    const anchor = worldBox3(key.anchor).getCenter(new THREE.Vector3());
    const target = dynamic.lerp(anchor, clamp01(settings.targetLock));
    return fitRig(box, aspect, az, settings.buildElevation, settings.buildMargin, fov, target);
  });
  // Damping sets the smoothing window. Distance takes the window's maximum first, so the
  // camera has already pulled back when a larger build (or a jump to another spot) arrives.
  const reach = 1 + Math.round(clamp01(settings.damping) * (SETTLE / FOCUS_STEP - 1));
  /** a close-up's keys and the keys outside close-ups are smoothed apart; buildRig eases between them */
  const near = (i: number, d: number) => {
    const k = Math.min(raw.length - 1, Math.max(0, i + d));
    return (keys[k].hold ?? '') !== (keys[i].hold ?? '') ? i : k;
  };
  const tri = (i: number, value: (k: number) => number) => {
    let sum = 0;
    let wsum = 0;
    for (let d = -reach; d <= reach; d++) {
      const k = near(i, d);
      const w = reach + 1 - Math.abs(d);
      sum += value(k) * w;
      wsum += w;
    }
    return sum / wsum;
  };
  const peak = raw.map((_, i) => {
    let m = 0;
    for (let d = -reach; d <= reach; d++) m = Math.max(m, raw[near(i, d)].dist);
    return m;
  });
  const rigs = raw.map((r, i) => ({
    target: new THREE.Vector3(tri(i, (k) => raw[k].target.x), tri(i, (k) => raw[k].target.y), tri(i, (k) => raw[k].target.z)),
    dist: Math.max(tri(i, (k) => peak[k]) * cfg.smooth, r.dist * 1.02),
    az: r.az,
    el: r.el,
  }));
  const out = { keys, rigs };
  byAspect.set(cacheKey, out);
  return out;
}

const cubic = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * (p2 - p0) / 2
    + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * (p3 - p1) / 2;
};

/** Catmull-Rom through `rigs` at the keys `idx` (sorted by time), at time t. */
function splineRig(keys: FrameKey[], rigs: Rig[], idx: number[], t: number): Rig {
  let lo = 0;
  let hi = idx.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[idx[mid]].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const j = Math.min(idx.length - 1, lo + 1);
  if (lo === j || keys[idx[j]].t <= keys[idx[lo]].t) return rigs[idx[lo]];
  const u = clamp01((t - keys[idx[lo]].t) / (keys[idx[j]].t - keys[idx[lo]].t));
  const a = rigs[idx[Math.max(0, lo - 1)]];
  const b = rigs[idx[lo]];
  const c = rigs[idx[j]];
  const d = rigs[idx[Math.min(idx.length - 1, j + 1)]];
  return {
    target: new THREE.Vector3(
      cubic(a.target.x, b.target.x, c.target.x, d.target.x, u),
      cubic(a.target.y, b.target.y, c.target.y, d.target.y, u),
      cubic(a.target.z, b.target.z, c.target.z, d.target.z, u),
    ),
    dist: Math.max(1, cubic(a.dist, b.dist, c.dist, d.dist, u)),
    az: b.az,
    el: b.el,
  };
}

/** a close-up: from its first key to its last, and its keys */
type Hold = { from: number; to: number; idx: number[]; easeIn: number; easeOut: number };
const holdCache = new WeakMap<FrameKey[], { free: number[]; holds: Hold[] }>();
function holdsOf(keys: FrameKey[]) {
  let out = holdCache.get(keys);
  if (out) return out;
  const free: number[] = [];
  const holds: Hold[] = [];
  keys.forEach((k, i) => {
    if (!k.hold) return void free.push(i);
    const last = holds[holds.length - 1];
    if (last && keys[last.idx[last.idx.length - 1]].hold === k.hold && last.idx[last.idx.length - 1] === i - 1) {
      last.idx.push(i);
      last.to = k.t;
      last.easeOut = k.easeOut ?? CLOSE_EASE;
    } else holds.push({ from: k.t, to: k.t, idx: [i], easeIn: k.easeIn ?? CLOSE_EASE, easeOut: k.easeOut ?? CLOSE_EASE });
  });
  holdCache.set(keys, (out = { free, holds }));
  return out;
}

function buildRig(tl: Timeline, t: number, aspect: number, framing: CameraFraming, settings: CameraSettings): Rig {
  const u0 = clamp01(t / Math.max(tl.buildEnd, 1e-6));
  const az = settings.buildAzimuth + settings.buildDrift * u0;
  const el = settings.buildElevation;
  const fov = cameraFov(settings, aspect);
  const { keys, rigs } = frameRigs(tl, aspect, framing, settings);
  if (!keys.length) return fitRig(tl.modelBox, aspect, az, el, settings.buildMargin, fov);
  const { free, holds } = holdsOf(keys);
  const base = free.length ? splineRig(keys, rigs, free, t) : fitRig(tl.modelBox, aspect, az, el, settings.buildMargin, fov);
  // A close-up holds still from its first key to its last (its last piece has landed by
  // then), and the camera eases in before it and out after it, never while it is held.
  let total = 0;
  const parts: { w: number; rig: Rig }[] = [];
  for (const h of holds) {
    const ramp = t < h.from ? 1 - (h.from - t) / h.easeIn : t > h.to ? 1 - (t - h.to) / h.easeOut : 1;
    if (ramp <= 0) continue;
    const w = easeInOutCubic(clamp01(ramp));
    const at = Math.min(h.to, Math.max(h.from, t));
    let k = 0;
    while (k + 1 < h.idx.length && keys[h.idx[k + 1]].t <= at) k++;
    const i = h.idx[k], j = h.idx[Math.min(h.idx.length - 1, k + 1)];
    const rig = j === i ? rigs[i] : mix(rigs[i], rigs[j], clamp01((at - keys[i].t) / (keys[j].t - keys[i].t)));
    parts.push({ w, rig });
    total += w;
  }
  if (!parts.length) return { ...base, az, el };
  // overlapping eases share the weight, so the camera never jumps between two close-ups
  const scale = Math.min(1, total) / total;
  const target = base.target.clone().multiplyScalar(1 - Math.min(1, total));
  let dist = base.dist * (1 - Math.min(1, total));
  for (const p of parts) {
    target.addScaledVector(p.rig.target, p.w * scale);
    dist += p.rig.dist * p.w * scale;
  }
  return { target, dist: Math.max(1, dist), az, el };
}

export function cameraAt(
  tl: Timeline,
  t: number,
  aspect: number,
  framing: CameraFraming = 'cinematic',
  camera: CameraSettings = DEFAULT_CAMERA_SETTINGS,
): CamPose {
  // Wide keeps the legacy spirit, while cinematic uses the photographic settings.
  const settings: CameraSettings = framing === 'wide'
    ? { ...camera, buildAzimuth: 30, buildElevation: 44, buildMargin: Math.max(camera.buildMargin, 1.22), targetLock: 0.45 }
    : camera;
  const fov = cameraFov(settings, aspect);
  let rig: Rig;
  if (t <= tl.buildEnd) rig = buildRig(tl, Math.min(t, tl.buildEnd), aspect, framing, settings);
  else if (tl.heroOrbit) {
    const u = clamp01((t - tl.buildEnd) / Math.max(1e-6, tl.duration - tl.buildEnd));
    const startAz = settings.buildAzimuth + settings.buildDrift;
    const az = startAz + settings.heroOrbitDegrees * u;
    const orbit = fitRig(tl.modelBox, aspect, az, settings.heroElevation, settings.heroMargin, fov);
    const from = buildRig(tl, tl.buildEnd, aspect, framing, settings);
    from.az = az;
    rig = mix(from, orbit, easeInOutCubic(clamp01((t - tl.buildEnd) / OUTRO_BLEND)));
  } else rig = buildRig(tl, tl.buildEnd, aspect, framing, settings);
  return { position: sphericalPosition(rig.target, rig.dist, rig.az, rig.el), target: rig.target, fov };
}

const spherical = (p: CamPose) => {
  const d = p.position.clone().sub(p.target);
  const r = d.length() || 1;
  return { r, az: Math.atan2(d.x, d.z), el: Math.asin(Math.min(1, Math.max(-1, d.y / r))) };
};
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The automatic intro (the wide establishing shot the Build view plays while it opens),
 * bent so that it lands exactly on `end` when the intro is over instead of on the
 * automatic build camera. At t = 0 it is the automatic intro unchanged, so the video
 * opens on the same frame the viewport does, and there is no jump into `end`.
 */
export function introInto(tl: Timeline, end: CamPose, aspect: number, framing: CameraFraming = 'cinematic', settings: CameraSettings = DEFAULT_CAMERA_SETTINGS): (t: number) => CamPose {
  const intro = Math.max(1e-6, tl.intro);
  const landing = cameraAt(tl, tl.intro, aspect, framing, settings);
  const a = spherical(landing), b = spherical(end);
  const dTarget = end.target.clone().sub(landing.target);
  const dR = b.r / a.r, dAz = wrapAngle(b.az - a.az), dEl = b.el - a.el, dFov = end.fov - landing.fov;
  return (t: number) => {
    if (t >= tl.intro) return { position: end.position.clone(), target: end.target.clone(), fov: end.fov };
    const k = easeInOutCubic(clamp01(t / intro));
    const at = cameraAt(tl, Math.max(0, t), aspect, framing, settings);
    const s = spherical(at);
    const target = at.target.clone().addScaledVector(dTarget, k);
    const r = s.r * Math.pow(dR, k);
    return { position: sphericalPosition(target, r, THREE.MathUtils.radToDeg(s.az + dAz * k), THREE.MathUtils.radToDeg(s.el + dEl * k)), target, fov: at.fov + dFov * k };
  };
}

/** The camera the viewport is showing: its pose and its lens. */
export type EditorCamera = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Width / height of the view this shot was framed in. When it differs from the
   * video's, the distance is re-fitted so the model fills the video as much as it
   * filled that view (a landscape viewport shot would otherwise be cropped or tiny in 9:16). */
  aspect?: number;
};

/**
 * The hero orbit around a fixed shot: before the outro (or with the orbit off) the shot
 * itself; during it, the shot swung around its own target by the hero angle at the same
 * distance, height and lens — so a saved scene camera keeps its framing while it orbits.
 */
export function heroAround(tl: Pick<Timeline, 'buildEnd' | 'duration' | 'heroOrbit'>, shot: CamPose, settings: Pick<CameraSettings, 'heroOrbitDegrees'> = DEFAULT_CAMERA_SETTINGS): (t: number) => CamPose {
  const offset = shot.position.clone().sub(shot.target);
  const degrees = (settings.heroOrbitDegrees ?? 120) * (Math.PI / 180);
  const ease = (u: number) => { const k = Math.min(1, Math.max(0, u)); return k * k * (3 - 2 * k); };
  const up = new THREE.Vector3(0, 1, 0);
  return (t: number) => {
    if (t < tl.buildEnd || !tl.heroOrbit) return { position: shot.position.clone(), target: shot.target.clone(), fov: shot.fov };
    const u = Math.min(1, Math.max(0, (t - tl.buildEnd) / Math.max(1e-6, tl.duration - tl.buildEnd)));
    const angle = degrees * u * ease((t - tl.buildEnd) / 0.6);
    return { position: shot.target.clone().add(offset.clone().applyAxisAngle(up, angle)), target: shot.target.clone(), fov: shot.fov };
  };
}

/**
 * The camera the Build tab plays, as a video sampler. It is *your* shot: the same direction,
 * distance and lens the viewport has, with the intro pushing in from slightly further out and
 * the outro orbiting around the model by the hero angle — no re-framing, no zoom change.
 */
export function buildViewCamera(
  tl: Timeline,
  editor: EditorCamera,
  aspect = 9 / 16,
  settings: CameraSettings = DEFAULT_CAMERA_SETTINGS,
  framing: CameraFraming = 'cinematic',
): (t: number) => CamPose {
  const target = new THREE.Vector3(...editor.target);
  const offset = new THREE.Vector3(...editor.position).sub(target);
  let radius = offset.length() || 1;
  const azimuth0 = Math.atan2(offset.x, offset.z);
  const elevation = Math.asin(Math.min(1, Math.max(-1, offset.y / radius)));
  if (editor.aspect && aspect > 0 && Math.abs(editor.aspect - aspect) > 1e-3) {
    // same zoom relative to the finished model, for the video's frame shape
    const box = worldBox3(tl.modelBox);
    const azDeg = THREE.MathUtils.radToDeg(azimuth0);
    const elDeg = THREE.MathUtils.radToDeg(elevation);
    const fitView = fitDistanceAtTarget(box, target, editor.fov, editor.aspect, azDeg, elDeg);
    const fitVideo = fitDistanceAtTarget(box, target, editor.fov, aspect, azDeg, elDeg);
    if (fitView > 0 && fitVideo > 0) radius *= fitVideo / fitView;
  }
  const ease = (u: number) => { const k = Math.min(1, Math.max(0, u)); return k * k * (3 - 2 * k); };
  const pose = (r: number, az: number): CamPose => {
    const cosEl = Math.cos(elevation);
    return {
      position: new THREE.Vector3(
        target.x + r * cosEl * Math.sin(az),
        target.y + r * Math.sin(elevation),
        target.z + r * cosEl * Math.cos(az),
      ),
      target: target.clone(),
      fov: editor.fov,
    };
  };
  const heroDegrees = (settings.heroOrbitDegrees ?? 120) * (Math.PI / 180);
  return (t: number) => {
    // the same establishing shot the Build view plays, landing on your own shot
    if (t < tl.intro) return introInto(tl, pose(radius, azimuth0), aspect, framing, settings)(t);
    if (t < tl.buildEnd || !tl.heroOrbit) return pose(radius, azimuth0);
    const u = Math.min(1, Math.max(0, (t - tl.buildEnd) / Math.max(1e-6, tl.duration - tl.buildEnd)));
    return pose(radius, azimuth0 + heroDegrees * u * ease((t - tl.buildEnd) / 0.6));
  };
}
