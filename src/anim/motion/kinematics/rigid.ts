/**
 * Rigid transforms and SO(3) maps for the kinematic solver. No three.js:
 * rotations are row-major 3x3 arrays, frames are {R, p} with x -> R x + p.
 *
 * Exponential and logarithm of SO(3), and the inverse left Jacobian used to
 * differentiate log(R) exactly (Murray, Li & Sastry, "A Mathematical
 * Introduction to Robotic Manipulation", ch. 2; Chirikjian, "Stochastic
 * Models, Information Theory and Lie Groups" vol. 2, ch. 10).
 */
export type V3 = [number, number, number];
export type M3 = number[]; // row-major, length 9
export type Frame = { R: M3; p: V3 };
export type Q4 = [number, number, number, number]; // x, y, z, w

export const I3 = (): M3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const identity = (): Frame => ({ R: I3(), p: [0, 0, 0] });

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => { const l = norm(a); if (!(l > 1e-12)) throw Error('zero-length axis'); return scale(a, 1 / l); };

export const mulMV = (R: M3, v: V3): V3 => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];
export const mulMtV = (R: M3, v: V3): V3 => [
  R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
  R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
  R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
];
export function mulMM(A: M3, B: M3): M3 {
  const C = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    C[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
  return C;
}
export const transpose = (R: M3): M3 => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];

export const compose = (a: Frame, b: Frame): Frame => ({ R: mulMM(a.R, b.R), p: add(mulMV(a.R, b.p), a.p) });
export const invert = (a: Frame): Frame => { const Rt = transpose(a.R); return { R: Rt, p: scale(mulMV(Rt, a.p), -1) }; };
export const apply = (a: Frame, x: V3): V3 => add(mulMV(a.R, x), a.p);

/** exp of the rotation vector w (Rodrigues). */
export function expSO3(w: V3): M3 {
  const t = norm(w);
  const [x, y, z] = w;
  // sin(t)/t and (1-cos t)/t^2 with series near 0.
  const A = t < 1e-6 ? 1 - t * t / 6 : Math.sin(t) / t;
  const B = t < 1e-6 ? 0.5 - t * t / 24 : (1 - Math.cos(t)) / (t * t);
  return [
    1 - B * (y * y + z * z), -A * z + B * x * y, A * y + B * x * z,
    A * z + B * x * y, 1 - B * (x * x + z * z), -A * x + B * y * z,
    -A * y + B * x * z, A * x + B * y * z, 1 - B * (x * x + y * y),
  ];
}

/** Rotation vector of R, angle in [0, pi]. */
export function logSO3(R: M3): V3 {
  const c = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const t = Math.acos(c);
  const v: V3 = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
  if (t < 1e-6) return scale(v, 0.5 + t * t / 12);
  if (Math.PI - t > 1e-4) return scale(v, t / (2 * Math.sin(t)));
  // Near pi: axis from the symmetric part, sign from the skew part.
  const d = [R[0], R[4], R[8]], k = d.indexOf(Math.max(...d));
  const a: V3 = [0, 0, 0];
  a[k] = Math.sqrt(Math.max(0, (d[k] - c) / (1 - c)));
  for (let j = 0; j < 3; j++) if (j !== k) a[j] = (R[3 * k + j] + R[3 * j + k]) / (2 * (1 - c) * a[k]);
  const s = Math.sign(dot(a, v)) || 1;
  return scale(unit(a), s * t);
}

const skew = (w: V3): M3 => [0, -w[2], w[1], w[2], 0, -w[0], -w[1], w[0], 0];

/** Inverse of the left Jacobian of SO(3) at rotation vector e: d log(exp(phi) R)/d phi at phi = 0. */
export function invLeftJacobianSO3(e: V3): M3 {
  const t = norm(e), K = skew(e), K2 = mulMM(K, K);
  const c = t < 1e-4 ? 1 / 12 + t * t / 720 : 1 / (t * t) - (1 + Math.cos(t)) / (2 * t * Math.sin(t));
  return I3().map((x, i) => x - 0.5 * K[i] + c * K2[i]);
}

/** World twist (w, v) moved by frame T: the adjoint map. */
export function adjoint(T: Frame, w: V3, v: V3): { w: V3; v: V3 } {
  const Rw = mulMV(T.R, w);
  return { w: Rw, v: add(mulMV(T.R, v), cross(T.p, Rw)) };
}

/** Rotation by angle t about axis a (unit) through point c. */
export function rotationAbout(a: V3, c: V3, t: number): Frame {
  const R = expSO3(scale(a, t));
  return { R, p: sub(c, mulMV(R, c)) };
}

export function quatToR(q: Q4): M3 {
  const [x, y, z, w] = q, n = Math.hypot(x, y, z, w), X = x / n, Y = y / n, Z = z / n, W = w / n;
  return [
    1 - 2 * (Y * Y + Z * Z), 2 * (X * Y - Z * W), 2 * (X * Z + Y * W),
    2 * (X * Y + Z * W), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z - X * W),
    2 * (X * Z - Y * W), 2 * (Y * Z + X * W), 1 - 2 * (X * X + Y * Y),
  ];
}

export function rToQuat(R: M3): Q4 {
  const tr = R[0] + R[4] + R[8];
  let q: Q4;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s, s / 4]; }
  else if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; q = [s / 4, (R[1] + R[3]) / s, (R[2] + R[6]) / s, (R[7] - R[5]) / s]; }
  else if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; q = [(R[1] + R[3]) / s, s / 4, (R[5] + R[7]) / s, (R[2] - R[6]) / s]; }
  else { const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; q = [(R[2] + R[6]) / s, (R[5] + R[7]) / s, s / 4, (R[3] - R[1]) / s]; }
  if (q[3] < 0) q = q.map(x => -x) as Q4;
  return q;
}

/** Re-orthonormalize a rotation drifting under repeated products. */
export function orthonormalize(R: M3): M3 { return quatToR(rToQuat(R)); }
