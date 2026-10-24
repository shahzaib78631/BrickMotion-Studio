import type { Box } from '../../ldraw/flatten';
import type { AssemblyHints } from '../../plan/types';
import type { PartMetrics } from '../../ldraw/metrics';
import type { M4, V3 } from './math';
export type ConstructionNode = {
    id: string;
    part?: string;
    model: string;
    step: number;
    order: number;
    matrix: M4;
    bounds: Box;
    body: Box;
    hints?: AssemblyHints;
    children?: ConstructionNode[];
    leaves: string[];
};
export type ConstructionModel = {
    nodes: ConstructionNode[];
    parts: Map<string, ConstructionNode>;
    bounds: Box;
    metrics: (id: string) => PartMetrics;
};
export type ContactRegion = {
    origin: V3;
    axis: V3;
    length: number;
    radius: number;
    minRadius?: number;
};
export type Connection = {
    id: string;
    parent: string;
    child: string;
    kind: 'explicit' | 'stud' | 'anatomical' | 'mechanical' | 'support' | 'surface';
    confidence: 'declared' | 'inferred';
    outward?: V3; /** Directional contact metadata is not a whole-part collision exemption. */
    /** Localised contact regions. `region` is retained for older serialized plans. */
    region?: ContactRegion;
    regions?: ContactRegion[];
    /** Maximum initially-overlapping travel that may be certified as render-mesh surface contact. */
    surfaceTolerance?: number;
    /** The joint separates either way along `outward` (a hinge sliding off its pin), not only outward. */
    axial?: boolean;
    /**
     * Final-pose contact metadata only. A static-only policy may explain why two
     * completed parts touch, but it must never exempt any portion of an animated
     * withdrawal/transport path from collision checking.
     */
    staticOnly?: boolean;
};
export type Dependency = {
    parent: string;
    child: string;
    reason: string;
};
export type PlannerFailureCode = 'invalid-input' | 'unresolved-final-contact' | 'missing-geometry' | 'unknown-connector' | 'ambiguous-connector' | 'dependency-cycle' | 'no-supported-rigid-route' | 'search-budget-exhausted' | 'cancelled' | 'unsupported-articulation' | 'invalid-plan';
export type Blockage = {
    moving: string;
    obstacle: string;
    stage: 'final-placement' | 'withdrawal' | 'transport' | 'floor';
    detail: string;
};
export class ConstructionError extends Error {
    constructor(public code: PlannerFailureCode, message: string, public details: {
        scope?: string;
        blockages?: Blockage[];
        stats?: SearchStats;
        items?: string[];
    } = {}) { super(`${code}: ${message}${details.blockages?.length ? ' Contacts: ' + details.blockages.slice(-4).map(b => `${b.moving} / ${b.obstacle} (${b.stage})`).join('; ') : ''}`); this.name = 'ConstructionError'; }
}
export type SearchStats = {
    states: number;
    candidates: number;
    backtracks: number;
    meshPairs: number;
    trianglePairs: number;
    cacheHits: number;
    milliseconds: number;
};
export type ConstructionOptions = {
    maxStates?: number;
    maxMilliseconds?: number;
    maxCandidates?: number;
    cancelled?: () => boolean;
    onProgress?: (p: {
        phase: 'connections' | 'disassembly' | 'validation';
        completed: number;
        total: number;
        item?: string;
    }) => void; /** First release requires a table or a declared virtual fixture. */
    supportMode?: 'fixture' | 'table';
    mechanicalSubassemblies?: boolean;
    /** Box the automatic work bays are laid out around, when it differs from the model's own
     * (a model moved to its assembly spot with "loose pieces follow" off). */
    layoutBounds?: Box;
};
export type Operation = {
    id: string;
    kind: 'place' | 'connect' | 'attach-subassembly';
    keys: string[];
    scope: string;
    model: string;
    step: number;
    requires: string[];
    connections: string[]; /** World translation offsets relative to the members' exact imported placements. */
    path: V3[];
    /** Optional checked world-rigid deltas, one per `path` waypoint. Each delta
     * left-multiplies every member's exact imported placement. Endpoints remain
     * translation-only so staging/final transforms stay exact. */
    rigidPath?: M4[];
    check: {
        method: 'continuous-triangle-sat';
        contactPolicies: string[];
        support: 'table' | 'connected' | 'virtual-fixture';
    };
};
export type ConstructionPlan = {
    schema: 'brickmotion-construction/v2';
    operations: Operation[];
    parts: {
        key: string;
        part: string;
        final: M4;
        staged: M4;
        bounds: Box;
    }[];
    connections: Connection[];
    dependencies: Dependency[];
    warnings: string[];
    stats: SearchStats;
    ground: number;
    bounds: Box;
    sceneBounds: Box;
    capabilities: {
        rigidTranslation: true;
        rigidRotation: boolean;
        hierarchicalSubassemblies: true;
        articulation: false;
        deformation: false;
        physicalStability: false;
    };
};
