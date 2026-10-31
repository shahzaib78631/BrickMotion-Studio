/**
 * Samples a Camera track at a time: the single source of the camera for the viewport,
 * Preview and MP4. Targets are resolved live (a key aimed at "what is being built" moves
 * with the build), then the two keys around the time are blended in rig space.
 */
import * as THREE from 'three';
import { fitDistanceAtTarget, sphericalPosition } from '../camera';
import { autoClampedSlope } from '../keyframes';
import { curveAt, overshootAt } from './curves';
import { DEFAULT_TRANSITION } from './presets';
import type { CameraContext, CameraKey, CameraShot, CameraTrack, CameraTransition, TransitionSettings } from './types';

const MIN_EL = -85;
const MAX_EL = 89;
const MIN_DIST = 0.5;


/** Vertical field of view (degrees) for a lens, matching cameraFov's convention. */
export const fovForLens = (lensMm: number, sensorMm: number) =>
  THREE.MathUtils.radToDeg(2 * Math.atan(Math.max(1, sensorMm) / (2 * Math.max(1, lensMm))));

type Rig = { target: THREE.Vector3; dist: number; az: number; el: number; roll: number; lensMm: number; focus: number; blur: number };

function targetBox(key: CameraKey, t: number, ctx: CameraContext): THREE.Box3 {
  switch (key.target.kind) {
    case 'model': return ctx.modelBox;
    case 'build': return ctx.buildBox(t);
    case 'piece': return ctx.pieceBox(t) ?? ctx.buildBox(t);
    case 'point': return ctx.modelBox;
  }
}

/** A key's rig at time t: aim point, distance (auto-fit resolved) and angles, clamped. */
export function keyRig(key: CameraKey, t: number, ctx: CameraContext): Rig {
  const box = targetBox(key, t, ctx);
  const target = key.target.kind === 'point'
    ? new THREE.Vector3(...key.target.at)
    : box.getCenter(new THREE.Vector3());
  target.add(new THREE.Vector3(...key.offset));
  const el = Math.min(MAX_EL, Math.max(MIN_EL, key.elevation));
  const fov = fovForLens(key.lensMm, ctx.sensorMm);
  const dist = key.distance.fit
    ? fitDistanceAtTarget(box, target, fov, ctx.aspect, key.azimuth, el) * key.distance.margin
    : key.distance.value;
  return {
    target, dist: Math.max(MIN_DIST, dist), az: key.azimuth, el, roll: key.roll, lensMm: key.lensMm,
    focus: key.focus === 'target' ? 0.5 : key.focus, blur: key.blur,
  };
}

/** Signed azimuth change of a move, following its orbit direction. */
function azimuthDelta(a: number, b: number, s: TransitionSettings): number {
  const pos = (((b - a) % 360) + 360) % 360;
  // a chosen direction between two keys facing the same way circles all the way round
  if (s.orbit === 'cw') return (pos === 0 ? 360 : pos) + 360 * Math.max(0, Math.floor(s.extraTurns));
  if (s.orbit === 'ccw') return -(pos === 0 ? 360 : 360 - pos) - 360 * Math.max(0, Math.floor(s.extraTurns));
  return pos > 180 ? pos - 360 : pos;
}

const transitionFrom = (track: CameraTrack, id: string): CameraTransition | undefined =>
  track.transitions.find((tr) => tr.from === id);
const settingsFrom = (track: CameraTrack, id: string): TransitionSettings =>
  transitionFrom(track, id)?.settings ?? DEFAULT_TRANSITION;

/** A small seeded number for each key pair, so shake differs between moves but repeats exactly. */
function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

function shotFrom(rig: Rig, ctx: CameraContext, shutter: number): CameraShot {
  return {
    position: sphericalPosition(rig.target, rig.dist, rig.az, rig.el),
    target: rig.target,
    fov: fovForLens(rig.lensMm, ctx.sensorMm),
    roll: rig.roll, lensMm: rig.lensMm, focus: rig.focus, blur: rig.blur, shutter,
  };
}

/** Hermite value for flowing moves: slopes from the neighbouring keys, auto-clamped. */
function hermite(x: number[], y: number[], i: number, t: number, flowIn: boolean, flowOut: boolean): number {
  const p = (k: number) => (k >= 0 && k < x.length ? { x: x[k], y: y[k] } : null);
  const h = x[i + 1] - x[i];
  const u = (t - x[i]) / h;
  const m0 = (flowIn ? autoClampedSlope(p(i - 1), p(i)!, p(i + 1)) : 0) * h;
  const m1 = (flowOut ? autoClampedSlope(p(i), p(i + 1)!, p(i + 2)) : 0) * h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y[i] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y[i + 1] + (u3 - u2) * m1;
}

/** The camera at time t, or null when the track has no keys. */
export function cameraTrackAt(track: CameraTrack, t: number, ctx: CameraContext): CameraShot | null {
  const keys = track.keys;
  if (!keys.length) return null;
  if (t <= keys[0].t || keys.length === 1) return shotFrom(keyRig(keys[0], t, ctx), ctx, track.shutter);
  const last = keys.length - 1;
  if (t >= keys[last].t) return shotFrom(keyRig(keys[last], t, ctx), ctx, track.shutter);
  let i = 0;
  while (i + 1 < last && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const s = settingsFrom(track, a.id);
  if (s.cut) return shotFrom(keyRig(a, t, ctx), ctx, track.shutter);
  const u = (t - a.t) / (b.t - a.t);
  const ra = keyRig(a, t, ctx), rb = keyRig(b, t, ctx);
  rb.az = ra.az + azimuthDelta(ra.az, rb.az, s);

  let rig: Rig;
  const flows = s.flowThrough;
  if (flows) {
    // Flowing moves: every channel follows a smooth curve through the neighbouring keys.
    const prevFlows = i > 0 && settingsFrom(track, keys[i - 1].id).flowThrough;
    const nextFlows = i + 2 <= last && settingsFrom(track, b.id).flowThrough;
    const idx = [i - 1, i, i + 1, i + 2].filter((k) => k >= 0 && k <= last);
    const rigs = idx.map((k) => (k === i ? ra : k === i + 1 ? rb : keyRig(keys[k], t, ctx)));
    const at = (k: number) => idx.indexOf(k);
    if (at(i - 1) >= 0) rigs[at(i - 1)].az = ra.az - azimuthDelta(rigs[at(i - 1)].az, ra.az, settingsFrom(track, keys[i - 1].id));
    if (at(i + 2) >= 0) rigs[at(i + 2)].az = rb.az + azimuthDelta(rb.az, rigs[at(i + 2)].az, settingsFrom(track, b.id));
    const xs = idx.map((k) => keys[k].t);
    const j = at(i);
    const ch = (f: (r: Rig) => number) => hermite(xs, rigs.map(f), j, t, prevFlows, nextFlows);
    rig = {
      target: new THREE.Vector3(ch((r) => r.target.x), ch((r) => r.target.y), ch((r) => r.target.z)),
      dist: Math.exp(ch((r) => Math.log(r.dist))), az: ch((r) => r.az), el: ch((r) => r.el),
      roll: ch((r) => r.roll), lensMm: ch((r) => r.lensMm), focus: ch((r) => r.focus), blur: ch((r) => r.blur),
    };
  } else {
    const up = curveAt(s.curve, u) + overshootAt(u, s.overshoot);
    const ua = curveAt(s.aimCurve ?? s.curve, u);
    const ul = curveAt(s.lensCurve ?? s.curve, u);
    // turning late: the angle holds, then swings round in the last seconds of the gap
    const late = s.turnLast && s.turnLast > 0 && s.turnLast < b.t - a.t ? s.turnLast : 0;
    const uTurn = late ? Math.min(1, Math.max(0, (t - (b.t - late)) / late)) : u;
    const upTurn = late ? curveAt(s.curve, uTurn) + overshootAt(uTurn, s.overshoot) : up;
    const upRest = late ? curveAt(s.curve, u) : up;
    rig = {
      target: ra.target.clone().lerp(rb.target, ua),
      dist: Math.exp(lerp(Math.log(ra.dist), Math.log(rb.dist), upRest)),
      az: lerp(ra.az, rb.az, upTurn), el: lerp(ra.el, rb.el, upRest), roll: lerp(ra.roll, rb.roll, upTurn),
      lensMm: lerp(ra.lensMm, rb.lensMm, ul), focus: lerp(ra.focus, rb.focus, ul), blur: lerp(ra.blur, rb.blur, ul),
    };
  }
  if (s.shake.amount > 0) {
    // handheld: two layered slow waves, faded in and out so the keys stay exact
    const ph = seed(`${a.id}>${b.id}`) * Math.PI * 2;
    const w = 2 * Math.PI * Math.max(0.05, s.shake.frequency) * t;
    const env = Math.min(1, u * 5, (1 - u) * 5);
    rig.az += s.shake.amount * env * (0.6 * Math.sin(w + ph) + 0.4 * Math.sin(w * 2.13 + ph * 1.7));
    rig.el += s.shake.amount * env * 0.6 * (0.6 * Math.sin(w * 1.31 + ph * 0.6) + 0.4 * Math.sin(w * 2.71 + ph * 2.3));
  }
  rig.el = Math.min(MAX_EL, Math.max(MIN_EL, rig.el));
  rig.dist = Math.max(MIN_DIST, rig.dist);
  const shot = shotFrom(rig, ctx, s.motionBlur);
  if (s.path === 'straight' && !flows) {
    // the camera slides along a line between the two key positions (truck / pedestal / dolly)
    const up = curveAt(s.curve, u) + overshootAt(u, s.overshoot);
    const pa = sphericalPosition(ra.target, ra.dist, ra.az, ra.el);
    const pb = sphericalPosition(rb.target, rb.dist, rb.az, rb.el);
    shot.position = pa.lerp(pb, up);
  }
  return shot;
}
