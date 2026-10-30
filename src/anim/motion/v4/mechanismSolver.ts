/** Phase 4: deterministic hierarchical FK, gear ratios, and closed-chain IK.
 * Unsupported or inconsistent constraints fail closed. No geometry-only guess
 * is promoted to an authoritative joint or gear engagement.
 *
 * The numerics run on the unified kinematic solver (kinematics/): joints are
 * coordinates, closures and rack contacts are equations with analytic
 * Jacobians, gears and transmissions are laws, stops are an active set, and
 * the driver move is continued on one branch. This class keeps the program
 * validation, the engagement checks and the error messages.
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import type { JointLimitRule } from './jointLimits';
import type { MechanismProgram, JointDrive, Vec3 } from './mechanismProgram';
import { validateMechanismProgram } from './mechanismProgram';
import { prepareTransmissionEquations, intoRootEquation, projectLinearConstraints,
  type LinearEquation } from './transmissionNetwork';
import { KinematicSystem, type Equation, type State } from '../kinematics/system';
import { solve as solveKinematics } from '../kinematics/solve';
import type { Inequality, Law } from '../kinematics/laws';
import type { Frame } from '../kinematics/rigid';
import { UNIT as LDU_PER_RAD } from '../mobility/screw';

const UNIT = (v: Vec3) => new THREE.Vector3(...v).normalize();
const at = (p: Vec3) => new THREE.Matrix4().makeTranslation(...p);
const finiteMatrix = (m: THREE.Matrix4) => m.elements.every(Number.isFinite);
const localPoint = (m: THREE.Matrix4, p: Vec3) => new THREE.Vector3(...p).applyMatrix4(m);
/** Column-major, as three.js stores it. */
const toMatrix = (f: Frame) => new THREE.Matrix4().fromArray([
  f.R[0], f.R[3], f.R[6], 0, f.R[1], f.R[4], f.R[7], 0, f.R[2], f.R[5], f.R[8], 0, f.p[0], f.p[1], f.p[2], 1]);
export const LDU_METRES = 0.0004;

export type SolvedFrame = {
  /** All configured animated bodies, in assembled-world LDraw coordinates. */
  poses: Map<string, THREE.Matrix4>;
  /** Relative joint coordinates, rad for hinges or LDU for slides. */
  joints: Map<string, number>;
  maxClosureErrorLdu: number;
  /** Independent closure gaps, in the same order as program.closures. */
  closureErrorsLdu: number[];
  /** Max normalized algebraic transmission error, when V5 constraints are used. */
  transmissionResidual?: number;
  activeTransmissions?: number;
  /** Rolling error of each rack contact, in program.rackContacts order. */
  rackContactErrorsLdu?: number[];
};

type RootRatio = { root: string; ratio: number };

/** The tree order is established once; no runtime dependence on object-key order. */
export class MechanismSolver {
  readonly program: MechanismProgram;
  readonly rest: ReadonlyMap<string, THREE.Matrix4>;
  readonly order: readonly JointDrive[];
  readonly driver: string;
  readonly roots: readonly string[];
  readonly freeRoots: readonly string[];
  private readonly factors: ReadonlyMap<string, RootRatio>;
  private readonly bounds: ReadonlyMap<string, { min: number; max: number }>;
  private readonly rootBounds: ReadonlyMap<string, { min: number; max: number }>;
  private readonly jointsById = new Map<string, JointDrive>();
  private readonly system: KinematicSystem;
  private readonly gearLaws: Law[] = [];
  private readonly stops: Inequality[] = [];
  private readonly tolerance: number;
  /** Last accepted pose: the continuation start of the next solve. */
  private state: State;
  /** Rack contacts in each rack's own assembled frame. */
  private readonly contacts: {
    id: string; pinion: JointDrive; rack: string; sign: number; radius: number;
    world: THREE.Vector3; local: THREE.Vector3; along: THREE.Vector3; normal: THREE.Vector3; direction: THREE.Vector3;
    travel: { min: number; max: number }; tolerance: number; engagement: number;
  }[] = [];

  constructor(asm: Assembly, program: MechanismProgram, limits: readonly JointLimitRule[] = []) {
    const errors = validateMechanismProgram(program);
    if (errors.length) throw Error(`Invalid mechanical program: ${errors.join('; ')}`);
    this.program = program;
    this.driver = program.driver.joint;
    this.rest = new Map(asm.instances.map(i => [i.key, i.world.clone()]));
    for (const j of program.joints) {
      if (!this.rest.has(j.body)) throw Error(`Missing assembled body ${j.body}`);
      if (j.parent && !this.rest.has(j.parent)) throw Error(`Missing parent instance ${j.parent}`);
      this.jointsById.set(j.id, j);
    }
    const pending = [...program.joints].sort((a,b)=>a.id.localeCompare(b.id));
    const visited = new Set<string>();
    const sorted: JointDrive[] = [];
    while (pending.length) {
      const ready = pending.findIndex(j => !j.parent || !program.joints.some(k=>k.body===j.parent) || visited.has(j.parent));
      if (ready < 0) throw Error('Kinematic ownership contains a directed cycle. Express closed loops with closures, not cyclic parents.');
      const j = pending.splice(ready,1)[0];
      sorted.push(j);visited.add(j.body);
    }
    this.order = sorted;
    for (const c of program.rackContacts ?? []) {
      const pinion = this.jointsById.get(c.pinion)!, rack = this.rest.get(c.rack);
      if (!rack) throw Error(`Rack contact ${c.id}: missing rack body ${c.rack}`);
      if (!pinion.pivot) throw Error(`Rack contact ${c.id}: pinion needs a pivot`);
      const axis = UNIT(pinion.axis), world = new THREE.Vector3(...c.contact);
      const out = world.clone().sub(new THREE.Vector3(...pinion.pivot));
      out.addScaledVector(axis, -out.dot(axis));
      if (Math.abs(out.length() - c.pitchRadiusLdu) > 1)
        throw Error(`Rack contact ${c.id}: contact is ${out.length().toFixed(2)} LDU from the pinion axis, not on its ${c.pitchRadiusLdu} LDU pitch circle`);
      const direction = UNIT(c.direction);
      if (Math.abs(direction.dot(axis)) > .05) throw Error(`Rack contact ${c.id}: rack does not run across the pinion shaft`);
      const toLocal = rack.clone().invert(), turn = new THREE.Matrix3().setFromMatrix4(toLocal);
      this.contacts.push({ id: c.id, pinion, rack: c.rack, sign: c.reversed ? -1 : 1, radius: c.pitchRadiusLdu, world, direction: direction.clone(),
        local: world.clone().applyMatrix4(toLocal),
        along: direction.clone().applyMatrix3(turn).normalize(),
        normal: out.normalize().negate().applyMatrix3(turn).normalize(),
        travel: c.travel ?? { min: -Infinity, max: Infinity }, tolerance: c.toleranceLdu ?? .1, engagement: c.engagementLdu ?? 1 });
    }

    const neighbours = new Map(program.joints.map(j=>[j.id,[] as {to:string; factor:number}[]]));
    for (const g of program.gears ?? []) {
      const a = this.jointsById.get(g.a)!, b = this.jointsById.get(g.b)!;
      if (a.kind !== 'revolute' || b.kind !== 'revolute') throw Error('Gear meshes require revolute joints');
      const aa=UNIT(a.axis),bb=UNIT(b.axis);
      if (Math.abs(aa.dot(bb)) < .995) throw Error(`Gear ${g.a}/${g.b}: axes must be parallel`);
      if (!a.pivot || !b.pivot) throw Error('Gear shafts require assembled-world pivots');
      if (g.moduleLdu) {
        const diff=new THREE.Vector3(...a.pivot).sub(new THREE.Vector3(...b.pivot));
        const radial=diff.addScaledVector(aa,-diff.dot(aa)).length();
        const expected=g.moduleLdu*(g.mesh==='external' ? (g.teethA+g.teethB)/2 : Math.abs(g.teethA-g.teethB)/2);
        if (Math.abs(radial-expected) > Math.max(.5,.015*expected))
          throw Error(`Gear ${g.a}/${g.b}: specified pitch circles do not mesh (${radial.toFixed(2)} vs ${expected.toFixed(2)} LDU)`);
      }
      // Orientation is measured around the WORLD axis. Reversing a declared
      // axis reverses the sign of its positive coordinate.
      const orientation=Math.sign(aa.dot(bb));
      const ratio=(g.mesh==='external'?-1:1)*g.teethA/g.teethB*orientation;
      neighbours.get(g.a)!.push({to:g.b,factor:ratio});
      this.gearLaws.push({ id: `gear:${g.a}/${g.b}`, coords: [g.a, g.b],
        f: x => [LDU_PER_RAD * (x[1] - ratio * x[0]) / Math.max(1, Math.abs(ratio))],
        grad: () => [[-LDU_PER_RAD * ratio / Math.max(1, Math.abs(ratio)), LDU_PER_RAD / Math.max(1, Math.abs(ratio))]] });
      neighbours.get(g.b)!.push({to:g.a,factor:1/ratio});
    }
    const factors=new Map<string,RootRatio>();
    const componentOrder=[this.driver,...[...neighbours.keys()].filter(k=>k!==this.driver).sort()];
    for (const root of componentOrder) {
      if (factors.has(root))continue;
      const queue=[root]; factors.set(root,{root,ratio:1});
      for(let cursor=0;cursor<queue.length;cursor++) {
        const id=queue[cursor],f=factors.get(id)!;
        for(const edge of neighbours.get(id)??[]) {
          const ratio=f.ratio*edge.factor,old=factors.get(edge.to);
          if (old) {
            if(old.root!==root || Math.abs(old.ratio-ratio)>1e-6*Math.max(1,Math.abs(ratio)))
              throw Error(`Contradictory closed gear train at ${id} -> ${edge.to}`);
          } else {factors.set(edge.to,{root,ratio});queue.push(edge.to);}
        }
      }
    }
    this.factors=factors;
    this.roots=[...new Set([...factors.values()].map(x=>x.root))];
    this.freeRoots=this.roots.filter(x=>x!==this.driver);
    if ((program.closures?.length??0) && this.freeRoots.length>12)
      throw Error('More than 12 free joint coordinates in a closed-chain solution. Split the mechanism.');
    const bounds=new Map<string,{min:number;max:number}>();
    for (const j of this.order) {
      let min=j.limits?.min ?? -Infinity,max=j.limits?.max ?? Infinity;
      for(const r of limits)if(r.moving===j.body && r.host===j.parent && r.kind===j.kind){
        min=Math.max(min,r.min);max=Math.min(max,r.max);
      }
      if (min>max || min>0 || max<0) throw Error(`Conflicting mechanical joint limits for ${j.id}`);
      bounds.set(j.id,{min,max});
    }
    this.bounds=bounds;
    const rootBounds=new Map(this.roots.map(id=>[id,{min:-Infinity,max:Infinity}]));
    for(const [id,f] of this.factors){
      const b=bounds.get(id)!;
      const x=b.min/f.ratio,y=b.max/f.ratio;
      const r=rootBounds.get(f.root)!;
      r.min=Math.max(r.min,Math.min(x,y));r.max=Math.min(r.max,Math.max(x,y));
      if(r.min>r.max)throw Error(`Contradictory joint limits within gear group ${f.root}`);
    }
    this.rootBounds=rootBounds;
    // Also validate the dimensionality of every V5 relation at construction time.
    prepareTransmissionEquations(program.transmissions??[],this.jointsById);
    for(const [i,c] of (program.closures??[]).entries()) {
      const a=this.rest.get(c.a.body),b=this.rest.get(c.b.body);
      if(!a||!b)throw Error(`Closure ${i+1} refers to unknown body`);
      const sep=localPoint(a,c.a.local).distanceTo(localPoint(b,c.b.local));
      if(sep>(c.toleranceLdu??.1))throw Error(`Closure ${i+1} is not closed in the authored assembled pose (${sep.toFixed(3)} LDU)`);
    }
    // The unified solver's model. A joint parent that is not itself a joint
    // body is static; closures and racks on rigid followers move with the leader.
    const moving=new Set(program.joints.map(j=>j.body));
    const leader=new Map<string,string>();
    for(const group of program.rigidFollowers??[])for(const b of group.bodies)if(!moving.has(b))leader.set(b,group.leader);
    const owner=(b:string):string|null=>{const l=leader.get(b)??b;return moving.has(l)?l:null;};
    const v3=(v:THREE.Vector3)=>v.toArray() as Vec3;
    const equations:Equation[]=[
      ...(program.closures??[]).map((c,i):Equation=>({kind:'point',id:`closure:${i}`,a:owner(c.a.body),b:owner(c.b.body),
        point:v3(localPoint(this.rest.get(c.a.body)!,c.a.local)),pb:v3(localPoint(this.rest.get(c.b.body)!,c.b.local)),
        tolerance:c.toleranceLdu??.1})),
      ...this.contacts.map((c):Equation=>({kind:'rolling',id:`rack:${c.id}`,carrier:c.pinion.parent?owner(c.pinion.parent):null,
        frame:owner(c.rack),point:v3(c.world),along:v3(c.direction),coord:c.pinion.id,ratio:c.sign*c.radius,tolerance:c.tolerance})),
    ];
    this.system=new KinematicSystem({bodies:[...moving],equations,joints:program.joints.map(j=>({
      id:j.id,parent:j.parent&&moving.has(j.parent)?j.parent:null,child:j.body,kind:j.kind,point:j.pivot??[0,0,0],axis:j.axis}))});
    for(const j of program.joints){
      const b=bounds.get(j.id)!;
      if(Number.isFinite(b.min)||Number.isFinite(b.max))
        this.stops.push({id:`stop:${j.id}`,coords:[j.id],a:[1],lo:b.min,hi:b.max,scale:j.kind==='revolute'?LDU_PER_RAD:1});
    }
    this.tolerance=Math.min(.1,...(program.closures??[]).map(c=>c.toleranceLdu??.1),...this.contacts.map(c=>c.tolerance));
    this.state=this.system.zeroState();
    const assembled=this.frameOf(this.state);
    if(!Number.isFinite(assembled.maxClosureErrorLdu))throw Error('Invalid assembly closure');
  }

  /** Poses of every animated body from a solved state. Regenerated from the
   * immutable rest transforms, so looping never accumulates drift. */
  private frameOf(state: State): SolvedFrame {
    const D=this.system.deltas(state);
    const q=new Map<string,number>();
    for(const j of this.order){
      const value=this.system.value(state,j.id),bound=this.bounds.get(j.id)!;
      if(!Number.isFinite(value)||value<bound.min-1e-6||value>bound.max+1e-6)
        throw Error(`Joint stop exceeded: ${j.id} (${value.toFixed(4)})`);
      q.set(j.id,value);
    }
    const poses=new Map<string,THREE.Matrix4>();
    for(const j of this.order){
      const next=toMatrix(D.get(j.body)!).multiply(this.rest.get(j.body)!);
      if(!finiteMatrix(next))throw Error(`Invalid kinematic pose: ${j.body} (${JSON.stringify(next.elements)})`);
      poses.set(j.body,next);
    }
    let max=0;
    for(const group of this.program.rigidFollowers??[]) {
      const leaderRest=this.rest.get(group.leader)!;
      const leaderPose=poses.get(group.leader)!;
      const leaderDelta=leaderPose.clone().multiply(leaderRest.clone().invert());
      for(const body of group.bodies) poses.set(body,leaderDelta.clone().multiply(this.rest.get(body)!));
    }
    // A carrier may relocate a gear shaft while other shafts remain fixed.
    // Gear engagement must hold over the ENTIRE solution, not only at rest.
    for (const g of this.program.gears??[]) {
      const shaft=(jointId:string)=>{
        const j=this.jointsById.get(jointId)!;
        const base=j.parent?this.rest.get(j.parent)!:null;
        const parent=j.parent?poses.get(j.parent)??base!:null;
        const motion=base&&parent?parent.clone().multiply(base.clone().invert()):new THREE.Matrix4();
        const pivot=new THREE.Vector3(...j.pivot!);
        const axis=UNIT(j.axis).toArray();
        const tip=new THREE.Vector3(j.pivot![0]+axis[0],j.pivot![1]+axis[1],j.pivot![2]+axis[2]);
        const centre=pivot.applyMatrix4(motion);
        const direction=tip.applyMatrix4(motion).sub(centre).normalize();
        return {centre,direction};
      };
      const a=shaft(g.a),b=shaft(g.b);
      if(Math.abs(a.direction.dot(b.direction))<.995)
        throw Error(`Gear ${g.a}/${g.b}: shafts lose alignment during motion`);
      if(g.moduleLdu!==undefined){
        const diff=new THREE.Vector3(a.centre.x,a.centre.y,a.centre.z).sub(b.centre);
        const radial=diff.addScaledVector(a.direction,-diff.dot(a.direction)).length();
        const expected=g.moduleLdu*(g.mesh==='external'?(g.teethA+g.teethB)/2:Math.abs(g.teethA-g.teethB)/2);
        if(Math.abs(radial-expected)>Math.max(.5,.015*expected))
          throw Error(`Gear ${g.a}/${g.b}: moving shafts lose pitch engagement (${radial.toFixed(2)} vs ${expected.toFixed(2)} LDU)`);
      }
    }
    const closureErrorsLdu:number[]=[];
    for(const c of this.program.closures??[]) {
      const a=poses.get(c.a.body)??this.rest.get(c.a.body)!;
      const b=poses.get(c.b.body)??this.rest.get(c.b.body)!;
      const distance=localPoint(a,c.a.local).distanceTo(localPoint(b,c.b.local));
      max=Math.max(max,distance);closureErrorsLdu.push(distance);
    }
    return {poses,joints:q,maxClosureErrorLdu:max,closureErrorsLdu};
  }
  /** For each rack contact: rolling error (rack travel minus pitch radius x
   * pinion angle), the travel itself, and how far the rack has drifted toward
   * (+) or away from (-) the pinion, all LDU, measured in the rack's frame. */
  private contactState(frame: SolvedFrame) {
    return this.contacts.map(c => {
      const parent = c.pinion.parent;
      const carrier = parent ? (frame.poses.get(parent) ?? this.rest.get(parent)!).clone().multiply(this.rest.get(parent)!.clone().invert()) : new THREE.Matrix4();
      const rack = frame.poses.get(c.rack) ?? this.rest.get(c.rack)!;
      const offset = c.world.clone().applyMatrix4(carrier).applyMatrix4(rack.clone().invert()).sub(c.local);
      // The fixed contact moves backwards through the rack as the rack advances.
      const travel = -offset.dot(c.along);
      return { rolling: travel - c.sign * c.radius * (frame.joints.get(c.pinion.id) ?? 0), travel, drift: offset.dot(c.normal) };
    });
  }
  /** Throws when a closure or rack contact fails in a solved frame. */
  private assertClosed(frame: SolvedFrame, label: string): SolvedFrame {
    const closures = this.program.closures ?? [];
    if (closures.some((c,i)=>frame.closureErrorsLdu[i]>(c.toleranceLdu??.1)+1e-7))
      throw Error(`${label}; closure gap ${frame.maxClosureErrorLdu.toFixed(4)} LDU`);
    const state = this.contactState(frame);
    state.forEach((x, i) => {
      const c = this.contacts[i];
      if (Math.abs(x.rolling) > c.tolerance + 1e-7) throw Error(`${label}; rack ${c.id} slips ${x.rolling.toFixed(4)} LDU on its pinion`);
      if (x.travel < c.travel.min - 1e-6 || x.travel > c.travel.max + 1e-6) throw Error(`${label}; pinion runs off the end of rack ${c.id}`);
      if (Math.abs(x.drift) > c.engagement) throw Error(`${label}; rack ${c.id} swings ${x.drift.toFixed(2)} LDU ${x.drift > 0 ? 'into' : 'away from'} its pinion`);
    });
    if (state.length) frame.rackContactErrorsLdu = state.map(x => Math.abs(x.rolling));
    return frame;
  }
  /** Joint values from a root seed (gear groups share a root). */
  private seeded(seed: ReadonlyMap<string,number>): State {
    const q=Float64Array.from(this.system.zeroState().q);
    for(const [id,{root,ratio}] of this.factors)q[this.system.coordIndex(id)]=(seed.get(root)??0)*ratio;
    return {q,rot:new Map()};
  }
  /** Drive the unified solver; failures keep the last accepted pose. */
  private run(drivers: ReadonlyMap<string,number>, laws: readonly Law[], seed: ReadonlyMap<string,number>|undefined,
    label: string, stopMessage: string): SolvedFrame {
    const from=seed?this.seeded(seed):this.state;
    const result=solveKinematics(this.system,from,drivers,{laws,inequalities:this.stops,tolerance:this.tolerance});
    if(result.status!=='converged'){
      if(/joint stop/.test(result.reason??''))throw Error(stopMessage);
      // Name the closure or rack that fails just past the last good pose.
      this.assertClosed(this.frameOf(result.state),label);
      throw Error(`${label}; ${result.reason}`);
    }
    const frame=this.assertClosed(this.frameOf(result.state),label);
    this.state=result.state;
    return frame;
  }

  /** Continuation from the preceding solved pose prevents arbitrary IK branch
   * flips. A failure reports unreachable rather than jumping through geometry. */
  solve(driverPosition:number, seed?: ReadonlyMap<string,number>): SolvedFrame {
    if(!Number.isFinite(driverPosition))throw Error('Nonfinite mechanism input');
    if(this.program.transmissions?.length)
      return this.solveInputs({[this.driver]:driverPosition},{seed});
    for(const [id,{root,ratio}] of this.factors)if(root===this.driver){
      const v=driverPosition*ratio,b=this.bounds.get(id)!;
      if(v<b.min-1e-8||v>b.max+1e-8)throw Error('The requested driver position violates a physical joint stop');
    }
    const label=this.program.closures?.length?`Unreachable closed linkage at ${driverPosition.toFixed(4)}`:`Rack contact failed at ${driverPosition.toFixed(4)}`;
    return this.run(new Map([[this.driver,driverPosition]]),this.gearLaws,seed,label,'The requested driver position violates a physical joint stop');
  }

  /** V5: solve multiple independent motor inputs against ideal gear, belt,
   * chain, worm, rack, screw, differential and engaged-clutch constraints.
   * This is a minimum-change kinematic solution, NOT a dynamic force solver.
   * Controls are named JOINT coordinates (radians or LDU). Omitted joints
   * keep their previous value as far as the constraints allow.
   *
   * Contradictory commands are rejected by exact linear algebra first; an
   * impossible pose throws rather than silently slipping. Overrides allow
   * gear selectors/clutches to change state at runtime.
   */
  solveInputs(
    controls: Readonly<Record<string,number>> | ReadonlyMap<string,number>,
    options: { engagements?: Readonly<Record<string,boolean>>; seed?: ReadonlyMap<string,number> } = {},
  ): SolvedFrame {
    const inputs=new Map(controls instanceof Map ? controls : Object.entries(controls));
    if (!inputs.size) throw Error('At least one independent motor input is required');
    if(inputs.size>this.roots.length)throw Error('Too many independently driven joints');
    const engaged=prepareTransmissionEquations(this.program.transmissions??[],this.jointsById,options.engagements);
    const algebra=engaged.map(e=>intoRootEquation(e,this.factors));
    for(const [id,value] of [...inputs].sort(([a],[b])=>a.localeCompare(b))){
      const factor=this.factors.get(id);
      if(!factor || !Number.isFinite(value))throw Error(`Invalid motor input ${id}`);
      algebra.push({id:`drive:${id}`,coefficients:new Map([[factor.root,factor.ratio]]),rhs:value});
    }
    // Exact algebra first: contradictory commands fail by name, not by residual.
    projectLinearConstraints(this.roots,algebra,new Map());
    const laws=[...this.gearLaws,...engaged.map((e):Law=>{
      const ids=[...e.coefficients.keys()],k=ids.map(id=>e.coefficients.get(id)!),s=LDU_PER_RAD/Math.max(1,Math.hypot(...k));
      return {id:`transmission:${e.id}`,coords:ids,f:x=>[s*(x.reduce((t,v,i)=>t+k[i]*v,0)-e.rhs)],grad:()=>[k.map(v=>s*v)]};
    })];
    const frame=this.run(inputs,laws,options.seed,'Unreachable V5 closed mechanism','Transmission motion exceeds a physical joint stop');
    const equations: LinearEquation[]=[...engaged,...[...inputs].map(([id,value])=>({id:`drive:${id}`,coefficients:new Map([[id,1]]),rhs:value}))];
    const maxResidual=equations.reduce((max,e)=>{
      let gap=-e.rhs;
      for(const [id,f] of e.coefficients)gap+=f*(frame.joints.get(id)??0);
      return Math.max(max,Math.abs(gap)/Math.max(1,Math.hypot(...e.coefficients.values())));
    },0);
    if(maxResidual>1e-6)throw Error('Transmission residual exceeds tolerance');
    return {...frame,transmissionResidual:maxResidual,activeTransmissions:engaged.length};
  }

  reset(){this.state=this.system.zeroState();}
  /** Exact assembled frame is returned for q=0; also resets IK continuation. */
  assembled():SolvedFrame{this.reset();return this.solve(0);}
}
