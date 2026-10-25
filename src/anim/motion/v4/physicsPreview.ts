/** Phase 5: deterministic REDUCED-COORDINATE gravity + motor dynamics.
 * Moves only bodies with explicit mass, through the same gear/linkage solver;
 * does NOT claim free rigid-body contacts, material properties, friction,
 * certified clearances, or that approximate box inertia is real part inertia.
 * This is intentionally opt-in: assembly construction is never gravity driven.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import type { GravitySpec } from './mechanismProgram';
import { LDU_METRES, type MechanismSolver } from './mechanismSolver';

const worldPoint=(m:THREE.Matrix4,p:[number,number,number])=>new THREE.Vector3(...p).applyMatrix4(m).multiplyScalar(LDU_METRES);
const diff=(a:THREE.Vector3,b:THREE.Vector3,scale:number)=>a.sub(b).multiplyScalar(scale);
const V=(p:[number,number,number])=>new THREE.Vector3(...p);
const clamp=(x:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,x));
function angularChange(a:THREE.Matrix4,b:THREE.Matrix4):number {
  // Relative world-rigid motion isolates rotation from a mirrored/nonstandard
  // LDraw rest matrix; taking the trace of the original transforms is wrong.
  const delta=b.clone().multiply(a.clone().invert()).elements;
  return Math.acos(clamp((delta[0]+delta[5]+delta[10]-1)/2,-1,1));
}
export class ReducedGravityPreview {
  private readonly masses: {body:string;massKg:number;centre:[number,number,number];inertia:number}[];
  private readonly g:THREE.Vector3;
  private readonly gravity:GravitySpec;
  /** Approximate inertia count is carried to diagnostics. */
  readonly approximateInertias:number;
  position=0;
  velocity=0;
  constructor(private solver:MechanismSolver,asm:Assembly,metrics:Metrics) {
    const gravity=solver.program.gravity;
    if (!gravity || solver.program.mode!=='gravity')throw Error('Reduced dynamics requires a gravity-mode program');
    this.gravity=gravity;
    this.g=V(gravity.acceleration);
    const byKey=new Map(asm.instances.map(i=>[i.key,i]));
    let approximate=0;
    this.masses=gravity.bodies.map(b=>{
      const inst=byKey.get(b.body);
      if(!inst)throw Error(`No mass instance ${b.body}`);
      const box=metrics(inst.part).full;
      const width=[0,1,2].map(i=>Math.max(0,box.max[i]-box.min[i])*LDU_METRES);
      const maxInertia=b.massKg*(width[0]**2+width[1]**2+width[2]**2)/12;
      if(b.inertiaKgM2===undefined)approximate++;
      return {body:b.body,massKg:b.massKg,centre:b.centreLocal??[0,1,2].map(i=>(box.min[i]+box.max[i])/2) as [number,number,number],
        inertia:b.inertiaKgM2??Math.max(maxInertia,1e-12)};
    });
    this.approximateInertias=approximate;
  }
  reset(q:number){this.position=q;this.velocity=0;this.solver.reset();this.solver.solve(q);}
  /** qdot and qddot are expressed in rad/s or LDU/s, matching joint kind. */
  accelerationAt(q:number,velocity:number):{acceleration:number; inertia:number; gravityForce:number} {
    const eps=this.solver.program.joints.find(j=>j.id===this.solver.driver)?.kind==='revolute'?5e-4:.01;
    let lo,hi,span=2*eps;
    try{lo=this.solver.solve(q-eps);}catch{lo=this.solver.solve(q);span=eps;}
    try{hi=this.solver.solve(q+eps);}catch{hi=this.solver.solve(q);span=eps;}
    if(lo===hi || (lo.joints.get(this.solver.driver)===hi.joints.get(this.solver.driver)))
      throw Error('Driver is held at an immovable mechanical stop');
    let inertia=0,gforce=0;
    for(const m of this.masses){
      const a=lo.poses.get(m.body)??this.solver.rest.get(m.body)!;
      const b=hi.poses.get(m.body)??this.solver.rest.get(m.body)!;
      const d=diff(worldPoint(b,m.centre),worldPoint(a,m.centre),1/span);
      inertia+=m.massKg*d.lengthSq()+m.inertia*Math.pow(angularChange(a,b)/span,2);
      gforce+=m.massKg*this.g.dot(d);
    }
    if (inertia<1e-12)throw Error('The selected masses have zero inertial coupling to the driven joint');
    const torque=gforce-(this.gravity.damping*velocity)+(this.gravity.motor??0);
    const result=torque/inertia;
    if(!Number.isFinite(result) || Math.abs(result)>1e8)throw Error('Unstable gravity acceleration; verify mass, inertia and motor units');
    return {acceleration:result,inertia,gravityForce:gforce};
  }
  /** Semi-implicit Euler with fixed dt, no wall clock. Limits stop the motion;
   * no elastic impact, contact impulse, or part-to-part friction is invented. */
  step(dt:number):void {
    if(!Number.isFinite(dt)||dt<=0||dt>1/120+1e-8)throw Error('Gravity step must be <=1/120 second');
    const accel=this.accelerationAt(this.position,this.velocity).acceleration;
    const v=clamp(this.velocity+dt*accel,-1e5,1e5);
    const next=this.position+v*dt;
    try{this.solver.solve(next);this.position=next;this.velocity=v;}
    catch(error){
      // Only an actual joint-limit crossing is a stop. In particular, IK
      // failures are not collisions and cannot silently halt the simulator.
      if(!/^(Joint stop exceeded:|The requested driver position violates a physical joint stop)/.test(String((error as Error)?.message??error)))
        throw error;
      // A genuine joint stop may catch a step; a loop-closure failure may NOT
      // be disguised as an impact. Binary-search along the previous legal step.
      const previous=this.solver.solve(this.position);
      let low=0,high=1;
      for(let i=0;i<20;i++){
        const mid=(low+high)/2;
        try {this.solver.solve(this.position+(next-this.position)*mid);low=mid;}
        catch(err){
          if(!/^(Joint stop exceeded:|The requested driver position violates a physical joint stop)/.test(String((err as Error)?.message??err)))throw err;
          high=mid;
        }
      }
      if(low<1e-5) {
        // Endpoint stop: zero velocity without making up bounce/restitution.
        this.solver.solve(this.position);
        this.velocity=0;
        return;
      }
      if(Math.abs(next-this.position)*low>Math.abs(next-this.position)*.99)
        throw Error(`Constrained physics blocked: ${String((error as Error)?.message??error)}`);
      this.position+=(next-this.position)*low;
      this.solver.solve(this.position,previous.joints);
      this.velocity=0;
    }
  }
}
