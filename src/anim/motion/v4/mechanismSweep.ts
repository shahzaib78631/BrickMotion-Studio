/** V5 bounded kinematic sweep diagnostics.
 * This checks the *authored mathematical mechanism* at sampled driver values.
 * Not a proof of real tooth contact, collisions, manufacturing tolerance,
 * backlash, motor torque, forces, or continuous paths between samples.
 */
import type { Assembly } from '../../../model/assemble';
import type { MechanismGraph } from './mechanismGraph';
import type { MechanismProgram } from './mechanismProgram';
import { MechanismSolver } from './mechanismSolver';
import { intoRootEquation, prepareTransmissionEquations, projectLinearConstraints } from './transmissionNetwork';

export type SweepResult = {
  format: 'brickmotion-kinematic-sweep'; version: 1;
  status: 'sampled-pass' | 'sampled-fail';
  checkedSamples: number; attemptedSamples: number;
  sampleMax: number; // driver coordinate (radians or LDU)
  sampleMin: number;
  maxLoopGapLdu: number;
  maxTransmissionResidual: number;
  independentCoordinates: number;
  estimatedUnconstrainedCoordinates: number;
  // These are mathematically approximate DOF counts; nonlinear loop closures
  // may remove further freedom, and nothing here establishes collision freedom.
  sampledJointRanges: Record<string, { min: number; max: number }>;
  failedAt?: number;
  error?: string;
  warnings: string[];
};

/** Multiple round-trip excursions permit regression detection of accumulated
 * drift, limit violations, and simple numerical branch flips. Result remains
 * a sampled diagnostic, never a continuous collision certificate. */
export function sweepMechanism(assembly: Assembly, program: MechanismProgram,
  graph?: MechanismGraph, stepsPerHalf = 12): SweepResult {
  if (!Number.isSafeInteger(stepsPerHalf) || stepsPerHalf < 2 || stepsPerHalf > 48)
    throw Error('Sweep must use 2–48 steps per half-cycle');
  const amplitude = Math.abs(program.driver.amplitude);
  const values = [0];
  for (let leg = 0; leg < 4; leg++) {
    const from = [0,amplitude,0,-amplitude][leg],to = [amplitude,0,-amplitude,0][leg];
    for (let i = 1; i <= stepsPerHalf; i++) values.push(from+(to-from)*i/stepsPerHalf);
  }
  const result: SweepResult = {
    format:'brickmotion-kinematic-sweep', version:1,status:'sampled-pass',
    checkedSamples:0,attemptedSamples:values.length,
    sampleMin:-amplitude,sampleMax:amplitude,maxLoopGapLdu:0,maxTransmissionResidual:0,
    independentCoordinates:0,estimatedUnconstrainedCoordinates:0,
    sampledJointRanges:{}, warnings: [
      'Sampled ideal kinematic equations only. No collision clearance or physical engagement is certified.',
      'The scan does not detect unsampled singularities, forces, friction, backlash, or actuator torque.',
    ],
  };
  if (program.secondaryMotors?.length) result.warnings.push('Secondary motor trajectories are not evaluated in this primary-driver sweep; the stage renderer separately validates all motors at sampled timeline frames.');
  try {
    const solver = new MechanismSolver(assembly, program);
    result.independentCoordinates=solver.roots.length;
    const base = prepareTransmissionEquations(program.transmissions??[],
      new Map(program.joints.map(j=>[j.id,j])));
    // solver.roots fold existing gear groups; DOF is computed exactly for
    // pure V5 networks and conservatively when old V4 gear ratios also exist.
    // Each root is an independent variable after old gear groups. A relation
    // may remove a degree of freedom; count independent rows only when there
    // are no legacy gear reductions (otherwise give a conservative upper bound).
    if(!program.gears?.length && base.length){
      const identity=new Map(solver.roots.map(id=>[id,{root:id,ratio:1}]));
      const projected=base.map(e=>intoRootEquation(e,identity));
      const rank=projectLinearConstraints(solver.roots,projected,new Map()).rank;
      result.estimatedUnconstrainedCoordinates=Math.max(0,solver.roots.length-rank);
    }else {
      result.estimatedUnconstrainedCoordinates=solver.roots.length;
      if(base.length)result.warnings.push('DOF estimate is an upper bound when legacy gear groups and V5 constraints are mixed.');
    }
    // Check fixed mates are not assigned to different moving owners. This
    // catches a frequent source of visually plausible but broken animations.
    const leaders=new Set(program.joints.map(j=>j.body));
    const owner=new Map<string,string>();
    for(const leader of leaders)owner.set(leader,leader);
    for(const group of program.rigidFollowers??[])for(const b of group.bodies)owner.set(b,group.leader);
    for(const edge of graph?.edges??[])if(edge.motion==='fixed'){
      const a=owner.get(edge.a),b=owner.get(edge.b);
      if((a||b) && a!==b)
        throw Error(`Fixed LDCad connection ${edge.id} would be separated (${edge.a}/${edge.b})`);
    }
    solver.reset();
    for(const position of values) {
      try {
        const frame=solver.solve(position);
        result.maxLoopGapLdu=Math.max(result.maxLoopGapLdu,frame.maxClosureErrorLdu);
        result.maxTransmissionResidual=Math.max(result.maxTransmissionResidual,frame.transmissionResidual??0);
        for(const [name,value] of frame.joints){
          const range=result.sampledJointRanges[name]??{min:value,max:value};
          range.min=Math.min(range.min,value);range.max=Math.max(range.max,value);
          result.sampledJointRanges[name]=range;
        }
        result.checkedSamples++;
      } catch(error){
        result.failedAt=position;
        throw error;
      }
    }
  } catch(error) {
    result.status='sampled-fail';result.error=error instanceof Error?error.message:String(error);
  }
  return result;
}
