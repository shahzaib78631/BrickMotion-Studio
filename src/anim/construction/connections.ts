import { assemblyRole } from '../assemblyGraph';
import { connectionGeometryFor, transformConnections, studFitsFace } from '../../ldraw/connectors';
import { cupGripFits, wristContact } from '../jointContact';
import { mateAxis, worldSnaps } from '../snapMates';
import type { Snap } from '../../ldraw/shadow';
import { add, sub, mul, unit, norm, point, vector, invert, multiply, dot } from './math';
import type { V3 } from './math';
import { ConstructionError, type Connection, type ConstructionNode, type ConstructionModel, type Dependency } from './types';
const canonical = (s = '') => s.toLowerCase().replace(/\.dat$/, '').split('/').pop()!;
const HOLDER: Record<string, string> = { hand: 'arm', arm: 'torso', torso: 'hips', head: 'torso', headwear: 'head', neckwear: 'torso', leg: 'hips' };
const role = (n: ConstructionNode) => n.hints?.role ?? assemblyRole(n.part);
const gap = (a: ConstructionNode, b: ConstructionNode) => [0, 1, 2].reduce((s, k) => s + Math.max(0, Math.max(a.bounds.min[k] - b.bounds.max[k], b.bounds.min[k] - a.bounds.max[k])) ** 2, 0);
const contactTube = (origin: V3, axis: V3, length: number, radius: number, minRadius?: number) => ({ origin, axis: unit(axis), length, radius, ...(minRadius === undefined ? {} : { minRadius }) });
const near = (a: number, b: number, eps = .35) => Math.abs(a - b) <= eps;
const relBasisNear = (r: readonly number[], expected: readonly number[], eps = 1e-3) => [0, 1, 2, 4, 5, 6, 8, 9, 10].every((k, i) => near(r[k], expected[i], eps));
const ID_BASIS = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
/** a plain round stud (radius 6 LDU), or a round socket that takes one: an anti-stud or a hinge tube such as a car door's */
const isStudSnap = (s: Snap) => s.kind === 'cyl' && s.length > 0 && s.length <= (s.gender === 'M' ? 8 : 32) && s.shapes.length > 0
    // a round stud also seats in a square socket: the underside of 1-wide plates (4315) and special bases
    && s.shapes.every(x => x === 'R' || (s.gender === 'F' && x === 'S')) && Math.abs(s.radius - 6) <= .6;
const STUD_PARALLEL = Math.cos(4 * Math.PI / 180);
const volume = (n: ConstructionNode) => [0, 1, 2].reduce((v, k) => v * Math.max(0, n.body.max[k] - n.body.min[k]), 1);
const FLIP_XZ_BASIS = [-1, 0, 0, 0, 1, 0, 0, 0, -1] as const;
const Y_POS_90_BASIS = [0, 0, 1, 0, 1, 0, -1, 0, 0] as const;
const Y_NEG_90_BASIS = [0, 0, -1, 0, 1, 0, 1, 0, 0] as const;
const X_POS_90_BASIS = [1, 0, 0, 0, 0, 1, 0, -1, 0] as const;
/** Connector discovery and mechanical dependencies are separate from access order. */
export function discoverConnections(model: ConstructionModel): {
    connections: Connection[];
    dependencies: Dependency[];
    warnings: string[];
} {
    const connections: Connection[] = [], dependencies: Dependency[] = [], warnings: string[] = [];
    /**
     * Studs of `parent` seated in `child`. First the child's flat underside (socket
     * face). Parts without one (a minifig seat, whose anti-stud sockets sit in a
     * shaped base) fall back to the LDCad shadow snaps: a round stud-sized male
     * of the parent coaxial with, and engaged in, a matching female of the child.
     * Either way the result only names the connector; the contact regions are the
     * stud cylinders themselves and every route is still swept against the meshes.
     */
    const studFit = (parent: ConstructionNode, child: ConstructionNode): Pick<Connection, 'outward' | 'regions'> | null => {
        if (parent === child || !parent.part || !child.part || gap(parent, child) > 36)
            return null;
        const tube = (base: V3, tip: V3, radius: number) => {
            const a = unit(sub(tip, base)), h = norm(sub(tip, base));
            return contactTube(add(base, mul(a, -.45)), a, h + .9, radius + .8);
        };
        const childGeo = transformConnections(connectionGeometryFor(child.part, model.metrics(child.part)), child.matrix);
        if (childGeo.socketFace) {
            const geo = transformConnections(connectionGeometryFor(parent.part, model.metrics(parent.part)), parent.matrix);
            const fits = geo.studs?.filter(s => studFitsFace(s, childGeo.socketFace!)) ?? [];
            if (fits.length)
                return { outward: unit(sub(fits[0].tip, fits[0].base)), regions: fits.map(s => tube(s.base, s.tip, s.radius)) };
        }
        const female = worldSnaps(model.metrics(child.part).snaps?.filter(s => s.gender === 'F' && isStudSnap(s)), child.matrix);
        if (!female.length)
            return null;
        const male = worldSnaps(model.metrics(parent.part).snaps?.filter(s => s.gender === 'M' && isStudSnap(s)), parent.matrix);
        // the stud must point INTO the socket (same direction), not merely share its line
        // both ends are already stud-sized, so only the geometry is checked here: a square
        // socket (the underside of a 1x1 plate on a headlight brick's side stud) takes a round stud
        const seated = (m: (typeof male)[number], f: (typeof female)[number]) => {
            if (dot(m.axis, f.axis) <= STUD_PARALLEL)
                return false;
            const w = sub(f.start, m.start), along = dot(w, m.axis);
            if (norm(sub(w, mul(m.axis, along))) > .5)
                return false;
            return Math.min(m.snap.length, along + f.snap.length) - Math.max(0, along) >= -.5;
        };
        const fits = male.filter(m => female.some(f => seated(m, f)));
        if (!fits.length)
            return null;
        return {
            outward: fits[0].axis,
            regions: fits.map(m => tube(m.start, add(m.start, mul(m.axis, m.snap.length)), m.snap.radius)),
        };
    };
    const addEdge = (parent: ConstructionNode, child: ConstructionNode, kind: Connection['kind'], extra: Partial<Connection> = {}, hard = true) => {
        const id = 'connection:' + JSON.stringify([parent.id, child.id, kind]);
        if (connections.some(c => c.id === id))
            return;
        connections.push({ id, parent: parent.id, child: child.id, kind, confidence: kind === 'explicit' ? 'declared' : 'inferred', ...extra });
        if (hard && !dependencies.some(d => d.parent === parent.id && d.child === child.id))
            dependencies.push({ parent: parent.id, child: child.id, reason: kind });
    };
    const walk = (nodes: ConstructionNode[]) => {
        const byShort = new Map(nodes.map(n => [n.id.split('/').pop()!, n]));
        const byId = new Map(nodes.map(n => [n.id, n]));
        if (byId.size !== nodes.length || byShort.size !== nodes.length)
            throw new ConstructionError('invalid-input', 'Duplicate sibling IDs.');
        for (const child of nodes) {
            if (child.hints?.insertionAxis) {
                const a = child.hints.insertionAxis;
                if (!a.every(Number.isFinite) || norm(a) < 1e-9)
                    throw new ConstructionError('invalid-input', `Invalid insertionAxis on ${child.id}.`);
            }
            for (const id of [...(child.hints?.after ?? []), ...(child.hints?.attachTo ? [child.hints.attachTo] : [])]) {
                const parent = byShort.get(id);
                if (!parent)
                    throw new ConstructionError('invalid-input', `Missing sibling ${id} required by ${child.id}.`);
                addEdge(parent, child, 'explicit');
            }
            const holder = HOLDER[role(child)];
            if (holder && !child.hints?.root && !child.hints?.attachTo && nodes.length > 1) {
                const candidates = nodes.filter(n => n !== child && role(n) === holder && gap(child, n) < 36).map(n => ({ n, d: norm(sub(point(n.matrix, [0, 0, 0]), point(child.matrix, [0, 0, 0]))) + 10 * gap(child, n) })).sort((a, b) => a.d - b.d || a.n.id.localeCompare(b.n.id));
                if (!candidates.length) {
                    if (['hand', 'arm'].includes(role(child)))
                        throw new ConstructionError('unknown-connector', `No matching ${holder} for ${child.id}. Declare attachTo or an intentional standalone root.`, { items: [child.id] });
                }
                else {
                    if (candidates[1] && Math.abs(candidates[1].d - candidates[0].d) < 1e-6)
                        throw new ConstructionError('ambiguous-connector', `Ambiguous ${holder} for ${child.id}. Declare attachTo.`, { items: [child.id] });
                    const parent = candidates[0].n, extra: Partial<Connection> = {};
                    // These small regions describe only the connector material. No part-wide exemption.
                    if (role(child) === 'hand') {
                        const rel = multiply(invert(parent.matrix), child.matrix), origin: V3 = [canonical(parent.part) === '3818' ? -5 : 5, 18.9, -9.9];
                        const wristAxis = unit(vector(child.matrix, [0, 0, -1])), localWay = unit(vector(invert(parent.matrix), wristAxis));
                        if (norm(sub([rel[12], rel[13], rel[14]], origin)) < .4 && wristContact(child.part!, parent.part!, rel, localWay)) {
                            const axis = unit(vector(child.matrix, [0, 0, 1]));
                            extra.outward = mul(axis, -1);
                            const x = vector(child.matrix, [1, 0, 0]), y = vector(child.matrix, [0, 1, 0]), z = vector(child.matrix, [0, 0, 1]);
                            const scale = Math.sqrt(Math.max(dot(x, x) + Math.abs(dot(x, y)) + Math.abs(dot(x, z)), dot(y, y) + Math.abs(dot(y, x)) + Math.abs(dot(y, z)), dot(z, z) + Math.abs(dot(z, x)) + Math.abs(dot(z, y))));
                            extra.region = { origin: add(point(child.matrix, [0, 0, 0]), mul(axis, -.3)), axis, length: 13 * norm(z) + .6, radius: 3.3 * scale };
                        }
                    }
                    else if (role(child) === 'arm') {
                        const sign = canonical(child.part) === '3818' ? -1 : 1;
                        const axis = unit(vector(child.matrix, [sign, 0, 0]));
                        extra.outward = axis;
                        const anchor = point(child.matrix, [0, 0, 0]), inside = mul(axis, -1);
                        const rel = multiply(invert(parent.matrix), child.matrix);
                        // Arm origins in authored minifigure poses can move slightly around
                        // the shoulder pivot. Require the correct side and a tightly bounded
                        // shoulder-centre neighbourhood instead of an exact unposed origin.
                        const radial = Math.hypot(rel[13] - 9, rel[14]);
                        if (Math.abs(rel[12] - sign * 15.6) < .65 && radial < 1.6)
                            // The arm/torso render meshes overlap around the rounded
                            // shoulder cup farther from the nominal pivot than the old
                            // 7.2 LDU tube allowed.  Keep the permission local to the
                            // recognised shoulder axis, but cover the complete socket
                            // lip so a valid posed arm is not rejected as penetration.
                            extra.region = contactTube(add(anchor, mul(inside, -.5)), inside, 9, 8.8);
                    }
                    else if (role(child) === 'leg') {
                        const sign = canonical(child.part) === '3816' ? -1 : 1, axis = unit(vector(child.matrix, [sign, 0, 0]));
                        extra.outward = axis;
                        const rel = multiply(invert(parent.matrix), child.matrix);
                        if (norm(sub([rel[12], rel[13], rel[14]], [0, 12, 0])) < .4)
                            // The rotating hip/leg socket lip reaches just beyond
                            // 9.3 LDU in the official render mesh. 9.5 covers the
                            // complete connector sweep while remaining confined
                            // to the hip joint; it does not exempt the thigh/body.
                            extra.region = { origin: point(child.matrix, [sign * 1.5, 0, 0]), axis, length: 17, radius: 9.5 };
                    }
                    else if (['head', 'headwear', 'neckwear', 'torso'].includes(role(child))) {
                        extra.outward = unit(vector(parent.matrix, [0, -1, 0]));
                        const rel = multiply(invert(parent.matrix), child.matrix);
                        if (role(child) === 'head' && Math.hypot(rel[12], rel[14]) < .35 && Math.abs(rel[13] + 26) < .6
                            && Math.abs(dot(unit(vector(child.matrix, [0, 1, 0])), unit(vector(parent.matrix, [0, 1, 0])))) > .999) {
                            // Standard minifigure neck stud. Besides vertical head
                            // insertion, this narrow cylinder is the physical
                            // bearing that permits yaw rotation after attachment.
                            // Keep the allowance around the neck only; face/head
                            // geometry and the torso shoulders remain ordinary
                            // collision surfaces.
                            const axis = unit(vector(parent.matrix, [0, 1, 0]));
                            extra.region = contactTube(point(parent.matrix, [0, -14, 0]), axis, 18, 7.1);
                        }
                        if (role(child) === 'headwear' && norm([rel[12], rel[13], rel[14]]) < .3 && Math.abs(dot(unit(vector(child.matrix, [0, 1, 0])), unit(vector(parent.matrix, [0, 1, 0])))) > .999) {
                            const axis = unit(vector(parent.matrix, [0, 1, 0]));
                            // Sleeve contact only in the outer 2.7 LDU annulus of a standard
                            // 26 LDU head, not the face, neck, or the entire hat envelope.
                            extra.region = { origin: point(parent.matrix, [0, 0, 0]), axis, length: 24, radius: 13.7, minRadius: 11.0 };
                        }
                    }
                    addEdge(parent, child, 'anatomical', extra);
                }
            }
        }
        // Studs are connection candidates, not a guessed mandatory build direction.
        // Only authored/anatomical ordering is hard. Backward extraction determines access.
        for (const child of nodes)
            for (const parent of nodes) {
                const fit = studFit(parent, child);
                if (fit)
                    addEdge(parent, child, 'stud', fit, false);
            }
        for (const cup of nodes)
            if (canonical(cup.part) === '3899') {
                const hands = nodes.filter(n => role(n) === 'hand' && cupGripFits(cup.matrix, n.matrix));
                if (hands.length === 1) {
                    const axis = unit(vector(cup.matrix, [0, 1, 0]));
                    addEdge(hands[0], cup, 'anatomical', { outward: mul(axis, -1), region: contactTube(point(cup.matrix, [0, 3.25, 20]), axis, 18, 5.4) });
                }
            }
        // Single-axle train bogie: the wheelset is already a rigid axle/wheel
        // component. The bogie is lowered over the two bearing ends. Only those
        // small bearing cylinders are contact-certified; wheel faces and the rest
        // of the bogie remain ordinary collision geometry.
        for (const bogie of nodes) if (canonical(bogie.part) === '2878')
            for (const wheel of nodes) if (canonical(wheel.part) === '70720c01') {
                const rel = multiply(invert(bogie.matrix), wheel.matrix);
                const aligned = [0, 1, 2, 4, 5, 6, 8, 9, 10].every(k => Math.abs(rel[k] - ([0, 5, 10].includes(k) ? 1 : 0)) < 1e-4);
                if (!aligned || Math.hypot(rel[12], rel[13] - 32, rel[14]) > .35) continue;
                const axis = unit(vector(wheel.matrix, [1, 0, 0]));
                // The bogie bearings run on the continuous axle through 70720c01.
                // Certify only that narrow axle span; wheel faces and surrounding
                // bogie geometry remain ordinary collision geometry.
                const region = contactTube(point(wheel.matrix, [-60, 0, 0]), axis, 120, 3);
                addEdge(wheel, bogie, 'mechanical', { outward: unit(vector(bogie.matrix, [0, -1, 0])), region });
            }
        // Keep static support separate and provisional. It influences ranking, not collision permissions.
        for (const child of nodes)
            for (const parent of nodes) {
                if (parent === child)
                    continue;
                if (Math.abs(child.body.max[1] - parent.body.min[1]) <= .35 && [0, 2].every(k => Math.min(child.body.max[k], parent.body.max[k]) - Math.max(child.body.min[k], parent.body.min[k]) > 1))
                    addEdge(parent, child, 'support', {}, false);
            }
        const state = new Map<string, number>();
        const visit = (id: string) => {
            if (state.get(id) === 1)
                throw new ConstructionError('dependency-cycle', `Dependency cycle at ${id}.`);
            if (state.get(id) === 2)
                return;
            state.set(id, 1);
            for (const d of dependencies)
                if (d.child === id && byId.has(d.parent))
                    visit(d.parent);
            state.set(id, 2);
        };
        for (const n of nodes)
            visit(n.id);
        for (const n of nodes)
            if (n.children)
                walk(n.children);
    };
    walk(model.nodes);

    // Neckwear such as 2524 shares the torso frame and is trapped by the head.
    // Forward construction is torso -> neckwear -> head; backward extraction is
    // the exact reverse. This is an ordering constraint, not a collision bypass.
    for (const neck of [...model.parts.values()].filter(n => role(n) === 'neckwear')) {
        const torsoEdge = connections.find(c => c.child === neck.id && role(model.parts.get(c.parent)!) === 'torso');
        if (!torsoEdge) continue;
        const heads = [...model.parts.values()].filter(n => role(n) === 'head' && connections.some(c => c.parent === torsoEdge.parent && c.child === n.id && c.kind === 'anatomical'));
        if (heads.length === 1 && !dependencies.some(d => d.parent === neck.id && d.child === heads[0].id))
            dependencies.push({ parent: neck.id, child: heads[0].id, reason: 'neckwear-lock' });
    }

    // Minifigure upper-body construction uses a phase order, not two independent
    // arm/hand chains. If one hand is removed and its arm is immediately staged,
    // that staged arm can physically obstruct the opposite hand's escape even
    // though the completed figure itself is perfectly valid. Forward assembly is
    // also visually clearer when both arms are seated before either hand arrives.
    // Add ordering only; the actual wrist/shoulder connector geometry remains the
    // authority for collision permission.
    for (const torso of [...model.parts.values()].filter(n => role(n) === 'torso')) {
        const arms = connections
            .filter(c => c.parent === torso.id && c.kind === 'anatomical')
            .map(c => model.parts.get(c.child))
            .filter((n): n is ConstructionNode => !!n && role(n) === 'arm');
        const hands = arms.flatMap(arm => connections
            .filter(c => c.parent === arm.id && c.kind === 'anatomical')
            .map(c => model.parts.get(c.child))
            .filter((n): n is ConstructionNode => !!n && role(n) === 'hand'));
        for (const arm of arms)
            for (const hand of hands)
                if (!dependencies.some(d => d.parent === arm.id && d.child === hand.id))
                    dependencies.push({ parent: arm.id, child: hand.id, reason: 'anatomical-phase' });
    }

    // Physical connections are not restricted by the imported submodel tree.
    // A minifigure foot can stand on a platform owned by a different submodel,
    // an accessory can be held by a hand outside its authored group, and a
    // mechanical component can bridge editor group boundaries. The hierarchy is
    // still used for construction scopes, but the connector graph must be built
    // from the actual leaf parts in the completed placement.
    const leaves = [...model.parts.values()];
    for (const child of leaves)
        for (const parent of leaves) {
            const fit = studFit(parent, child);
            if (fit)
                addEdge(parent, child, 'stud', fit, false);
        }
    for (const cup of leaves)
        if (canonical(cup.part) === '3899') {
            const hands = leaves.filter(n => role(n) === 'hand' && cupGripFits(cup.matrix, n.matrix));
            if (hands.length === 1) {
                const axis = unit(vector(cup.matrix, [0, 1, 0]));
                addEdge(hands[0], cup, 'anatomical', { outward: mul(axis, -1), region: contactTube(point(cup.matrix, [0, 3.25, 20]), axis, 18, 5.4) });
            }
        }


    // Train and legacy-electrics mechanical interfaces. These profiles are
    // recognised from both the exact part family and the completed relative
    // pose. `surfaceTolerance` is a bounded disengagement distance along one
    // connector axis; it is never a global/part-wide collision tolerance.
    // The first swept segment must move in `outward`, after which ordinary
    // continuous collision checking resumes with no exemption.
    const addPoseFit = (parent: ConstructionNode, child: ConstructionNode, outwardLocal: V3, tolerance: number) => {
        addEdge(parent, child, 'mechanical', {
            outward: unit(vector(child.matrix, outwardLocal)),
            surfaceTolerance: tolerance,
        }, false);
    };
    // Some legacy render meshes contain decorative shells, hollow electrical
    // housings or sloped faces that overlap at an authored completed pose even
    // though that contact is not itself an insertion joint. These certificates
    // are deliberately static-only: they can explain the completed pose but
    // NEVER skip any part of a swept construction path.
    const addStaticPoseFit = (parent: ConstructionNode, child: ConstructionNode, outwardLocal: V3, tolerance: number) => {
        addEdge(parent, child, 'surface', {
            outward: unit(vector(child.matrix, outwardLocal)),
            surfaceTolerance: tolerance,
            staticOnly: true,
        }, false);
    };

    // 4592/4593 is the classic control-stick hinge. The stick rotates around X
    // in authored poses but remains coaxial with the base pin. Axial withdrawal
    // is a valid rigid primitive even when articulated rotation is not yet used.
    for (const base of leaves) if (canonical(base.part) === '4592')
        for (const stick of leaves) if (canonical(stick.part) === '4593') {
            const r = multiply(invert(base.matrix), stick.matrix);
            // Printed/legacy matrices can contain mild scale/shear in the Y/Z
            // plane. The hinge axis itself is the invariant: local X remains
            // coaxial and the two origins coincide within a fraction of an LDU.
            const xCoaxial = near(r[0], 1, 1e-3) && Math.abs(r[1]) < 1e-3 && Math.abs(r[2]) < 1e-3
                && Math.abs(r[4]) < 1e-3 && Math.abs(r[8]) < 1e-3;
            if (!xCoaxial || Math.hypot(r[12], r[13], r[14]) > .25) continue;
            addPoseFit(base, stick, [1, 0, 0], 10.25);
        }

    // The 3496/3278 tap assembly sits against the inner face of an inverted
    // 3660 slope in train 2. The recorded LDraw render shells overlap there,
    // but this is not permission to pull the tap through the slope. Certify
    // only the exact authored orientation/offset as completed-pose contact.
    for (const slope of leaves) if (canonical(slope.part) === '3660')
        for (const tap of leaves) if (['3496', '3278'].includes(canonical(tap.part))) {
            const r = multiply(invert(slope.matrix), tap.matrix);
            if (!relBasisNear(r, Y_POS_90_BASIS) || !near(r[12], -10, .25) || !near(r[13], 0, .25) || !near(r[14], -10, .25)) continue;
            addStaticPoseFit(slope, tap, [0, -1, 0], canonical(tap.part) === '3496' ? 8.25 : 3.25);
        }

    // Train-3 electrical/motor housings and adjacent bodywork use old render
    // meshes with shallow shell overlaps. Keep these as exact-pose static
    // certificates so access search still has to find a genuinely clear route.
    for (const motor of leaves) if (canonical(motor.part) === '70358')
        for (const base of leaves) if (canonical(base.part) === '4093c') {
            const r = multiply(invert(motor.matrix), base.matrix);
            if (!relBasisNear(r, Y_NEG_90_BASIS) || !near(r[12], 1, .4) || !near(r[13], -8, .4) || !near(r[14], -180.571, .6)) continue;
            addStaticPoseFit(motor, base, [0, 0, -1], 1.25);
        }
    for (const base of leaves) if (canonical(base.part) === '4093c')
        for (const tail of leaves) if (canonical(tail.part) === '4746') {
            const r = multiply(invert(base.matrix), tail.matrix);
            if (!relBasisNear(r, Y_POS_90_BASIS) || !near(r[12], -59, .4) || !near(r[13], -48, .4) || !near(r[14], 0, .4)) continue;
            addStaticPoseFit(base, tail, [0, 0, 1], 1.25);
        }
    for (const electric of leaves) if (canonical(electric.part) === '5306')
        for (const plate of leaves) if (canonical(plate.part) === '3710') {
            const r = multiply(invert(electric.matrix), plate.matrix);
            if (!relBasisNear(r, Y_NEG_90_BASIS) || !near(r[12], -9, .35) || !near(r[13], -8, .35) || !near(r[14], 0, .35)) continue;
            addStaticPoseFit(electric, plate, [0, -1, 0], 4.25);
        }
    for (const slope of leaves) if (canonical(slope.part) === '3660')
        for (const electric of leaves) if (canonical(electric.part) === '5306') {
            const r = multiply(invert(slope.matrix), electric.matrix);
            if (!relBasisNear(r, Y_POS_90_BASIS) || !near(Math.abs(r[12]), 20, .35) || !near(r[13], 8, .35) || !near(r[14], -30, .35)) continue;
            // Large because the old electric-brick shell is enclosed by both
            // slopes. Static-only is essential here: no 20-LDU motion shortcut.
            addStaticPoseFit(slope, electric, [0, 1, 0], 20.25);
        }

    // Console/control details in train 3. These exact final contacts describe
    // old decorative meshes sitting on/through a console surface. Motion is
    // still checked without any exemption.
    for (const consolePart of leaves) if (canonical(consolePart.part) === '2342') {
        for (const detail of leaves) {
            const id = canonical(detail.part), r = multiply(invert(consolePart.matrix), detail.matrix);
            if (id === '4588' && relBasisNear(r, X_POS_90_BASIS) && near(r[12], 1, .35) && near(r[13], -13, .35) && near(r[14], 10, .35))
                addStaticPoseFit(consolePart, detail, [0, 1, 0], 4.25);
            if (id === '4592' && near(r[0], 1, 1e-3) && Math.abs(r[1]) < 1e-3 && Math.abs(r[2]) < 1e-3 && near(r[12], 0, .35) && near(r[13], -40.522, .5) && near(r[14], -6.937, .5))
                addStaticPoseFit(consolePart, detail, [0, 0, -1], 4.25);
        }
    }

    // Classic train track joins and wheel-on-rail contacts. 2865/2867 render
    // meshes include rail-joiner detail that overlaps in the assembled scene;
    // 70720c01 wheels likewise touch/overlap the rail shell. These are scene
    // contacts, not construction shortcuts, so all are static-only. The centre
    // spacing limits keep the rule on actual neighbouring track sections.
    const trackId = (n: ConstructionNode) => canonical(n.part);
    const isTrack = (n: ConstructionNode) => ['2865', '2867'].includes(trackId(n));
    const centreDistanceXZ = (a: ConstructionNode, b: ConstructionNode) => {
        const pa = point(a.matrix, [0, 0, 0]), pb = point(b.matrix, [0, 0, 0]);
        return Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
    };
    for (let i = 0; i < leaves.length; i++) {
        const a = leaves[i]; if (!isTrack(a)) continue;
        for (let j = i + 1; j < leaves.length; j++) {
            const b = leaves[j]; if (!isTrack(b) || gap(a, b) > 4) continue;
            const pair = [trackId(a), trackId(b)].sort().join('/'), d = centreDistanceXZ(a, b);
            const neighbour = pair === '2865/2865' ? d > 318 && d < 322
                : pair === '2865/2867' ? d > 313 && d < 319
                    : pair === '2867/2867' ? d > 303 && d < 310 : false;
            if (!neighbour) continue;
            const pa = point(a.matrix, [0, 0, 0]), pb = point(b.matrix, [0, 0, 0]);
            addEdge(a, b, 'surface', {
                outward: unit(sub(pb, pa)),
                surfaceTolerance: 20.25,
                staticOnly: true,
            }, false);
        }
    }
    for (const track of leaves) if (isTrack(track))
        for (const wheel of leaves) if (canonical(wheel.part) === '70720c01' && gap(track, wheel) < 1) {
            const pt = point(track.matrix, [0, 0, 0]), pw = point(wheel.matrix, [0, 0, 0]);
            const radial = sub(pw, pt), outward: V3 = norm(radial) > 1e-6 ? unit(radial) : unit(vector(wheel.matrix, [0, 0, 1]));
            addEdge(track, wheel, 'surface', { outward, surfaceTolerance: 8.25, staticOnly: true }, false);
        }

    // 4092a's long bogie pin enters either end mounting hole of 4093c. In the
    // finished model the bogie is rotated 180 degrees around Y and its pin is
    // seated about 18-20 LDU into the base. Require that exact mounting pose.
    for (const base of leaves) if (canonical(base.part) === '4093c')
        for (const bogie of leaves) if (canonical(bogie.part) === '4092a') {
            const r = multiply(invert(base.matrix), bogie.matrix);
            if (!relBasisNear(r, FLIP_XZ_BASIS) || !near(Math.abs(r[12]), 181, 2.1) || !near(r[13], 8, .35) || !near(r[14], 0, .5)) continue;
            addPoseFit(base, bogie, [0, -1, 0], 20.25);
        }

    // 2920 is the sliding train coupling mounted in 4022's buffer beam. The
    // old render meshes overlap throughout the coupling pocket. Only the
    // authored beam/coupling pose is recognised; removal is straight upward in
    // the coupling's local -Y direction and clears after about 10 LDU.
    for (const beam of leaves) if (canonical(beam.part) === '4022')
        for (const coupling of leaves) if (canonical(coupling.part) === '2920') {
            const r = multiply(invert(beam.matrix), coupling.matrix);
            if (!relBasisNear(r, ID_BASIS) || Math.abs(r[12]) > 1.5 || !near(r[13], 16, .35) || r[14] < -34 || r[14] > -29) continue;
            addPoseFit(beam, coupling, [0, -1, 0], 10.25);
        }

    // 2919 is the internal light prism fitted into the patterned 2916 train
    // front used by this model. It is deeply enclosed by design, so its rigid
    // extraction distance is much larger than an ordinary surface-contact
    // probe. Restrict this to the exact [0,24,-30] assembled transform.
    for (const front of leaves) if (canonical(front.part).endsWith('2916pb03'))
        for (const prism of leaves) if (canonical(prism.part) === '2919') {
            const r = multiply(invert(front.matrix), prism.matrix);
            if (!relBasisNear(r, ID_BASIS) || !near(r[12], 0, .2) || !near(r[13], 24, .2) || !near(r[14], -30, .2)) continue;
            addPoseFit(front, prism, [0, -1, 0], 43.75);
        }

    // The light/sound brick 6035 has legacy geometry that omits usable stud
    // metadata in recorded reproductions. In 10001 a 2x2 plate seats on its
    // top at this repeatable transform. Model that interface directly rather
    // than pretending the entire electric brick is a solid obstruction.
    for (const electric of leaves) if (canonical(electric.part) === '6035')
        for (const plate of leaves) if (canonical(plate.part) === '3022') {
            const r = multiply(invert(electric.matrix), plate.matrix);
            if (!relBasisNear(r, FLIP_XZ_BASIS) || !near(r[12], 0, .3) || !near(r[13], -8, .3) || !near(r[14], -9, .4)) continue;
            addPoseFit(electric, plate, [0, -1, 0], 4.25);
        }

    // A 3068b tile can sit immediately beside/over the lip of the inverted
    // 3660 slope in the train nose. Their render meshes overlap by roughly the
    // stud cap height at the exact authored offset. Treat it as bounded surface
    // contact only; it does not create a mechanical dependency.
    for (const slope of leaves) if (canonical(slope.part) === '3660')
        for (const tile of leaves) if (canonical(tile.part) === '3068b') {
            const r = multiply(invert(slope.matrix), tile.matrix);
            if (!relBasisNear(r, ID_BASIS) || !near(r[12], 0, .25) || !near(r[13], -8, .25) || !near(r[14], -29, .35)) continue;
            addEdge(slope, tile, 'surface', { outward: unit(vector(tile.matrix, [0, -1, 0])), surfaceTolerance: 4.25 }, false);
        }

    // Finger hinges described by the LDCad shadow library (4213 car roof on
    // 4315 hinge plate, 3937/3938, 4275/4276 ...): interleaved fingers on one pin
    // line. They come apart only by sliding along the pin, either way, so the
    // pair is a hard mechanical module (built at its own bay, then placed as one
    // piece) with contact certified only in a tube around the pin.
    for (const a of leaves) {
        if (!a.part) continue;
        const fa = worldSnaps(model.metrics(a.part).snaps?.filter(s => s.kind === 'fgr' && s.gender === 'M' && s.length > 0), a.matrix);
        if (!fa.length) continue;
        for (const b of leaves) {
            if (b === a || !b.part || gap(a, b) > 36) continue;
            const fb = worldSnaps(model.metrics(b.part).snaps?.filter(s => s.kind === 'fgr' && s.gender === 'F' && s.length > 0), b.matrix);
            const pair = fa.flatMap(m => fb.filter(f => mateAxis(m, f)).map(f => ({ m, f })))[0];
            if (!pair) continue;
            // a finger snap's start is its middle; it runs half its length each way
            const axis = pair.m.axis, half = Math.max(pair.m.snap.length, pair.f.snap.length) / 2 + 1;
            const radius = Math.max(pair.m.snap.radius, pair.f.snap.radius) + 4;
            // the larger part is the module's base; the other clips onto its pin.
            // Interleaved fingers cannot slide apart along the pin (each finger
            // meets the next), so the clip comes off sideways: straight away from
            // the pin toward the child's body. A child centred on the pin keeps
            // the axial slide.
            const [parent, child] = volume(a) >= volume(b) ? [a, b] : [b, a];
            const centre = [0, 1, 2].map(k => (child.bounds.min[k] + child.bounds.max[k]) / 2) as V3;
            const d = sub(centre, pair.m.start), radial = sub(d, mul(axis, dot(d, axis)));
            const sideways = norm(radial) > 1;
            addEdge(parent, child, 'mechanical', {
                outward: sideways ? unit(radial) : axis,
                ...(sideways ? {} : { axial: true }),
                region: contactTube(sub(pair.m.start, mul(axis, half)), axis, 2 * half, radius),
            });
        }
    }

    // A tyre (LDCad generic "rim" socket) pushed onto a wheel hub. Many old wheel
    // parts (122c01's built-in wheels) expose only a plain hub stud, so the rim
    // group never pairs; a hub stud on the tyre's own axis line is enough. The
    // tyre slides off along the axle, away from the hub's part; the region is the
    // tyre's own envelope around that axle, for this pair only.
    for (const tyre of leaves) {
        if (!tyre.part) continue;
        const rims = worldSnaps(model.metrics(tyre.part).snaps?.filter(s => s.kind === 'gen' && s.gender === 'F' && s.shapes[0] === 'GEN:cyl'), tyre.matrix);
        if (!rims.length) continue;
        for (const hub of leaves) {
            if (hub === tyre || !hub.part || gap(tyre, hub) > 8) continue;
            const males = worldSnaps(model.metrics(hub.part).snaps?.filter(s => s.gender === 'M' && (s.kind === 'cyl' || s.kind === 'gen')), hub.matrix);
            const pair = rims.flatMap(r => males.filter(m => {
                if (m.snap.kind === 'gen') return !!mateAxis(m, r);
                if (Math.abs(dot(m.axis, r.axis)) < STUD_PARALLEL) return false;
                const w = sub(r.start, m.start), along = dot(w, m.axis);
                return norm(sub(w, mul(m.axis, along))) <= .5 && Math.abs(along) <= r.snap.length + m.snap.length + 8;
            }).map(m => ({ r, m })))[0];
            if (!pair) continue;
            const centre = (b: { min: V3; max: V3 }) => [0, 1, 2].map(k => (b.min[k] + b.max[k]) / 2) as V3;
            let axis = unit(pair.m.axis);
            if (dot(sub(centre(tyre.bounds), centre(hub.bounds)), axis) < 0) axis = mul(axis, -1);
            // the tyre's envelope around the axle line
            let lo = Infinity, hi = -Infinity, radius = 0;
            for (const x of [tyre.bounds.min[0], tyre.bounds.max[0]])
                for (const y of [tyre.bounds.min[1], tyre.bounds.max[1]])
                    for (const z of [tyre.bounds.min[2], tyre.bounds.max[2]]) {
                        const d = sub([x, y, z], pair.r.start), t = dot(d, axis);
                        lo = Math.min(lo, t); hi = Math.max(hi, t);
                        radius = Math.max(radius, norm(sub(d, mul(axis, t))));
                    }
            addEdge(hub, tyre, 'mechanical', {
                outward: axis,
                region: contactTube(add(pair.r.start, mul(axis, lo - 1)), axis, hi - lo + 2, radius + 1),
            }, false);
        }
    }

    // 2923/2922a pantograph joints are interleaved finger hinges. Axial
    // extraction along the hinge pin direction is a valid rigid disassembly
    // primitive; a later articulated planner may instead rotate them in place.
    for (const a of leaves) if (canonical(a.part) === '2923') {
        for (const b of leaves) {
            const id = canonical(b.part);
            if (b === a || (id !== '2923' && id !== '2922a') || gap(a, b) > 100) continue;
            // Require actual final mesh proximity and avoid creating all-to-all
            // pantograph edges merely because the part numbers match.
            if (![0, 1, 2].every(k => Math.min(a.bounds.max[k], b.bounds.max[k]) - Math.max(a.bounds.min[k], b.bounds.min[k]) > -1)) continue;
            addEdge(a, b, 'mechanical', {
                outward: unit(vector(b.matrix, [1, 0, 0])),
                surfaceTolerance: 8.25,
            }, false);
        }
    }

    // Classic finger hinges: 4275b's three-finger pivot is centred at
    // local [26,8,0]; 4504 has matching end pivots at local +/-[70,8,0].
    // Certify only the cylindrical finger envelope around a coincident pivot.
    // This is contact metadata, not a whole-part collision exemption, and the
    // inferred hinge does not force an assembly order.
    for (const leaf of leaves) if (canonical(leaf.part) === '4275b')
        for (const mate of leaves) if (canonical(mate.part) === '4504') {
            const pivot = point(leaf.matrix, [26, 8, 0]);
            const candidates = [point(mate.matrix, [70, 8, 0]), point(mate.matrix, [-70, 8, 0])];
            const match = candidates.map(p => ({ p, d: norm(sub(pivot, p)) })).sort((a, b) => a.d - b.d)[0];
            if (!match || match.d > .75) continue;
            const axis = unit(vector(leaf.matrix, [0, 0, 1]));
            const centre = mul(add(pivot, match.p), .5);
            addEdge(mate, leaf, 'mechanical', {
                outward: axis,
                region: contactTube(add(centre, mul(axis, -10.5)), axis, 21, 10),
            }, false);
        }
    for (const bogie of leaves) if (canonical(bogie.part) === '2878')
        for (const wheel of leaves) if (canonical(wheel.part) === '70720c01') {
            const rel = multiply(invert(bogie.matrix), wheel.matrix);
            const aligned = [0, 1, 2, 4, 5, 6, 8, 9, 10].every(k => Math.abs(rel[k] - ([0, 5, 10].includes(k) ? 1 : 0)) < 1e-4);
            if (!aligned || Math.hypot(rel[12], rel[13] - 32, rel[14]) > .35)
                continue;
            const axis = unit(vector(wheel.matrix, [1, 0, 0]));
            // The bogie bearings run on the continuous axle through 70720c01.
            // Certify only that narrow axle span; wheel faces and surrounding
            // bogie geometry remain ordinary collision geometry.
            const region = contactTube(point(wheel.matrix, [-60, 0, 0]), axis, 120, 3);
            addEdge(wheel, bogie, 'mechanical', { outward: unit(vector(bogie.matrix, [0, -1, 0])), region });
        }

    // Official 2495c01 consists of the 2495 hand-truck frame and 2496 wheelset
    // in exactly the same local frame.  Recognise that mechanical fit rather
    // than treating the wheel/frame intersection as arbitrary mesh overlap.
    // The allowed contact is an annulus around the wheelset only; it is not a
    // part-wide exemption.  The wheelset can withdraw through the open rear
    // bearing slots in +Z of the frame's local coordinates.
    for (const frame of leaves) if (canonical(frame.part) === '2495') {
        for (const wheel of leaves) if (canonical(wheel.part) === '2496') {
            const rel = multiply(invert(frame.matrix), wheel.matrix);
            const identityFit = [0, 1, 2, 4, 5, 6, 8, 9, 10].every(k => Math.abs(rel[k] - ([0, 5, 10].includes(k) ? 1 : 0)) < 1e-4)
                && Math.hypot(rel[12], rel[13], rel[14]) < .1;
            if (!identityFit) continue;
            const axle = unit(vector(frame.matrix, [1, 0, 0]));
            const outward = unit(vector(frame.matrix, [0, 0, 1]));
            addEdge(frame, wheel, 'mechanical', {
                outward,
                region: contactTube(point(frame.matrix, [-25, 0, 0]), axle, 50, 11, 6),
            });
        }

        // A minifigure grips either of the hand-truck's two cylindrical handles.
        // Recognition is based on the hand's actual grip centre/axis in the frame
        // coordinate system, so a nearby hand elsewhere on the trolley does not
        // inherit this contact policy.  The frame is the moving accessory for the
        // contact edge; the hand remains attached to its arm.
        const gripCentre: V3 = [0, -.8229, -9.8948], gripAxis: V3 = [0, .968148, .25038];
        for (const hand of leaves) if (role(hand) === 'hand') {
            const rel = multiply(invert(frame.matrix), hand.matrix);
            const centre = point(rel, gripCentre), axisLocal = unit(vector(rel, gripAxis));
            const fitted = Math.abs(Math.abs(centre[0]) - 22.5) < 4.5
                && Math.abs(centre[1] + 58) < 4.5
                && Math.abs(centre[2] - 7.2) < 3
                && Math.abs(dot(axisLocal, [0, 0, 1])) > .985;
            if (!fitted) continue;
            // The rigid insertion axis belongs to the trolley handle, not to
            // the posed hand mesh. Both handles are parallel in the frame, while
            // authored hands can carry a few degrees of wrist/mesh rounding.
            // Using the hand axis made a two-handed trolley demand two mutually
            // incompatible rigid translations even though both bores fit the same
            // physical handle direction. The fit test above still bounds that
            // angular mismatch; only the actual handle cylinder is certified.
            const axis = unit(vector(frame.matrix, [0, 0, 1]));
            const centreWorld = point(hand.matrix, gripCentre);
            addEdge(hand, frame, 'mechanical', {
                outward: axis,
                region: contactTube(add(centreWorld, mul(axis, -7)), axis, 14, 7),
            }, false);
        }
    }
    // Cross-scope and phase dependencies are added after the sibling-local walk
    // above, so validate the complete leaf graph once more before returning.
    // A declared dependency that contradicts the anatomical phase must fail
    // explicitly rather than being silently ignored by the backward search.
    const depState = new Map<string, number>();
    const visitDependency = (id: string) => {
        if (depState.get(id) === 1)
            throw new ConstructionError('dependency-cycle', `Dependency cycle at ${id}.`);
        if (depState.get(id) === 2)
            return;
        depState.set(id, 1);
        for (const d of dependencies)
            if (d.child === id && model.parts.has(d.parent))
                visitDependency(d.parent);
        depState.set(id, 2);
    };
    for (const id of model.parts.keys())
        visitDependency(id);
    if (connections.some(c => c.kind === 'anatomical' && !c.outward))
        warnings.push('Some anatomical connections have ordering metadata but no verified insertion-axis profile; candidate directions still undergo full mesh checks.');
    return { connections, dependencies, warnings };
}
