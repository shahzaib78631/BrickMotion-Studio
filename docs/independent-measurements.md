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
