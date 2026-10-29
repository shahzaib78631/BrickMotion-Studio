/**
 * Mechanism V5: ideal, explicit transmission constraints and a rank-aware
 * projection solver. No mesh contact is inferred by this module.
 *
 * Rotational coordinates are radians; linear coordinates are LDU. Every
 * constraint is expressed relative to the imported assembled pose (q=0).
 * Nothing here claims force, slip, backlash, or collision validity.
 */
import type { JointDrive, TransmissionConstraint } from './mechanismProgram';

export type LinearEquation = { id: string; coefficients: ReadonlyMap<string, number>; rhs: number };
export type RootFactor = { root: string; ratio: number };
export type Projection = { roots: Map<string, number>; rank: number; maxResidual: number };
const TPI = 2 * Math.PI;
const signed = (reversed?: boolean) => reversed ? -1 : 1;
const eq = (id: string, items: readonly (readonly [string, number])[]): LinearEquation => {
  const coefficients = new Map<string, number>();
  for (const [key, value] of items) coefficients.set(key, (coefficients.get(key) ?? 0) + value);
  return { id, coefficients, rhs: 0 };
};

/** Dimensionally exact ideal ratios. Pivots, tooth contact and bearing
 * geometry must be checked separately in a later geometric verifier. */
export function transmissionEquation(t: TransmissionConstraint): LinearEquation | null {
  switch (t.kind) {
    case 'gear': return eq(t.id, [[t.b, t.teethB], [t.a, t.teethA]]);
    case 'belt': return eq(t.id, [[t.b, t.teethB], [t.a, (t.crossed ? 1 : -1) * t.teethA]]);
    case 'chain': return eq(t.id, [[t.b, t.teethB], [t.a, -t.teethA]]);
    case 'worm': return eq(t.id, [[t.b, t.wheelTeeth], [t.a, -signed(t.reversed) * t.starts]]);
    case 'rack-pinion': return eq(t.id, [[t.b, 1], [t.a, -signed(t.reversed) * t.pitchRadiusLdu]]);
    case 'wheel-ground': return eq(t.id, [[t.b, 1], [t.a, signed(t.reversed) * t.radiusLdu]]);
    case 'linear-actuator': return eq(t.id, [[t.b, 1], [t.a, -signed(t.reversed) * t.leadLduPerTurn / TPI]]);
    case 'differential': return eq(t.id, [[t.left, 1], [t.right, 1], [t.carrier, -2]]);
    case 'clutch': return t.engaged ? eq(t.id, [[t.b, 1], [t.a, -signed(t.reversed)]]) : null;
  }
}

/** Collapse old V4 gear groups to joint-independent root variables. */
export function intoRootEquation(
  source: LinearEquation,
  factors: ReadonlyMap<string, RootFactor>,
): LinearEquation {
  const coefficients = new Map<string, number>();
  for (const [joint, value] of source.coefficients) {
    const factor = factors.get(joint);
    if (!factor) throw Error(`Transmission ${source.id} references unknown joint ${joint}`);
    coefficients.set(factor.root, (coefficients.get(factor.root) ?? 0) + value * factor.ratio);
  }
  return { id: source.id, coefficients, rhs: source.rhs };
}

/** Normalize each equation and orthogonalize by modified Gram-Schmidt,
 * including the right-hand side. This detects dependent/contradictory loops
 * instead of inverting an ill-conditioned A*A^T matrix. The result minimizes
 * Euclidean displacement from the supplied seed on the feasible manifold.
 */
export function projectLinearConstraints(
  rootNames: readonly string[],
  equations: readonly LinearEquation[],
  seed: ReadonlyMap<string, number>,
): Projection {
  const names = new Set(rootNames);
  if (names.size !== rootNames.length || rootNames.length > 48) throw Error('Invalid or excessive transmission roots');
  const basis: { vector: number[]; rhs: number }[] = [];
  for (const e of equations) {
    if (!Number.isFinite(e.rhs)) throw Error(`Nonfinite transmission target ${e.id}`);
    for (const [id, value] of e.coefficients) {
      if (!names.has(id) || !Number.isFinite(value)) throw Error(`Invalid transmission coefficient in ${e.id}`);
    }
    const original = rootNames.map(id => e.coefficients.get(id) ?? 0);
    const scale = Math.hypot(...original);
    if (!Number.isFinite(scale)) throw Error(`Unbounded transmission coefficient ${e.id}`);
    if (scale < 1e-13) {
      if (Math.abs(e.rhs) > 1e-8) throw Error(`Contradictory transmission constraint ${e.id}`);
      continue;
    }
    const vector = original.map(value => value / scale);
    let rhs = e.rhs / scale;
    // Re-orthogonalize once: gear and differential cycles can be almost dependent.
    for (let pass = 0; pass < 2; pass++) for (const b of basis) {
      const projection = vector.reduce((sum, x, i) => sum + x * b.vector[i], 0);
      for (let i = 0; i < vector.length; i++) vector[i] -= projection * b.vector[i];
      rhs -= projection * b.rhs;
    }
    const length = Math.hypot(...vector);
    if (length < 1e-9) {
      if (Math.abs(rhs) > 1e-8) throw Error(`Contradictory transmission constraint ${e.id}`);
      continue;
    }
    if (!Number.isFinite(length) || !Number.isFinite(rhs / length)) throw Error(`Unstable transmission ${e.id}`);
    basis.push({ vector: vector.map(x => x / length), rhs: rhs / length });
  }
  const result = rootNames.map(id => seed.get(id) ?? 0);
  if (result.some(x => !Number.isFinite(x))) throw Error('Nonfinite transmission seed');
  for (const b of basis) {
    const error = result.reduce((sum, x, i) => sum + x * b.vector[i], 0) - b.rhs;
    for (let i = 0; i < result.length; i++) result[i] -= error * b.vector[i];
  }
  let maxResidual = 0;
  for (const e of equations) {
    const error = rootNames.reduce((sum, id, i) => sum + (e.coefficients.get(id) ?? 0) * result[i], 0) - e.rhs;
    const norm = Math.max(1, Math.hypot(...[...e.coefficients.values()]));
    maxResidual = Math.max(maxResidual, Math.abs(error) / norm);
  }
  if (maxResidual > 1e-6 || result.some(x => !Number.isFinite(x)))
    throw Error(`Transmission constraints cannot close (residual ${maxResidual.toExponential(2)})`);
  return { roots: new Map(rootNames.map((id, i) => [id, result[i]])), rank: basis.length, maxResidual };
}

/** Clamp-to-bound active set. Unlike naive coordinate clamps this preserves
 * coupled transmissions, or explicitly rejects an impossible request. */
export function projectLimitedNetwork(
  roots: readonly string[],
  equations: readonly LinearEquation[],
  seed: ReadonlyMap<string, number>,
  limits: ReadonlyMap<string, { min: number; max: number }>,
): Projection {
  let active: LinearEquation[] = [];
  const pinned = new Set<string>();
  for (let step = 0; step <= roots.length; step++) {
    const result = projectLinearConstraints(roots, [...equations, ...active], seed);
    const violations = roots.map(id => {
      const x = result.roots.get(id)!;
      const lim = limits.get(id) ?? { min: -Infinity, max: Infinity };
      const target = x < lim.min ? lim.min : x > lim.max ? lim.max : x;
      return { id, target, error: Math.abs(x - target) };
    }).filter(item => item.error > 1e-7).sort((a, b) => b.error - a.error);
    if (!violations.length) return result;
    const next = violations.find(item => !pinned.has(item.id));
    if (!next) throw Error('Transmission motion exceeds a physical joint stop');
    pinned.add(next.id);
    active.push({ id: `stop:${next.id}`, coefficients: new Map([[next.id, 1]]), rhs: next.target });
  }
  throw Error('Transmission joint limits cannot be satisfied');
}

/** Builds typed constraints while checking that revolute/prismatic units are not
 * accidentally mixed. User-authored ratios remain explicitly unverified. */
export function prepareTransmissionEquations(
  constraints: readonly TransmissionConstraint[],
  joints: ReadonlyMap<string, JointDrive>,
  engagements?: Readonly<Record<string, boolean>>,
): LinearEquation[] {
  const out: LinearEquation[] = [];
  const expectKind = (id: string, kind: JointDrive['kind'], label: string) => {
    if (joints.get(id)?.kind !== kind) throw Error(`${label}: ${id} must be ${kind}`);
  };
  for (const t of constraints) {
    if (t.kind === 'differential') {
      for (const id of [t.carrier, t.left, t.right]) expectKind(id, 'revolute', t.id);
    } else {
      expectKind(t.a, 'revolute', t.id);
      expectKind(t.b, t.kind === 'rack-pinion' || t.kind === 'wheel-ground' || t.kind === 'linear-actuator' ? 'prismatic' : 'revolute', t.id);
    }
    const constraint = t.kind === 'clutch' && engagements?.[t.id] !== undefined
      ? { ...t, engaged: engagements[t.id] } as TransmissionConstraint : t;
    const equation = transmissionEquation(constraint);
    if (equation) out.push(equation);
  }
  return out;
}
