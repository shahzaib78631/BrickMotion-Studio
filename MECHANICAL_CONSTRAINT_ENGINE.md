# Construction V3: mechanical-interface inference and LEGO 5590 investigation

**Date:** 2026-10-24
**Scope:** LDraw / LDCad connector interpretation, mechanical topology, V3 route proposals, final-contact diagnostics, and regression checks.
**Status:** Integrated improvement, **not** a general articulated physics/kinematics solver or a certified animation for LEGO 5590.

## What changed

The existing V3 planner had connector metadata, but it flattened a multi-section LDCad `SNAP_CYL` definition to its **largest radius** before checking compatibility. A stepped male connector whose narrow tip was correctly inserted into a female hole could therefore be rejected if its broad shoulder was outside the hole. The 5590 helicopter's round plate / loudhailer is a real reproduction of this failure.

- `src/ldraw/shadow.ts` now retains each cylinder's shape, radius, length, and axial start in the resolved part-space snap. Scaling and centering preserve those sections.
- `src/anim/snapMates.ts` adds `profiledCylinderMate`. It transforms snaps into world space, checks gender, parallelism, coaxial offset, section-by-section axial engagement, and shape/radius fit. It requires all *engaged* sections to fit: a wide shoulder cannot pass through a narrow hole. The legacy matching function remains unchanged for V2 compatibility.
- `src/anim/construction/mechanicalConstraintGraph.ts` builds an immutable inference result for nearby mesh AABB pairs. It classifies plausible stud/socket, pin/hole, axle/hole, hinge, clip, ball/socket, and cylindrical relationships, with world-space axes and centers. The classification is a **kinematic hint**; it does not prove a connection can articulate under load or that the pair has passed a mesh collision test.
- For exact, section-validated coaxial cylindrical matches only, the graph proposes a *small localized final-contact region*, not a model-wide collision waiver. The planner must independently validate the static mesh with `MeshOracle`; every moving route continues using the existing swept-triangle checks. New connections are flagged `staticOnly`, so they do not grant a shortcut during motion, impose false rigid dependencies, or suppress obstructions.
- V3 prioritizes valid joint axes in its inexpensive NEAR/FAR pass. When a joint provides a definite insertion direction, it does **not** test unrelated world axes in the same cheap pass. The exhaustive fallback remains available when no guided candidate allows progress. V2's algorithm remains independent.
- Unexplained final contacts now carry contextual mechanical-reason text, involved item IDs, part names, and a world-space mesh witness point where available. The Build footer shows expandable contact details and a Copy diagnostics action. Diagnostic messages distinguish missing metadata, same-gender connectors, incompatible engaged sections, off-axis connectors, and verified metadata that still requires mesh checking.
- The project timeline cache was versioned from 6 to 7, invalidating stale V3 results.

### Certification boundary

**A connector match is NEVER equivalent to collision certification.** Static contact allowances are confined to the engaged connector's short tube and have `staticOnly: true`. A verified static contact cannot be reused to permit a brick's flight through solid material. Unknown contacts remain blockers for certified V3, while existing Standard-preview fallback remains visibly uncertified. No broad gear/hinge/flex collision exemptions were added.

## Reproduction with LEGO 5590

Inputs: user-supplied `5590_-_whirl_n_wheel_super_truck_with_steps.mpd`, its extracted minimal official LDraw parts/primitives, and the bundled `vendor/LDCadShadowLibrary`. **Those external geometry inputs are not redistributed in this source archive.**

| Real-model measurement | Before this change | After this change |
|---|---:|---:|
| Full model piece instances | 1,258 | 1,258 |
| Unresolved final-contact helicopter pairs | 3 | **2** |
| `4073` (plate) / `4349` (loudhailer) | Rejected | **Accepted** via sectional connector match AND localized mesh-contact check |
| `4349` / `2462` (facet brick) | Rejected | **Still rejected** |
| `4073` / `2462` | Rejected | **Still rejected** |
| Certified full 5590 animation | No | **No** |

The remaining helicopter contacts' connector axes do not align in the supplied final pose. The independent mesh checker finds contact near `(-319.61, -192.08, 406.47)` and `(-311.13, -189.52, 397.99)` LDU respectively. Their current metadata cannot explain these intersections. They could be approximated render contacts, uncommon/intermediate joints, or physically incompatible placements. A specific verified joint model or better geometry evidence is required before treating them as certified.

### Topology inspection

The new CLI `--inspect-interfaces` mode reports **7,137 nearby piece pairs** and **3,467 metadata-based candidate interfaces** in the supplied full model. These include about 3,335 stud/socket, 34 axle/hole, 76 cylindrical, 12 hinge, 4 clip, 4 ball/socket, and 2 pin/hole candidates. These numbers are **not** 3,467 certified mesh contacts and do not indicate a completed motion plan. A copy of the inspection report is at `docs/diagnostics/v3-5590-mechanical-interfaces.json`.

### Truck search comparison (20 seconds)

| Metric | Earlier V3 baseline | New V3 with joint-guided fast pass |
|---|---:|---:|
| Selected removal units / 450 | 35 | **37** |
| Search states | 36 | **38** |
| Route candidate attempts | 63,793 | **30,419** |
| Detailed triangle-pair checks | 3,241,780 | **2,995,504** |
| Outcome | Budget exceeded | **Still budget exceeded** |

These runs were measured with the same local geometry and nominal 20-second budget. The improvement is promising but modest, **not** evidence that arbitrary large assemblies now plan successfully. Elapsed-time-limited work can vary by machine and load; use search-state and route counts as complementary indicators. This search still attempts to remove many individual bricks and needs a larger algorithmic redesign for large Technic assemblies.

## Running diagnostics

After installing dependencies and the LDraw parts library:

```bash
# Model-specific joint and contact explanations, no search
npx tsx scripts/diagnose-construction-mpd.ts \
  /path/to/5590_-_whirl_n_wheel_super_truck_with_steps.mpd \
  /path/to/ldraw full interfaces.json \
  --engine=v3 --inspect-interfaces --focus-parts=4073,4349,2462

# Strict full-model planning: returns a machine-readable error report on failure
npx tsx scripts/diagnose-construction-mpd.ts \
  /path/to/5590_-_whirl_n_wheel_super_truck_with_steps.mpd \
  /path/to/ldraw full full-v3.json \
  --engine=v3 --budget=extended

# Isolated truck planner benchmark (budget is configurable)
npx tsx scripts/diagnose-construction-mpd.ts \
  /path/to/5590_-_whirl_n_wheel_super_truck_with_steps.mpd \
  /path/to/ldraw truck truck-v3.json \
  --engine=v3 --budget=standard
```

The CLI reports specific error codes, phases, planner statistics, and—on failure—individual contact witnesses. The `--inspect-interfaces` output explicitly labels connector matches **uncertified**.

## Verification performed

- Strict independent TypeScript checks of the Construction core (`tests/tsconfig.construction.json`) passed.
- Independent TypeScript checks of the new and modified regression test sources passed using a local Vitest declaration shim (a replacement for missing installed dependencies only during type checking).
- 11 executable standalone assertions passed for sectional parsing, tipped connectors, oversized shoulders, gender, offsets, axle shapes, 3D transforms, typed graph, non-certification of solid overlaps, planner refusal of invalid geometry, and diagnostic text.
- Separate existing V3 synthetic tests passed for swept BVH/box equivalence, guided route distances, deliberate collision rejection, and compile/replay of rotated independently placed subassemblies at 15°, 45°, 90°, and 180°.
- 252 TypeScript and TSX files passed syntax parsing.
- The real LEGO 5590 full-model static audit and independent truck budget benchmark completed, with raw reports included.

**Not verified here:** a full `npm run build`, full Vitest suite, interactive browser playback/UX, complete 5590 certified planning, or real MP4 encoding. The registry-dependent application dependencies were unavailable in this environment.

## Remaining engineering work

1. **Unresolved helicopter facet-brick contacts:** inspect actual mesh witness topology; identify whether these are surface approximations, assembly-geometry errors, or interfaces requiring new metadata. Never add a generalized overlap exception just to make this model pass.
2. **Large-assembly scalability:** step-scoped solving, incremental contact audits, coarse-to-fine route evaluation, failure-driven local subgraph replanning, and benchmark datasets beyond LEGO 5590.
3. **Articulated mechanisms:** a separate solver is needed for actual hinge limits, coupled gear ratios, rack travel, articulated subassembly collision checking, and flexible hose deformation. Current `motion: 'revolute'|'sliding'|'ball'` is only a joint classification/hint and **does not animate those degrees of freedom**.
4. **Visual debugging:** a future 3D witness overlay should draw exact collision markers and connector axes with an opt-in viewport debug setting; current UI provides textual coordinates only.
5. **Distribution/quality:** run the full browser build, Vitest, import/playback, save/reload, and MP4 workflows with a complete licensed LDraw asset set before production release.

## Data attribution

Joint metadata is derived from the locally bundled LDCad Shadow Library. Retain its license and attribution notices when distributing source or generated metadata. Original LDraw library geometry retains its own attribution and license conditions.
