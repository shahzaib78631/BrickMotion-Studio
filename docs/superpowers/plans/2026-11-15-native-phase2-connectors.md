# Native Rewrite Phase 2 (Connectors and Connection Graph) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every part its connectors, find every mated pair in a model, turn the mates into joints and rigid bodies, and measure the result over the corpus against the web engine.

**Architecture:** A new `bm::connect` module in `bmcore`. Connectors come from pluggable sources (first: the LDCad shadow library), each connector carrying its source. Mating is decided by **profile matching** (the male's cross-section fits the female's along a shared axis), not by a fixed list of connector families, so axles, pins, bars, studs, sideways and upside-down studs all go through one rule. Mates between the same two pieces combine into one joint by intersecting the motions each mate allows.

**Tech Stack:** as phase 1 (C++20, Catch2).

**Spec:** `docs/superpowers/specs/2026-11-15-native-rewrite-design.md` (sections "1. Connector database", "2. Connection graph and joints", "Proving it").

## Global Constraints

- No per-set or per-part special cases in engine code; a fix goes into connector data or a general rule.
- A connector is a frame in space: nothing assumes a world grid or an up direction.
- Every connector records its source (`shadow`, later `studio`, `bricknet`, `kinebrick`, `geometry`, `override`).
- The shadow library is read from `BM_SHADOW_DIR` (default `<repo>/vendor/LDCadShadowLibrary`). It is CC BY-SA 4.0: keep attribution; do not copy it into `native/`.
- `bmcore` stays free of Apple headers; `-Wall -Wextra -Werror`; lengths in LDU, doubles.
- Tolerances are named constants in one header, in LDU, with a comment saying what each protects.

## Review Focus

1. A shadow line with missing or malformed parameters (`secs` with a non-number, `grid` with too few values, unknown `gender`): that connector is skipped, the rest of the file is kept, nothing crashes.
2. A `SNAP_INCL` loop (a includes b includes a): ends, yields what it found.
3. Two pieces placed at exactly the same pose (a duplicated piece): no joint between them, no crash, no quadratic blow-up.
4. A model with 10,000+ pieces: the graph is built in time roughly linear in pieces (spatial hash), not quadratic.
5. A part scaled or mirrored by its reference (stretched axle hole, mirrored subpart): connector length and radius follow the scale; a mirrored frame still mates.

---

### Task 1: Shadow reader

**Files:** Create `native/core/include/bm/connect/shadow.h`, `native/core/src/connect/shadow.cpp`; Test `native/tests/shadow_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::connect {
enum class Gender : uint8_t { Male, Female };
struct Section { char shape; double radius, length; };   // 'R' round, 'A' axle, 'S' square, 'L' flexible lip (L_ and _L)
struct Frame { Mat3 r; Vec3 t; };                        // row-major orientation, position
enum class SnapKind : uint8_t { Cyl, Clip, Finger, Generic };
struct SnapDef {
  SnapKind kind; Gender gender = Gender::Female;
  std::string id, group;
  std::vector<Frame> frames;             // one per grid copy
  std::vector<Section> sections;         // Cyl
  std::string caps = "one";              // Cyl: none, one, two, a, b
  bool center = false, slide = false;
  double radius = 0, length = 0;         // Clip, Finger (default finger radius 4)
  std::vector<double> seq;               // Finger
  std::string bounding, match, placement;// Generic
};
struct Include { std::string ref; std::vector<Frame> frames; };
struct ShadowInfo {
  std::vector<SnapDef> snaps; std::vector<Include> includes;
  bool clearAll = false; std::vector<std::string> clearIds;   // lower-case
};
ShadowInfo parseShadow(std::string_view text);
std::vector<Vec3> gridOffsets(std::string_view grid);
class ShadowLibrary {                     // thread-safe, parsed once per file
 public:
  explicit ShadowLibrary(std::filesystem::path root);   // missing dir = empty
  const ShadowInfo* find(std::string_view name) const;  // "stud.dat", "s/3001s01.dat", "48/…"
  size_t size() const;
};
}
```
Behaviour follows `src/ldraw/shadow.ts` (`snapParams`, `gridOffsets`, `framesOf`, `parseSections`, `parseShadow`): keys case-insensitive, `0 //!LDCAD` ignored, `MIRROR_INFO` ignored, a Clip is always female.

- [ ] Tests: the lines for 3673 (pin), stud2, 3700, 4085a, 3937, 32474 parse to the expected definitions; `grid=C 4 C 2 20 20` gives 8 offsets centred on 0; `grid=1 2 0 20` gives (0,0,0),(0,0,20); Review Focus 1 inputs; a real-data test (`[data]`, skipped without `BM_SHADOW_DIR`) that the library has more than 4,000 files and `stud.dat` has one male round snap of radius 6, length 4.
- [ ] Run to see them fail; implement; run to pass; commit `feat(native): LDCad shadow reader`.

### Task 2: Part connectors

**Files:** Create `native/core/include/bm/connect/connectors.h`, `native/core/src/connect/connectors.cpp`; Test `native/tests/connectors_test.cpp`; fixtures `native/tests/fixtures/shadow/`.

**Interfaces — produces:**
```cpp
namespace bm::connect {
enum class Source : uint8_t { Shadow, Studio, BrickNet, Kinebrick, Geometry, Override };
struct ProfileSection { char shape; double radius, start, length; };   // start measured from the connector's start, along its axis
struct Connector {
  SnapKind kind; Gender gender; Source source = Source::Shadow;
  Vec3 start;            // part space, LDU
  Vec3 axis;             // unit: the direction its sections run in
  Vec3 side;             // unit, perpendicular to axis: fixes the roll (axle cross, generic)
  double length = 0, radius = 0;
  std::vector<ProfileSection> profile;   // Cyl
  bool slide = false; bool openStart = true, openEnd = false;   // from caps
  std::string id, group, match, placement, bounding;
  std::vector<double> seq;               // Finger
};
class ConnectorDb {                      // thread-safe; each part computed once
 public:
  ConnectorDb(const ldraw::Library&, const ShadowLibrary&);
  std::shared_ptr<const std::vector<Connector>> get(std::string_view partName, const ldraw::Library* modelLibrary = nullptr);
};
Connector transformed(const Connector&, const Xform&);
}
```
Rules: a part's connectors are its own shadow snaps (with `SNAP_INCL` expanded, depth ≤ 8) plus those of every subfile it references, placed by the reference, unless the referencing file's shadow clears them (all, or by id). Lengths scale with the reference's scale along the axis, radii with the larger scale across it. `center=true` moves `start` back by half the length. caps: `none` both ends open; `one` start open, end closed; `two` both closed; `a` start closed; `b` end closed. Reference depth ≤ 64, loops end. `modelLibrary` lets a model's inline parts resolve; results for inline parts are not shared.

- [ ] Tests on a fixture library + fixture shadow dir: a 2×4 brick has 8 male studs pointing −Y and 8 female sockets at y=24; a stud inherited through a 90°-turned reference points sideways (SNOT); a stretched reference doubles a hole's length; `SNAP_CLEAR` drops inherited snaps, `SNAP_CLEAR [id=…]` only those; an include loop ends (Review Focus 2, 5).
- [ ] `[data]`: real `3001.dat` → 8 studs + 8 sockets; real `3673.dat` → its own male profile only (the inherited ones are cleared); `3700.dat` has a through hole with both ends open.
- [ ] RED, implement, GREEN, commit `feat(native): part connectors from the shadow library`.

### Task 3: Mating rules

**Files:** Create `native/core/include/bm/connect/mate.h`, `native/core/src/connect/mate.cpp`, `native/core/include/bm/connect/tolerances.h`; Test `native/tests/mate_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::connect {
struct Freedom {                 // what one mate leaves free between the two pieces
  bool rotates = false;          // about `axis` through `point`
  bool slides = false;           // along `axis`
  bool ball = false;             // any rotation about `point`
  Vec3 point, axis;
};
struct Mate { Freedom freedom; double grip; };     // grip: LDU of matched engagement
std::optional<Mate> mate(const Connector& a, const Connector& b);   // world-space connectors; order-independent
enum class JointKind : uint8_t { Fixed, Revolute, Prismatic, Cylindrical, Spherical };
struct Joint { JointKind kind; Vec3 point, axis; };
Joint combine(const std::vector<Freedom>& mates);  // non-empty
}
```
Rules (general, by geometry):
- **Cyl male + Cyl female:** axes parallel either way (|dot| ≥ `kAxisParallel`), male start within `kAxisOffset` of the female's axis line. Map the male profile onto the female's axis. Reject if any male section is wider than the female section it overlaps by more than `kRadiusSlack` over more than `kMinInterference`. Grip = total overlap length of section pairs that fit: round in round, axle in axle, axle in round, round in square, radii within `kRadiusSlack`; a lip (`L`) fits anything round. Mate if grip ≥ `kMinGrip`. A closed end blocks entry: the male may not extend past a closed female end, and may not enter through one. Freedom: rotates unless axle-in-axle; slides if either side has `slide`.
- **Cyl male + Clip:** the male has a round section of the clip's radius (within slack) overlapping the clip's length by ≥ `kMinGrip`, axes parallel. Rotates; slides if either allows.
- **Finger + Finger:** opposite gender offsets, same group when both have one, same radius, axes parallel, spans overlap by ≥ half the shorter. Rotates only.
- **Generic + Generic:** opposite gender, same group, positions within `kPointMatch`; `bounding=sph` or `placement=free` → ball; otherwise nothing free (fixed).
- Anything else: no mate.
- **combine:** rotation survives only about a line every mate allows (lines coincide within tolerance; a ball allows any line through its point); sliding survives only along a direction every mate allows. Both → Cylindrical, rotation only → Revolute (or Spherical if all mates are balls at one point), slide only → Prismatic, neither → Fixed.

- [ ] Tests: stud in socket (grip 4, revolute); same stud 1 LDU off-axis mates, 3 LDU off does not; stud approaching a socket from its closed end does not mate; pin through a hole from either side mates; axle in axle hole → prismatic when it slides; axle in round hole → cylindrical; a wide pin collar in a narrow hole is rejected; bar in clip; hinge fingers; ball and socket; two studs between the same pieces → Fixed; two coaxial pin holes → Revolute or Cylindrical; mirrored frame still mates (Review Focus 5).
- [ ] RED, implement, GREEN, commit `feat(native): mating rules and joint combination`.

### Task 4: Connection graph

**Files:** Create `native/core/include/bm/connect/graph.h`, `native/core/src/connect/graph.cpp`; Test `native/tests/graph_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::connect {
struct Connection { uint32_t a, b; Joint joint; uint16_t mates; double grip; };   // piece indices, a < b
struct Graph {
  std::vector<Connection> connections;
  std::vector<uint32_t> group;     // per piece: connected-group id (any joint)
  std::vector<uint32_t> body;      // per piece: rigid-body id (Fixed joints only)
  uint32_t groups = 0, bodies = 0;
  uint32_t largestGroup = 0;       // pieces in it
  uint32_t attached = 0;           // pieces with at least one connection
  uint32_t withoutConnectors = 0;  // pieces whose part has no connector at all
};
Graph buildGraph(const Model&, ConnectorDb&);
}
```
World connectors go into a spatial hash (cell `kHashCell`), each connector entered at points along its length no further apart than the cell, so overlapping coaxial connectors always share a cell or neighbours. Candidate pairs are tested once; mates are grouped by piece pair and combined. Pieces at the same pose with the same part are not paired (Review Focus 3).

- [ ] Tests: two bricks stacked → 1 connection, Fixed, 1 group, 1 body; brick on one stud → Revolute, 1 group, 2 bodies; SNOT: a brick on a sideways stud joins; two separate stacks → 2 groups; a duplicated piece → no connection between the twins; 10,000 bricks in a grid build in under 2 s (Review Focus 4); a piece whose part has no shadow counts in `withoutConnectors`.
- [ ] RED, implement, GREEN, commit `feat(native): connection graph, joints and rigid bodies`.

### Task 5: Audit columns and measurement

**Files:** Modify `native/core/include/bm/audit.h`, `native/core/src/audit/audit.cpp`, `native/tools/bm/cmd_audit.cpp`, `native/tools/bm/cmd_load.cpp`, `native/tools/compare_scoreboards.py`, `native/README.md`; Create `native/tools/bm/cmd_joints.cpp`.

- `audit::Row` gains `joined` (largest group), `groups`, `attached`, `bodies`, `withoutConnectors`, `joints` (count per kind), `graphMs`. `summarize` totals them and reports `joined %` and `attached %` over pieces.
- `bm joints <file> [--json]`: per-kind joint counts, groups, bodies, and the 20 most-used parts with no connectors or no connection.
- `bm audit` writes `<out>/unjoined-parts.json`: over the whole run, parts ranked by how many placed pieces had no connection, split into "part has no connectors" and "has connectors, nothing mated".
- `compare_scoreboards.py` prints joined % and fully-joined model counts, native vs web, per source.

- [ ] Test: `loadRow` on the stacked-brick fixture reports joined 2, groups 1.
- [ ] Run the full audit; record native vs web joined % per source in `native/README.md`; commit `feat(native): joint columns in the audit`.
- [ ] From `unjoined-parts.json`, write down in `native/README.md` what the next connector source must cover (which parts, how many pieces). That list is the input to the next plan (Studio connectivity, BrickNet labels, Kinebrick, mesh detection).
