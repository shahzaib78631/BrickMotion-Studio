/**
 * Mechanism Lab: fast, on-demand analysis of the *assembled* viewport.
 *
 * Reuses the same LDCad connector matcher, rigid-body graph, automatic pitch
 * detector and bounded solver as Standard Motion V4, without first planning
 * or rewriting any construction flights. All evidence remains provisional.
 */
import { findShiftElements, type ShiftElement } from '../gearbox/shiftElements';
import { rateNetwork, type RateNetwork } from '../gearbox/shiftModes';
import { recognizeVehicle, type Vehicle } from '../vehicle/vehicle';
import { steeringFor } from '../vehicle/vehicleReport';
import { vehicleSuggestion } from '../vehicle/vehiclePlayback';
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import type { ConstructionModel, ConstructionNode } from '../../construction/types';
import { buildMechanicalConstraintGraph } from '../../construction/mechanicalConstraintGraph';
import { buildMotionMechanismGraph, type MechanismGraph } from './mechanismGraph';
import { refineKnownMechanicalJoints, detectAutomaticMechanics, rankSuggestions, type AutoMechanicsReport } from './autoMechanics';
import { MechanismSolver } from './mechanismSolver';
import type { MechanismProgram } from './mechanismProgram';
import { screenMechanismGeometry, type GeometryCandidate } from '../spatial/geometryScreen';
import { worldGear } from '../gears/gearTable';
import { libraryConnectors, withLibraryConnectors } from '../parts/libraryConnectors';
import { findLinearActuators } from '../parts/actuators';
import { findHigherPairs, type HigherPair } from '../pairs/higherPairs';
import type { ToleratedFit } from '../../construction/toleratedFit';
import type { MechanicalJoint } from '../../construction/mechanicalConstraintGraph';
import { suggestRackSteering } from './drivetrainSuggestions';
import { classify } from '../classify/patterns';
import { suggestMechanisms } from '../classify/suggest';
import type { WorldGear } from '../gears/gearGeometry';

export type LabReport = {
  graph: MechanismGraph;
  detection: AutoMechanicsReport;
  pairsExamined: number;
  connectorPairs: number;
  missingMetadata: number;
  geometryCandidates: GeometryCandidate[];
  /** Gear, bevel, rack, worm and screw pairs between bodies, from measured part features. */
  higherPairs: HigherPair[];
  /** Fits accepted only within a tolerance, worst first: what to correct in the model file. */
  tolerances: TolerancedPair[];
  /** Driving rings with their clutch gears, and the gear network the mode table is read from (spec §4). */
  gearbox: { shifts: ShiftElement[]; network: RateNetwork };
  /** The model as a vehicle (spec §5), or null: fewer than three ground wheels on two axles. */
  vehicle: Vehicle | null;
};
/** One part pair's accepted placement errors. */
export type TolerancedPair = { a: string; b: string; partA: string; partB: string; fits: ToleratedFit[] };
/**
 * A gear mesh error above this is listed. Pitch radii are measured from the
 * part's teeth, so a small error may be ours rather than the file's.
 */
const REPORT_MESH_LDU = 0.5;

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
  const measuredJoints = libraryConnectors(asm, metrics, known);
  const graph = buildMotionMechanismGraph(asm, withLibraryConnectors(known, measuredJoints));
  const screws = findLinearActuators(asm, measuredJoints);
  const higherPairs = findHigherPairs(asm, graph.recognition?.bodyOf, screws);
  const detection = detectAutomaticMechanics(asm, metrics, graph);
  const measured = new Map(asm.instances.flatMap(i => { const g = worldGear(i.key, i.part, i.world); return g ? [[i.key, g] as [string, WorldGear]] : []; }));
  const geometryCandidates = screenMechanismGeometry(detection.parts,
    new Map(asm.instances.map(i=>[i.key,i.worldBox])),graph.rigidClusters,measured);
  // Whole functions come first: the model's purpose-built mechanisms, named
  // from its loops and meshes, not incidental hinges. Rack steering assembled
  // from measured meshes leads, as it was built for the model's steering.
  const steering = suggestRackSteering(asm, graph, geometryCandidates, measured)
    .map(s => ({ ...s, mechanism: { kind: 'rack-steering', name: s.title } }));
  const named = graph.recognition ? classify(graph.recognition, higherPairs, screws, asm, metrics) : [];
  const rec = graph.recognition;
  const gearbox = rec ? { shifts: findShiftElements(asm, rec), network: rateNetwork(rec, higherPairs, named, asm) }
    : { shifts: [], network: { meshes: [], locks: [] } };
  detection.suggestions = rankSuggestions([...steering, ...suggestMechanisms(asm, graph, named, higherPairs, screws, gearbox), ...detection.suggestions]);
  // The vehicle shares its steering suggestion's driver, so it joins after ranking (never merged away), just after that suggestion.
  const vehicle = rec ? recognizeVehicle(asm, rec, named, metrics) : null;
  const steer = vehicle ? steeringFor(vehicle, detection.suggestions) : undefined;
  if (vehicle && steer) detection.suggestions.splice(detection.suggestions.indexOf(steer) + 1, 0, vehicleSuggestion(vehicle, steer));
  return {
    graph,detection,geometryCandidates,higherPairs,gearbox,vehicle,
    tolerances: toleratedPairs(asm, withLibraryConnectors(known, measuredJoints), higherPairs),
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

/** Every accepted placement error, grouped per part pair, worst (closest to its limit) first. */
export function toleratedPairs(asm: Assembly, joints: readonly MechanicalJoint[], pairs: readonly HigherPair[]): TolerancedPair[] {
  const part = new Map(asm.instances.map(i => [i.key, i.part.replace(/\.dat$/, '')]));
  const byPair = new Map<string, TolerancedPair>();
  const add = (a: string, b: string, fits: readonly ToleratedFit[]) => {
    if (!fits.length) return;
    const [x, y] = a < b ? [a, b] : [b, a], k = `${x}|${y}`;
    const entry = byPair.get(k) ?? byPair.set(k, { a: x, b: y, partA: part.get(x) ?? x, partB: part.get(y) ?? y, fits: [] }).get(k)!;
    for (const f of fits) if (!entry.fits.some(e => e.rule === f.rule && Math.abs(e.measured - f.measured) < 1e-6)) entry.fits.push(f);
  };
  for (const j of joints) add(j.male, j.female, j.tolerated ?? []);
  for (const p of pairs) if (p.allowedLdu && (p.errorLdu ?? 0) > REPORT_MESH_LDU) add(p.a, p.b, [{ rule: 'mesh-error', measured: p.errorLdu!, allowed: p.allowedLdu, unit: 'LDU',
    detail: `${p.kind} mesh ${p.errorLdu!.toFixed(2)} LDU from exact (accepted up to ${p.allowedLdu}); check the spacing between the two gears, or our measured pitch for these parts` }]);
  const worst = (t: TolerancedPair) => Math.max(...t.fits.map(f => f.measured / f.allowed));
  return [...byPair.values()].sort((p, q) => worst(q) - worst(p));
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
    // Placement errors we accepted: correct these in the model file.
    tolerances: report.tolerances,
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
