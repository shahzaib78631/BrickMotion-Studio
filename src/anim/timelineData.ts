/** Plain timeline contract, independent of Three.js. The renderer, worker codec
 * and V2 compiler share these types rather than maintaining parallel schemas. */
import type { Box } from '../ldraw/flatten';
import type { Pacing } from './pacing';
import type { ConstructionPlan } from './construction/types';
export type Unit = {
    operationId?: string;
    dependsOn?: number[];
    /** Legacy hardware staging; V2 does not skip assembly this way. */
    preassembled?: string;
    kind: 'piece' | 'attach';
    keys: string[];
    start: number;
    dur: number;
    step: number;
    box?: Box | null;
    /** Where the flight ends (LDU): the spot the camera keeps in frame. */
    land?: Box | null;
    /** Legacy serialized data only; new plans never hide blocked flights. */
    hidden?: boolean;
    /** No route could be certified collision-free; it takes the least-obstructed one. */
    uncertified?: boolean;
    /** Editable Standard Motion preview: even exact pivot kinematics do NOT certify a sweep. */
    motion?: 'hinge' | 'clip' | 'pin-hole' | 'axle-hole' | 'cylindrical' | 'stud-socket' | 'ball-socket' | 'clearance-route' | 'preview';
};
export type SubBuild = {
    key: string;
    name: string;
    closeUp: boolean;
    start: number;
    attachStart: number;
    attachEnd: number;
    focus: Box;
};
export type CamKey = {
    t: number;
    box: Box;
};
export type StepSpan = {
    model: string;
    index: number;
    start: number;
    end: number;
};
/** Exact local DOF between successive posePath[i] -> posePath[i+1].
 * Revolute motion keeps the world-space pivot fixed; prismatic motion never
 * rotates or drifts from the declared axis. All numbers serialize as plain
 * timeline data and are replayed identically by worker, preview and baker. */
export type KinematicSegment = {
    index: number;
    kind: 'revolute' | 'prismatic';
    axis: [number, number, number];
    pivot?: [number, number, number];
    /** Radians for revolute, LDraw units for prismatic. Signed displacement. */
    travel: number;
};
export type MoveData<M> = {
    /** Exact checked polyline, offsets from `from`; only its timing may be eased. */
    translationPath?: [
        number,
        number,
        number
    ][];
    /** Exact checked affine poses for rigid-rotation V2 operations. The source
     * scale/shear/reflection is unchanged; only world rigid motion varies. */
    posePath?: M[];
    /** Joint-space interpolation overrides the indicated posePath segments. */
    kinematicSegments?: KinematicSegment[];
    /** A shared world-rigid delta per waypoint for a V2 assembly operation.
     * Interpolate about `rigidPivot` and apply to `rigidBase` so every member
     * follows the SAME rigid motion through a turn (no per-brick chord shrink). */
    rigidDeltas?: M[];
    rigidBase?: M;
    rigidPivot?: [number, number, number];
    unit: number;
    /** The built group is already in its installed pose; skip the lift and flight. */
    stationary?: boolean;
    from: M;
    to: M;
    rel: M | null;
    skyY: number;
    hold: number;
    entry: [
        number,
        number,
        number
    ];
};
export type TrackData<M> = {
    appear: number;
    floor: M;
    floorBox: Box;
    ctx: number;
    moves: MoveData<M>[];
    final: M;
};
/** Non-certified preview provenance: never present an adaptive fallback as a certified V2 plan. */
export type PlanningFallback = {
    planner: 'construction-v2' | 'construction-v3';
    mode: 'uncertified-preview';
    code: string;
    message: string;
    scope?: string;
    phase?: 'connections' | 'final-contact-audit' | 'route-search' | 'forward-replay' | 'disassembly' | 'validation';
    searchStates?: number;
    peakRemovals?: number;
    peakScopeUnits?: number;
    searchCandidates?: number;
    searchBacktracks?: number;
    /** A few relevant blocker pairs make the failure diagnosable after saving. */
    contacts?: { moving: string; obstacle: string; stage: string }[];
};
/** Phase 4-6 postassembly motion, encoded as rigid world deltas from the
 * exact authored final pose. Standard timeline codec stores it unchanged. */
export type MechanismStage = {
    start: number;
    duration: number;
    frames: number;
    sampleHz: number;
    mode: 'kinematic' | 'gravity';
    /** Conservative interval certificate for rendered triangle surfaces. */
    collisionStatus: 'clear' | 'blocked' | 'unverified';
    tracks: { key: string; deltas: number[][] }[];
    diagnostics: {
      joints: number; gearPairs: number; loopClosures: number; rigidFollowers: number;
      maxClosureErrorLdu: number; physicsSteps: number; approximateInertias: number;
      sampledAabbOverlapAdvisories: number;
      /** Mechanism-induced collisions, not stationary assembly contacts. */
      continuousCollision?: { checkedPairs: number; clearPairs: number; blockedPairs: number;
        unverifiedPairs: number; testedIntervals: number; triangleNodeTests: number;
        staticWitnesses: number; issues: {a:string;b:string;time:number;
          status:'blocked'|'unverified';reason:string}[] };
    };
};
export type TimelineData = {
    /** Optional post-build mechanism demonstration; regular Build is unchanged. */
    mechanismStage?: MechanismStage;
    /** A permissive, non-physics preview; all paths remain editable in the Dope Sheet. */
    motion?: {
        engine: 'standard-motion' | 'standard-motion-v4'; parts: number; articulated: number; review: number;
        /** Advisory AABB checks against installed, staged and simultaneously moving pieces. */
        checked?: number;
        /** Routes with sampled possible obstructions, including legacy/fallback ones. */
        obstructed?: number;
        /** Summed sampled route-overlap severity across reviewed leaves. */
        interferenceScore?: number;
        /** Exact joint-space arcs/axial insertions actually chosen, and leaves
         * whose conflicting installed joint hints prevented such an approach. */
        kinematics?: { pivotArcs: number; axialInsertions: number; overconstrained: number };
        /** A new connected-part assembly order, with per-joint host guides. */
        logical?: { chains: number; strategy: string; attempts: number; order: string[][] };
        /** Capped actionable per-leaf reports; never a collision certificate. */
        issues?: { key: string; unit: number; time: number; blockers: string[]; firstHit?: number;
          status?: 'blocked' | 'unverified'; reason?: string }[];
        /** Per-phase provenance: never promote an unverified path to certified. */
        v4?: {
          version: number; phases: number[];
          planning?: {mode:'mesh-reviewed'|'bounded-preview'; warnings:string[];
            retainedMoves:number; limitedVerification:boolean; deferredRoutes?:number; deferredCertificates?:number};
          graph: { edges: number; rigidClusters: number; constrainedBodies: number; unknownBodies: number };
          mesh: { certified: number; blocked: number; unverified: number; exactChecks: number;
            candidateChecks: number; pairsExamined: number; rerouted: number };
          limits: { rules: number; matches: number; checked: number; adjusted: number; rejected: number;
            conflicts: number; unspecified: number };
          detection?: { scanned:number; described:number; connectors:number; movableJoints:number;
            kinds: Record<'gear'|'turntable'|'hinge'|'axle'|'pin'|'shaft'|'wheel'|'other',number>;
            matchedJoints:number; gearMeshes:number;
            jointDetails: {a:string;b:string;kind:string;motion:'revolute'|'prismatic'|'fixed'|'ball';evidence:'ldcad-shadow'|'turntable-inferred'}[];
            gearDetails: {a:string;b:string;teethA:number;teethB:number;moduleLdu:number;evidence:'inferred-pitch';confidence:'review-required'}[];
            suggestions: {title:string;program:import('./motion/v4/mechanismProgram').MechanismProgram;
              evidence:'ldcad-shadow'|'inferred-gear-mesh';warnings:string[]}[];
            warnings:string[] };
          demonstration?: { mode: 'kinematic' | 'gravity'; bodies: number; frames: number;
            gearPairs: number; loopClosures: number; maxClosureErrorLdu: number;
            collisionStatus: 'clear' | 'blocked' | 'unverified'; approximateInertias: number };
        };
        fallback?: string;
    };
    /** Bump when rigid collision-certification algorithms change. */
    certificationVersion?: number;
    fallback?: PlanningFallback;
    construction?: ConstructionPlan;
    duration: number;
    steps: StepSpan[];
    pacing: Pacing;
    heroOrbit: boolean;
    intro: number;
    buildEnd: number;
    units: Unit[];
    subBuilds: SubBuild[];
    buildBox: Box;
    modelBox: Box;
    sceneBox: Box;
    camKeys: CamKey[];
    ground: number;
};
export type EncMove = Omit<MoveData<number>, 'rel'> & {
    rel: number;
};
export type EncTrack = Omit<TrackData<number>, 'moves'> & {
    moves: EncMove[];
};
export type EncodedTimeline = TimelineData & {
    mats: Float64Array;
    tracks: [
        string,
        EncTrack
    ][];
};
