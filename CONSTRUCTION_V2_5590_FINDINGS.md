# Construction V2: LEGO 5590 real-geometry audit and localized connector fix

Date: 2026-10-24

## Inputs and reproduction

- Model: `5590_-_whirl_n_wheel_super_truck_with_steps.mpd`, user-supplied.
- Dependency bundle: `5590-minimal-ldraw.zip`, user-supplied: 446 resolved LDraw files and **zero missing references** (444 DAT definitions plus configuration/readme).
- Three authored top-level submodels: truck 554 pieces, trailer 399, helicopter 305. Total **1,258** part instances / **133** unique direct part definitions.
- Exact LDraw parts were parsed and flattened to collision triangles with LDCad shadow connector metadata from `vendor/LDCadShadowLibrary`, using the project's own parsers, metrics, model and Construction V2 planner.
- The model's supplied build steps, positions and 45-degree top-level submodel transforms were retained. No placement offsets were invented.
- Plan reproduction uses `modelFromPlan(importLDraw(...), metrics)`, the dependency-free equivalent of the browser's `modelFromNodes(assemble(...))` path, then `planConstruction`.
- CLI: `npx tsx scripts/diagnose-construction-mpd.ts <mpd> <extracted-ldraw-directory> [full|truck|trailer|helicopter] [report.json]`. Extract `5590-minimal-ldraw.zip` to obtain `ldraw/parts`, `ldraw/p`, `ldraw/LDConfig.ldr`.

## Confirmed original failure

**No route search ever starts:** `unresolved-final-contact` with `states=0`, not the previously suspected 2,000-state search budget or a missing external part. The initial full-model run had 12 reported final-contact obstructions, after ~10s of real collision testing. Each submodel also failed when checked separately.

Representative rejected contacts:

- `4442` Technic plate / `4261` steering arm.
- `3749` Technic axle pin / `4442` plate.
- `3701` Technic brick with holes / `2780` friction pin, reported as contained geometry.
- `3743` gear rack / `3647` 8-tooth gear.
- Trailer `755`/`756` overlapping flexible hose segments.
- Helicopter `4073`/`4349`/`2462` interactions.

## Implemented: precise, final-pose-only Technic joint recognition

`src/anim/construction/mechanicalContacts.ts` recognizes a previously unresolved contact **only when both**:

1. The LDCad connector metadata defines opposite-gender, compatible, collinear, engaged cylindrical male/female snap segments; and
2. The actual triangle-and-containment oracle proves that every completed-pose intersection lies inside the union of the corresponding **narrow connector cylinders** (radius max of the two measured snaps + 0.2 LDU).

The resulting certificate carries `staticOnly: true`. It cannot bypass continuous collision checks during removal, insertion, transportation or export replay. This also avoids automatically declaring any nearby gear tooth or flexible-hose geometry safe.

In the truck, **11/12 originally displayed final-contact pairs** met these strict criteria and disappeared after the change. The remaining gear-rack contact did not. The next contacts exposed by deeper auditing include bevel gears and flexible hose segments.

Three focused regression cases were added under `tests/anim/constructionV2MechanicalContacts.test.ts`:

- Correctly recognizing a localized mated pair;
- Rejecting a through-solid swept motion even with the final-pose certificate;
- Rejecting unmated connectors and contacts extending outside the connector region.

A dependency-free synthetic test ran **six assertions successfully**. Strict TypeScript checks passed for the independent Construction V2 source and the new diagnostic CLI. The full app, Vitest and browser tests were not available in the environment.

## Remaining genuine blockers (post-fix)

The corrected planner still does **not** produce a Construction V2-certified animation for LEGO 5590:

- **Truck:** `3743`/`3647` gear/rack mesh; `4143`/`4143` bevel gear mesh; many `755`/`756` intentionally overlapping segments of one flexible hose.
- **Trailer:** A long chain of interpenetrating `755`/`756` flexible-hose segments.
- **Helicopter:** `4073`/`4349`, `4073`/`2462` and `4349`/`2462` authored contacts remain unexplained by the connector metadata.

These are not safely fixable by globally raising the surface-tolerance threshold: a gear train has interlocking rotational contacts, while LDraw's 755/756 geometry models one bent hose as multiple overlapping pieces, not separate independently rigid LEGO parts. Converting them into individually flown solids would generate incorrect assembly motion.

**Next required architecture:** recognize flexible segments as one composite object that moves as a whole during flight; handle gear trains with appropriate meshing/contact and insertion constraints; complete or annotate the helicopter's three connector relationships. Only after these final-contact blockers are eliminated can V2's removal-path search and collision-certified timeline be meaningfully tested on the entire set.

Until then, the user may explicitly select the **Standard planner** to generate an **uncertified** visualization, with review required before export. The V2 solver must not silently fall back to unchecked motion.

## Validation and status

| Scope | Part instances | New result | Search states |
|---|---:|---|---:|
| Truck | 554 | Unresolved gear meshes and flexible-hose segment contacts | 0 |
| Trailer | 399 | Unresolved flexible-hose segment contacts | 0 |
| Helicopter | 305 | Three unexplained mechanical/contact relationships | 0 |
| Full model | 1,258 | The above, beginning in the truck | 0 |

**Production status:** localized connector-recognition improvement verified; the user's complete LEGO 5590 Construction V2 animation is **not** solved or certified. Full browser/build/MP4 QA not performed.
