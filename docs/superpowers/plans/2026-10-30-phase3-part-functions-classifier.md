# Phase 3: Part Functions, Classifier and Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise what LEGO Technic parts *do* (gears, racks, worms, slides, seats) from their LDraw geometry, name the mechanisms they form (gear trains, differentials, slider-cranks and piston engines, four-bars, steering, suspension, linear actuators), and offer each as a whole-function suggestion proven by the unified solver. Done when 5590 still scores 17/17 and LEGO 42000 scores ≥ 80 %.

**Architecture:** A new `src/anim/motion/parts/` measures part functions automatically from LDraw meshes and connector sections, and caches them per part id. A build script packs them into `public/data/part-functions.json`, and unknown parts are measured lazily at runtime. Nothing is hardcoded per part number except the one fact geometry cannot show: a linear actuator's screw lead, which is sourced and credited. Higher pairs and designed slides feed the Phase 1 recognition. A new `src/anim/motion/classify/` matches patterns over its bodies, joints, loops and meshes. Suggestions are built from named mechanisms, run on the Phase 2 solver and ranked.

**Tech Stack:** TypeScript, vitest, three.js (matrices only), existing `src/ldraw` loaders, Phase 1 `mobility/`, Phase 2 `kinematics/`.

**Spec:** `docs/superpowers/specs/2026-10-30-mechanism-recognition-design.md` (§2 C, E, F; §7; §8 row 3)

## Global Constraints

- Every part measurement comes from LDraw geometry or connector data, computed by code. The only per-part constant is the screw lead of linear actuators, which the LDraw shape does not contain (`92693c01`: 60 LDU per 19.9 turns, builders' measurement as recorded by Kinebrick; credited in code).
- Kinebrick data (`corrections.ldr`, `connections.json`, `sets/42000-1.json`, CC BY-SA 4.0) is used **only as a test oracle and benchmark ground truth**, credited in the test and benchmark files. It is never loaded at runtime. Kinebrick `mechanism.ts` (code license not stated): facts only, credited, no code.
- LEGO tooth size: pitch radius 1.25 LDU per tooth (`TOOTH_PITCH_RADIUS`). Mesh tolerances stay `MESH_TOLERANCE` 2, `BEVEL_TOLERANCE` 3.5 and `RACK_TOLERANCE` 4.5 LDU.
- Axes compare as lines (4° / 2 LDU, as `sameLine`). Rotation is weighted at `UNIT` = 20 LDU/rad.
- Mobility rules stay as Phase 1 set them: axle and pin axial slides stay off. A slide is added only where geometry shows a designed bore (Task 5).
- 5590 benchmark stays 17/17 after every task. `npm run bench:mechanisms` must not get slower than 2× today (≈1.6 s for 5590).
- The model file `samples/42000-1.mpd` (LDraw OMR, CC BY 2.0) is git-ignored like 5590's. The benchmark JSON records its sha256.
- Commit on `feat/v8-review` only, never push. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Symmetric non-gears**: a hub, wheel, turntable or bush with 4-, 6- or 8-fold symmetry must not become a gear. The tip radius must equal 1.25·n + 1..3 LDU, and the tooth band must sit at the outer rim (Task 2 test `rejects symmetric non-gears`).
2. **Parts carrying two toothed features**, such as 6573 (16T + 24T) or a gear with clutch dogs, must report each feature with its own centre (Task 2 test `finds both gears on 6573`).
3. **Meshes that disengage during motion**: a sliding gear, a rack running off its pinion, or the driving ring leaving a clutch gear must be reported at the frame they part, not only at rest (Task 6 test `rack runs off its pinion mid-travel`).
4. **The same function suggested twice**: a differential seen both as a gear train and as a differential, or eight slider-cranks each offered separately, must be grouped into one named mechanism (Task 7 test `V8 is one piston engine`).
5. **Phase 4 functions on 42000**: the function selector must not be scored as a Phase 3 miss, and must not be offered as a working mechanism when the driving ring is in neither clutch (Task 1 `phase` field; Task 8 test `selector without an engaged clutch is not offered`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/anim/motion/parts/meshSymmetry.ts` | Vertex hash grid, plus rotational, screw and translational symmetry tests on a vertex set |
| `src/anim/motion/parts/teeth.ts` | Toothed features of one part: spur, bevel, double bevel, crown, clutch dogs, worm, rack |
| `src/anim/motion/parts/bores.ts` | Designed slides (coaxial bores wider than an axle) and press-fit seats (tyre on rim) from connector sections and the mesh |
| `src/anim/motion/parts/partFunctions.ts` | `PartFunctions` type, per-part cache, lazy measure, load of the packed table |
| `src/anim/motion/parts/actuators.ts` | Linear actuator recognition (body, input, piston by connectors and geometry) and the one sourced lead constant |
| `scripts/measure-part-functions.ts` | Packs `public/data/part-functions.json` from the LDraw library |
| `src/anim/motion/gears/gearTable.ts` | Becomes a thin view over `partFunctions` (`worldGear` keeps its signature) |
| `src/anim/motion/pairs/higherPairs.ts` | Meshes between placed features, per-pose engagement predicate, gear/rack/worm/screw laws for the solver |
| `src/anim/motion/classify/loops.ts` | Fundamental loops of the recognised body graph (spanning tree + cut joints, meshes preferred as cuts) |
| `src/anim/motion/classify/patterns.ts` | Pattern matchers that return `NamedMechanism[]` |
| `src/anim/motion/classify/suggest.ts` | Builds, proves and ranks a `MechanismProgram` per named mechanism |
| `src/anim/motion/benchmark/mechanismBenchmark.ts` | New `function` check, `phase` field, per-phase score |
| `benchmarks/mechanisms/42000.expected.json` | Ground truth for 42000 |

## Task 1: Benchmark — `function` check, phases, 42000 ground truth

**Files:**
- Modify: `src/anim/motion/benchmark/mechanismBenchmark.ts`, `tests/diagnostics/mechanismBenchmark.test.ts`
- Create: `benchmarks/mechanisms/42000.expected.json`, `tests/anim/mechanismBenchmarkFunction.test.ts`
- Modify: `benchmarks/mechanisms/README.md` (document the new check and the attribution)

**Interfaces:**
- Produces:
  - `BenchmarkCheck` gains `{ type: 'function'; label; kinds: string[]; driver: PartRef; moves: PartRef[]; stays?: PartRef[] }`.
  - `ExpectedMechanism` gains `phase?: number` (default 3).
  - `BenchmarkResult` gains `byPhase: Record<number, { hit: number; total: number }>`.
  - `SuggestedMechanism` gains `mechanism?: { kind: string; name: string }`. Task 8 fills it.

- [ ] **Step 1: Write the failing tests** in `tests/anim/mechanismBenchmarkFunction.test.ts`, using a small hand-built assembly with a hinge suggestion:
  - `function check hits when a suggestion of a listed kind moves every 'moves' part`
  - `function check misses when a 'stays' part moves`
  - `function check misses on a suggestion of another kind`
  - `phase 4 mechanisms are scored separately`

  The hit rule:
  - a suggestion's `mechanism.kind` is in `kinds`;
  - its driver joint's body holds the `driver` part, or that part's rigid cluster;
  - solving at ±amplitude moves every `moves` part by more than 0.5 LDU or 1°;
  - every `stays` part moves by less than that.
- [ ] **Step 2: Run** `npx vitest run tests/anim/mechanismBenchmarkFunction.test.ts`. Expected: FAIL (type `function` unknown).
- [ ] **Step 3: Implement** in `mechanismBenchmark.ts`. Measure motion by running `MechanismSolver` through `solveLabFrame`, including rigid followers.
- [ ] **Step 4: Write `42000.expected.json`.**
  - Parts are located by part number + box centre (resolve against the `pN` indices verified in this session: p706 32138 at 0,-100,101, and so on).
  - Mechanisms:
    1. **`steering`** (phase 3): `function` kinds `["rack-steering","steering"]`, driver p706, moves p644 / p497 / p585 / p588, stays p350 / p358. Also `rackPinion` 32270 p497 on 87761 at (0,-80,-320), `gearMesh` bevel 32269 p644 ↔ 6589 at (0,-73,-20), and `rotates` for both front hubs about Y.
    2. **`engine`** (phase 3): `function` kinds `["piston-engine","gear-train","differential"]`, driver p350, moves p274 / p395 / p396 / p400 / p411, stays p0. Also a `gearMesh` for each stage: 62821 ↔ 32269 at (0,-60,600), 32269 (0,-60,560) ↔ 32270 (0,-100,560) spur ratio 20:12, and 6589 side ↔ spider. Plus `slides` piston p411 along its cylinder axis (0.8,-0.6,0).
    3. **`front-suspension`** and **`rear-suspension`** (phase 3): `function` kinds `["suspension"]`, driver p591 / p278, moves p559 + p566 / p298 + p464. Plus `slides` for each shock rod in its cylinder.
    4. **`front-wheels`** (phase 3): `rotates` rim p1369 and tyre p1373 about X, and both are carried with their hub.
    5. **`function-selector`** (phase 4): `function` kinds `["linear-actuator"]`, driver p158, moves p105 / p252 / p1089 / p1161.
  - `notes` credit Kinebrick (`data/sets/42000-1.json`, CC BY-SA 4.0, commit 516e176) and the LDraw OMR file (CC BY 2.0). Springs are noted as not modelled, following Kinebrick's skip.
- [ ] **Step 5: Run** `npm run bench:mechanisms`. Expected: both models run with no `unresolved` checks; 5590 17/17; 42000 low (baseline: 0 meshes, 6 generic hinges). Run with `BENCH_WRITE=1` to record the 42000 baseline.
- [ ] **Step 6: Commit** `bench: function checks, phases, LEGO 42000 ground truth`.

## Task 2: Toothed features from geometry (spur, bevel, double bevel, crown, clutch)

**Files:**
- Create: `src/anim/motion/parts/meshSymmetry.ts`, `src/anim/motion/parts/teeth.ts`, `tests/anim/partTeeth.test.ts`

**Interfaces:**
- Produces:
  - `type ToothedFeature = { kind: 'spur'|'bevel'|'double-bevel'|'crown'|'clutch'|'worm'|'rack'; teeth: number; axis: V3; centre: V3; pitchRadius: number; width: number; facing?: V3; apex?: number; lead?: number; length?: number; face?: V3 }`. All values are in part space, LDU.
  - `measureTeeth(flat: FlatPart): ToothedFeature[]`
  - `rotationalOrder(points, axis, centre, tol): number`
  - `screwLead(points, axis, centre): number | null`
  - `translationPeriod(points, dir): number | null`

The method was prototyped in this session; it gives the exact tooth count on all 18 gears tried:
1. For each candidate axis (the part's X, Y, Z, plus axes of axle-hole connectors), slice the vertices into slabs along the axis.
2. In each slab, take the tooth band: radius > tip − 4 LDU.
3. The order n is the largest n ≤ 80 whose rotation by 2π/n maps ≥ 97 % of band vertices onto band vertices (hash grid, 0.1 LDU).
4. Accept n as teeth only if the tip radius minus 1.25·n is between 1 and 3 LDU.
5. Kind:
   - **spur**: the tip radius stays flat across the slab;
   - **bevel**: the tip radius falls about 45° towards one side; `facing` is that side, and `apex` = the pitch plane's distance + pitch radius;
   - **double bevel**: it falls towards both sides;
   - **crown**: teeth stand axially at the face;
   - **clutch**: dog teeth on an end face inside the hub.
6. Group adjacent slabs into features.

- [ ] **Step 1: Write the failing tests.** Load real parts as `loadRealModel` does (skip if part data is missing). The oracle values, credited to Kinebrick `corrections.ldr` and our `gearTable`:
  - **`spur gears`**: 3647 → 8/r10, 4019 → 16/r20, 94925 → 16/r20, 3648b → 24/r30, 3649 → 40/r50, each with axis ±Z through the origin.
  - **`bevel gears`**:
    - 4143: 14 teeth, facing −Z, apex 17;
    - 32198: 20, facing −Z, apex 28;
    - 87407: 20, facing −Z, apex 30;
    - 6589: 12, r15, facing +Z, apex 17;
    - 62821: 28, r35, facing −Z, apex 34 from z = 24 (tip at z = −10, ±1.5 LDU).
  - **`double bevels`**: 32270 → 12/r15 double-bevel, 32269 → 20/r25, 32498 → 36/r45.
  - **`finds both gears on 6573`**: 24 teeth at z ≈ 30 and 16 teeth at z ≈ −30.
  - **`clutch gears`**:
    - 6542b and 18946: a spur 16 plus clutch dogs;
    - 2471: a spur 24 plus dogs on both faces;
    - 6539: clutch dogs at both ends and no spur.
  - **`rejects symmetric non-gears`**: these return no gear feature: 3713 bush, 4265c half bush, 44772 rim, 3403 turntable base, 32054 pin with friction and bush, 6536 axle-pin connector.
  - **Pass rule:** tooth counts must be exact; radii, apex and centres within 1.5 LDU; axes within 4°.
- [ ] **Step 2: Run** `npx vitest run tests/anim/partTeeth.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `meshSymmetry.ts`, then `teeth.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npx vitest run` is green, apart from the pre-existing minifig failure.
- [ ] **Step 5: Commit** `feat(parts): measure gear teeth from LDraw geometry`.

## Task 3: Worms and racks from geometry

**Files:**
- Modify: `src/anim/motion/parts/teeth.ts`, `tests/anim/partTeeth.test.ts`

- [ ] **Step 1: Failing tests:**
  - `worm`: 4716 gives `worm`, axis Z, 1 start, lead 7.854 ± 0.3 LDU, meshing radius 10 ± 1.
  - `racks`:
    - 3743: 10 teeth, length 80, pitch line at y = −4, face −Y, along X;
    - 87761: 6 teeth, length 48, pitch line at y = −5, face −Y.
  - The pitch spacing is reported as 2π·1.25 (LEGO tooth), while the drawn period is 8 LDU; the test checks both.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Worm:** the band vertices are invariant under rotation θ plus translation θ·lead/2π. Search the lead in [4, 20] LDU.
  - **Rack:** translational symmetry along a straight direction with period 6–10 LDU. The tooth band is the extreme layer on the face side. The pitch line sits 1.25 LDU (one addendum) below the tip line, reconciled against the oracle.
- [ ] **Step 4: Run.** Expected: PASS. Run the full suite.
- [ ] **Step 5: Commit** `feat(parts): worms and racks from geometry`.

## Task 4: Part-function table, cache and `gearTable` replacement

**Files:**
- Create: `src/anim/motion/parts/partFunctions.ts`, `scripts/measure-part-functions.ts`, `tests/anim/partFunctions.test.ts`
- Modify: `src/anim/motion/gears/gearTable.ts`, `src/anim/motion/v4/mechanismLab.ts`, `tests/diagnostics/loadRealModel.ts`, `package.json` (script `data:part-functions`)

**Interfaces:**
- Produces:
  - `type PartFunctions = { teeth: ToothedFeature[]; bores: Bore[]; seats: Seat[] }` (Bore and Seat come from Task 5; empty until then);
  - `partFunctions(id: string): PartFunctions | undefined`, `loadPartFunctionTable(json)`, `measurePartFunctions(flat)`;
  - `worldGear(key, part, world)` keeps its signature and returns the first gear feature, with every feature reachable through `worldFeatures(key, part, world): WorldFeature[]`.

- [ ] **Step 1: Failing tests:**
  - **`gearTable parity`**: for every part in the old TABLE, `worldGear` from measured features matches the old entry within 1.5 LDU (3743 included: its pitch line at y = −4, face −Y, matches the oracle).
  - **`lazy measure fills the cache once`.**
  - **`packed table round-trips`.**
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The script walks `public/ldraw/parts/*.dat` and measures every part with an axle or pin hole connector, or whose band passes the tooth test, within a time budget. It writes only the parts that have features, plus a `{generator, ldrawVersion, count}` header.
  - The Mechanism Lab measures lazily any part missing from the table.
  - `hasMeasuredGear` reads features.
- [ ] **Step 4: Run** the suite, then `npm run bench:mechanisms`. Expected: 5590 17/17 (its 4143 / 3647 / 3743 come out the same).
- [ ] **Step 5: Commit** `feat(parts): packed part-function table; gearTable reads measured features`.

## Task 5: Designed slides, seats and linear actuators

**Files:**
- Create: `src/anim/motion/parts/bores.ts`, `src/anim/motion/parts/actuators.ts`, `tests/anim/partBores.test.ts`
- Modify: `src/anim/motion/mobility/recognise.ts` (accept `extraConnectors`), `src/anim/motion/v4/mechanismGraph.ts`, `src/anim/motion/v4/mechanismLab.ts`

**Interfaces:**
- Produces:
  - `type Bore = { axis: V3; centre: V3; radius: number; shape: string; travel: [number, number] }`;
  - `type Seat = { axis: V3; centre: V3; radius: number; width: number; gender: 'M'|'F' }`;
  - `libraryConnectors(asm, functions): MechanicalJoint[]` (source `'part-function'`);
  - `type Screw = { body: string; input: string; piston: string; axis: V3; centre: V3; leadLduPerTurn: number; stroke: [number, number] }`;
  - `findLinearActuators(asm, joints): Screw[]`.

Rules, all geometric:
- **Designed slide:** a male section of radius > 6 LDU (wider than an axle or pin) sits coaxially inside a female section of the same shape and radius, and their axial overlap is shorter than the female. That gives a prismatic connector with travel up to the female's ends. This covers the shock absorber rod in its cylinder and the piston in its bore.
- **Seat:** a male part's outer surface and a female part's inner surface are coaxial, radii within 1 LDU, axially overlapping by ≥ 50 % of the narrower one. That gives a fixed connector (tyre on rim).
- **Pin in an oval or slot section ('O'):** a revolute joint about the pin (piston pin).
- **Linear actuator:** a part whose LDraw description contains "Linear Actuator" and whose subparts or neighbours give an input turning in its rear bore and a piston sliding in its front bore. That gives a revolute (input) plus prismatic (piston) plus `Screw`. The lead comes from the one sourced constant (`92693c01`: 60/19.9 LDU per turn). The stroke comes from the geometry of the LDraw `-f1`/`-f2` (contracted and extended) shortcut files when present, otherwise from the bore length.

- [ ] **Step 1: Failing tests** on 42000 parts:
  - **`shock absorbers slide`**: 4254 p464 in 4255 is prismatic along its axis, with travel covering the built position.
  - **`pistons slide in their cylinders and pin to their rods`**: p411 is prismatic along (0.8,−0.6,0) and revolute to its 2852.
  - **`tyres sit on rims`**: p1373 is fixed to p1369.
  - **`linear actuators`**: three are found, p105, p1089 and p1161, each with a lead of 60/19.9.
  - **`axle in a round hole still does not slide`**: a regression guard for Phase 1.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Pass the new connectors into `recogniseMechanism` next to the LDCad ones. Add `Bore` and `Seat` to the packed table.
- [ ] **Step 4: Run** the suite and `npm run bench:mechanisms`. Expected: 5590 17/17. The 42000 bodies probe shows shocks prismatic, pistons on slides and tyres carried by rims.
- [ ] **Step 5: Commit** `feat(parts): designed slides, seats and linear actuators from geometry`.

## Task 6: Higher pairs and per-frame engagement

**Files:**
- Create: `src/anim/motion/pairs/higherPairs.ts`, `tests/anim/higherPairs.test.ts`
- Modify: `src/anim/motion/gears/gearGeometry.ts` (accept features), `src/anim/motion/kinematics/laws.ts` (worm and screw laws if missing), `src/anim/motion/v4/mechanismLab.ts`

**Interfaces:**
- Produces:
  - `type HigherPair = { id: string; kind: 'spur'|'bevel'|'crown'|'rack'|'worm'|'screw'|'clutch'; a: string; b: string; featureA: number; featureB: number; ratio?: number; reversed?: boolean; pitchRadius?: number; lead?: number }`;
  - `findHigherPairs(asm, recognition): HigherPair[]`;
  - `engaged(pair, poseA: Matrix4, poseB: Matrix4): { ok: boolean; errorLdu: number; reason?: string }`;
  - `pairLaws(pairs): TransmissionConstraint[]`.

- [ ] **Step 1: Failing tests:**
  - **`42000 meshes`** (by part refs):
    - 62821 ↔ 32269 at (0,−60,600), bevel 28:20;
    - 32269 (0,−60,560) ↔ 32270 (0,−100,560), spur 20:12;
    - 32269 p644 ↔ 6589 (0,−73,−20), bevel;
    - 6589 (0,−73,−20) ↔ 32269 (0,−100,−40), bevel;
    - 32270 p497 ↔ 87761, rack.
  - **`spider meshes both side gears`**: the 6589 at (0,−60,657) meshes with 6589 at ±17.
  - **`no mesh between coaxial gears on one axle`.**
  - **`rack runs off its pinion mid-travel`**: `engaged` turns false once the rack moves past its teeth.
  - **`5590 meshes unchanged`.**
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Candidate pairs come from a spatial grid over feature pitch circles. Use the mesh tests from `gearGeometry.ts` on world features. A double bevel meshes either as spur (parallel axes) or as bevel (crossing axes).
- [ ] **Step 4: Run** the suite and bench. Expected: 5590 17/17; 42000 `gearMesh` and `rackPinion` checks hit.
- [ ] **Step 5: Commit** `feat(pairs): higher pairs with per-frame engagement`.

## Task 7: Classifier

**Files:**
- Create: `src/anim/motion/classify/loops.ts`, `src/anim/motion/classify/patterns.ts`, `tests/anim/classify.test.ts`

**Interfaces:**
- Consumes: `Recognition` (Phase 1), `HigherPair[]`, `Screw[]`.
- Produces:
  - `type NamedMechanism = { kind: 'gear-train'|'differential'|'worm-drive'|'four-bar'|'parallelogram'|'slider-crank'|'piston-engine'|'watt-six-bar'|'stephenson-six-bar'|'rack-steering'|'steering'|'suspension'|'turntable'|'linear-actuator'; name: string; bodies: number[]; joints: number[]; pairs: string[]; drivers: number[]; outputs: number[]; parts?: Record<string, string[]> }`;
  - `fundamentalLoops(bodies, joints, pairs): Loop[]`, with higher pairs preferred as cut joints (spec D.1, Müller Fig. 8);
  - `classify(recognition, pairs, screws, asm): NamedMechanism[]`.

Patterns, matched on loops and joint kinds, with geometry only as a tie-break:
- **four-bar:** a 4-revolute loop with parallel axes. It is a **parallelogram** when opposite links are equal within 1 LDU.
- **slider-crank:** a loop of 3 revolutes plus 1 prismatic.
- **piston engine:** ≥ 2 slider-cranks sharing a crank body.
- **six-bars:** a 2-loop, 7-joint, 6-body group. It is **Watt** when the two ternary links are adjacent, otherwise **Stephenson**.
- **gear train:** a maximal chain of higher pairs through shafts, with ratio = product.
- **differential:** a carrier holding a spider pair that meshes two coaxial side gears (no part numbers).
- **worm drive:** a worm pair.
- **rack steering:** rack and pinion, plus the rack on a slide or a four-bar coupler, plus hubs turning about kingpins (a port of `suggestRackSteering`).
- **steering:** ≥ 2 wheel-carrying bodies on near-vertical revolutes linked by one chain.
- **suspension:** a loop containing a wheel-carrying body and a designed slide.
- **turntable:** a large-radius revolute between two big bodies.
- **linear actuator:** a `Screw`.
- **Grouping:** whole-function mechanisms absorb their sub-patterns (a piston engine absorbs its slider-cranks; rack steering absorbs its four-bar).

- [ ] **Step 1: Failing tests:**
  - Synthetic `Recognition` fixtures, built with `screwJoint` from connector freedoms: four-bar, parallelogram, slider-crank, V2 engine, Watt, Stephenson, three-gear train (ratio), differential, worm.
  - Real models:
    - **5590:** rack steering on a four-bar;
    - **42000:**
      - `V8 is one piston engine` (8 slider-cranks, crank B89);
      - `differential at 62821`;
      - `two suspensions per axle`;
      - `rack steering with both front hubs`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `loops.ts`, then `patterns.ts`.
- [ ] **Step 4: Run.** Expected: PASS, with the full suite green.
- [ ] **Step 5: Commit** `feat(classify): loops and named mechanisms`.

## Task 8: Suggestions from named mechanisms

**Files:**
- Create: `src/anim/motion/classify/suggest.ts`, `tests/anim/classifySuggest.test.ts`
- Modify: `src/anim/motion/v4/mechanismLab.ts` (use `suggestMechanisms`), `src/anim/motion/v4/autoMechanics.ts` (`SuggestedMechanism.mechanism`, ranking), `src/anim/motion/v4/drivetrainSuggestions.ts` (becomes the rack-steering builder that `suggest.ts` calls)

**Interfaces:**
- Consumes: `NamedMechanism[]`, `HigherPair[]`, `Screw[]`, `provenSuggestion`, `carriedBodies`.
- Produces: `suggestMechanisms(asm, graph, named, pairs, screws): SuggestedMechanism[]`. Each result has `mechanism: { kind, name }` and evidence `'measured-gear-train'` or a new `'classified'`.

Each suggestion:
1. Program = the mechanism's joints (tree from `loops.ts`), closures for its cut joints, `pairLaws` for its pairs, and screws as `linear-actuator` transmissions.
2. The driver is the preferred free coordinate: a knob, steering wheel or crank input, or the wheel for a vehicle drive. Its amplitude comes from stops and engagement limits, else ±π/2.
3. Carried bodies are rigid followers.
4. It is proven over its whole travel by `provenSuggestion`, and engagement must hold at every proving frame.
5. Rank: whole-function kinds (`rack-steering`, `steering`, `piston-engine`, `differential`, `suspension`, `linear-actuator`, `gear-train`) > single named joints (`turntable`, `four-bar`) > generic hinges. Within a rank, more moving parts come first.

- [ ] **Step 1: Failing tests:**
  - **5590:** the top suggestion is still rack steering with the same title prefix, and the ready-to-drive test passes unchanged.
  - **42000:**
    - **`rear wheel drives V8`:** driving p350 moves p274, p395 and p411, and the pistons stay on their cylinder axes within 0.1 LDU.
    - **`steering wheel turns both front hubs`.**
    - **`suspension sweeps`.**
    - **`selector without an engaged clutch is not offered`**, or if offered, only through the engaged branch.
  - **`no duplicate suggestions for one mechanism`.**
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite and `npm run bench:mechanisms`. Expected: 5590 17/17; 42000 phase-3 score ≥ 80 %. Then run `BENCH_WRITE=1` to refresh the results.
- [ ] **Step 5: Commit** `feat(classify): suggestions from named mechanisms`.

## Task 9: Docs, spec, UI smoke and final review

**Files:**
- Modify: spec §1, §2 C/E/F notes and §8 row 3 (with the measured numbers); `benchmarks/mechanisms/README.md`; the Mechanism Lab UI label for `mechanism.name` if it shows titles only.

- [ ] **Step 1:** Run `npx tsc --noEmit`, `npx vite build`, `npx vitest run`, `npm run verify:v8:all` and `npm run bench:mechanisms`. Record the counts.
- [ ] **Step 2:** Update the spec row 3 to ✓ with the numbers. Credit Kinebrick (oracle, ground truth) and the OMR in the README.
- [ ] **Step 3:** Commit `docs: phase 3 results`. Then do the whole-branch review per executing-plans.
