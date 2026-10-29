/** Phase 4: deterministic hierarchical FK, gear ratios, and closed-chain IK.
 * Unsupported or inconsistent constraints fail closed. No geometry-only guess
 * is promoted to an authoritative joint or gear engagement.
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import type { JointLimitRule } from './jointLimits';
import type { MechanismProgram, JointDrive, Vec3 } from './mechanismProgram';
import { validateMechanismProgram } from './mechanismProgram';
import { prepareTransmissionEquations, intoRootEquation, projectLimitedNetwork,
  type LinearEquation } from './transmissionNetwork';

const UNIT = (v: Vec3) => new THREE.Vector3(...v).normalize();
const EPS = 1e-8;
const at = (p: Vec3) => new THREE.Matrix4().makeTranslation(...p);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const finiteMatrix = (m: THREE.Matrix4) => m.elements.every(Number.isFinite);
const localPoint = (m: THREE.Matrix4, p: Vec3) => new THREE.Vector3(...p).applyMatrix4(m);
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
  private previousRoots = new Map<string, number>();

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
    // The zero-reference must physically close before any motion can start.
    const assembled=this.evaluateRoots(new Map(this.roots.map(r=>[r,0])));
    for(const [i,c] of (program.closures??[]).entries()) {
      const a=this.rest.get(c.a.body),b=this.rest.get(c.b.body);
      if(!a||!b)throw Error(`Closure ${i+1} refers to unknown body`);
      const sep=localPoint(a,c.a.local).distanceTo(localPoint(b,c.b.local));
      if(sep>(c.toleranceLdu??.1))throw Error(`Closure ${i+1} is not closed in the authored assembled pose (${sep.toFixed(3)} LDU)`);
    }
    if(!Number.isFinite(assembled.maxClosureErrorLdu))throw Error('Invalid assembly closure');
  }

  /** A frame is regenerated from immutable rest transforms, not accumulated
   * incremental matrices, so looping doesn't introduce mechanical drift. */
  private evaluateRoots(rootValues: ReadonlyMap<string, number>): SolvedFrame {
    const q = new Map<string,number>();
    for(const [id,{root,ratio}]of this.factors) {
      const value=(rootValues.get(root)??0)*ratio;
      const bound=this.bounds.get(id)!;
      if (!Number.isFinite(value)||value<bound.min-1e-6||value>bound.max+1e-6)
        throw Error(`Joint stop exceeded: ${id} (${value.toFixed(4)})`);
      q.set(id,value);
    }
    const poses=new Map<string,THREE.Matrix4>();
    for(const j of this.order) {
      const parentRest=j.parent?this.rest.get(j.parent)!:null;
      const parentWorld=j.parent?(poses.get(j.parent)??parentRest!):null;
      const deltaParent=parentWorld?parentWorld.clone().multiply(parentRest!.clone().invert()):new THREE.Matrix4();
      const amount=q.get(j.id)!;
      const action=j.kind==='revolute'
        ? at(j.pivot!).multiply(new THREE.Matrix4().makeRotationAxis(UNIT(j.axis),amount)).multiply(at(j.pivot!).invert())
        : new THREE.Matrix4().makeTranslation(...(UNIT(j.axis).multiplyScalar(amount).toArray() as Vec3));
      const next=deltaParent.multiply(action).multiply(this.rest.get(j.body)!);
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
  private residual(roots: ReadonlyMap<string,number>): number[] {
    const frame=this.evaluateRoots(roots),error:number[]=[];
    for(const c of this.program.closures??[]) {
      const a=frame.poses.get(c.a.body)??this.rest.get(c.a.body)!;
      const b=frame.poses.get(c.b.body)??this.rest.get(c.b.body)!;
      const diff=localPoint(a,c.a.local).sub(localPoint(b,c.b.local));
      error.push(diff.x,diff.y,diff.z);
    }
    return error;
  }
  private withinLimits(roots: ReadonlyMap<string,number>): boolean {
    for (const [id,{root,ratio}]of this.factors){const q=(roots.get(root)??0)*ratio,lim=this.bounds.get(id)!;
      if(q<lim.min-1e-8||q>lim.max+1e-8)return false;}
    return true;
  }
  private solveNormal(matrix: number[][],rhs:number[]):number[]|null {
    const n=rhs.length;
    const a=matrix.map((row,i)=>[...row,rhs[i]]);
    for(let col=0;col<n;col++){
      let pivot=col;
      for(let row=col+1;row<n;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
      if(Math.abs(a[pivot][col])<1e-15)return null;
      [a[pivot],a[col]]=[a[col],a[pivot]];
      const v=a[col][col];for(let j=col;j<=n;j++)a[col][j]/=v;
      for(let row=0;row<n;row++)if(row!==col){const f=a[row][col];for(let j=col;j<=n;j++)a[row][j]-=f*a[col][j];}
    }
    return a.map(row=>row[n]);
  }
  /** Continuation from the preceding solved pose prevents arbitrary IK branch
   * flips. A failure reports unreachable rather than jumping through geometry. */
  solve(driverPosition:number, seed?: ReadonlyMap<string,number>): SolvedFrame {
    if(!Number.isFinite(driverPosition))throw Error('Nonfinite mechanism input');
    if(this.program.transmissions?.length)
      return this.solveInputs({[this.driver]:driverPosition},{seed});
    const roots=new Map(this.roots.map(r=>[r,seed?.get(r)??this.previousRoots.get(r)??0]));
    roots.set(this.driver,driverPosition);
    if(!this.withinLimits(roots))throw Error('The requested driver position violates a physical joint stop');
    const constraints=this.program.closures??[];
    if(constraints.length) {
      let err=this.residual(roots);
      let norm=Math.hypot(...err);
      const tolerance=Math.min(...constraints.map(c=>c.toleranceLdu??.1));
      for(let iteration=0;norm>tolerance&&iteration<48;iteration++) {
        const free=this.freeRoots;
        if(!free.length)break;
        const jac=free.map(id=>{
          const h=Math.max(1e-5,Math.abs(roots.get(id)??0)*1e-5);
          const perturbed=new Map(roots);perturbed.set(id,(roots.get(id)??0)+h);
          if(!this.withinLimits(perturbed)){perturbed.set(id,(roots.get(id)??0)-h);}
          const signedH=(perturbed.get(id)??0)-(roots.get(id)??0);
          if(!signedH||!this.withinLimits(perturbed))return err.map(()=>0);
          try{return this.residual(perturbed).map((e,i)=>(e-err[i])/signedH);}
          catch{return err.map(()=>0);}
        });
        const lambda=.005;
        const M=free.map((_,i)=>free.map((__,j)=>jac[i].reduce((s,v,k)=>s+v*jac[j][k],0)+(i===j?lambda*lambda:0)));
        const rhs=jac.map(column=>-column.reduce((s,v,k)=>s+v*err[k],0));
        const delta=this.solveNormal(M,rhs);
        if(!delta)break;
        let accepted=false;
        for(const alpha of [1,.5,.25,.125,.0625,.03125]){
          const cand=new Map(roots);
          free.forEach((id,i)=>cand.set(id,(roots.get(id)??0)+clamp(delta[i]*alpha,-.35,.35)));
          if(!this.withinLimits(cand))continue;
          try{
            const residual=this.residual(cand),newNorm=Math.hypot(...residual);
            if(newNorm<norm-1e-9){roots.clear();for(const [id,v] of cand)roots.set(id,v);err=residual;norm=newNorm;accepted=true;break;}
          }catch{/* excluded by physical joint limits or invalid transform */}
        }
        if(!accepted)break;
      }
      const frame=this.evaluateRoots(roots);
      if(constraints.some((c,i)=>frame.closureErrorsLdu[i]>(c.toleranceLdu??.1)+1e-7))
        throw Error(`Unreachable closed linkage at ${driverPosition.toFixed(4)}; closure gap ${frame.maxClosureErrorLdu.toFixed(4)} LDU`);
    }
    const solved=this.evaluateRoots(roots);
    this.previousRoots=roots;
    return solved;
  }

  /** V5: solve multiple independent motor inputs against ideal gear, belt,
   * chain, worm, rack, screw, differential and engaged-clutch constraints.
   * This is a minimum-change kinematic solution, NOT a dynamic force solver.
   * Controls are named JOINT coordinates (radians or LDU). Omitted joints
   * inherit the nearest feasible value from the previous solved frame.
   *
   * All algebraic constraints are projected exactly before evaluating FK;
   * when the result is impossible, throws rather than silently slipping.
   * Overrides allow gear selectors/clutches to change state at runtime.
   */
  solveInputs(
    controls: Readonly<Record<string,number>> | ReadonlyMap<string,number>,
    options: { engagements?: Readonly<Record<string,boolean>>; seed?: ReadonlyMap<string,number> } = {},
  ): SolvedFrame {
    const inputs=new Map(controls instanceof Map ? controls : Object.entries(controls));
    if (!inputs.size) throw Error('At least one independent motor input is required');
    if(inputs.size>this.roots.length)throw Error('Too many independently driven joints');
    const algebra=prepareTransmissionEquations(this.program.transmissions??[],this.jointsById,options.engagements)
      .map(e=>intoRootEquation(e,this.factors));
    for(const [id,value] of [...inputs].sort(([a],[b])=>a.localeCompare(b))){
      const factor=this.factors.get(id);
      if(!factor || !Number.isFinite(value))throw Error(`Invalid motor input ${id}`);
      algebra.push({id:`drive:${id}`,coefficients:new Map([[factor.root,factor.ratio]]),rhs:value});
    }
    const project=(guess:ReadonlyMap<string,number>)=>
      projectLimitedNetwork(this.roots,algebra,guess,this.rootBounds);
    const initial=new Map(this.roots.map(id=>[id,options.seed?.get(id)??this.previousRoots.get(id)??0]));
    let projected=project(initial);
    const roots=projected.roots;
    const closures=this.program.closures??[];
    if(closures.length){
      let error=this.residual(roots);
      let norm=Math.hypot(...error);
      const tolerance=Math.min(...closures.map(c=>c.toleranceLdu??.1));
      // The algebraic manifold is projected into after every IK perturbation.
      // This prevents a closure correction from breaking a transmission ratio.
      const controlled=new Set([...inputs.keys()].map(id=>this.factors.get(id)!.root));
      const free=this.roots.filter(id=>!controlled.has(id));
      for(let iteration=0;norm>tolerance&&iteration<48;iteration++){
        if(!free.length)break;
        const jac=free.map(id=>{
          const h=Math.max(1e-5,Math.abs(roots.get(id)??0)*1e-5);
          const perturb=new Map(roots);perturb.set(id,(perturb.get(id)??0)+h);
          try{
            const feasible=project(perturb).roots;
            const movement=Math.hypot(...this.roots.map(root=>(feasible.get(root)??0)-(roots.get(root)??0)));
            if(movement<1e-9)return error.map(()=>0);
            return this.residual(feasible).map((x,i)=>(x-error[i])/h);
          }catch{return error.map(()=>0);}
        });
        const lambda=.005;
        const M=free.map((_,i)=>free.map((__,j)=>jac[i].reduce((sum,v,k)=>sum+v*jac[j][k],0)+(i===j?lambda*lambda:0)));
        const rhs=jac.map(column=>-column.reduce((sum,v,k)=>sum+v*error[k],0));
        const delta=this.solveNormal(M,rhs);
        if(!delta)break;
        let accepted=false;
        for(const alpha of [1,.5,.25,.125,.0625,.03125]){
          const candidate=new Map(roots);
          free.forEach((id,i)=>candidate.set(id,(roots.get(id)??0)+clamp(delta[i]*alpha,-.35,.35)));
          try{
            const feasible=project(candidate).roots;
            const nextError=this.residual(feasible),nextNorm=Math.hypot(...nextError);
            if(nextNorm<norm-1e-9){
              roots.clear();for(const [id,v]of feasible)roots.set(id,v);
              error=nextError;norm=nextNorm;accepted=true;break;
            }
          }catch{/* infeasible joint stop or closure */}
        }
        if(!accepted)break;
      }
      const frame=this.evaluateRoots(roots);
      if(closures.some((c,i)=>frame.closureErrorsLdu[i]>(c.toleranceLdu??.1)+1e-7))
        throw Error(`Unreachable V5 closed mechanism; closure gap ${frame.maxClosureErrorLdu.toFixed(4)} LDU`);
    }
    projected=project(roots);
    const frame=this.evaluateRoots(projected.roots);
    // Recompute residual strictly in joint space and include exact drive equations.
    const equations: LinearEquation[]=algebra;
    const maxResidual=equations.reduce((max,e)=>{
      let gap=-e.rhs;
      for(const [id,f] of e.coefficients)gap+=f*(projected.roots.get(id)??0);
      return Math.max(max,Math.abs(gap)/Math.max(1,Math.hypot(...e.coefficients.values())));
    },0);
    if(maxResidual>1e-6)throw Error('Transmission residual exceeds tolerance');
    this.previousRoots=new Map(projected.roots);
    return {...frame,transmissionResidual:maxResidual,
      activeTransmissions:algebra.filter(e=>!e.id.startsWith('drive:')).length};
  }

  reset(){this.previousRoots.clear();}
  /** Exact assembled frame is returned for q=0; also resets IK continuation. */
  assembled():SolvedFrame{this.reset();return this.solve(0);}
}
