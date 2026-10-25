/**
 * Standard Motion is an intentionally *editable preview* assembler. It keeps
 * Standard's staging, scheduling, hierarchy and assembly whenever possible,
 * then proposes joint-aware approach poses using LDCad connector evidence.
 * Unlike Construction V2-V4, its proposed paths are NOT collision certified.
 * When Standard cannot order malformed/ambiguous assembly relationships, a
 * deterministic per-leaf fallback still assembles every valid placed part.
 */
import * as THREE from 'three';
import type { Box } from '../../ldraw/flatten';
import { factorAffine } from '../affineTransform';
import { buildMechanicalConstraintGraph, type MechanicalJoint } from '../construction/mechanicalConstraintGraph';
import { adaptiveClearanceApproaches, clearanceApproaches, connectionApproaches, mechanicalApproaches, type MotionCandidate } from './kinematicCandidates';
import { logicalAssemblyProposals, type LogicalProposal } from './logicalConnections';
import { jointApproachIsCompatible } from './jointKinematics';
import { InstalledRouteIndex, type RouteAssessment } from './routeSelection';
import type { ConstructionModel, ConstructionNode } from '../construction/types';
import { AssemblyPlanningError } from '../assemblyGraph';
import { choosePacing, type AnimOptions } from '../pacing';
import type { PlanningProgress } from '../planning';
import { buildTimeline, flightPose, type Move, type Timeline } from '../timeline';
import type { Unit, TrackData, StepSpan } from '../timelineData';
import { transformBox, unionBox, type Assembly, type Metrics } from '../../model/assemble';
import type { AssemblySpot } from '../../plan/types';

const UP_CLEARANCE = 48;
const WAYPOINTS = 8;
const EPS = 0.00001;
const REVIEW_CAP = 200;

type Pose = THREE.Matrix4;
const translate = (pose: Pose, x: number, y: number, z: number): Pose =>
  new THREE.Matrix4().makeTranslation(x, y, z).multiply(pose);
const atHeight = (pose: Pose, sky: number): Pose => translate(pose, 0, sky - pose.elements[13], 0);

/** Works with connector geometry even when triangle meshes are absent. */
export function jointsFor(asm: Assembly, metrics: Metrics): MechanicalJoint[] {
  const parts = new Map<string, ConstructionNode>();
  for (const inst of asm.instances) {
    parts.set(inst.key, {
      id: inst.key, part: inst.part, model: inst.model, step: 0, order: 0,
      matrix: inst.world.elements.slice() as ConstructionNode['matrix'],
      bounds: inst.worldBox, body: metrics(inst.part).body, leaves: [inst.key],
    });
  }
  const model: ConstructionModel = { nodes: [...parts.values()], parts,
    bounds: asm.bounds ?? { min: [0, -24, 0], max: [20, 0, 20] }, metrics };
  return buildMechanicalConstraintGraph(model).joints;
}

/** Updates the visible camera framing to include newly proposed joint arcs. */
function widenMotionCamera(tl: Timeline, unit: Unit, move: Move, body: Box): void {
  let box: Box | null = unit.box ?? null;
  for (let i = 0; i <= WAYPOINTS * 3; i++) {
    const pose = flightPose(move, i / (WAYPOINTS * 3), new THREE.Matrix4());
    box = unionBox(box, transformBox(body, pose));
  }
  if (!box) return;
  unit.box = box;
  tl.buildBox = unionBox(tl.buildBox, box);
  tl.sceneBox = unionBox(tl.sceneBox, box);
  for (const cam of tl.camKeys) if (cam.t >= unit.start - 0.21 && cam.t <= unit.start + unit.dur + 0.21)
    cam.box = unionBox(cam.box, box);
}

/**
 * Multiple connector-guided and ordinary visual approach routes are sampled
 * against the *already installed* model. Lower-scoring candidates replace
 * Standard's route, and remaining possible overlaps become per-part, clickable
 * review diagnostics. No generated AABB score is a collision certificate.
 */
export function articulateStandardTimeline(tl: Timeline, asm: Assembly, metrics: Metrics,
  guides: Map<string, string> = new Map(), jointHints?: MechanicalJoint[]): Timeline {
  const installed = new Map<string, { firstUnit: number; end: number }>();
  for (const [key, track] of tl.tracks) {
    const first = track.moves[0], last = track.moves.at(-1);
    if (!first || !last) continue;
    const done = tl.units[last.unit];
    if (done) installed.set(key, { firstUnit: first.unit, end: done.start + done.dur });
  }
  const candidates = new Map<string, { joint: MechanicalJoint; other: string }[]>();
  let joints: MechanicalJoint[] = jointHints ?? [];
  if (!jointHints) try { joints = jointsFor(asm, metrics); }
  catch { /* No optional metadata: keep every Standard trajectory editable. */ }
  for (const joint of joints) for (const [key, other] of [[joint.male, joint.female], [joint.female, joint.male]]) {
    const list = candidates.get(key) ?? [];
    list.push({ joint, other }); candidates.set(key, list);
  }
  const byKey = new Map(asm.instances.map(i => [i.key, i]));
  const partByKey = new Map(asm.instances.map(i => [i.key, i.part]));
  const index = new InstalledRouteIndex(asm, tl, metrics);
  let articulated = 0, checked = 0, obstructed = 0, interferenceScore = 0;
  let pivotArcs = 0, axialInsertions = 0, overconstrained = 0;
  const issues: NonNullable<NonNullable<Timeline['motion']>['issues']> = [];
  // Route in time order, then review all tracks AFTER every modification.
  // Otherwise an earlier part can retain a stale collision report about a
  // later part whose route has subsequently moved out of the way.
  const selectedHosts = new Map<string, string>();
  const orderedTracks = [...tl.tracks].sort((a, b) => {
    const av = a[1].moves[0], bv = b[1].moves[0];
    return (av ? tl.units[av.unit]?.start ?? 0 : 0) - (bv ? tl.units[bv.unit]?.start ?? 0 : 0) || a[0].localeCompare(b[0]);
  });
  for (const [key, track] of orderedTracks) {
    const part = partByKey.get(key);
    if (!part || !track.moves.length) continue;
    // Only individual free leaves are articulated; groups and attaches retain
    // their EXACT shared Standard transforms, never break rigid subassemblies.
    const firstMove = track.moves[0];
    const firstUnit = tl.units[firstMove.unit];
    if (!firstUnit) continue;
    const free = (track.ctx ?? 0) === 0 && firstUnit.kind === 'piece' && firstUnit.keys.length === 1 &&
      firstUnit.keys[0] === key && !firstMove.rel && !firstMove.stationary && !firstMove.rigidDeltas?.length;
    if (free) {
      const engaged = (candidates.get(key) ?? []).filter(c => {
        const host = installed.get(c.other);
        return host && host.end <= firstUnit.start + EPS && host.firstUnit !== firstMove.unit;
      });
      // A pivot is not free when another installed connector locks the leaf
      // against that pivot (e.g. a hinge plus an attached stud). Likewise,
      // multiple sliders require parallel axes, and hinges must be coaxial.
      const installedJoints = engaged.map(entry => entry.joint);
      const near = engaged.filter(c => jointApproachIsCompatible(c.joint, key, installedJoints)).sort((a, b) => {
        const rank = (j: MechanicalJoint) => j.type === 'hinge' ? 0 : j.type === 'clip' ? 1 :
          j.type === 'ball-socket' ? 2 : j.type === 'axle-hole' ? 3 : j.type === 'pin-hole' ? 4 : 5;
        return rank(a.joint) - rank(b.joint) || b.joint.engagement - a.joint.engagement;
      }).slice(0, 4);
      if (engaged.length && !near.length) overconstrained++;
      const samples = asm.instances.length > 2500 ? 12 : asm.instances.length > 600 ? 18 : 30;
      // Connector seats may overlap the host's AABB close to the final pose;
      // they may not fly through that host earlier in the route.
      const allowedMate = guides.get(key);
      // Never excuse an early path straight through the mating host: only a
      // close-to-target connector seat is allowed to share its coarse AABB.
      const baseline = index.assess(firstMove, key, part, firstUnit.start, metrics, samples, allowedMate);
      let winner: { candidate: MotionCandidate; assessment: RouteAssessment } | null = null;
      let bestHits = baseline.hits, bestPreference = 0;
      const test = (c: MotionCandidate) => {
        const move: Move = { ...firstMove, translationPath: undefined, posePath: c.poses,
          kinematicSegments: c.kinematicSegments };
        const assessment = index.assess(move, key, part, firstUnit.start, metrics, samples, c.host, true);
        // Prefer real connector pivots to an equally good generic route;
        // never accept a joint hint with MORE AABB interference than Standard.
        if (assessment.hits > bestHits ||
          (assessment.hits === bestHits && c.preference >= bestPreference)) return null;
        bestHits = assessment.hits; bestPreference = c.preference;
        return { candidate: c, assessment };
      };
      for (const { joint } of near) for (const c of mechanicalApproaches(firstMove, joint, key)) winner = test(c) ?? winner;
      // A sequence can be logically connected even without library connector
      // metadata. Bring the new piece in from the unoccupied side of the host.
      const guidedHost = guides.get(key);
      const host = guidedHost ? byKey.get(guidedHost) : undefined;
      if (host && (installed.get(guidedHost!)?.end ?? Infinity) <= firstUnit.start + EPS) {
        const moving = byKey.get(key);
        if (moving) {
          const anatomy = /^(3815|3816|3817)/i.test(moving.part.split('/').pop() ?? '') &&
            /^(3815|3816|3817)/i.test(host.part.split('/').pop() ?? '');
          for (const c of connectionApproaches(firstMove, moving.worldBox, host.worldBox, anatomy))
            winner = test({ ...c, host: guidedHost }) ?? winner;
        }
      }
      if (bestHits > 0) {
        // First try corridors sized to the actual occupied scene. This can
        // clear an obstruction hundreds of LDU tall/wide, where a fixed
        // sidestep would still tunnel through its middle. It also sees parts
        // currently staged or in-flight (the scorer tests their true timing).
        const obstacles = index.obstacleBoxes(firstUnit.start, firstUnit.start + firstUnit.dur, key);
        for (const c of adaptiveClearanceApproaches(firstMove, metrics(part).full, obstacles)) {
          winner = test(c) ?? winner;
          if (bestHits === 0) break;
        }
      }
      if (bestHits > 0 && !winner) {
        // Retain the original inexpensive guesses as a last visual fallback.
        const b = metrics(part).full;
        const extent = Math.max(...[0, 1, 2].map(k => b.max[k] - b.min[k]));
        for (const c of clearanceApproaches(firstMove, extent)) winner = test(c) ?? winner;
      }
      if (winner) {
        firstMove.posePath = winner.candidate.poses;
        firstMove.kinematicSegments = winner.candidate.kinematicSegments;
        if (winner.candidate.kinematicSegments?.some(s => s.kind === 'revolute')) pivotArcs++;
        if (winner.candidate.kinematicSegments?.some(s => s.kind === 'prismatic')) axialInsertions++;
        // flightPose prioritises translationPath before posePath: clear it so
        // the chosen kinematic path is ACTUALLY played/baked/exported.
        firstMove.translationPath = undefined;
        index.noteUpdatedMove(key, firstMove);
        firstUnit.motion = winner.candidate.motion;
        firstUnit.uncertified = true;
        if (winner.candidate.host) {
          if (winner.candidate.motion !== 'clearance-route') articulated++;
          selectedHosts.set(key, winner.candidate.host);
        }
        widenMotionCamera(tl, firstUnit, firstMove, metrics(part).full);
      }
    }
  }
  // Re-evaluate the final, consistent set of flights, including later attach
  // operations, and build diagnostics from ACTUAL chosen playback trajectories.
  for (const [key, track] of orderedTracks) {
    const part = partByKey.get(key);
    const firstMove = track.moves[0];
    if (!part || !firstMove) continue;
    const firstUnit = tl.units[firstMove.unit];
    const mate = selectedHosts.get(key) ?? guides.get(key);
    const installedMate = mate && firstUnit &&
      (installed.get(mate)?.end ?? Infinity) <= firstUnit.start + EPS ? mate : undefined;
    let worst: RouteAssessment | null = null;
    let failedUnit = firstMove.unit;
    for (const move of track.moves) {
      const u = tl.units[move.unit];
      if (!u) continue;
      const samples = asm.instances.length > 2500 ? 12 : 20;
      const guided = move === firstMove && !!installedMate;
      const result = index.assess(move, key, part, u.start, metrics, samples,
        guided ? installedMate : undefined, guided);
      if (result.assessed !== false) checked++;
      if (result.assessed !== false && (!worst || result.hits > worst.hits)) { worst = result; failedUnit = move.unit; }
    }
    if (worst?.hits) {
      obstructed++;
      interferenceScore += worst.hits;
      if (issues.length < REVIEW_CAP) issues.push({
        key, unit: failedUnit, time: tl.units[failedUnit].start +
          (worst.firstHit ?? 0.5) * tl.units[failedUnit].dur,
        blockers: worst.blockers,
        ...(worst.firstHit == null ? {} : { firstHit: worst.firstHit }),
      });
    }
  }
  tl.motion = { engine: 'standard-motion', articulated, parts: tl.tracks.size,
    checked, obstructed, interferenceScore, issues,
    kinematics: { pivotArcs, axialInsertions, overconstrained },
    // There is no triangle-mesh or multibody certification, even on routes
    // whose sampled AABBs appeared clear. All parts remain user-editable.
    review: tl.tracks.size, fallback: tl.motion?.fallback };
  return tl;
}

/**
 * Permissive last resort. No leaf disappears if a support graph has a missing
 * parent, cycle or ambiguous connector. It does NOT claim physical feasibility.
 * Uses 32 reusable floor positions, staggered visibility and per-part moves.
 */
export function buildLooseMotionTimeline(asm: Assembly, metrics: Metrics, opts: AnimOptions, reason: string,
  guides: Map<string, string> = new Map()): Timeline {
  const count = asm.instances.length;
  const modelBox: Box = asm.bounds ?? { min: [0, -24, 0], max: [20, 0, 20] };
  const ground = modelBox.max[1];
  const roots = new Map(asm.nodes.map(node => [node.itemId, node.step]));
  const preferred = asm.instances.map((inst, i) => ({ inst, i, step: roots.get(inst.key.split('/')[0]) ?? 0 }))
    .sort((a, b) => a.step - b.step || a.i - b.i);
  const byId = new Map(preferred.map(x => [x.inst.key, x]));
  // Keep the same connection-first ordering if Standard's graph failed.
  // A cycle or a missing guide never hides an authored part.
  const ordered: typeof preferred = [];
  const visiting = new Set<string>(), added = new Set<string>();
  const append = (key: string) => {
    if (added.has(key) || visiting.has(key)) return;
    const node = byId.get(key);
    if (!node) return;
    visiting.add(key);
    const host = guides.get(key);
    if (host) append(host);
    visiting.delete(key);
    added.add(key); ordered.push(node);
  };
  for (const x of preferred) append(x.inst.key);
  const distinctSteps = [...new Set(ordered.map(x => x.step))];
  const pacing = choosePacing(count, distinctSteps.length, opts);
  const durationPerFlight = pacing.sequential ? Math.max(0.35, pacing.flight) : Math.max(0.28, pacing.flight);
  const intro = pacing.intro;
  const estimatedBuild = Math.max(1, pacing.build);
  const cells = 32;
  const columns = 16;
  const width = ordered.reduce((max, { inst }) => {
    const box = metrics(inst.part).body;
    return Math.max(max, box.max[0] - box.min[0] + 12, box.max[2] - box.min[2] + 12);
  }, 30);
  const centerX = (modelBox.min[0] + modelBox.max[0]) / 2;
  const depth = Math.max(36, width);
  const tracks = new Map<string, TrackData<THREE.Matrix4>>();
  const units: Unit[] = [];
  const stepMap = new Map<number, StepSpan>();
  let sceneBox = modelBox;
  let actualEnd = intro;
  const unitByKey = new Map<string, number>();
  const sky = modelBox.min[1] - UP_CLEARANCE - width;
  for (let i = 0; i < ordered.length; i++) {
    const { inst, step } = ordered[i];
    const group = pacing.mode === 'step' ? distinctSteps.indexOf(step) : pacing.mode === 'batch' ? Math.floor(i / pacing.batchSize) : i;
    const groupCount = pacing.mode === 'step' ? Math.max(1, distinctSteps.length) : pacing.mode === 'batch' ? Math.max(1, Math.ceil(count / pacing.batchSize)) : count;
    const slot = pacing.sequential ? Math.max(pacing.slot, durationPerFlight + 0.05) : estimatedBuild / Math.max(1, groupCount);
    const old = i >= cells ? units[i - cells] : undefined;
    // A recycled staging cell stays occupied until its predecessor has lifted.
    // If many bricks share a STEP, delay the newcomer instead of teleporting it
    // into a floor spot that is still occupied.
    const hostIndex = unitByKey.get(guides.get(inst.key) ?? '');
    const hostEnd = hostIndex === undefined ? intro : units[hostIndex].start + units[hostIndex].dur + 0.05;
    const start = Math.max(intro + group * slot, hostEnd,
      old ? old.start + durationPerFlight * 0.32 + 0.02 : intro);
    const appear = old ? start : -Infinity;
    const factor = factorAffine(inst.world.elements);
    if (!factor) throw new Error(`Cannot animate singular or non-affine placement: ${inst.key}`);
    const shape = new THREE.Matrix4().fromArray(factor.shape);
    const body = transformBox(metrics(inst.part).body, shape);
    const cell = i % cells;
    const col = cell % columns;
    const row = Math.floor(cell / columns);
    const x = centerX + (col - (columns - 1) / 2) * width;
    const z = row === 0 ? modelBox.min[2] - depth * 1.6 : modelBox.max[2] + depth * 1.6;
    const floor = translate(shape, x - (body.min[0] + body.max[0]) / 2, ground - body.max[1], z - (body.min[2] + body.max[2]) / 2);
    const lift = atHeight(floor, sky);
    const cruise = atHeight(inst.world, sky);
    const unit: Unit = { kind: 'piece', keys: [inst.key], start, dur: durationPerFlight, step,
      ...(hostIndex === undefined ? {} : { dependsOn: [hostIndex] }), uncertified: true,
      motion: 'preview' };
    const mv: Move = { unit: i, from: floor, to: inst.world.clone(), rel: null, skyY: sky,
      hold: 0, entry: [0, 0, 0], posePath: [floor.clone(), lift, cruise, inst.world.clone()] };
    const floorBox = transformBox(metrics(inst.part).full, floor);
    tracks.set(inst.key, { appear, floor, floorBox, ctx: 0, moves: [mv], final: inst.world.clone() });
    units.push(unit);
    unitByKey.set(inst.key, i);
    actualEnd = Math.max(actualEnd, start + durationPerFlight);
    sceneBox = unionBox(sceneBox, floorBox);
    const span = stepMap.get(step) ?? { model: '', index: step, start, end: start + durationPerFlight };
    span.start = Math.min(span.start, start); span.end = Math.max(span.end, start + durationPerFlight);
    stepMap.set(step, span);
    let swept: Box | null = null;
    for (let t = 0; t <= WAYPOINTS * 3; t++)
      swept = unionBox(swept, transformBox(metrics(inst.part).full, flightPose(mv, t / (WAYPOINTS * 3), new THREE.Matrix4())));
    unit.box = swept;
    unit.land = transformBox(metrics(inst.part).full, inst.world);
    if (swept) sceneBox = unionBox(sceneBox, swept);
  }
  // Store every position in the camera's build box, including flight arcs.
  const camKeys = [{ t: 0, box: sceneBox }, { t: actualEnd, box: sceneBox }];
  return {
    duration: actualEnd + pacing.outro, intro, buildEnd: actualEnd, ground,
    steps: [...stepMap.values()].sort((a, b) => a.start - b.start || a.index - b.index),
    pacing, heroOrbit: opts.heroOrbit, units, tracks, subBuilds: [],
    modelBox, buildBox: sceneBox, sceneBox, camKeys,
    motion: { engine: 'standard-motion', parts: count, articulated: 0, review: count, fallback: reason.slice(0, 800) },
  };
}

export function buildStandardMotionTimeline(asm: Assembly, metrics: Metrics, opts: AnimOptions,
  onProgress?: (p: PlanningProgress) => void, layoutBox: Box | null = null,
  workBaySpots: Record<string, AssemblySpot> = {},
  /** Internal v4 option. Generate one valid Standard timeline, then let v4
   * score routes once. V3 callers retain the full multi-proposal search. */
  singlePass = false): Timeline {
  // A visual fallback must never conceal duplicate instances or manufacture
  // transforms from corrupt LDraw matrices. Validate BEFORE allowing a broad
  // "Standard failed" recovery so keys aren't silently dropped by Map.set.
  const keys = new Set<string>();
  for (const inst of asm.instances) {
    if (keys.has(inst.key)) throw new AssemblyPlanningError([{ code: 'duplicate-id',
      items: [inst.key], message: `Duplicate visible leaf ${inst.key}. Repair the imported model.` }]);
    keys.add(inst.key);
    if (!factorAffine(inst.world.elements)) throw new AssemblyPlanningError([{ code: 'invalid-transform',
      items: [inst.key], message: `Leaf ${inst.key} has a singular or non-finite authored transform.` }]);
  }
  // Choose the order BEFORE routing, rather than attempting to fly a hub
  // through two sides that Standard has already installed. The unchanged
  // original plan remains a candidate, and every attempt is a cloned graph.
  let joints: MechanicalJoint[] = [];
  try { joints = jointsFor(asm, metrics); } catch { /* Connector-free minifigs still work. */ }
  let proposals: LogicalProposal[] = [];
  try { proposals = logicalAssemblyProposals(asm, joints); }
  catch (error) {
    // V4's large-model fast path is an editable *preview*. Uncertain connector
    // topology must not suppress every LDraw leaf. The normal V3 planner keeps
    // its existing strict failure behavior.
    if (!singlePass) throw error;
  }
  // Every scene size gets its connection-first plan. On huge sets, limit the
  // number of full Standard retries rather than disabling correct ordering.
  const choices: (LogicalProposal | null)[] = singlePass ? [proposals[0] ?? null] : [
    ...proposals.slice(0, asm.instances.length > 3000 ? 1 : asm.instances.length > 1000 ? 2 : 3), null,
  ];
  let best: { timeline: Timeline; score: number; proposal: LogicalProposal | null } | null = null;
  let failed: Error | null = null;
  let tested = 0;
  for (const proposal of choices) {
    try {
      const candidate = buildTimeline(proposal?.assembly ?? asm, metrics, { ...opts, planner: 'legacy' },
        onProgress, layoutBox, workBaySpots);
      if (candidate.tracks.size !== asm.instances.length || asm.instances.some(i => !candidate.tracks.has(i.key)))
        throw new Error('Standard returned an incomplete assembly.');
      const timeline = singlePass ? candidate :
        articulateStandardTimeline(candidate, asm, metrics, proposal?.guides, joints);
      if (singlePass) timeline.motion = { ...timeline.motion, engine: 'standard-motion',
        parts: timeline.tracks.size, articulated: 0, checked: 0, obstructed: 0,
        interferenceScore: 0, issues: [], review: timeline.tracks.size };
      tested++;
      // Prefer short, connected access routes, while allowing a centre-first
      // build when the reverse insertion is significantly less obstructed.
      // Merely tolerating a hub-through-both-sides order as a zero-hit AABB
      // route reintroduces the original minifigure bug. Penalise it heavily.
      const arrival = (key: string) => {
        const mv = candidate.tracks.get(key)?.moves[0];
        return mv ? candidate.units[mv.unit]?.start ?? Infinity : Infinity;
      };
      const isBadLegacy = proposals.some(p => p.chains.some(c => c.kind === 'anatomy' &&
        arrival(c.hub) > Math.max(arrival(c.first), arrival(c.last))));
      const score = (timeline.motion?.interferenceScore ?? 0) +
        (timeline.motion?.obstructed ?? 0) * 8 + (proposal?.preference ?? 0) * 4 +
        (!proposal && isBadLegacy ? 1_000_000 : 0);
      if (!best || score < best.score) best = { timeline, score, proposal };
    } catch (error) {
      if (error instanceof AssemblyPlanningError && error.issues.some(issue =>
        issue.code === 'invalid-transform' || issue.code === 'duplicate-id')) throw error;
      if (!(error instanceof Error)) throw error;
      failed ??= error;
    }
    // The candidate search is bounded; avoid multiple large-scene replans.
    if (asm.instances.length > 350 && best && !best.timeline.motion?.obstructed) break;
  }
  if (!best) {
    onProgress?.({ phase: 'preparing', completed: 0, total: asm.instances.length,
      item: 'No complete Standard order; using a logically sequenced, editable preview' });
    const primary = proposals[0];
    const fallback = buildLooseMotionTimeline(asm, metrics, opts,
      `${failed?.name ?? 'PlanningError'}: ${failed?.message ?? 'No complete build sequence'}`,
      primary?.guides);
    best = { timeline: singlePass ? fallback : articulateStandardTimeline(fallback, asm, metrics, primary?.guides, joints),
      score: Infinity, proposal: primary ?? null };
  }
  if (best.proposal) {
    best.timeline.motion = { ...best.timeline.motion!, logical: {
      chains: best.proposal.chains.length,
      strategy: best.proposal.label,
      attempts: tested,
      order: best.proposal.sequences.slice(0, 6),
    } };
  }
  return best.timeline;
}
