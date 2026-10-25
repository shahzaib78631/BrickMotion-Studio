/**
 * V4 removal-route generation.
 *
 * A route is a sequence of world-rigid deltas from the authored pose to a
 * staging pose. It may start with a joint arc (hinge/rotor/axle), then a
 * certified translation into free space, a certified lift above the whole
 * scene, a transfer over the staging area, and a certified descent. Every
 * segment is checked by the exact oracle; proposals are never certificates.
 */
import { axisDirections, mul, multiply, norm, pos, rigidDelta, size, sub, unit, vector } from '../../math';
import type { M4, V3 } from '../../math';
import { stagedBounds } from '../../rigidStaging';
import type { V4Joint } from '../types';
import type { ClearProof, V4Scene } from '../scene/globalScene';

const ZERO: V3 = [0, 0, 0];
const UP: V3 = [0, -1, 0];
const DOWN: V3 = [0, 1, 0];

export type V4Route = {
    poses: M4[];
    proof: { kind: 'translation' | 'arc' | 'chain'; pairs: number; detail: string };
    articulated: boolean;
    pivot?: V3;
};

const distinct = (dirs: V3[]): V3[] => {
    const out: V3[] = [];
    for (const raw of dirs) {
        if (!raw.every(Number.isFinite) || norm(raw) < 1e-9) continue;
        const d = unit(raw);
        if (out.some(e => e[0] * d[0] + e[1] * d[1] + e[2] * d[2] > 1 - 1e-7)) continue;
        out.push(d);
    }
    return out;
};

function targetAtSlot(scene: V4Scene, cluster: number, from: M4): M4 {
    const box = stagedBounds(scene.clusters[cluster].bounds, from);
    const slot = scene.slotBounds[cluster];
    return multiply(rigidDelta([slot.min[0] - box.min[0], scene.ground - box.max[1], slot.min[2] - box.min[2]]), from);
}

/** Forward construction of a preassembled step module from a workbench pose. */
export function routeInstallSet(scene: V4Scene, ids: number[], stage: M4, extraDirections: readonly V3[], debug?: (message: string) => void): V4Route | null {
    const finalPose = rigidDelta(ZERO);
    const directions = distinct([
        ...extraDirections,
        UP,
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
    ]).slice(0, 16);
    const startBox = ids.map(c => stagedBounds(scene.clusters[c].bounds, stage)).reduce((a, b) => ({
        min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])] as V3,
        max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] as V3,
    }));
    const extent = Math.max(startBox.max[0] - startBox.min[0], startBox.max[1] - startBox.min[1], startBox.max[2] - startBox.min[2]);
    const distances = [12, Math.max(96, extent * 2)];
    const sky = scene.ceiling;
    const skyDelta: V3 = [0, sky - startBox.min[1], 0];
    const skyStart = multiply(rigidDelta(skyDelta), stage);
    const startPoses = new Map(ids.map(c => [c, stage]));
    const lift = scene.translationClear(ids, skyDelta, undefined, startPoses);
    if (!lift) { debug?.('group slot lift blocked'); return null; }
    for (const direction of directions) for (const distance of distances) {
        const entry = rigidDelta(mul(direction, distance));
        const entryBox = ids.map(c => stagedBounds(scene.clusters[c].bounds, entry)).reduce((a, b) => ({
            min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])] as V3,
            max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] as V3,
        }));
        if (entryBox.max[1] > scene.ground) continue;
        const aboveEntry = multiply(rigidDelta([0, sky - entryBox.min[1], 0]), entry);
        const overDelta: V3 = [pos(aboveEntry)[0] - pos(skyStart)[0], pos(aboveEntry)[1] - pos(skyStart)[1], pos(aboveEntry)[2] - pos(skyStart)[2]];
        const over = scene.translationClear(ids, overDelta, undefined, new Map(ids.map(c => [c, skyStart])));
        if (!over) { debug?.(`group transfer blocked ${direction.map(v => v.toFixed(2))}`); continue; }
        const downDelta: V3 = [pos(entry)[0] - pos(aboveEntry)[0], pos(entry)[1] - pos(aboveEntry)[1], pos(entry)[2] - pos(aboveEntry)[2]];
        const down = scene.translationClear(ids, downDelta, undefined, new Map(ids.map(c => [c, aboveEntry])));
        if (!down) { debug?.(`group descent blocked ${direction.map(v => v.toFixed(2))}`); continue; }
        const insertDelta: V3 = [-pos(entry)[0], -pos(entry)[1], -pos(entry)[2]];
        const insert = scene.translationClear(ids, insertDelta, undefined, new Map(ids.map(c => [c, finalPose])), true);
        if (!insert) { debug?.(`group insertion blocked ${direction.map(v => v.toFixed(2))}`); continue; }
        return {
            poses: [stage, skyStart, aboveEntry, entry, finalPose],
            proof: { kind: 'chain', pairs: lift.pairs + over.pairs + down.pairs + insert.pairs, detail: 'step module insertion' },
            articulated: false,
        };
    }
    return null;
}

/** Forward construction: move a staged cluster into its authored final pose. */
export function routeInstall(scene: V4Scene, cluster: number, joints: readonly V4Joint[], extraDirections: readonly V3[], debug?: (message: string) => void): V4Route | null {
    const slot = scene.slotPoses[cluster];
    const finalPose = multiply(rigidDelta(ZERO), rigidDelta(ZERO));
    const node = scene.model.parts.get(scene.clusters[cluster].leaves[0])!;
    const local = axisDirections(node.matrix);
    const incident = joints.filter(j => j.a === cluster || j.b === cluster);
    const directions = distinct([
        ...extraDirections,
        ...incident.map(j => j.axis), ...incident.map(j => mul(j.axis, -1)),
        UP,
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
        ...local,
    ]).slice(0, 16);
    const extent = Math.max(...size(scene.clusters[cluster].bounds));
    const distances = [12, Math.max(96, extent * 2)];
    const slotBox = stagedBounds(scene.clusters[cluster].bounds, slot);
    const sky = scene.ceiling;
    const skySlot = multiply(rigidDelta([0, sky - slotBox.min[1], 0]), slot);
    const lift = scene.translationClear([cluster], [0, sky - slotBox.min[1], 0], undefined, new Map([[cluster, slot]]));
    if (!lift) { debug?.('slot lift blocked'); return null; }
    const segments = (poses: M4[]): { poses: M4[]; pairs: number } | null => {
        const out = [slot, skySlot];
        let pairs = lift.pairs;
        let at = skySlot;
        for (const pose of poses) {
            const delta: V3 = [pos(pose)[0] - pos(at)[0], pos(pose)[1] - pos(at)[1], pos(pose)[2] - pos(at)[2]];
            // Insertion is the time reverse of a certified withdrawal. The
            // anchored surface certificate is defined at the final pose, so
            // check final -> entry and then play the segment backwards.
            const insertion = pose === finalPose;
            const proof = insertion
                ? scene.translationClear([cluster], [-delta[0], -delta[1], -delta[2]], undefined, new Map([[cluster, pose]]), true)
                : scene.translationClear([cluster], delta, undefined, new Map([[cluster, at]]), false);
            if (!proof) { debug?.(`segment blocked ${insertion ? 'insertion' : 'transfer'}: ${JSON.stringify(scene.lastFailure)?.slice(0, 260)}`); return null; }
            pairs += proof.pairs;
            out.push(pose);
            at = pose;
        }
        return { poses: out, pairs };
    };
    for (const direction of directions) {
        for (const distance of distances) {
            const entry = multiply(rigidDelta(mul(direction, distance)), finalPose);
            const entryBox = stagedBounds(scene.clusters[cluster].bounds, entry);
            if (entryBox.max[1] > scene.ground) continue;
            const aboveEntry = multiply(rigidDelta([0, sky - entryBox.min[1], 0]), entry);
            const result = segments([aboveEntry, entry, finalPose]);
            if (result) return { poses: result.poses, proof: { kind: 'translation', pairs: result.pairs, detail: 'authored-order insertion' }, articulated: false };
            debug?.(`install direction ${direction.map(v => v.toFixed(2))} distance ${distance}: blocked`);
        }
    }
    return null;
}

export function routeCluster(scene: V4Scene, cluster: number, joints: readonly V4Joint[], extraDirections: readonly V3[], debug?: (message: string) => void): V4Route | null {
    const start = scene.poses[cluster];
    const node = scene.model.parts.get(scene.clusters[cluster].leaves[0])!;
    const local = axisDirections(node.matrix);
    const incident = joints.filter(j => j.b === cluster && (j.kind === 'revolute' || j.kind === 'cylindrical' || j.kind === 'ball'));
    const directions = distinct([
        UP, DOWN,
        ...incident.map(j => j.axis), ...incident.map(j => mul(j.axis, -1)),
        ...extraDirections,
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0],
        ...local,
    ]).slice(0, 16);
    const extent = Math.max(...size(scene.clusters[cluster].bounds));
    const distances = [12, Math.max(64, extent * 2), Math.max(192, extent * 4)];

    const finish = (from: M4, prefix: M4[], prefixPoses: ClearProof | null, prefixArcs: ClearProof | null, firstIgnore?: ReadonlySet<number>, disengage = true): V4Route | null => {
        const target = targetAtSlot(scene, cluster, from);
        const targetBox = stagedBounds(scene.clusters[cluster].bounds, target);
        const sky = scene.ceiling;
        for (const direction of directions) {
            let entryFound = false;
            for (const distance of distances) {
                const delta = mul(direction, distance);
                const first = scene.translationClear([cluster], delta, firstIgnore, new Map([[cluster, from]]), disengage);
                if (!first) continue;
                entryFound = true;
                const entry = multiply(rigidDelta(delta), from);
                const entryBox = stagedBounds(scene.clusters[cluster].bounds, entry);
                const skyDelta: V3 = [0, sky - entryBox.min[1], 0];
                const skyPose = multiply(rigidDelta(skyDelta), entry);
                const lift = scene.translationClear([cluster], skyDelta, undefined, new Map([[cluster, entry]]));
                if (!lift) { debug?.(`direction ${direction.map(v => v.toFixed(2))} distance ${distance}: lift blocked`); continue; }
                const aboveTargetDelta: V3 = [pos(target)[0] - pos(skyPose)[0], 0, pos(target)[2] - pos(skyPose)[2]];
                const aboveTarget = multiply(rigidDelta(aboveTargetDelta), skyPose);
                const over = scene.translationClear([cluster], aboveTargetDelta, undefined, new Map([[cluster, skyPose]]));
                if (!over) { debug?.(`direction ${direction.map(v => v.toFixed(2))} distance ${distance}: transfer blocked`); continue; }
                // Descend from the sky lane to the target staging pose.
                const descent: V3 = [0, targetBox.min[1] - stagedBounds(scene.clusters[cluster].bounds, aboveTarget).min[1], 0];
                const down = scene.translationClear([cluster], descent, undefined, new Map([[cluster, aboveTarget]]));
                if (!down) { debug?.(`direction ${direction.map(v => v.toFixed(2))} distance ${distance}: descent blocked`); continue; }
                const poses = [...prefix, entry, skyPose, aboveTarget, multiply(rigidDelta(descent), aboveTarget)];
                const pairs = (prefixPoses?.pairs ?? 0) + (prefixArcs?.pairs ?? 0) + first.pairs + lift.pairs + over.pairs + down.pairs;
                return {
                    poses,
                    proof: { kind: prefixArcs ? 'chain' : 'translation', pairs, detail: `${poses.length - 1} certified segment(s)` },
                    articulated: !!prefixArcs,
                };

            }
            if (!entryFound) debug?.(`direction ${direction.map(v => v.toFixed(2))}: no clear entry (${distances.join(',')})`);
        }
        return null;
    };

    // 1. Straight removal first.
    const straight = finish(start, [start], null, null);
    if (straight) return straight;

    // 2. Articulate a joint child out of the way, then remove along a new pose.
    for (const joint of incident) {
        const ignore = new Set<number>([joint.a]);
        const angles = joint.kind === 'revolute'
            ? [Math.PI / 2, -Math.PI / 2, Math.PI / 3, -Math.PI / 3, Math.PI / 6, -Math.PI / 6]
            : [Math.PI / 4, -Math.PI / 4];
        for (const angle of angles) {
            if (angle < joint.min - 1e-6 || angle > joint.max + 1e-6) continue;
            const arc = scene.arcClear([cluster], joint.pivot, joint.axis, angle, ignore);
            if (!arc) { debug?.(`arc ${(angle * 180 / Math.PI).toFixed(0)}° blocked`); continue; }
            const turned = multiply(rigidDelta(ZERO, joint.pivot, joint.axis, angle), start);
            const route = finish(turned, [start, turned], null, arc, ignore, false);
            if (route) {
                route.pivot = [...joint.pivot] as V3;
                return route;
            }
        }
    }
    return null;
}
