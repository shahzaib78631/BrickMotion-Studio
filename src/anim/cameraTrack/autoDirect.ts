/**
 * Auto-direct: writes a Camera track from the build, in the styles of BrickHeadz speed-build
 * videos (see the five references in docs/superpowers/specs/2026-10-31-camera-director-design.md):
 *
 * - Speed build: starts high over the base and lowers as the model grows, swoops to the side
 *   being built, pulls back before a tall part, then hard-cuts to a low front view for the
 *   last details (the Megatron video).
 * - Showcase orbit: lowers to the front, circles slowly round the back while the rest goes
 *   on, then cuts to a low front view (the Doctor Doom video).
 * - Turntable: a still frame on the whole finished model that the build grows into, turning
 *   about 225° round it (slowly at first, faster near the end), then a whip round to the
 *   front and a still hold (the three KenBrick videos). Long builds add whole turns.
 * - Calm, Energetic, Overhead: variations with an arc reveal onto the front.
 *
 * Everything it makes is ordinary keys and moves (origin 'auto') that can be edited.
 */
import * as THREE from 'three';
import { worldBox3 } from '../camera';
import type { Timeline } from '../timeline';
import { relink } from './ops';
import { presetById } from './presets';
import type { CameraKey, CameraTrack, CameraTransition, DirectorStyle, TransitionSettings } from './types';

export type DirectorOptions = {
  style: DirectorStyle;
  /** 0 calm … 1 busy: how often the camera swings */
  swings: number;
  lensMm: number;
  shutter: number;
  /** azimuth of the model's front in degrees; automatic when left out */
  front?: number;
};

type Finish = 'arc' | 'cut' | 'whip';
type StyleRules = {
  elStart: number; elEnd: number;
  /** side swings: seconds between them at swings 0 and at swings 1; 0 = none */
  swingEvery: [number, number];
  big: string; small: string; lens?: number; shutter?: number;
  /** how the build ends on the front */
  finish: Finish;
  /** the camera height after a cut to the front */
  finishEl?: number;
  /** the share of the build after which the finish cut comes */
  cutAt?: number;
  /** Turntable: seconds per full turn while building; Showcase: degrees circled before the cut */
  turnSeconds?: number; orbitDegrees?: number;
  /** how tight the building view is (auto-fit margin) */
  margin: number;
};
const STYLES: Record<DirectorStyle, StyleRules> = {
  reference: { elStart: 60, elEnd: 15, swingEvery: [6, 2.2], big: 'swoop', small: 'swoop', finish: 'cut', finishEl: 10, cutAt: 0.8, margin: 1.15 },
  showcase: { elStart: 52, elEnd: 18, swingEvery: [0, 0], big: 'glide', small: 'glide', finish: 'cut', finishEl: 8, cutAt: 0.82, orbitDegrees: 200, margin: 1.15 },
  turntable: { elStart: 38, elEnd: 16, swingEvery: [0, 0], big: 'swoop', small: 'swoop', finish: 'whip', turnSeconds: 12, margin: 1.1 },
  calm: { elStart: 50, elEnd: 22, swingEvery: [0, 0], big: 'glide', small: 'glide', lens: 85, finish: 'arc', margin: 1.15 },
  energetic: { elStart: 62, elEnd: 12, swingEvery: [3, 1.5], big: 'whip-pan', small: 'swoop', shutter: 0.7, finish: 'arc', margin: 1.15 },
  overhead: { elStart: 78, elEnd: 70, swingEvery: [0, 0], big: 'glide', small: 'glide', finish: 'arc', margin: 1.15 },
};

/** quick move lengths, seconds */
const MOVE = { swoop: 0.5, 'whip-pan': 0.35, orbit: 1.1, glide: 1.1 } as Record<string, number>;
/** a tall part: raises the built height by this share of the finished height */
const TALL = 0.25;
/** pull back this long before the tall part lands */
const PULL_LEAD = 0.6;
/** keys closer than this merge, so the timeline never shows two diamonds on top of each other */
const MIN_GAP = 0.6;
/** at most this many side swings in one build, however long: long builds space them out */
const MAX_SWINGS = 10;
/** Turntable: at most this many whole turns on top of the KenBrick turn, which is TURN_BASE */
const MAX_TURNS = 5;
const TURN_BASE = 225;
const TURN_STEP = 120;
/** when two planned keys fall together, the more telling move wins */
const PRIORITY: Record<string, number> = { cut: 5, 'whip-pan': 4, swoop: 4, 'arc-reveal': 3, 'pull-back': 2, 'push-in': 1, hold: 1, glide: 0 };

const deg = THREE.MathUtils.radToDeg;
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

type Landing = { t: number; start: number; box: THREE.Box3 };
const landingsOf = (tl: Timeline): Landing[] =>
  tl.units.filter((u) => !u.hidden && (u.land ?? u.box))
    .map((u) => ({ t: u.start + u.dur, start: u.start, box: worldBox3((u.land ?? u.box)!) }))
    .sort((a, b) => a.t - b.t);

/**
 * The model's front. LDraw models are built facing the LDraw front view (LDU −Z, world +Z,
 * azimuth 0), BrickHeadz included. Guessing it from where pieces land picked a caped
 * figure's back, so the convention wins.
 */
export function frontAzimuth(_tl: Timeline): number {
  return 0;
}

type Plan = {
  t: number; az: number; el: number; margin: number; target: CameraKey['target']; preset: string;
  /** settings changes on top of the preset (orbit direction, flowing through) */
  tweak?: Partial<TransitionSettings>;
  /** the move into this key is a quick swing at the end of the gap (the view holds before it) */
  arrive?: { preset: string; len: number };
};

/** Writes a camera track for the build. */
export function autoDirect(tl: Timeline, opts: DirectorOptions): CameraTrack {
  const rules = STYLES[opts.style];
  const lensMm = rules.lens ?? opts.lensMm;
  const shutter = rules.shutter ?? opts.shutter;
  const model = worldBox3(tl.modelBox);
  const ground = model.min.y;
  const height = Math.max(1e-6, model.max.y - ground);
  const centre = model.getCenter(new THREE.Vector3());
  const lands = landingsOf(tl);
  const front = wrap(opts.front ?? frontAzimuth(tl));
  const start = Math.max(0, Math.min(tl.intro, tl.buildEnd));
  const end = tl.buildEnd;
  const busy = Math.min(1, Math.max(0, opts.swings));

  /** built height share at time t (pieces landed by then) */
  const builtAt = (t: number) => {
    let top = ground;
    for (const l of lands) if (l.t <= t + 1e-9) top = Math.max(top, l.box.max.y);
    return Math.min(1, (top - ground) / height);
  };
  /** the camera lowers with the height that will be built shortly after t (never rises) */
  const elAt = (t: number) => {
    let lowest = rules.elStart;
    for (let x = 0; x <= t + 1e-9; x += Math.max(0.05, t / 200)) lowest = Math.min(lowest, lerp(rules.elStart, rules.elEnd, builtAt(x + 1)));
    return Math.min(lowest, lerp(rules.elStart, rules.elEnd, builtAt(t + 1)));
  };

  // the finish cut comes for the last details: a share of the build, at most the last 8 s
  const cutAt = rules.finish === 'cut' ? Math.max(start + (rules.cutAt ?? 0.8) * (end - start), end - 8) : Infinity;
  const plans: Plan[] = [];
  const tail: Plan[] = [];
  const build = (t: number, az: number, preset: string, margin = rules.margin, tweak?: Partial<TransitionSettings>): Plan =>
    ({ t, az, el: elAt(t), margin, target: { kind: 'build' }, preset, tweak });

  if (rules.turnSeconds) {
    // Turntable: fixed on the finished model, turning clockwise from the front three-quarter
    // view to behind the far side; a whole turn more for every turnSeconds past a short build
    const orbitEnd = Math.max(start + 0.5, end - MIN_GAP - 0.05);
    const az0 = wrap(front - 35);
    const len = orbitEnd - start;
    const extra = Math.min(MAX_TURNS, Math.max(0, Math.round((len - 9) / rules.turnSeconds)));
    const total = TURN_BASE + 360 * extra;
    // a short build speeds up as it goes (as the videos do); a long one turns evenly
    const ease = extra === 0 ? 1.8 : 1;
    const steps = Math.max(4, Math.ceil(total / TURN_STEP));
    const flow = { orbit: 'cw' as const, flowThrough: true };
    const still = (t: number, az: number, preset: string, tweak?: Partial<TransitionSettings>): Plan =>
      ({ t, az, el: elAt(t), margin: rules.margin, target: { kind: 'model' }, preset, tweak });
    plans.push(still(0, az0, 'orbit', flow));
    if (start > 0.3) plans.push(still(start, az0, 'orbit', flow));
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      plans.push(still(lerp(start, orbitEnd, u), az0 + total * u ** ease, i === steps ? 'swoop' : 'orbit', i === steps ? undefined : flow));
    }
    // the whip onto the front, then a still hold
    tail.push({ t: Math.min(tl.duration, end + 0.05), az: front, el: rules.elEnd, margin: rules.margin, target: { kind: 'model' }, preset: 'hold' });
    if (tl.duration > end + 0.6) tail.push({ t: tl.duration, az: front, el: rules.elEnd, margin: rules.margin - 0.04, target: { kind: 'model' }, preset: 'glide' });
  } else {
    let az = wrap(front + 35);
    plans.push(build(0, az, 'glide', 1.15));

    // Showcase: lower onto the front by the middle of the build, then circle round the back
    if (rules.orbitDegrees) {
      const mid = start + 0.45 * (end - start);
      az = wrap(front + 20);
      plans.push(build(mid, az, 'orbit', rules.margin, { orbit: 'cw', flowThrough: true }));
      const orbitEnd = Math.min(cutAt, end) - MIN_GAP - 0.05;
      const steps = Math.max(2, Math.ceil(rules.orbitDegrees / 90));
      for (let i = 1; i <= steps; i++) {
        const t = lerp(mid, orbitEnd, i / steps);
        plans.push(build(t, az + (rules.orbitDegrees * i) / steps, 'orbit', rules.margin, { orbit: 'cw', flowThrough: i < steps }));
      }
    }

    // side swings: each window of the build looks from the side most pieces land on
    const every = lerp(rules.swingEvery[0], rules.swingEvery[1], busy);
    const swingEnd = Math.min(end, cutAt - 0.3);
    if (every > 0 && swingEnd > start) {
      const win = Math.max(1.5, every, (swingEnd - start) / MAX_SWINGS);
      for (let w0 = start; w0 < swingEnd - 1e-6; w0 += win) {
        const w1 = Math.min(swingEnd, w0 + win);
        const pull = new THREE.Vector2();
        let size = 0;
        for (const l of lands) {
          if (l.t < w0 || l.t >= w1) continue;
          const p = l.box.getCenter(new THREE.Vector3()).sub(centre);
          const v = Math.cbrt(Math.max(1e-6, l.box.getSize(new THREE.Vector3()).toArray().reduce((a, b) => a * b, 1)));
          pull.x += p.x * v; pull.y += p.z * v; size += v;
        }
        let want: number;
        const reach = Math.max(model.max.x - model.min.x, model.max.z - model.min.z) / 2;
        if (size && pull.length() / size >= 0.2 * reach) want = wrap(deg(Math.atan2(pull.x, pull.y)));
        // pieces all over (or none): swap to the other three-quarter view of the front
        else want = wrap(front + (wrap(az - front) >= 0 ? -35 : 35));
        // keep a three-quarter view of that side rather than flat on
        let target = wrap(want + 30 * Math.sign(wrap(az - want) || 1));
        // already on that side: cross to its other three-quarter view, so the shot keeps moving
        if (Math.abs(wrap(target - az)) < 30) target = wrap(want - 30 * Math.sign(wrap(az - want) || 1));
        const delta = Math.abs(wrap(target - az));
        if (delta < 30) continue;
        const preset = delta > 60 ? rules.big : rules.small;
        const len = MOVE[preset] ?? 1;
        const t = Math.max(w0, len);
        if (t >= swingEnd) break;
        // one key: the move into it holds the old view, then swings round in its last moment
        az = target;
        plans.push({ ...build(t, az, 'glide', 1.15), arrive: { preset, len } });
      }
    }

    // pull back and lower before a tall part arrives
    let before = 0;
    for (const l of lands) {
      const after = Math.min(1, (Math.max(ground, l.box.max.y) - ground) / height);
      if (after - before > TALL && l.t - PULL_LEAD < cutAt - 0.3) {
        const t = Math.max(0, l.t - PULL_LEAD);
        const t0 = Math.max(0, t - 1);
        plans.push(build(t0, azAt(plans, t0), 'pull-back', 1.15));
        plans.push(build(t, azAt(plans, t), 'glide', 1.45));
      }
      before = Math.max(before, after);
    }

    if (rules.finish === 'cut') {
      // hard cut to a low front view for the last details, then a slow push in; the key
      // before the cut gets the cut (its view holds, following the build, until the cut)
      tail.push({ t: cutAt, az: front, el: rules.finishEl ?? rules.elEnd, margin: 1.2, target: { kind: 'model' }, preset: 'push-in' });
      tail.push({ t: tl.duration, az: front, el: rules.finishEl ?? rules.elEnd, margin: 1.05, target: { kind: 'model' }, preset: 'glide' });
    } else {
      // the reveal: swing to the front, then a slow push in to the end
      const revealAt = Math.min(tl.duration, end + 0.2);
      plans.push(build(Math.max(0, end - 0.9), azAt(plans, end - 0.9), 'arc-reveal', 1.15));
      tail.push({ t: revealAt, az: front, el: rules.elEnd, margin: 1.12, target: { kind: 'model' }, preset: 'push-in' });
      if (tl.duration > revealAt + 0.5) tail.push({ t: tl.duration, az: front, el: rules.elEnd, margin: 1.02, target: { kind: 'model' }, preset: 'glide' });
    }
  }

  // in time order, without near-duplicate times; the camera never rises again
  plans.sort((a, b) => a.t - b.t);
  const lastBody = tail.length ? tail[0].t - MIN_GAP : Infinity;
  const kept: Plan[] = [];
  for (const p of plans) {
    if (p.t > lastBody) continue;
    const prev = kept[kept.length - 1];
    if (prev && p.t - prev.t < MIN_GAP) {
      const win = (PRIORITY[p.preset] ?? 0) >= (PRIORITY[prev.preset] ?? 0) ? p : prev;
      kept[kept.length - 1] = { ...p, t: prev.t, preset: win.preset, tweak: win.tweak, arrive: prev.arrive ?? p.arrive };
      continue;
    }
    kept.push({ ...p });
  }
  // the key before a cut finish: its move is the cut
  if (rules.finish === 'cut' && kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], preset: 'cut', tweak: undefined };
  kept.push(...tail.filter((p) => p.t > (kept[kept.length - 1]?.t ?? -1) + 1e-6));
  for (let i = 1; i < kept.length; i++) if (kept[i].target.kind === 'build') kept[i].el = Math.min(kept[i].el, kept[i - 1].el);

  const keys: CameraKey[] = kept.map((p, i) => ({
    id: `auto-${i}`, t: p.t, target: p.target, offset: [0, 0, 0], azimuth: p.az, elevation: p.el,
    distance: { fit: true, margin: p.margin }, roll: 0, lensMm, focus: 'target', blur: 0, origin: 'auto',
  }));
  const transitions: CameraTransition[] = keys.slice(0, -1).map((k, i) => {
    // a quick swing into the next key (unless this key cuts away) turns late in the gap
    const arrive = kept[i].preset !== 'cut' ? kept[i + 1].arrive : undefined;
    const preset = presetById(arrive?.preset ?? kept[i].preset, []);
    const gap = keys[i + 1].t - k.t;
    const late = arrive && gap > arrive.len + 1e-6 ? { turnLast: arrive.len } : undefined;
    const settings = { ...structuredClone(preset.settings), ...(arrive ? undefined : kept[i].tweak), ...late };
    return { from: k.id, to: keys[i + 1].id, preset: preset.id, settings, origin: 'auto' };
  });
  return { keys, transitions, shutter, style: opts.style };
}

/** The azimuth already planned for time t (the latest plan at or before it). */
function azAt(plans: { t: number; az: number }[], t: number): number {
  let best = plans[0];
  for (const p of plans) if (p.t <= t + 1e-9 && p.t >= best.t) best = p;
  return best.az;
}

/**
 * Puts a fresh Auto-direct result together with what the user changed: their keys (moved
 * inside the video if it got shorter) and the moves they edited stay; automatic keys close
 * to one of theirs make way.
 */
export function mergeAuto(existing: CameraTrack | undefined, auto: CameraTrack, duration: number): CameraTrack {
  const mine = (existing?.keys ?? []).filter((k) => k.origin === 'user').map((k) => ({ ...k, t: Math.min(Math.max(0, k.t), duration) }));
  // an automatic key you edited keeps its auto-N id: new automatic keys never reuse it
  const taken = new Set(mine.map((k) => k.id));
  const rename = new Map<string, string>();
  for (const k of auto.keys) {
    let id = k.id;
    for (let n = 2; taken.has(id); n++) id = `${k.id}-${n}`;
    taken.add(id);
    rename.set(k.id, id);
  }
  const fresh = (id: string) => rename.get(id) ?? id;
  const autoKeys = auto.keys.filter((k) => !mine.some((m) => Math.abs(m.t - k.t) < 0.4)).map((k) => ({ ...k, id: fresh(k.id) }));
  const autoMoves = auto.transitions.map((tr) => ({ ...tr, from: fresh(tr.from), to: fresh(tr.to) }));
  const keys = [...mine, ...autoKeys].sort((a, b) => a.t - b.t);
  const myMoves = (existing?.transitions ?? []).filter((tr) => tr.origin === 'user');
  return { ...auto, shutter: existing?.shutter ?? auto.shutter, keys, transitions: relink(keys, [...myMoves, ...autoMoves]) };
}
