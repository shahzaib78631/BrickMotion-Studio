/**
 * One global scene for V4. Every cluster is always present: installed at its
 * authored pose, or staged at a workbench slot. Scopes are never isolated, so a
 * route cannot ignore a neighbouring submodel or a previously removed part.
 */
import type { Box } from '../../../../ldraw/flatten';
import { add, mul, multiply, norm, pos, rigidDelta, shiftBox, size, sub, transformBox, union } from '../../math';
import type { M4, V3 } from '../../math';
import { MeshOracle, SKIN } from '../../collision';
import { isIdentityOrientation, stagedBounds } from '../../rigidStaging';
import type { Connection, ConstructionModel, ConstructionNode, SearchStats } from '../../types';
import type { ClusterId, V4Cluster, V4Joint, V4Stats } from '../types';

const ZERO: V3 = [0, 0, 0];
const CORNERS: V3[] = [
    [0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1],
    [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1],
];
const boxCorner = (b: Box, i: number): V3 => [CORNERS[i][0] ? b.max[0] : b.min[0], CORNERS[i][1] ? b.max[1] : b.min[1], CORNERS[i][2] ? b.max[2] : b.min[2]];

export type ClearProof = { pairs: number; detail: string };

export class V4Scene {
    readonly model: ConstructionModel;
    readonly clusters: V4Cluster[];
    readonly joints: V4Joint[];
    readonly leafToCluster: Map<string, number>;
    readonly leafFinal = new Map<string, M4>();
    readonly leavesByCluster: string[][];
    readonly poses: M4[];
    readonly installed: boolean[];
    readonly slotPoses: M4[];
    readonly slotBounds: Box[];
    readonly oracle: MeshOracle;
    readonly ground: number;
    readonly sceneBounds: Box;
    readonly ceiling: number;
    readonly stats: SearchStats;
    readonly pulse: () => void;
    lastFailure: unknown = null;
    private readonly policyIndex = new Map<string, Connection[]>();

    constructor(model: ConstructionModel, clusters: V4Cluster[], joints: V4Joint[], leafToCluster: Map<string, number>, stats: SearchStats, pulse: () => void, connections: readonly Connection[] = [], layoutBounds?: Box) {
        this.model = model;
        this.clusters = clusters;
        this.joints = joints;
        this.leafToCluster = leafToCluster;
        this.stats = stats;
        this.pulse = pulse;
        this.ground = model.bounds.max[1];
        this.addPolicies(connections, true);
        this.leavesByCluster = clusters.map(() => []);
        for (const [leaf, cluster] of leafToCluster) this.leavesByCluster[cluster].push(leaf);
        for (const node of model.parts.values()) this.leafFinal.set(node.id, [...node.matrix] as M4);
        this.poses = clusters.map(() => rigidDelta(ZERO));
        this.installed = clusters.map(() => true);
        this.slotPoses = new Array(clusters.length);
        this.slotBounds = new Array(clusters.length);
        const layout = layoutBounds ?? model.bounds;
        const gap = 24;
        const area = clusters.reduce((sum, c) => sum + (size(c.bounds)[0] + gap) * (size(c.bounds)[2] + gap), 0);
        const rowWidth = Math.max(400, Math.sqrt(area) * 1.35, ...clusters.map(c => size(c.bounds)[0] + gap));
        const originX = layout.max[0] + gap * 2, originZ = layout.min[2];
        let x = originX, z = originZ, rowDepth = 0, maxX = originX;
        for (const cluster of clusters) {
            const d = size(cluster.bounds);
            if (x > originX && x + d[0] > originX + rowWidth) { x = originX; z += rowDepth + gap; rowDepth = 0; }
            const delta: V3 = [x - cluster.bounds.min[0], this.ground - cluster.bounds.max[1], z - cluster.bounds.min[2]];
            this.slotPoses[cluster.id] = rigidDelta(delta);
            this.slotBounds[cluster.id] = shiftBox(cluster.bounds, delta);
            maxX = Math.max(maxX, this.slotBounds[cluster.id].max[0]);
            x += d[0] + gap;
            rowDepth = Math.max(rowDepth, d[2]);
        }
        const all = [...clusters.map(c => c.bounds), ...this.slotBounds].reduce(union);
        this.sceneBounds = union(model.bounds, { min: [layout.min[0], all.min[1], all.min[2]], max: [maxX, all.max[1], all.max[2]] });
        this.ceiling = Math.min(...clusters.map((c, i) => Math.min(c.bounds.min[1], this.slotBounds[i].min[1]))) - 32;
        this.oracle = new MeshOracle(model, stats, pulse);
    }

    private policyKey(a: string, b: string): string { return `${a.length}:${a}${b.length}:${b}`; }
    hasPolicy(a: string, b: string): boolean { return this.policyIndex.has(this.policyKey(a, b)); }
    policyFor(a: string, b: string): Connection | undefined { return this.policyIndex.get(this.policyKey(a, b))?.[0]; }
    addPolicies(connections: readonly Connection[], reverse = true): void {
        const add = (c: Connection) => {
            if (!c.region && !c.regions?.length && !c.surfaceTolerance) return;
            const key = this.policyKey(c.child, c.parent);
            const list = this.policyIndex.get(key) ?? [];
            // Axial policies are used for the final insertion segment too; the
            // region still bounds the allowance and all other material remains
            // exact.
            list.push({ ...c, axial: true });
            this.policyIndex.set(key, list);
        };
        for (const c of connections) {
            add(c);
            // Forward construction can seat either side of a connector. The
            // region is localized either way; only material inside it is
            // exempted and the rest of the sweep is exact.
            if (reverse) add({ ...c, child: c.parent, parent: c.child, outward: c.outward ? [-c.outward[0], -c.outward[1], -c.outward[2]] : undefined, axial: true });
        }
    }

    clusterBounds(id: ClusterId): Box { return transformBox(this.clusters[id].bounds, this.poses[id]); }
    leafPose(leaf: string): M4 { return multiply(this.poses[this.leafToCluster.get(leaf)!], this.leafFinal.get(leaf)!); }

    private otherClusters(moving: readonly number[], ignore?: ReadonlySet<number>): ClusterId[] {
        const out: ClusterId[] = [];
        for (let c = 0; c < this.clusters.length; c++) if (!moving.includes(c) && !ignore?.has(c)) out.push(c);
        return out;
    }

    /** Exact continuous translation certificate against every other cluster. */
    translationClear(moving: readonly number[], delta: V3, ignore?: ReadonlySet<number>, startPoses?: ReadonlyMap<number, M4>, first = false): ClearProof | null {
        this.pulse();
        let pairs = 0;
        for (const c of moving) {
            const startPose = startPoses?.get(c) ?? this.poses[c];
            const start = stagedBounds(this.clusters[c].bounds, startPose);
            const endPose = multiply(rigidDelta(delta), startPose);
            const end = stagedBounds(this.clusters[c].bounds, endPose);
            if (start.max[1] > this.ground + SKIN || end.max[1] > this.ground + SKIN) return null;
        }
        for (const c of moving) {
            const aPose = startPoses?.get(c) ?? this.poses[c];
            for (const o of this.otherClusters(moving, ignore)) {
                const bPose = this.poses[o];
                const aBox = stagedBounds(this.clusters[c].bounds, aPose), bBox = stagedBounds(this.clusters[o].bounds, bPose);
                if (!sweptOverlap(aBox, bBox, delta)) continue;
                for (const a of this.leavesByCluster[c]) {
                    const aLeaf = transformBox(this.model.parts.get(a)!.bounds, aPose);
                    if (!sweptOverlap(aLeaf, bBox, delta)) continue;
                    for (const b of this.leavesByCluster[o]) {
                        const bLeaf = transformBox(this.model.parts.get(b)!.bounds, bPose);
                        if (!sweptOverlap(aLeaf, bLeaf, delta)) continue;
                        pairs++;
                        (this.stats as V4Stats).translationPairs = ((this.stats as V4Stats).translationPairs ?? 0) + 1;
                        const policies = first ? this.policyIndex.get(`${a.length}:${a}${b.length}:${b}`) : undefined;
                        // Translation-only poses can use the base bodies with world
                        // offsets. This avoids rebuilding a posed mesh for every
                        // candidate and is the dominant fast path.
                        const flat = isIdentityOrientation(aPose) && isIdentityOrientation(bPose);
                        const clear = policies?.length
                            ? policies.some(p => flat
                                ? this.oracle.clear(a, b, pos(aPose), pos(bPose), delta, p)
                                : this.oracle.clearPosed(a, b, aPose, bPose, delta, p))
                            : flat
                                ? this.oracle.clear(a, b, pos(aPose), pos(bPose), delta)
                                : this.oracle.clearPosed(a, b, aPose, bPose, delta);
                        if (!clear) { this.lastFailure = { a, b, moving: moving.map(x => this.clusters[x].key), detail: this.oracle.lastFailure }; return null; }
                    }
                }
            }
        }
        (this.stats as V4Stats).translations = ((this.stats as V4Stats).translations ?? 0) + 1;
        return { pairs, detail: `${moving.length} cluster(s), translation` };
    }

    /** Conservative continuous arc certificate. `ignore` is used for a joint's own mating cluster. */
    arcClear(moving: readonly number[], pivot: V3, axis: V3, angle: number, ignore?: ReadonlySet<number>, startPoses?: ReadonlyMap<number, M4>): ClearProof | null {
        this.pulse();
        if (!Number.isFinite(angle) || Math.abs(angle) < 1e-9) return { pairs: 0, detail: 'zero arc' };
        const length = norm(axis);
        const u = axis.every(Number.isFinite) && length > 1e-9 ? (axis.map(v => v / length) as V3) : ZERO;
        if (norm(u) < 0.5) return null;
        for (const c of moving) {
            const box = stagedBounds(this.clusters[c].bounds, startPoses?.get(c) ?? this.poses[c]);
            let radius = 0;
            for (let i = 0; i < 8; i++) radius = Math.max(radius, norm(sub(boxCorner(box, i), pivot)));
            if (pivot[1] + radius > this.ground + SKIN) return null;
        }
        let pairs = 0;
        for (const c of moving) {
            const aPose = startPoses?.get(c) ?? this.poses[c];
            for (const o of this.otherClusters(moving, ignore)) {
                const bPose = this.poses[o];
                // Conservative whole-cluster sphere first.
                const ab = stagedBounds(this.clusters[c].bounds, aPose), bb = stagedBounds(this.clusters[o].bounds, bPose);
                let radius = 0;
                for (let i = 0; i < 8; i++) radius = Math.max(radius, norm(sub(boxCorner(ab, i), pivot)));
                const sphere = { min: sub(pivot, [radius, radius, radius]), max: add(pivot, [radius, radius, radius]) } as Box;
                if (!overlapsBox(sphere, bb)) continue;
                for (const a of this.leavesByCluster[c]) for (const b of this.leavesByCluster[o]) {
                    pairs++;
                    (this.stats as V4Stats).arcPairs = ((this.stats as V4Stats).arcPairs ?? 0) + 1;
                    if (this.oracle.annulusClear(a, b, aPose, bPose, pivot, u)) continue;
                    if (!this.oracle.arcClear(a, b, aPose, bPose, pivot, u, angle)) return null;
                }
            }
        }
        (this.stats as V4Stats).arcCertificates = ((this.stats as V4Stats).arcCertificates ?? 0) + 1;
        return { pairs, detail: `${moving.length} cluster(s), arc ${(angle * 180 / Math.PI).toFixed(1)}°` };
    }

    applyTranslation(moving: readonly number[], delta: V3): void {
        for (const c of moving) this.poses[c] = multiply(rigidDelta(delta), this.poses[c]);
    }
    applyArc(moving: readonly number[], pivot: V3, axis: V3, angle: number): void {
        const turn = rigidDelta(ZERO, pivot, axis, angle);
        for (const c of moving) this.poses[c] = multiply(turn, this.poses[c]);
    }
    stage(c: ClusterId): M4 {
        const previous = this.poses[c];
        this.poses[c] = [...this.slotPoses[c]] as M4;
        this.installed[c] = false;
        return previous;
    }
    restore(c: ClusterId, previousPose: M4): void {
        this.poses[c] = previousPose;
        this.installed[c] = true;
    }
    isStaged(c: ClusterId): boolean { return !this.installed[c]; }
    skyY(): number { return this.ceiling; }
    slotTop(c: ClusterId): number { return this.slotBounds[c].min[1]; }
}

function overlapsBox(a: Box, b: Box): boolean {
    return a.max[0] > b.min[0] && a.min[0] < b.max[0] && a.max[1] > b.min[1] && a.min[1] < b.max[1] && a.max[2] > b.min[2] && a.min[2] < b.max[2];
}
function sweptOverlap(a: Box, b: Box, delta: V3): boolean {
    const c: Box = { min: [Math.min(a.min[0], a.min[0] + delta[0]), Math.min(a.min[1], a.min[1] + delta[1]), Math.min(a.min[2], a.min[2] + delta[2])],
        max: [Math.max(a.max[0], a.max[0] + delta[0]), Math.max(a.max[1], a.max[1] + delta[1]), Math.max(a.max[2], a.max[2] + delta[2])] };
    return overlapsBox(c, b);
}
