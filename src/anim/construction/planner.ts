import type { Box } from '../../ldraw/flatten';
import { add, sub, mul, norm, unit, dot, vector, axisDirections, shiftBox, union, size, sweptBox, overlaps, centre, rigidDelta, pos, point, multiply } from './math';
import type { V3, M4 } from './math';
import { fixedBayPose, isIdentityOrientation, oracleOffsets, poseMoved, poseWithCentreAndYaw, sameOrientation, stagedBounds, turningSphere, yawOf } from './rigidStaging';
import { discoverConnections } from './connections';
import { assemblyRole } from '../assemblyGraph';
import { MeshOracle, SKIN } from './collision';
import { mechanicalSubassemblies } from './subassemblies';
import { ConstructionError, type ConstructionModel, type ConstructionNode, type ConstructionPlan, type ConstructionOptions, type Blockage, type Operation, type SearchStats, type Connection } from './types';
type Slot = {
    id: string;
    pose: M4;
    box: Box;
};
type Removal = {
    node: ConstructionNode;
    poses: M4[];
    connections: string[];
    support: Operation['check']['support'];
};
type RouteResult = { poses: M4[] };
const ZERO: V3 = [0, 0, 0], AXES: V3[] = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const unique = (v: V3[]) => v.filter((d, i) => !v.slice(0, i).some(e => dot(d, e) > 1 - 1e-10));
const owns = (node: ConstructionNode, id: string): boolean => node.id === id || node.leaves.includes(id) || !!node.children?.some(n => owns(n, id));
const compactPoses = (poses: M4[]) => poses.filter((p, i) => !i || p.some((v, k) => Math.abs(v - poses[i - 1][k]) > 1e-9));
function positive(value: number | undefined, fallback: number, max: number): number { if (value === undefined)
    return fallback; if (!Number.isFinite(value) || value <= 0)
    throw new ConstructionError('invalid-input', 'Search budgets must be finite and positive.'); return Math.max(1, Math.min(max, Math.floor(value))); }
/** Backward removal search -> precomputed construction operations -> verified replay.
 * The planner never invokes legacy routing, never hides parts, and never relaxes
 * contact limits when a search budget is exhausted.
 */
export function planConstruction(model: ConstructionModel, options: ConstructionOptions = {}): ConstructionPlan {
    const start = performance.now(), stats: SearchStats = { states: 0, candidates: 0, backtracks: 0, meshPairs: 0, trianglePairs: 0, cacheHits: 0, milliseconds: 0 };
    const maxStates = positive(options.maxStates, 2000, 100000), maxMilliseconds = positive(options.maxMilliseconds, 20000, 120000), maxCandidates = positive(options.maxCandidates, 100000, 2000000);
    let scope = '', lastBlockages: Blockage[] = [];
    const pulse = () => {
        stats.milliseconds = Math.round(performance.now() - start);
        if (options.cancelled?.())
            throw new ConstructionError('cancelled', 'Construction planning was cancelled.', { scope, stats: { ...stats } });
        if (stats.milliseconds > maxMilliseconds || stats.states > maxStates || stats.candidates > maxCandidates)
            throw new ConstructionError('search-budget-exhausted', 'The bounded search did not finish. This does not establish physical impossibility.', { scope, blockages: lastBlockages.slice(-12), stats: { ...stats } });
    };
    options.onProgress?.({ phase: 'connections', completed: 0, total: model.parts.size });
    const graph = discoverConnections(model), ground = model.bounds.max[1];
    pulse();
    const rootNodes = options.mechanicalSubassemblies === false ? model.nodes : mechanicalSubassemblies(model.nodes, graph.connections, graph.dependencies);
    const all: ConstructionNode[] = [];
    const collect = (nodes: ConstructionNode[]) => nodes.forEach(n => { all.push(n); if (n.children)
        collect(n.children); });
    collect(rootNodes);
    const slots = new Map<string, Slot>(), gap = 24;
    // Group work bays and loose-part inventory are two different resources.
    // Packing them into one row made the first part removed from a nested group
    // become a *real* obstacle beside that same group's workbench. A second arm,
    // hand or leg could then be blocked by staging furniture that existed only
    // because of our layout choice. Keep group bays in one zone and every
    // individually staged leaf in a separate inventory zone. Both zones remain
    // visible and physical once occupied; only their abstract empty boxes are
    // non-obstacles.
    const groupNodes = all.filter(n => !!n.children?.length), leafNodes = all.filter(n => !n.children?.length);
    // A chosen build spot fixes a group bay. The automatic bays are laid out around it,
    // and it never moves because another spot moved.
    const layoutModel = options.layoutBounds ?? model.bounds;
    for (const n of groupNodes) {
        const spot = n.hints?.buildSpot;
        if (!spot)
            continue;
        // Manual bays are global positions and orientations. Never shift or turn
        // a chosen bay just because its parent assembly is itself rotated.
        if (![spot.x, spot.z, spot.angle].every(Number.isFinite))
            throw new ConstructionError('invalid-input', `Invalid coordinates or angle on the build spot for ${n.id}.`, { items: [n.id] });
        const pose = fixedBayPose(n.bounds, spot, ground);
        slots.set(n.id, { id: n.id, pose, box: stagedBounds(n.bounds, pose) });
    }
    const pack = (nodes: ConstructionNode[], originX: number): number => {
        if (!nodes.length) return originX;
        const area = nodes.reduce((s, n) => s + (size(n.bounds)[0] + gap) * (size(n.bounds)[2] + gap), 0);
        const rowWidth = Math.max(240, Math.sqrt(area) * 1.25, ...nodes.map(n => size(n.bounds)[0] + gap));
        const originZ = layoutModel.min[2];
        let x = originX, z = originZ, rowDepth = 0, maxX = originX;
        for (const n of nodes) {
            if (slots.has(n.id))
                continue;
            const d = size(n.bounds);
            if (x > originX && x + d[0] > originX + rowWidth) {
                x = originX;
                z += rowDepth + gap;
                rowDepth = 0;
            }
            const offset: V3 = [x - n.bounds.min[0], ground - n.bounds.max[1], z - n.bounds.min[2]];
            const box = shiftBox(n.bounds, offset);
            slots.set(n.id, { id: n.id, pose: rigidDelta(offset), box });
            maxX = Math.max(maxX, box.max[0]);
            x += d[0] + gap;
            rowDepth = Math.max(rowDepth, d[2]);
        }
        return maxX;
    };
    const workOriginX = Math.max(layoutModel.max[0] + gap, ...[...slots.values()].map(s => s.box.max[0] + gap));
    const workMaxX = pack(groupNodes, workOriginX);
    // Two gaps provide a clear transport aisle between active workbenches and
    // stored loose pieces. The continuous scene replay still checks every real
    // staged mesh, so this is spatial planning rather than a collision bypass.
    pack(leafNodes, Math.max(workOriginX, workMaxX + 2 * gap));
    // Work areas are planning coordinates, not physical obstacles. A group bay
    // is empty until that subassembly is actually moved there. Treating every
    // work area as solid made nested scopes (for example $upper/$lower minifig
    // modules) block one another even though no geometry occupied those boxes.
    // Physical staged obstacles are tracked dynamically from already-removed
    // nodes below and checked with their real leaf meshes.
    const workAreas = new Map<string, Slot>([['$root', { id: '$root', pose: rigidDelta(ZERO), box: model.bounds }], ...slots]);
    const layoutAreas = [...workAreas.values()];
    const sceneBounds = layoutAreas.map(s => s.box).reduce(union, model.bounds);
    const ceiling = Math.min(...layoutAreas.map(s => s.box.min[1])) - 32;
    const oracle = new MeshOracle(model, stats, pulse);
    pulse();
    const hasContactPolicy = (c: Connection) => !!(c.region || c.regions?.length || c.surfaceTolerance);
    const hasMotionPolicy = (c: Connection) => hasContactPolicy(c) && !c.staticOnly;
    const staticPolicyFor = (a: string, b: string) => graph.connections.find(c => c.child === a && c.parent === b && hasContactPolicy(c));
    // A pair can carry several certificates (a stud connector plus the measured
    // lift-off of a seat sunk into its base); the withdrawal is certified when any one does.
    const motionPoliciesFor = (a: string, b: string) => graph.connections.filter(c => c.child === a && c.parent === b && hasMotionPolicy(c));
    const clearWithPolicies = (a: string, b: string, from: V3, offset: V3, delta: V3) => {
        const policies = motionPoliciesFor(a, b);
        return policies.length ? policies.some(p => oracle.clear(a, b, from, offset, delta, p)) : oracle.clear(a, b, from, offset, delta);
    };
    const nodeRole = (n: ConstructionNode) => n.hints?.role ?? assemblyRole(n.part);
    // Posed hands and legs in authored scenes can intentionally touch seats,
    // controls or vehicle bodywork without being mechanically attached to those
    // parts.  Legacy LDraw render meshes often overlap such a touch by roughly
    // one stud-height because studs, hollow soles and rounded hand geometry are
    // not watertight collision solids.  Keep this allowance final-pose-only,
    // directional and restricted to hand/leg versus non-anatomical scene parts.
    // It never applies to generic brick/brick overlap or to containment.
    const poseSurfaceLimit = (moving: ConstructionNode, obstacle: ConstructionNode): number | undefined => {
        const r = nodeRole(moving), other = nodeRole(obstacle);
        if (other !== 'generic') return;
        // Nested authored figures inside vehicles/scenery are a separate final-
        // pose concern from mechanical attachment. Legacy render meshes include
        // studs, hair shells and rounded hands that can overlap neighbouring
        // vehicle detail substantially even though no connector exists between
        // them. These bounds are used ONLY by staticContact(); any certificate
        // it creates is staticOnly and therefore cannot weaken route collision
        // checks. Large hand bounds intentionally expose such poses to the later
        // articulation/motion stage rather than pretending they are rigid joints.
        if (r === 'hand') return 16.05;
        if (r === 'headwear') return 8.05;
        if (r === 'head' || r === 'leg') return 4.05;
        return;
    };
    // Very thin, studless geometry is commonly a sticker/decal surface rather
    // than a closed solid.  It may be certified only by separating it along its
    // own thin normal by no more than its measured thickness plus a small skin.
    // This remains pair-specific and never exempts the surface from other parts.
    const thinSurface = (n: ConstructionNode): { axis: V3; thickness: number } | undefined => {
        if (!n.part) return;
        const m = model.metrics(n.part), d = size(m.full);
        let k = 0;
        if (d[1] < d[k]) k = 1;
        if (d[2] < d[k]) k = 2;
        const other = [0, 1, 2].filter(i => i !== k);
        if (d[k] > 3.1 || other.some(i => d[i] < 16) || m.studs?.length || m.socketFace) return;
        const basis: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        return { axis: unit(vector(n.matrix, basis[k])), thickness: d[k] };
    };
    // Audit the supplied completed placement before spending a search budget on
    // access routes. Unmodelled mesh contact is NOT declared physically invalid.
    const finalContacts: Blockage[] = [], contactWarnings: string[] = [], leaves = [...model.parts.values()];
    let certifiedSurfaceContacts = 0;
    audit: for (let i = 0; i < leaves.length; i++)
        for (let j = i + 1; j < leaves.length; j++) {
            pulse();
            const a = leaves[i], b = leaves[j];
            if (!overlaps(a.bounds, b.bounds, -1e-6))
                continue;
            const ab = staticPolicyFor(a.id, b.id), ba = staticPolicyFor(b.id, a.id);
            const ta = thinSurface(a), tb = thinSurface(b);
            const ra = nodeRole(a), rb = nodeRole(b);
            // A known directed connector decides the moving side. Without one,
            // prefer a single thin surface as the moving decoration. For authored
            // pose contact, move the anatomical hand/leg rather than the vehicle
            // or scenery it is touching so the resulting surface policy has the
            // physically meaningful withdrawal side.
            const poseRoles = ['hand', 'leg', 'head', 'headwear'];
            const posedA = poseRoles.includes(ra) && rb === 'generic';
            const posedB = poseRoles.includes(rb) && ra === 'generic';
            const moving = ba ? b : ab ? a : ta && !tb ? a : tb && !ta ? b : posedA ? a : posedB ? b : a;
            const obstacle = moving === a ? b : a, policy = moving === a ? ab : ba;
            const thin = moving === a ? ta : tb;
            const poseProbe = !policy && !thin ? poseSurfaceLimit(moving, obstacle) : undefined;
            // Stud connections in legacy LDraw scenes can carry small pose
            // quantisation across a long plate/hinge chain. Probe a larger
            // separation only for an already-recognised stud pair. A thin
            // decoration gets only its own measured thickness along its normal.
            // Posed hand/leg touches get at most one stud-height, never a global
            // collision tolerance and never a containment exemption.
            // An explicit policy's tolerance is a measured certification bound,
            // not merely a minimum. Probing farther can leave a shallow clear
            // window and hit unrelated geometry on the far side, falsely turning
            // a valid surface certificate back into an unresolved contact.
            const contactProbe = policy?.surfaceTolerance ?? (policy?.kind === 'stud' ? 6.0 : thin ? Math.max(2.0, thin.thickness + .25) : poseProbe ?? 2.0);
            const probePolicy = policy ?? (thin ? { id: '$thin-probe', parent: obstacle.id, child: moving.id, kind: 'surface' as const, confidence: 'inferred' as const, outward: thin.axis } : undefined);
            const relation = oracle.staticContact(moving.id, obstacle.id, probePolicy, contactProbe);
            if (relation.kind === 'clear' || relation.kind === 'connector')
                continue;
            if (relation.kind === 'surface' && relation.separation && norm(relation.separation) <= contactProbe + SKIN) {
                let distance = norm(relation.separation), outward = unit(relation.separation), staticOnly = true;
                // A recognised connector may have a tiny residual overlap with a
                // neighbouring, non-connected render shell (helmet beside a
                // backpack is a common example). If moving the connector child
                // straight along its *already verified* withdrawal axis reaches
                // a collision-free pose within a very small bound, certify only
                // that initial separating motion for this exact pair. This is
                // stronger than a generic final-pose surface certificate but far
                // narrower than a collision tolerance: it is directional,
                // pair-specific, capped at 4.05 LDU and the remainder of the
                // swept route is still checked with ordinary collision rules.
                const connectorDirs = graph.connections
                    .filter(c => c.child === moving.id && c.kind !== 'surface' && !c.staticOnly && c.outward)
                    .map(c => unit(c.outward!));
                let guided: { distance: number; outward: V3 } | undefined;
                for (const dir of connectorDirs) {
                    const limit = 4.05, samples = 16;
                    let lo = 0, hi: number | undefined;
                    for (let i = 1; i <= samples; i++) {
                        const d = limit * i / samples;
                        if (oracle.clear(moving.id, obstacle.id, mul(dir, d), ZERO, ZERO, policy)) {
                            hi = d;
                            break;
                        }
                        lo = d;
                    }
                    if (hi === undefined) continue;
                    let upper: number = hi;
                    for (let i = 0; i < 8; i++) {
                        const mid = (lo + upper) / 2;
                        if (oracle.clear(moving.id, obstacle.id, mul(dir, mid), ZERO, ZERO, policy)) upper = mid; else lo = mid;
                    }
                    const d = Math.min(limit, upper + SKIN);
                    if (!guided || d < guided.distance) guided = { distance: d, outward: dir };
                }
                if (guided) {
                    distance = guided.distance;
                    outward = guided.outward;
                    staticOnly = false;
                }
                // Thin surfaces are allowed to peel only along their own normal.
                // A sideways escape is ordinary collision avoidance, not evidence
                // that the final overlap is a sticker/decal attachment.
                if (thin && Math.abs(dot(outward, thin.axis)) < .999) {
                    finalContacts.push({ moving: moving.id, obstacle: obstacle.id, stage: 'final-placement', detail: `Thin-surface contact between ${moving.part} and ${obstacle.part} does not separate along the surface normal; connector metadata or the final placement is still required.` });
                    if (finalContacts.length >= 12) break audit;
                    continue;
                }
                if (distance > SKIN) {
                    // Final-pose residual contact is evidence about the completed
                    // model, not permission to skip the same distance during an
                    // animated insertion. Keep it in a separate static-only
                    // certificate even when a real connector also exists.
                    const id = 'surface:' + JSON.stringify([obstacle.id, moving.id, outward.map(v => Math.round(v * 1e6) / 1e6)]);
                    if (!graph.connections.some(c => c.id === id))
                        graph.connections.push({ id, parent: obstacle.id, child: moving.id, kind: 'surface', confidence: 'inferred', outward, surfaceTolerance: distance, staticOnly });
                    certifiedSurfaceContacts++;
                }
                continue;
            }
            const reason = relation.kind === 'penetration'
                ? 'representative geometry is contained inside the other part'
                : `the contact persists beyond the bounded ${contactProbe.toFixed(1)} LDU ${policy?.kind === 'stud' ? 'stud-residual' : 'render-surface'} probe`;
            finalContacts.push({ moving: a.id, obstacle: b.id, stage: 'final-placement', detail: `Final mesh contact between ${a.part} and ${b.part} is unresolved: ${reason}. Add/repair connector metadata or correct the final placement; access order alone cannot certify it.` });
            if (finalContacts.length >= 12)
                break audit;
        }
    if (certifiedSurfaceContacts)
        contactWarnings.push(`${certifiedSurfaceContacts} final-pose contacts were classified as bounded directional surface contact. Recognised stud residuals may use up to 6.0 LDU; thin decorations are bounded by their measured thickness; authored anatomical scene contacts use role-specific final-pose bounds (hand 16.05, headwear 8.05, head/leg 4.05 LDU); other unrecognised contacts remain <= 2.0 LDU. These inferred surface certificates are static-only: assembly paths still undergo continuous collision checks and none create part-wide motion tolerances.`);
    if (finalContacts.length)
        throw new ConstructionError('unresolved-final-contact', 'The completed model contains contacts that remain unexplained after connector and bounded surface-contact classification. Check connector metadata or the final placement; changing access order alone cannot certify them.', { scope: '$root', blockages: finalContacts, stats: { ...stats } });
    const remember = (b: Blockage) => { if (!lastBlockages.some(x => x.moving === b.moving && x.obstacle === b.obstacle && x.stage === b.stage))
        lastBlockages.push(b); if (lastBlockages.length > 64)
        lastBlockages.shift(); };
    type StagedObstacle = { node: ConstructionNode; pose: M4 };
    // A pair with the same world-rigid orientation can use the original exact
    // triangle oracle in their shared (unrotated) frame. For different bay
    // orientations we reject any possibly intersecting swept AABBs; accepting
    // such a pair without a rigid-vs-rigid mesh certificate would be unsafe.
    const clearSweep = (a: string, b: string, from: M4, to: M4, obstacle: M4, withPolicy: boolean): boolean => {
        const delta = sub(pos(to), pos(from));
        const ma = model.parts.get(a)!, mb = model.parts.get(b)!;
        if (!sweptBox(stagedBounds(ma.bounds, from), stagedBounds(mb.bounds, obstacle), delta, -1e-6))
            return true;
        if (!sameOrientation(from, to) || !sameOrientation(from, obstacle))
            return false;
        const local = oracleOffsets(from, obstacle, delta);
        return withPolicy
            ? clearWithPolicies(a, b, local.a, local.b, local.delta)
            : oracle.clear(a, b, local.a, local.b, local.delta);
    };
    const rememberSweep = (moving: ConstructionNode, obstacle: ConstructionNode, stage: Blockage['stage']) => {
        remember({ moving: moving.id, obstacle: obstacle.id, stage,
            detail: 'Swept mesh collision or conservative cross-orientation bound. No unchecked transport is allowed between differently oriented build bays.' });
    };
    const segmentClear = (node: ConstructionNode, from: M4, to: M4, remaining: ConstructionNode[], staged: StagedObstacle[], scopePose: M4, first: boolean): boolean => {
        pulse();
        if (!sameOrientation(from, to))
            throw new ConstructionError('invalid-input', 'A translation segment cannot change its rigid orientation.');
        const delta = sub(pos(to), pos(from));
        if (norm(delta) < 1e-10) return true;
        const at = stagedBounds(node.bounds, from), end = stagedBounds(node.bounds, to);
        if (at.max[1] > ground + SKIN || end.max[1] > ground + SKIN) {
            remember({ moving: node.id, obstacle: 'floor', stage: 'floor', detail: 'A swept endpoint lies below the table.' });
            return false;
        }
        for (const placed of staged) {
            if (placed.node === node || !sweptBox(at, stagedBounds(placed.node.bounds, placed.pose), delta, -1e-6)) continue;
            for (const a of node.leaves) for (const b of placed.node.leaves) {
                if (!clearSweep(a, b, from, to, placed.pose, false)) {
                    rememberSweep(node, placed.node, 'transport');
                    return false;
                }
            }
        }
        for (const other of remaining) {
            if (other === node || !sweptBox(at, stagedBounds(other.bounds, scopePose), delta, -1e-6)) continue;
            for (const a of node.leaves) for (const b of other.leaves) {
                if (!clearSweep(a, b, from, to, scopePose, first)) {
                    rememberSweep(node, other, first ? 'withdrawal' : 'transport');
                    return false;
                }
            }
        }
        return true;
    };
    /** A rotation can only be made at a stationary world-space centre and when
     * the enclosing sphere is free. This is a continuous proof for ANY yaw,
     * including arbitrary 15/30/45-degree facing angles, not sampled frames. */
    const rotationEnvelopeClear = (node: ConstructionNode, from: M4, to: M4, remaining: ConstructionNode[], staged: StagedObstacle[], scopePose: M4): boolean => {
        pulse();
        const before = point(from, centre(node.bounds)), after = point(to, centre(node.bounds));
        if (norm(sub(before, after)) > 1e-6) return false;
        const envelope = turningSphere(node.bounds, from);
        if (envelope.max[1] > ground + SKIN) {
            remember({ moving: node.id, obstacle: 'floor', stage: 'floor', detail: 'The conservative rotation envelope crosses the table.' });
            return false;
        }
        for (const placed of staged) {
            if (placed.node !== node && overlaps(envelope, stagedBounds(placed.node.bounds, placed.pose))) {
                remember({ moving: node.id, obstacle: placed.node.id, stage: 'transport', detail: 'Continuous rotation envelope intersects an occupied staging part.' });
                return false;
            }
        }
        for (const other of remaining) {
            if (other !== node && overlaps(envelope, stagedBounds(other.bounds, scopePose))) {
                remember({ moving: node.id, obstacle: other.id, stage: 'transport', detail: 'Continuous rotation envelope intersects assembled geometry.' });
                return false;
            }
        }
        return true;
    };
    const support = (node: ConstructionNode, remaining: ConstructionNode[], pose: M4): Removal['support'] | null => {
        if (Math.abs(stagedBounds(node.bounds, pose).max[1] - ground) <= SKIN) return 'table';
        if (graph.connections.some(c => c.kind !== 'surface' && ((owns(node, c.child) && remaining.some(n => owns(n, c.parent))) || (owns(node, c.parent) && remaining.some(n => owns(n, c.child))))))
            return 'connected';
        return options.supportMode === 'table' ? null : 'virtual-fixture';
    };
    const route = (node: ConstructionNode, remaining: ConstructionNode[], staged: StagedObstacle[], scopePose: M4, scopeId: string): RouteResult | null => {
        const target = slots.get(node.id)!.pose;
        // If a manually placed submodel bay already coincides with its installed
        // pose, its children assemble in place. There is no group carry flight,
        // no clearance corridor to certify and no reason to lift it off its studs.
        // Require the full matrix (including height and rotation) to match:
        // matching just the floor X/Z footprint would be unsafe.
        if (node.children?.length && node.hints?.buildSpot &&
            scopePose.every((v, k) => Math.abs(v - target[k]) < 1e-6))
            return { poses: [scopePose, target] };
        const connected = graph.connections.filter(c => owns(node, c.child) && remaining.some(n => n !== node && owns(n, c.parent)));
        const preferred = connected.flatMap(c => c.outward ? (c.axial ? [c.outward, mul(c.outward, -1)] : [c.outward]) : []);
        const directions = node.hints?.insertionAxis ? [unit(node.hints.insertionAxis)] : unique([...preferred, ...AXES, ...axisDirections(node.matrix)]);
        const anatomical = connected.filter(c => c.kind === 'anatomical' && c.outward);
        const dirs = (anatomical.length ? directions.filter(d => anatomical.every(c => dot(d, c.outward!) > .9999)) : directions)
            .map(d => unit(vector(scopePose, d)));
        const extent = Math.max(...size(node.bounds)), distances = [...new Set([2, 4, 8, 16, 32, Math.max(48, extent + 8)])];
        const work = workAreas.get(scopeId)!.box;
        const rotatedBay = !sameOrientation(scopePose, target);
        const radius = norm(mul(size(node.bounds), .5));
        for (const dir of dirs) for (const distance of distances) {
            stats.candidates++;
            pulse();
            const entry = poseMoved(scopePose, mul(dir, distance));
            if (!segmentClear(node, scopePose, entry, remaining, staged, scopePose, true)) continue;
            const p = pos(entry), entryBox = stagedBounds(node.bounds, entry);
            const slides: V3[] = [8, 16, 24, 32, 48, 64].flatMap(d => ([[d, 0, 0], [-d, 0, 0], [0, 0, d], [0, 0, -d]] as V3[]));
            const exits: M4[] = [entry, ...slides.map(d => poseMoved(entry, d)),
                poseMoved(entry, [work.min[0] - entryBox.max[0] - gap, 0, 0]),
                poseMoved(entry, [work.max[0] - entryBox.min[0] + gap, 0, 0]),
                poseMoved(entry, [0, 0, work.min[2] - entryBox.max[2] - gap]),
                poseMoved(entry, [0, 0, work.max[2] - entryBox.min[2] + gap])];
            for (const exit of exits) {
                if (!segmentClear(node, entry, exit, remaining, staged, scopePose, false)) continue;
                if (rotatedBay) {
                    // Lift ABOVE the full 3D turning sphere before yawing. Rotation
                    // is applied to the entire finished group, not its individual
                    // pieces, and is undone on the flight back into its parent.
                    const skyCentreY = ceiling - radius;
                    const exitCentre = point(exit, centre(node.bounds));
                    const air = poseMoved(exit, [0, skyCentreY - exitCentre[1], 0]);
                    if (!segmentClear(node, exit, air, remaining, staged, scopePose, false)) continue;
                    const turned = poseWithCentreAndYaw(node.bounds, point(air, centre(node.bounds)), yawOf(target));
                    if (!rotationEnvelopeClear(node, air, turned, remaining, staged, scopePose)) continue;
                    const targetCentre = point(target, centre(node.bounds));
                    const targetAir = poseMoved(target, [0, skyCentreY - targetCentre[1], 0]);
                    if (!segmentClear(node, turned, targetAir, remaining, staged, scopePose, false)) continue;
                    if (!segmentClear(node, targetAir, target, remaining, staged, scopePose, false)) continue;
                    return { poses: compactPoses([scopePose, entry, exit, air, turned, targetAir, target]) };
                }
                const high = ceiling - node.bounds.max[1];
                const skyExit = poseMoved(exit, [0, high - pos(exit)[1], 0]);
                const skyTarget = poseMoved(target, [0, high - pos(target)[1], 0]);
                if (!segmentClear(node, exit, skyExit, remaining, staged, scopePose, false)) continue;
                if (!segmentClear(node, skyExit, skyTarget, remaining, staged, scopePose, false)) continue;
                if (!segmentClear(node, skyTarget, target, remaining, staged, scopePose, false)) continue;
                return { poses: compactPoses([scopePose, entry, exit, skyExit, skyTarget, target]) };
            }
        }
        // Preserve the original conservative 90-degree free-piece escape for
        // difficult fixed-orientation routes. No extra degrees of freedom are
        // silently granted at an occupied assembly point.
        if (!rotatedBay) {
            const pivot = centre(node.bounds), rotationAxes = unique([[1, 0, 0], [0, 1, 0], [0, 0, 1], ...axisDirections(node.matrix)] as V3[]);
            const rotationDistances = [...new Set([...distances, 64, 96, Math.max(96, extent * 2 + gap)])];
            for (const dir of dirs) for (const distance of rotationDistances) {
                stats.candidates++;
                pulse();
                const entry = poseMoved(scopePose, mul(dir, distance));
                if (!segmentClear(node, scopePose, entry, remaining, staged, scopePose, true)) continue;
                const entryCentre = point(entry, pivot);
                const radius = norm(mul(size(node.bounds), .5)), skyY = ceiling - radius;
                const skyEntry = poseMoved(entry, [0, skyY - entryCentre[1], 0]);
                for (const axis of rotationAxes) for (const angle of [Math.PI / 2, -Math.PI / 2]) {
                    const direction = unit(vector(scopePose, axis));
                    const turn = (at: M4): M4 => multiply(rigidDelta(ZERO, point(at, pivot), direction, angle), at);
                    const targetCentre = point(target, pivot);
                    const skyTarget = poseMoved(target, [0, skyY - targetCentre[1], 0]);
                    const rotatedTarget = turn(skyTarget);
                    // Preserve the existing V2 route that rotates immediately
                    // after a certified withdrawal. This can clear an overhang
                    // that would obstruct an unrotated vertical ascent.
                    const rotatedEntry = turn(entry), rotatedSkyEntry = turn(skyEntry);
                    if (rotationEnvelopeClear(node, entry, rotatedEntry, remaining, staged, scopePose) &&
                        segmentClear(node, rotatedEntry, rotatedSkyEntry, remaining, staged, scopePose, false) &&
                        segmentClear(node, rotatedSkyEntry, rotatedTarget, remaining, staged, scopePose, false) &&
                        rotationEnvelopeClear(node, rotatedTarget, skyTarget, remaining, staged, scopePose) &&
                        segmentClear(node, skyTarget, target, remaining, staged, scopePose, false))
                        return { poses: compactPoses([scopePose, entry, rotatedEntry, rotatedSkyEntry, rotatedTarget, skyTarget, target]) };
                    // Additional safe escape: climb into an empty air lane first,
                    // then rotate inside the sphere above the entire scene.
                    if (!segmentClear(node, entry, skyEntry, remaining, staged, scopePose, false)) continue;
                    if (!rotationEnvelopeClear(node, skyEntry, rotatedSkyEntry, remaining, staged, scopePose)) continue;
                    if (!segmentClear(node, rotatedSkyEntry, rotatedTarget, remaining, staged, scopePose, false)) continue;
                    if (!rotationEnvelopeClear(node, rotatedTarget, skyTarget, remaining, staged, scopePose)) continue;
                    if (!segmentClear(node, skyTarget, target, remaining, staged, scopePose, false)) continue;
                    return { poses: compactPoses([scopePose, entry, skyEntry, rotatedSkyEntry, rotatedTarget, skyTarget, target]) };
                }
            }
        }
        return null;
    };
    const solve = (nodes: ConstructionNode[], pose: M4, scopeId: string): Removal[] => {
        scope = scopeId;
        lastBlockages = [];
        type Frame = { remaining: ConstructionNode[]; candidates: ConstructionNode[]; next: number };
        const failed = new Set<string>(), stateKey = (r: ConstructionNode[]) => JSON.stringify(r.map(n => n.id));
        const frame = (remaining: ConstructionNode[]): Frame => {
            stats.states++;
            pulse();
            const candidates = remaining.filter(n => !graph.dependencies.some(d => owns(n, d.parent) && remaining.some(o => o !== n && owns(o, d.child))) && support(n, remaining.filter(o => o !== n), pose));
            candidates.sort((a, b) => Number(a.bounds.max[1] + pose[13] >= ground - SKIN) - Number(b.bounds.max[1] + pose[13] >= ground - SKIN) || a.bounds.min[1] - b.bounds.min[1] || b.step - a.step || b.order - a.order || a.id.localeCompare(b.id));
            return { remaining, candidates, next: 0 };
        };
        const stack: Frame[] = [frame(nodes)], chosen: Removal[] = [];
        while (stack.length) {
            pulse();
            const f = stack[stack.length - 1];
            options.onProgress?.({ phase: 'disassembly', completed: chosen.length, total: nodes.length, item: scopeId });
            if (!f.remaining.length) return chosen;
            if (f.next >= f.candidates.length) {
                failed.add(stateKey(f.remaining)); stack.pop();
                if (chosen.length) chosen.pop();
                stats.backtracks++;
                continue;
            }
            const node = f.candidates[f.next++], remaining = f.remaining.filter(n => n !== node);
            if (failed.has(stateKey(remaining))) continue;
            const staged = chosen.map(r => ({ node: r.node, pose: slots.get(r.node.id)!.pose }));
            const result = route(node, f.remaining, staged, pose, scopeId);
            if (!result) continue;
            const connections = graph.connections.filter(c => c.kind !== 'surface' && c.kind !== 'support' && ((owns(node, c.child) && remaining.some(n => owns(n, c.parent))) || (owns(node, c.parent) && remaining.some(n => owns(n, c.child))))).map(c => c.id);
            chosen.push({ node, poses: result.poses, connections, support: support(node, remaining, pose)! });
            stack.push(frame(remaining));
        }
        throw new ConstructionError('no-supported-rigid-route', 'No collision-certified rigid path was found for this assembly. Angled bays are never silently ignored or moved.', { scope, blockages: lastBlockages.slice(-12), stats: { ...stats } });
    };
    const operations: Operation[] = [], warnings = [...graph.warnings, ...contactWarnings];
    const unoriented = [...new Set([...model.parts.values()].map(n => n.part!))].filter(id => { const m = model.metrics(id); return m.meshTwoSidedFrom !== undefined && m.meshTwoSidedFrom < m.mesh!.length / 9; });
    if (unoriented.length)
        warnings.push(`Some mesh faces have unknown orientation (${unoriented.join(', ')}); containment assumes reasonably consistent winding and is not a solid-CAD certificate.`);
    const compile = (nodes: ConstructionNode[], pose: M4, scopeId: string) => {
        const removals = solve(nodes, pose, scopeId);
        for (const removal of [...removals].reverse()) {
            const n = removal.node;
            if (n.children?.length)
                compile(n.children, slots.get(n.id)!.pose, n.id);
            const id = `construct:${n.id}`, previous = operations[operations.length - 1];
            const poses = [...removal.poses].reverse();
            // Use the existing lightweight translation track only when EVERY
            // waypoint is in the imported orientation. Angled scopes use full
            // rigid matrices, including at their staging/attachment endpoints.
            const rigid = poses.some(p => !isIdentityOrientation(p));
            operations.push({ id, kind: n.children ? 'attach-subassembly' : removal.connections.length ? 'connect' : 'place', keys: [...n.leaves], scope: scopeId, model: n.model, step: n.step,
                requires: previous ? [previous.id] : [], connections: removal.connections,
                path: poses.map(pos), rigidPath: rigid ? poses : undefined,
                check: { method: 'continuous-triangle-sat', contactPolicies: graph.connections.filter(c => hasMotionPolicy(c) && owns(n, c.child)).map(c => c.id), support: removal.support } });
        }
    };
    if (model.parts.size)
        compile(rootNodes, rigidDelta(ZERO), '$root');

    // Verify the whole FORWARD scene with true staged orientations. The earlier
    // algorithm replayed only translation offsets and therefore could not tell
    // whether an angled group's members really ended in their correct bay pose.
    const current = new Map([...model.parts.keys()].map(key => [key, slots.get(key)!.pose]));
    const closePose = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    for (const [index, op] of operations.entries()) {
        pulse();
        options.onProgress?.({ phase: 'validation', completed: index, total: operations.length, item: op.id });
        const moving = new Set(op.keys);
        const poses: M4[] = op.rigidPath ?? op.path.map(p => rigidDelta(p));
        const first = poses[0], last = poses[poses.length - 1];
        for (const key of op.keys)
            if (!closePose(current.get(key)!, first))
                throw new ConstructionError('invalid-plan', `Discontinuous staged orientation or position for ${key} in ${op.id}.`);
        const movingBounds = op.keys.map(key => model.parts.get(key)!.bounds).reduce(union);
        for (let i = 1; i < poses.length; i++) {
            const from = poses[i - 1], to = poses[i];
            // An assembly constructed on its final studs never travels. Do not
            // run a motion-collision certificate for a zero-length segment.
            if (closePose(from, to)) continue;
            if (!sameOrientation(from, to)) {
                const before = point(from, centre(movingBounds)), after = point(to, centre(movingBounds));
                const sphere = turningSphere(movingBounds, from);
                if (norm(sub(before, after)) > 1e-6 || sphere.max[1] > ground + SKIN)
                    throw new ConstructionError('invalid-plan', `Replay cannot certify the pivot or floor clearance for ${op.id}.`);
                for (const [key, where] of current) {
                    if (!moving.has(key) && overlaps(sphere, stagedBounds(model.parts.get(key)!.bounds, where)))
                        throw new ConstructionError('invalid-plan', `Replay cannot certify continuous rotation of ${op.id} near ${key}.`, {
                            scope: op.scope, blockages: [{ moving: op.id, obstacle: key, stage: 'transport', detail: 'The continuous rotation sphere intersects actual staged/assembled geometry.' }], stats: { ...stats } });
                }
                continue;
            }
            const delta = sub(pos(to), pos(from));
            const worldBox = stagedBounds(movingBounds, from), endBox = stagedBounds(movingBounds, to);
            if (worldBox.max[1] > ground + SKIN || endBox.max[1] > ground + SKIN)
                throw new ConstructionError('invalid-plan', `Replay found an under-table path for ${op.id}.`);
            for (const a of op.keys) for (const [b, where] of current) {
                if (moving.has(b)) continue;
                // Exact, time-reversible mesh check in the same rigid frame.
                // An end-of-flight connector certificate only applies to the
                // final insertion segment, never to earlier transport.
                if (!clearSweep(a, b, to, from, where, i === poses.length - 1))
                    throw new ConstructionError('invalid-plan', `Replay rejected collision of ${a} with ${b} during ${op.id}.`, {
                        scope: op.scope, blockages: [{ moving: a, obstacle: b, stage: 'transport', detail: 'Continuous mesh sweep or cross-orientation conservative broad phase rejected the actual scene.' }], stats: { ...stats } });
            }
        }
        for (const key of op.keys) current.set(key, last);
    }
    for (const [key, pose] of current)
        if (!closePose(pose, rigidDelta(ZERO)))
            throw new ConstructionError('invalid-plan', `Final orientation or placement changed for ${key}.`);
    if (operations.some(o => o.check.support === 'virtual-fixture'))
        warnings.push('Some assembly operations require a held workpiece/virtual fixture. Fixtures are assumptions, not rendered supports; gravity and physical stability are not simulated.');
    if (operations.some(o => o.rigidPath))
        warnings.push('Rotated group transfers preserve each member\'s rigid relative pose. Every turn has a continuous obstacle-free sphere certificate and every translation is checked against the staged scene.');
    warnings.push('Automatic articulated-joint search and flexible/snap-fit deformation are not implemented; these fail explicitly rather than bypassing collision checks.');
    warnings.push('Mesh validation uses a 0.02 LDU numerical skin and oriented-mesh winding-number containment assumptions. Connector contact allowances are localized metadata, not a tolerance-free mechanical proof.');
    stats.milliseconds = Math.round(performance.now() - start);
    return { schema: 'brickmotion-construction/v2', operations,
        parts: [...model.parts.values()].map(n => ({ key: n.id, part: n.part!, final: [...n.matrix], staged: multiply(slots.get(n.id)!.pose, n.matrix), bounds: n.bounds })),
        connections: graph.connections, dependencies: graph.dependencies, warnings, stats, ground, bounds: model.bounds, sceneBounds,
        capabilities: { rigidTranslation: true, rigidRotation: true, hierarchicalSubassemblies: true, articulation: false, deformation: false, physicalStability: false } };
}
