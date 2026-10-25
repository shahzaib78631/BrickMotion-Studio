/**
 * Construction V4 data model.
 *
 * V4 plans a global scene of rigid clusters. A cluster is either one part or a
 * physically inseparable module (tyre/rim, preformed hose). Joint metadata is
 * derived from LDCad connectors and used for articulated removal paths; it is
 * never a collision permission. Every accepted movement carries a proof and is
 * re-checked by forward replay.
 */
import type { Box } from '../../../ldraw/flatten';
import type { V3, M4 } from '../math';
import type { ConstructionPlan, ContactRegion, Operation, SearchStats } from '../types';

export type ClusterId = number;
export type JointId = number;

export type ClusterModule = 'part' | 'wheel' | 'hose' | 'shaft' | 'fixed' | 'subassembly' | 'other';

export type V4Cluster = {
    id: ClusterId;
    key: string;
    name: string;
    leaves: string[];
    parts: string[];
    model: string;
    step: number;
    order: number;
    bounds: Box;
    body: Box;
    module: ClusterModule;
};

export type V4JointKind = 'fixed' | 'revolute' | 'prismatic' | 'cylindrical' | 'ball' | 'gear';

export type V4Joint = {
    id: JointId;
    a: ClusterId;
    b: ClusterId;
    kind: V4JointKind;
    /** World unit axis and pivot at the authored final pose. */
    axis: V3;
    pivot: V3;
    min: number;
    max: number;
    /** Joint-specific localized material allowance, if one was measured. */
    region?: ContactRegion;
    evidence: string;
    confidence: 'declared' | 'inferred';
    ratio?: number;
};

export type V4Proof = {
    kind: 'translation' | 'arc' | 'chain' | 'interface';
    pairs: number;
    detail: string;
};

export type V4Removal = {
    /** One or more clusters removed together as a held rigid workpiece. */
    clusters: ClusterId[];
    /** Forward-construction waypoints in world rigid deltas from the authored final pose. */
    poses: M4[];
    proof: V4Proof;
    support: Operation['check']['support'];
    /** True when the first waypoints are a joint arc used to free the part. */
    articulated?: boolean;
    /** World pivot of that joint arc, used by the animation compiler. */
    pivot?: V3;
};

export type V4Stats = SearchStats & {
    clusters?: number;
    joints?: number;
    modules?: number;
    actions?: number;
    translations?: number;
    translationPairs?: number;
    arcCertificates?: number;
    arcPairs?: number;
    articulatedCandidates?: number;
    supportRejects?: number;
    stagingRoutes?: number;
    groupRemovals?: number;
    replayFailures?: number;
    deepest?: number;
    remainingByStep?: Record<string, number>;
    remainingUnits?: number;
    forwardFailure?: string;
    finalSurfaceContacts?: number;
    unresolvedFinalContacts?: number;
    peakInstalled?: number;
};

export type V4Plan = ConstructionPlan & {
    v4: {
        clusters: V4Cluster[];
        joints: V4Joint[];
        removals: V4Removal[];
        stats: V4Stats;
    };
};

export type V4Options = {
    maxMilliseconds?: number;
    maxStates?: number;
    maxActions?: number;
    maxTranslationPairs?: number;
    maxArcPairs?: number;
    /** Maximum candidates tried in one search state (deterministic depth cut). */
    maxCandidatesPerState?: number;
    /** Diagnostic: print every route attempt for this cluster key. */
    debugCluster?: string;
    /** Final fallback: lift the whole remaining workpiece if it is this small. */
    maxGroupLeaves?: number;
    cancelled?: () => boolean;
    onProgress?: (p: {
        phase: 'connections' | 'disassembly' | 'validation';
        completed: number;
        total: number;
        item?: string;
    }) => void;
    supportMode?: 'fixture' | 'table';
    /** Box the staging area is laid out around (same semantics as V2/V3). */
    layoutBounds?: Box;
};
