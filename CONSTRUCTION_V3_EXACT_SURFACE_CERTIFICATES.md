# Construction V3 — exact-relative-pose surface certificates

## Purpose

The LEGO 5590 helicopter includes two *surface* contacts near the facet brick
(`2462`) that cannot legitimately be represented as snap/connector joints:

- round plate `4073` with facet brick `2462`;
- loudhailer `4349` with facet brick `2462`.

Their completed render meshes exhibit approximately 2.05 LDU of bounded
surface overlap. A measured 2.5 LDU displacement away from the facet clears
both pairs. These are **not** mechanical joints, assembly dependencies, or
permissions to pass through material during animation.

## Implementation

- `src/anim/construction/reviewedSurfaceContacts.ts` keeps measured witnesses
  as explicit data, including instance IDs, part IDs, obstacle-relative affine
  poses, obstacle-local separation directions, maximum 2.1 LDU bounded contact
  allowance, and 2.5 LDU independent clearance witnesses.
- Each candidate must match **all** identifiers and the obstacle-relative
  transform; the same rigid translation/rotation applied to both parts does
  not invalidate the review, but changing one part's pose does.
- The `MeshOracle` re-measures real geometry *without a relaxed policy* and
  requires clearance within the reviewed 2.1 LDU interval plus a second
  clearance witness at 2.5 LDU. Unverified contacts continue to fail normally.
- Accepted certificates have `kind: 'surface'`, `staticOnly: true`, and no
  `regions`. They cannot create a connector graph edge, mechanical dependency,
  or reduced moving-path collision check. Construction V3's swept mesh oracle
  remains the final route validator.
- The global/default 2.0 LDU contact tolerance is **unchanged**.
- Reviewed observations for this model are bundled, and may be disabled for
  differential diagnostics with the CLI flag `--no-reviewed-surfaces`. Other
  reviews can be passed through the `reviewedSurfaces` option but are equally
  subject to exact-pose and mesh verification.

## Profiled connector matcher import correction

`profiledCylinderMate()` is implemented and exported from
`src/anim/construction/profiledCylinderMate.ts`. The mechanical constraint
engine imports it from that file directly. `src/anim/snapMates.ts` re-exports
it solely for compatibility with existing callers. The standalone module
uses **type-only** imports and has no runtime cycle with `snapMates.ts`.

The profile matcher continues to recognize the valid coaxial 4 LDU
`4073` / `4349` cylindrical engagement while rejecting oversized shoulders,
off-axis cylinders, mismatched genders, and incompatible shapes.

## Verification

With the user-supplied LEGO 5590 MPD and the minimal LDraw tree, a 60-second
V3 *contact-audit-only* run completed successfully:

- 1,258 piece instances, 133 distinct LDraw parts;
- 444 DAT files loaded, 4,162 shadow definitions available;
- 2 reviewed surface contacts accepted;
- final-contact audit passed in approximately 24.1 seconds;
- 5.53 million triangle-pair checks during the audit;
- **no claim that the full route plan or video has been certified**.

The isolated 3-part actual-geometry regression also confirms that both
certificates are valid at their exact poses, invariant to common group
movement, invalidated by relative movement, and do not change the result
of a swept collision check. Tests in
`tests/anim/constructionReviewedSurface.test.ts` cover the same invariants.

To reproduce the audit with dependencies installed, from the project root:

```bash
npx tsx scripts/diagnose-construction-mpd.ts \
  /path/to/5590.mpd /path/to/ldraw full /tmp/5590-audit.json \
  --engine=v3 --budget=extended --audit-only
```

The diagnostic CLI now aborts with an actionable error if run without the
LDCad Shadow Library in the current project directory; previously that could
silently produce false missing-connector errors.

## Boundaries

An exact-pose surface classification is not a motion certificate. The search
must still find and verify a complete insertion route. Large-scale route-search
complexity, physical articulation, and flexible deformation remain separate
unsolved problems. Do not convert a static-only review into a swept-contact
policy to force a route to pass.

## Full-model route test following successful contact audit

A separate V3 `--budget=extended` full-model run got **past** the previously
blocking helicopter final-contact phase and entered guided route search.
It then reached about **50 of the truck's 450 removal units**, attempting
87,240 route candidates before exhausting the 60-second global time budget.
There were zero backtracks. This is a **search-performance failure**, not a
remaining completed-pose contact error, and does not establish that the model
is physically impossible. Supporting records are in:

- `docs/diagnostics/construction-v3-5590-exact-contact-audit.json`
- `docs/diagnostics/construction-v3-5590-60s-route-search.json`
