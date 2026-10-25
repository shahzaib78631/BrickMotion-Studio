/**
 * Construction V4: global-scene, cluster-level, certified disassembly search.
 *
 * The planner decomposes the model into rigid clusters, builds a reverse
 * support order from the existing connection graph, and removes one cluster at
 * a time. A removal route may start with a joint arc. Every accepted segment is
 * checked by the exact mesh oracle against every other cluster, installed or
 * staged. There is no uncertified fallback.
 */
import { mul, multiply, norm, pos, rigidDelta, sub, union, unit } from '../math';
import { stagedBounds } from '../rigidStaging';
import type { M4, V3 } from '../math';
import { discoverConnections } from '../connections';
import { worldSnaps } from '../../snapMates';
import { buildMechanicalConstraintGraph } from '../mechanicalConstraintGraph';
import { possibleFinalContacts } from '../contactBroadphase';
import { ConstructionError, type Connection, type ConstructionModel, type Operation, type SearchStats } from '../types';
import { decomposeClusters } from './macro/decomposition';
import { buildJointGraph } from './kinematics/jointGraph';
import { V4Scene } from './scene/globalScene';
import { routeCluster, routeInstall, routeInstallSet } from './motion/route';
import type { V4Cluster, V4Options, V4Plan, V4Proof, V4Removal, V4Stats } from './types';

const ZERO: V3 = [0, 0, 0];
const SKIN = 0.02;

function finiteMs(value: number | undefined): number {
    if (value === undefined) return 300_000;
    if (!Number.isFinite(value) || value <= 0) throw new ConstructionError('invalid-input', 'V4 time budget must be finite and positive.');
    return Math.max(1_000, Math.min(300_000, Math.floor(value)));
}

function installedKey(installed: readonly boolean[]): string {
    let out = '';
    for (const v of installed) out += v ? '1' : '0';
    return out;
}

export function planConstructionV4(model: ConstructionModel, options: V4Options = {}): V4Plan {
    const start = performance.now();
    const stats: V4Stats = {
        states: 0, candidates: 0, backtracks: 0, meshPairs: 0, trianglePairs: 0, cacheHits: 0, milliseconds: 0,
        clusters: 0, joints: 0, modules: 0, actions: 0, translations: 0, translationPairs: 0,
        arcCertificates: 0, arcPairs: 0, articulatedCandidates: 0, supportRejects: 0, stagingRoutes: 0, groupRemovals: 0, peakInstalled: 0,
    };
    const maxMs = finiteMs(options.maxMilliseconds);
    const maxStates = Math.max(1, Math.min(100_000, options.maxStates ?? 20_000));
    const maxActions = Math.max(1, Math.min(1_000_000, options.maxActions ?? 200_000));
    const maxTranslationPairs = Math.max(1, Math.min(50_000_000, options.maxTranslationPairs ?? 8_000_000));
    const maxArcPairs = Math.max(1, Math.min(20_000_000, options.maxArcPairs ?? 2_000_000));
    let scope = '$root', phase: 'connections' | 'disassembly' | 'validation' = 'connections';
    const pulse = () => {
        stats.milliseconds = Math.round(performance.now() - start);
        if (options.cancelled?.()) throw new ConstructionError('cancelled', 'Construction V4 was cancelled.', { scope, phase, stats: { ...stats } });
        if (stats.milliseconds > maxMs || stats.states > maxStates || (stats.actions ?? 0) > maxActions ||
            (stats.translationPairs ?? 0) > maxTranslationPairs || (stats.arcPairs ?? 0) > maxArcPairs)
            throw new ConstructionError('search-budget-exhausted', 'The V4 search did not finish. This does not establish physical impossibility.', { scope, phase, stats: { ...stats } });
    };
    options.onProgress?.({ phase: 'connections', completed: 0, total: model.parts.size });
    pulse();

    const { clusters, leafToCluster } = decomposeClusters(model);
    stats.clusters = clusters.length;
    stats.modules = clusters.filter(c => c.module !== 'part').length;
    const mechanical = buildMechanicalConstraintGraph(model);
    const joints = buildJointGraph(mechanical, leafToCluster);
    stats.joints = joints.length;
    // Every inferred joint gets a localized motion policy. It is oriented from
    // the moving connector to its mate: a stud withdraws its female socket, a
    // pin/axle withdraws the male shaft. The region is only the connector
    // material; the first segment is still bounded and the remainder exact.
    const jointPolicies: Connection[] = [];
    for (const j of mechanical.joints) {
        if (!j.region) continue;
        const movingIsMale = j.type !== 'stud-socket';
        const parent = movingIsMale ? j.female : j.male;
        const child = movingIsMale ? j.male : j.female;
        jointPolicies.push({
            id: `v4-joint:${j.type}:${child}:${parent}`,
            parent, child, kind: 'mechanical', confidence: 'inferred',
            outward: [-j.axis[0], -j.axis[1], -j.axis[2]],
            region: j.region,
            axial: movingIsMale && (j.type === 'pin-hole' || j.type === 'axle-hole' || j.type === 'cylindrical'),
        });
    }

    const graph = discoverConnections(model);
    const children = clusters.map(() => new Set<number>());
    const neighbours = clusters.map(() => new Set<number>());
    const directions = clusters.map(() => [] as V3[]);
    const addDirection = (c: number, v: V3 | undefined) => {
        if (!v || !v.every(Number.isFinite) || norm(v) < 1e-9) return;
        directions[c].push(unit(v));
    };
    for (const d of graph.dependencies) {
        const a = leafToCluster.get(d.parent), b = leafToCluster.get(d.child);
        if (a === undefined || b === undefined || a === b) continue;
        children[a].add(b);
    }
    for (const c of graph.connections) {
        const a = leafToCluster.get(c.parent), b = leafToCluster.get(c.child);
        if (a === undefined || b === undefined || a === b) continue;
        if (c.kind !== 'surface' && !c.staticOnly) { neighbours[a].add(b); neighbours[b].add(a); }
        if (c.outward) { addDirection(a, c.outward); addDirection(b, mul(unit(c.outward), -1)); }
    }
    for (const j of joints) {
        addDirection(j.a, j.axis); addDirection(j.a, mul(j.axis, -1));
        addDirection(j.b, j.axis); addDirection(j.b, mul(j.axis, -1));
    }
    for (const node of model.parts.values()) {
        const c = leafToCluster.get(node.id);
        if (c === undefined) continue;
        addDirection(c, node.hints?.insertionAxis);
        // LDCad snaps are the only source of tilted pin/clip/axle axes on parts
        // that the pairwise mechanical matcher could not pair.
        if (node.part) for (const snap of worldSnaps(model.metrics(node.part).snaps, node.matrix)) {
            addDirection(c, snap.axis);
            addDirection(c, mul(unit(snap.axis), -1));
        }
        // The part's own axes are useful for tilted / side-mounted pieces.
        for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]) {
            const v = [node.matrix[0] * axis[0] + node.matrix[4] * axis[1] + node.matrix[8] * axis[2],
                node.matrix[1] * axis[0] + node.matrix[5] * axis[1] + node.matrix[9] * axis[2],
                node.matrix[2] * axis[0] + node.matrix[6] * axis[1] + node.matrix[10] * axis[2]] as V3;
            addDirection(c, v); addDirection(c, mul(v, -1));
        }
    }

    const scene = new V4Scene(model, clusters, joints, leafToCluster, stats, pulse, [...jointPolicies, ...graph.connections], options.layoutBounds);
    const removals: V4Removal[] = [];
    const failed = new Set<string>();
    const maxCandidatesPerState = Math.max(1, Math.min(512, options.maxCandidatesPerState ?? 64));
    const maxGroupLeaves = Math.max(2, Math.min(256, options.maxGroupLeaves ?? 64));
    let budgetExceeded = false;

    // Final-pose surface audit: authored LDraw geometry has shallow render
    // overlaps at seams that are not connector contacts. Measure each one,
    // record a pose-anchored certificate, and use the measured withdrawal
    // direction for insertion. Deep penetration is never exempted.
    let finalSurfaceContacts = 0, unresolvedFinalContacts = 0;
    const unresolvedPairs: string[] = [];
    for (const [a, b] of possibleFinalContacts([...model.parts.values()])) {
        const ca = leafToCluster.get(a.id), cb = leafToCluster.get(b.id);
        if (ca === undefined || cb === undefined || ca === cb) continue;
        // Retain any connector certificate while measuring the residual
        // surface overlap. A connector explains only part of the final contact
        // (the V3 audit makes the same distinction).
        const existing = scene.policyFor(a.id, b.id);
        const anchor = sub(pos(a.matrix) as V3, pos(b.matrix) as V3);
        // Authored pose-fit rules (e.g. the 4592/4593 control-stick hinge)
        // carry a measured tolerance but no anchor. Anchoring it at this exact
        // final pose makes it usable for the final insertion/withdrawal without
        // granting any motion allowance elsewhere.
        const anchored = existing?.surfaceTolerance && !existing.surfaceAnchor ? { ...existing, surfaceAnchor: anchor } : existing;
        const tolerance = Math.max(4.2, existing?.surfaceTolerance ?? 0);
        const result = scene.oracle.staticContact(a.id, b.id, anchored, tolerance);
        const bare = result.kind === 'connector' ? scene.oracle.staticContact(a.id, b.id, undefined, tolerance) : result;
        const measured = bare.kind === 'surface' && bare.separation && norm(bare.separation) > 1e-4 ? bare.separation : undefined;
        if (measured) {
            const d = unit(measured), length = Math.max(norm(measured) + 0.05, existing?.surfaceTolerance ?? 0);
            scene.addPolicies([
                { id: `v4-surface:${a.id}:${b.id}:out`, parent: b.id, child: a.id, kind: 'surface', confidence: 'inferred', outward: d, surfaceTolerance: length, surfaceAnchor: anchor },
                { id: `v4-surface:${a.id}:${b.id}:in`, parent: b.id, child: a.id, kind: 'surface', confidence: 'inferred', outward: mul(d, -1), surfaceTolerance: length, surfaceAnchor: anchor },
                { id: `v4-surface:${b.id}:${a.id}:out`, parent: a.id, child: b.id, kind: 'surface', confidence: 'inferred', outward: mul(d, -1), surfaceTolerance: length, surfaceAnchor: mul(anchor, -1) },
                { id: `v4-surface:${b.id}:${a.id}:in`, parent: a.id, child: b.id, kind: 'surface', confidence: 'inferred', outward: d, surfaceTolerance: length, surfaceAnchor: mul(anchor, -1) },
            ], false);
            addDirection(ca, mul(d, -1));
            addDirection(cb, d);
            finalSurfaceContacts++;
        } else if (result.kind === 'penetration' || result.kind === 'unresolved') {
            unresolvedFinalContacts++;
            unresolvedPairs.push(`${a.part ?? '?'} ${a.id} / ${b.part ?? '?'} ${b.id}: ${result.kind}`);
        }
    }
    stats.finalSurfaceContacts = finalSurfaceContacts;
    stats.unresolvedFinalContacts = unresolvedFinalContacts;
    if (unresolvedFinalContacts > 0) {
        throw new ConstructionError('unresolved-final-contact',
            `Construction V4 found ${unresolvedFinalContacts} final-pose contact(s) it cannot explain with a connector or a measured surface certificate.`,
            { scope, phase: 'final-contact-audit', items: unresolvedPairs.slice(0, 64), stats: { ...stats } });
    }

    const supportOf = (c: number): Operation['check']['support'] => {
        const table = Math.abs(clusters[c].bounds.max[1] - scene.ground) <= SKIN;
        if (table) return 'table';
        const attached = [...neighbours[c]].some(o => scene.installed[o]) ||
            joints.some(j => (j.a === c && scene.installed[j.b]) || (j.b === c && scene.installed[j.a]));
        return attached ? 'connected' : options.supportMode === 'table' ? 'table' : 'virtual-fixture';
    };

    // Primary strategy: exact forward construction in authored step/order. The
    // authored hierarchy already encodes a feasible build order; checking each
    // insertion from the staging area is far cheaper than proving a complete
    // interlocked model can be disassembled top-down.
    type ForwardOp = { clusters: number[]; poses: M4[]; proof: V4Proof; support: Operation['check']['support']; staged: M4 };
    const forwardOps: ForwardOp[] = [];
    let forwardOk = true;
    const steps = [...new Set(clusters.map(c => c.step))].sort((a, b) => a - b);
    const byStep = new Map<number, number[]>(steps.map(s => [s, []]));
    for (const c of clusters) byStep.get(c.step)!.push(c.id);
    for (const ids of byStep.values()) ids.sort((a, b) => clusters[b].bounds.max[1] - clusters[a].bounds.max[1] || clusters[a].order - clusters[b].order || a - b);
    // Workbench poses for step modules: preserve the final relative layout and
    // park the module on a staging lane outside the model.
    const groupStage = new Map<number, M4>();
    const laneX = scene.sceneBounds.max[0] + 400;
    const laneWidth = Math.max(2_000, Math.sqrt(clusters.reduce((n, c) => n + (c.bounds.max[0] - c.bounds.min[0] + 48) * (c.bounds.max[2] - c.bounds.min[2] + 48), 0)) * 1.25);
    let cursorX = laneX, cursorZ = scene.sceneBounds.min[2], rowDepth = 0;
    for (const step of steps) {
        const ids = byStep.get(step)!;
        if (ids.length < 2) continue;
        const box = ids.map(c => clusters[c].bounds).reduce((a, b) => ({
            min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])] as V3,
            max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] as V3,
        }));
        const w = box.max[0] - box.min[0], d = box.max[2] - box.min[2];
        if (cursorX > laneX && cursorX + w > laneX + laneWidth) { cursorX = laneX; cursorZ += rowDepth + 48; rowDepth = 0; }
        groupStage.set(step, rigidDelta([cursorX - box.min[0], scene.ground - box.max[1], cursorZ - box.min[2]]));
        cursorX += w + 48; rowDepth = Math.max(rowDepth, d);
    }
    scene.installed.fill(false);
    for (const c of clusters) {
        const stage = groupStage.get(c.step);
        scene.poses[c.id] = stage ? ([...stage] as M4) : ([...scene.slotPoses[c.id]] as M4);
    }
    const forwardComponents = (ids: number[]): number[][] => {
        if (ids.length < 2) return [ids];
        const boxes = ids.map(c => clusters[c].bounds);
        const parent = ids.map((_, i) => i);
        const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.max[0] + 24 > b.min[0] && b.max[0] + 24 > a.min[0] &&
                a.max[1] + 24 > b.min[1] && b.max[1] + 24 > a.min[1] &&
                a.max[2] + 24 > b.min[2] && b.max[2] + 24 > a.min[2]) {
                const x = find(i), y = find(j); if (x !== y) parent[y] = x;
            }
        }
        const groups = new Map<number, number[]>();
        ids.forEach((c, i) => { const k = find(i); const list = groups.get(k) ?? []; list.push(c); groups.set(k, list); });
        return [...groups.values()].filter(g => g.length >= 2).sort((a, b) => b.length - a.length);
    };

    const installStep = (step: number): boolean => {
        const ids = byStep.get(step)!.filter(c => !scene.installed[c]);
        if (!ids.length) return true;
        const stage = groupStage.get(step) ?? scene.slotPoses[ids[0]];
        const debug = options.debugCluster === `step:${step}` ? (m: string) => console.log(`[v4 step:${step}] ${m}`) : undefined;
        const begin = forwardOps.length;
        const whole = routeInstallSet(scene, ids, stage, ids.flatMap(c => directions[c]), debug);
        if (whole) {
            for (const c of ids) { scene.installed[c] = true; scene.poses[c] = rigidDelta(ZERO); }
            forwardOps.push({ clusters: [...ids], poses: whole.poses, proof: whole.proof, support: 'virtual-fixture', staged: stage });
            stats.groupRemovals = (stats.groupRemovals ?? 0) + 1;
            return true;
        }
        let remaining = [...ids];
        for (const component of forwardComponents(remaining)) {
            const route = routeInstallSet(scene, component, stage, component.flatMap(c => directions[c]), debug);
            if (!route) continue;
            for (const c of component) { scene.installed[c] = true; scene.poses[c] = rigidDelta(ZERO); }
            forwardOps.push({ clusters: component, poses: route.poses, proof: route.proof, support: 'virtual-fixture', staged: stage });
            stats.groupRemovals = (stats.groupRemovals ?? 0) + 1;
            remaining = remaining.filter(c => !scene.installed[c]);
        }
        if (remaining.length) {
            const route = routeInstallSet(scene, remaining, stage, remaining.flatMap(c => directions[c]), debug);
            if (route) {
                for (const c of remaining) { scene.installed[c] = true; scene.poses[c] = rigidDelta(ZERO); }
                forwardOps.push({ clusters: [...remaining], poses: route.poses, proof: route.proof, support: 'virtual-fixture', staged: stage });
                stats.groupRemovals = (stats.groupRemovals ?? 0) + 1;
                remaining = [];
            }
        }
        if (!remaining.length) return true;
        // Undo partial installs from this attempt.
        while (forwardOps.length > begin) {
            const op = forwardOps.pop()!;
            for (const c of op.clusters) { scene.installed[c] = false; scene.poses[c] = [...op.staged] as M4; }
            if (op.poses.length) stats.groupRemovals = Math.max(0, (stats.groupRemovals ?? 1) - 1);
        }
        return false;
    };

    const stepFailed = new Set<string>();
    let stepNodes = 0;
    const stepLimit = Math.max(120, Math.min(800, steps.length * 24));
    const forwardDeadline = start + Math.min(maxMs * 0.45, 120_000);
    let forwardTimedOut = false;
    const goSteps = (pendingSteps: number[]): boolean => {
        pulse();
        if (performance.now() > forwardDeadline) { forwardTimedOut = true; return false; }
        if (!pendingSteps.length) return true;
        const key = [...pendingSteps].sort((a, b) => a - b).join(',');
        if (stepFailed.has(key)) return false;
        if (++stepNodes > stepLimit) return false;
        for (const step of pendingSteps) {
            const before = forwardOps.length;
            if (installStep(step) && goSteps(pendingSteps.filter(s => s !== step))) return true;
            while (forwardOps.length > before) {
                const op = forwardOps.pop()!;
                for (const c of op.clusters) { scene.installed[c] = false; scene.poses[c] = [...op.staged] as M4; }
            }
        }
        stepFailed.add(key);
        return false;
    };
    forwardOk = goSteps(steps);
    if (!forwardOk) stats.forwardFailure = forwardTimedOut ? 'forward-budget' : 'step-order';
    stats.actions = forwardOps.length;
    stats.deepest = Math.max(stats.deepest ?? 0, forwardOps.reduce((n, op) => n + op.clusters.length, 0));
    if (!forwardOk) {
        scene.installed.fill(true);
        for (let i = 0; i < clusters.length; i++) scene.poses[i] = rigidDelta(ZERO);
        stats.actions = 0; stats.stagingRoutes = 0; stats.groupRemovals = 0; stats.deepest = 0;
    }

    const ordered = (pool: number[]): number[] => pool.sort((a, b) => {
        const ma = clusters[a].module !== 'part' ? 0 : 1, mb = clusters[b].module !== 'part' ? 0 : 1;
        return ma - mb || clusters[b].step - clusters[a].step || clusters[b].order - clusters[a].order || a - b;
    });

    const attempt = (c: number, support: Operation['check']['support']): boolean => {
        stats.candidates++;
        options.onProgress?.({ phase: 'disassembly', completed: removals.length, total: clusters.length, item: clusters[c].key });
        const debug = options.debugCluster === clusters[c].key ? (message: string) => console.log(`[v4 ${clusters[c].key}] ${message}`) : undefined;
        const route = routeCluster(scene, c, joints, directions[c], debug);
        if (!route) return false;
        const previousPose = scene.poses[c];
        scene.installed[c] = false;
        scene.poses[c] = route.poses[route.poses.length - 1];
        removals.push({ clusters: [c], poses: route.poses, proof: route.proof, support, articulated: route.articulated, ...(route.pivot ? { pivot: route.pivot } : {}) });
        stats.deepest = Math.max(stats.deepest ?? 0, removals.length);
        stats.actions = (stats.actions ?? 0) + 1;
        stats.stagingRoutes = (stats.stagingRoutes ?? 0) + 1;
        if (route.articulated) stats.articulatedCandidates = (stats.articulatedCandidates ?? 0) + 1;
        if (solve()) return true;
        removals.pop();
        scene.poses[c] = previousPose;
        scene.installed[c] = true;
        return false;
    };

    const tryGroup = (ids: number[], label: string): boolean => {
        if (options.supportMode === 'table' || ids.length < 2) return false;
        const leaves = ids.reduce((n, c) => n + clusters[c].leaves.length, 0);
        if (leaves > maxGroupLeaves) return false;
        const box = ids.map(c => scene.clusterBounds(c)).reduce((a, b) => ({
            min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])] as V3,
            max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] as V3,
        }));
        const extent = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
        const debug = options.debugCluster === 'group' ? (m: string) => console.log(`[v4 group] ${label} ${m}`) : undefined;
        debug?.(`try ${leaves} leaves, box ${box.min.map(v => v.toFixed(0))}/${box.max.map(v => v.toFixed(0))}`);
        const pivot: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
        const rotations: { angle: number; pose: M4; pivot: V3 }[] = [{ angle: 0, pose: rigidDelta(ZERO), pivot }];
        const angles = [Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI / 4, Math.PI / 4, -Math.PI / 6, Math.PI / 6];
        for (const angle of angles) {
            const pose = rigidDelta(ZERO, pivot, [0, 1, 0], angle);
            if (scene.arcClear(ids, pivot, [0, 1, 0], angle)) rotations.push({ angle, pose, pivot });
        }
        // Snap clips and hinges may need to be rolled off their own bar/pin,
        // not spun about the arbitrary layer centre.
        const seenAxes = new Set<string>();
        const memberJoints = leaves <= 12 ? joints.filter(j => ids.includes(j.a) || ids.includes(j.b)).slice(0, 2) : [];
        for (const joint of memberJoints) {
            const key = `${joint.pivot.map(v => v.toFixed(1)).join(',')}:${joint.axis.map(v => v.toFixed(2)).join(',')}`;
            if (seenAxes.has(key)) continue;
            seenAxes.add(key);
            for (const angle of [Math.PI / 2, -Math.PI / 2, Math.PI]) {
                if (scene.arcClear(ids, joint.pivot, joint.axis, angle)) rotations.push({ angle, pose: rigidDelta(ZERO, joint.pivot, joint.axis, angle), pivot: joint.pivot });
            }
        }
        for (const rotation of rotations) {
            const startPoses = new Map(ids.map(c => [c, multiply(rotation.pose, scene.poses[c])]));
            const turnedBox = rotation.angle === 0 ? box : ids.map(c => stagedBounds(clusters[c].bounds, startPoses.get(c)!)).reduce((a, b) => ({
                min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])] as V3,
                max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] as V3,
            }));
            const candidates: V3[] = [
                [0, scene.ceiling - turnedBox.min[1], 0],
                [extent * 2 + 32, 0, 0], [-(extent * 2 + 32), 0, 0],
                [0, 0, extent * 2 + 32], [0, 0, -(extent * 2 + 32)],
            ];
            for (const delta of candidates) {
                stats.candidates++;
                // The first segment may disengage the group's own connectors; the
                // localized policy is pair-specific and the rest of the sweep is
                // still exact.
                const proof = scene.translationClear(ids, delta, undefined, startPoses, true);
                if (!proof) { debug?.(`rot ${(rotation.angle * 180 / Math.PI).toFixed(0)} delta ${delta.map(v => v.toFixed(0))}: blocked`); continue; }
                debug?.(`rot ${(rotation.angle * 180 / Math.PI).toFixed(0)} delta ${delta.map(v => v.toFixed(0))}: clear`);
                const end = multiply(rigidDelta(delta), rotation.pose);
                const previous = ids.map(c => scene.poses[c]);
                for (const c of ids) { scene.installed[c] = false; scene.poses[c] = end; }
                const poses = rotation.angle === 0 ? [rigidDelta(ZERO), end] : [rigidDelta(ZERO), rotation.pose, end];
                removals.push({ clusters: [...ids], poses, proof: { kind: rotation.angle === 0 ? 'translation' : 'chain', pairs: proof.pairs, detail: `${label}, ${leaves} part(s)${rotation.angle ? ', layer turn' : ''}` }, support: 'virtual-fixture', ...(rotation.angle ? { pivot: rotation.pivot } : {}) });
                stats.deepest = Math.max(stats.deepest ?? 0, removals.length);
                stats.actions = (stats.actions ?? 0) + 1;
                stats.groupRemovals = (stats.groupRemovals ?? 0) + 1;
                if (solve()) return true;
                removals.pop();
                ids.forEach((c, i) => { scene.installed[c] = true; scene.poses[c] = previous[i]; });
            }
        }
        return false;
    };

    const spatialComponents = (ids: number[]): number[][] => {
        if (ids.length < 2) return [ids];
        const boxes = ids.map(c => scene.clusterBounds(c));
        const parent = ids.map((_, i) => i);
        const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const gap = 24;
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
            const a = boxes[i], b = boxes[j];
            const touch = a.max[0] + gap > b.min[0] && b.max[0] + gap > a.min[0] &&
                a.max[1] + gap > b.min[1] && b.max[1] + gap > a.min[1] &&
                a.max[2] + gap > b.min[2] && b.max[2] + gap > a.min[2];
            if (touch) { const x = find(i), y = find(j); if (x !== y) parent[y] = x; }
        }
        const groups = new Map<number, number[]>();
        ids.forEach((c, i) => { const k = find(i); const list = groups.get(k) ?? []; list.push(c); groups.set(k, list); });
        return [...groups.values()].filter(g => g.length >= 2).sort((a, b) => b.length - a.length);
    };

    const attemptLayerGroups = (present: number[], maxBands = 8): boolean => {
        const steps = [...new Set(present.map(c => clusters[c].step))].sort((a, b) => b - a);
        for (let band = 0; band < Math.min(maxBands, steps.length); band++) {
            const ids = present.filter(c => steps.slice(0, band + 1).includes(clusters[c].step));
            for (const component of spatialComponents(ids)) {
                if (tryGroup(component, `spatial layer ${steps[0]}..${steps[band]}`)) return true;
            }
            if (tryGroup(ids, `authored layer ${steps[0]}..${steps[band]}`)) return true;
        }
        return false;
    };

    const solve = (): boolean => {
        pulse();
        if (!scene.installed.some(Boolean)) return true;
        stats.states++;
        const key = installedKey(scene.installed);
        if (failed.has(key)) { stats.backtracks++; return false; }
        phase = 'disassembly';
        const present = clusters.filter(c => scene.installed[c.id]).map(c => c.id);
        const ready = present.filter(c => ![...children[c]].some(o => scene.installed[o]));
        // Authored top layers are coherent subassemblies. Extracting a layer or
        // a spatial component of it first is both cheaper and closer to how the
        // model was authored; it is fully certified and held if necessary.
        if (attemptLayerGroups(present, 2)) return true;
        // Modules next: a preformed subassembly (underside, hose, wheel) is a
        // physically coherent unit and can often be extracted even while its
        // authored children are still present. It is held if necessary.
        const modules = ordered(present.filter(c => clusters[c].module !== 'part'));
        for (const c of modules.slice(0, Math.max(1, maxCandidatesPerState >> 2))) {
            const support = ready.includes(c) ? supportOf(c) : 'virtual-fixture';
            if (attempt(c, support)) return true;
        }
        // Top-down: a part cannot be pulled through the children it supports.
        for (const c of ordered([...ready]).slice(0, maxCandidatesPerState)) {
            const support = supportOf(c);
            if (support === 'table' && options.supportMode === 'table' && Math.abs(scene.clusterBounds(c).max[1] - scene.ground) > SKIN && ![...neighbours[c]].some(o => scene.installed[o])) {
                stats.supportRejects = (stats.supportRejects ?? 0) + 1;
                continue;
            }
            if (attempt(c, support)) return true;
        }
        // A held-workpiece fallback: if every ready part is trapped, a parent
        // module may be removed while its children are held. This is the
        // underside/authoring case; the certificate still checks all geometry.
        if (options.supportMode !== 'table') {
            const blocked = present.filter(c => !ready.includes(c));
            for (const c of ordered([...blocked]).slice(0, maxCandidatesPerState)) {
                if (attempt(c, 'virtual-fixture')) return true;
            }
        }
        if (attemptLayerGroups(present, 8)) return true;
        if (tryGroup(present, 'held remaining workpiece')) return true;
        failed.add(key);
        stats.backtracks++;
        if (failed.size > 60_000) failed.clear();
        return false;
    };

    let solved = forwardOk;
    if (!forwardOk) try { solved = solve(); }
    catch (error) {
        const failure = error as ConstructionError;
        budgetExceeded = error instanceof ConstructionError && (failure.code === 'search-budget-exhausted' || failure.code === 'cancelled');
        if (error instanceof ConstructionError) {
            const remaining = clusters.filter(c => scene.installed[c.id]);
            stats.remainingUnits = remaining.length;
            stats.remainingByStep = Object.fromEntries([...new Set(remaining.map(c => c.step))].sort((a, b) => a - b)
                .map(step => [String(step), remaining.filter(c => c.step === step).length]));
            error.details.stats = { ...stats };
            error.details.items = [...remaining]
                .sort((a, b) => b.step - a.step || b.order - a.order || a.key.localeCompare(b.key))
                .map(c => c.key).slice(0, 64);
        }
        throw error;
    }
    if (!solved) {
        throw new ConstructionError(budgetExceeded ? 'search-budget-exhausted' : 'no-supported-rigid-route',
            `Construction V4 could not certify every cluster. ${removals.length}/${clusters.length} removed.`,
            { scope, phase, items: clusters.filter(c => scene.installed[c.id]).map(c => c.key).slice(0, 32), stats: { ...stats } });
    }
    phase = 'validation';
    pulse();
    stats.milliseconds = Math.round(performance.now() - start);

    const staged = new Map<number, M4>();
    let sceneBounds = scene.sceneBounds;
    let removalMeta: V4Removal[] = removals;
    const operations: Operation[] = [];
    let previousId: string | undefined;
    if (forwardOk) {
        for (const insertion of forwardOps) {
            const cluster = clusters[insertion.clusters[0]];
            const id = `construct:${cluster.key}`;
            for (const c of insertion.clusters) {
                staged.set(c, insertion.staged);
                sceneBounds = union(sceneBounds, stagedBounds(clusters[c].bounds, insertion.staged));
            }
            const op: Operation = {
                id, kind: insertion.clusters.length > 1 || cluster.module !== 'part' ? 'attach-subassembly' : 'place',
                keys: insertion.clusters.flatMap(c => clusters[c].leaves), scope: '$root', model: cluster.model, step: cluster.step,
                requires: previousId ? [previousId] : [], connections: [],
                path: insertion.poses.map(p => pos(p) as V3), rigidPath: insertion.poses.map(p => [...p] as M4),
                check: { method: 'continuous-triangle-sat', contactPolicies: [], support: insertion.support },
            };
            operations.push(op);
            previousId = id;
        }
        removalMeta = forwardOps.slice().reverse().map(op => ({
            clusters: [...op.clusters], poses: [...op.poses].reverse(), proof: op.proof,
            support: op.support,
        }));
    } else {
        for (const r of removals) for (const c of r.clusters) {
            const end = r.poses[r.poses.length - 1];
            staged.set(c, end);
            sceneBounds = union(sceneBounds, stagedBounds(clusters[c].bounds, end));
        }
        for (const removal of [...removals].reverse()) {
            const cluster = clusters[removal.clusters[0]];
            const poses = [...removal.poses].reverse();
            const id = `construct:${cluster.key}`;
            const keys = removal.clusters.flatMap(c => clusters[c].leaves);
            const op: Operation = {
                id, kind: removal.clusters.length > 1 || cluster.module !== 'part' ? 'attach-subassembly' : 'place',
                keys, scope: '$root', model: cluster.model, step: cluster.step,
                requires: previousId ? [previousId] : [], connections: [],
                path: poses.map(p => pos(p) as V3), rigidPath: poses.map(p => [...p] as M4),
                ...(removal.pivot ? { pivot: removal.pivot } : {}),
                check: { method: 'continuous-triangle-sat', contactPolicies: [], support: removal.support },
            };
            operations.push(op);
            previousId = id;
        }
    }

    const parts = [...model.parts.values()].map(node => {
        const c = leafToCluster.get(node.id)!;
        return { key: node.id, part: node.part!, final: [...node.matrix] as M4, staged: multiply(staged.get(c)!, node.matrix), bounds: node.bounds };
    });
    const warnings = [
        'Construction V4 plans one global scene of rigid clusters and certifies every translation and arc against every installed or staged cluster. There is no uncertified fallback.',
        'Support and fixture handling are topological, not a gravity or physical-stability simulation.',
        'Mechanism joints use measured connector axes; a hinge/arc certificate is continuous but conservative, so a safe tight turn can be reported as unproven.',
    ];
    if (clusters.some(c => c.module === 'hose'))
        warnings.push('Flexible hose render segments are merged into preformed rigid units. Bending, straightening or manufacturing the hose is not simulated.');
    if (joints.some(j => j.kind === 'gear'))
        warnings.push('Gear couplings are kinematic hints with declared interface regions; physical tooth contact is not simulated.');
    const plan: V4Plan = {
        schema: 'brickmotion-construction/v2',
        operations,
        parts,
        connections: graph.connections,
        dependencies: graph.dependencies,
        warnings,
        stats: { ...stats } as SearchStats,
        ground: scene.ground,
        bounds: model.bounds,
        sceneBounds,
        capabilities: { rigidTranslation: true, rigidRotation: true, hierarchicalSubassemblies: true, articulation: true, deformation: false, physicalStability: false },
        v4: { clusters, joints, removals: removalMeta, stats },
    };
    return plan;
}
