/** Continuous triangle SAT for fixed-orientation translations. No frame sampling.
 * Surface contact is resolved at a fixed 0.02 LDU numerical skin; this is not a
 * deformation simulation, a tolerance-free CAD proof, or a stability solver.
 */
import type { Box } from '../../ldraw/flatten';
import type { Connection, ConstructionModel, ConstructionNode, SearchStats } from './types';
import { add, sub, mul, dot, cross, norm, unit, vector, pos, bounds, union, shiftBox, overlaps, sweptBox, point, multiply } from './math';
import type { M4 } from './math';
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
            if (contains(solid, probe, pulse)) {
                chosen = probe;
                break;
            }
        }
        solid.representatives.push(chosen);
    }
    return solid;
}
/** Orthonormal basis of the plane perpendicular to a unit axis. */
function arcBasis(axis: V3): [V3, V3] {
    const helper: V3 = Math.abs(axis[0]) < .9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = unit(cross(axis, helper)), e2 = cross(axis, e1);
    return [e1, e2];
}
function boxOfPoints(points: V3[]): Box {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    return { min, max };
}
/** Exact AABB of one point's circular arc about `axis` through `pivot`. */
function pointArcBox(p: V3, axis: V3, pivot: V3, e1: V3, e2: V3, lo: number, hi: number, offset: V3): Box {
    const d = sub(p, pivot), h = dot(d, axis), radial = sub(d, mul(axis, h)), r = norm(radial);
    if (r < 1e-9) return boxOfPoints([add(add(pivot, mul(axis, h)), offset)]);
    const phi = Math.atan2(dot(radial, e2), dot(radial, e1));
    const base = add(pivot, mul(axis, h));
    const angles = new Set<number>([lo, hi]);
    for (let k = 0; k < 3; k++) {
        const a = r * (e1[k] * Math.cos(phi) + e2[k] * Math.sin(phi));
        const b = r * (-e1[k] * Math.sin(phi) + e2[k] * Math.cos(phi));
        if (Math.hypot(a, b) < 1e-12) continue;
        const critical = Math.atan2(b, a);
        for (const turn of [-Math.PI, 0, Math.PI, 2 * Math.PI])
            if (critical + turn > lo && critical + turn < hi) angles.add(critical + turn);
    }
    const points: V3[] = [];
    for (const theta of angles) {
        const t = theta;
        points.push(add(offset, add(base, add(mul(e1, r * Math.cos(phi + t)), mul(e2, r * Math.sin(phi + t))))));
    }
    return boxOfPoints(points);
}
function triangleArcBox(t: Tri, axis: V3, pivot: V3, lo: number, hi: number, offset: V3): Box {
    const [e1, e2] = arcBasis(axis);
    return union(union(pointArcBox(t.p[0], axis, pivot, e1, e2, lo, hi, offset), pointArcBox(t.p[1], axis, pivot, e1, e2, lo, hi, offset)), pointArcBox(t.p[2], axis, pivot, e1, e2, lo, hi, offset));
}
function solidArcBox(s: Solid, axis: V3, pivot: V3, lo: number, hi: number, offset: V3): Box {
    const [e1, e2] = arcBasis(axis);
    let box: Box | null = null;
    for (const t of s.triangles) {
        const b = union(union(pointArcBox(t.p[0], axis, pivot, e1, e2, lo, hi, offset), pointArcBox(t.p[1], axis, pivot, e1, e2, lo, hi, offset)), pointArcBox(t.p[2], axis, pivot, e1, e2, lo, hi, offset));
        box = box ? union(box, b) : b;
    }
    return box!;
}
/** Exact radial/axial interval covered by a solid around an axis. */
function solidAnnulusRange(s: Solid, axis: V3, pivot: V3, offset: V3): { rmin: number; rmax: number; hmin: number; hmax: number } {
    let rmin = Infinity, rmax = 0, hmin = Infinity, hmax = -Infinity;
    for (const t of s.triangles) for (const p of t.p) {
        const d = sub(add(p, offset), pivot), h = dot(d, axis), r = norm(sub(d, mul(axis, h)));
        rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
        hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
    }
    return { rmin, rmax, hmin, hmax };
}
/** Conservative full-turn annular cylinder AABB of a solid. */
function solidAnnulusBox(s: Solid, axis: V3, pivot: V3, offset: V3): Box {
    const [e1, e2] = arcBasis(axis);
    let rmax = 0, hmin = Infinity, hmax = -Infinity;
    for (const t of s.triangles) for (const p of t.p) {
        const d = sub(add(p, offset), pivot), h = dot(d, axis);
        rmax = Math.max(rmax, norm(sub(d, mul(axis, h))));
        hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
    }
    const points: V3[] = [];
    for (const h of [hmin, hmax]) for (const x of [-rmax, rmax]) for (const y of [-rmax, rmax])
        points.push(add(pivot, add(mul(axis, h), add(mul(e1, x), mul(e2, y)))));
    return boxOfPoints(points);
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
    // A contact that is gone within the skin of the start is the starting pose's own
    // flush touch being left (a plate face on a brick face, separating along its normal).
    if (norm(delta) > 1e-9 && hi * norm(delta) <= SKIN)
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
    // A numerical SAT interval does not prove an actual contact polygon exists.
    // Treat an empty clipping result as unverified, never as an exemption
    // (Array.every would otherwise accept it vacuously).
    if (!polygon.length) return false;
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
function nearSurface(s: Solid, p: V3, pulse: () => void = () => {}): boolean {
    const stack = [s.tree], limit = SKIN * SKIN;
    let visited = 0;
    while (stack.length) {
        if ((++visited & 255) === 0) pulse();
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
export function windingNumber(s: Solid, p: V3, pulse: () => void = () => {}): number {
    let sum = 0, correction = 0, visited = 0;
    for (const t of s.triangles) {
        if ((++visited & 255) === 0) pulse();
        const a = sub(t.p[0], p), b = sub(t.p[1], p), c = sub(t.p[2], p);
        const na = norm(a), nb = norm(b), nc = norm(c);
        const angle = 2 * Math.atan2(dot(a, cross(b, c)), na * nb * nc + dot(a, b) * nc + dot(b, c) * na + dot(c, a) * nb);
        const term = angle - correction, next = sum + term;
        correction = (next - sum) - term;
        sum = next;
    }
    return sum / (4 * Math.PI);
}
export function contains(s: Solid, p: V3, pulse: () => void = () => {}): boolean {
    if (!overlaps({ min: p, max: p }, s.box, -SKIN) || nearSurface(s, p, pulse))
        return false;
    return Math.abs(windingNumber(s, p, pulse)) > .5;
}
export class MeshOracle {
    private solids = new Map<string, Solid>();
    private results = new Map<string, boolean>();
    readonly bodies = new Map<string, Body>();
    lastFailure: unknown = null;
    constructor(private model: ConstructionModel, private stats: SearchStats, private pulse: () => void = () => { }) {
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
    /** Exact continuous translation of meshes in DIFFERENT rotated work bays.
     * Rotating only their AABBs caused false "blocked" results for safe paths.
     * Meshes are transformed at the fixed endpoint orientations; the segment
     * itself must be a translation. Rotations still use the separate full
     * enclosing-sphere proof in the planner.
     */
    clearPosed(aKey: string, bKey: string, aPose: M4, bPose: M4, worldDelta: V3, policy?: Connection): boolean {
        this.pulse();
        const moving = this.posedBody(aKey, aPose), obstacle = this.posedBody(bKey, bPose);
        const adapted = policy ? { ...policy,
            outward: policy.outward ? unit(vector(bPose, policy.outward)) : undefined,
            region: policy.region ? this.rotatedRegion(policy.region, bPose) : undefined,
            regions: policy.regions?.map(r => this.rotatedRegion(r, bPose)),
        } : undefined;
        return this.testBodies(aKey, bKey, moving, obstacle, [0, 0, 0], [0, 0, 0], worldDelta, adapted);
    }
    private rotatedRegion(r: NonNullable<Connection['region']>, m: M4): NonNullable<Connection['region']> {
        return { ...r, origin: point(m, r.origin), axis: unit(vector(m, r.axis)) };
    }
    private posedBody(id: string, pose: M4): Body {
        const n = this.model.parts.get(id)!;
        const matrix = multiply(pose, n.matrix);
        // Cached by shape and linear transform, NOT translation. A single mesh
        // is shared by thousands of differently positioned identical bricks.
        const key = n.part + '|' + matrix.slice(0, 12).join(',');
        let solid = this.solids.get(key);
        if (!solid) {
            solid = makeSolid(this.model.metrics(n.part!).mesh!, matrix, this.pulse);
            this.solids.set(key, solid);
        }
        return { key, solid, position: pos(matrix), axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => unit(vector(matrix, a as V3))) };
    }
    clear(aKey: string, bKey: string, aOffset: V3, bOffset: V3, delta: V3, policy?: Connection): boolean {
        this.pulse();
        return this.testBodies(aKey, bKey, this.bodies.get(aKey)!, this.bodies.get(bKey)!, aOffset, bOffset, delta, policy);
    }
    /**
     * Conservative continuous rotation certificate for one rigid part pair.
     * Every triangle of the moving body gets the exact bounding box of its
     * circular arc; if none overlaps the obstacle triangle boxes the rotation
     * is certified. Overlaps are subdivided; a surviving overlap is rejected,
     * never sampled into acceptance. This may reject a safe tight turn, but it
     * cannot accept a colliding one.
     */
    arcClear(aKey: string, bKey: string, aPose: M4, bPose: M4, pivot: V3, axis: V3, angle: number, slices = 16): boolean {
        this.pulse();
        if (!Number.isFinite(angle) || Math.abs(angle) < 1e-9) return this.clearPosed(aKey, bKey, aPose, bPose, [0, 0, 0]);
        const moving = this.posedBody(aKey, aPose), obstacle = this.posedBody(bKey, bPose);
        const u = unit(axis), a = moving.solid, b = obstacle.solid;
        const obstacleBox = shiftBox(b.box, obstacle.position), obstacleTris = b.triangles.map(o => shiftBox(o.box, obstacle.position));
        const sector = union(solidArcBox(a, u, pivot, 0, angle, moving.position), solidArcBox(a, u, pivot, angle, 0, moving.position));
        if (!overlaps(sector, obstacleBox, SKIN * 4)) return true;
        const parts = Math.max(1, Math.min(64, Math.ceil(slices)));
        for (let i = 0; i < parts; i++) {
            this.pulse();
            const lo = angle * i / parts, hi = angle * (i + 1) / parts;
            const box = solidArcBox(a, u, pivot, lo, hi, moving.position);
            if (!overlaps(box, obstacleBox, SKIN * 4)) continue;
            // A body-level overlap is only a prefilter. Test the actual triangle
            // arcs; this avoids rejecting a long part whose bounding sector merely
            // grazes an obstacle elsewhere.
            for (const t of a.triangles) {
                // Do not cull a triangle using its INITIAL AABB: a triangle
                // can start far away and enter the obstacle late in an arc.
                // Only its exact continuous sub-arc envelope is safe here.
                const arc = triangleArcBox(t, u, pivot, lo, hi, moving.position);
                for (const ob of obstacleTris) if (overlaps(arc, ob, SKIN)) return false;
            }
        }
        return true;
    }
    /**
     * Full-turn annulus certificate: if the rotation-invariant annular bounding
     * volume of the moving part is clear of the obstacle body, any angle is
     * certified. This is the cheap path for rotors, turntables and free wheels.
     */
    /** Diagnostic: exact conservative sector bounds used by arcClear. */
    arcSector(aKey: string, aPose: M4, pivot: V3, axis: V3, angle: number): Box {
        const moving = this.posedBody(aKey, aPose);
        return union(solidArcBox(moving.solid, unit(axis), pivot, 0, angle, moving.position), solidArcBox(moving.solid, unit(axis), pivot, angle, 0, moving.position));
    }
    annulusClear(aKey: string, bKey: string, aPose: M4, bPose: M4, pivot: V3, axis: V3): boolean {
        this.pulse();
        const moving = this.posedBody(aKey, aPose), obstacle = this.posedBody(bKey, bPose);
        const u = unit(axis);
        const a = solidAnnulusRange(moving.solid, u, pivot, moving.position), b = solidAnnulusRange(obstacle.solid, u, pivot, obstacle.position);
        // A central mast inside the rotor's inner radius is not in the swept
        // annulus. Radial and axial interval separation is exact and therefore
        // a positive free-turn certificate.
        if (a.rmax + SKIN < b.rmin || b.rmax + SKIN < a.rmin ||
            a.hmax + SKIN < b.hmin || b.hmax + SKIN < a.hmin) return true;
        const box = solidAnnulusBox(moving.solid, u, pivot, moving.position);
        return !overlaps(box, shiftBox(obstacle.solid.box, obstacle.position), SKIN * 4);
    }
    private testBodies(aKey: string, bKey: string, a: Body, b: Body, aOffset: V3, bOffset: V3, delta: V3, policy?: Connection): boolean {
        const pa = add(a.position, aOffset), pb = add(b.position, bOffset), relative = sub(pa, pb);
        if (!sweptBox(shiftBox(a.solid.box, pa), shiftBox(b.solid.box, pb), delta, -1e-6))
            return true;
        // A final-pose certificate is deliberately weaker than a motion
        // certificate. Even if a caller accidentally forwards a static-only
        // policy into a swept check, it cannot create an insertion/withdrawal
        // exemption. Zero-length checks retain the metadata so staticContact()
        // can classify the completed pose itself.
        const activePolicy = policy?.staticOnly && norm(delta) > 1e-9 ? undefined : policy;
        // A measured snap-fit disengagement is certified ONLY at the exact
        // relative pose where the final-contact audit measured it, along the
        // connector axis, and only for the measured distance. The separated
        // endpoint is re-checked under the localized policy; every remaining
        // part of this segment is then checked with no exemption at all.
        // A policy without an anchor (or a pair that has since moved) gets no
        // relaxation from surfaceTolerance.
        const anchor = activePolicy?.surfaceAnchor;
        if (anchor && activePolicy!.surfaceTolerance && activePolicy!.child === aKey && activePolicy!.outward &&
            norm(delta) > 1e-9 && dot(unit(delta), activePolicy!.outward) > .9999) {
            const relative = sub(pa, pb);
            if (norm(sub(relative, anchor)) <= 1e-3) {
                const distance = Math.min(activePolicy!.surfaceTolerance, norm(delta));
                const step = mul(unit(delta), distance);
                if (distance > 1e-9 &&
                    this.testBodies(aKey, bKey, a, b, add(aOffset, step), bOffset, [0, 0, 0], activePolicy) &&
                    this.testBodies(aKey, bKey, a, b, add(aOffset, step), bOffset, sub(delta, step)))
                    return true;
            }
        }
        // surfaceTolerance is a measurement of an existing final-pose overlap,
        // NOT a certificate to skip that many LDU of actual movement. Skipping
        // the first interval could accept an arbitrary path THROUGH an obstacle.
        // Only explicit, localized contact regions (validated below) can relax
        // mesh collisions on a swept path. Static-only metadata remains limited
        // to the stationary completed pose.
        const rawRegions = activePolicy ? [...(activePolicy.region ? [activePolicy.region] : []), ...(activePolicy.regions ?? [])] : [];
        const along = norm(delta) < 1e-9 || !activePolicy?.outward ? 0 : dot(unit(delta), activePolicy.outward);
        const allowed = rawRegions.length > 0 && activePolicy!.child === aKey && (norm(delta) < 1e-9 || along > .9999 || (!!activePolicy!.axial && along < -.9999));
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
        let clear = true, iterations = 0;
        while (stack.length && clear) {
            if ((++iterations & 255) === 0) this.pulse();
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
                    if (contains(b.solid, q, this.pulse)) {
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
                    if (contains(a.solid, sub(p, off), this.pulse)) {
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
            this.pulse();
            // Clear space along a non-convex render mesh is not necessarily
            // monotonic with displacement: a shallow contact can clear and then
            // hit an unrelated surface farther along the same direction. Probe
            // the bounded interval rather than assuming the far endpoint alone
            // determines whether a valid separating displacement exists.
            const samples = policy?.surfaceTolerance !== undefined ? 16 : 4;
            let lo = 0, hi: number | undefined;
            for (let i = 1; i <= samples; i++) {
                this.pulse();
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
                this.pulse();
                const mid = (lo + upper) / 2;
                if (this.clear(aKey, bKey, mul(d, mid), zero, zero, policy)) upper = mid; else lo = mid;
            }
            return { kind: 'surface', separation: mul(d, Math.min(tolerance, upper + SKIN)), failure };
        }
        return { kind: contained ? 'penetration' : 'unresolved', failure };
    }
}
