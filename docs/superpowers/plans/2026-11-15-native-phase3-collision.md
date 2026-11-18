# Native Rewrite Phase 3 (Collision) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One collision implementation on the exact part meshes that says whether two placed pieces interpenetrate, finds every overlap in a model, and checks a moving piece along a path — without flagging pieces that merely touch or are properly connected.

**Architecture:** A new `bm::collide` module. Each part gets a `Shape`: its true surface, the same surface pulled inward by the skin, and a bounding-volume tree over the triangles. Two pieces overlap when the inner surface of one crosses the true surface of the other, so surfaces that touch or overlap by less than the skin do not count. Where two pieces are joined, the volume of each mate (a stud in its socket, a bar in its clip) is exempt, taken from the connection graph, which replaces per-part exceptions with one rule. A model is checked with a sort-and-sweep over piece boxes, then tree-against-tree per candidate pair.

**Tech Stack:** as before (C++20, Catch2).

**Spec:** `docs/superpowers/specs/2026-11-15-native-rewrite-design.md` ("3. Collision", "Proving it").

## Global Constraints

- No per-set or per-part special cases. An exemption comes from a mate in the connection graph or from a general rule.
- One implementation: the static check, the model-wide check and the moving check all use the same `Shape` and the same pair test.
- Tolerances are named constants in `collide/tolerances.h`, in LDU, each with a comment.
- `bmcore` stays free of Apple headers; `-Wall -Wextra -Werror`.
- Thread-safe: shapes are built once and shared; checks do not mutate shared state.

## Review Focus

1. Two bricks that touch face to face, or sit side by side sharing a wall plane: not an overlap.
2. Two bricks at the same height overlapping by half a stud (their faces coplanar, their edges on each other's face boundaries): an overlap.
3. A piece duplicated at exactly the same pose: reported as a duplicate, not silently missed.
4. A degenerate mesh (zero-area triangles, a part with no triangles, non-finite transforms): no crash, no overlap reported.
5. A 10,000-piece model: the model-wide check runs in time near-linear in pieces, not quadratic.

---

### Task 1: Triangle test and part shapes

**Files:** Create `native/core/include/bm/collide/tolerances.h`, `native/core/include/bm/collide/shape.h`, `native/core/src/collide/tritri.cpp`, `native/core/src/collide/shape.cpp`; Test `native/tests/collide_shape_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::collide {
inline constexpr double kSkin = 0.5;        // surfaces overlapping by less than this do not count
struct Vec3f { float x, y, z; };
/// Whether two triangles cross (not merely touch, not coplanar). `where` gets a point on the crossing.
bool trianglesCross(const Vec3f a[3], const Vec3f b[3], Vec3f* where = nullptr);
struct Node { float min[3], max[3]; uint32_t left, count; };   // count > 0: leaf of `count` triangles from `left`; else children left, left+1
struct Shape {
  std::vector<Vec3f> points;        // pulled inward by kSkin / 2 along the vertex normal
  std::vector<uint32_t> triangles;  // 3 per triangle, reordered for the tree
  std::vector<Node> nodes;          // nodes[0] is the root; empty when there are no triangles
  Box bounds;                       // of `points`
};
Shape buildShape(const ldraw::Mesh& mesh);
class ShapeCache {                  // thread-safe; one Shape per mesh
 public:
  std::shared_ptr<const Shape> get(const std::shared_ptr<const ldraw::Mesh>& mesh);
};
}
```
A vertex normal is the area-weighted sum of its triangles' normals; a vertex whose normals cancel (two-sided geometry) is not moved. Zero-area triangles are dropped. Leaves hold at most 4 triangles; split at the median of centroids on the longest axis.

- [ ] Tests: crossing triangles cross and report a point on both planes; touching at an edge or a vertex, coplanar, parallel and far-apart triangles do not; a box mesh's shape has its corners 0.25·(inward diagonal) in, every triangle reachable through the tree, node boxes containing their triangles; an empty mesh and a mesh of degenerate triangles give an empty shape (Review Focus 4); the cache returns one shape per mesh from 8 threads.
- [ ] RED, implement, GREEN, commit `feat(native): triangle test and collision shapes`.

### Task 2: Two placed shapes

**Files:** Create `native/core/include/bm/collide/pair.h`, `native/core/src/collide/pair.cpp`; Test `native/tests/collide_pair_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::collide {
struct Zone { Vec3 a, b; double radius; };     // a capsule in model space where surfaces may cross
struct Hit { Vec3 point; };                    // model space
/// Whether shape `a` placed by `xa` and `b` placed by `xb` interpenetrate outside `zones`.
bool overlap(const Shape& a, const Xform& xa, const Shape& b, const Xform& xb, const std::vector<Zone>& zones = {}, Hit* hit = nullptr);
}
```
Tree against tree in `a`'s space: `b`'s node boxes are carried over by the relative transform (conservatively, as boxes); leaves test triangle pairs with `trianglesCross`; a crossing inside any zone is ignored and the search goes on.

- [ ] Tests (box meshes): stacked and side-by-side bricks do not overlap (Review Focus 1); bricks at one height overlapping by half a stud do (Review Focus 2); overlapping by 0.3 LDU does not, by 1 LDU does; rotated 45° into each other do; far apart do not; the same crossing inside a zone is ignored, outside it is found; a mirrored placement behaves the same; non-finite transform gives no overlap (Review Focus 4).
- [ ] RED, implement, GREEN, commit `feat(native): overlap test between two placed shapes`.

### Task 3: Mate zones from the connection graph

**Files:** Modify `native/core/include/bm/connect/graph.h`, `native/core/src/connect/graph.cpp`; Test `native/tests/graph_test.cpp`.

- `Connection` gains `uint32_t firstZone, zoneCount`; `Graph` gains `std::vector<MateZone> zones` where `MateZone { Vec3 a, b; double radius; }` is the shorter of the two mated connectors' segments, radius = the larger connector radius + `kZonePad` (2 LDU); a generic mate (hinge, ball, wheel) is a sphere of `max(radius, kGenericZone)` + pad.

- [ ] Tests: a stacked 2×4 pair has 8 zones, each around a stud; a bar in a clip has a zone the length of the clip, not of the bar.
- [ ] RED, implement, GREEN, commit `feat(native): mate zones on connections`.

### Task 4: Whole-model check and moving check

**Files:** Create `native/core/include/bm/collide/world.h`, `native/core/src/collide/world.cpp`; Test `native/tests/collide_world_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::collide {
struct Overlap { uint32_t a, b; Vec3 point; bool duplicate; };   // piece indices, a < b
struct Report { std::vector<Overlap> overlaps; uint32_t tested = 0; };
/// Every overlapping pair in the model. Joined pieces are exempt inside their mate zones;
/// flexible segments are not tested; exact duplicates are reported as such.
Report findOverlaps(const Model&, const connect::Graph&, ldraw::PartCache&, ShapeCache&);

class World {       // the model's pieces, ready to be asked about one more shape
 public:
  World(const Model&, ldraw::PartCache&, ShapeCache&);
  /// First piece (not in `ignore`) that `shape` at `xf` overlaps, or nullopt.
  std::optional<uint32_t> hits(const Shape& shape, const Xform& xf, const std::vector<uint32_t>& ignore = {}, const std::vector<Zone>& zones = {}) const;
  /// Checks poses along the straight move from `from` to `to`, no further apart than kSweepStep.
  /// Returns the fraction of the move (0..1) at the first hit, or nullopt if the move is clear.
  std::optional<double> sweep(const Shape& shape, const Xform& from, const Xform& to, const std::vector<uint32_t>& ignore = {}, const std::vector<Zone>& zones = {}) const;
};
}
```
Broad phase: piece boxes sorted on x, swept, then y and z compared. `kSweepStep = kSkin`: nothing thicker than the skin can be stepped over. The moving check interpolates translation linearly and rotation by the shortest arc.

- [ ] Tests: a clean stack has no overlaps; a brick pushed half a stud into its neighbour is reported once with both indices; a duplicate is reported with `duplicate = true` (Review Focus 3); a stud in its socket is not an overlap but the same brick sunk 6 LDU into the one below is; segments are skipped; 10,000 bricks in under 3 s (Review Focus 5); `World::sweep` straight down onto studs is clear until seated and a move through a wall reports a fraction between 0 and 1.
- [ ] RED, implement, GREEN, commit `feat(native): model-wide overlap check and sampled sweep`.

### Task 5: Audit columns and measurement

**Files:** Modify `native/core/include/bm/audit.h`, `native/core/src/audit/audit.cpp`, `native/tools/bm/cmd_audit.cpp`, `native/README.md`; Create `native/tools/bm/cmd_overlaps.cpp`.

- `audit::Row` gains `overlaps`, `overlapPieces`, `duplicates`, `collisionMs`, and a map of part-pair → count; `bm audit` writes `<out>/overlap-pairs.json` ranking part pairs by overlaps across the corpus.
- `bm overlaps <file>` lists a model's overlapping pairs with part names and the crossing point.

- [ ] Run the full audit. Official sets should have almost no overlaps: read the top of `overlap-pairs.json`, decide for each recurring pair whether it is a real overlap in the file, a missing mate (fix in connector data), or a fault in the test (fix the rule), and record the result and what remains in `native/README.md`.
- [ ] Commit `feat(native): overlap columns in the audit`.

## Not in this phase

Clearance distance between shapes, swept volumes instead of sampled poses, containment of one piece wholly inside another's solid, and SIMD. Each is added when the planner (phase 5) shows it is needed.
