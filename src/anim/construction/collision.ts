/** Continuous triangle SAT for fixed-orientation translations. No frame sampling.
 * Surface contact is resolved at a fixed 0.02 LDU numerical skin; this is not a
 * deformation simulation, a tolerance-free CAD proof, or a stability solver.
 */
import type { Box } from '../../ldraw/flatten';
import type { Connection, ConstructionModel, ConstructionNode, SearchStats } from './types';
import { add, sub, mul, dot, cross, norm, unit, vector, pos, bounds, union, shiftBox, overlaps, sweptBox, point } from './math';
import type { V3 } from './math';
export const SKIN = 0.02;
type Tri = {
    p: [
        V3,
        V3,
        V3
    ];
    edges: [
        V3,
        V3,
        V3
    ];
    normal: V3;
    box: Box;
};
type Tree = {
    box: Box;
    left?: Tree;
    right?: Tree;
    triangles?: Tri[];
};
export type Solid = {
    tree: Tree;
    box: Box;
    triangles: Tri[];
    representatives: V3[];
};
export type Body = {
    key: string;
    solid: Solid;
    position: V3;
    axes: V3[];
};
export type Collision = {
    a: string;
    b: string;
    detail: string;
};
const triangle = (p: [
    V3,
    V3,
    V3
]): Tri | null => { const edges: [
    V3,
    V3,
    V3
] = [sub(p[1], p[0]), sub(p[2], p[1]), sub(p[0], p[2])], n = cross(edges[0], edges[1]); return norm(n) < 1e-9 ? null : { p, edges, normal: unit(n), box: bounds(p.flat()) }; };
function buildTree(tris: Tri[]): Tree {
    const box = tris.map(t => t.box).reduce(union);
    if (tris.length <= 8)
        return { box, triangles: tris };
    const size = sub(box.max, box.min), axis = size.indexOf(Math.max(...size));
    const sorted = [...tris].sort((a, b) => a.box.min[axis] + a.box.max[axis] - b.box.min[axis] - b.box.max[axis]), mid = sorted.length >> 1;
    return { box, left: buildTree(sorted.slice(0, mid)), right: buildTree(sorted.slice(mid)) };
}
export function makeSolid(mesh: Float32Array, matrix: readonly number[], pulse: () => void = () => { }): Solid {
    const tris: Tri[] = [];
    for (let i = 0; i < mesh.length; i += 9) {
        if (i % 9216 === 0)
            pulse();
        const p = [0, 3, 6].map(k => vector(matrix, [mesh[i + k], mesh[i + k + 1], mesh[i + k + 2]])) as [
            V3,
            V3,
            V3
        ];
        const t = triangle(p);
        if (t)
            tris.push(t);
    }
    if (!tris.length)
        throw new Error('Collision mesh has no non-degenerate triangles.');
    // One representative per vertex-connected surface component catches a solid
    // wholly enclosed in another solid without a triangle-surface crossing.
    const parent = tris.map((_, i) => i), find = (i: number): number => { while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
    } return i; };
    const vertex = new Map<string, number>();
    tris.forEach((t, i) => t.p.forEach(p => { const key = p.map(v => Math.round(v * 1e5)).join(','); const j = vertex.get(key); if (j === undefined)
        vertex.set(key, i);
    else
        parent[find(i)] = find(j); }));
    const representatives = new Map<number, V3>();
    tris.forEach((t, i) => { const root = find(i); if (!representatives.has(root))
        representatives.set(root, mul(add(add(t.p[0], t.p[1]), t.p[2]), 1 / 3)); });
    const tree = buildTree(tris), solid: Solid = { tree, box: tree.box, triangles: tris, representatives: [] };
    // Interior probes also detect coincident identical solids (all their surface
    // representatives would otherwise lie exactly on the other solid's boundary).
    for (const [root, p] of representatives) {
        pulse();
        const t = tris[root];
        let chosen = p;
        for (const sign of [-1, 1]) {
            const probe = add(p, mul(t.normal, sign * SKIN * 4));
            if (contains(solid, probe)) {
                chosen = probe;
                break;
            }
        }
        solid.representatives.push(chosen);
    }
    return solid;
}
function project(p: [
    V3,
    V3,
    V3
], axis: V3): [
    number,
    number
] { const v = p.map(p => dot(p, axis)); return [Math.min(...v), Math.max(...v)]; }
/** Interval of overlap of two convex triangles under translation. */
export function triangleInterval(a: Tri, b: Tri, offset: V3, delta: V3): [
    number,
    number
] | null {
    const ap = a.p.map(p => add(p, offset)) as [
        V3,
        V3,
        V3
    ];
    // Coplanar sliding is tangency, not solid penetration.
    if (Math.abs(dot(a.normal, b.normal)) > 1 - 1e-5 && ap.every(p => Math.abs(dot(sub(p, b.p[0]), b.normal)) <= SKIN && Math.abs(dot(sub(add(p, delta), b.p[0]), b.normal)) <= SKIN))
        return null;
    const axes = [a.normal, b.normal, ...a.edges.flatMap(e => b.edges.map(f => cross(e, f))), ...a.edges.map(e => cross(a.normal, e)), ...b.edges.map(e => cross(b.normal, e))];
    let lo = 0, hi = 1;
    for (const raw of axes) {
        const length = norm(raw);
        if (length < 1e-10)
            continue;
        const axis = mul(raw, 1 / length);
        let [amin, amax] = project(ap, axis), [bmin, bmax] = project(b.p, axis);
        // Shrink only non-degenerate projections. Zero-thickness triangle normals
        // must retain their plane, or every surface crossing would be missed.
        if (amax - amin > 2 * SKIN) {
            amin += SKIN;
            amax -= SKIN;
        }
        if (bmax - bmin > 2 * SKIN) {
            bmin += SKIN;
            bmax -= SKIN;
        }
        const speed = dot(delta, axis);
        if (Math.abs(speed) < 1e-12) {
            if (amax < bmin - 1e-9 || amin > bmax + 1e-9)
                return null;
            continue;
        }
        let enter = (bmin - amax) / speed, exit = (bmax - amin) / speed;
        if (enter > exit)
            [enter, exit] = [exit, enter];
        lo = Math.max(lo, enter);
        hi = Math.min(hi, exit);
        if (lo > hi + 1e-12)
            return null;
    }
    if (hi < 1e-9 || lo > 1 - 1e-9)
        return null;
    return [Math.max(0, lo), Math.min(1, hi)];
}
function insideRegion(box: Box, r: NonNullable<Connection['region']>): boolean {
    for (const x of [box.min[0], box.max[0]])
        for (const y of [box.min[1], box.max[1]])
            for (const z of [box.min[2], box.max[2]]) {
                const d = sub([x, y, z], r.origin), t = dot(d, r.axis);
                const radial = norm(sub(d, mul(r.axis, t)));
                if (t < -.05 || t > r.length + .05 || radial > r.radius || radial < (r.minRadius ?? 0))
                    return false;
            }
    return true;
}
/** Clip a stationary triangle by the convex swept triangular prism. Its
 * vertices bound EVERY contact over the interval, unlike sampled contact points
 * or an over-large world AABB. Cylindrical regions are convex. */
function contactPolygon(a: Tri, b: Tri, offset: V3, delta: V3, interval: [
    number,
    number
]): V3[] {
    const verts = interval.flatMap(t => a.p.map(p => add(p, add(offset, mul(delta, t)))));
    const planes: {
        n: V3;
        d: number;
    }[] = [];
    for (let i = 0; i < verts.length; i++)
        for (let j = i + 1; j < verts.length; j++)
            for (let k = j + 1; k < verts.length; k++) {
                const raw = cross(sub(verts[j], verts[i]), sub(verts[k], verts[i]));
                if (norm(raw) < 1e-10)
                    continue;
                let n = unit(raw), d = dot(n, verts[i]);
                const distances = verts.map(v => dot(n, v) - d);
                if (Math.min(...distances) < -1e-7 && Math.max(...distances) > 1e-7)
                    continue;
                if (Math.max(...distances) > 1e-7) {
                    n = mul(n, -1);
                    d = -d;
                }
                if (!planes.some(p => dot(p.n, n) > 1 - 1e-8 && Math.abs(p.d - d) < 1e-6))
                    planes.push({ n, d });
            }
    // Degenerate in-plane sweeps need the side planes too.
    if (Math.abs(dot(delta, a.normal)) < 1e-9) {
        for (let i = 0; i < verts.length; i++)
            for (let j = i + 1; j < verts.length; j++) {
                const raw = cross(a.normal, sub(verts[j], verts[i]));
                if (norm(raw) < 1e-10)
                    continue;
                let n = unit(raw), d = dot(n, verts[i]);
                const dist = verts.map(v => dot(n, v) - d);
                if (Math.min(...dist) < -1e-7 && Math.max(...dist) > 1e-7)
                    continue;
                if (Math.max(...dist) > 1e-7) {
                    n = mul(n, -1);
                    d = -d;
                }
                planes.push({ n, d });
            }
    }
    let polygon: V3[] = [...b.p];
    for (const { n, d } of planes) {
        const next: V3[] = [];
        for (let i = 0; i < polygon.length; i++) {
            const p = polygon[i], q = polygon[(i + 1) % polygon.length], dp = dot(n, p) - d, dq = dot(n, q) - d;
            if (dp <= 1e-7)
                next.push(p);
            if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0))
                next.push(add(p, mul(sub(q, p), dp / (dp - dq))));
        }
        polygon = next;
        if (!polygon.length)
            break;
    }
    return polygon;
}
function localizedContact(a: Tri, b: Tri, offset: V3, delta: V3, interval: [
    number,
    number
], region: NonNullable<Connection['region']>, obstaclePosition: V3): boolean {
    const polygon = contactPolygon(a, b, offset, delta, interval);
    if (!polygon.every(p => { const world = add(p, obstaclePosition); return insideRegion({ min: world, max: world }, region); }))
        return false;
    if (region.minRadius && polygon.length) {
        const radial = polygon.map(p => { const v = sub(add(p, obstaclePosition), region.origin); return sub(v, mul(region.axis, dot(v, region.axis))); });
        let minimum = Infinity, positive = false, negative = false, area = 0;
        for (let i = 0; i < radial.length; i++) {
            const p = radial[i], q = radial[(i + 1) % radial.length], edge = sub(q, p), den = dot(edge, edge), t = den ? Math.max(0, Math.min(1, -dot(p, edge) / den)) : 0;
            minimum = Math.min(minimum, norm(add(p, mul(edge, t))));
            const sign = dot(cross(edge, mul(p, -1)), region.axis);
            if (sign > 1e-8)
                positive = true;
            if (sign < -1e-8)
                negative = true;
            area += dot(cross(p, q), region.axis);
        }
        if (Math.abs(area) > 1e-8 && !(positive && negative))
            minimum = 0;
        if (minimum < region.minRadius)
            return false;
    }
    return true;
}
function nearSurface(s: Solid, p: V3): boolean {
    const stack = [s.tree], limit = SKIN * SKIN;
    while (stack.length) {
        const n = stack.pop()!;
        const distance = n.box.min.reduce((sum, lo, k) => sum + Math.max(lo - p[k], p[k] - n.box.max[k], 0) ** 2, 0);
        if (distance > limit)
            continue;
        if (!n.triangles) {
            stack.push(n.left!, n.right!);
            continue;
        }
        for (const t of n.triangles) {
            const height = dot(sub(p, t.p[0]), t.normal);
            if (Math.abs(height) > SKIN)
                continue;
            const q = sub(p, mul(t.normal, height));
            if (t.edges.every((edge, i) => dot(cross(edge, sub(q, t.p[i])), t.normal) >= -1e-9))
                return true;
            for (let i = 0; i < 3; i++) {
                const e = t.edges[i], r = sub(p, t.p[i]), u = Math.max(0, Math.min(1, dot(r, e) / dot(e, e)));
                if (dot(sub(r, mul(e, u)), sub(r, mul(e, u))) <= limit)
                    return true;
            }
        }
    }
    return false;
}
/** Oriented solid-angle containment. Unlike a fixed set of ray directions, this
 * does not change classification when the same part is rotated. It also avoids
 * odd/even cancellation of overlapping oriented surface components. Requires
 * reasonably consistent triangle orientation; open render meshes are not CAD
 * solids. See Jacobson, Kavan & Sorkine-Hornung (SIGGRAPH 2013),
 * https://igl.ethz.ch/projects/winding-number/
 */
export function windingNumber(s: Solid, p: V3): number {
    let sum = 0, correction = 0;
    for (const t of s.triangles) {
        const a = sub(t.p[0], p), b = sub(t.p[1], p), c = sub(t.p[2], p);
        const na = norm(a), nb = norm(b), nc = norm(c);
        const angle = 2 * Math.atan2(dot(a, cross(b, c)), na * nb * nc + dot(a, b) * nc + dot(b, c) * na + dot(c, a) * nb);
        const term = angle - correction, next = sum + term;
        correction = (next - sum) - term;
        sum = next;
    }
    return sum / (4 * Math.PI);
}
export function contains(s: Solid, p: V3): boolean {
    if (!overlaps({ min: p, max: p }, s.box, -SKIN) || nearSurface(s, p))
        return false;
    return Math.abs(windingNumber(s, p)) > .5;
}
export class MeshOracle {
    private solids = new Map<string, Solid>();
    private results = new Map<string, boolean>();
    readonly bodies = new Map<string, Body>();
    lastFailure: unknown = null;
    constructor(model: ConstructionModel, private stats: SearchStats, private pulse: () => void = () => { }) {
        for (const n of model.parts.values()) {
            this.pulse();
            const key = n.part + '|' + n.matrix.slice(0, 12).join(',');
            let solid = this.solids.get(key);
            if (!solid) {
                solid = makeSolid(model.metrics(n.part!).mesh!, n.matrix, this.pulse);
                this.solids.set(key, solid);
            }
            this.bodies.set(n.id, { key, solid, position: pos(n.matrix), axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => unit(vector(n.matrix, a as V3))) });
        }
    }
    clear(aKey: string, bKey: string, aOffset: V3, bOffset: V3, delta: V3, policy?: Connection): boolean {
        const a = this.bodies.get(aKey)!, b = this.bodies.get(bKey)!;
        const pa = add(a.position, aOffset), pb = add(b.position, bOffset), relative = sub(pa, pb);
        if (!sweptBox(shiftBox(a.solid.box, pa), shiftBox(b.solid.box, pb), delta, -1e-6))
            return true;
        // A final-pose certificate is deliberately weaker than a motion
        // certificate. Even if a caller accidentally forwards a static-only
        // policy into a swept check, it cannot create an insertion/withdrawal
        // exemption. Zero-length checks retain the metadata so staticContact()
        // can classify the completed pose itself.
        const activePolicy = policy?.staticOnly && norm(delta) > 1e-9 ? undefined : policy;
        // A surface certificate is only valid while EXITING the tiny final-pose
        // overlap that was independently measured by staticContact(). It never
        // exempts transit through the obstacle and it is bounded in LDU.
        if (activePolicy?.surfaceTolerance && activePolicy.child === aKey && activePolicy.outward && norm(delta) > 1e-9 && dot(unit(delta), activePolicy.outward) > .9999) {
            const distance = Math.min(activePolicy.surfaceTolerance, norm(delta));
            const step = mul(unit(delta), distance);
            if (distance > 1e-9 && this.clear(aKey, bKey, add(aOffset, step), bOffset, sub(delta, step)))
                return true;
        }
        const rawRegions = activePolicy ? [...(activePolicy.region ? [activePolicy.region] : []), ...(activePolicy.regions ?? [])] : [];
        const allowed = rawRegions.length > 0 && activePolicy!.child === aKey && (norm(delta) < 1e-9 || (activePolicy!.outward && dot(unit(delta), activePolicy!.outward) > .9999));
        const regions = allowed ? rawRegions.map(region => ({ ...region, origin: add(region.origin, bOffset) })) : [];
        const key = [a.key, b.key, relative.join(','), delta.join(','), regions.length ? JSON.stringify(regions) : ''].join('|');
        const cached = this.results.get(key);
        if (cached !== undefined) {
            this.stats.cacheHits++;
            return cached;
        }
        this.stats.meshPairs++;
        this.lastFailure = null;
        const stack: [
            Tree,
            Tree
        ][] = [[a.solid.tree, b.solid.tree]];
        let clear = true;
        while (stack.length && clear) {
            const [an, bn] = stack.pop()!;
            if (!sweptBox(shiftBox(an.box, relative), bn.box, delta, -1e-6))
                continue;
            if (an.triangles && bn.triangles) {
                for (const at of an.triangles) {
                    for (const bt of bn.triangles) {
                        if (!sweptBox(shiftBox(at.box, relative), bt.box, delta, -1e-6))
                            continue;
                        if (++this.stats.trianglePairs % 1024 === 0)
                            this.pulse();
                        const interval = triangleInterval(at, bt, relative, delta);
                        if (interval && !regions.some(region => localizedContact(at, bt, relative, delta, interval, region, pb))) {
                            const polygon = contactPolygon(at, bt, relative, delta, interval).map(p => add(p, pb));
                            this.lastFailure = { kind: 'triangle', a: aKey, b: bKey, aTriangle: at.p, bTriangle: bt.p, relative, delta, interval, regions, obstaclePosition: pb, contactPolygon: polygon };
                            clear = false;
                            break;
                        }
                    }
                    if (!clear)
                        break;
                }
            }
            else if (an.triangles)
                stack.push([an, bn.left!], [an, bn.right!]);
            else if (bn.triangles)
                stack.push([an.left!, bn], [an.right!, bn]);
            else
                stack.push([an.left!, bn.left!], [an.left!, bn.right!], [an.right!, bn.left!], [an.right!, bn.right!]);
        }
        // Full containment does not produce crossing surfaces. Test components at
        // both endpoints, excluding only explicitly localized connector material.
        if (clear)
            for (const t of [0, 1]) {
                const off = add(relative, mul(delta, t));
                for (const p of a.solid.representatives) {
                    const q = add(p, off), world = add(q, pb);
                    if (regions.some(region => insideRegion({ min: world, max: world }, region)))
                        continue;
                    if (contains(b.solid, q)) {
                        this.lastFailure = { kind: 'contained-a', a: aKey, b: bKey, point: world, regions };
                        clear = false;
                        break;
                    }
                }
                if (!clear)
                    break;
                for (const p of b.solid.representatives) {
                    const world = add(p, pb);
                    if (regions.some(region => insideRegion({ min: world, max: world }, region)))
                        continue;
                    if (contains(a.solid, sub(p, off))) {
                        this.lastFailure = { kind: 'contained-b', a: aKey, b: bKey, point: world, regions };
                        clear = false;
                        break;
                    }
                }
                if (!clear)
                    break;
            }
        if (this.results.size > 50000)
            this.results.clear();
        this.results.set(key, clear);
        return clear;
    }
    /** Classify a completed-placement contact without weakening swept motion checks.
     * A tiny separating displacement may certify render-mesh surface contact, but
     * containment or contact that survives the bounded probe remains unresolved. */
    staticContact(aKey: string, bKey: string, policy?: Connection, tolerance = 0.25): { kind: 'clear' | 'connector' | 'surface' | 'penetration' | 'unresolved'; separation?: V3; failure?: unknown } {
        const zero: V3 = [0, 0, 0];
        // If a connector explains only part of the final contact (for example a
        // shoulder socket plus harmless upper-arm/torso surface contact), retain
        // that connector while classifying the residual.  Re-running the probe
        // without it makes the already-certified connector overlap dominate the
        // measured separation and falsely turns a shallow touch into a deep one.
        let failure: { kind?: string } | null = null;
        if (policy) {
            if (this.clear(aKey, bKey, zero, zero, zero, policy))
                return { kind: 'connector' };
            failure = this.lastFailure as { kind?: string } | null;
        }
        else {
            if (this.clear(aKey, bKey, zero, zero, zero))
                return { kind: 'clear' };
            failure = this.lastFailure as { kind?: string } | null;
        }
        const contained = failure?.kind === 'contained-a' || failure?.kind === 'contained-b';
        // A representative point from an open/non-manifold render mesh can land
        // microscopically inside its neighbour even when the completed pose is
        // only a shallow edge/surface contact.  Do not promote that numerical
        // artifact to a hard penetration until the same bounded directional
        // separation probe has failed.  Genuine containment still fails because
        // it cannot clear within the caller's small, pair-specific tolerance.
        if (!Number.isFinite(tolerance) || tolerance <= 0)
            return { kind: contained ? 'penetration' : 'unresolved', failure };
        const a = this.bodies.get(aKey)!, b = this.bodies.get(bKey)!;
        const centre = sub(a.position, b.position);
        // Probe the actual contact-plane normals as well as the part axes. A
        // shallow touch between a sloped/curved surface and another part can
        // require a very long X/Y/Z slide before the AABBs separate even though
        // less than one LDU along the contact normal proves there is no solid
        // penetration. This affects final-contact classification only; swept
        // motion still uses the full continuous triangle SAT in clear().
        const contactNormals: V3[] = [];
        const triFailure = failure as { aTriangle?: [V3, V3, V3]; bTriangle?: [V3, V3, V3] } | null;
        for (const tri of [triFailure?.aTriangle, triFailure?.bTriangle]) if (tri) {
            const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
            if (norm(n) > 1e-9) contactNormals.push(unit(n));
        }
        const raw = [...(policy?.outward ? [policy.outward] : []), ...contactNormals, ...a.axes, ...b.axes, ...(norm(centre) > 1e-8 ? [unit(centre)] : [])];
        const dirs: V3[] = [];
        for (const axis of raw) for (const sign of [-1, 1]) {
            const d = mul(axis, sign);
            if (!dirs.some(e => dot(d, e) > 1 - 1e-8)) dirs.push(d);
        }
        for (const d of dirs) {
            // Clear space along a non-convex render mesh is not necessarily
            // monotonic with displacement: a shallow contact can clear and then
            // hit an unrelated surface farther along the same direction. Probe
            // the bounded interval rather than assuming the far endpoint alone
            // determines whether a valid separating displacement exists.
            const samples = policy?.surfaceTolerance !== undefined ? 16 : 4;
            let lo = 0, hi: number | undefined;
            for (let i = 1; i <= samples; i++) {
                const distance = tolerance * i / samples;
                if (this.clear(aKey, bKey, mul(d, distance), zero, zero, policy)) {
                    hi = distance;
                    break;
                }
                lo = distance;
            }
            if (hi === undefined) continue;
            let upper: number = hi;
            for (let i = 0; i < 8; i++) {
                const mid = (lo + upper) / 2;
                if (this.clear(aKey, bKey, mul(d, mid), zero, zero, policy)) upper = mid; else lo = mid;
            }
            return { kind: 'surface', separation: mul(d, Math.min(tolerance, upper + SKIN)), failure };
        }
        return { kind: contained ? 'penetration' : 'unresolved', failure };
    }
}
