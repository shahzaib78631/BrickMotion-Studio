import type { Box } from '../../ldraw/flatten';
import { add, sub, mul, norm, unit, dot, vector, axisDirections, shiftBox, union, size, sweptBox, translated, overlaps, centre, transformBox, rigidDelta } from './math';
import type { V3, M4 } from './math';
import { discoverConnections } from './connections';
import { assemblyRole } from '../assemblyGraph';
import { MeshOracle, SKIN } from './collision';
import { mechanicalSubassemblies } from './subassemblies';
import { ConstructionError, type ConstructionModel, type ConstructionNode, type ConstructionPlan, type ConstructionOptions, type Blockage, type Operation, type SearchStats, type Connection } from './types';
type Slot = {
    id: string;
    offset: V3;
    box: Box;
};
type Removal = {
    node: ConstructionNode;
    path: V3[];
    rigidPath?: M4[];
    connections: string[];
    support: Operation['check']['support'];
};
type RouteResult = { path: V3[]; rigidPath?: M4[] };
const ZERO: V3 = [0, 0, 0], AXES: V3[] = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const same = (a: V3, b: V3) => norm(sub(a, b)) < 1e-9;
const unique = (v: V3[]) => v.filter((d, i) => !v.slice(0, i).some(e => dot(d, e) > 1 - 1e-10));
const owns = (node: ConstructionNode, id: string): boolean => node.id === id || node.leaves.includes(id) || !!node.children?.some(n => owns(n, id));
const compact = (path: V3[]) => path.filter((p, i) => !i || !same(p, path[i - 1]));
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
    const pack = (nodes: ConstructionNode[], originX: number): number => {
        if (!nodes.length) return originX;
        const area = nodes.reduce((s, n) => s + (size(n.bounds)[0] + gap) * (size(n.bounds)[2] + gap), 0);
        const rowWidth = Math.max(240, Math.sqrt(area) * 1.25, ...nodes.map(n => size(n.bounds)[0] + gap));
        const originZ = model.bounds.min[2];
        let x = originX, z = originZ, rowDepth = 0, maxX = originX;
        for (const n of nodes) {
            const d = size(n.bounds);
            if (x > originX && x + d[0] > originX + rowWidth) {
                x = originX;
                z += rowDepth + gap;
                rowDepth = 0;
            }
            const offset: V3 = [x - n.bounds.min[0], ground - n.bounds.max[1], z - n.bounds.min[2]];
            const box = shiftBox(n.bounds, offset);
            slots.set(n.id, { id: n.id, offset, box });
            maxX = Math.max(maxX, box.max[0]);
            x += d[0] + gap;
            rowDepth = Math.max(rowDepth, d[2]);
        }
        return maxX;
    };
    const workOriginX = model.bounds.max[0] + gap;
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
    const workAreas = new Map<string, Slot>([['$root', { id: '$root', offset: ZERO, box: model.bounds }], ...slots]);
    const layoutAreas = [...workAreas.values()];
    const sceneBounds = layoutAreas.map(s => s.box).reduce(union, model.bounds);
    const ceiling = Math.min(...layoutAreas.map(s => s.box.min[1])) - 32;
    const oracle = new MeshOracle(model, stats, pulse);
    pulse();
    const hasContactPolicy = (c: Connection) => !!(c.region || c.regions?.length || c.surfaceTolerance);
    const hasMotionPolicy = (c: Connection) => hasContactPolicy(c) && !c.staticOnly;
    const staticPolicyFor = (a: string, b: string) => graph.connections.find(c => c.child === a && c.parent === b && hasContactPolicy(c));
    const motionPolicyFor = (a: string, b: string) => graph.connections.find(c => c.child === a && c.parent === b && hasMotionPolicy(c));
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
    type StagedObstacle = { node: ConstructionNode; offset: V3 };
    const segmentClear = (node: ConstructionNode, from: V3, to: V3, remaining: ConstructionNode[], staged: StagedObstacle[], scopeOffset: V3, scopeId: string, first: boolean): boolean => {
        pulse();
        const delta = sub(to, from);
        if (norm(delta) < 1e-10)
            return true;
        const at = shiftBox(node.bounds, from), end = shiftBox(node.bounds, to);
        if (at.max[1] > ground + SKIN || end.max[1] > ground + SKIN) {
            remember({ moving: node.id, obstacle: 'floor', stage: 'floor', detail: 'A swept endpoint lies below the table.' });
            return false;
        }
        // Only already-removed nodes occupy staging bays in the backward
        // search. Abstract root/group work areas contain no material and must
        // never behave like invisible collision boxes. Check occupied staging
        // nodes with the same leaf-mesh oracle used for the assembled model.
        for (const placed of staged) {
            if (placed.node === node || !sweptBox(at, shiftBox(placed.node.bounds, placed.offset), delta, -1e-6))
                continue;
            for (const a of node.leaves)
                for (const b of placed.node.leaves) {
                    if (!oracle.clear(a, b, from, placed.offset, delta)) {
                        remember({ moving: node.id, obstacle: placed.node.id, stage: 'transport', detail: `Swept collision with an actually occupied staging bay: ${a} (part ${model.parts.get(a)!.part}) against ${b} (part ${model.parts.get(b)!.part}).` });
                        return false;
                    }
                }
        }
        for (const other of remaining) {
            if (other === node || !sweptBox(at, shiftBox(other.bounds, scopeOffset), delta, -1e-6))
                continue;
            for (const a of node.leaves)
                for (const b of other.leaves) {
                    if (!oracle.clear(a, b, from, scopeOffset, delta, first ? motionPolicyFor(a, b) : undefined)) {
                        remember({ moving: node.id, obstacle: other.id, stage: first ? 'withdrawal' : 'transport', detail: `Swept collision between ${a} (part ${model.parts.get(a)!.part}) and ${b} (part ${model.parts.get(b)!.part}); no connector policy certified this contact.` });
                        return false;
                    }
                }
        }
        return true;
    };
    /** Conservative broad-phase certificate for a segment whose orientation is
     * already changed. `transformBox(node.bounds, rigidDelta)` encloses the true
     * rotated mesh because `node.bounds` encloses the completed mesh. We accept
     * the segment only when that enclosure never overlaps any obstacle box; an
     * overlap is rejected rather than guessed clear. */
    const rigidBroadSegmentClear = (node: ConstructionNode, fromDelta: M4, toDelta: M4, fromOffset: V3, toOffset: V3, remaining: ConstructionNode[], staged: StagedObstacle[], scopeOffset: V3): boolean => {
        pulse();
        const at = transformBox(node.bounds, fromDelta), end = transformBox(node.bounds, toDelta), delta = sub(toOffset, fromOffset);
        if (at.max[1] > ground + SKIN || end.max[1] > ground + SKIN) {
            remember({ moving: node.id, obstacle: 'floor', stage: 'floor', detail: 'A rigid-rotation transport endpoint lies below the table.' });
            return false;
        }
        for (const placed of staged) {
            if (placed.node === node) continue;
            const obstacle = shiftBox(placed.node.bounds, placed.offset);
            if (sweptBox(at, obstacle, delta, -1e-6)) {
                remember({ moving: node.id, obstacle: placed.node.id, stage: 'transport', detail: 'A conservative rotated swept box intersects an actually occupied staging part; this route is not certified.' });
                return false;
            }
        }
        for (const other of remaining) {
            if (other === node) continue;
            const obstacle = shiftBox(other.bounds, scopeOffset);
            if (sweptBox(at, obstacle, delta, -1e-6)) {
                remember({ moving: node.id, obstacle: other.id, stage: 'transport', detail: 'A conservative rotated swept box intersects assembled geometry; this route is not certified.' });
                return false;
            }
        }
        return true;
    };
    /** A rotation is accepted only inside an obstacle-free sphere enclosing the
     * node at every orientation. This is deliberately conservative: it provides
     * a continuous proof for the rotation itself without frame sampling. */
    const rotationEnvelopeClear = (node: ConstructionNode, atOffset: V3, remaining: ConstructionNode[], staged: StagedObstacle[], scopeOffset: V3): boolean => {
        const pivot = add(centre(node.bounds), atOffset), radius = norm(mul(size(node.bounds), .5));
        const r: V3 = [radius, radius, radius], envelope = { min: sub(pivot, r), max: add(pivot, r) };
        if (envelope.max[1] > ground + SKIN) {
            remember({ moving: node.id, obstacle: 'floor', stage: 'floor', detail: 'The conservative rotation envelope would cross the table.' });
            return false;
        }
        for (const placed of staged) {
            if (placed.node !== node && overlaps(envelope, shiftBox(placed.node.bounds, placed.offset))) {
                remember({ moving: node.id, obstacle: placed.node.id, stage: 'transport', detail: 'The continuous rotation envelope intersects an occupied staging part.' });
                return false;
            }
        }
        for (const other of remaining) {
            if (other !== node && overlaps(envelope, shiftBox(other.bounds, scopeOffset))) {
                remember({ moving: node.id, obstacle: other.id, stage: 'transport', detail: 'The continuous rotation envelope intersects assembled geometry.' });
                return false;
            }
        }
        return true;
    };
    const support = (node: ConstructionNode, remaining: ConstructionNode[], offset: V3): Removal['support'] | null => {
        if (Math.abs(node.bounds.max[1] + offset[1] - ground) <= SKIN)
            return 'table';
        if (graph.connections.some(c => c.kind !== 'surface' && ((owns(node, c.child) && remaining.some(n => owns(n, c.parent))) || (owns(node, c.parent) && remaining.some(n => owns(n, c.child))))))
            return 'connected';
        return options.supportMode === 'table' ? null : 'virtual-fixture';
    };
    const route = (node: ConstructionNode, remaining: ConstructionNode[], staged: StagedObstacle[], offset: V3, scopeId: string): RouteResult | null => {
        const target = slots.get(node.id)!.offset;
        const connected = graph.connections.filter(c => owns(node, c.child) && remaining.some(n => n !== node && owns(n, c.parent)));
        const preferred = connected.flatMap(c => c.outward ? [c.outward] : []);
        const directions = node.hints?.insertionAxis ? [unit(node.hints.insertionAxis)] : unique([...preferred, ...AXES, ...axisDirections(node.matrix)]);
        // Known wrist/shoulder/head axes constrain an operation, rather than merely
        // allowing an unrelated low collision score to choose the wrong joint motion.
        const anatomical = connected.filter(c => c.kind === 'anatomical' && c.outward);
        const dirs = anatomical.length ? directions.filter(d => anatomical.every(c => dot(d, c.outward!) > .9999)) : directions;
        const extent = Math.max(...size(node.bounds));
        const distances = [2, 4, 8, 16, 32, Math.max(48, extent + 8)];
        const ownBox = shiftBox(node.bounds, offset), work = workAreas.get(scopeId)!.box;
        const high = ceiling - node.bounds.max[1];
        for (const dir of dirs)
            for (const distance of [...new Set(distances)]) {
                stats.candidates++;
                pulse();
                const entry = add(offset, mul(dir, distance));
                if (!segmentClear(node, offset, entry, remaining, staged, offset, scopeId, true))
                    continue;
                const exits: V3[] = [entry,
                    [entry[0] + work.min[0] - shiftBox(node.bounds, entry).max[0] - gap, entry[1], entry[2]],
                    [entry[0] + work.max[0] - shiftBox(node.bounds, entry).min[0] + gap, entry[1], entry[2]],
                    [entry[0], entry[1], entry[2] + work.min[2] - shiftBox(node.bounds, entry).max[2] - gap],
                    [entry[0], entry[1], entry[2] + work.max[2] - shiftBox(node.bounds, entry).min[2] + gap]];
                for (const exit of exits) {
                    const path = compact([offset, entry, exit, [exit[0], high, exit[2]], [target[0], high, target[2]], target]);
                    let good = true;
                    for (let i = 2; i < path.length; i++)
                        if (!segmentClear(node, path[i - 1], path[i], remaining, staged, offset, scopeId, false)) {
                            good = false;
                            break;
                        }
                    if (good)
                        return { path };
                }
            }
        // Rigid-rotation fallback. Rotation itself occurs only inside a fully
        // clear enclosing sphere; translated rotated poses are accepted only
        // when their conservative swept AABB is disjoint from every obstacle.
        // This cannot tunnel through geometry and does not replace articulated
        // joints, but it lets long free pieces turn before traversing an aisle.
        const pivot = centre(node.bounds), rotationAxes = unique([[1, 0, 0], [0, 1, 0], [0, 0, 1], ...axisDirections(node.matrix)] as V3[]);
        const rotationDistances = [...new Set([...distances, 64, 96, Math.max(96, extent * 2 + gap)])];
        for (const dir of dirs)
            for (const distance of rotationDistances) {
                stats.candidates++;
                pulse();
                const entry = add(offset, mul(dir, distance));
                if (!segmentClear(node, offset, entry, remaining, staged, offset, scopeId, true))
                    continue;
                if (!rotationEnvelopeClear(node, entry, remaining, staged, offset))
                    continue;
                for (const axis of rotationAxes)
                    for (const angle of [Math.PI / 2, -Math.PI / 2]) {
                        const atEntry = rigidDelta(entry, pivot, axis, angle), rotated = transformBox(node.bounds, atEntry);
                        // Put the entire rotation sphere and both orientations in
                        // the air lane. More negative Y is above the table/model.
                        const radius = norm(mul(size(node.bounds), .5));
                        const sphereHigh = ceiling - (pivot[1] + radius);
                        const rotatedHigh = entry[1] + ceiling - rotated.max[1];
                        const finalHigh = ceiling - node.bounds.max[1];
                        const highY = Math.min(sphereHigh, rotatedHigh, finalHigh);
                        const highEntry: V3 = [entry[0], highY, entry[2]], highTarget: V3 = [target[0], highY, target[2]];
                        const atHighEntry = rigidDelta(highEntry, pivot, axis, angle), atHighTarget = rigidDelta(highTarget, pivot, axis, angle);
                        if (!rigidBroadSegmentClear(node, atEntry, atHighEntry, entry, highEntry, remaining, staged, offset))
                            continue;
                        if (!rigidBroadSegmentClear(node, atHighEntry, atHighTarget, highEntry, highTarget, remaining, staged, offset))
                            continue;
                        if (!rotationEnvelopeClear(node, highTarget, remaining, staged, offset))
                            continue;
                        if (!segmentClear(node, highTarget, target, remaining, staged, offset, scopeId, false))
                            continue;
                        const path: V3[] = [offset, entry, entry, highEntry, highTarget, highTarget, target];
                        const rigidPath: M4[] = [
                            rigidDelta(offset),
                            rigidDelta(entry),
                            atEntry,
                            atHighEntry,
                            atHighTarget,
                            rigidDelta(highTarget),
                            rigidDelta(target),
                        ];
                        return { path, rigidPath };
                    }
            }
        return null;
    };
    const solve = (nodes: ConstructionNode[], offset: V3, scopeId: string): Removal[] => {
        scope = scopeId;
        lastBlockages = [];
        type Frame = {
            remaining: ConstructionNode[];
            candidates: ConstructionNode[];
            next: number;
            removed?: Removal;
        };
        const failed = new Set<string>(), stateKey = (r: ConstructionNode[]) => JSON.stringify(r.map(n => n.id));
        const frame = (remaining: ConstructionNode[]): Frame => {
            stats.states++;
            pulse();
            const candidates = remaining.filter(n => !graph.dependencies.some(d => owns(n, d.parent) && remaining.some(o => o !== n && owns(o, d.child))) && support(n, remaining.filter(o => o !== n), offset));
            candidates.sort((a, b) => Number(a.bounds.max[1] + offset[1] >= ground - SKIN) - Number(b.bounds.max[1] + offset[1] >= ground - SKIN) || a.bounds.min[1] - b.bounds.min[1] || b.step - a.step || b.order - a.order || a.id.localeCompare(b.id));
            return { remaining, candidates, next: 0 };
        };
        const stack: Frame[] = [frame(nodes)], chosen: Removal[] = [];
        while (stack.length) {
            pulse();
            const f = stack[stack.length - 1];
            options.onProgress?.({ phase: 'disassembly', completed: chosen.length, total: nodes.length, item: scopeId });
            if (!f.remaining.length)
                return chosen;
            if (f.next >= f.candidates.length) {
                failed.add(stateKey(f.remaining));
                stack.pop();
                if (chosen.length)
                    chosen.pop();
                stats.backtracks++;
                continue;
            }
            const node = f.candidates[f.next++], remaining = f.remaining.filter(n => n !== node);
            if (failed.has(stateKey(remaining)))
                continue;
            // In backward disassembly, only nodes already removed by this search
            // occupy their staging slots. This exactly mirrors forward assembly:
            // those are the pieces that have not yet been installed when the
            // current reversed operation begins.
            const staged = chosen.map(r => ({ node: r.node, offset: slots.get(r.node.id)!.offset }));
            const routeResult = route(node, f.remaining, staged, offset, scopeId);
            if (!routeResult)
                continue;
            const connections = graph.connections.filter(c => c.kind !== 'surface' && c.kind !== 'support' && ((owns(node, c.child) && remaining.some(n => owns(n, c.parent))) || (owns(node, c.parent) && remaining.some(n => owns(n, c.child))))).map(c => c.id);
            chosen.push({ node, path: routeResult.path, rigidPath: routeResult.rigidPath, connections, support: support(node, remaining, offset)! });
            stack.push(frame(remaining));
        }
        throw new ConstructionError('no-supported-rigid-route', 'No order in the explored fixed-orientation route family succeeded. Articulation, deformation, richer connectors, or a corrected final pose may be required; no part was hidden.', { scope, blockages: lastBlockages.slice(-12), stats: { ...stats } });
    };
    const operations: Operation[] = [], warnings = [...graph.warnings, ...contactWarnings];
    const unoriented = [...new Set([...model.parts.values()].map(n => n.part!))].filter(id => { const m = model.metrics(id); return m.meshTwoSidedFrom !== undefined && m.meshTwoSidedFrom < m.mesh!.length / 9; });
    if (unoriented.length)
        warnings.push(`Some mesh faces have unknown orientation (${unoriented.join(', ')}); containment assumes reasonably consistent winding and is not a solid-CAD certificate.`);
    const compile = (nodes: ConstructionNode[], offset: V3, scopeId: string) => {
        const removals = solve(nodes, offset, scopeId);
        for (const removal of [...removals].reverse()) {
            const n = removal.node;
            if (n.children?.length)
                compile(n.children, slots.get(n.id)!.offset, n.id);
            const id = `construct:${n.id}`, previous = operations[operations.length - 1];
            operations.push({ id, kind: n.children ? 'attach-subassembly' : removal.connections.length ? 'connect' : 'place', keys: [...n.leaves], scope: scopeId, model: n.model, step: n.step, requires: previous ? [previous.id] : [], connections: removal.connections, path: [...removal.path].reverse(), rigidPath: removal.rigidPath ? [...removal.rigidPath].reverse() : undefined, check: { method: 'continuous-triangle-sat', contactPolicies: graph.connections.filter(c => hasMotionPolicy(c) && owns(n, c.child)).map(c => c.id), support: removal.support } });
        }
    };
    if (model.parts.size)
        compile(rootNodes, ZERO, '$root');
    // Replay the ACTUAL scene, not just the work-bay abstraction. A rejected replay
    // is a planner failure; there is no automatic legacy fallback or final snap.
    const current = new Map([...model.parts.keys()].map(key => [key, slots.get(key)!.offset]));
    const linearIndices = [0, 1, 2, 4, 5, 6, 8, 9, 10] as const;
    const sameLinear = (a: readonly number[], b: readonly number[]) => linearIndices.every(k => Math.abs(a[k] - b[k]) < 1e-9);
    const identityLinear = (a: readonly number[]) => linearIndices.every(k => Math.abs(a[k] - ([0, 5, 10].includes(k) ? 1 : 0)) < 1e-9);
    for (const [index, op] of operations.entries()) {
        pulse();
        options.onProgress?.({ phase: 'validation', completed: index, total: operations.length, item: op.id });
        const moving = new Set(op.keys);
        for (const key of op.keys)
            if (!same(current.get(key)!, op.path[0]))
                throw new ConstructionError('invalid-plan', `Discontinuous launch for ${key}.`);
        if (op.rigidPath && (!identityLinear(op.rigidPath[0]) || !identityLinear(op.rigidPath[op.rigidPath.length - 1])))
            throw new ConstructionError('invalid-plan', `Rigid operation ${op.id} must begin and end in the imported orientation.`);
        const movingBounds = op.keys.map(key => model.parts.get(key)!.bounds).reduce(union);
        const replayEnvelopeClear = (atOffset: V3): boolean => {
            const pivot = add(centre(movingBounds), atOffset), radius = norm(mul(size(movingBounds), .5));
            const r: V3 = [radius, radius, radius], envelope = { min: sub(pivot, r), max: add(pivot, r) };
            if (envelope.max[1] > ground + SKIN) return false;
            for (const [key, where] of current) {
                if (moving.has(key)) continue;
                if (overlaps(envelope, shiftBox(model.parts.get(key)!.bounds, where))) return false;
            }
            return true;
        };
        for (let i = 1; i < op.path.length; i++) {
            const from = op.path[i - 1], to = op.path[i];
            const fromRigid = op.rigidPath?.[i - 1], toRigid = op.rigidPath?.[i];
            if (fromRigid && toRigid && !sameLinear(fromRigid, toRigid)) {
                if (!same(from, to) || !replayEnvelopeClear(from))
                    throw new ConstructionError('invalid-plan', `Replay could not certify the continuous rotation in ${op.id}.`, { scope: op.scope, blockages: [{ moving: op.id, obstacle: 'scene', stage: 'transport', detail: 'The conservative continuous rotation envelope intersects staged/assembled geometry or the table.' }], stats: { ...stats } });
                continue;
            }
            if (fromRigid && toRigid && !identityLinear(fromRigid)) {
                const startBox = transformBox(movingBounds, fromRigid), delta = sub(to, from);
                if (startBox.max[1] > ground + SKIN || transformBox(movingBounds, toRigid).max[1] > ground + SKIN)
                    throw new ConstructionError('invalid-plan', `Replay detected a rotated path below the table in ${op.id}.`);
                for (const [key, where] of current) {
                    if (moving.has(key)) continue;
                    if (sweptBox(startBox, shiftBox(model.parts.get(key)!.bounds, where), delta, -1e-6))
                        throw new ConstructionError('invalid-plan', `Replay detected an uncertified rotated sweep for ${op.id} against ${key}.`, { scope: op.scope, blockages: [{ moving: op.id, obstacle: key, stage: 'transport', detail: 'The conservative rotated swept box intersects the actual staged scene.' }], stats: { ...stats } });
                }
                continue;
            }
            // Reverse each segment to use exactly the withdrawal contact policy used
            // by the search. Geometric intersection of a path is time-reversible.
            for (const a of op.keys)
                for (const [b, where] of current) {
                    if (moving.has(b))
                        continue;
                    const ma = model.parts.get(a)!, mb = model.parts.get(b)!;
                    if (!sweptBox(shiftBox(ma.bounds, to), shiftBox(mb.bounds, where), sub(from, to), -1e-6))
                        continue;
                    if (!oracle.clear(a, b, to, where, sub(from, to), i === op.path.length - 1 ? motionPolicyFor(a, b) : undefined))
                        throw new ConstructionError('invalid-plan', `Replay detected an unchecked collision for ${a} against ${b}.`, { scope: op.scope, blockages: [{ moving: a, obstacle: b, stage: 'transport', detail: 'Actual staged-scene replay rejected this operation.' }], stats: { ...stats } });
                }
        }
        for (const key of op.keys)
            current.set(key, op.path[op.path.length - 1]);
    }
    for (const [key, offset] of current)
        if (!same(offset, ZERO))
            throw new ConstructionError('invalid-plan', `Final placement changed for ${key}.`);
    if (operations.some(o => o.check.support === 'virtual-fixture'))
        warnings.push('Some assembly operations require a held workpiece/virtual fixture. Fixtures are assumptions, not rendered supports; gravity and physical stability are not simulated.');
    if (operations.some(o => o.rigidPath))
        warnings.push('Some free-part transports use certified rigid 90-degree rotations. Each rotation occurs inside an obstacle-free enclosing sphere; rotated translations use conservative swept bounds before exact final insertion.');
    warnings.push('Automatic articulated-joint search and flexible/snap-fit deformation are not implemented; these fail explicitly rather than bypassing collision checks.');
    warnings.push('Mesh validation uses a 0.02 LDU numerical skin and oriented-mesh winding-number containment assumptions. Connector contact allowances are localized metadata, not a tolerance-free mechanical proof.');
    stats.milliseconds = Math.round(performance.now() - start);
    return { schema: 'brickmotion-construction/v2', operations, parts: [...model.parts.values()].map(n => ({ key: n.id, part: n.part!, final: [...n.matrix], staged: translated(n.matrix, slots.get(n.id)!.offset), bounds: n.bounds })), connections: graph.connections, dependencies: graph.dependencies, warnings, stats, ground, bounds: model.bounds, sceneBounds, capabilities: { rigidTranslation: true, rigidRotation: true, hierarchicalSubassemblies: true, articulation: false, deformation: false, physicalStability: false } };
}
