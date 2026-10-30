/**
 * Bounded, repeatable whole-cycle evidence for a user-reviewed V6 linkage.
 * The sweep does not prove continuous collision clearance, tooth contact,
 * dynamics, stability, or motion between samples. Failed frames are never
 * reported as certified motion.
 */
import { SpatialMechanismSolver, type SpatialModel } from '../kinematics/spatialModel';

export type SpatialSweepReport = {
  kind: 'brickmotion-v6-sampled-spatial-sweep';
  status: 'sampled-pass'|'sampled-fail';
  mode?: 'round-trip'|'forward';
  additionalMotors?: Readonly<Record<string,number>>;
  driver: string;
  amplitude: number;
  attemptedSamples: number;
  checkedSamples: number;
  maxResidualLdu: number;
  highestIterations: number;
  minimumFreeDof: number;
  worstConstraint: string|null;
  failures: { at: number; reason: string }[];
  evidence: 'numerical-sampled-kinematics-only';
  disclaimer: string;
};

export function sweepSpatialLinkage(model: SpatialModel, driver: string,
  amplitude: number, subdivisions=8,options:{
    additionalMotors?:Readonly<Record<string,number>>;
    mode?:'round-trip'|'forward';
  }={}): SpatialSweepReport {
  const joint=model.constraints.find(c=>c.id===driver);
  if(!joint||(joint.kind!=='hinge'&&joint.kind!=='slider'))
    throw Error('Spatial sweep driver must be an existing hinge or slider');
  if (!Number.isFinite(amplitude) || amplitude<=0 || (joint.kind==='hinge'&&amplitude>=Math.PI-.001)||amplitude>1000)
    throw Error('Spatial sweep amplitude must be positive, below pi for hinges, and at most 1000 LDU for sliders');
  if (!Number.isInteger(subdivisions)||subdivisions<2||subdivisions>16)
    throw Error('Spatial sweep supports 2–16 subdivisions per quarter-cycle');
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Invalid spatial sweep options');
  const mode=options.mode??'round-trip';
  if(mode!=='round-trip'&&mode!=='forward')throw Error('Unsupported spatial sweep mode');
  const extra=options.additionalMotors??{};
  if(Object.prototype.hasOwnProperty.call(extra,driver))throw Error('Secondary motors must not override the swept driver');
  if(!extra||typeof extra!=='object'||Array.isArray(extra))throw Error('Secondary spatial motors must be an object');
  for(const [key,value]of Object.entries(extra)){
    const c=model.constraints.find(c=>c.id===key);
    if(!c||(c.kind!=='hinge'&&c.kind!=='slider')||!Number.isFinite(value))
      throw Error(`Invalid secondary spatial motor ${key}`);
  }
  const solver = new SpatialMechanismSolver(model);
  const points: number[] = [0];
  // Run the same motor forward/backward in both directions to expose closure
  // failures or dependence on continuation path; the rest frame is included.
  const driverPawl=model.mechanics?.find(m=>m.kind==='ratchet'&&m.joint===driver&&m.engaged!==false);
  const oneWaySign=driverPawl?.kind==='ratchet'&&driverPawl.direction==='negative'?-1:1;
  for (const [a,b] of mode==='forward'?[[0,oneWaySign]]:[[0,1],[1,0],[0,-1],[-1,0]])
    for(let i=1;i<=subdivisions;i++)points.push(amplitude*(a+(b-a)*i/subdivisions));
  let checkedSamples=0,maxResidualLdu=0,highestIterations=0,minDof=Infinity;
  let worstConstraint:string|null=null;
  const failures:SpatialSweepReport['failures']=[];
  for(const q of points){
    let frame;
    try {frame=solver.solve({...extra,[driver]:q},{maxIterations:60,toleranceLdu:.04});}
    catch(error){failures.push({at:q,reason:error instanceof Error?error.message:String(error)});break;}
    checkedSamples++;
    highestIterations=Math.max(highestIterations,frame.iterations);
    minDof=Math.min(minDof,frame.estimatedFreeDof);
    for(const [id,residual] of frame.residualByConstraint){
      if(residual>maxResidualLdu){maxResidualLdu=residual;worstConstraint=id;}
    }
    if(frame.status==='failed'){
      failures.push({at:q,reason:frame.warning??`Unclosed linkage (residual ${frame.maxResidualLdu.toFixed(3)} LDU)`});
      break;
    }
  }
  return {
    kind:'brickmotion-v6-sampled-spatial-sweep',
    status:failures.length?'sampled-fail':'sampled-pass',driver,amplitude,mode,
    additionalMotors:extra,
    attemptedSamples:points.length,checkedSamples,maxResidualLdu,
    highestIterations,minimumFreeDof: Number.isFinite(minDof)?minDof:-1,
    worstConstraint,failures,evidence:'numerical-sampled-kinematics-only',
    disclaimer:'Only sampled ideal constraints and authored mechanical ratios were tested. No continuous collision, loads, tooth engagement, spring forces, rope tension, material safety, or real-set certification.',
  };
}
