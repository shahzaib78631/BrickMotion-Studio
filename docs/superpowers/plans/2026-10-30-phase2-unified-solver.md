# Phase 2: Unified Kinematic Solver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One joint-coordinate kinematic solver with analytic Jacobians, a predictor-corrector, a singularity stop, several simultaneous drivers and inequality limits. It replaces the numerics of the v4 `MechanismSolver` and the whole v6 `SpatialMechanismSolver`. v6 is then deleted.

**Architecture:** Bodies move by world deltas `D_b = pose_b · rest_b⁻¹`. A spanning tree from ground gives `D_child = D_parent · M_j(q_j)`, where every joint motion is a product of exponentials of rest-world twists. Each non-tree joint is a cut joint: it keeps its own coordinates and adds a 6-equation closure, as in Müller's cut-body form already used by `mobility/`. Laws (gears, Ackermann, cams and so on) are equations on scalar joint coordinates. The corrector is Levenberg–Marquardt in weighted coordinates, so the solution is the minimum change from the last pose. Continuation subdivides the driver step and never clamps it.

**Tech Stack:** TypeScript. No three.js in the core. Tests run in vitest, plus the existing `scripts/verify-*.cjs` offline suites.

**Spec:** `docs/superpowers/specs/2026-10-30-mechanism-recognition-design.md` §3, and §8 row 2.

## Global Constraints

- Acceptance (§8): "All v4 and v6 tests pass on it; v6 deleted". This means vitest `tests/anim`, `tests/diagnostics/mechanismBenchmark.test.ts`, and `npm run verify:v8:all`, which includes the v4–v8 offline suites. The 5590 benchmark stays at 17/17.
- Dynamics are out of scope. XPBD is not used for kinematics.
- Rotations are weighted as `UNIT = 20` LDU per radian. This is `mobility/screw.ts` `UNIT` and v6 `ORIENTATION_LDU`.
- Fail closed: a failed solve never replaces the last accepted pose, and it reports a plain reason.
- `minifigInsertion.test.ts` already fails on the base commit and is not in scope.
- Commit as steps on `feat/v8-review`. Never push. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A driver pushed through a toggle**, for example a four-bar crank at the dead point, must stop with `status: 'singular'` and must not flip the coupler to the other branch. Test this in Task 3.
2. **Redundant LEGO constraints**, such as a parallelogram with all four pins or a doubled closure, must still converge, and rank deficiency must not be reported as a singularity. Test this in Task 3.
3. **Large driver jumps**, up to π per frame on a closed loop, must subdivide and land on the continuous branch. Test this in Task 3.
4. **Hinge angles past ±2π** must keep winding, so a hinge returns 4π after two turns and is never wrapped. Test this in Task 2.
5. **A tree with the hinge stored in the reversed direction** (the child is v6 `a`) must report the same signed angle as v6. Test this in Task 5.

---

### Task 1: Rigid-body math and the kinematic system (FK, residual, analytic Jacobian)

**Files:**
- Create: `src/anim/motion/kinematics/rigid.ts`, which holds `Frame {R: number[9] row-major, p: V3}`, `compose`, `invert`, `apply`, `expSO3`, `logSO3`, `invLeftJacobianSO3`, `quatToR`, `rToQuat` and `adjoint`.
- Create: `src/anim/motion/kinematics/system.ts`.
- Test: `tests/anim/kinematicsSystem.test.ts`.

**Interfaces (produces):**
```ts
type JointKind = 'revolute'|'prismatic'|'cylindrical'|'universal'|'spherical'|'planar'|'fixed';
type JointSpec = { id: string; parent: string | null; child: string; kind: JointKind;
  point: V3; axis: V3; axis2?: V3 };            // rest-world geometry; parent null = ground
type Equation =                                  // cut-only constraints
  | { kind: 'point'; id: string; a: string|null; b: string|null; point: V3 }          // 3 eq
  | { kind: 'distance'; id: string; a: string|null; pa: V3; b: string|null; pb: V3; length: number }
  | { kind: 'rolling'; id: string; carrier: string|null; frame: string; point: V3; along: V3; coord: string; ratio: number };
type Coord = string;                             // 'joint' or 'joint:k'
class KinematicSystem {
  constructor(spec: { bodies: string[]; joints: JointSpec[]; equations?: Equation[] });
  readonly coords: Coord[]; readonly angular: boolean[]; readonly tree: string[]; readonly cuts: string[];
  zeroState(): State;                            // all coordinates 0, spherical identity
  value(s: State, c: Coord): number;
  step(s: State, delta: Float64Array): State;    // spherical: left-multiplied exp
  deltas(s: State): Map<string, Frame>;          // D_b per body
  constraints(s: State): { rows: Row[] };        // Row = {id, value, grad: Float64Array}
}
```
Tree: BFS from ground. Prefer `fixed` joints, then joints with fewer coordinates. Joint geometry is in rest-world. The cut residual is the position at `point` plus `UNIT·log(R_b R_target^T)`, and its Jacobian uses `invLeftJacobianSO3`, so it is exact away from the closure, not only at it. A twist's world value is `adjoint(D_parent · prefix)` of the rest twist.

- [ ] **Step 1: Failing tests.**
  - `analytic Jacobian matches central differences`: random spatial loops with every joint kind, about 3 seeds. Move off the closure by `step(s, random·0.3)` and require max abs difference < 1e-6 with h = 1e-6.
  - `FK of a revolute chain`: 2 links, hinge 0.3 rad. The arm tip is at `[10cos.3, 10sin.3, 0]`.
  - `assembled pose closes`: every row is 0 at `zeroState()`.
- [ ] **Step 2: Run** `npx vitest run tests/anim/kinematicsSystem.test.ts`. Expect a FAIL because the module is not found.
- [ ] **Step 3: Implement** `rigid.ts` and `system.ts`.
- [ ] **Step 4: Run** the same command. Expect a PASS.
- [ ] **Step 5: Commit** `feat(kinematics): joint-coordinate system with analytic closure Jacobian`.

### Task 2: Laws on joint coordinates (the v6 mechanics port)

**Files:**
- Create: `src/anim/motion/kinematics/laws.ts`. It reuses `v8/mechanismLaws.ts`.
- Test: `tests/anim/kinematicsLaws.test.ts`.

**Interfaces (produces):**
```ts
type Law = { id: string; coords: Coord[]; rows: number; scale: number[];
  f(x: number[]): number[]; grad?(x: number[]): number[][] };     // default grad = central diff (h 1e-6)
type Inequality = { id: string; coords: Coord[]; a: number[]; lo: number; hi: number }; // lo ≤ a·x ≤ hi
function lawsFromMechanics(m: SpatialMechanic[], ctx: { coordOf(id: string): Coord; isHinge(id: string): boolean;
  accepted(id: string): number; drive(id: string): number|undefined; ratchetStop(id: string): number })
  : { laws: Law[]; inequalities: Inequality[] };
```
Each of the 27 v6 kinds maps to the same formula and scale as v6 `measure()`. The following kinds become inequalities instead of penalty residuals:
- `stop` becomes `[min, max]`;
- `ratchet` becomes a one-sided limit at the stop;
- `backlash-gear` becomes `|out − f·in| ≤ clearance`, so minimum change holds the output inside the gap.

`brake` holds 0, as v6 does. `detent` targets the nearest pitch of the drive or of the accepted value. A disengaged `clutch` adds no law.

- [ ] **Step 1: Failing tests.** For each kind, check `f` on one hand-computed point:
  - a 24:8 gear gives `out = −3·in`;
  - Ackermann with wheelbase 100 and track 60 at 0.2 rad gives the left/right `atan2` values;
  - planetary sun 12 and ring 36;
  - slider-crank equals `sliderCrankTravel`;
  - a winch with 2 segments gives `r/2`.

  Also check that `grad` agrees with central difference for every nonlinear law.
- [ ] **Step 2: Run** `npx vitest run tests/anim/kinematicsLaws.test.ts`. Expect a FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect a PASS.
- [ ] **Step 5: Commit** `feat(kinematics): v6 mechanism laws as joint-coordinate equations`.

### Task 3: Solver: corrector, predictor/continuation, active set, singularity stop

**Files:**
- Create: `src/anim/motion/kinematics/solve.ts`.
- Test: `tests/anim/kinematicsSolve.test.ts`.

**Interfaces (produces):**
```ts
type Drivers = ReadonlyMap<Coord, number>;
type SolveOptions = { tolerance?: number /* LDU, default 0.01 */; maxSubdivisions?: number /* 6 */;
  maxIterations?: number /* 40 per substep */; laws?: Law[]; inequalities?: Inequality[];
  extraRows?: (s: State) => Row[] };
type SolveResult = { status: 'converged'|'singular'|'failed'; state: State; iterations: number;
  maxResidual: number; residuals: Map<string, number>; conditioning: number; freeDof: number;
  active: string[]; reason?: string };
function solve(sys: KinematicSystem, from: State, drivers: Drivers, opts?: SolveOptions): SolveResult;
```

The step algorithm:
1. The corrector solves `(JᵀJ + μI) z = −Jᵀr` in weighted coordinates, with `z = W·δ`, angular weight `UNIT` and linear weight 1. μ follows Nielsen's update and starts at 1e-3·max diag. The first step from an accepted pose is the tangent predictor.
2. Continuation: the move from the previous drivers to the new ones is split in halves when any of these happens:
   - the corrector fails;
   - one substep moves more than 0.5 rad or 10 LDU weighted;
   - conditioning drops by more than 10× within the substep.

   Splitting stops after `maxSubdivisions` levels.
3. Active set: after convergence, add the worst violated inequality as an equality at its bound and re-solve from the same start. Repeat at most n times. If it is still violated, return `failed` with the reason "exceeds a physical joint stop".
4. Singularity: let `r0` be the rank of the weighted J (eigen of JᵀJ, tolerance 1e-9·σ²max) at the start pose for this driver set. Conditioning is the `r0`-th largest σ. Return `singular` when it falls below `1e-3·σmax` (the rank drops at a toggle). The state that comes back is then the last good substep. Redundant constraints are already deficient in `r0`, so they never trigger this.

- [ ] **Step 1: Failing tests:**
  - `four-bar follows its crank`: closure < 1e-6 at 0..1.5 rad.
  - `crank-rocker passes 0→2π→0 continuously`: the rocker angle sequence is monotone between extremes and comes back to 0 at 2π.
  - `jump of 3 rad lands on the same branch as 30 small steps`: the state difference is < 1e-6.
  - `toggle stops`: a four-bar with a rocker limit position, driven past the dead point, gives `status 'singular'`, and the returned state is within 0.05 rad of the toggle.
  - `parallelogram with a redundant fifth bar converges`, and conditioning stays > 1e-3.
  - `two drivers at once`: a 2-DOF five-bar driven on both cranks matches the closed-form position.
  - `minimum change`: an undriven free hinge stays at its previous value.
  - `stop`: a driven joint coupled by a gear to a limited joint is held at the bound. A request beyond it gives `failed` with the reason containing "joint stop".
  - `Bennett linkage`: 1 DOF, and freeDof is 0 with a driver.
- [ ] **Step 2: Run** `npx vitest run tests/anim/kinematicsSolve.test.ts`. Expect a FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect a PASS.
- [ ] **Step 5: Commit** `feat(kinematics): predictor-corrector with active set and singularity stop`.

### Task 4: The v4 MechanismSolver on the core

**Files:**
- Modify: `src/anim/motion/v4/mechanismSolver.ts`. Constructor validation and messages stay as they are. `evaluateRoots`, `residual`, `solveNormal` and the two LM loops go.
- Modify: `src/anim/motion/v4/transmissionNetwork.ts`. Keep `transmissionEquation` and `prepareTransmissionEquations`. Remove `projectLimitedNetwork` and `intoRootEquation` once they are unused.
- Test: the existing `tests/anim/{rackContact,transmissionV5,mechanismLab,standardMotionV4Mechanisms,drivetrainSuggestions}.test.ts` and `verify:v4:mechanisms:offline`, `verify:v5:offline`.

Mapping:
- `JointDrive` becomes revolute/prismatic. A parent that is not a joint body is static, which means ground.
- Gears and transmissions become linear `Law`s, with `engagements` overriding them.
- Closures become `point` equations with their own tolerance.
- Rack contacts become `rolling` equations. The travel and engagement checks stay in `assertClosed`.
- Limits become inequalities.
- `rigidFollowers` and the gear shaft alignment checks run on the solved deltas, as today.
- `solve(x)` is `solveInputs({driver: x})`.

`SolvedFrame` keeps every field. A joint stop failure keeps the message "The requested driver position violates a physical joint stop" for a single driver and "Transmission motion exceeds a physical joint stop" for `solveInputs`. Non-convergence keeps "Unreachable closed linkage at …".

- [ ] **Step 1: Run** the listed suites on the old code and record the pass counts as the baseline.
- [ ] **Step 2: Port.**
- [ ] **Step 3: Run** `npx vitest run tests/anim tests/diagnostics`, `npm run verify:v4:mechanisms:offline` and `npm run verify:v5:offline`. Expect the same pass counts, with only the minifig failure.
- [ ] **Step 4: Run** the 5590 benchmark. Expect 17/17.
- [ ] **Step 5: Commit** `refactor(v4): MechanismSolver runs on the unified kinematic solver`.

### Task 5: Spatial rig API on the core; v6 deleted

**Files:**
- Create: `src/anim/motion/kinematics/spatialModel.ts`. It holds the v6 types (`SpatialModel`, `SpatialMechanic`, …), `validateSpatialModel` with its messages unchanged, and `SpatialMechanismSolver`, which keeps v6's public API and result shape.
- Move: `v6/{geometryScreen,spatialAdapter,spatialMechanicProposal,spatialRig,spatialSweep}.ts` to `src/anim/motion/spatial/`.
- Delete: `src/anim/motion/v6/`.
- Modify imports in `v4/drivetrainSuggestions.ts`, `v4/mechanismLab.ts`, `v8/spatialClip.ts`, `state/mechanismLab.ts`, `ui/{Viewport,SpatialMechanicsDesigner,MechanismLabPanel}.tsx`, two tests and the six `scripts/verify-*` files.

Mapping:
- hinge → revolute, slider → prismatic, cylindrical, universal (axis = `axisA`, axis2 = `axisB`), planar (axis = normal), ball → spherical, weld → fixed. The geometry is the world rest pose of `a`'s local anchor and axes.
- A tree joint whose child is v6 `a` is stored reversed with negated axes, so the coordinate keeps v6's sign.
- distance → `distance` equation.
- Drives become drivers. The jump ≥ π check and its message stay.
- `jointPositions` are coordinates, so they unwind naturally.
- `residualByConstraint` is 0 for tree joints, and the closure norm for cuts and laws (`mechanic:id`).
- `estimatedFreeDof = n − rank`.
- Engagement mirroring and ratchet memory work as in v6.

- [ ] **Step 1: Run** `npm run verify:v6:offline`, `verify:v7:offline`, `verify:v8:offline` and `verify:v8:properties` on the old code and record the baseline.
- [ ] **Step 2: Failing test** `tests/anim/kinematicsSpatial.test.ts`:
  - a reversed hinge gives the same signed angle as forward;
  - a hinge driven in 0.5 rad steps to 4π reports 4π.
- [ ] **Step 3: Implement, move, rewire and delete v6.**
- [ ] **Step 4: Run** `npm run verify:v8:all`, `npx vitest run` and `npx tsc --noEmit -p .`. Expect all green except minifig.
- [ ] **Step 5: Commit** `refactor(mechanisms): spatial rigs on the unified solver; retire v6`.

### Task 6: Docs and acceptance

- [ ] Mark §8 Phase 2 ✓ in the spec with measured results: the suite counts, the 5590 result, and the solve time per frame on 5590 compared with before. Update the "Two solvers" sentence in §1.
- [ ] Commit `docs: phase 2 done`.
