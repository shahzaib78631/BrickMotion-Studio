# Construction V3: bounded constrained-motion search

Status: implemented and independently tested as a **partial rigid-motion extension**.
This is not a general-purpose articulated mechanism solver, nor proof that all
LDraw models can be collision-certified. In particular, LEGO 5590 is **not solved**.

## What changed

1. **Configuration-space NEAR/FAR fallback** (`src/anim/construction/configurationSpace.ts`):
   after an already certified connector-aligned withdrawal, an obstacle-face
   nonuniform lattice proposes a bounded three-dimensional sequence of
   translations. It can navigate a corridor requiring multiple turns, unlike
   the former single side-exit routes. Every proposal edge is verified by
   the exact `segmentClear` continuous swept-mesh oracle. Final paths still
   receive independent forward replay. No speculative geometric clearance is
   ever certified.
2. **Explicit search budgets**: per-branch limits on roadmap expansions,
   collision-checked edges, completion attempts, and wall-clock time.
   Cancellation uses the existing planner's `pulse()`. Bounded failure means
   UNKNOWN; it cannot certify impossibility or approve motion.
3. **Optional authored-step modules** (`stepModules.ts`): connected components
   of verified-profile *candidate mates*, within the same model and authored
   build step, can form a capped workbench group. Each child is assembled at
   that group's workbench; group attachment is checked independently. This is
   experimental and disabled by default because LEGO 5590 did not improve.
4. **Joint inventory and diagnostics**: the mechanical graph is reused for
   group proposals; the planner exposes counts of matched mechanical joint
   hints, articulated-joint hints, detour attempts/successes and workbench
   groups. These hints do **not** create collision permissions or simulate
   kinematic movement.
5. **UI/configuration**: the Video panel exposes the experimental module
   checkbox for V3, persists it, and invalidates the timeline cache when it
   changes. The original V2 and V3 planner choices remain available.

## Benchmark and verification

All timing comparisons depend on local CPU load and are indicative, not strict
speedup certification. Tested against the supplied 5590 MPD and its complete
minimal LDraw geometry/shadow data. The truck has 554 brick instances and
450 root disassembly units with standard V3 grouping.

| Truck run | Budget | Deepest root units | Pieces at deepest level | Outcome |
| --- | ---: | ---: | ---: | --- |
| Previous V3 Search Scalability baseline | 20 s | 110 / 450 | 110 / 554 | search limit |
| Updated V3, default | 20 s | 106 / 450 | 106 / 554 | search limit |
| Updated V3, opt-in step grouping | 20 s | 99 / 421 | 107 / 554 | search limit |
| Updated V3, opt-in step grouping | 60 s | 99 / 421 | 107 / 554 | search limit |

An earlier run of the new default binary reached 110/450 in 20s; the
recompiled delivery run reached 106/450. These variations reinforce that the
new search did **not** materially improve 5590 at its current bottleneck.
The same nominal 60s budget without experimental grouping reached roughly
129/450, also failed.

The detour solver successfully navigated a synthetic elbow-shaped obstacle
fixture requiring multiple turns. It checks every edge against a continuous
swept AABB oracle, is deterministic, invariant under global translation,
respects bounded failure, and propagates cancellation. The planner's separate
six-piece integration fixture successfully produced a certified plan and
compiled timeline; an overlapping-solid fixture was rejected.

For actual 5590, no configuration-space detour was used in the 20-second test:
most hard candidates could not obtain the **initial connector disengagement**
needed to seed the detour. The mechanical graph identifies 1,384 candidate
joint hints in the truck, 12 of which are potentially articulated, but these
are not yet kinematic certificates. Staging/replay never relax collision rules.

## Reproducing checks

With globally available `tsc` and Node:

```sh
tsc --noEmit --project tests/tsconfig.construction.json
# Compile scripts with the project-wide Node type declarations when available:
# scripts/verify-constrained-motion.ts
# scripts/verify-v3-constrained-integration.ts
```

The model diagnostic supports:

```sh
node scripts/diagnose-construction-mpd.js MODEL.mpd LDraw_DIRECTORY truck result.json --engine=v3 --budget=standard
node scripts/diagnose-construction-mpd.js MODEL.mpd LDraw_DIRECTORY truck result.json --engine=v3 --budget=extended --step-modules
```

When built directly with global `tsc`, run compiled JS under CommonJS from
this project's root so relative `vendor/LDCadShadowLibrary` resolves.

## Remaining engineering challenges

- A genuine **joint-coordinate planner** must be added for engaged hinges,
  sliders, ball joints, rotating axles, gears, and coupled motions. It must
  preserve mate constraints during movement and certify the complete swept
  mesh of *each moving component* and every other fixture; rotation cannot
  be inferred from a static connector match alone.
- A composite-motion representation must support **multiple connected
  bodies moving simultaneously**, as well as temporary fixture holding or
  backtracking of previously placed modules. The current reverse-disassembly
  state tracks one rigid actor per action and cannot express these states.
- Flexible/elastic elements need a deformation model and a separate
  conservative collision strategy. The existing pre-shaped hose composite
  is only a rigid visualization.
- Large-model planning needs stronger step-conditioned hierarchical search
  and an incremental mesh/constraint scene to avoid repeated expensive
  queries even after the prefix-pruning improvement.
- MP4 and full-browser testing were not performed because the environment
  lacks application npm dependencies and required runtime/browser assets.

**Policy:** If certification fails or the budget is exhausted, the editor
continues to use its explicit, visibly uncertified preview fallback. No
unsupported mechanical motion is labelled collision-certified.

## Continuation: engaged-pose detours and bounded scheduling

The follow-up implementation fixes a limitation in the initial configuration-
space integration: the roadmap previously required a fully cleared straight
withdrawal before it was called. The fallback can now start at the original
assembled pose, applying a validated connector/contact policy only to the
**initial** departure edge. It applies ordinary continuous swept-mesh checks
on **every subsequent** edge, as well as independent forward replay. No
surface-contact review becomes a general movement exemption.

On a long candidate list, the previous solver sometimes timed out before
running any roadmap search. A stalled-state scheduling pass now tries at most
two eligible, previously blocked mechanical pieces before resuming the guided
list at its saved cursor. A global detour-attempt allowance scales from 2 to
16 with the user-selected wall-clock budget; failed roadmap branches cannot
consume unlimited resources or erase the legacy search fallback.

### Verification after this change

- Dependency-free continuous swept-AABB test solves a multi-turn **initial
  connector release** and verifies that the contact exception is not usable
  on a later edge. This is a *search test*, **not** a proof for LEGO geometry.
- Six-piece Construction V3 fixture still plans and compiles; deliberate
  overlapping-solid fixture is still rejected.
- Strict Construction core TypeScript check passes.
- Actual 5590 truck, 20-second Standard budget: deepest **110 / 450** root
  units, **15,493** route candidates, **2** assembled-pose detour attempts,
  **0** certified detours. The earlier constrained-motion delivery was
  106 / 450 units, with 13,806 candidates; this difference is not evidence of
  a reliable performance gain.
- Actual 5590 truck, 60-second Extended budget: deepest **129 / 450** root
  units, **319,077** candidates, **10** assembled-pose detour attempts, **0**
  certified detours. No complete route was produced. These numbers are
  near the previous V3's ~129/450 and show that more flexible *single-body*
  paths have not removed the model's mechanical interlock bottleneck.

Next genuinely new solver work is joint-coordinate and **simultaneous multi-
body** motion with verified invariant joints (pin/hinge/gear/linkage), plus
rigid composite grouping chosen by genuine mechanical topology. A candidate
mate graph alone is not sufficient to authorize articulation or separation.
