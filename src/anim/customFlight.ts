import * as THREE from 'three';
import type { Instance } from '../model/assemble';
import type { FlightPose, KeyframeAnimation } from '../plan/types';
import { factorAffine } from './affineTransform';
import { buildLayerAt } from './buildLayer';
import { valuesAt } from './keyframes';
import { FROM_VIEW, displayPivot, keyframeDelta } from './keyframePose';
import { locationFrames } from './flightPath';
import type { Move, Timeline } from './timeline';

/**
 * A flight path edited in the viewport, handed back to the Build timeline: the piece flies
 * along the same route, but with the Build's own timing and easing instead of the keys'.
 *
 * Poses are stored relative to the seat, in the seat's own frame (`seatFrame`), so they do
 * not change when the whole model turns to another spot. They are evenly spaced along the
 * way (distance moved plus turning), because a pose path plays each step in equal time.
 */

/** LDU of travel one radian of turning counts as, when spacing poses along the way */
const TURN_LDU = 20;
/** one pose about every this many LDU of travel, within these limits */
const SPACING = 5;
const MIN_POSES = 8;
const MAX_POSES = 160;
const MAX_SAMPLES = 4000;

const ONE = new THREE.Vector3(1, 1, 1);
const _s = new THREE.Vector3();

/** The rigid part of a seat matrix (its position and rotation, without scale or shear). */
export function seatFrame(to: THREE.Matrix4): THREE.Matrix4 {
  const f = factorAffine(to.elements);
  if (!f) return new THREE.Matrix4().copyPosition(to);
  return new THREE.Matrix4().fromArray(f.rotation).setPosition(f.position[0], f.position[1], f.position[2]);
}

type Sample = { p: THREE.Vector3; q: THREE.Quaternion; at: number };

/**
 * The flight a baked piece's keys describe, as poses for `assembly.flight`: its first move
 * (from where it waits to its seat), from the first visible location key to the last one
 * (or the end of that move, when the piece moves again later, as in a submodel). Null when
 * the keys do not move it.
 */
export function flightFromKeys(
  animation: KeyframeAnimation,
  model: string,
  inst: Instance,
  base: THREE.Matrix4,
  timeline: Timeline,
): FlightPose[] | null {
  const track = timeline.tracks.get(inst.key);
  const move = track?.moves[0];
  // the Build layer only bounds a piece that moves again later; a detached model has none
  const layer = buildLayerAt(animation, model);
  if (!track || !move || move.stationary) return null;
  const visible = (f: number) => valuesAt(animation, model, inst.key, f).visibility >= 0.5;
  const frames = locationFrames(animation, model, inst.key).filter(visible);
  if (frames.length < 2) return null;
  const lo = frames[0];
  let hi = frames[frames.length - 1];
  if (track.moves.length > 1 && layer) {
    const u = timeline.units[move.unit];
    if (u) hi = Math.min(hi, layer.startFrame + ((u.start + u.dur) / layer.speed) * animation.fps);
  }
  if (hi <= lo) return null;
  // the keys give the piece's world pose; the move flies `from` -> `to`, then applies `rel`
  const seat = move.rel ? move.to.clone().multiply(move.rel) : move.to;
  const seatInv = seat.clone().invert();
  const pivot = displayPivot(inst, base);
  const centre = pivot.clone().applyMatrix4(FROM_VIEW);
  const step = Math.max(0.25, (hi - lo) / MAX_SAMPLES);
  const samples: Sample[] = [];
  const point = new THREE.Vector3(), last = new THREE.Vector3();
  for (let f = lo; ; f = Math.min(hi, f + step)) {
    const v = valuesAt(animation, model, inst.key, f);
    // the world move from the seat to this pose
    const delta = keyframeDelta(v, pivot).multiply(base).multiply(seatInv);
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    delta.decompose(p, q, _s);
    const prev = samples[samples.length - 1];
    if (prev && prev.q.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    point.copy(centre).applyMatrix4(delta);
    const at = prev ? prev.at + point.distanceTo(last) + TURN_LDU * prev.q.angleTo(q) : 0;
    samples.push({ p, q, at });
    last.copy(point);
    if (f >= hi) break;
  }
  const total = samples[samples.length - 1].at;
  if (total < 1) return null;
  const count = Math.max(MIN_POSES, Math.min(MAX_POSES, Math.round(total / SPACING) + 1));
  const T = seatFrame(move.to), Tinv = T.clone().invert();
  const round = (n: number, k: number) => { const r = Math.round(n * k) / k; return Object.is(r, -0) ? 0 : r; };
  const poses: FlightPose[] = [];
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  let j = 0;
  for (let k = 0; k < count; k++) {
    const at = (total * k) / (count - 1);
    while (j < samples.length - 2 && samples[j + 1].at < at) j++;
    const a = samples[j], b = samples[j + 1] ?? a;
    const t = b.at > a.at ? Math.min(1, Math.max(0, (at - a.at) / (b.at - a.at))) : 0;
    p.copy(a.p).lerp(b.p, t);
    q.copy(a.q).slerp(b.q, t);
    // the same move seen from the seat: T⁻¹ · D · T
    const local = Tinv.clone().multiply(new THREE.Matrix4().compose(p, q, ONE)).multiply(T);
    const lp = new THREE.Vector3(), lq = new THREE.Quaternion();
    local.decompose(lp, lq, _s);
    lq.normalize();
    poses.push([round(lp.x, 1e3), round(lp.y, 1e3), round(lp.z, 1e3), round(lq.x, 1e6), round(lq.y, 1e6), round(lq.z, 1e6), round(lq.w, 1e6)]);
  }
  // it ends exactly on its seat
  poses[poses.length - 1] = [0, 0, 0, 0, 0, 0, 1];
  return poses;
}

const rigid = (pose: readonly number[]) => {
  const q = new THREE.Quaternion(pose[3], pose[4], pose[5], pose[6]);
  if (q.lengthSq() < 1e-12) q.identity(); else q.normalize();
  return new THREE.Matrix4().compose(new THREE.Vector3(pose[0], pose[1], pose[2]), q, ONE);
};

/** A track's first move flown along `flight` instead of the planner's route. */
export function flightMove(move: Move, flight: readonly FlightPose[]): Move {
  if (move.stationary || flight.length < 2) return move;
  const T = seatFrame(move.to), Tinv = T.clone().invert();
  const posePath = flight.map((pose) => T.clone().multiply(rigid(pose)).multiply(Tinv).multiply(move.to));
  // It starts where the piece waits now. When the piece was dragged or turned on the floor
  // after its path was edited, that difference fades out over the first part of the way.
  const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), pf = new THREE.Vector3(), qf = new THREE.Quaternion();
  posePath[0].decompose(p0, q0, _s);
  move.from.decompose(pf, qf, _s);
  const shift = pf.clone().sub(p0);
  const turn = qf.clone().multiply(q0.clone().invert());
  const none = new THREE.Quaternion();
  if (shift.length() > 1e-3 || turn.angleTo(none) > 1e-5) {
    const pos = posePath.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
    const at = [0];
    for (let k = 1; k < pos.length; k++) at.push(at[k - 1] + pos[k].distanceTo(pos[k - 1]));
    const fade = Math.max(1e-6, at[at.length - 1] * 0.7);
    for (let k = 1; k < posePath.length - 1; k++) {
      const w = Math.max(0, 1 - at[k] / fade);
      if (w <= 0) break;
      // turned about the piece's own position, then shifted
      posePath[k] = new THREE.Matrix4().makeTranslation(pos[k].x + shift.x * w, pos[k].y + shift.y * w, pos[k].z + shift.z * w)
        .multiply(new THREE.Matrix4().makeRotationFromQuaternion(none.clone().slerp(turn, w)))
        .multiply(new THREE.Matrix4().makeTranslation(-pos[k].x, -pos[k].y, -pos[k].z))
        .multiply(posePath[k]);
    }
  }
  posePath[0] = move.from.clone();
  posePath[posePath.length - 1] = move.to.clone();
  return {
    ...move, posePath,
    translationPath: undefined, kinematicSegments: undefined,
    rigidDeltas: undefined, rigidBase: undefined, rigidPivot: undefined,
  };
}

/** Lays edited flight paths (by piece key) over a planned timeline. The original is not changed. */
export function applyCustomFlights(tl: Timeline, flights: ReadonlyMap<string, readonly FlightPose[]>): Timeline {
  let tracks: Timeline['tracks'] | null = null;
  for (const [key, flight] of flights) {
    const tr = tl.tracks.get(key);
    if (!tr?.moves.length || tr.moves[0].stationary) continue;
    tracks ??= new Map(tl.tracks);
    tracks.set(key, { ...tr, moves: [flightMove(tr.moves[0], flight), ...tr.moves.slice(1)] });
  }
  return tracks ? { ...tl, tracks } : tl;
}
