# Independent measurement plan

Scope: measure our own replacement data first. Keep the existing application,
integrations, imported tables and branding unchanged until a later migration.

The target is equivalent useful information, not identical numbers from another
renderer or connector database. CAD dimensions, physical fit and image appearance
are different measurements and must have separate evidence.

## Required outcome: full connector coverage

The prototype below is discovery tooling, **not completion of this requirement**.
Processing every file, matching the 194 web fallback snaps, or finding at least one
connector per part cannot be used as a coverage claim. The target includes every
connection site and both mating halves, in both the web and native engines.

Freeze a versioned inventory of the entire supported part library, including
assemblies, variants, mirrored parts and embedded copies. A future or unknown
custom part cannot silently inherit a claim made for that inventory. Every part
must have either a reviewed complete connector set or an explicit reviewed
no-connectors result. An unresolved part blocks a full-coverage release.

Required families include studs and anti-studs (top, underside, recessed and
side-facing), hollow studs and bar sockets, pins and pin holes, keyed axles and
axle holes, bars and clips, finger/friction/click hinges, balls and cups, wheel
and tyre interfaces, turntables, rails/sliders, articulated/CV joints and special
accessory interfaces. Gears, racks, worms and actuator motion constraints must
also be represented where they participate in the app's mechanism graph.

For each site record a full local frame, connector family, mating role,
cross-section profile, dimensions, opening/access directions, insertion depth,
compatible partner classes, motion freedoms and limits, and evidence. Record
friction/detents as unknown until measured; do not guess them from geometry.

Use three complementary production methods:

1. **Primitive and parametric recognition:** compose local transforms through the
   part hierarchy to recover repeated connectors, grids and keyed profiles.
2. **Mesh analysis:** find arbitrary-axis cylinders, cavities, spheres, grooves
   and open boundaries; compare full profiles, including recessed openings and
   retaining lips. Validate accessibility with insertion sweeps.
3. **Independent reviewed measurement:** author per-part records for every
   unresolved interface using CAD sections and physical fit tests where needed.
   Automation failure goes into this queue; it never removes a part from scope.

The existing database may be used as a comparison oracle to identify omissions,
but replacement coordinates and compatibility rules need independent evidence.
The native importer covers more families than the web fallback table and itself
skips unknown record types; neither importer alone defines complete ground truth.
Review the part geometry and physical mating behaviour for connections missing
from both importers as well.

The release gate is **100% reviewed parts and connection sites in the frozen
inventory, zero unresolved cases, and all required mating/motion fixtures passing
in both engines**. Also test incompatible mates, reversed insertion, mirrored
frames, collisions and joint limits. Report per-family recall and false-positive
counts against independently reviewed annotations. Set measurement tolerances
before validation; file-loading success is never a substitute for this gate.

This requires a finite measured library plus a manual completion process. A
geometry heuristic alone cannot guarantee full coverage or recover physical
friction and deformation. Removal remains deferred until that gate is met.

## What we can produce

| Data | Our measurement method | What this does not establish |
| --- | --- | --- |
| Part dimensions, collision surfaces | Flatten a separately verified LDraw library; measure bounds and transformed triangles | Moulding tolerances, deformation or material strength |
| Studs and sockets | Recognize primitives; fit cylinders and cavity profiles in each local frame; record centre, axis, radius, depth and openings | A circular hole alone does not prove a compatible connection |
| Pins, axles, bars, clips, hinges, balls | Fit cross-sections and surfaces; distinguish solid/void and keyed/round profiles; identify motion axes | Friction, clutch force, detents and allowed assembly paths |
| Gears, racks, worms | Detect periodic geometry and estimate tooth count, pitch, axis and handedness | Reliable meshing until tested with a compatible mate |
| Tyres and rims | Sample the complete radial profile along the axle; compare bead and groove sections | Matching maximum radii alone do not establish a fit |
| Joint behaviour | Test physical pairs; measure insertion travel/force, angular range and rotation torque | Geometry cannot supply these values reliably |
| Colour | Measure physical samples under a documented illuminant; ideally retain spectral reflectance, otherwise calibrated RAW observations | A screenshot or display hex is not material reflectance |
| Surface appearance | Photograph physical coupons under measured light and camera poses; fit roughness/specular parameters using our renderer | A fitted roughness value depends on the chosen shading model |
| Transparent plastic | Measure transmission through known thicknesses, with a neutral reference; fit absorption separately from surface reflection | A tinted surface swatch does not measure volume absorption or IOR |
| Lighting | Author our own area-light rigs or capture our own exposure-bracketed environment | Reproducing a branded reference scene is unnecessary |

## Working geometry prototype

### Whole-library coverage work (current)

The user has authorized independent reference datasets in addition to our own
measurements. The reference source was fetched independently from
`https://github.com/RolandMelkert/LDCadShadowLibrary` at commit
`9b1131fb1991f8c0bfc072325e4e12f6271aba35`; its attribution is retained in the
measurement manifest. The reference lookup bypasses the application's local
shadow patches, so the source hash describes exactly the metadata used.

Current frozen inventory: **35,575 parts**. The full export contains **430,077
reference connector records on 24,858 parts**, with **160,307 explicitly open
female entrances**. All records have matching full-frame definitions; the
structural audit found no count mismatches, non-unit axes or invalid dimensions.
Full matrices preserve keyed roll, mirroring and scale. These checks do not prove
physical mating validity or complete coverage of each part.

All **10,717 parts without reference connectors** have been scanned geometrically:
5,342 have stud/cylinder/sphere candidates, 5,369 have no detected connector
features, four have incomplete geometry, and two have reviewed obsolete empty
representations. Absence of detected features
is not a reviewed no-connectors assertion. **Validated coverage remains unclaimed.**

The measurement interpreter (`independent-shadow-v2`) propagates included clear
rules, supplies clip defaults, preserves mirror/scale modifiers, and applies
inheritance restrictions before placement. It exposes both explicit A/B socket
cap directions. Finger sequences without an explicit center flag are centered,
consistent with the native parser and the 3937/3938 hinge geometry; this default
is not unambiguously specified by the reference documentation. The 2780 pin now
has two reference interfaces rather than duplicate primitive half-pins. Both
3937/3938 hinge profiles run from `[-20,10,0]` to `[20,10,0]`.

The rebuild records 5,977 scale-policy exclusions, 1,149 mirror-policy exclusions,
8,947 nonorthogonal-frame exclusions and 9 axial-only-policy exclusions across
part instances. These are retained for review, not silently counted as absent
physical connectors. Rounded or distorted CAD frames may require a measured
error bound before accepting their inherited connector information. Interpretation
follows the [source metadata specification](https://www.melkert.net/LDCad/tech/meta)
where specified; existing app interpretation remains unchanged.

Measurement-only resolution now records high-resolution primitive substitutions
and the exact-basename formed-sticker subfile lookup. This reduced missing-file
inventory cases from 54 to 3: `4603014b`, `60616ad01`, and `bl_26603`. The first
two reference `s/4603014bs01.dat`, which is also listed as missing by the
[upstream part record](https://library.ldraw.org/parts/46828). The custom tile's
missing subfile is not silently replaced with a differently framed tile mesh.

Reproducible commands (all output remains separate from application data):

```sh
npx tsx scripts/connector-coverage.ts
npx tsx scripts/measure-reference-library.ts public/ldraw .cache/measurements/independent-shadow.json
npx tsx scripts/queue-unreferenced-parts.ts
npx tsx scripts/measure-independent.ts --part-list .cache/measurements/unreferenced-ids.json --connectors-only --jsonl --out .cache/measurements/unreferenced-geometry.jsonl
npx tsx scripts/audit-connector-coverage.ts
npx tsx scripts/validate-independent-mates.ts
```

The current work queues are in `.cache/measurements/coverage-audit.json`.
The reference export is `.cache/measurements/reference-library.jsonl`, accompanied
by its source/license/hash manifest. Geometry-only measurements are streamed to
JSONL to avoid retaining the entire library in memory. `--connectors-only`
explicitly marks mechanical-feature measurement as skipped, rather than returning
empty gear/actuator lists as if they had been measured.

The next work is to validate and classify the geometry-only candidates, review
the no-evidence queue, address empty/missing inputs, and establish mating tests.
No runtime data or integrations have been removed or replaced.

### Accessory insertions: katana and shaped holders

`npx tsx scripts/measure-accessory-insertions.ts` produces independent accessory
measurement data without changing the application's connector tables. The compact
snapshot is `docs/data/accessory-connection-measurements.json`.

The shared blade subfile used at the identity frame by 30173a, 30173b and 21459
has an 80 LDU (32 mm) axial span and bounds `[-1.875,-98,-4]` to
`[1.875,-18,12.375]`. Eighty transverse sections retain the changing blade
envelope rather than substituting a cylinder. Guard and grip differences remain
separate: shared blade geometry does not prove whole-part compatibility.

Three host section sets cover both documented 19141 sword poses and the 30177
pose. Each includes actual host section segments and distances to walls in four
transverse directions from the blade-envelope center. These measurements do not
yet establish a connected cavity, mouth plane or usable insertion depth. The
second 19141 pose is a reflection; its CAD sections are measured, but it is
excluded from rigid insertion tests.

Six whole-part candidate placements (three sword variants, two proper host poses)
were tested for triangle-surface intersections at 61 withdrawal offsets, every
2 LDU from 0 to 120 LDU. All six report intersections at their seated position
and along part of the straight path. Therefore none is certified as a valid
insertion. Contact, source-pose rounding, outdated geometry and an unsuitable
straight path need separate investigation; do not suppress these results or
turn the sweep distance into an insertion-depth claim.

The same run extracts 1,837 exact documented placement examples across the part
library, including 36 reflections. These include assembly examples as well as
accessories, and are not 1,837 validated connectors. Nonliteral HELP annotations
remain in an explicit review queue. In particular, 98132's two katana poses omit
an exact sword ID; 95348 explicitly documents a 2530 cutlass, not a katana.

Detailed artifacts are `.cache/measurements/accessory-insertions.json` and
`.cache/measurements/independent-placement-references.json`. Source hashes,
authorship/license headers, units, pose provenance and validation limitations
are retained in the compact snapshot. Existing runtime placement helpers already
use a small curated set of HELP poses; this measurement work extends evidence
collection without changing those helpers or claiming new physical compatibility.

### Assembly evidence beyond the shadow library

`scripts/measure-assembly-use-cases.ts` scans the [LDraw Official Model Repository](https://library.ldraw.org/omr)
cache and checks the CAD placements listed in `docs/data/assembly-use-case-targets.json`.
Run it against the corpus using its download manifest, then compare the result with the
[BrickNet catalogue](https://github.com/kulits/BrickNet/blob/master/DATA.md).

```sh
npx tsx scripts/measure-assembly-use-cases.ts /path/to/omr/models
python3 scripts/compare-assembly-reference-labels.py
```

The scan read 1,836 model files. It found 4,861 candidate relative poses across
1,332 part pairs, with 11,448 model observations. Each observation preserves the
source URL, model hash, instance paths, and unrounded relative pose. A separate
queue identifies 439 parts from priority families, including 160 with zero shadow
records. The web matcher found no mate using the independent shadow records at
22 of the selected CAD placements and at 3,550 model candidate poses. The nearest
surface filter admits incidental neighbors and ordinary snaps, so those model
poses require review before they count as missing connections.
It also misses some distant origins, embedded variants, and nonrigid placements.
The full report and queue are in `.cache/measurements/assembly-use-cases.json`.

The compact snapshot, `docs/data/assembly-use-case-measurements.json`, includes
27 inspected CAD placements and the 17 model poses for specifically named pairs.
It includes drawer slides, cupboard doors, pet flaps, tyre seats, accessory bars,
scabbards and stretcher mounts. The `8011` holder and both `98132` shoulder armour
slots have seated katana candidates with no triangle-surface intersection at the
tested pose. Straight probes still intersect the holder. The `98132` CAD notes
state the poses and leave the mould unspecified, so the three tested variants
are recorded as hypotheses. [LEGO's Jay ZX leaflet, page 1](https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6012765.pdf#page=1)
shows the armour and a separate katana and supplies visual co-listing evidence.

The BrickNet cross-check found 3,389 labels across 987 exact-ID frozen parts
with zero shadow connectors. Comparing the catalogue's CAD snapshot to the
frozen library established identical oriented geometry and coordinate frames
for 927 parts, with 3,126 labels. The other 60 need revision review, including
29 with identical bounds and different surface signatures. The matched rows
are exported to `.cache/measurements/assembly-geometry-matched-labels.json`.
The cross-check also found complementary label
groups with coincident origins for seven CAD placements, including `2656/2657`
cupboard doors, `79730/4533` pet flaps and the `23799` tyre on three rims.
The tyre examples also include measured rim outer radii and tyre inner radii
in planes 1 LDU apart. The radial extrema give the size of each envelope.
Orientation, local clearance, material compliance and physical travel require
further evidence.

`scripts/verify-reference-label-geometry.ts` compares the supplemental queue
against the [BrickNet CAD snapshot](https://keeper.mpdl.mpg.de/seafhttp/f/9b4a3c04e88940d1a718/?op=view).
Pass the extracted `ldraw` directory and original archive to record its hash.
The comparison requires identical oriented triangles in the same coordinates.
The coverage audit lists the matched records, documented placements, targeted
model observations and mechanical references in its supplemental evidence queues.

`scripts/index-mechanical-reference.ts` indexes the pinned
[Kinebrick authored corrections](https://github.com/erik-larsen/kinebrick/blob/82176b455d82b9d59ecba68cb54ad2121b72e457/data/corrections.ldr).
It found 209 rules and measurements on 133 frozen parts. The local
`.cache/measurements/mechanical-reference-candidates.json` retains the source
hash, licence attribution and parameters for cylinder profiles, gears, racks,
shift positions, shock travel and shaped grooves. The authored `3145` tipper end
grooves have additional assembly evidence from the
[8848 OMR model](https://library.ldraw.org/media/omr_models/1499/8848-1.mpd).
Four observed `3145/3029` poses include two-direction CAD surface probes.
The general mesh detector agrees with 32 of 36 reference gear entries on tooth
count and pitch radius within 0.5 LDU. Separate radial sections show four repeats
on `32072` and 56 repeats on each of `2855` and `48168`, which verifies the
repeat count for three entries the general detector misses. Those three pitch
radii remain reference values. The `27938` worm's mesh estimate is 0.57 LDU above
the reference pitch radius and stays in the review queue.

### Exported-profile mating regressions

`scripts/validate-independent-mates.ts` selects the actual exported 2780/3700
pin/hole and 3937/3938 finger-hinge profiles, including full-frame roll, and runs
them through the existing native mating solver in an isolated executable. All
**eight fixtures pass in both operand orders**: both pin-hole entrances accept
the seated pin; the collar inside the bore and an off-axis pin are rejected;
complementary hinge fingers rotate without sliding; two bases, separated fingers,
and crossed axes are rejected. The report stores reference attribution, source-row
hashes, generated fixture hash and solver-source hashes in
`.cache/measurements/mating-regressions.json`.

This checks interpreter-to-solver consistency for four actual parts. It does not
check mesh collisions, insertion sweeps, physical tolerances, other connector
families or the web engine, and does not promote any part to complete coverage.

### Geometry-equivalent reference transfer

`scripts/index-independent-geometry.ts` indexes the complete inventory using
strict oriented triangle multisets. The signature ignores only colour, triangle
record order and cyclic vertex order. It retains every coordinate without
rounding, winding, sidedness and duplicate surfaces. Translation, reflection,
different holes and merely matching bounds do not pass. This conservative
method can miss equivalent meshes with different tessellation; it must not
silently replace strict identity with a looser match.

`scripts/find-independent-equivalents.ts` looks for unreferenced parts with the
same signature as a reference-covered part. It compares complete resolved
connector definitions, including mating groups, profiles and keyed roll, across
all donors. Conflicting donors are queued for review instead of selecting one.
Even a conflict-free match remains a reference-transfer candidate, not proof
that the donor's connector set is complete or that physical materials match.

The completed strict index contains 35,566 usable signatures and 9 unresolved
entries. It found 18 conflict-free reference-transfer candidates and 2 matches
with conflicting donor definitions. Candidate connectors, full frames and
provenance are exported to `.cache/measurements/equivalent-connectors.json`;
the detailed donor report is `equivalent-references.json`. The conflicting
targets are `11459p02` and `bl_11251pb01`; neither receives an automatic donor.
`60616ad01`, `6637a` and `6637d` have reference metadata but incomplete/empty
geometry, so they cannot supply a geometry-verified transfer. In particular,
6637a/d are obsolete empty files with stale reference connectors, confirming why
metadata presence alone cannot count as complete validated coverage.

Two entries, `6637b` and `6637c`, have been reviewed as intentionally empty
obsolete files. Their headers explicitly say obsolete and their only subfile is
`empty.dat`. The review in `docs/data/independent-connector-reviews.json` is tied
to the exact complete source closure. A changed hash, missing dependency,
truncated hierarchy or nonempty geometry invalidates that review. They remain
in the inventory. This reduces the unresolved empty/incomplete geometry queue
from six to four without inventing connectors or excluding supported entries.

Run from the repository root:

```sh
# Representative bricks, pins, gears and wheels (11 parts)
npx tsx scripts/measure-independent.ts

# Specific parts from a separately sourced library
npx tsx scripts/measure-independent.ts --ldraw /absolute/path/to/ldraw 3001 4070 4143

# Whole library; can take substantially longer
npx tsx scripts/measure-independent.ts --ldraw /absolute/path/to/ldraw --all --out .cache/measurements/all.json
```

The tool calls the geometry parser/flattener directly. It does not call
`PartLibrary`, read the shadow pack, use imported connectors, use saved function
tables, or access material tables. It reuses our existing geometry feature
detectors. It deliberately omits the actuator helper because that helper includes
an externally sourced screw-lead constant.

Every result records source-file SHA-256 hashes, LDU coordinates, bounds, ordinary
studs, and candidate teeth/bores/seats/rods. Missing dependencies, cycles, excess
nesting, empty geometry and non-finite measurements produce unresolved results,
not partial measurements presented as complete. Exit code 2 means the report was
written but contains unresolved parts.

The current local library may contain previously synchronized parts. Hashes prove
which files were measured, not their origin. Before publishing replacement data,
repeat this against a separately obtained, version-pinned official library and
record its download origin, archive hash and required attribution. This prototype
is independent of the imported measurement tables, not a certification of every
input file's provenance.

## Initial results — 2026-11-18

### Implementation progress

The primitive extractor now composes complete local frames through the reference
hierarchy and recognizes open side studs (`stud2a.dat`). It records full circular
cylinder surfaces, including short cavities, independently of the old long-bore
heuristic. Non-circular, sheared and degenerate frames are explicitly rejected.
Every measurement remains `connectorCoverage: unreviewed` until its complete
connection set is validated.

Verified on the local library: 4070 now includes the recessed stud from
`[0,10,-6]` to `[0,10,-10]`; 87087 includes its side stud from `[0,10,-10]`
to `[0,10,-14]`; 3700 includes an inner radius-6 cylinder from `[0,10,8]`
to `[0,10,-8]`. The latter is a cavity observation, not yet a certified pin
interface: opening geometry, shoulders and insertion access still need review.
The original results below describe the earlier baseline.

The web library audit examined 2,245 IDs in the existing imported connector table.
All resolved locally. With the currently installed shadow pack and supplementary
metadata, 2,102 added no imported fallback snaps; 143 still added 194 fallback
snaps. This counts current fallback usage, not independently measured coverage or
native-engine parity. Four missing sub-file warnings also occurred in that audit.

The geometry-only run completed on all 11 representative parts and all 143 parts
using fallbacks. “Completed” means valid geometric output, not all connectors
recovered. Among the 143, 79 had detected ordinary studs, 3 had toothed candidates,
2 had bore candidates, 19 had seat candidates and 22 had rod candidates. These
groups overlap and do not measure recall against the imported connections.

Concrete measurements from the representative run:

| Part | Geometry-derived result |
| --- | --- |
| 3001 | Body bounds `[-40,0,-20]` to `[40,24,20]`; eight studs, radius 6 and height 4 LDU |
| 4143 | 14-tooth bevel candidate; axis `[0,0,1]`, estimated pitch radius 17.5 LDU |
| 3743 | Rack candidate; 10 detected teeth over an 80 LDU length |
| 42610 / 51011 | Both expose radius-14 seat candidates; full mating profile still needs validation |
| 4070 | Only the ordinary top stud is detected; recessed side stud and rear socket remain a gap |
| 3700 | Studs are detected, but the short pin hole is not returned by the existing long-bore detector |

Local reports are `.cache/measurements/geometry.json` and
`.cache/measurements/fallback-parts.json`. The baseline dependency counts and part
IDs are in `.cache/independence/baseline.json`. These reports are not loaded by the
application.

## Next measurement work

1. **Complete connector geometry.** Start with 4070 and 87087 for recessed/side
   studs, 3700 and 2780 for short pin interfaces, then brackets, clips and hinges.
   Fit surfaces in arbitrary local axes instead of only axes through the part
   origin. Record mouth position, cross-section, free depth, insertion direction,
   and uncertainty. Do not infer underside sockets from a bounding rectangle.
2. **Validate assembled pairs.** Maintain positive and negative pair fixtures.
   Check axis/shape agreement, occupied volume, insertion sweep and permitted
   motion. A candidate becomes a certified connector only after those checks;
   collision checking stays authoritative.
3. **Measure physical fit separately.** Use several specimens per selected part
   and repeat each measurement. Record instrument resolution, specimen identity,
   wear, measurement direction and repeatability. Measure actuator travel per
   counted turn directly. Retain intervals and raw readings, not just averages.
4. **Capture a small material set.** Begin with opaque red/white/black, clear and
   coloured transparent plastic, and rubber. Lock exposure and white balance,
   capture RAW with a neutral/colour reference, record lamp geometry, and keep
   diffuse colour and specular measurements separate. Fit parameters jointly
   across views; reserve additional lighting/view angles for validation. Use
   measured transmission at multiple thicknesses for transparent samples.
5. **Create a versioned measurement registry.** Store part/colour ID, method,
   source hashes or specimen ID, coordinate system, units, raw evidence,
   uncertainty, algorithm version, reviewer and status (`candidate`, `validated`,
   `rejected`). CAD-derived and physically measured rows must remain distinct.
6. **Gate the later migration.** Require connector precision/recall on reviewed
   fixtures, no new collisions, bounded position/axis errors, and acceptable
   material error on held-out captures. Set thresholds before fitting. Report
   unsupported families explicitly. Only then replace application data and remove
   integrations and mentions in a separate change.

No physical measurements, material calibration or replacement-parity claims have
been made by this prototype. Existing app behaviour is unchanged.
