/**
 * Standard Motion v4 / phase 1: immutable, model-wide mechanical topology.
 *
 * Shadow snaps describe possible kinematic joints; they do not provide proof
 * of strength, a contact surface, angular stops, or a collision-free sweep.
 * Fixed connections are grouped only for mobility analysis, never silently
 * turned into a single staged/rendered part.
 */
import type { Assembly } from '../../../model/assemble';
import type { MechanicalJoint, MechanicalJointType } from '../../construction/mechanicalConstraintGraph';
import { jointApproachIsCompatible } from '../jointKinematics';
import { recogniseMechanism, type Recognition } from '../mobility/recognise';
import type { JointKind, ScrewJoint } from '../mobility/screw';

type V3 = [number, number, number];
export type MechanismEdge = {
  id: string;
  a: string;
  b: string;
  type: MechanicalJointType;
  motion: MechanicalJoint['motion'];
  centre: V3;
  axis: V3;
  source: 'ldcad-shadow';
  joint: MechanicalJoint;
};
export type Mobility = {
  allowed: boolean;
  dof: 'fixed' | 'revolute' | 'prismatic' | 'ball' | 'unknown';
  primary?: MechanismEdge;
  engaged: string[];
  blockers: string[];
  reason?: string;
};
export type MechanismGraph = {
  readonly edges: readonly MechanismEdge[];
  readonly byBody: ReadonlyMap<string, readonly MechanismEdge[]>;
  readonly rigidClusters: readonly (readonly string[])[];
  readonly uncertainBodies: readonly string[];
  /** Screw-theory bodies, joints and loop mobility behind rigidClusters. */
  readonly recognition?: Recognition;
  mobility(moving: string, host: string, installed: ReadonlySet<string>,
    kind: 'revolute' | 'prismatic'): Mobility;
  isMate(a: string, b: string): boolean;
};
const finite3 = (v: readonly number[]) => v.length === 3 && v.every(Number.isFinite);
const typeDOF = (joint: MechanicalJoint): Mobility['dof'] => joint.motion === 'revolute' ? 'revolute'
  : joint.motion === 'ball' ? 'ball' : joint.motion === 'sliding' ? 'prismatic' : 'fixed';
const pair = (a: string, b: string) => a < b ? `${a.length}:${a}|${b}` : `${b.length}:${b}|${a}`;

/** Joint kind from the screw analysis -> the motion hint the v4 pipeline reads. */
const motionOfKind = (kind: JointKind, own: MechanicalJoint['motion']): MechanicalJoint['motion'] =>
  kind === 'revolute' || kind === 'cylindrical' ? 'revolute' : kind === 'spherical' ? 'ball'
    : kind === 'prismatic' ? 'sliding' : kind === 'fixed' ? 'fixed' : own;

export function buildMotionMechanismGraph(asm: Assembly, hints: readonly MechanicalJoint[]): MechanismGraph {
  const parts = new Set(asm.instances.map(i => i.key));
  const all = new Map<string, MechanismEdge[]>();
  for (const id of parts) all.set(id, []);
  const edges: MechanismEdge[] = [], known = new Set<string>();
  const valid = hints.filter(j => parts.has(j.male) && parts.has(j.female) && j.male !== j.female &&
    finite3(j.centre) && finite3(j.axis) && Math.hypot(...j.axis) >= 0.9 && Number.isFinite(j.engagement) && j.engagement >= 0);
  // Bodies and joints from the connectors' constraint wrenches and the loops
  // they form (mobility/recognise.ts); fixed pairs and locked loops merge.
  const recognition = recogniseMechanism([...parts], valid);
  const pairJoint = new Map<string, ScrewJoint>();
  for (const j of recognition.joints) for (const c of j.connectors) pairJoint.set(c.id, j.joint);
  for (const j of valid) {
    const len = Math.hypot(...j.axis);
    const same = recognition.bodyOf.get(j.male) === recognition.bodyOf.get(j.female);
    const kind = same ? 'fixed' : pairJoint.get(j.id)?.kind;
    const edge: MechanismEdge = { id: j.id, a: j.male, b: j.female, type: j.type,
      motion: kind ? motionOfKind(kind, j.motion) : j.motion, centre: [...j.centre] as V3,
      axis: j.axis.map(x => x / len) as V3, source: 'ldcad-shadow', joint: j };
    edges.push(edge);
    all.get(j.male)!.push(edge); all.get(j.female)!.push(edge);
    known.add(j.male); known.add(j.female);
  }
  const rigidClusters = recognition.bodies.map(b => [...b]).sort((a,b)=>a[0].localeCompare(b[0]));
  const matePairs = new Set(edges.map(e => pair(e.a, e.b)));
  return {
    edges, byBody: all, rigidClusters, recognition, uncertainBodies: [...parts].filter(p => !known.has(p)).sort(),
    isMate: (a, b) => matePairs.has(pair(a,b)),
    mobility(moving, host, installed, kind): Mobility {
      const engaged = (all.get(moving) ?? []).filter(e => installed.has(e.a === moving ? e.b : e.a));
      const primaries = engaged.filter(e => e.a === host || e.b === host);
      const eligible = primaries.filter(e => kind === 'revolute'
        ? (e.motion === 'revolute' || e.motion === 'ball')
        : (e.motion === 'sliding' || ['pin-hole', 'axle-hole', 'stud-socket', 'cylindrical'].includes(e.type)));
      for (const primary of eligible) {
        if (jointApproachIsCompatible(primary.joint, moving, engaged.map(e => e.joint)))
          return { allowed: true, dof: kind, primary, engaged: engaged.map(e => e.id), blockers: [] };
      }
      const offenders = engaged.filter(e => !eligible.includes(e)).map(e => e.id);
      return { allowed: false, dof: 'fixed', engaged: engaged.map(e => e.id),
        blockers: offenders.length ? offenders : primaries.map(e => e.id),
        reason: !primaries.length ? 'No engaged connector matching the host'
          : !eligible.length ? 'The connection has no compatible moving degree of freedom'
          : 'A second installed joint locks or conflicts with the proposed joint' };
    },
  };
}
