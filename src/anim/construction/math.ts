/** Planner-owned numeric primitives. No renderer classes or mutable global scratch state. */
import type { Box } from '../../ldraw/flatten';
export type V3 = [
    number,
    number,
    number
];
export type M4 = number[];
export const identity = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): number => Math.hypot(...a);
export function unit(a: V3): V3 { const n = norm(a); if (!Number.isFinite(n) || n < 1e-12)
    throw new Error('Invalid direction'); return mul(a, 1 / n); }
export const pos = (m: readonly number[]): V3 => [m[12], m[13], m[14]];
export const vector = (m: readonly number[], p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
export const point = (m: readonly number[], p: V3): V3 => add(vector(m, p), pos(m));
export function multiply(a: readonly number[], b: readonly number[]): M4 {
    const out = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
            for (let k = 0; k < 4; k++)
                out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
}
export function translation(v: V3): M4 {
    const out = identity();
    out[12] = v[0]; out[13] = v[1]; out[14] = v[2];
    return out;
}
/** Proper world-space rotation matrix. Reflections/scale/shear stay in the
 * source placement and are carried by left-multiplying this rigid transform. */
export function rotation(axis: V3, angle: number): M4 {
    const [x, y, z] = unit(axis), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [
        t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
        t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
        t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
        0, 0, 0, 1,
    ];
}
/** Rigid delta applied to an already-world-space placement: translate the
 * completed model by `offset`, while optionally rotating it about a pivot that
 * is expressed in the completed model's world coordinates. */
export function rigidDelta(offset: V3, pivot?: V3, axis?: V3, angle = 0): M4 {
    if (!pivot || !axis || Math.abs(angle) < 1e-12)
        return translation(offset);
    return multiply(translation(add(pivot, offset)), multiply(rotation(axis, angle), translation(mul(pivot, -1))));
}
export function translated(m: readonly number[], v: V3): M4 { const out = [...m]; for (let k = 0; k < 3; k++)
    out[12 + k] += v[k]; return out; }
export function placement(p: {
    pos: V3;
    m: readonly number[];
}): M4 { const a = p.m; return [a[0], a[3], a[6], 0, a[1], a[4], a[7], 0, a[2], a[5], a[8], 0, ...p.pos, 1]; }
export function determinant(m: readonly number[]): number { return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]); }
export function validMatrix(m: readonly number[]): boolean { return m.length === 16 && m.every(Number.isFinite) && [3, 7, 11].every(k => Math.abs(m[k]) < 1e-10) && Math.abs(m[15] - 1) < 1e-10 && Math.abs(determinant(m)) > 1e-10; }
export function invert(m: readonly number[]): M4 {
    if (!validMatrix(m))
        throw new Error('Invalid affine matrix');
    const d = determinant(m), out = identity();
    out[0] = (m[5] * m[10] - m[9] * m[6]) / d;
    out[4] = (m[8] * m[6] - m[4] * m[10]) / d;
    out[8] = (m[4] * m[9] - m[8] * m[5]) / d;
    out[1] = (m[9] * m[2] - m[1] * m[10]) / d;
    out[5] = (m[0] * m[10] - m[8] * m[2]) / d;
    out[9] = (m[8] * m[1] - m[0] * m[9]) / d;
    out[2] = (m[1] * m[6] - m[5] * m[2]) / d;
    out[6] = (m[4] * m[2] - m[0] * m[6]) / d;
    out[10] = (m[0] * m[5] - m[4] * m[1]) / d;
    const t = mul(vector(out, pos(m)), -1);
    for (let k = 0; k < 3; k++)
        out[12 + k] = t[k];
    return out;
}
export function bounds(points: ArrayLike<number>): Box {
    const b: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < points.length; i += 3)
        for (let k = 0; k < 3; k++) {
            b.min[k] = Math.min(b.min[k], points[i + k]);
            b.max[k] = Math.max(b.max[k], points[i + k]);
        }
    return b;
}
export function transformBox(b: Box, m: readonly number[]): Box {
    const p: number[] = [];
    for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]])
            for (const z of [b.min[2], b.max[2]])
                p.push(...point(m, [x, y, z]));
    return bounds(p);
}
export const shiftBox = (b: Box, d: V3): Box => ({ min: add(b.min, d), max: add(b.max, d) });
export const union = (a: Box, b: Box): Box => ({ min: a.min.map((v, k) => Math.min(v, b.min[k])) as V3, max: a.max.map((v, k) => Math.max(v, b.max[k])) as V3 });
export const overlaps = (a: Box, b: Box, epsilon = 0): boolean => [0, 1, 2].every(k => a.max[k] > b.min[k] + epsilon && a.min[k] < b.max[k] - epsilon);
export const centre = (b: Box): V3 => mul(add(b.min, b.max), .5);
export const size = (b: Box): V3 => sub(b.max, b.min);
export const axisDirections = (m: readonly number[]): V3[] => [0, 4, 8].flatMap(c => { const v = unit([m[c], m[c + 1], m[c + 2]]); return [v, mul(v, -1)]; });
/** Time interval during which two translating boxes overlap. */
export function sweptBox(a: Box, b: Box, delta: V3, epsilon = 0): boolean {
    let enter = 0, exit = 1;
    for (let k = 0; k < 3; k++) {
        if (Math.abs(delta[k]) < 1e-12) {
            if (a.max[k] <= b.min[k] + epsilon || a.min[k] >= b.max[k] - epsilon)
                return false;
            continue;
        }
        let t0 = (b.min[k] + epsilon - a.max[k]) / delta[k], t1 = (b.max[k] - epsilon - a.min[k]) / delta[k];
        if (t0 > t1)
            [t0, t1] = [t1, t0];
        enter = Math.max(enter, t0);
        exit = Math.min(exit, t1);
        if (enter >= exit)
            return false;
    }
    return exit > 0 && enter < 1;
}
/** Translation-only paths preserve the imported scale, shear and reflection exactly. */
export function pathOffset(path: readonly V3[], fraction: number): V3 {
    if (path.length < 2)
        return path[0] ?? [0, 0, 0];
    const lengths = path.slice(1).map((p, i) => norm(sub(p, path[i]))), total = lengths.reduce((a, b) => a + b, 0);
    let distance = Math.max(0, Math.min(1, fraction)) * total;
    for (let i = 0; i < lengths.length; i++) {
        if (distance <= lengths[i] || i === lengths.length - 1)
            return add(path[i], mul(sub(path[i + 1], path[i]), lengths[i] ? distance / lengths[i] : 1));
        distance -= lengths[i];
    }
    return path[path.length - 1];
}
