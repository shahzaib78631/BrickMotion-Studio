/**
 * V4 joint graph.
 *
 * Converts the existing LDCad-derived mechanical hints into directed, typed
 * joints between clusters. The metadata is a *kinematic proposal*: a joint can
 * only move after the motion certificate validates the arc against the whole
 * scene. Stud/socket geometry is retained as a fixed attachment for support,
 * not as a collision exemption.
 */
import { norm, unit } from '../../math';
import type { V3 } from '../../math';
import type { MechanicalConstraintGraph } from '../../mechanicalConstraintGraph';
import type { ConstructionModel } from '../../types';
import type { V4Joint, V4JointKind } from '../types';

function kindFor(type: string, motion: string): V4JointKind | undefined {
    if (type === 'hinge' || type === 'clip') return 'revolute';
    if (type === 'axle-hole' || type === 'pin-hole') return 'cylindrical';
    if (type === 'cylindrical') return motion === 'sliding' ? 'cylindrical' : 'revolute';
    if (type === 'ball-socket') return undefined; // rims/plugs are misclassified; no global ball motions
    if (type === 'stud-socket') return 'fixed';
    return undefined;
}

export function buildJointGraph(graph: MechanicalConstraintGraph, leafToCluster: Map<string, number>): V4Joint[] {
    const joints: V4Joint[] = [];
    const seen = new Set<string>();
    for (const j of graph.joints) {
        const a = leafToCluster.get(j.female), b = leafToCluster.get(j.male);
        if (a === undefined || b === undefined || a === b) continue;
        const kind = kindFor(j.type, j.motion);
        if (!kind) continue;
        const axis = unit(j.axis);
        if (!axis.every(Number.isFinite) || norm(axis) < 1e-8) continue;
        const pivot = j.centre;
        if (!pivot.every(Number.isFinite)) continue;
        const key = `${a}:${b}:${kind}:${axis.map(v => v.toFixed(4)).join(',')}:${pivot.map(v => v.toFixed(2)).join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const fixed = kind === 'fixed';
        const prismatic = kind === 'prismatic';
        const cylindrical = kind === 'cylindrical';
        const span = Math.max(2, j.engagement || 8);
        joints.push({
            id: joints.length, a, b, kind, axis: axis as V3, pivot: pivot as V3,
            min: fixed ? 0 : prismatic || cylindrical ? -Math.max(8, span * 2) : -Math.PI,
            max: fixed ? 0 : prismatic || cylindrical ? Math.max(8, span * 2) : Math.PI,
            ...(j.region ? { region: j.region } : {}),
            evidence: `${j.type}/${j.motion}`,
            confidence: j.engagement > 0 ? 'declared' : 'inferred',
        });
    }
    return joints;
}
