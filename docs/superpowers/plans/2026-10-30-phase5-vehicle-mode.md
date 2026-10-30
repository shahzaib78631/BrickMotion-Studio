# Phase 5 Vehicle Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise a model as a vehicle, drive it round a circle with every wheel rolling at its own speed, report turning centre, Ackermann error and tyre scrub (tandem axles included), and sweep suspensions for camber gain and bump steer.

**Architecture:** A new `src/anim/motion/vehicle/` module. `vehicle.ts` finds ground wheels, axles and the chassis from measured tyre geometry and the recognised joints. `rolling.ts` is pure plane geometry: the turning centre (ICR) as the least-squares meet of the axle lines, slip per wheel, spin per unit of travel, yaw. `vehicleReport.ts` reads steered wheel headings from the existing steering suggestion's solver. `vehiclePlayback.ts` turns a steer position plus a distance into poses for the whole model. `suspension.ts` measures shock stroke from part geometry and sweeps suspension programs. The Lab gets a vehicle suggestion (the steering program plus a serialisable `vehicle` field) and two readouts.

**Tech Stack:** TypeScript, three.js matrices, vitest (+ happy-dom for UI), React, zustand.

**Spec:** `docs/superpowers/specs/2026-10-30-mechanism-recognition-design.md` §5 (and §7 for the `scrub` check, §8 row 5 for acceptance).

## Global Constraints

- Evidence ladder: "Only measured or connector evidence may create a constraint; posed and inferred evidence may only rank or label." Wheels come from measured tyre geometry; steer comes from the solved steering mechanism.
- Fail closed: "A mechanism we cannot prove over its whole travel is not offered. A rejection always comes with a plain reason."
- Acceptance (§8 row 5): "5590 drives a circle with correct wheel spins; tandem-axle scrub reported; suspension sweep gives bump steer".
- LDraw axes: −Y is up; the ground is the largest Y any ground tyre reaches.
- Commit only on `feat/v8-review`; never push. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Kinebrick data (CC BY-SA 4.0) only as an oracle, with attribution. Model files stay uncommitted under `samples/`.
- Do not touch the failing `minifigInsertion` test.
- Every tolerance accepted against a model file is listed for the user (README results).

## Out of scope (stated, not dropped)

- Terrain under each wheel driving the suspension loops, and chassis pitch, roll and heave (§5.1, §5.6 first half): the sweep drives each suspension at its own input instead. Chassis motion is planar x, z, yaw.
- Trailer articulation: towed units ride rigidly with the chassis.
- Wheels joined through a recognised differential are free (each rolls at its own speed); only wheels in one rigid body form a solid axle.

## Review Focus

1. A towed trailer (5590) or a spare tyre lying on the model (5590's steering knob is a tyre) → neither is a ground wheel of the truck; trailer tyres are listed in `towed`, not dropped silently. Test in Task 1.
2. Driving straight (steer giving parallel axle lines) → no ICR (`null`), radius `Infinity`, zero slip and yaw, no NaN anywhere. Test in Task 2.
3. Two wheels on one solid axle → they share one spin, and the mismatch is reported as longitudinal scrub instead of each rolling freely. Test in Task 2.
4. A wheel whose contact point is behind/ahead of the ICR on the far side (ICR between the axles, e.g. tandem) → slip angles of opposite sign, never wrapped past ±90°. Test in Task 2 (tandem) and Task 3 (5590).
5. A suspension whose shock stroke cannot be measured from its parts → the sweep still runs over the proven travel and says the stroke was not measured. Test in Task 5.

---

### Task 1: Vehicle recognition

**Files:**
- Create: `src/anim/motion/vehicle/vehicle.ts`
- Modify: `src/anim/motion/v4/mechanismLab.ts` (`LabReport.vehicle: Vehicle | null`, computed after `classify`)
- Test: `tests/anim/vehicle/vehicle.test.ts`

**Interfaces:**
- Consumes: `isTyre(part, metrics)` (libraryConnectors.ts), `partFunctions`, `Recognition`, `NamedMechanism` (`parts.wheels`, `parts.hubs`, kinds `rack-steering` | `steering` | `turntable`).
- Produces:
```ts
export type VehicleWheel = {
  tyre: string;            // tyre part key
  parts: string[];         // every part key that spins with the tyre (its recognition body)
  centre: Vec3; axis: Vec3; // world, axis unit and horizontal, at rest
  radius: number;          // rolling radius, LDU
  axle: number;            // index into Vehicle.axles
  steered: boolean;        // on a hub of the steering mechanism
};
export type Vehicle = {
  wheels: VehicleWheel[];
  axles: { solid: boolean; steered: boolean }[];
  groundY: number;
  forward: Vec3;   // unit, horizontal: from ref toward the steered axle
  ref: Vec3;       // centre of the non-steered axles (all axles if none), on the ground
  towed: string[]; // ground tyres left out: on a unit hinged to the chassis that is not steering (a trailer)
  steering?: string; // name of the steering NamedMechanism
  warnings: string[];
};
export function recognizeVehicle(asm: Assembly, rec: Recognition, named: readonly NamedMechanism[], metrics: Metrics): Vehicle | null;
```

Rules (values to use):
- Ground tyres: tyres whose world-box bottom (max Y) is within `GROUND = 2` LDU of the largest bottom over all tyres, with a horizontal axis (|axis.y| ≤ sin 10°). `groundY` = that largest bottom.
- Rolling radius = half the tyre's world-box Y extent (exact for a horizontal axle at any yaw).
- Spinning: the tyre's body must have a revolute joint whose axis is within 4° of the tyre axis and whose line passes within 2.5 LDU of the tyre centre; otherwise the tyre is left out with the warning `"<part> at (x,y,z) does not turn on its own axle"`.
- Chassis = the largest recognition body (`groundOf`). Breadth-first from each wheel body toward the chassis; if the path crosses a revolute with a vertical axis (|axis.y| ≥ cos 30°) that is not a joint of the steering mechanism's hubs, the tyre goes to `towed` (warning `"N trailer wheels are towed, not driven (articulation is not modelled)"`).
- Steered: the tyre key is in a `rack-steering`/`steering` mechanism's `parts.wheels`.
- Axles: wheels whose axis lines are within 4° and 4 LDU of each other share an axle. `solid` = two or more of its wheels are in the same recognition body. `steered` = any wheel steered.
- `null` when fewer than 3 ground wheels or fewer than 2 axles remain.

- [ ] **Step 1: Write the failing tests**
```ts
it('5590: ten truck wheels on three axles, the trailer towed and the knob tyre left out', async () => {
  const v = recognizeVehicle(...)!;
  expect(v.wheels).toHaveLength(10);
  expect(v.axles).toHaveLength(3);
  expect(v.axles.filter(a => a.steered)).toHaveLength(1);
  expect(v.towed).toHaveLength(8);
  expect(v.wheels.every(w => Math.abs(w.radius - 54) < 0.5)).toBe(true);
  expect(v.wheels.some(w => w.centre[1] < -100)).toBe(false); // the knob at y=-113
  expect(v.forward[2]).toBeLessThan(-0.99);                  // front axle is at z ≈ -90, rear at 140..260
});
it('42000: four wheels, two axles, the front pair steered', ...);  // steered tyres at z = -280
it('8880 (axle fix): four wheels on two axles', ...);               // tyres 2997 only, not rims 2998
```
- [ ] **Step 2:** `npx vitest run tests/anim/vehicle/vehicle.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `recognizeVehicle`; add `vehicle` to `LabReport`.
- [ ] **Step 4:** Run → PASS; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5:** Commit `feat(vehicle): recognise ground wheels, axles and chassis`.

### Task 2: Rolling geometry

**Files:**
- Create: `src/anim/motion/vehicle/rolling.ts`
- Test: `tests/anim/vehicle/rolling.test.ts`

**Interfaces:**
- Produces:
```ts
export type P2 = [number, number]; // ground plane (x, z)
export type WheelPose = { contact: P2; heading: P2 /* unit, forward */; radius: number; axle: number };
export type Turn = { icr: P2 | null; radius: number /* of ref; Infinity when straight */; ackermannError: number /* RMS LDU of axle lines from icr */; sense: 1 | -1 | 0 };
export function instantCentre(wheels: readonly WheelPose[]): { icr: P2 | null; ackermannError: number };
export type WheelRoll = { slip: number /* rad, signed, in (-π/2, π/2] */; spinPerLdu: number /* rad of spin per LDU the ref travels */; longitudinalScrub: number /* fraction, 0 when free */ };
export function rolling(wheels: readonly WheelPose[], ref: P2, solidAxles: ReadonlySet<number>): { turn: Turn; wheels: WheelRoll[]; yawPerLdu: number };
export function bicycle(wheelbase: number, steer: number): { radius: number };
```
Algorithm decisions:
- ICR: minimise Σ (nᵢ·(p − cᵢ))² over the axle lines (through each contact, along its axle, n = heading). Straight when the 2×2 normal matrix's smallest eigenvalue < 1e-9 × its largest, or |p| > 1e6 LDU: `icr = null`, radius `Infinity`, sense 0, error 0.
- Contact velocity direction ∝ perpendicular of (contact − icr), oriented so the ref point moves along the vehicle's mean heading. Slip = signed angle from heading to that direction, wrapped into (−π/2, π/2].
- Spin = rolling component: `spinPerLdu = (|c − icr| / |ref − icr|) · cos(slip) / radius` (straight: `1/radius`). This makes the contact point's velocity along its heading zero (pure rolling), and leaves the lateral part as scrub.
- Solid axle: its wheels take the mean spin; `longitudinalScrub = (own − mean) / own`.
- `yawPerLdu = sense / radius` (0 straight). `bicycle(L, δ)`: radius `L / tan δ` (Infinity at δ = 0).

- [ ] **Step 1: Write the failing tests** (synthetic, exact):
  - perfect Ackermann car (wheelbase 100, track 60, ICR at (200, 0) on the rear axle line) → `icr ≈ (200,0)` to 1e-9, `ackermannError < 1e-9`, every `|slip| < 1e-9`, outer wheel `spinPerLdu` > inner, `yawPerLdu ≈ 1/200`;
  - straight (all headings (0,1)) → `icr === null`, `radius === Infinity`, slips 0, `spinPerLdu === 1/radius`, no NaN;
  - tandem rear (axles at z=±60 about the ref, ICR on the line between them at x=300) → slips on the two axles opposite in sign, each ≈ atan(60/300) to 1e-6;
  - solid axle with wheels at 270 and 330 from the ICR → equal spins (the mean), `longitudinalScrub` ≈ −0.1111 (inner, (270−300)/270) and +0.0909 (outer, (330−300)/330);
  - `bicycle(100, Math.atan(0.5)).radius ≈ 200`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(vehicle): turning centre, slip and wheel spin`.

### Task 3: Vehicle report from the steering mechanism

**Files:**
- Create: `src/anim/motion/vehicle/vehicleReport.ts`
- Test: `tests/anim/vehicle/vehicleReport.test.ts`

**Interfaces:**
- Consumes: `Vehicle` (Task 1), `rolling`, `bicycle` (Task 2), `MechanismSolver`, `solveLabFrame`.
- Produces:
```ts
export type WheelReport = { tyre: string; steerDeg: number; slipDeg: number; spinPerLdu: number; longitudinalScrub: number };
export type VehicleReport = { model: 'steering' | 'bicycle' | 'straight'; turn: Turn; yawPerLdu: number; wheels: WheelReport[] };
/** Steer at the steering solver's driver position; with no solver, `steer` is a bicycle front-wheel angle (rad). */
export function vehicleReport(vehicle: Vehicle, solver: MechanismSolver | null, steer: number): VehicleReport;
```
Each wheel's heading = its rest axis turned by the pose delta of its tyre in the solved frame (pose·rest⁻¹; identity if the tyre is not in the frame), projected on the ground plane, rotated −90° about up and signed to agree with `forward`. Bicycle: steered axle wheels' headings turned by `steer`, wheelbase = distance from `ref` to the steered axle along `forward`; with no steered axle, `model: 'straight'`.

- [ ] **Step 1: Write the failing tests** (5590, steering suggestion's program, as posed):
  - `model === 'steering'`, `turn.icr !== null` (the file is posed turned ~21°);
  - the two front wheels' `steerDeg` differ (inner > outer in magnitude);
  - **tandem scrub reported:** the z=140 and z=260 axles' mean slips have opposite signs and each is within 25 % of `atan(60 / turn.radius)` in magnitude;
  - at the steering driver position that makes the front wheels straight (search the program's travel for min |steerDeg|), `|yawPerLdu| < 1e-3`;
  - no solver, `steer = 0.2` → `model === 'bicycle'`, `turn.radius ≈ wheelbase / tan 0.2` to 1 %.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(vehicle): ICR, Ackermann error and scrub from the steering solver`.

### Task 4: Vehicle program and rolling playback

**Files:**
- Modify: `src/anim/motion/v4/mechanismProgram.ts` (`vehicle?: Vehicle`, validated: 3–64 wheels, finite centres, unit horizontal axes, radius in (0, 500], axle index in range, unit `forward`)
- Create: `src/anim/motion/vehicle/vehiclePlayback.ts`
- Modify: `src/anim/motion/classify/patterns.ts` (`MechanismKind` adds `'vehicle'`), `src/anim/motion/v4/mechanismLab.ts` (append the vehicle suggestion **after** `rankSuggestions`, so it is not merged with the steering suggestion it shares a driver with)
- Test: `tests/anim/vehicle/vehiclePlayback.test.ts`

**Interfaces:**
- Produces:
```ts
/** Poses for every instance: the chassis carried round the ICR (or straight along forward) by `distance` LDU of ref travel, steering solved at `steer`, each wheel spun about its own axle. */
export function vehicleFrame(asm: Assembly, solver: MechanismSolver, steer: number, distance: number): Map<string, THREE.Matrix4>;
export function vehicleSuggestion(vehicle: Vehicle, steering: SuggestedMechanism): SuggestedMechanism;
// title: `Vehicle — drive a circle: ${n} wheels on ${a} axles`; mechanism { kind: 'vehicle' };
// program: { ...steering.program, vehicle }; warnings carry vehicle.warnings.
```
Chassis motion: rotation about the vertical line through the ICR by `distance · yawPerLdu` (straight: translation `distance · forward`). Wheel spin: rotation about the wheel's current (steered) axle line by `distance · spinPerLdu`, sense such that the contact point moves backward relative to the chassis.

- [ ] **Step 1: Write the failing tests** (5590, as posed):
  - **correct wheel spins:** for every truck wheel, the material point at its contact at frame k has velocity along that wheel's heading below 1e-3 of the chassis speed (central difference over distance ±0.5 LDU);
  - after a full circle (`distance = 2π · turn.radius`) the chassis pose returns to rest within 1e-6 LDU;
  - outer wheels turn more than inner: compare spin angles of the z=260 axle's outermost and innermost tyres;
  - the program with `vehicle` validates (`validateMechanismProgram` → `[]`); a wheel with radius 0 is rejected.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; wire the suggestion. **Step 4:** Run → PASS; existing `tests/anim/classifySuggest.test.ts` still passes.
- [ ] **Step 5:** Commit `feat(vehicle): drive a circle with every wheel rolling`.

### Task 5: Shock stroke and suspension sweep

**Files:**
- Create: `src/anim/motion/vehicle/suspension.ts`
- Modify: `src/anim/motion/classify/suggest.ts` (a suspension's prismatic joint gets `limits: { ...stroke, source: 'verified' }` when measured; `SuggestedMechanism.wheel?: string` = the named suspension's `parts.wheels[0]`), `src/anim/motion/v4/autoMechanics.ts` (`wheel?` field)
- Test: `tests/anim/vehicle/suspension.test.ts`

**Interfaces:**
- Produces:
```ts
/** Slide room of a shock from its two parts' rods along the slide axis, LDU from the assembled pose: [−compression, extension], or null when the parts give no fitting rod. */
export function shockStroke(asm: Assembly, inner: string, outer: string, axis: Vec3): { min: number; max: number } | null;
export type SweepSample = { travel: number /* wheel centre rise, LDU, up positive */; camberDeg: number; toeDeg: number };
export type SuspensionSweep = { samples: SweepSample[]; travelLdu: number; camberGainDegPerLdu: number; bumpSteerDeg: number; strokeMeasured: boolean };
export function sweepSuspension(asm: Assembly, program: MechanismProgram, tyre: string, steps?: number /* 16 */): SuspensionSweep;
```
Stroke rule: in the inner part, the rod segment whose radius fits the outer part's bore (|r − r_bore| ≤ 0.5) is the piston rod. Compression = axial gap between the outer part's near end and the inner part's first segment wider than the bore (the collar). Extension = inserted length of the piston segment − 4 LDU of minimum engagement. Sweep: walk the driver from −amplitude to +amplitude (stopping at the stroke limits), record the tyre's centre and axis; camber = signed angle of the axis to the ground plane; toe = signed angle of the axis about vertical from rest; camber gain = least-squares slope of camber on travel; bump steer = max toe − min toe.

- [ ] **Step 1: Write the failing tests:**
  - synthetic parallelogram suspension (upright on two equal parallel arms, wheel axis along x): `camberGainDegPerLdu` and `bumpSteerDeg` < 1e-6, `travelLdu` > 0;
  - **42000 bump steer:** both rear suspension suggestions (wheels at z=640) give finite `bumpSteerDeg` ≥ 0 and `travelLdu` > 5 LDU; the left and right `camberGainDegPerLdu` agree in magnitude within 10 % (mirror pair);
  - `shockStroke` for the 42000 4254-in-4255 pair returns a stroke with `min < 0 < max` or `max === 0`, and the suspension program's prismatic joint carries it as `limits`;
  - an inner/outer pair with no fitting rod → `null`, and `sweepSuspension` reports `strokeMeasured: false`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; benchmark scores for 42000 phase 3 unchanged (16/18).
- [ ] **Step 5:** Commit `feat(vehicle): shock stroke and suspension sweep`.

### Task 6: Benchmark checks

**Files:**
- Modify: `src/anim/motion/benchmark/mechanismBenchmark.ts`, `benchmarks/mechanisms/5590.expected.json`, `benchmarks/mechanisms/42000.expected.json`
- Test: `tests/anim/mechanismBenchmark.test.ts`

**Interfaces:**
- New checks:
  - `{ type: 'vehicle', wheels: number, axles: number, steered: number }` — hit when `report.vehicle` matches all three;
  - `{ type: 'scrub', axle: PartRef /* a tyre on that axle */, sign: 1 | -1, minDeg: number, maxDeg: number }` — the axle's mean slip at the steering suggestion's assembled pose (as posed);
  - `{ type: 'bumpSteer', wheel: PartRef, maxDeg: number }` — a suspension suggestion carrying that tyre sweeps with `bumpSteerDeg ≤ maxDeg` and `travelLdu > 0`.
- Miss details: `"no vehicle"`, `"found N wheels on M axles (S steered)"`, `"slip X° outside a..b"`, `"no suspension carries this wheel"`.

- [ ] **Step 1:** Scorer tests on a stubbed report (hit and each miss detail) → FAIL.
- [ ] **Step 2:** Implement. **Step 3:** Run → PASS.
- [ ] **Step 4:** Add phase-5 mechanisms: 5590 `truck-driving` (`vehicle` 10/3/1; `scrub` on the z=140 axle and on the z=260 axle with opposite signs, magnitudes from Task 3's measured values ±50 %); 42000 `rear-suspension-sweep` (`bumpSteer` for each rear tyre, `maxDeg` = measured + 0.5°) and `driving` (`vehicle` 4/2/1). Record the measured numbers in each check's `why`.
- [ ] **Step 5:** `npm run bench:mechanisms` → 5590 phase 5 all hit, 42000 phase 5 all hit; phases 3 and 4 unchanged. Commit `feat(bench): vehicle, scrub and bump steer checks`.

### Task 7: Lab — drive the vehicle, wheel table, suspension readout

**Files:**
- Create: `src/ui/VehicleTable.tsx`
- Modify: `src/ui/MechanismLabPanel.tsx`, `src/ui/Viewport.tsx`, `src/ui/studio.css`
- Test: `tests/ui/MechanismLabVehicle.test.tsx`

**Interfaces:**
- `VehicleTable({ report }: { report: VehicleReport })`: a summary line `Turning radius R LDU · Ackermann error E LDU` (or `Driving straight`), then one row per wheel: wheel label, `steer °`, `slip °` (one decimal), `turns per 1000 LDU`.
- Panel: for a program with `vehicle`, the position slider is the steering input and the table updates from `vehicleReport` (solver built once per program, report recomputed when position changes). For a suggestion with `wheel`, a line `Camber gain G°/LDU · bump steer B° over T LDU` from `sweepSuspension` (computed once per program), plus `stroke not measured` when so.
- Viewport: for a program with `vehicle`, poses from `vehicleFrame(assembly, solver, lab.position, distance)`, `distance` advancing by `labClock · rpm / 60 · 400` LDU while playing; playing does not overwrite `lab.position`.

- [ ] **Step 1:** UI tests: the table renders `Turning radius 300 LDU`, a straight report renders `Driving straight`, slip shown as `11.3°` for 0.197 rad → FAIL.
- [ ] **Step 2:** Implement. **Step 3:** Run → PASS; `tests/ui` all pass.
- [ ] **Step 4:** Check in the browser preview (worktree dev server): load 5590, pick the vehicle suggestion, play — the truck circles, wheels turn, the table shows opposite-sign slip on the tandem axles; load 42000, pick a rear suspension, the readout shows. Screenshot.
- [ ] **Step 5:** Commit `feat(lab): drive the vehicle and sweep suspensions`.

### Task 8: Spec, results and full verification

**Files:**
- Modify: spec §8 row 5 (✓ with numbers) and a *Phase 5 as built* note under §5; `benchmarks/mechanisms/README.md` (phase 5 results, measured scrub and bump steer, the stroke measurements and anything accepted with a tolerance)

- [ ] **Step 1:** `npx vitest run > .superpowers/p5-suite.txt 2>&1; npx tsc --noEmit -p . && npx vite build && npm run verify:v8:all` → only `minifigInsertion` fails (speed tests that fail under load are re-run alone and ledgered); tsc, build and verify clean.
- [ ] **Step 2:** `BENCH_WRITE=1 npm run bench:mechanisms` → 5590 phase 3 17/17 and phase 5 all hit; 42000 phase 3 16/18, phase 5 all hit; 8880 phase 4 5/7. Write the numbers into the spec row and README.
- [ ] **Step 3:** Commit `docs: phase 5 vehicle mode results`.
