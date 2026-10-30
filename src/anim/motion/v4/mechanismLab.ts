/**
 * Mechanism Lab: fast, on-demand analysis of the *assembled* viewport.
 *
 * Reuses the same LDCad connector matcher, rigid-body graph, automatic pitch
 * detector and bounded solver as Standard Motion V4, without first planning
 * or rewriting any construction flights. All evidence remains provisional.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import type { ConstructionModel, ConstructionNode } from '../../construction/types';
import { buildMechanicalConstraintGraph } from '../../construction/mechanicalConstraintGraph';
import { buildMotionMechanismGraph, type MechanismGraph } from './mechanismGraph';
import { refineKnownMechanicalJoints, detectAutomaticMechanics, MAX_SUGGESTIONS, type AutoMechanicsReport } from './autoMechanics';
import { MechanismSolver } from './mechanismSolver';
import type { MechanismProgram } from './mechanismProgram';
import { screenMechanismGeometry, type GeometryCandidate } from '../spatial/geometryScreen';
import { worldGear } from '../gears/gearTable';
import { libraryConnectors, withLibraryConnectors } from '../parts/libraryConnectors';
import { suggestRackSteering } from './drivetrainSuggestions';
import type { WorldGear } from '../gears/gearGeometry';

export type LabReport = {
  graph: MechanismGraph;
  detection: AutoMechanicsReport;
  pairsExamined: number;
  connectorPairs: number;
  missingMetadata: number;
  geometryCandidates: GeometryCandidate[];
};

/** A safety bound for an interactive inspector; full V4 planning supports larger assemblies. */
export const MAX_LAB_PARTS = 2500;

export function inspectMechanisms(asm: Assembly, metrics: Metrics): LabReport {
  if (asm.instances.length > MAX_LAB_PARTS) throw new Error(
    `Mechanism Lab is limited to ${MAX_LAB_PARTS.toLocaleString()} displayed parts. Open a submodel or use the full V4 planner.`);
  const nodes: ConstructionNode[] = asm.instances.map((i, order) => ({
    id: i.key, part: i.part, model: i.model, step: 0, order,
    matrix: [...i.world.elements], bounds: i.worldBox, body: metrics(i.part).body,
    leaves: [i.key],
  }));
  const model: ConstructionModel = {
    nodes,
    parts: new Map(nodes.map(n => [n.id, n])),
    bounds: asm.bounds ?? { min: [0, 0, 0], max: [0, 0, 0] },
    metrics,
  };
  const matched = buildMechanicalConstraintGraph(model);
  // LDCad connectors, plus slides and seats measured from part geometry.
  const known = refineKnownMechanicalJoints(matched.joints, asm);
  const graph = buildMotionMechanismGraph(asm, withLibraryConnectors(known, libraryConnectors(asm, metrics, known)));
  const detection = detectAutomaticMechanics(asm, metrics, graph);
  const measured = new Map(asm.instances.flatMap(i => { const g = worldGear(i.key, i.part, i.world); return g ? [[i.key, g] as [string, WorldGear]] : []; }));
  const geometryCandidates = screenMechanismGeometry(detection.parts,
    new Map(asm.instances.map(i=>[i.key,i.worldBox])),graph.rigidClusters,measured);
  // Whole drive trains built from measured meshes come first: they are the
  // model's purpose-built functions, not incidental hinges.
  detection.suggestions.unshift(...suggestRackSteering(asm, graph, geometryCandidates, measured));
  detection.suggestions.splice(MAX_SUGGESTIONS);
  return {
    graph,detection,geometryCandidates,
    pairsExamined: matched.pairsExamined,
    connectorPairs: matched.matesByPair.size,
    missingMetadata: asm.instances.filter(i => !(metrics(i.part).snaps?.length)).length,
  };
}

/**
 * Solve one live frame including welded followers. The solver is passed in so
 * slider drags/RAF ticks do not rebuild its joint topology or lose IK continuity.
 * No source placements, build tracks or rendered geometry are modified here.
 */
export function solveLabFrame(solver: MechanismSolver, position: number,
  additionalInputs: Readonly<Record<string,number>> = {},
  engagements: Readonly<Record<string,boolean>> = {}): Map<string, THREE.Matrix4> {
  const frame = Object.keys(additionalInputs).length || Object.keys(engagements).length
    ? solver.solveInputs({ ...additionalInputs, [solver.driver]: position },{engagements})
    : solver.solve(position);
  const poses = new Map(frame.poses);
  for (const follower of solver.program.rigidFollowers ?? []) {
    const leaderPose = poses.get(follower.leader);
    const leaderRest = solver.rest.get(follower.leader);
    if (!leaderPose || !leaderRest) throw new Error(`Missing rigid leader ${follower.leader}`);
    const delta = leaderPose.clone().multiply(leaderRest.clone().invert());
    for (const key of follower.bodies) {
      const original = solver.rest.get(key);
      if (!original) throw new Error(`Missing rigid follower ${key}`);
      poses.set(key, delta.clone().multiply(original));
    }
  }
  return poses;
}

/** Data-only inspection export; no browser UI state or circular graph structures. */
export function mechanismReportJson(report: LabReport, modelName: string): string {
  return JSON.stringify({
    format: 'brickmotion-mechanism-report', version: 1, modelName,
    counts: {
      parts: report.detection.scanned,
      described: report.detection.described,
      withConnectors: report.detection.connectors,
      examinedPairs: report.pairsExamined,
      matchedPairs: report.connectorPairs,
      unmatchedMetadata: report.missingMetadata,
      rigidGroups: report.graph.rigidClusters.length,
    },
    kinds: report.detection.kinds,
    classifiedParts: report.detection.parts,
    joints: report.detection.joints,
    // The viewport list and detector summaries are intentionally bounded;
    // unlike those previews, this export retains every inferred connection.
    connections: report.graph.edges.map(e => ({
      id: e.id, a: e.a, b: e.b, type: e.type, motion: e.motion,
      axis: e.axis, centre: e.centre, source: e.source,
    })),
    gearPairs: report.detection.gearMeshes,
    functionalHints: report.detection.functionalHints,
    geometryCandidates: report.geometryCandidates,
    suggestions: report.detection.suggestions,
    unconnected: report.graph.uncertainBodies,
    warnings: report.detection.warnings,
    disclaimer: 'Connection and gear engagement hints are not verified dynamics or collision clearance.',
  }, null, 2);
}

/** Graphviz text for external diagnosis / educational diagrams. */
export function mechanismReportDot(report: LabReport): string {
  const quote = (s: string) => JSON.stringify(s);
  const lines = ['graph BrickMotion {', '  graph [overlap=false, splines=true];', '  node [shape=box];'];
  for (const e of report.graph.edges) lines.push(
    `  ${quote(e.a)} -- ${quote(e.b)} [label=${quote(`${e.type} / ${e.motion}`)}];`);
  for (const p of report.graph.uncertainBodies) lines.push(`  ${quote(p)} [style=dashed];`);
  for (const g of report.geometryCandidates.filter(c=>c.status==='plausible')) lines.push(
    `  ${quote(g.a)} -- ${quote(g.b)} [style=dashed, color=blue, label=${quote(`${g.kind} (V6 screened, unverified)`)}];`);
  for (const g of report.detection.gearMeshes) lines.push(
    `  ${quote(g.a)} -- ${quote(g.b)} [style=dotted, color=orange, label=${quote(`${g.teethA}:${g.teethB} (inferred)`)}];`);
  return [...lines, '}'].join('\n');
}

export function previewAmplitude(program: MechanismProgram): number {
  // Small by default so an inferred mechanism is not assumed to tolerate full turns.
  const joint = program.joints.find(j => j.id === program.driver.joint);
  const fallback = joint?.kind === 'prismatic' ? 8 : Math.PI / 12;
  // Assembled drive trains are solved over their whole travel before they are
  // offered (rack kept on its teeth, loop closed), so their range is known.
  if (program.rackContacts?.length && Number.isFinite(program.driver.amplitude) && program.driver.amplitude > 0)
    return Math.min(program.driver.amplitude, joint?.kind === 'prismatic' ? 50 : Math.PI / 2);
  return fallback;
}
