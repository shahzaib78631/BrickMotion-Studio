/**
 * World-space mechanical topology inferred from the LDCad Shadow Library.
 *
 * This graph is NOT a collision certificate or a dynamics solver. A matched
 * profile identifies a plausible joint and its constrained axis; the mesh
 * oracle independently certifies final contacts and all animated sweeps.
 * Unknown, orthogonal, or physically oversized profiles remain unresolved.
 */
import { possibleFinalContacts } from './contactBroadphase';
import { dot, mul, norm, sub } from './math';
import type { V3 } from './math';
import { mateAxis, worldSnaps, type WorldSnap } from '../snapMates';
import { profiledCylinderMate } from './profiledCylinderMate';
import type { ConstructionModel, Connection, ContactRegion, ConstructionNode } from './types';

export type MechanicalJointType = 'stud-socket' | 'pin-hole' | 'axle-hole' | 'hinge' | 'clip' | 'ball-socket' | 'cylindrical';
export type MechanicalJoint = {
  id: string;
  male: string;
  female: string;
  type: MechanicalJointType;
  axis: V3;
  centre: V3;
  engagement: number;
  /** Kinematic hint, not evidence that the final model can be articulated safely. */
  motion: 'fixed' | 'sliding' | 'revolute' | 'ball';
  /** A tightly scoped contact tube, only for exact profiled cylindrical mates. */
  region?: ContactRegion;
};
export type MechanicalConstraintGraph = {
  joints: MechanicalJoint[];
  /** Static-only proposals; the collision oracle must still verify each contact. */
  connections: Connection[];
  pairsExamined: number;
  matesByPair: Map<string, MechanicalJoint[]>;
  snapsByPart: Map<string, WorldSnap[]>;
};
const key = (a: string,b: string) => a < b ? `${a.length}:${a}${b.length}:${b}` : `${b.length}:${b}${a.length}:${a}`;
const unitAxis = (axis: readonly number[]): V3 => [axis[0],axis[1],axis[2]];
const typeOf = (a: WorldSnap, b: WorldSnap): MechanicalJointType => {
  const snaps = [a.snap,b.snap];
  if (snaps.some(s=>s.kind==='gen')) return 'ball-socket';
  if (snaps.some(s=>s.kind==='fgr')) return 'hinge';
  if (snaps.some(s=>s.kind==='clp')) return 'clip';
  if (snaps.some(s=>s.shapes.includes('A'))) return 'axle-hole';
  const male=snaps.find(s=>s.gender==='M')!;
  if (male.radius >= 5.2 && male.radius <= 6.6 && male.length <= 8.2) return 'stud-socket';
  if (male.radius <= 5.5 && male.length >= 5) return 'pin-hole';
  return 'cylindrical';
};
const motionOf = (type: MechanicalJointType, a: WorldSnap, b: WorldSnap): MechanicalJoint['motion'] => {
  if (type === 'ball-socket') return 'ball';
  if (type === 'hinge' || type === 'clip') return 'revolute';
  if (a.snap.slide || b.snap.slide) return 'sliding';
  return 'fixed';
};
const centreOf = (a: WorldSnap,b: WorldSnap): V3 => [0,1,2].map(k=>
  (a.start[k]+a.axis[k]*a.snap.length/2+b.start[k]+b.axis[k]*b.snap.length/2)/2) as V3;

/** Caches world-space shadow snaps ONCE and examines only nearby AABB pairs. */
export function buildMechanicalConstraintGraph(model: ConstructionModel, pulse: () => void = () => {}): MechanicalConstraintGraph {
  const snapsByPart = new Map<string, WorldSnap[]>();
  for (const node of model.parts.values()) {
    pulse();
    snapsByPart.set(node.id, node.part ? worldSnaps(model.metrics(node.part).snaps,node.matrix) : []);
  }
  const joints: MechanicalJoint[] = [], matesByPair = new Map<string, MechanicalJoint[]>();
  const directed = new Map<string, {parent:string;child:string;regions:ContactRegion[];axes:V3[]}>();
  let pairsExamined=0, comparisons=0;
  for (const [a,b] of possibleFinalContacts([...model.parts.values()])) {
    pulse(); pairsExamined++;
    const aa=snapsByPart.get(a.id)??[], bb=snapsByPart.get(b.id)??[];
    if (!aa.length||!bb.length) continue;
    const found: MechanicalJoint[] = [];
    for (const x of aa) for (const y of bb) {
      if ((++comparisons & 255) === 0) pulse();
      let region:ContactRegion|undefined;
      const profiled = profiledCylinderMate(x,y);
      const axis=profiled?.axis ?? (x.snap.kind!=='cyl' || y.snap.kind!=='cyl' ? mateAxis(x,y) : null);
      if (!axis) continue;
      const male = x.snap.gender==='M' ? a : b, female=male===a?b:a;
      if (profiled) region={origin:profiled.origin,axis:profiled.axis,length:profiled.length,radius:profiled.radius+0.2};
      const type=typeOf(x,y);
      const joint:MechanicalJoint={id:`joint:${male.id}:${female.id}:${found.length}`,male:male.id,female:female.id,type,axis:unitAxis(axis),centre:profiled ? [0,1,2].map(k=>profiled.origin[k]+profiled.axis[k]*profiled.length/2) as V3:centreOf(x,y),engagement:profiled?.length??0,motion:motionOf(type,x,y),...(region?{region}:{})};
      found.push(joint); joints.push(joint);
      if (!region) continue;
      const dkey=`${male.id.length}:${male.id}${female.id.length}:${female.id}`;
      const entry=directed.get(dkey)??{parent:female.id,child:male.id,regions:[],axes:[]};
      entry.regions.push(region);
      entry.axes.push(mul(joint.axis,-1)); // male withdraws opposite its insertion axis
      directed.set(dkey,entry);
    }
    if (found.length) matesByPair.set(key(a.id,b.id),found);
  }
  const connections:Connection[]=[];
  for (const entry of directed.values()) {
    // Multiple differently-oriented connectors mean no single insertion axis;
    // do not invent one, even if individual profiles mate perfectly.
    const axis=entry.axes.every(a=>dot(a,entry.axes[0])>0.999)
      ? entry.axes[0] : undefined;
    connections.push({id:`profiled:${entry.parent.length}:${entry.parent}:${entry.child}`,
      parent:entry.parent, child:entry.child, kind:'mechanical',confidence:'inferred',
      ...(axis?{outward:axis}:{}),regions:entry.regions,staticOnly:true});
  }
  return {joints,connections,pairsExamined,matesByPair,snapsByPart};
}

/** Human-readable evidence for a rejected final contact. NEVER changes collision rules. */
export function explainMissingMechanicalMate(a: ConstructionNode,b: ConstructionNode,graph: MechanicalConstraintGraph): string {
  if (graph.matesByPair.has(key(a.id,b.id)))
    return 'Compatible connection metadata exists. A separate triangle-mesh check is required before this contact can be certified.';
  const aa=graph.snapsByPart.get(a.id)??[],bb=graph.snapsByPart.get(b.id)??[];
  if (!aa.length||!bb.length) return 'One or both parts have no LDCad Shadow Library connector definitions.';
  let alignedOpposite=false, coaxialSame=false, nearest=Infinity, nonparallel=true;
  for (const x of aa) for(const y of bb) {
    const cosine=Math.abs(dot(x.axis,y.axis));
    if(cosine<Math.cos(Math.PI/45)) continue;
    nonparallel=false;
    const delta=sub(y.start as V3,x.start as V3);
    const projection=dot(delta,x.axis);
    const off=norm(sub(delta as V3,mul(x.axis as V3,projection)));
    nearest=Math.min(nearest,off);
    if(off>1.2) continue;
    if(x.snap.gender===y.snap.gender) coaxialSame=true;
    else alignedOpposite=true;
  }
  if (alignedOpposite) return 'Coaxial male/female connectors are present, but their engaged section profiles or axial ranges are incompatible. Check exact part placement and geometry.';
  if(coaxialSame) return 'Nearby coaxial connectors have the same gender and cannot mate; another intermediate connector or a corrected placement is needed.';
  if(nonparallel) return 'The available connector axes do not align at this final pose; an articulated joint or a corrected placement may be required.';
  return `Nearby connector axes are offset by at least ${nearest.toFixed(2)} LDU (supported matching tolerance: 1.20 LDU).`;
}
