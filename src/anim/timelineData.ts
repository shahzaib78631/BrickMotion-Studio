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
export type TimelineData = {
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
