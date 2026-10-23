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

function fitDistanceAtTarget(box: THREE.Box3, target: THREE.Vector3, fovDeg: number, aspect: number, azimuthDeg: number, elevationDeg: number): number {
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

/** One thing being assembled: the main model (index 0) or a submodel at its side spot. */
type Focus = { finished: Box; lands: { start: number; land: Box }[] };
/** `shots`: when the camera holds on each submodel; the main model has the rest of the time */
type FocusPlan = { groups: Focus[]; shots: { from: number; to: number; group: number; size: number }[] };
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
    shots.push({ from: enter, to: exit, group: g, size: volume(groups[g].finished) });
  }
  const plan = { groups, shots };
  focusCache.set(tl, plan);
  return plan;
}

/** The (sub)model being assembled around time t and the part of it the camera must show. */
function focusAt(plan: FocusPlan, t: number): { group: number; box: Box; anchor: Box } {
  const { groups, shots } = plan;
  // every submodel held at t; a nested one is built while its parent still gets pieces, so show both
  let group = 0;
  let size = Infinity;
  let held: Box | null = null;
  for (const sh of shots)
    if (t >= sh.from && t <= sh.to) {
      held = held ? unionBoxes(held, groups[sh.group].finished) : groups[sh.group].finished;
      if (sh.size < size) ((group = sh.group), (size = sh.size));
    }
  // a submodel is small: hold one steady framing of the whole thing while it is built
  if (held) return { group, box: held, anchor: held };
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
  return { group, box: { min, max }, anchor: g.finished };
}

type FrameKey = { t: number; box: Box; anchor: Box };

/** Cinematic: only what is being assembled. Wide: the timeline's full-scene keys (floor included). */
function frameKeys(tl: Timeline, framing: CameraFraming, settings: CameraSettings): FrameKey[] {
  if (framing === 'wide') return tl.camKeys.map((k) => ({ t: k.t, box: k.box, anchor: tl.modelBox }));
  const plan = focusPlan(tl);
  if (!plan.groups.some((g) => g.lands.length)) return [];
  const keys: FrameKey[] = [];
  const main = plan.groups[0];
  for (let t = 0; t <= tl.buildEnd + 1e-9; t += FOCUS_STEP) {
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
    keys.push({ t, box, anchor });
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
  const tri = (i: number, value: (k: number) => number) => {
    let sum = 0;
    let wsum = 0;
    for (let d = -reach; d <= reach; d++) {
      const k = Math.min(raw.length - 1, Math.max(0, i + d));
      const w = reach + 1 - Math.abs(d);
      sum += value(k) * w;
      wsum += w;
    }
    return sum / wsum;
  };
  const peak = raw.map((_, i) => {
    let m = 0;
    for (let d = -reach; d <= reach; d++) m = Math.max(m, raw[Math.min(raw.length - 1, Math.max(0, i + d))].dist);
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

function buildRig(tl: Timeline, t: number, aspect: number, framing: CameraFraming, settings: CameraSettings): Rig {
  const u0 = clamp01(t / Math.max(tl.buildEnd, 1e-6));
  const az = settings.buildAzimuth + settings.buildDrift * u0;
  const fov = cameraFov(settings, aspect);
  const { keys, rigs } = frameRigs(tl, aspect, framing, settings);
  if (!keys.length) return fitRig(tl.modelBox, aspect, az, settings.buildElevation, settings.buildMargin, fov);
  // keys may be unevenly spaced (the construction planner's keys are), so search for t
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const j = Math.min(keys.length - 1, i + 1);
  if (i === j || keys[j].t <= keys[i].t) return { ...rigs[i], az, el: settings.buildElevation };
  const u = clamp01((t - keys[i].t) / (keys[j].t - keys[i].t));
  const a = rigs[Math.max(0, i - 1)];
  const b = rigs[i];
  const c = rigs[j];
  const d = rigs[Math.min(rigs.length - 1, j + 1)];
  return {
    target: new THREE.Vector3(
      cubic(a.target.x, b.target.x, c.target.x, d.target.x, u),
      cubic(a.target.y, b.target.y, c.target.y, d.target.y, u),
      cubic(a.target.z, b.target.z, c.target.z, d.target.z, u),
    ),
    dist: Math.max(1, cubic(a.dist, b.dist, c.dist, d.dist, u)),
    az,
    el: settings.buildElevation,
  };
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
