# Uncertified routes — 31039 Blue Power Jet

Diagnosis of the legacy planner on
`/Users/mac/Downloads/31039_Blue_Power_Jet_LOGICAL_SUBMODELS_v4.mpd`.

## Result

The legacy plan marks **30 units uncertified, containing 86 pieces**. That is
exactly the warning shown by `BuildTimeline.tsx` (it counts `unit.keys`, not
units). The plan takes about **105 s** with the real LDraw library and LDCad
shadow pack.

| Metric | Value |
|---|---:|
| Uncertified units | 30 / 622 |
| Uncertified pieces | 86 |
| Distinct part ids | 33 |
| Single-piece units | 26 (26 pieces) |
| Rigid `attach` units | 4 (60 pieces: 11 + 11 + 19 + 19) |
| First collision in `transit` | 26 units |
| First collision in `insertion corridor` | 4 units |
| First blocker is a final-seat contact | 21 units (77 pieces) |
| First blocker is adjacent, not a seat contact | 9 units (9 pieces) |
| First blocker is a transitive dependency | 27 units |
| First blocker is **not** a dependency | 3 units: 239, 244, 454 |
| Chain contains an uncertified unit | 14 units |
| Alternate tested entries that clear | 0 units |
| Final seat hard-rejected | 1 unit: 33 |
| Units with members missing shadow connectors | 3 units: 33, 111, 117 |

The important split is **not** that the final seat is wrong. In 29/30 units the
final seat is accepted. The flight is rejected **before** the insertion
corridor because it meets pieces that are already built — usually the very
pieces the part is designed to sit on.

## Method

`tests/diagnostics/uncertified.test.ts`:

1. Imports the model and inline submodels, applies
   `public/data/ldcad-shadow.json` through `lib.setShadow(...)`, measures every
   part and assembles the model exactly as the app does.
2. Calls the legacy planner with
   `{ targetSeconds: 15, heroOrbit: true }` (default access search settings) and
   caches the encoded timeline in
   `tests/diagnostics/uncertified-timeline.cache.json`.
3. Rebuilds the planner's resting-piece windows (`blockersAt`) and runs a
   faithful copy of `routeHitsResting` (`src/anim/timeline.ts:1329`) with stage
   reporting, the same final-seat `insertionAllowed` / `verifiedTranslation`
   narrow phases, and the planner's connector axes.
4. For each unit it reports the first blocking piece, the chain of blockers,
   whether removing the chain clears the route, whether the first blocker is a
   final-seat contact / dependency / uncertified, and whether a different entry
   was found by a bounded search over connector axes, `±X/±Y/±Z`, longer
   entries, holds and climb heights.

The full machine-readable output is
`tests/diagnostics/uncertified-analysis.json` (generated, not a source file).
The timeline cache is about 490 KB; it is a build artifact. The local
`tests/diagnostics/.gitignore` excludes the cache and the analysis output.

Reproduce:

```sh
npx vitest run tests/diagnostics/uncertified.test.ts --silent=false
# re-plan instead of using the cache:
FORCE_REPLAN=1 npx vitest run tests/diagnostics/uncertified.test.ts --silent=false
# also run the alternate-entry search (~42 s with cache):
PROBES=1 npx vitest run tests/diagnostics/uncertified.test.ts --silent=false
```

Increasing the access search to **32 attempts / 10 s** produced the **same 30
units**, so this is not merely the default 12-attempt / 4 s budget being too
small.

## Where each unit fails

`Relation` is the relationship of the first blocking piece to the moving unit.
`final-seat contact` means the blocker's box touches and intersects the moving
member's destination box. `dependency` is the transitive dependency closure;
the generated analysis also records the direct edge as `directDependency`.

| # | Unit (keys) | Pcs | Part(s) | Step | First blocker | Stage | Relation | Hard seat | No-snap members |
|---:|---|---:|---|---:|---|---|---|---:|---:|
| 16 | i4 | 1 | 30000 | 15 | i0 32018 "Technic Brick 1 x 14 with Holes" | transit | final-seat contact, dependency | 0 | 0/1 |
| 20 | i7 | 1 | 99780 | 19 | i5 30157 "~Moved to 30157a" | transit | final-seat contact, dependency | 0 | 0/1 |
| 21 | i8 | 1 | 99780 | 20 | i6 30157 "~Moved to 30157a" | transit | final-seat contact, dependency | 0 | 0/1 |
| 22 | i9 | 1 | 3023 | 21 | i5 30157 "~Moved to 30157a" | transit | final-seat contact, dependency | 0 | 0/1 |
| 23 | ia | 1 | 3023 | 22 | i6 30157 "~Moved to 30157a" | transit | final-seat contact, dependency | 0 | 0/1 |
| 29 | ic/ib8 | 1 | 41677 | 28 | ic/iba 6632 "Technic Beam 3 x 0.5 Liftarm" | insertion corridor | adjacent, dependency | 0 | 0/1 |
| 31 | ic/ibc | 1 | 41677 | 30 | ic/iba 6632 "Technic Beam 3 x 0.5 Liftarm" | insertion corridor | adjacent, dependency | 0 | 0/1 |
| 33 | ic/ibe | 1 | 51011 | 32 | ic/ibd 42610 "Wheel Rim 8 x 11.2 with Centre Groove" | transit | final-seat contact, dependency | 1 | 1/1 |
| 42 | id | 1 | 32018 | 40 | i4 30000 "Brick 2 x 2 with Pins and Axlehole" | transit | final-seat contact, dependency, uncertified | 0 | 0/1 |
| 110 | i2m/ibm | 1 | 31039 - 13971 | 87 | i2m/ibl 3673 "Technic Pin" | transit | final-seat contact, dependency | 0 | 0/1 |
| 111 | i2m/ibn | 1 | 31039 - 61254 | 88 | i2m/ibj 32316 "Technic Beam 5" | transit | adjacent, dependency | 0 | 1/1 |
| 116 | i2n/ibm | 1 | 31039 - 13971 | 93 | i2n/ibl 3673 "Technic Pin" | transit | final-seat contact, dependency | 0 | 0/1 |
| 117 | i2n/ibn | 1 | 31039 - 61254 | 94 | i2n/ibj 32316 "Technic Beam 5" | transit | adjacent, dependency | 0 | 1/1 |
| 233 | i5u | 1 | 2780 | 171 | i5s 6541 "Technic Brick 1 x 1 with Hole" | transit | final-seat contact, dependency | 0 | 0/1 |
| 234 | i5v | 1 | 2780 | 171 | i5t 6541 "Technic Brick 1 x 1 with Hole" | transit | final-seat contact, dependency | 0 | 0/1 |
| 236 | i5x | 1 | 6536 | 173 | i5u 2780 "Technic Pin with Friction and Slots" | transit | final-seat contact, dependency, uncertified | 0 | 0/1 |
| 238 | i5z | 1 | 6536 | 174 | i5v 2780 "Technic Pin with Friction and Slots" | transit | final-seat contact, dependency, uncertified | 0 | 0/1 |
| 239 | i60 | 1 | 3706 | 175 | i5l 4162 "Tile 1 x 8" | transit | adjacent, **not** dependency | 0 | 0/1 |
| 240 | i61 | 1 | 32123a | 176 | i5x 6536 "Technic Cross Block 1 x 2 (Axle/Pin)" | insertion corridor | adjacent, dependency, uncertified | 0 | 0/1 |
| 241 | i62 | 1 | 32123a | 176 | i5z 6536 "Technic Cross Block 1 x 2 (Axle/Pin)" | insertion corridor | adjacent, dependency, uncertified | 0 | 0/1 |
| 242 | i63 | 1 | 32015 | 177 | i60 3706 "Technic Axle 6" | transit | final-seat contact, dependency, uncertified | 0 | 0/1 |
| 243 | i64 | 1 | 32015 | 177 | i60 3706 "Technic Axle 6" | transit | final-seat contact, dependency, uncertified | 0 | 0/1 |
| 244 | i65 | 1 | 6558 | 178 | i5p 15068 "Slope Brick Curved 2 x 2 x 0.667" | transit | adjacent, **not** dependency | 0 | 0/1 |
| 245 | i66 | 1 | 6558 | 178 | i5d 18677 "Plate 1 x 2 with Offset Peghole on Underside" | transit | final-seat contact, dependency | 0 | 0/1 |
| 278 | i73 | 1 | 30236 | 204 | i72 15712 "Tile 1 x 1 with Clip (Thick C-Clip)" | transit | final-seat contact, dependency | 0 | 0/1 |
| 454 | ias/icv | 1 | 2429 | 335 | ias/icm 3034 "Plate 2 x 8" | transit | adjacent, **not** dependency | 0 | 0/1 |
| 569 | ib2/ifh… | 11 | 6106, 2450 x3, 41769, 3070b, 3068b, 3710, 10247, 6636 x2 | 442 | i66 6558 "Technic Pin Long with Friction and Slot" | transit | final-seat contact, dependency, uncertified | 0 | 0/11 |
| 581 | ib3/ifs… | 11 | 6106, 2450 x3, 3070b, 3068b, 41770, 3710, 10247, 6636 x2 | 454 | i65 6558 "Technic Pin Long with Friction and Slot" | transit | final-seat contact, dependency, uncertified | 0 | 0/11 |
| 601 | ib4/ig3… | 19 | 32124 x2, 3004 x5, 3710 x3, 3024, 60481 x3, 4460b x2, 3010, 3005, 2431 | 474 | i64 32015 "Technic Angle Connector #5 (112.5 degree)" | transit | final-seat contact, dependency, uncertified | 0 | 0/19 |
| 621 | ib5/ig3… | 19 | 32124 x2, 3004 x5, 3710 x3, 3024, 60481 x3, 4460b x2, 3010, 3005, 2431 | 494 | i63 32015 "Technic Angle Connector #5 (112.5 degree)" | transit | final-seat contact, dependency, uncertified | 0 | 0/19 |

All 30 routes become clear when the reported blocker chain is removed from the
resting set. That is strong evidence that the destination is reachable and the
rejection is a route/approach decision, not general impossibility.

## Per-part-id counts

| Part | Name | Pieces | Units |
|---|---|---:|---:|
| 3004 | Brick 1 x 2 | 10 | 601, 621 |
| 3710 | Plate 1 x 4 | 8 | 569, 581, 601, 621 |
| 2450 | Plate 3 x 3 without Corner | 6 | 569, 581 |
| 60481 | ~Moved to 60481a | 6 | 601, 621 |
| 32124 | Technic Rotor 2 Blade with 4 Studs | 4 | 601, 621 |
| 4460b | Slope Brick 75 2 x 1 x 3 with Hollow Stud | 4 | 601, 621 |
| 6636 | Tile 1 x 6 | 4 | 569, 581 |
| 10247 | Plate 2 x 2 with Hole and Complete Underside Rib | 2 | 569, 581 |
| 2431 | Tile 1 x 4 with Groove | 2 | 601, 621 |
| 2780 | Technic Pin with Friction and Slots | 2 | 233, 234 |
| 3005 | Brick 1 x 1 | 2 | 601, 621 |
| 3010 | Brick 1 x 4 | 2 | 601, 621 |
| 3023 | ~Moved to 3023b | 2 | 22, 23 |
| 3024 | Plate 1 x 1 | 2 | 601, 621 |
| 3068b | Tile 2 x 2 with Groove | 2 | 569, 581 |
| 3070b | Tile 1 x 1 with Groove | 2 | 569, 581 |
| 31039 - 13971 | Wheel Rim 8 x 18 with Deep Centre Groove, Deep Spokes and Peghole | 2 | 110, 116 |
| 31039 - 61254 | Tyre 7/ 45x 17 Offset Tread with Middle Band | 2 | 111, 117 |
| 32015 | Technic Angle Connector #5 (112.5 degree) | 2 | 242, 243 |
| 32123a | Technic Bush 1/2 Smooth with Axle Hole Reduced | 2 | 240, 241 |
| 41677 | Technic Beam 2 x 0.5 Liftarm | 2 | 29, 31 |
| 6106 | Plate 6 x 6 without Corner | 2 | 569, 581 |
| 6536 | Technic Cross Block 1 x 2 (Axle/Pin) | 2 | 236, 238 |
| 6558 | Technic Pin Long with Friction and Slot | 2 | 244, 245 |
| 99780 | Bracket 1 x 2 - 1 x 2 Up | 2 | 20, 21 |
| 2429 | Hinge Plate 1 x 4 Base | 1 | 454 |
| 30000 | Brick 2 x 2 with Pins and Axlehole | 1 | 16 |
| 30236 | Brick 1 x 2 with Handle | 1 | 278 |
| 32018 | Technic Brick 1 x 14 with Holes | 1 | 42 |
| 3706 | Technic Axle 6 | 1 | 239 |
| 41769 | ~Moved to 41769a | 1 | 569 |
| 41770 | ~Moved to 41770a | 1 | 581 |
| 51011 | Tyre 6.4/ 75 x 8 Shallow Offset Tread | 1 | 33 |

## Causes

### A. The approach hits an already-built piece before the insertion waiver

**All 30 units. 26 first hits in transit, 4 in the insertion corridor. 86/86
pieces are affected through their unit.**

`routeHitsResting` accepts an overlap with the destination only when

```ts
local0 >= insertion - 1e-6 && boxIntersects(destinations[k], block.box) && allowInsertion(...)
```

with `insertion = 0.8` for lateral entries and `0.76` for vertical entries
(`src/anim/timeline.ts:1380-1381`). Before that point, the same contact is a
hard collision. For a short entry (often 4 LDU), the descent at
`destination + entry` already overlaps the holder, so the flight is rejected in
`transit`. For a vertical entry, the descent passes through the holder until
`0.76`.

- **A1 — the blocker is a final-seat contact and transitive dependency: 21
  units / 77 pieces.** Units 16, 20, 21, 22, 23, 33, 42, 110, 116, 233, 234,
  236, 238, 242, 243, 245, 278, 569, 581, 601, 621. These are usually the
  intended mates: a pin into a brick, a rim onto a pin, a plate onto a pin, a
  rotor onto an angle connector. (Unit 33 is the tyre/rim data exception, see
  cause B.) Reordering cannot help because the mate must exist first.
- **A2 — the first blocker is adjacent rather than a seat contact: 9 units / 9
  pieces.** Units 29, 31, 111, 117, 239, 240, 241, 244, 454. Six of these are
  still transitive dependencies; only 239, 244 and 454 have a first blocker
  outside the dependency closure. Four of the nine fail in the insertion
  corridor rather than transit (29, 31, 240, 241).
- Removing the whole reported chain clears **30/30** routes.
- A bounded alternate-entry search (connector axes in both directions,
  `±X/±Y/±Z`, 12/60 LDU entries, holds, two climb heights) found **0/30**
  clearing entries. Wrong approach axis is therefore not the primary cause;
  the corridor around the mate is.

**Representative examples**

- **#233 `2780` pin → #231 `6541` brick (step 171, transit).** The pin's final
  seat is accepted (`score 0.061 / cap 0.085`), but its short `+Z` entry keeps
  it inside the brick while lowering. Removing the brick clears the route.
  Units 234, 236 and 238 then form a cascade: the cross blocks are blocked by
  the pins, and the bush units 240/241 by those cross blocks.
- **#110 `13971` rim → #109 `3673` pin (step 87, transit).** The rim is seated
  on the pin at the destination, but the descent with a 4 LDU entry intersects
  the pin body before `local0 = 0.8`. Removing the pin clears the route; it is
  a direct dependency, so the pin cannot simply be moved later.
- **#42 `32018` Technic Brick 1 x 14 (step 40, transit).** The long brick has
  eight final-seat contacts; the first is `30000`. Removing all eight clears.
  This is the same issue at scale: the brick threads through parts that are
  already built while the waiver is only active in the last 20% of the slide.
- **#569 / #581 (11-piece plates, steps 442/454).** The whole plate and tile
  chunk is blocked by a single long pin (`6558`, #245/#244). A per-member route
  check lets one protruding pin reject the entire rigid chunk.
- **#33 `51011` tyre → `42610` rim (step 32).** Unlike the others, this one also
  fails the final seat: 28.02/28.01 LDU overlap, no connector axes, and the
  tyre has **zero shadow connectors**. See cause B.
- **#29 / #31 `41677` liftarm → `6632` / `32449` beams (steps 28/30, insertion
  corridor).** The final seat is on the two `32062` axles and is accepted, but
  the slide-in path is blocked by adjacent beams. These are insertion-corridor
  failures, so a longer/clearer entry is needed rather than only a later
  waiver.

### B. Missing connector data / a hard final-seat fit

**1 hard failure, 3 units with missing shadow connector data.**

- **#33 tyre `51011` + rim `42610`:** the tyre has 0 shadow connector entries,
  no connector mate is found, and the final overlap is
  `[16, 28.02, 28.01]` LDU. The final seat is rejected outright.
- **#111 / #117 tyre `61254` + rim `13971`:** the tyres also have 0 shadow
  connectors. Their final seats are accepted only marginally
  (`score 0.082 / cap 0.085`, overlap `18 x 42 x 42`). They currently fail in
  transit, but this is a connector-data gap and a fragile fit.
- `rigidWheelPairs` (`src/anim/rigidHardware.ts:18`) only recognises known
  6014/6015 wheels or rims/tyres paired by `SNAP_GEN` group `rim…`
  (`rigidHardware.ts:34-56`). With no snaps on these tyres, the rim and tyre
  stay separate and the tyre becomes an independent flight. The window-pane
  fallback (`rigidHardware.ts:58-69`) already demonstrates a one-sided-data
  pairing pattern that could be extended.

### C. Cascades from other uncertified units

**14 units have an uncertified blocker in their chain; 11 have an uncertified
*first* blocker.** Units 31, 42, 111, 117, 236, 238, 240, 241, 242, 243, 569,
581, 601, 621. This is mostly a consequence of A/B rather than an independent
failure: the pin units 233/234 block the cross blocks 236/238, which block the
bushes 240/241 and the axle/angle-connector chain 239-245; those in turn block
the two rotor attaches 601/621. Fixing the earliest route in each cluster should
remove most of these from the warning.

### D. Rigid attach flights amplify the problem

**4 units / 60 pieces.** Units 569, 581 (11 pieces each) and 601, 621 (19 pieces
each) are rigid subassemblies. `routeHitsResting` is called with every member
(`src/anim/timeline.ts:1370-1395`), so one member that cannot thread past a pin
rejects the entire chunk even though the other 18 members are clear. This is
why 60 of the 86 pieces are in only four units.

## Recommendations, ranked by expected impact

1. **Allow a verified connector mate during the final approach, not only the
   last 20%.** In `routeHitsResting`
   (`src/anim/timeline.ts:1380-1381`), when a block intersects the destination
   and `allowInsertion` passes, permit the contact once the member is on the
   final approach segment (lateral: from `SIDE_CRUISE_END` / 0.56; vertical:
   from `LOWER_START` / 0.76), or gate it on a connector axis that is collinear
   with the approach. Keep the existing mesh check so unrelated parts are still
   rejected. Expected to address the 21 final-seat-contact units (77 pieces)
   without weakening unrelated collision checks.
2. **Generate entries that are actually clear of the holder.** In `entries()`
   (`src/anim/timeline.ts:805-835`), `clearOf(around)` uses the destination
   AABB. When the holder box contains the destination, this can still yield a
   4 LDU entry. Compute the offset from the moving member's real box and the
   holder's extent along the connector way, and prefer the longest entry when
   fallback candidates have equal reject counts. This directly targets the
   the 233/234 and 110/116 pin/brick cases and the 21 contact units.
3. **Pair the unsupported rims and tyres.** Extend `rigidWheelPairs`
   (`src/anim/rigidHardware.ts:34-69`) to recognise `51011 + 42610` and
   `61254 + 13971` when they are geometrically seated even if the tyre has no
   shadow `SNAP_GEN` data, following the existing one-sided window-pane
   fallback. This removes the hard #33 failure and the fragile #111/#117 fits,
   and turns each wheel into one rigid unit.
4. **Handle attach members individually at the mating contact.** For units
   569/581/601/621, let the member that actually touches the blocker use its
   connector axis for the approach waiver instead of letting an unrelated
   member's pin reject the whole subassembly. Re-run the diagnostic and confirm
   that the 19-piece rotor units no longer fail on a single angle connector.
5. **Follow up on the three non-dependency cases (239, 244, 454).** #239 is the
   clean reorder candidate: removing `i5l` (Tile 1 x 8) alone clears its route.
   A higher access budget (32 attempts / 10 s) did **not** change the uncertified
   set, so do not just increase the budget; inspect why the sibling edge for
   #239 is not accepted (`src/anim/accessOrder.ts:searchAccessOrder`,
   `src/anim/timeline.ts:177-190`). Lower priority than 1-3.
6. **Record the rejection reason on the timeline.** `Unit` exposes only
   `uncertified?: boolean` (`src/anim/timelineData.ts:22`); the blocker and
   stage are discarded after planning. Carry an optional
   `{ blocker, stage, dependency }` per uncertified unit so the UI warning
   (`src/ui/BuildTimeline.tsx:81`) and future diagnostics can explain *why*
   without re-planning.

## Caveats

- The route replica is deliberately close to `routeHitsResting`, but the
  `holder` predicate used for final-seat insertion is approximated as
  “connector mate or dependency” instead of the planner's full `requires` set.
  This can only make a final seat look *more* permissive, never more strict;
  the reported first blockers are real route collisions.
- The alternate-entry search is bounded (connector axes, `±X/±Y/±Z`, two
  lengths, two holds, two climb heights). The planner itself tries more
  lengths and five lanes, so “0/30 clear” means the tested alternatives do not
  help, not that no exotic path exists.
- The 105 s plan and the 32-attempt / 10 s experiment both produced the same 30
  uncertified units; the cached plan corresponds to the default app options.
- `tests/diagnostics/uncertified-timeline.cache.json` (about 490 KB) and
  `tests/diagnostics/uncertified-analysis.json` (about 300 KB) are generated
  artifacts. They are useful for re-running the analysis without paying the
  105 s plan again; `tests/diagnostics/.gitignore` excludes both.

## Connector library results

Recommendation 3 is implemented. The supplementary connector data lives in
`src/data/connectorLibrary.ts` (chosen over a file under `public/data`, which is
gitignored) and is applied by `PartLibrary.loadPart`. It adds only missing
connector groups; LDCad shadow data is never removed or replaced.

Embedded copies are aliased to the library part they copy only when their
flattened geometry matches: triangle count, body/full bounds, centroid and
surface area (`src/ldraw/partAlias.ts`). A matching name alone is not enough, so
`31039 - 13971.dat` and `31039 - 61254.dat` inherit `13971`/`61254` shadow and
supplementary data while a renamed part with different geometry does not.

`rigidWheelPairs` now recognises the measured `51011 + 42610` and
`61254 + 13971` seats. It works one-sided like the window-pane fallback: a tyre
seat connector plus a coaxial rim whose measured outer radius fits the bore is
enough, even when the rim has no connector data. When both sides do have data
the pair is still emitted once.

| Metric | Before | After |
|---|---:|---:|
| Uncertified units | 30 / 622 | 27 / 619 |
| Uncertified pieces | 86 | 85 |
| Final seat hard-rejected | 1 unit (#33) | 0 |
| Units with members missing shadow connectors | 3 units (33, 111, 117) | 0 |
| Rigid-wheel uncertified units | 4 separate tyre units | 2 two-piece wheel units (109, 114) |

What changed:

- The hard-rejected `51011` unit (#33) is gone.
- The `61254` tyre units (#111/#117) are gone as separate units. Each tyre is
  now rigidly attached to its `13971` rim, so the combined wheel units (#109,
  #114) contain two pieces instead of one. Those two units are still
  uncertified, but for the pre-existing route reason: they hit pin `3673` in
  transit, not because the tyre lacks connectors.
- No unit was added to or removed from the rest of the uncertified set; the
  other 25 units are unchanged.

Verification:

- `npx tsc --noEmit` passes.
- `npx vitest run tests/ldraw/connectorLibrary.test.ts tests/anim/rigidHardware.test.ts`
  passes all 13 tests, including negative cases for a non-matching inline
  geometry, a renamed part that is not geometrically equal, a tyre beside its
  rim, and a mismatched seat radius.
- `npx vitest run tests/anim tests/ldraw tests/model tests/io` passes 149 tests;
  the only two failures are the pre-existing
  `minifigInsertion.test.ts` ("every minifig piece goes on along a way its real
  shape allows") and `timeline.test.ts` ("within a step a piece flies in after
  the piece it rests on") cases.
- `FORCE_REPLAN=1 npx vitest run tests/diagnostics/uncertified.test.ts --silent=false`
  re-planned in 101.8 s and produced the after numbers above.

Remaining issue from this change: the `13971 + 61254` wheel units still fail
route certification on the pin `3673` seat. That is a transit/approach problem
covered by recommendations 1 and 2, not a missing-connector problem.
