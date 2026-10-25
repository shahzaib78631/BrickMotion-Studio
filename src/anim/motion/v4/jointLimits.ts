/** Standard Motion v4 / phase 3: explicit limits in the ASSEMBLED-ZERO frame.
 *
 * Nothing in generic LDraw triangle geometry certifies angular or linear stops.
 * Therefore unknown limits remain unknown; the engine never guesses a 90°
 * hinge or a 30-LDU slider. Users/manufacturers may supply verified limits.
 */
import * as THREE from 'three';
import type { MechanicalJointType } from '../../construction/mechanicalConstraintGraph';
import type { KinematicSegment } from '../../timelineData';
import type { MotionCandidate } from '../kinematicCandidates';
import type { MechanismEdge } from './mechanismGraph';

export type JointLimitRule = {
  /** The exact moving and stationary leaf keys (no unstable snap ordering). */
  moving: string;
  host: string;
  type?: MechanicalJointType;
  kind: 'revolute' | 'prismatic';
  /** Signed radians for revolute, LDraw units for prismatic. Final assembly = 0. */
  min: number;
  max: number;
  /** Physical evidence must be supplied separately; not inferred from LDraw. */
  source: 'user' | 'verified';
};
export type LimitResult = {
  status: 'within-limits' | 'adjusted' | 'violated' | 'unknown' | 'invalid-rule';
  candidate?: MotionCandidate;
  rule?: JointLimitRule;
  detail?: string;
};
const EPS = 1e-6;
const TYPES: readonly MechanicalJointType[] = ['stud-socket','pin-hole','axle-hole','hinge',
  'clip','ball-socket','cylindrical'];

export function validJointLimit(rule: JointLimitRule): boolean {
  return !!rule && typeof rule === 'object' && typeof rule.moving === 'string' &&
    typeof rule.host === 'string' && !!rule.moving && !!rule.host && rule.moving !== rule.host &&
    (rule.type === undefined || TYPES.includes(rule.type)) &&
    (rule.kind === 'revolute' || rule.kind === 'prismatic') &&
    Number.isFinite(rule.min) && Number.isFinite(rule.max) && rule.min <= rule.max &&
    rule.min <= 0 + EPS && rule.max >= 0 - EPS &&
    (rule.kind === 'revolute' ? rule.min >= -Math.PI * 2 && rule.max <= Math.PI * 2 :
      rule.min >= -1e5 && rule.max <= 1e5) &&
    (rule.source === 'user' || rule.source === 'verified');
}
/** Reject overlapping selectors rather than arbitrarily using the first rule.
 * `type`-less rules match all connectors of that joint kind. */
export function validateJointLimitRules(rules: readonly JointLimitRule[]): string[] {
  const errors: string[]=[];
  rules.forEach((a,i)=>{
    if(!validJointLimit(a)) errors.push(`Rule ${i+1}: invalid bounds or zero reference`);
    for(let j=0;j<i;j++){
      const b=rules[j];
      if(a && b && a.moving===b.moving && a.host===b.host && a.kind===b.kind &&
          (!a.type || !b.type || a.type===b.type))
        errors.push(`Rules ${j+1} and ${i+1}: overlapping limits for ${a.moving} -> ${a.host}`);
    }
  });
  return errors;
}

export function matchingLimit(rules: readonly JointLimitRule[], moving: string, host: string,
  edge: MechanismEdge, kind: JointLimitRule['kind']): JointLimitRule | undefined {
  return rules.find(rule => rule.moving === moving && rule.host === host &&
    (!rule.type || rule.type === edge.type) && rule.kind === kind);
}

/** Given an exact connected approach whose final joint coordinate is zero,
 * truncate the open configuration to a real permitted range and reconstruct
 * every keyframe from forward kinematics. Never clamp playback independently:
 * that would silently change the authored destination or desynchronise frames.
 */
export function constrainJointCandidate(candidate: MotionCandidate, rule?: JointLimitRule): LimitResult {
  if (!rule) return { status: 'unknown', candidate };
  if (!validJointLimit(rule)) return { status: 'invalid-rule', rule, detail: 'Malformed or incompatible zero-referenced joint limits' };
  const segments = candidate.kinematicSegments ?? [];
  if (!segments.length || !segments.every(s => s.kind === rule.kind))
    return { status: 'violated', rule, detail: 'The candidate does not use the constrained joint' };
  const sorted = [...segments].sort((a,b)=>a.index-b.index);
  if (sorted.some((s,i) => i > 0 && s.index !== sorted[i-1].index + 1) ||
      sorted.at(-1)!.index !== candidate.poses.length - 2)
    return { status: 'violated', rule, detail: 'Joint trajectory does not terminate at the assembled-zero pose' };
  const first = sorted[0].index, end = candidate.poses.length - 1;
  // The original travel from open to assembled-zero is -q(open).
  const initial = -sorted.reduce((sum,s)=>sum+s.travel,0);
  const target = Math.min(rule.max, Math.max(rule.min, initial));
  if (Math.abs(target) < EPS) return { status: 'violated', rule,
    detail: 'The joint cannot open in this direction inside the allowed range' };
  const factor = target / initial;
  if (!Number.isFinite(factor) || factor < 0) return { status: 'violated', rule };
  if (Math.abs(factor - 1) < EPS) return { status: 'within-limits', candidate, rule };
  const revised: KinematicSegment[] = sorted.map(s => ({ ...s, travel: s.travel * factor }));
  const pose = candidate.poses.map(m=>m.clone());
  const assembled = pose[end];
  const axis = new THREE.Vector3(...sorted[0].axis).normalize();
  let remaining = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = revised[i];
    remaining -= s.travel;
    const start = pose[s.index];
    if (s.kind === 'revolute') {
      if (!s.pivot) return { status: 'violated', rule, detail: 'Hinge has no pivot' };
      const [x,y,z] = s.pivot;
      start.copy(new THREE.Matrix4().makeTranslation(x,y,z)
        .multiply(new THREE.Matrix4().makeRotationAxis(axis, remaining))
        .multiply(new THREE.Matrix4().makeTranslation(-x,-y,-z)).multiply(assembled));
    } else {
      start.copy(assembled);
      start.elements[12] += axis.x * remaining;
      start.elements[13] += axis.y * remaining;
      start.elements[14] += axis.z * remaining;
    }
  }
  // The preceding, unconstrained cruise point used the old open orientation;
  // preserve its sky coordinate but align it to the newly limited opening.
  if (first > 0) {
    const oldCruise = candidate.poses[first - 1], oldOpen = candidate.poses[first];
    pose[first - 1].copy(pose[first]);
    pose[first - 1].elements[12] += oldCruise.elements[12] - oldOpen.elements[12];
    pose[first - 1].elements[13] += oldCruise.elements[13] - oldOpen.elements[13];
    pose[first - 1].elements[14] += oldCruise.elements[14] - oldOpen.elements[14];
  }
  // Check each intermediate coordinate, not only the new open state.
  remaining = target;
  for (const s of revised) {
    if (remaining < rule.min - EPS || remaining > rule.max + EPS) return { status: 'violated', rule };
    remaining += s.travel;
  }
  if (Math.abs(remaining) > EPS) return { status: 'violated', rule };
  return { status: 'adjusted', candidate: { ...candidate, poses: pose, kinematicSegments: revised }, rule };
}
