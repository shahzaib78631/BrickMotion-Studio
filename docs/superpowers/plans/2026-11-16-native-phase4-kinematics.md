# Native Rewrite Phase 4 (Kinematics, Mechanisms, Stability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Say how a model can move — its degrees of freedom, which pieces each one moves, and the exact ratio between any two shafts — by solving its joints, not by matching patterns; drive any freedom to a pose; and say whether a model or a build step stands up.

**Architecture:** A new `bm::kin` module on top of the connection graph and collision. Gear teeth become couplings between pieces; joints that cannot really move (two pins through two beams, a bushed axle that cannot slide) are merged away until only bodies that can move remain; the freedoms are the null space of the constraint Jacobian of what is left. Driving one freedom is Newton iteration on the same constraints. Limits and shift states come from collision: a joint's travel ends where pieces touch, and a sliding ring that ends its travel meshed into a gear is locked to it. A separate `bm::stable` module checks a set of placed pieces for tipping, load paths and connection strength.

**Tech Stack:** as before (C++20, Catch2, nlohmann/json). No new third-party code: the dense algebra and the small linear program are written here.

**Spec:** `docs/superpowers/specs/2026-11-15-native-rewrite-design.md` ("4. Kinematics, mechanisms, physics", "Proving it"). Hand-checked cases: `benchmarks/mechanisms/{5590,8880,42000}.expected.json` (format in `benchmarks/mechanisms/README.md`).

## Global Constraints

- Solver, not classifier: whether something moves is decided only by joints, couplings and collision. Names (gearbox, differential) are labels added afterwards and never change the answer.
- No per-set or per-part special cases in code. Per-part *data* (tooth counts, a connector a source lacks) lives in `native/data/*.json` with its origin stated.
- Tolerances are named constants in `kin/tolerances.h` and `stable/tolerances.h`, in LDU or radians, each with a comment saying why that value.
- Gear ratios are exact: a ratio is a quotient of tooth counts carried as a rational, never measured from a simulated pose.
- `bmcore` stays free of Apple headers; `-Wall -Wextra -Werror`; thread-safe (no shared mutable state in a solve).
- Never hangs and never throws on a model: anything too large or degenerate is reported as not solved, with the reason.
- Commit per task on `feat/native-engine`; stage only `native/`, `docs/superpowers/plans/2026-11-16-native-phase4-kinematics.md` and the files a task names. The other uncommitted work in the tree is not ours.

## Review Focus

1. Two beams joined by two pins, where every pin joint by itself may turn and slide: the beams are one body, zero freedoms between them.
2. A shaft through two holes whose axes differ by the rounding of the file (up to 2.5°, 1 LDU): it still turns. Near-coincident axes are snapped to one line before any rank is taken.
3. An empty model, one piece, or a model with no moving joint: zero freedoms, no crash, in microseconds.
4. A gear train closed on itself with ratios that disagree (a locked train): reported as locked (zero freedoms for those shafts), not given a ratio.
5. A 12,000-piece model that is almost all fixed joints: solved in seconds, because bodies are merged before any dense algebra; a moving core over `kMaxSolveBodies` is reported as not solved, not attempted.

---

### Task 1: Gear teeth and gear meshes

**Files:** Create `native/tools/gears_from_part_functions.py`, `native/data/gears.json`, `native/core/include/bm/kin/tolerances.h`, `native/core/include/bm/kin/gears.h`, `native/core/src/kin/gears.cpp`; Test `native/tests/kin_gears_test.cpp`.

`gears.json` is the `teeth` lists of `public/data/part-functions.json` (163 parts, measured from the part meshes by `scripts/measure-part-functions.ts`), written by the Python script as `{"source": ..., "parts": {"3648": [{kind, teeth, axis, centre, pitchRadius, width, facing?, tip?, tips?, length?, face?, lead?}]}}`. A part name with a letter suffix or `cNN` assembly suffix uses its base number's row when it has none of its own (`3648a` → `3648`).

**Interfaces — produces:**
```cpp
namespace bm::kin {
enum class ToothKind : uint8_t { Spur, Bevel, DoubleBevel, Worm, Rack };
struct Toothed {                 // one ring of teeth, in part space (then model space once placed)
  ToothKind kind; int teeth; Vec3 axis, centre; double pitchRadius, width;
  Vec3 facing, tip, tips[2];     // bevel: the side its teeth face and the cone apex; double bevel: both apexes
  double length = 0; Vec3 face;  // rack: its length along `axis`, and the direction its teeth point
  double lead = 0;               // worm: travel per turn
};
class GearDb {                   // read-only after load; thread-safe
 public:
  size_t load(std::string_view json);                         // rows added; malformed rows skipped
  const std::vector<Toothed>& get(std::string_view part) const;  // empty when the part has no teeth
};
enum class MeshKind : uint8_t { Parallel, Crossed, Worm, Rack };
struct GearMesh {
  uint32_t a = 0, b = 0;         // piece indices, a < b
  MeshKind kind;
  int teethA = 0, teethB = 0;    // rack: teethB is 0 and `travel` is used
  double travel = 0;             // rack or worm: LDU moved (or teeth advanced) per turn of a
  Vec3 point, tangent;           // at `point` both tooth surfaces move together along `tangent`; `point` divides the
                                 // distance to the two shafts exactly as the tooth counts
  Vec3 axisA, axisB, pointA, pointB;  // each gear's shaft line; a rack's direction of travel
};
std::vector<GearMesh> findMeshes(const Model& model, const GearDb& gears);
}
```
Rules (constants in `tolerances.h`, the slacks being those the web engine observed in official models): `kPitchSlack = 2`, `kRackSlack = 4.5`, `kBevelSlack = 3.5` LDU, `kMeshAxis` = cos 3.5°.
- **Parallel:** axes parallel, centres `rA + rB` apart across the axis (± slack), tooth widths overlapping along it by at least 2 LDU. Spur–spur, spur–double bevel, double bevel–double bevel.
- **Crossed:** axes perpendicular (± 3.5°) and intersecting within slack, each centre `r_other` (± slack) from the other's axis, and for a single bevel the teeth facing the partner. Bevel and double-bevel kinds only.
- **Worm:** axes perpendicular and skew, their distance `rWorm + rGear` (± slack), the gear's plane crossing the worm's length. Ratio `1 : teeth`.
- **Rack:** gear axis perpendicular to the rack's direction and to its `face`, gear centre `r` (± slack) above the tooth line, within the rack's length. `travel = 2π r`.

- [ ] Tests on hand-built `Toothed` values and a small `gears.json`: 8T and 24T at 40 LDU mesh with teeth 8/24 and sign −1, at 43 LDU do not; two 12T bevels at right angles on a shared apex mesh, the same pair facing away do not; a worm against a 24T gives 1:24; an 8T over a rack gives travel `2π·10`; three gears in a row give two meshes; the same gears on one axis (stacked) do not mesh; a malformed row is skipped; `3648a` finds `3648`.
- [ ] `[data]` test: 8880 contains the three meshes named in `8880.expected.json` "gearbox-meshes"; 42000 contains its five `gearMesh` pairs with the listed ratios (± 0.002).
- [ ] RED, implement, GREEN, commit `feat(native): gear teeth and gear meshes`.

### Task 2: Meshes in the graph, and connectors the sources lack

**Files:** Modify `native/core/include/bm/connect/graph.h`, `native/core/src/connect/graph.cpp`, `native/core/src/collide/world.cpp`, `native/core/src/audit/audit.cpp`, `native/tools/bm/cmd_audit.cpp`, `native/tools/bm/cmd_joints.cpp`, `native/tools/bm/cmd_overlaps.cpp`; Create `native/data/extra-connectors.json`, loader `loadExtraConnectors(std::string_view json, ConnectorDb&) -> size_t` in `connectors.h/.cpp`; Tests `native/tests/graph_test.cpp`, `native/tests/collide_world_test.cpp`, `native/tests/connectors_test.cpp`.

- `Graph` gains `std::vector<kin::GearMesh> meshes` (filled by `buildGraph(model, connectors, const kin::GearDb* gears = nullptr)`) and one `MateZone` per mesh: a capsule along the line of tooth contact (through `point`, along the gear axis for the shared width; along the rack), radius `kToothDepth = 4` LDU. `findOverlaps` exempts a meshed pair inside its zone, like a mate. Meshed gears do not join groups: a gear is held by its shaft, not by its neighbour.
- `extra-connectors.json` gives connectors (`Source::Override`) for parts no source covers, each row `{part, kind: "ball"|"socket"|"pin"|"hole"|"hinge", at, axis, radius, length, note}` with the measurement's origin in `note`. First rows: tread links `57518`, `57519`, `57520` (pin and hole on the hinge line), chain links `30104k02` ends, link `6628`/`32293` balls and sockets, tow ball/socket pairs that top `overlap-pairs.json`. Values are measured from the part mesh with `bm shape`.

- [ ] Tests: two meshing gears on shafts are not an overlap and are still two groups; the same two gears pushed 3 LDU closer are an overlap; an extra-connector row for a ball and a socket makes a spherical joint; a malformed row is skipped.
- [ ] Run the audit; record overlap counts for 5590 / 42000 / 8880 before and after.
- [ ] Commit `feat(native): gear meshes exempt from overlap, extra connectors`.

### Task 3: The moving system

**Files:** Create `native/core/include/bm/kin/system.h`, `native/core/src/kin/system.cpp`; Test `native/tests/kin_system_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::kin {
struct Link {                    // a joint between two moving bodies
  uint32_t a = 0, b = 0;         // body indices, a < b
  connect::JointKind kind;       // Revolute, Prismatic, Cylindrical or Spherical
  Vec3 point, axis;
  uint32_t pieceA = 0, pieceB = 0;  // a piece pair it came from
};
struct Gearing {                 // a gear mesh between two bodies
  uint32_t a = 0, b = 0; GearMesh mesh;
};
struct System {
  std::vector<uint32_t> bodyOf;  // per piece
  uint32_t bodies = 0;
  std::vector<uint32_t> size;    // pieces per body
  uint32_t ground = 0;           // the body with the most pieces
  std::vector<Link> links;
  std::vector<Gearing> gearings;
  std::vector<uint32_t> heldSlides;  // connection indices whose slide was found not to move
};
struct SystemOptions { bool testTravel = true; };
System buildSystem(const Model&, const connect::Graph&, ldraw::PartCache&, collide::ShapeCache&, SystemOptions = {});
}
```
How bodies are made, in order, repeated until nothing changes:
1. Start from the graph's rigid bodies. Flexible joints are dropped (a hose holds nothing rigidly); segments are their own bodies and are left out of the system.
2. **Snap axes:** link axes within `kMeshAxis` of each other and lines within `connect::kLineMatch` are replaced by their common line (Review Focus 2).
3. **A slide that is held:** a link that slides loses its slide when the mate grips through a lip (`'L'` section) or is keyed (`'A'` in `'A'`: a friction fit) and neither connector is marked `slide`; or, with `testTravel`, when moving the smaller body `kMinTravel = 2` LDU each way along the axis makes an overlap it did not have in both directions.
4. **Combine parallel links:** all links between the same two bodies are combined with `connect::combine`; a result of Fixed merges the bodies.
5. **Bridge through a pin:** a body whose only links are two coaxial turning links (a pin through two beams) is kept, and a coaxial Revolute/Cylindrical link is added between its two neighbours, so step 4 sees both pins of a two-pin joint (Review Focus 1).

- [ ] Tests (fixture parts): two beams and two pins → one body (plus the pins merged or free to spin, never a freedom between the beams); two beams and one pin → two bodies and one revolute link; an axle through a beam with a bush each side → revolute, not cylindrical, with `testTravel`, cylindrical without; a piston in a cylinder keeps its slide; an empty model and a single piece give `bodies` 0 or 1 and no links (Review Focus 3); 10,000 stacked bricks in under 1 s (Review Focus 5).
- [ ] RED, implement, GREEN, commit `feat(native): moving bodies and links`.

### Task 4: Freedoms

**Files:** Create `native/core/include/bm/kin/linalg.h`, `native/core/src/kin/linalg.cpp`, `native/core/include/bm/kin/mobility.h`, `native/core/src/kin/mobility.cpp`; Tests `native/tests/kin_linalg_test.cpp`, `native/tests/kin_mobility_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::kin {
struct Matrix { size_t rows = 0, cols = 0; std::vector<double> v; double& at(size_t r, size_t c); };
/// Orthonormal basis of the null space (columns), by Householder QR with column pivoting on the
/// transpose; a pivot under `tol` times the largest counts as zero.
Matrix nullSpace(const Matrix& m, double tol);

struct Twist { Vec3 angular, linear; };       // of a body about the model origin; ground is zero
struct Freedom {
  std::vector<uint32_t> bodies;                // bodies it moves
  std::vector<Twist> twists;                   // one per entry of `bodies`
  bool local = false;                          // moves exactly one body about one link (a free wheel, a spinning pin)
};
struct Mobility {
  bool solved = true; std::string reason;      // why not, when !solved
  std::vector<Freedom> freedoms;               // locals first, then the rest by bodies moved
  std::vector<uint8_t> moves;                  // per body: some freedom moves it
};
Mobility mobility(const System&);
/// Turns of `b` per turn of `a` (each about its own link axis to ground or its shaft line) in freedom `f`,
/// as a reduced fraction when both are on geared shafts; nullopt when either does not turn in it.
struct Ratio { int num = 0, den = 1; double value = 0; };
std::optional<Ratio> ratio(const System&, const Mobility&, size_t freedom, uint32_t bodyA, uint32_t bodyB);
}
```
- Unknowns: 6 per non-ground body. Rows: a revolute link 5, prismatic 5, cylindrical 4, spherical 3, a gearing 1 (`ωA·axisA·teethA − sign·ωB·axisB·teethB = 0`, written with the two shaft lines; a rack `ωA·r = v·dir`). Lengths are scaled by 1/20 so rows are comparable. `kRankTol = 1e-7`.
- Before the algebra, bodies with a single link and no gearing are stripped and reported as `local` freedoms, repeatedly; each connected component of the rest is solved by itself. A component of more than `kMaxSolveBodies = 400` bodies gives `solved = false` with the count (Review Focus 5).
- The null-space basis is rotated so freedoms are as separate as possible: reduced row echelon over bodies, so each freedom has a body no other freedom moves where one exists.
- `ratio` takes tooth counts along the gearing path between the two shafts when one exists (exact), and checks it against the twists.

- [ ] Tests: `nullSpace` of a rank-deficient 3×3, of a full-rank matrix (empty), of a zero matrix (identity size); a single revolute link → 1 freedom; a four-bar → 1 freedom moving 3 bodies; a triangle of three revolute links → 0; two shafts with 8T and 24T → 1 freedom and ratio −1/3 exactly; three gears in a ring on parallel shafts with tooth counts that cannot agree → those shafts locked (Review Focus 4); a rack and pinion → 1 freedom, rack linear speed `r·ω`; a differential (three bevels on a carrier) → 2 freedoms; an empty system → no freedoms.
- [ ] RED, implement, GREEN, commit `feat(native): degrees of freedom from the joints`.

### Task 5: Driving a freedom

**Files:** Create `native/core/include/bm/kin/drive.h`, `native/core/src/kin/drive.cpp`; Test `native/tests/kin_drive_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::kin {
struct Pose { std::vector<Xform> body; bool converged = true; };   // each body's motion from its rest pose
/// Moves along `freedom` by `amount` (radians of its fastest-turning body, or LDU when nothing turns),
/// from `from` (rest when null), in steps of at most kDriveStep, correcting each step by Newton on the
/// link constraints until the residual is under kCloseTol or kMaxNewton iterations pass.
Pose drive(const System&, const Mobility&, size_t freedom, double amount, const Pose* from = nullptr);
/// A piece's placement in a pose.
Xform placed(const Model&, const System&, const Pose&, uint32_t piece);
}
```
`kDriveStep = 0.05` rad or 1 LDU; `kCloseTol = 1e-6` (scaled lengths); `kMaxNewton = 20`. Gearings are integrated exactly: a geared shaft's angle is the driver's angle times the tooth ratio, not the sum of steps.

- [ ] Tests: a crank turned 2π returns every body to rest (within 1e-6); a four-bar's coupler stays its length through a full turn of the crank; a slider-crank's slider travels twice the crank radius; 8T driving 24T by one turn leaves the 24T at exactly −120°; driving past where a four-bar can go reports `converged = false` and the last good pose.
- [ ] RED, implement, GREEN, commit `feat(native): drive a freedom to a pose`.

### Task 6: Limits from collision, and shift states

**Files:** Create `native/core/include/bm/kin/limits.h`, `native/core/src/kin/limits.cpp`; Test `native/tests/kin_limits_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::kin {
struct Range { double lo = 0, hi = 0; bool loOpen = false, hiOpen = false; };   // open: no stop found within a full turn or kMaxSlide
/// How far `freedom` can be driven each way before a moved piece overlaps a piece of another body
/// (mate and mesh zones exempt, as in findOverlaps).
Range range(const Model&, const connect::Graph&, const System&, const Mobility&, size_t freedom, ldraw::PartCache&, collide::ShapeCache&);
/// The system as it is with `pose` applied: links whose travel is zero both ways in that pose
/// (a driving ring meshed into its clutch gear) become fixed and the bodies merge.
System systemAt(const Model&, const connect::Graph&, const System&, const Pose&, ldraw::PartCache&, collide::ShapeCache&);
}
```
`kMaxSlide = 200` LDU; a turn is searched to ±2π in `kDriveStep`s then bisected to 0.01.

- [ ] Tests: a hinge plate on a plate swings from flat to the stop on the other side and no further; a wheel on an axle has an open range; a piston's range is its cylinder's length; a ring sliding on a splined shaft between two loose gears: at rest it turns neither, at each end of its travel `systemAt` merges it with that gear and the shaft-to-gear ratio becomes 1.
- [ ] RED, implement, GREEN, commit `feat(native): joint limits and shift states from collision`.

### Task 7: The truth column, and `bm mechanisms`

**Files:** Create `native/core/include/bm/kin/truth.h`, `native/core/src/kin/truth.cpp`, `native/tools/bm/cmd_mechanisms.cpp`, `native/corpus/mechanism-truth.json`; Modify `native/tools/bm/main.cpp`, `commands.h`, `native/core/include/bm/audit.h`, `native/core/src/audit/audit.cpp`, `native/tools/bm/cmd_audit.cpp`; Test `native/tests/kin_truth_test.cpp`.

- `mechanism-truth.json` lists the model files and points at the three `benchmarks/mechanisms/*.expected.json` files, read as they are (the owner grows them there). Check types scored: `rotates`, `slides` (the piece's body has a freedom about / along that axis), `gearMesh` (the mesh exists, and its ratio when given), `rackPinion`, `fourBar` (the piece moves in a freedom that closes a loop and is not a pure slide), `function` (driving the driver's freedom over its range moves every `moves` piece by 0.5 LDU or 1° and leaves every `stays` piece), `shiftMode` (over all end positions of sliding links, the listed input:output ratio occurs; `null` means no ratio at rest). `vehicle`, `scrub`, `bumpSteer` and `suggested` are reported as `not scored`.
- `kin::score(model, expected json, ...) -> {hit, missing, notScored, lines}`; `audit::Row` gains `freedoms`, `localFreedoms`, `meshes`, `kinMs`, `truthHit`, `truthTotal`.
- `bm mechanisms <file> [--drive <n> <amount>] [--truth <expected.json>]` prints freedoms (bodies moved, a few part names each, range), gear trains with ratios, and the truth score.

- [ ] Tests: a small model with a hand-written expected file scores hit/missing as expected for each scored check type; a check whose part is not at the position is `unresolved`.
- [ ] Run on 5590, 8880, 8880-axle-fix, 42000. For every miss decide: missing connector data (fix in data), a rule fault (fix the rule, add the test), or a defect of the file (record it). Target: every scored 8880 and 42000 check passes.
- [ ] Commit `feat(native): mechanism truth column`.

### Task 8: Names

**Files:** Create `native/core/include/bm/kin/names.h`, `native/core/src/kin/names.cpp`; Test `native/tests/kin_names_test.cpp`.

`std::vector<Named> nameMechanisms(const System&, const Mobility&)` with `Named { std::string kind; std::vector<uint32_t> bodies; size_t freedom; }`, read off the solved system only: `gear-train` (a freedom through two or more gearings), `differential` (two freedoms sharing three crossed meshes on one carrier), `rack-steering` (a rack gearing whose rack body links to two bodies turning about parallel axes), `piston-engine` (a turning body with two or more slider-crank loops), `linear-actuator` (a worm or screw freedom ending in a slide), `linkage` (a loop of links with no gearing). Shown by `bm mechanisms`.

- [ ] Tests: each kind on the Task 4 fixtures; a plain hinge gets no name.
- [ ] Commit `feat(native): mechanism names`.

### Task 9: Stability

**Files:** Create `native/core/include/bm/stable/tolerances.h`, `native/core/include/bm/stable/stability.h`, `native/core/src/stable/stability.cpp`, `native/core/src/stable/lp.cpp`, `native/tools/bm/cmd_stability.cpp`; Tests `native/tests/stable_test.cpp`, `native/tests/stable_lp_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::stable {
struct Options { Vec3 down{0, 1, 0}; const std::vector<uint8_t>* present = nullptr; };  // present: per piece, for a build step
struct Result {
  bool stands = true;
  std::vector<uint32_t> unsupported;   // pieces with no load path to the floor
  std::vector<uint32_t> tipping;       // groups (by a piece in each) whose weight falls outside their footprint
  std::vector<uint32_t> overloaded;    // connections that would have to pull harder than they hold
  double margin = 0;                   // LDU from the centre of mass to the footprint's edge, smallest over groups
};
Result check(const Model&, const connect::Graph&, ldraw::PartCache&, Options = {});
/// Minimise c·x subject to A x = b, x >= 0 (dense two-phase simplex, Bland's rule). nullopt when infeasible.
std::optional<std::vector<double>> solveLp(const kin::Matrix& A, const std::vector<double>& b, const std::vector<double>& c);
}
```
- Mass is the mesh's enclosed volume times `kDensity` (ABS, 1.05 g/cm³; 1 LDU = 0.4 mm), with the bounding box's volume times `kHollowShare = 0.25` when the mesh is not closed.
- Floor contacts: the lowest points of the present pieces within `kFloorSlack = 1` LDU of the lowest. A group stands when its centre of mass projects inside the convex hull of its contacts.
- Load path: every present piece is in a group that touches the floor (groups from joints among present pieces only).
- Connection strength: one linear program per group over rigid bodies — unknowns are a force and torque at each connection and normal forces at floor contacts; each body is in balance; a connection's pull along its axis is at most `kStudHold = 1.0` N per stud of grip (`grip / 4` LDU) and its bending moment at most that pull times its lever. Infeasible → the connections on the cut are `overloaded`.

- [ ] Tests: LP — a 2-variable problem with a known optimum, an infeasible one, a degenerate one that must not cycle; a brick on the floor stands; a brick in mid-air is `unsupported`; a tall stack leaning on a 1-stud overhang past its footprint tips; a 16-stud-long plate cantilevered from one stud is `overloaded`, from 2×4 studs is not; `present` hiding the supporting brick makes the brick above unsupported; an empty model stands.
- [ ] `bm stability <file> [--step n]`; audit columns `stands`, `unsupportedPieces`. Commit `feat(native): stability check`.

### Task 10: Measure and record

- [ ] Full audit with kinematics and stability columns; sanitizer builds (ASan, TSan) clean.
- [ ] `native/README.md`: "Phase 4 results" — truth scores per reference set against the web engine's (`benchmarks/mechanisms/*.results.txt`), overlap counts before/after, freedoms across the corpus, timings, what the corpus corrected, what is not done.
- [ ] Commit `docs(native): phase 4 results`.

## Not in this phase

Time-stepped playback with motors (the timeline, phase 5, calls `drive`), free dynamics, friction and backlash, belts and chains as drives (a chain is hinged links here, not a coupling), vehicle rolling/scrub/bump-steer checks, and geometric detection of connectors from the mesh.
