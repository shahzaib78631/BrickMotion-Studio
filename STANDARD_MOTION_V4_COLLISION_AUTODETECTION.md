# Standard Motion v4: continuous mechanism collision checks and automatic LDraw mechanics

Implementation status: **experimental v4 enhancement**, 25 October 2026.
It builds on Standard Motion v4 phases 1–6 without modifying the Standard Motion v3 and Construction planners.

## What changed

### 1. Continuous geometric clearance of post-build mechanisms

- New module: `src/anim/motion/v4/mechanismCollision.ts`.
- Integration: `src/anim/motion/v4/mechanismStage.ts`, `src/anim/timelineData.ts`, `src/ui/VideoPanel.tsx`.
- The verifier takes the **actual serialized playback keyframes**, not an independently re-solved or approximate pose.
- Checks every relevant pair of part instances, including moving/parked, moving/moving, and fixed followers. Only *stationary vs stationary* assembly geometry is excluded; that is not a mechanism-induced collision.
- For each saved keyframe interval, playback is linear world translation plus shortest-path quaternion SLERP. A conservative envelope for **all intermediate poses** is derived from endpoint transformed triangle-BVH bounds plus an angular chord-error bound `R * theta^2 / 8 + 0.0005 LDU`. Triangle hierarchy queries can rule out intersection for an entire interval without discrete sampling.
- If a triangle-envelope pair cannot be ruled out, the interval is subdivided and the project's existing triangle `MeshOracle.clearPosed` checks actual posed geometry for positive collision witnesses. Negative frame samples **never** establish a CLEAR verdict.
- The source of truth for broad-phase bounds is the actual mesh BVH, not possibly stale `PartMetrics.full` boxes.
- Missing meshes, all-degenerate triangle meshes, invalid/duplicated motion tracks, unsupported close contacts, assembled penetrations, budget exhaustion and verifier exceptions produce **UNVERIFIED**, not CLEAR.
- Intentional gear/connector contacts are not silently exempted. Pre-existing assembled overlap is **UNVERIFIED**; newly witnessed unwanted moving-mesh penetration is **BLOCKED** for unpaired bodies.
- Evidence is saved into `mechanismStage.collisionStatus` and `mechanismStage.diagnostics.continuousCollision`, with tested interval counts, triangle hierarchy work and capped example problem pairs/times. The video editor shows this diagnostic after building.

**Verdict semantics:**

| Verdict | Meaning | Export implications |
| --- | --- | --- |
| **CLEAR** | Every checked animated instance has valid geometry and rigid keyframes; conservative envelopes prove its rendered triangle surfaces remain separated from all other instances throughout the saved motion. | Geometric separation under this playback/library version, **not** a proof of real-world fit. |
| **BLOCKED** | Exact posed mesh contact/penetration was witnessed at a time during the animation. | Review or change the mechanism. |
| **UNVERIFIED** | The system cannot prove separation, often because of an already-assembled mate, narrow clearance, incomplete mesh or bounded compute budget. | Requires review; **do not** treat as collision-free. |

This verifies **rendered triangle surfaces**, not watertight solids, plastic deformation, machining/LEGO tolerances, friction, shock response or contact dynamics. Some physically functional meshing teeth must remain UNVERIFIED with the supplied LDraw representation. Large detailed models may require more compute; the finite budgets intentionally fail closed. The certificate is valid for the **geometry and playback used when Build ran**—regenerate the timeline after editing the model or changing the LDraw library.

### 2. Automatic mechanical-property discovery

- New module: `src/anim/motion/v4/autoMechanics.ts`.
- Reuses actual `PartMetrics.description` LDraw headers, inherited LDCad Shadow snap profiles and the shared constrained-joint graph.
- Classifies gear, hinge, turntable, axle/shaft, pin and wheel **instances**; gear tooth counts are read only from explicit header values (`"Gear  8 Tooth"`, etc.). No filename or scale guess is treated as fact.
- Enriches an engaged **3403/3404** turntable's joint only when a central, positive-length, cylindrical connector is matched. Ordinary stud or off-axis connections remain fixed.
- Infers possible parallel spur-gear pitch pairs when explicit teeth and compatible axle-hole axes are present, with labelled *inferred* source and *review-required* confidence. Bevel gears, worm gears, crowns and racks are recognized by descriptions but intentionally excluded from spur-gear auto-coupling.
- Builds up to four **opt-in** mechanism proposals with real assembled instance IDs; each proposal must pass the existing joint solver and fixed-connector ownership checks at small positive and negative excursions. Suggested programs do **not** invent angular stops, mass, inertia or friction.
- In Video → **Planner → Standard Motion v4**, generate Build first. In **Automatic LDraw mechanical detection**, review detected counts, interfaces and evidence. Click **Use detected motion: ...** to choose a proposal, then regenerate Build. Review the new CLEAR/BLOCKED/UNVERIFIED result before rebaking or exporting. The raw mechanism JSON remains editable for unusual assemblies.
- The joint/gear metadata summary and suggestions are persisted with the timeline to make detection auditable after a rebuild.

Large connected assemblies may have no safe standalone motion proposal even if individual hinges or gears are detected. This is an intentional safety limit, **not** a claim that the model contains no working mechanism.

## LEGO 5590 — supplied minimal LDraw dependency audit

Run `npm run audit:v4:5590` to refresh `samples/5590-v4-mechanical-coverage.json`.

| Item | Count (from MPD + bundled parts) |
| --- | ---: |
| Direct DAT placements | 1,258 |
| Distinct DAT filenames | 133 |
| Missing referenced DAT files | **0** |
| Hinge pieces (description-based) | 42 |
| Turntable pieces | 2 |
| Standard spur gears | 2 |
| Bevel gears | 8 |
| Rack gears | 1 |
| Axles/shaft pieces | 22 |
| Pins | 23 |
| Wheels/tyres | 40 |

The static audit finds direct LDCad Shadow files for 696 instances, with *potentially reachable* direct or inherited shadow metadata for 1,043. Those figures are **not** matched-connector or working-joint counts; effective SNAP_CLEAR rules, assembled spatial engagement, and mesh clearance must still be checked at application runtime.

**No additional geometry DAT files are required for the supplied 5590 model.** Highest-value additional **mechanical metadata / ground truth**, if available:

- `4143.dat` (14-tooth bevel gears, 8 instances): bevel pitch cones, tooth engagement orientation and supported gear ratios.
- `3743.dat` (rack gear, 1 instance): rack pitch reference axis and engagement pairing for future rack/pinion motion.
- `3403.dat` / `3404.dat` (turntable pair): physical rotational stops or unrestricted-bearing confirmation and actual supported pivot.
- `4275a.dat`, `4275b.dat`, `4276b.dat`, `3937.dat`, `3938.dat` (hinges): verified angular stops and precise pivot locations.
- `3647.dat` (8-tooth spur gear, 2 instances): effective inherited axle-hole snaps can originate in `axlehole.dat`, but runtime connector matching and gear engagement still need confirmation.
- `2440.dat` and `2458.dat`: review inherited snap metadata and physical restrictions.

Physical stop data should come from reliable part metadata or measurements. This release does **not** invent mechanical stops, mass or friction. User-provided LDCad shadow improvements or a verified test mechanism map would be more useful than duplicate geometry files.

## Verification and running tests

The dependencies listed in `package.json` were not available to this build environment. Therefore the complete application TypeScript build, Vitest suite and interactive 5590 demonstration have **not** been run. Focused offline TypeScript compilation uses minimal *explicitly stubbed* external types; focused numerical integration harnesses use lightweight Three.js substitutes. These are useful regressions but not full integration certification.

```sh
npm ci
npm run build
npm run test:v4:collision-autodetect
npm run test:v4
npm run test:v4:mechanisms
npm run verify:v4:collision-autodetect:offline
npm run verify:v4:offline
npm run verify:v4:mechanisms:offline
npm run typecheck:v4:collision-autodetect:offline
npm run audit:v4:5590
```

Validated offline tests: **15 new collision/detection checks**, **9 earlier v4 assembly safety checks**, **10 earlier gear/linkage/physics checks**, plus focused strict TypeScript source checks and planner/UI syntax checks. New Vitest tests are in `tests/anim/standardMotionV4AutoCollision.test.ts`, but they were not executed without Vitest.

Offline regression scenarios include: between-keyframe obstruction, two moving objects crossing, quarter-interval tunnelling, many parked obstacles, misleading part-metric bounds, missing and zero-area meshes, duplicated tracks, pre-existing assembled overlap, verification-budget exhaustion, inferred gear ratios, central-turntable-only recognition and limited hinge proposals.

## Preservation and compatibility

- Standard Motion v3, Construction v2/v3/v4 and the original six phases remain present.
- The v4 post-assembly stage retains editability through existing world-space playback samples and rebaking.
- Existing projects without an explicit mechanical demo do not start physics or demo motion automatically.
- Detection proposals are opt-in; downloaded/rendered LDraw shapes or missing metadata cannot silently create physical limits.
- When migrating an existing project, **regenerate Build and rebake motion after backing up edited keyframes** so the fresh continuous-collision verdict matches the current mesh library.
