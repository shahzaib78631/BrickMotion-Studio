/**
 * Measured gear geometry: where a gear's teeth are, not a guess from its box.
 *
 * Pure meshing math (no Three.js): pitch circles, cone tips and pitch lines
 * of gears already placed in the model. The measured per-part table that
 * produces them is gearTable.ts.
 *
 * Tooth size: every LEGO Technic gear has a 1.25 LDU pitch radius per tooth
 * (8T = 10, 24T = 30). Bevel cone tips and rack pitch lines are measured
 * values from the Kinebrick project's connection corrections
 * (github.com/erik-larsen/kinebrick, data/corrections.ldr, CC BY-SA 4.0),
 * cross-checked against official models; tolerances are its observed ones.
 */
type V3 = [number, number, number];
export const TOOTH_PITCH_RADIUS = 1.25;

export type WorldGear =
  | { key: string; kind: 'spur' | 'bevel'; teeth: number; radius: number; width: number; centre: V3; axis: V3;
      /** bevel only: unit direction the teeth face, and the cone tip */
      facing?: V3; tip?: V3 }
  | { key: string; kind: 'rack'; teeth: number; width: number; length: number;
      /** middle of the pitch line, its unit direction, and the way the teeth face */
      centre: V3; direction: V3; face: V3 };

// Tolerances observed in official models (see the header).
export const MESH_TOLERANCE = 2;    // spur pitch circles, LDU
export const RACK_TOLERANCE = 4.5;  // gear pitch circle to rack pitch line, LDU
export const BEVEL_TOLERANCE = 3.5; // cone tip to the shafts' crossing, LDU
const AXIS_TOLERANCE = 1;           // shafts that must cross, LDU
const PARALLEL = Math.cos(2 * Math.PI / 180);
const RACK_TILT = 0.55;             // radians a pinion may tip about the rack's length
const MIN_OVERLAP = 2;              // tooth widths that must overlap, LDU

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[], s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);

export type MeshVerdict = {
  meshes: boolean;
  /** Why not, in plain words, when it doesn't. */
  reason?: string;
  /** How far off the ideal, LDU. */
  errorLdu?: number;
  /** Output turns `sign * teethA/teethB` per input turn, about each gear's own axis. */
  sign?: 1 | -1;
};

/** Signed ratio from the velocity of both gears at their contact point. */
function contactSign(a: { centre: V3; axis: V3 }, b: { centre: V3; axis: V3 }, contact: V3): 1 | -1 {
  const va = cross(a.axis, sub(contact, a.centre)), vb = cross(b.axis, sub(contact, b.centre));
  return dot(va, vb) >= 0 ? 1 : -1;
}

/** Spur gears: parallel shafts, pitch circles touching, teeth overlapping. */
export function spurMesh(a: WorldGear, b: WorldGear): MeshVerdict {
  if (a.kind !== 'spur' || b.kind !== 'spur') return { meshes: false, reason: 'not two spur gears' };
  if (Math.abs(dot(a.axis, b.axis)) < PARALLEL) return { meshes: false, reason: 'shafts are not parallel' };
  const d = sub(b.centre, a.centre), along = dot(d, a.axis);
  const apart = len(add(d, a.axis, -along));
  const error = Math.abs(apart - (a.radius + b.radius));
  if (error > MESH_TOLERANCE) return { meshes: false, errorLdu: error, reason: `pitch circles ${error.toFixed(1)} LDU from touching` };
  if ((a.width + b.width) / 2 - Math.abs(along) < MIN_OVERLAP) return { meshes: false, errorLdu: error, reason: 'teeth are side by side, not overlapping' };
  const toB = add(d, a.axis, -along), unit = toB.map(x => x / (apart || 1));
  return { meshes: true, errorLdu: error, sign: contactSign(a, b, add(a.centre, unit, a.radius)) };
}

/** Where two shafts cross (midpoint of closest approach), or null. */
function crossing(a: { centre: V3; axis: V3 }, b: { centre: V3; axis: V3 }): V3 | null {
  const n = cross(a.axis, b.axis), nn = dot(n, n);
  if (nn < 1e-6) return null;
  const w = sub(b.centre, a.centre);
  if (Math.abs(dot(w, n)) / Math.sqrt(nn) > AXIS_TOLERANCE) return null;
  const s = dot(cross(w, b.axis), n) / nn, t = dot(cross(w, a.axis), n) / nn;
  return add(a.centre, a.axis, s).map((x, i) => (x + b.centre[i] + b.axis[i] * t) / 2) as V3;
}

/** Bevel gears: shafts that cross, both cone tips at the crossing. */
export function bevelMesh(a: WorldGear, b: WorldGear): MeshVerdict {
  if (a.kind !== 'bevel' || b.kind !== 'bevel') return { meshes: false, reason: 'not two bevel gears' };
  if (Math.abs(a.radius / a.teeth - b.radius / b.teeth) > 0.01) return { meshes: false, reason: 'different tooth sizes' };
  const x = crossing(a, b);
  if (!x) return { meshes: false, reason: 'shafts do not cross' };
  const error = Math.max(len(sub(a.tip!, x)), len(sub(b.tip!, x)));
  if (error > BEVEL_TOLERANCE) return { meshes: false, errorLdu: error, reason: `cone tips ${error.toFixed(1)} LDU from where the shafts cross` };
  // Contact: on each pitch circle, toward the other gear's teeth.
  const back = (g: WorldGear) => (g.kind === 'rack' ? [0, 0, 0] : g.facing!.map(v => -v)) as V3;
  const contact = add(add(x, back(a), b.radius), back(b), a.radius);
  return { meshes: true, errorLdu: error, sign: contactSign(a, b, contact) };
}

/** Rack and pinion: pinion shaft across the rack, pitch circle on the pitch line. */
export function rackMesh(gear: WorldGear, rack: WorldGear): MeshVerdict & { slide?: V3 } {
  if (gear.kind !== 'spur' || rack.kind !== 'rack') return { meshes: false, reason: 'not a spur pinion and a rack' };
  if (Math.abs((2 * Math.PI * gear.radius) / gear.teeth - (2 * Math.PI * TOOTH_PITCH_RADIUS)) > 0.25)
    return { meshes: false, reason: 'tooth size differs from the rack' };
  if (Math.abs(dot(gear.axis, rack.direction)) > 0.05) return { meshes: false, reason: 'pinion shaft is not across the rack' };
  const d = sub(gear.centre, rack.centre);
  const along = dot(d, rack.direction);
  if (Math.abs(along) > rack.length / 2) return { meshes: false, reason: `pinion is ${(Math.abs(along) - rack.length / 2).toFixed(1)} LDU past the end of the rack` };
  const apart = add(add(d, rack.direction, -along), gear.axis, -dot(d, gear.axis));
  const distance = len(apart);
  if (dot(apart, rack.face) < Math.cos(RACK_TILT) * distance) return { meshes: false, reason: 'pinion is not on the side the teeth face' };
  const error = Math.abs(distance - gear.radius);
  if (error > RACK_TOLERANCE) return { meshes: false, errorLdu: error, reason: `pitch circle ${error.toFixed(1)} LDU from the rack's pitch line` };
  if ((gear.width + rack.width) / 2 - Math.abs(dot(d, gear.axis)) < MIN_OVERLAP) return { meshes: false, errorLdu: error, reason: 'teeth do not overlap across their widths' };
  // Rack velocity for a positive pinion turn, at the contact point.
  const contact = add(gear.centre, apart.map(v => -v / (distance || 1)) as V3, gear.radius);
  const v = cross(gear.axis, sub(contact, gear.centre));
  return { meshes: true, errorLdu: error, sign: dot(v, rack.direction) >= 0 ? 1 : -1, slide: rack.direction };
}
