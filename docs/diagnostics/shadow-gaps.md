# LDCad shadow-library connector coverage gaps

Read-only diagnostic for **BrickMotion Studio**. It measures the connectors the app actually sees after `ownSnaps`, `SNAP_INCL` expansion and `SNAP_CLEAR`, not merely the number of shadow files. No source file was modified.

## Versions and inputs

| Input | Value |
| --- | --- |
| Official LDraw library | `public/ldraw`, 24,856 top-level parts, newest `!LDRAW_ORG ... UPDATE` stamp **2026-09** |
| LDCad Shadow Library checkout | `vendor/LDCadShadowLibrary` at `9b1131fb1991f8c0bfc072325e4e12f6271aba35` |
| Packed shadow copy | `public/data/ldcad-shadow.json` at `9b1131fb1991f8c0bfc072325e4e12f6271aba35`, 4,162 files, CC BY-SA 4.0, LDCad Shadow Library (Roland Melkert and contributors) |
| Upstream check | `9b1131fb1991f8c0bfc072325e4e12f6271aba35` — same as checkout |
| Connector-primitive seed | 12 families derived from the 86 SNAP-annotated primitives in `vendor/LDCadShadowLibrary/p`; unmapped seed primitives: none |
| Local usage corpus | 13 model files, 13 models, 3,813 piece instances, 280 distinct part ids |

The upstream check is read-only (`git ls-remote`). A result of “same as checkout” means the local vendor copy is current as of this run; “differs” means upstream has newer or rewritten history.

## Method

### Effective snaps (app pipeline)

For each official top-level part, the script walks the same reference tree as `src/ldraw/flatten.ts`:

- every referenced file contributes its own shadow snaps via `ownSnaps()` (which also expands `SNAP_INCL`);
- an including file's `SNAP_CLEAR` drops inherited snaps, either all of them or the named connector ids;
- transforms place each snap in the part's coordinate space;
- provenance is recorded as the source file that defined the snap, so “own” versus “inherited” is observable.

The two tyre/rim pairs are reported both ways: **shadow data alone** (the upstream-relevant number) and **with the app's supplementary connector library** (`src/data/connectorLibrary.ts`). Supplementary snaps are tagged and deduplicated by group exactly as `PartLibrary.loadPart()` does.

### Expected connectors (independent of shadow data)

The expected side is a data-driven primitive model, not a count of shadow files:

1. The seed families come from the primitives the shadow library annotates in `vendor/LDCadShadowLibrary/p` (studs, stud4 anti-studs, pegholes, beam/connector holes, axle holes, axles, pins, clips, hinge fingers, joints, bars). Regex variants catch official family members the seed implies but does not list (for example `npeghol7`, `stud5`, `axl5hol9`, `clip15`, `confricrib1`).
2. For every instance of an annotated primitive in the part's reference tree, its **own active snap counts** are added to the expected class totals. This is what the app would inherit if no `SNAP_CLEAR` removed anything.
3. An unannotated connector variant contributes **one inferred snap** only when it is a leaf in the primitive tree (so `npeghol2` -> two `npeghol7` leaves, not three snaps) and only for a class with no annotated evidence. `stug-*` stud groups are excluded because their `stud.dat` children are counted directly. `stud4` anti-studs are evidence-only because they are structural underside tubes; the parent shadow normally represents the seating positions as F snaps.
4. Per class, annotated evidence overrides unannotated evidence. This prevents a `beamhole` annotation plus its internal `npeghol` geometry from being double-counted.
5. A part with axle-end primitives (or flexible-axle `s/faxle*` segments) is an axle body: its `axlehol*` primitives draw the axle's own cross shape, so they add no expected holes.
6. Hinge primitives repeat once per tooth, but LDCad models a whole finger set as one `SNAP_FGR` with a `seq` of widths, so a hinge part needs at least one finger snap, not one per tooth.

Missing counts are compared per snap class (`cyl M`, `cyl F`, `clip`, `hinge finger`, `generic M/F`) with documented tolerance:

- 25% missing allowed for stud/hole/clip families;
- 50% for pins, axles, hinges and generic joints, where one long snap can consolidate several primitive segments;
- 50% when the only expected source is a peghole/axle-hole family (a long slide snap can cover several segments).

A part is an **inheritance gap** when an expected class falls below that tolerance. This catches both unannotated primitives and over-aggressive `SNAP_CLEAR`.

### Bucket rules (exactly one bucket per part)

| Bucket | Rule |
| --- | --- |
| **covered** | Expected connectors are present within tolerance, or the part has effective snaps but no primitive-derived expectation. |
| **redirect/alias** | `~Moved to`, `Part Alias`, `Part Physical_Colour`, or any `Shortcut`. For redirects the status is the target's status; for shortcuts the status is computed from the component-derived snaps. Report the target status. |
| **inheritance gap** | Has connector-primitive evidence but a snap class is below tolerance (unannotated primitive or over-clearing `SNAP_CLEAR`). |
| **geometry-only gap** | No or too little primitive evidence to derive an expectation, but the category/title says the part connects (Technic, wheel, tyre, hinge, clip, bar, minifig, hose, etc.) and effective snaps are absent. These need hand modelling/review. |
| **no connectors expected** | Sticker or sticker-sheet titles/categories, sheet fabric/plastic/cardboard, and the baseplate special case **only when there are no effective snaps**. Sticker shortcuts that include a base part keep that part's connectors, and printed variants of ordinary parts are **not** automatically excluded. |
| **unknown** | Neither connector evidence nor a decorative/connector hint. Listed rather than guessed. |

### Usage ranking

Every `*.mpd`/`*.ldr` file under `~/Downloads`, `samples/`, `public/ldraw/models/` and `public/data/` was parsed (13 files). MPD submodels are resolved recursively; embedded copies whose names follow `<title> - <partId>` are mapped to the library id (for example `31039 - 13971` -> `13971`) and not recursed into as submodels. Duplicate/derived 31039 instruction files and two copies of 10156 are counted as separate models, so the ranking is a usage signal, not a market survey.

**The corpus is small.** It contains 13 models and 3,813 piece instances, mostly one jet family plus demos. The **LDraw Official Model Repository (OMR)** is the right larger corpus for a representative ranking; it was not downloaded for this analysis. Recounting against OMR is the single highest-value follow-up for prioritisation.

## Totals

### Buckets (all 24,856 parts)

| Bucket | With supplementary | % | Shadow data only | % |
| --- | ---: | ---: | ---: | ---: |
| covered | 12,186 | 49.0% | 12,087 | 48.6% |
| redirect/alias | 7,045 | 28.3% | 7,045 | 28.3% |
| inheritance gap | 482 | 1.9% | 482 | 1.9% |
| geometry-only gap | 1,343 | 5.4% | 1,442 | 5.8% |
| no connectors expected | 2,924 | 11.8% | 2,924 | 11.8% |
| unknown | 876 | 3.5% | 876 | 3.5% |

### Coverage status (same parts, status is finer-grained for redirects/shortcuts)

| Status | With supplementary | % | Shadow data only | % |
| --- | ---: | ---: | ---: | ---: |
| covered | 18,593 | 74.8% | 18,483 | 74.4% |
| inheritance gap | 704 | 2.8% | 704 | 2.8% |
| geometry-only gap | 1,503 | 6.0% | 1,613 | 6.5% |
| no connectors expected | 3,115 | 12.5% | 3,115 | 12.5% |
| unknown | 932 | 3.7% | 932 | 3.7% |
| target missing | 9 | 0.0% | 9 | 0.0% |

Shortcuts (5,264 parts) break down as: covered 4904, inheritance gap 188, geometry-only gap 85, no connectors expected 55, unknown 32. Redirects are not themselves ranked as gaps; they inherit the target's status. Supplementary data changes the status of 100 part(s): 11209, 11957, 15413, 18450, 1872, 18977, 18978b, 18979a, 18979b, 2346, 23798, 23799, 24308b, 2696, 2807, 2857, 2902, 29117a, 2995, 2997, 30028b, 30155, 30190, 30391, 30648, 30699, 3139b, 32076, 32078, 32180, 32196, 32296, 32296p01, 32298, 32298p01, 3483, 35578, 36, 3634, 3740, 4084, 41893, 41897, 4410, 44308, 44309, 4455, 44771, 44799, 451b, 458, 458c01, 45982, 46335, 50861, 50951, 51011, 52985, 539, 54120, 55976, 55978, 56890, 56891, 56897, 56898, 56907, 574, 58090, 59895, 6015, 61254, 61480, 61481, 6578, 6578c01, 6579, 6581, 6594, 6596, 67140, 69909, 69912, 70490, 70695, 71721, 71722, 72210a, 72210b, 7860, 80279, 80542, 87414, 87697, 88516, 89201, 92402, 92409, 92912, u9131.

## Top 50 gaps by usage

Only rankable gaps are shown (moved/alias redirects excluded). “Missing” lists the deficient snap classes as effective/expected. Usage is instances in the local corpus; models is the number of distinct models containing the part.

| # | Part | Title | Category | Bucket | Uses | Models | Missing feature types |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 70720c01 | ~Axle Steel 5 x 112 LDU with Conical Ends with Two Train Wheels with Open Centres | Wheel | redirect/alias | 10 | 1 | no effective snaps |
| 2 | 85984 | Slope Brick 31 1 x 2 x 0.667 | — | inheritance gap | 8 | 4 | cyl M 0/1 |
| 3 | 70023 | ~Magnet Cylindrical (Obsolete) | Obsolete | geometry-only gap | 4 | 1 | no effective snaps |
| 4 | 4588 | Brick 1 x 1 Round with Fins | — | inheritance gap | 1 | 1 | cyl F 1/6 |
| 5 | 2894c01 | Electric Train Motor 9V (Complete) | — | redirect/alias | 1 | 1 | cyl F 0/1 |
| 6 | 23324 | ~Electric Motor Unit 6 x 18 x 4 - Bottom | — | inheritance gap | 0 | 0 | cyl F 0/64 |
| 7 | 95646 | Electric Mindstorms EV3 | — | redirect/alias | 0 | 0 | cyl F 32/80 |
| 8 | 95646c01 | Electric Mindstorms EV3 with Rechargeable Battery | — | redirect/alias | 0 | 0 | cyl F 32/80 |
| 9 | 99141c01 | Electric Mindstorms EV3 without Bottom Lid | — | redirect/alias | 0 | 0 | cyl F 32/80 |
| 10 | 43446c01 | ~Electric RC Receiver Unit with Auxiliary Output Body | — | redirect/alias | 0 | 0 | cyl F 32/76 |
| 11 | 43446 | ~Electric RC Race Buggy Battery Top | — | inheritance gap | 0 | 0 | cyl F 20/54 |
| 12 | 99141 | ~Electric Mindstorms EV3 Shell Top | — | inheritance gap | 0 | 0 | cyl F 20/52 |
| 13 | 99141p01 | ~Electric Mindstorms EV3 Shell Top with LEGO Logo Pattern | — | inheritance gap | 0 | 0 | cyl F 20/52 |
| 14 | 32065 | Technic Beam 7 x 0.5 | — | inheritance gap | 0 | 0 | cyl F 7/38 |
| 15 | 54734 | Electric 9V Battery Box with Pegholes (Complete) | — | redirect/alias | 0 | 0 | cyl F 20/48 |
| 16 | 923 | ~Electric 9V Battery Box with Pegholes Case | — | inheritance gap | 0 | 0 | cyl F 20/48 |
| 17 | 32063 | Technic Beam 6 x 0.5 | — | inheritance gap | 0 | 0 | cyl F 6/32 |
| 18 | 42924 | Technic Pin Long with Friction Type 2 | — | inheritance gap | 0 | 0 | cyl M 1/24 |
| 19 | 65414c01 | Technic Differential with Red 28 Tooth Drive Gear and Tan Satellites | — | redirect/alias | 0 | 0 | cyl F 2/23 |
| 20 | 7222 | Technic Axle with 4 Wheel Pins | — | inheritance gap | 0 | 0 | cyl M 0/21 |
| 21 | 32289a | Electric Technic Motor 4.5V 6 x 17 x 5 Base Type 1 | — | inheritance gap | 0 | 0 | cyl F 0/20 |
| 22 | 11214 | Technic Axle Pin Long with Friction with 2L Pin | — | inheritance gap | 0 | 0 | cyl M 1/18 |
| 23 | 12782 | ~Pullback Motor 6 x 5 x 3 Threaded Side | Technic | inheritance gap | 0 | 0 | cyl F 7/24 |
| 24 | 12787 | ~Pullback Motor 6 x 5 x 3 Screw Head Side | Technic | inheritance gap | 0 | 0 | cyl F 7/24 |
| 25 | 11025 | ~Electric Mindstorms EV3 Bottom Shell | — | inheritance gap | 0 | 0 | cyl F 12/28 |
| 26 | 11025p01 | ~Electric Mindstorms EV3 Bottom Shell with Port Id. Pattern | — | inheritance gap | 0 | 0 | cyl F 12/28 |
| 27 | 53791 | ~Electric Mindstorms NXT Battery Case (Needs Work) | — | inheritance gap | 0 | 0 | cyl F 12/28 |
| 28 | 65304 | Technic Pin Long with Stop Bush Type 2 | — | inheritance gap | 0 | 0 | cyl M 1/17 |
| 29 | 72156 | Electric Mindstorms EV3 IR-Beacon / Remote Handset | — | redirect/alias | 0 | 0 | cyl F 10/26 |
| 30 | 76607 | ~Electric Mindstorms EV3 IR-Beacon Case Top | — | inheritance gap | 0 | 0 | cyl F 10/26 |
| 31 | 76607c01 | Electric Mindstorms EV3 IR-Beacon / Remote Handset Case | — | redirect/alias | 0 | 0 | cyl F 10/26 |
| 32 | 76607p01 | ~Electric Mindstorms EV3 IR-Beacon Case Top, Colour Marks Pattern | — | inheritance gap | 0 | 0 | cyl F 10/26 |
| 33 | 53792 | Electric Mindstorms NXT Ultrasonic Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 34 | 53793c00 | Electric Mindstorms NXT Touch Sensor Case | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 35 | 55816 | ~Electric Mindstorms NXT Sensor Shell Back | — | inheritance gap | 0 | 0 | cyl F 3/18 |
| 36 | 55963 | Electric Mindstorms NXT Sound Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 37 | 55969 | Electric Mindstorms NXT Light Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 38 | 62840 | Electric Mindstorms NXT Temperature Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 39 | 64892 | Electric Mindstorms NXT Colour Sensor / Colour Lamp | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 40 | ms1034 | Electric Mindstorms NXT Compass Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 41 | ms1038 | Electric Mindstorms NXT Colour Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 42 | ms1040 | Electric Mindstorms NXT Accelerometer Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 43 | ms1042 | Electric Mindstorms NXT InfraRed Seeker Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 44 | ms1044 | Electric Mindstorms NXT Gyroscopic Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 45 | ms1048 | Electric Mindstorms NXT RFID Sensor | — | redirect/alias | 0 | 0 | cyl F 3/18 |
| 46 | 32289b | Electric Technic Motor 4.5V 6 x 17 x 5 Base Type 2 | — | inheritance gap | 0 | 0 | cyl F 0/14 |
| 47 | 4586 | Technic Beam 9 x 0.5 with 3 Holes | — | inheritance gap | 0 | 0 | cyl F 0/14 |
| 48 | 39888 | Technic Pin Long without Friction Type 2 | — | inheritance gap | 0 | 0 | cyl M 1/14 |
| 49 | 41670 | Technic Bionicle Leg 4 x 4 with Two Ball Joints | — | inheritance gap | 0 | 0 | cyl F 1/14 |
| 50 | 501ac01 | Electric Train Motor 12V with 2-Hole Sockets (Complete) | — | redirect/alias | 0 | 0 | cyl M 17/28; cyl F 4/6 |

## Gaps grouped by family

Family is the part's `!CATEGORY`, or a title-derived family when the category is missing or `Obsolete`. “Missing/unmodelled” counts missing snaps for inheritance gaps and one placeholder per geometry-only part.

| Family | Gap parts | Uses | Missing/unmodelled | Example parts |
| --- | --- | --- | --- | --- |
| Wheel | 24 | 10 | 25 | 70720c01, 12588, 12589, 12589c01 |
| Brick | 82 | 9 | 162 | 85984, 4588, 11290, 13358 |
| Obsolete | 2 | 4 | 2 | 70023, u8014 |
| Uncategorised | 441 | 1 | 1443 | 2894c01, 10091, 10132, 10152 |
| Technic | 292 | 0 | 773 | 100943, 100943p01, 103671-f1, 108 |
| Minifig Accessory | 195 | 0 | 208 | 11092, 11439, 11439p01, 11439p02 |
| Minifig Headwear | 137 | 0 | 137 | 10164, 10164p01, 10168, 10168p01 |
| Electric | 126 | 0 | 139 | 2840, 2843, 2844, 2845 |
| Sticker Shortcut | 99 | 0 | 182 | 11055d02, 11055d03, 11055d04, 11055d05 |
| Minifig | 75 | 0 | 118 | 100937, 10177, 10177b, 10354 |
| Minifig Neckwear | 74 | 0 | 75 | 10052, 10183, 10183p01, 11438 |
| Figure Accessory | 65 | 0 | 65 | 11641, 2044, 25866, 25866p01 |
| Wheel/Tyre | 62 | 0 | 112 | 11140, 2344, 243c02, 2686 |
| Bar/Clip | 49 | 0 | 59 | 11055, 11055p30, 11100, 115551 |
| Hose | 47 | 0 | 47 | 14301k02, 22678, 23221, 23221k01 |
| Tile | 47 | 0 | 53 | 2376, 2609b, 2609bc01, 2609c |
| Vehicle | 42 | 0 | 43 | 10042, 13756, 15709, 21709a |
| Hinge | 39 | 0 | 39 | 14418, 14704, 16686, 21709 |
| Window | 36 | 0 | 36 | 31022, 4809, 90265, u8016 |
| Door | 26 | 0 | 26 | 15582, 18816, 2294, 27382 |
| Constraction Accessory | 17 | 0 | 27 | 11305, 18588, 2601, 3627 |
| Plate | 15 | 0 | 18 | 10092, 10134, 2863, 2864c01 |
| Train | 14 | 0 | 17 | 13359, 13359p01, 35962, 35962p01 |
| Minifig Hipwear | 11 | 0 | 11 | 14295c01, 16820c01, 18200c01, 27145 |
| Plant | 8 | 0 | 8 | 2297, 2298, 30131, 30338 |
| Container | 6 | 0 | 8 | 18742, 449, 4882, 4891 |
| Crane | 5 | 0 | 6 | 15449, 15450, 21996, 4663 |
| Figure | 5 | 0 | 7 | 10124, 10154, 2715, u9200 |
| Animal | 3 | 0 | 3 | 1410, 15107, 57798 |
| Bar | 3 | 0 | 3 | 35649, 3917, 7052 |
| Constraction | 3 | 0 | 6 | 15362, 32559, 54272 |
| Sphere | 3 | 0 | 3 | 22119, 86500p01, 86500p02 |
| Turntable | 3 | 0 | 7 | 4842, 4875, 92005 |
| Car | 2 | 0 | 2 | 85543-f4, 85543-f5 |
| Cone | 2 | 0 | 3 | 4378a, 4378b |
| Dish | 2 | 0 | 2 | 27372, 31333 |
| Fence | 2 | 0 | 3 | 12602, 2214 |
| Propeller | 2 | 0 | 2 | 15211, t1111 |
| Slope | 2 | 0 | 6 | 29303, 70683 |
| Staircase | 2 | 0 | 12 | 27976, 28387 |
| Support | 2 | 0 | 5 | 4375, 4537 |
| Windscreen | 2 | 0 | 2 | 5241, 8009 |
| Antenna | 1 | 0 | 1 | 51708 |
| Belville | 1 | 0 | 1 | 33160 |
| Boat | 1 | 0 | 1 | 4788 |
| Minifig Footwear | 1 | 0 | 1 | 15447 |
| Minifig Leg | 1 | 0 | 1 | 105181 |
| Plane | 1 | 0 | 1 | 4869 |
| Screw | 1 | 0 | 1 | u9389 |
| Sticker | 1 | 0 | 1 | 4150c07 |
| Tap | 1 | 0 | 1 | 15327 |
| Tyre | 1 | 0 | 1 | 6292 |
| Winch | 1 | 0 | 1 | 761 |

## Inheritance gaps by primitive responsible

A part can appear under more than one primitive when several classes are deficient. “Usage-weighted missing” is missing snaps multiplied by local usage (at least 1), a rough priority signal.

| Primitive family | Id | Parts | Missing snaps | Usage-weighted missing | Example parts |
| --- | --- | --- | --- | --- | --- |
| peg hole (peghole/npeghol) | peghole | 109 | 1111 | 1111 | 10124, 10154, 11025, 11025p01 |
| stud | stud | 352 | 621 | 628 | 85984, 10354, 10354c01, 10355 |
| axle hole | axle-hole | 113 | 474 | 474 | 4588, 10124, 10152, 10154 |
| Technic pin | pin | 28 | 168 | 168 | 2894c01, 10042, 100943, 100943p01 |
| axle | axle | 62 | 82 | 82 | 11214, 11305, 11641, 15107 |
| Technic connector hole | conn-hole | 8 | 58 | 58 | 15458, 15458d01, 15458d02, 15458d03 |
| clip | clip | 18 | 34 | 34 | 11055, 11055d02, 11055d03, 11055d04 |
| hinge finger | hinge | 30 | 30 | 30 | 13358, 13359, 13359p01, 15449 |
| joint / generic | joint | 7 | 7 | 7 | 14418, 14704, 23922, 23922c01 |
| anti-stud / stud4 | antistud | 1 | 1 | 1 | 93563 |

## Sanity checks (hand-reviewed)

These parts span the buckets and the requested spot-check list (brick, plate, pin, beam, rim, tyres, shortcut, moved part, printed torso, hose, sticker, baseplate, tile). “Expected / effective” is total snaps; the verdict compares the rule's status with the hand expectation.

| Part | Title | Category | Bucket | Status | Hand expectation | Expected / effective | Missing | Verdict | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3001 | Brick 2 x 4 |  | covered | covered | covered | 8 / 16 | — | OK | 2x4 brick: 8 top studs and 8 underside receptacles inherited from s/3001s01. |
| 3023b | Plate 1 x 2 |  | covered | covered | covered | 3 / 5 | — | OK | 1x2 plate: stud3 + two studs via stug-1x2; 2 underside receptacles from s/3023bs01. |
| 3673 | Technic Pin |  | covered | covered | covered | 2 / 2 | — | OK | Technic pin: SNAP_CLEAR drops two inherited connect snaps; one long M + one F consolidate them. |
| 32316 | Technic Beam 5 |  | covered | covered | covered | 5 / 7 | — | OK | Technic beam 5: four beamhole snaps + connhole + own SNAP_INCL. |
| 6558 | Technic Pin Long with Friction and Slot |  | covered | covered | covered | 1 / 2 | — | OK | Long friction pin: SNAP_CLEAR + consolidated M/F; pin tolerance accepts it. |
| 42610 | Wheel Rim 8 x 11.2 with Centre Groove |  | covered | covered | covered | 0 / 2 | — | OK | Wheel rim: shadow F hole; supplementary adds measured M seat. |
| 51011 | Tyre 6.4/ 75 x 8 Shallow Offset Tread |  | covered | covered | covered | 0 / 1 | — | OK | Tyre: no shadow; supplementary F seat makes it covered (geometry-only without supplement). |
| 61254 | Tyre 7/ 45 x 17 Offset Tread with Middle Band |  | covered | covered | covered | 0 / 1 | — | OK | Large tyre: no shadow; supplementary F seat makes it covered (geometry-only without supplement). |
| 13971 | Wheel Rim 8 x 18 with Deep Centre Groove, Deep Spokes and Peghole |  | covered | covered | covered | 1 / 2 | — | OK | Wheel rim: shadow connhole F; supplementary adds measured M seat. |
| 6014c01 | ~Moved to 6014bc01 |  | redirect/alias | inheritance gap | inheritance gap | 1 / 0 | cyl F 0/1 | OK | ~Moved to shortcut 6014bc01; target exposes an axle-hole primitive but has no shadow, so the redirect inherits an inheritance-gap status. |
| 6014bc01 | Wheel Rim 12 x 11 with Notched Hole with Tyre 12/ 40 x 11 Wide |  | redirect/alias | inheritance gap | inheritance gap | 1 / 0 | cyl F 0/1 | OK | Wheel assembly shortcut: 6014b contains wpinhol2.dat (axle hole) but no shadow data covers it. |
| 10 | ~Moved to 10a |  | redirect/alias | covered | covered | 764 / 764 | — | OK | ~Moved to 10a; target baseplate has full stud coverage. |
| 973p34 | Minifig Torso with Open Jacket over Striped Vest Pattern |  | covered | covered | covered | 0 / 5 | — | OK | Printed minifig torso: printed suffix, but inherits the base torso subpart s/973s01. |
| 973 | Minifig Torso |  | covered | covered | covered | 0 / 5 | — | OK | Minifig torso base: 4 F + 1 M inherited from s/973s01. |
| 3811 | Baseplate 32 x 32 |  | covered | covered | covered | 1024 / 1024 | — | OK | 32x32 baseplate: 1024 stud.dat instances -> 1024 M snaps. |
| 3069b | Tile 1 x 2 with Groove |  | covered | covered | covered | 0 / 2 | — | OK | 1x2 tile: two F underside receptacles from s/3069bs01. |
| 22678 | Technic Ribbed Hose 31L | Hose | geometry-only gap | geometry-only gap | geometry-only gap | 0 / 0 | no effective snaps | OK | 31L ribbed hose: no shadow and no connector primitives; hand-modelled flexible part. |
| 10202d01 | Tile 6 x 6 with Dark Bluish Grey Line and Light Bluish Grey Open Rectangle Right Panel Sticker | Sticker Shortcut | redirect/alias | covered | covered | 0 / 36 | — | OK | Sticker shortcut keeps the base 6x6 tile underside: 36 F snaps from s/10202s01; the sticker itself adds no connectors. |

## Next 10 data-fill tasks

Ranked by usage-weighted expected gain. Primitive-family tasks benefit every part that references that primitive; geometry tasks group parts that need hand modelling. “Upstream” says whether the work belongs in the LDCad Shadow Library (CC BY-SA 4.0) or is app-specific.

| # | Task | Parts | Missing/assumed | Usage-weighted | Examples | Upstream suitability |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Add/repair peg hole (peghole/npeghol) connectors (primitive family "peghole") | 109 | 1111 | 1111 | 10124, 10154, 11025, 11025p01 | yes — directly useful to the LDCad Shadow Library |
| 2 | Add/repair stud connectors (primitive family "stud") | 352 | 621 | 628 | 85984, 10354, 10354c01, 10355 | yes — directly useful to the LDCad Shadow Library |
| 3 | Add/repair axle hole connectors (primitive family "axle-hole") | 113 | 474 | 474 | 4588, 10124, 10152, 10154 | yes — directly useful to the LDCad Shadow Library |
| 4 | Add/repair Technic pin connectors (primitive family "pin") | 28 | 168 | 168 | 2894c01, 10042, 100943, 100943p01 | yes — directly useful to the LDCad Shadow Library |
| 5 | Promote the app-measured tyre/rim seat connectors into shadow data | 100 | 100 | 127 | 11209, 11957, 15413, 18450, 1872, 18977 | not ready — app-specific measured fallback; propose SNAP_GEN/SNAP_CYL upstream after review |
| 6 | Add/repair axle connectors (primitive family "axle") | 62 | 82 | 82 | 11214, 11305, 11641, 15107 | yes — directly useful to the LDCad Shadow Library |
| 7 | Add/repair Technic connector hole connectors (primitive family "conn-hole") | 8 | 58 | 58 | 15458, 15458d01, 15458d02, 15458d03 | yes — directly useful to the LDCad Shadow Library |
| 8 | Add/repair clip connectors (primitive family "clip") | 18 | 34 | 34 | 11055, 11055d02, 11055d03, 11055d04 | yes — directly useful to the LDCad Shadow Library |
| 9 | Add/repair hinge finger connectors (primitive family "hinge") | 30 | 30 | 30 | 13358, 13359, 13359p01, 15449 | yes — directly useful to the LDCad Shadow Library |
| 10 | Add/repair joint / generic connectors (primitive family "joint") | 7 | 7 | 7 | 14418, 14704, 23922, 23922c01 | yes — directly useful to the LDCad Shadow Library |

## Uncertainties and limitations

- The local corpus is small and skewed to 31039 variants. Treat the ordering as a directional signal only until re-run against OMR.
- Expected counts are a model of the shadow library's own primitive annotations, not ground truth for every physical joint. Tolerance values are documented and deliberately conservative; parts near a threshold are marked “REVIEW” in the sanity table if hand inspection disagrees.
- `SNAP_CLEAR` can be intentional consolidation (for example `3673` and `6558`). The 50% pin tolerance accepts those; a part with a genuinely missing pin class can still fall below it.
- The connection-primitive seed covers the currently annotated upstream primitives plus obvious official variants. A primitive that is both unannotated and absent from the seed will show as geometry-only or unknown rather than inheritance gap.
- Embedded part copies are mapped by name pattern only when the extracted id is an official top-level part; geometry equality is not re-verified here (the app does that separately).
- Upstream check: `9b1131fb1991f8c0bfc072325e4e12f6271aba35` (same as checkout). Re-run the script to refresh.

## Outputs

- `docs/diagnostics/shadow-gaps/parts.csv` — one row per official top-level part with metadata, buckets, expected/effective class counts, primitive evidence, provenance and usage.
- `docs/diagnostics/shadow-gaps/usage.csv` — canonical part id, usage instances/models and classification.
- `docs/diagnostics/shadow-gaps/summary.json` — machine-readable versions, totals, top gaps, family/primitive groups, tasks and sanity checks.
