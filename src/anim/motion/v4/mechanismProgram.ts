/** Phase 4-6: authored, model-instance-specific mechanical demonstration.
 * Coordinates are world LDraw units at the assembled pose (q=0), unless
 * explicitly named `local`, and cannot be inferred from a render mesh.
 */
export type Vec3 = [number, number, number];
export type JointDrive = {
  id: string;
  /** Animated leaf instance, NOT a part filename. */
  body: string;
  /** Optional upstream moving body. Absence means fixed world. */
  parent?: string;
  kind: 'revolute' | 'prismatic';
  axis: Vec3;
  /** World-space assembled pivot for revolute joints. */
  pivot?: Vec3;
  /** Optional measured stops, assembled pose = zero. */
  limits?: { min: number; max: number; source: 'user' | 'verified' };
};
export type GearPair = {
  a: string; b: string; teethA: number; teethB: number;
  mesh: 'external' | 'internal';
  /** Optional LDraw pitch module (tooth pitch diameter divided by count). */
  moduleLdu?: number;
  source: 'user' | 'verified' | 'inferred';
};

/** Explicit, idealized mechanical transmissions. All ratios are relative to
 * the assembled q=0 position. These are authored links, NOT automatic proof
 * of teeth engagement, force transmission, backlash, or collision clearance.
 * `a` is the rotating input, `b` the output (or sliding member for rack/lead).
 */
export type TransmissionConstraint = (
  /** `reversed`: both shafts turn the same way about their own axes (e.g. a
   * bevel pair, depending on how its shafts point); spur pairs leave it unset. */
  | { kind: 'gear' | 'belt' | 'chain'; a: string; b: string; teethA: number; teethB: number; crossed?: boolean; reversed?: boolean }
  | { kind: 'worm'; a: string; b: string; starts: number; wheelTeeth: number; reversed?: boolean }
  | { kind: 'rack-pinion'; a: string; b: string; pitchRadiusLdu: number; reversed?: boolean }
  /** Ideal straight-line, no-slip wheel roll: b is a sliding chassis, a a wheel. */
  | { kind: 'wheel-ground'; a: string; b: string; radiusLdu: number; reversed?: boolean }
  | { kind: 'linear-actuator'; a: string; b: string; leadLduPerTurn: number; reversed?: boolean }
  | { kind: 'differential'; carrier: string; left: string; right: string }
  | { kind: 'clutch'; a: string; b: string; engaged: boolean; reversed?: boolean }
) & { id: string; source: 'user' | 'verified' | 'inferred' };

export type ClosurePoint = { body: string; local: Vec3 };
export type LoopClosure = {
  a: ClosurePoint; b: ClosurePoint;
  /** Solver tolerance in LDU. Not a claim about manufactured tolerance. */
  toleranceLdu?: number;
};
export type MassSpec = { body: string; massKg: number; centreLocal?: Vec3; inertiaKgM2?: number };
export type GravitySpec = {
  /** Physics acceleration, m/s^2, LDraw positive Y is down. */
  acceleration: Vec3;
  bodies: MassSpec[];
  damping: number;
  /** Applied generalized moment (N*m for revolution, N*0.0004 for LDU translation). */
  motor?: number;
  /** Initial joint travel at release, signed rad/LDU. */
  releaseAt: number;
};
export type MechanismProgram = {
  duration: number;
  sampleHz?: number;
  mode: 'kinematic' | 'gravity';
  joints: JointDrive[];
  gears?: GearPair[];
  /** V5: ideal transmission constraints and optionally engaged clutches. */
  transmissions?: TransmissionConstraint[];
  closures?: LoopClosure[];
  /** Bodies welded to a driven leaf; inherit exactly its rigid world delta. */
  rigidFollowers?: { leader: string; bodies: string[] }[];
  /** Primary motor; periodic travel is zero at both assembled stage endpoints. */
  driver: { joint: string; amplitude: number; cycles?: number };
  /** V5: additional independent periodic motors for baked scene/video output.
   * All positions are measured from the assembled frame, units per joint kind.
   * Conflicting commanded coordinates fail the exact algebraic projection.
   */
  secondaryMotors?: { joint: string; amplitude: number; cycles?: number }[];
  gravity?: GravitySpec;
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite) && v.every(n => Math.abs(n) <= 1e7);
const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const key = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 300;

export function validateMechanismProgram(raw: unknown): string[] {
  if (raw == null) return [];
  const p = raw as Partial<MechanismProgram>;
  if (typeof p !== 'object' || Array.isArray(p)) return ['Mechanism program must be an object'];
  const errors: string[] = [];
  if (!finite(p.duration) || p.duration < 0.3 || p.duration > 60) errors.push('Duration must be 0.3–60 seconds');
  if (p.sampleHz !== undefined && (!whole(p.sampleHz) || p.sampleHz < 24 || p.sampleHz > 120))
    errors.push('Sample frequency must be 24–120 Hz');
  if (p.mode !== 'kinematic' && p.mode !== 'gravity') errors.push('Unknown mechanism mode');
  if (!Array.isArray(p.joints) || !p.joints.length || p.joints.length > 32) errors.push('1–32 moving joints required');
  const byId = new Set<string>(), byBody = new Set<string>();
  for (const [i,j] of (Array.isArray(p.joints) ? p.joints : []).entries()) {
    if (!j || !key(j.id) || !key(j.body) || (j.parent != null && !key(j.parent)) || j.body === j.parent ||
      !['revolute','prismatic'].includes(j.kind) || !vec(j.axis) || Math.hypot(...j.axis) < 1e-6 ||
      (j.kind === 'revolute' && !vec(j.pivot))) { errors.push(`Joint ${i+1}: invalid ID/body/kind/axis/pivot`); continue; }
    if (byId.has(j.id) || byBody.has(j.body)) errors.push(`Joint ${i+1}: duplicated ID or moving body`);
    byId.add(j.id); byBody.add(j.body);
    if (j.limits && (!finite(j.limits.min) || !finite(j.limits.max) || j.limits.min > 0 || j.limits.max < 0 ||
        j.limits.max < j.limits.min || !['user','verified'].includes(j.limits.source) ||
        (j.kind === 'revolute' && (j.limits.min < -2*Math.PI || j.limits.max > 2*Math.PI))))
      errors.push(`Joint ${j.id}: invalid measured stops`);
  }
  for (const [i,g] of (Array.isArray(p.gears) ? p.gears : []).entries()) {
    if (!g || !key(g.a) || !key(g.b) || g.a === g.b || !whole(g.teethA) || !whole(g.teethB) ||
        g.teethA < 4 || g.teethB < 4 || g.teethA > 500 || g.teethB > 500 ||
        !['external','internal'].includes(g.mesh) || !['user','verified','inferred'].includes(g.source) ||
        (g.moduleLdu !== undefined && (!finite(g.moduleLdu) || g.moduleLdu <= 0 || g.moduleLdu > 100)))
      errors.push(`Gear pair ${i+1}: invalid tooth counts, mesh type, or evidence`);
    else if (!byId.has(g.a) || !byId.has(g.b)) errors.push(`Gear pair ${i+1}: unknown joint`);
  }
  if (p.transmissions !== undefined && !Array.isArray(p.transmissions))
    errors.push('Transmissions must be an array');
  if ((p.transmissions?.length ?? 0) > 64) errors.push('Maximum 64 transmissions');
  const transmissionIds = new Set<string>();
  for (const [i,t] of (Array.isArray(p.transmissions) ? p.transmissions : []).entries()) {
    if (!t || !key(t.id) || transmissionIds.has(t.id) ||
        !['gear','belt','chain','worm','rack-pinion','wheel-ground','linear-actuator','differential','clutch'].includes(t.kind) ||
        !['user','verified','inferred'].includes(t.source)) {
      errors.push(`Transmission ${i+1}: invalid or duplicate ID/kind/source`); continue;
    }
    transmissionIds.add(t.id);
    const ids = t.kind === 'differential' ? [t.carrier,t.left,t.right] : [t.a,t.b];
    if (ids.some(id=>!key(id)||!byId.has(id)) || new Set(ids).size !== ids.length) {
      errors.push(`Transmission ${t.id}: joints must be distinct and exist`); continue;
    }
    const kindOf = (id:string) => (Array.isArray(p.joints) ? p.joints : []).find(j=>j.id===id)?.kind;
    if (t.kind === 'differential' ? ids.some(id=>kindOf(id)!=='revolute') :
        (kindOf(t.a)!=='revolute' || kindOf(t.b) !==
          (t.kind === 'rack-pinion' || t.kind === 'wheel-ground' || t.kind === 'linear-actuator' ? 'prismatic' : 'revolute')))
      errors.push(`Transmission ${t.id}: incompatible rotational/linear joint types`);
    const positive = (v:unknown, max:number) => finite(v) && v > 0 && v <= max;
    if ((t.kind === 'gear' || t.kind === 'belt' || t.kind === 'chain') &&
        (!whole(t.teethA) || !whole(t.teethB) || t.teethA > 500 || t.teethB > 500))
      errors.push(`Transmission ${t.id}: invalid tooth counts`);
    if (t.kind === 'worm' && (!whole(t.starts) || t.starts > 8 || !whole(t.wheelTeeth) || t.wheelTeeth > 500))
      errors.push(`Transmission ${t.id}: invalid worm starts or wheel teeth`);
    if (t.kind === 'wheel-ground' && !positive(t.radiusLdu, 1e5))
      errors.push(`Transmission ${t.id}: invalid wheel radius`);
    if (t.kind === 'rack-pinion' && !positive(t.pitchRadiusLdu, 1e5))
      errors.push(`Transmission ${t.id}: invalid pitch radius`);
    if (t.kind === 'linear-actuator' && !positive(t.leadLduPerTurn, 1e5))
      errors.push(`Transmission ${t.id}: invalid screw lead`);
    if (t.kind === 'clutch' && typeof t.engaged !== 'boolean')
      errors.push(`Transmission ${t.id}: clutch engagement must be Boolean`);
    if ('reversed' in t && t.reversed !== undefined && typeof t.reversed !== 'boolean')
      errors.push(`Transmission ${t.id}: reversed flag must be Boolean`);
    if ('crossed' in t && t.crossed !== undefined && typeof t.crossed !== 'boolean')
      errors.push(`Transmission ${t.id}: crossed flag must be Boolean`);
  }
  if (p.mode === 'gravity' && p.transmissions?.length)
    errors.push('V5 transmission networks currently require kinematic mode; reduced gravity mode does not handle multiple coupled motor coordinates');
  if (p.gears !== undefined && !Array.isArray(p.gears)) errors.push('Gear pairs must be an array');
  if ((p.gears?.length ?? 0) > 48) errors.push('Maximum 48 gear pairs');
  for (const [i,c] of (Array.isArray(p.closures) ? p.closures : []).entries()) {
    if (!c || !c.a || !c.b || !key(c.a.body) || !key(c.b.body) || !vec(c.a.local) || !vec(c.b.local) ||
        (c.toleranceLdu !== undefined && (!finite(c.toleranceLdu) || c.toleranceLdu < 0.01 || c.toleranceLdu > 1)))
      errors.push(`Loop closure ${i+1}: invalid endpoints/tolerance`);
  }
  if (p.closures !== undefined && !Array.isArray(p.closures)) errors.push('Loop closures must be an array');
  if ((p.closures?.length ?? 0) > 16) errors.push('Maximum 16 loop closures');
  const assigned=new Set([...byBody]);
  for(const [i,f] of (Array.isArray(p.rigidFollowers)?p.rigidFollowers:[]).entries()){
    if(!f || !key(f.leader) || !byBody.has(f.leader) || !Array.isArray(f.bodies) || !f.bodies.length || f.bodies.length>32)
      {errors.push(`Rigid follower group ${i+1}: invalid leader or members`);continue;}
    for(const b of f.bodies){
      if(!key(b) || assigned.has(b))errors.push(`Rigid follower ${String(b)}: duplicate or driven by another joint`);
      assigned.add(b);
    }
  }
  if (p.rigidFollowers !== undefined && !Array.isArray(p.rigidFollowers)) errors.push('Rigid followers must be an array');
  if((p.rigidFollowers?.length??0)>32)errors.push('Maximum 32 rigid follower groups');
  if (!p.driver || !key(p.driver.joint) || !byId.has(p.driver.joint) ||
      !finite(p.driver.amplitude) || Math.abs(p.driver.amplitude) > 500 ||
      (p.driver.cycles !== undefined && (!whole(p.driver.cycles) || p.driver.cycles > 8)))
    errors.push('Driver must name an existing joint and have finite amplitude');
  if(p.secondaryMotors !== undefined && !Array.isArray(p.secondaryMotors))
    errors.push('Secondary motors must be an array');
  if((p.secondaryMotors?.length ?? 0)>8)errors.push('Maximum 8 secondary motors');
  const motorNames=new Set<string>();
  for(const [i,m] of (Array.isArray(p.secondaryMotors)?p.secondaryMotors:[]).entries()){
    if(!m || !key(m.joint) || !byId.has(m.joint) || m.joint===p.driver?.joint || motorNames.has(m.joint) ||
      !finite(m.amplitude) || Math.abs(m.amplitude)>500 ||
      (m.cycles!==undefined && (!whole(m.cycles) || m.cycles>8)))
      errors.push(`Secondary motor ${i+1}: invalid or duplicate motor joint/amplitude/cycles`);
    else motorNames.add(m.joint);
  }
  if(p.mode==='gravity' && p.secondaryMotors?.length)
    errors.push('Secondary motors require kinematic mode');
  if (p.mode === 'gravity') {
    const g = p.gravity;
    if (!g || !vec(g.acceleration) || Math.hypot(...g.acceleration) > 100 ||
        !finite(g.damping) || g.damping < 0 || g.damping > 100 ||
        !finite(g.releaseAt) || Math.abs(g.releaseAt) > 500 ||
        (g.motor !== undefined && (!finite(g.motor) || Math.abs(g.motor) > 100)))
      errors.push('Gravity mode requires physical acceleration, damping and a release position');
    if (!Array.isArray(g?.bodies) || !g.bodies.length || g.bodies.length > 128)
      errors.push('Gravity mode requires 1–128 explicit body masses');
    const massNames=new Set<string>();
    for (const b of Array.isArray(g?.bodies) ? g.bodies : []) {
      if (!b || !key(b.body) || !assigned.has(b.body) || !finite(b.massKg) || b.massKg <= 0 || b.massKg > 100 ||
          (b.centreLocal !== undefined && !vec(b.centreLocal)) ||
          (b.inertiaKgM2 !== undefined && (!finite(b.inertiaKgM2) || b.inertiaKgM2 <= 0)))
        errors.push(`Mass for ${String(b?.body)} is invalid`);
      else if (massNames.has(b.body)) errors.push(`Duplicate physical mass: ${b.body}`);
      else massNames.add(b.body);
    }
    for(const name of assigned) if(!massNames.has(name))
      errors.push(`Explicit mass required for moving body ${name}`);
  } else if (p.gravity) errors.push('Gravity parameters are only valid in gravity mode');
  return errors;
}
