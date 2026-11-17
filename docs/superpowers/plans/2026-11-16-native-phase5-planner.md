# Native Phase 5: Assembly Planner and Animation Timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bm plan <file>` returns, for any model in the corpus, a build order and a flight for every piece in which nothing floats, nothing passes through anything, and every connection goes in along its own connector — or says, on the piece, exactly which of those it could not prove.

**Architecture:** Assembly by disassembly. Each mate records how it comes apart (a *release*). A unit (a piece, or a group that must go in together) can leave when one direction satisfies every release it has with what remains, the sweep along that direction is clear, and what remains is still joined. Units are taken off until nothing is left; the build is that list reversed. A separate **certifier**, which shares no code with the planner, replays the finished plan and is the only thing that may call a move certified. The timeline is generated from the plan and written into the existing plan-file format.

**Tech Stack:** C++20, CMake/Ninja, Catch2, nlohmann/json. Builds on `bm::connect` (graph, mates), `bm::collide` (`Shape`, `World`), `bm::kin` (`System`), `bm::stable`, `bm::JobPool`, `bm::io` (plan files). No new third-party code.

**Spec:** `docs/superpowers/specs/2026-11-15-native-rewrite-design.md`, section "5. Assembly planner and animation" and "Proving it: the corpus scoreboard". Read both before starting.

> **Status 2026-11-16.** Built and committed in one pass, simpler than written below in places:
> - Tasks 1–7 done. A release is one struct per mate, in step with `Graph::zones` (`Across` for a clip with
>   `orAlong`; a ball is `Any`). Queries on part of a model are `World::clearTravel` / `near` on piece indices.
>   The certifier does not compute `tips`.
> - Task 8 done for top-level items of a plan file (not inside submodels). An authored `after` loop is not detected.
> - Task 9 in part: cancel and budget work; there is no cross-run `Cache` (the `World` remembers pair sweeps within a run).
> - Task 10 in part: staging, flights, hover, camera and JSON are done; `writeInto` a plan document is not, and
>   the staging and crossing legs of a flight are not swept.
> - Task 11 in part: scorer and six fixture cases; no clip, hand, sword, wheel, tyre, hinge or ball case yet, and none from the reference sets.
> - Task 12: see `native/README.md`, "Phase 5 results". **The speed target is not met.**
>
> **Status 2026-11-17.** Speed work done (commits 424e38f, 79832c5): the 25-set OMR sample plans in a median of
> 0.65 s and a 95th percentile of 6.1 s one model at a time, with no time-outs (was 16 s, 46 s and 10 of 25
> out of time). Target met on the sample. Still open from this plan: floating placements and crossings on OMR
> (3 and 30 on the sample), `writeInto`, the cross-run cache, more insertion-truth cases.

## Global Constraints

- All code under `native/`, namespace `bm::plan`; headers in `native/core/include/bm/plan/`, sources in `native/core/src/plan/`, tests in `native/tests/plan_*_test.cpp`. CMake globs sources: new files need no list edit, but re-run `cmake -S native -B native/build` once after adding the first file.
- `-Wall -Wextra -Werror`. No Apple headers in `bmcore`. Everything thread-safe or documented as not.
- **No per-set and no per-part special cases in engine code.** A part that needs help gets a row in `native/data/*.json` that states where its numbers come from.
- Every tolerance is a named constant in `native/core/include/bm/plan/tolerances.h` with a comment that says what it means physically and where its value comes from.
- **The hard rules are never relaxed to make a plan succeed.** A move the certifier does not pass is flagged with a reason; it is never played as if it were fine. There is no search budget that turns into an uncertified move silently: when a budget runs out the affected moves are flagged `Budget`.
- Build order is the planner's own; it does not have to follow the file's steps (owner's decision). File steps are a preference, not a constraint. Only what the author pinned is a constraint.
- Targets from the spec, restated against the measured baseline: OMR median plan time under 1 s, 95th percentile under 10 s, no time-outs, every reference set planned. Web baseline to beat: OMR median 8.5 s, p95 92.8 s, 178 of 1,833 time-outs, 23.2% of placements floating.
- Commit per task on `feat/native-engine`. Stage only files under `native/` and this plan; the owner's other uncommitted work in the tree is never staged.
- Build and test: `cmake --build native/build && BM_LDRAW_DIR=$PWD/public/ldraw BM_SHADOW_DIR=$PWD/vendor/LDCadShadowLibrary native/build/tests/bmcore_tests`.

## Review Focus

Inputs the spec implies and no happy-path test would meet. Each has its test in the task named.

1. **A piece joined to nothing in the file** (1.3% of corpus pieces: stickers, parts with no connector data). It cannot be placed "joined to something built". Expected: placed after what it rests on, flagged `Unjoined`, never counted as certified, and never blocks the rest of the plan. (Task 5)
2. **A piece held by two connections that release along different lines** (a beam on two pins at right angles; a plate under a SNOT bracket). Expected: grouped with a neighbour into a unit that does have a common direction; if no group up to `kMaxGroup` has one, flagged `NoDirection`. (Tasks 4 and 5)
3. **A piece that can only leave through a gap narrower than the sweep step** (a tile between two walls with 0.2 LDU clearance). The sampled sweep must not call a grazing path clear by stepping over the obstacle, and must not call an exact fit blocked. (Task 3)
4. **A file with several separate assemblies, or one that is empty, or one piece.** Expected: each group planned by itself on the floor; empty gives an empty plan; one piece gives one move from staging. (Task 5)
5. **An authored flight that passes through another piece.** Expected: kept exactly as authored, flagged `AuthoredCrossing`; the planner never replaces what the author set. (Task 8)
6. **Cancelling mid-plan and re-planning after an edit.** Expected: cancel returns promptly with the moves found so far marked `Budget`; a re-plan after moving one piece re-tests only units whose neighbourhood changed, and gives the same plan as a cold run. (Task 9)

---

## File Structure

| File | Responsibility |
|---|---|
| `bm/connect/mate.h`, `graph.h` (modify) | each mate's `Release`; `Graph::releases` per connection |
| `bm/collide/world.h` (modify) | queries against a subset of pieces; box candidates for a swept box |
| `bm/plan/tolerances.h` | every planner number |
| `bm/plan/release.h` | which directions a unit may leave along, from its releases |
| `bm/plan/units.h` | the units a model is built from, and grouping |
| `bm/plan/extract.h` | one unit, one direction: clear travel, exit path |
| `bm/plan/sequence.h` | the disassembly loop and the order preference |
| `bm/plan/plan.h` | the result types (`Move`, `Plan`, `Flag`) and `plan()` |
| `bm/plan/certify.h` | the independent certifier |
| `bm/plan/timeline.h` | flights, pacing, staging, camera; plan-file export |
| `tools/bm/cmd_plan.cpp` | `bm plan`, `bm certify` |
| `bm/audit.h` (modify) | plan columns |
| `native/corpus/insertion-truth.json`, `native/tests/fixtures/plan/*.ldr` | hand-checked insertion cases |

---

### Task 1: Releases — how each mate comes apart

**Files:** Modify `native/core/include/bm/connect/mate.h`, `native/core/src/connect/mate.cpp`, `native/core/include/bm/connect/graph.h`, `native/core/src/connect/graph.cpp`, `native/tools/bm/cmd_joints.cpp`; Test `native/tests/mate_test.cpp`, `native/tests/graph_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::connect {
/// How one mate comes apart: the directions the *male* connector's piece may leave along.
enum class ReleaseKind : uint8_t {
  Along,     ///< one way along `axis` (a stud lifts off, a pin in a blind hole, an axle with a stop)
  Either,    ///< either way along `axis` (a pin or axle through an open hole)
  Across,    ///< out of the open side: any direction within `spread` of `axis`, which is square to the bar (a clip)
  Cone,      ///< out through the opening: any direction within `spread` of `axis` (a ball in its socket)
  Any,       ///< it holds by nearness only (a flexible end, a generic mate with no axis): no constraint
};
struct Release {
  ReleaseKind kind = ReleaseKind::Any;
  Vec3 axis;          ///< unit, model space; for Along and Cone it points the way the male leaves
  double spread = 0;  ///< radians; 0 for Along and Either
  double travel = 0;  ///< LDU the male must move along `axis` before the mate lets go (the engaged length)
  bool maleIsFirst = false;  ///< the male is the first connector given to mate()
};
struct Mate { Freedom freedom; double grip = 0; Release release; };   // release added
struct Connection { /* existing */ uint32_t firstRelease = 0, releaseCount = 0; };
struct Graph { /* existing */ std::vector<Release> releases; };  ///< one per mate, axis signed so it is how piece `b` leaves piece `a`
}
```
Rules, each read off the connectors and nothing else:
- **Cylinders.** `travel` is the overlap of the two profiles along the axis. `Either` when the female is open at both ends and no rigid male section wider than the hole lies outside it on either side (a collar, a stop); otherwise `Along`, pointing away from the side that blocks. A stud in a socket is `Along` the stud axis away from the stud's base.
- **Clip on bar:** `Across`, `axis` = the clip's opening direction (from the clip connector's `side`), `spread` = `kClipSpread`; also allowed: `Either` along the bar when the bar's end is free (the bar connector is open at an end and nothing rigid of the bar is wider than the clip beyond it). Stored as two releases for the one mate; a direction satisfies the mate if it satisfies either.
- **Ball in socket:** `Cone` about the socket's opening axis, `spread` = `kSocketSpread`.
- **Fingers (hinge halves):** `Either` along the hinge pin.
- **Generic with no axis, tyre on rim, flexible:** tyre is `Either` along the rim's axis; the rest `Any`.
- In `buildGraph` the axis is flipped where needed so that every stored release says how the higher-numbered piece `b` leaves `a`; the opposite direction is how `a` leaves `b`.

- [ ] **Step 1: Failing tests** in `mate_test.cpp` (use the file's `stud`, `socket`, `pin`, `pinHole`, `axle`, `axleHole` helpers): a stud in a socket gives `Along` with `axis == kUp` and `travel == 4`; a pin through a pin hole gives `Along` away from its collar (the collar is wider than the hole) with `travel == 20`; an axle through an axle hole open both ends gives `Either`, `travel == 20`; a bar in a clip gives two releases, `Across` along the clip's side and `Either` along the bar; a ball in a socket gives `Cone` about the socket's opening; `mate(a, b)` and `mate(b, a)` give the same release with `maleIsFirst` flipped.
- [ ] **Step 2:** `graph_test.cpp`: two 1x1 bricks stacked — `graph.releases` has one entry, `Along`, axis `(0, -1, 0)` when the upper brick is piece `b`, `(0, 1, 0)` when the file lists it first.
- [ ] **Step 3: Run** `native/build/tests/bmcore_tests "[mate],[graph]"`; expect the new cases to fail to compile, then fail.
- [ ] **Step 4: Implement.** `bm joints <file> --of <part>` (exists) also prints each connection's releases.
- [ ] **Step 5: Run the whole suite; commit** `feat(native): each mate records how it comes apart`.

### Task 2: World queries against part of a model

**Files:** Modify `native/core/include/bm/collide/world.h`, `native/core/src/collide/world.cpp`; Test `native/tests/collide_world_test.cpp`.

The planner asks the same world about a shrinking set of pieces thousands of times; an `ignore` list that grows to the whole model is quadratic.

**Interfaces — produces:**
```cpp
namespace bm::collide {
/// Which pieces are there. Null means all. Indexed like Model::pieces().
using Present = std::vector<uint8_t>;
class World {
 public:
  // existing hits()/sweep() keep working; these take a mask and several shapes moving as one.
  struct Moving { const Shape* shape; Xform at; uint32_t piece; };   ///< `piece`: its own index, never an obstacle
  /// First obstacle among present pieces that any of `unit`, moved by `motion`, interpenetrates.
  std::optional<uint32_t> hits(const std::vector<Moving>& unit, const Xform& motion, const Present* present, const std::vector<Zone>& zones = {}) const;
  /// How far (LDU, up to `distance`) `unit` can travel along unit vector `direction` before the first hit; `distance` if clear.
  /// `blocker`, if given, receives the piece that stops it.
  double clearTravel(const std::vector<Moving>& unit, Vec3 direction, double distance, const Present* present, const std::vector<Zone>& zones = {}, uint32_t* blocker = nullptr) const;
  /// Present pieces whose boxes meet `box`. Cheap; used to skip the surface test when nothing is near.
  void near(const Box& box, const Present* present, std::vector<uint32_t>& out) const;
};
}
```
- `clearTravel` first sweeps the unit's box along the direction and collects `near` pieces; with none it returns `distance` without a surface test. Otherwise it samples at `kSweepStep` and, on the first hit, bisects back to within `kTravelTol` so the travel returned is the last clear pose.
- Zones given are carried with the unit (they are corridors of its own mates, Task 3).

- [ ] **Tests:** with a 1x1 fixture brick as the unit and a wall of bricks 30 LDU away: `clearTravel` towards it returns 10 ± `kTravelTol` (the gap), away from it returns `distance`, and `blocker` is the wall piece; with the wall's piece masked out it returns `distance`; a unit of two shapes is stopped by whichever meets first; a unit never collides with its own pieces; `near` returns only present pieces; with `present == nullptr` the results equal the mask of all ones; ten thousand `clearTravel` calls on a 1,000-brick wall finish in under 1 s (not under sanitizers, as existing timing tests do).
- [ ] RED, implement, GREEN, commit `feat(native): collision queries against part of a model`.

### Task 3: Extraction — one unit, one direction

**Files:** Create `native/core/include/bm/plan/tolerances.h`, `native/core/include/bm/plan/extract.h`, `native/core/src/plan/extract.cpp`; Test `native/tests/plan_extract_test.cpp`.

**Tolerances (all in `plan/tolerances.h`):**
```cpp
inline constexpr double kReleaseAgree = 0.9986;   // cos 3 deg: a direction is "along" a release axis within the rounding of placed files
inline constexpr double kClipSpread   = 0.5236;   // 30 deg: a clip's jaws open about a third of a turn
inline constexpr double kSocketSpread = 0.3491;   // 20 deg: a ball leaves within the socket's mouth
inline constexpr double kTravelTol    = 0.05;     // LDU: bisection of the first contact
inline constexpr double kClearMargin  = 4.0;      // LDU beyond the engaged length a unit must travel freely to count as out: one stud height
inline constexpr double kExitMargin   = 20.0;     // LDU outside the built model's box where a flight may turn: one stud
inline constexpr int    kMaxGroup     = 24;       // pieces in a unit grown to find a common direction; larger groups are authored submodels or mechanisms
inline constexpr int    kMaxLegs      = 3;        // straight legs from seat to open air
```

**Interfaces — produces:**
```cpp
namespace bm::plan {
struct Unit { std::vector<uint32_t> pieces; };          ///< sorted piece indices; moves as one rigid thing

/// The directions a unit may leave along, given what is present. Empty: none satisfies every mate.
/// Each is unit length in model space, most constrained first (an Along axis before an Either, before a sampled Across/Cone).
struct Leave { Vec3 direction; double travel; };        ///< travel: the longest engaged length among its mates along it
std::vector<Leave> leaveDirections(const connect::Graph&, const Unit&, const collide::Present* present);

struct Extraction {
  bool ok = false;
  Vec3 direction;                   ///< the insertion axis, pointing out of the seat
  double seatTravel = 0;            ///< along `direction` while the mates are engaged
  std::vector<Xform> path;          ///< the unit's motion from the seat (identity first) to open air, straight legs between
  uint32_t blocker = UINT32_MAX;    ///< when !ok: the piece in the way of the best attempt
  enum class Why : uint8_t { None, NoDirection, Blocked, NoExit } why = Why::None;
};
/// Tries to take `unit` out of the present pieces. Thread-safe: reads only.
Extraction extract(const Model&, const connect::Graph&, const collide::World&, const std::vector<std::shared_ptr<const collide::Shape>>& shapes,
                   const Unit&, const collide::Present* present, const Box& builtBounds);
}
```
How `extract` works, in order:
1. `leaveDirections`: for every connection between a unit piece and a present piece outside it, the direction must satisfy one of that connection's mates' releases for *each mate* (`Along`: within `kReleaseAgree` of the axis; `Either`: of the axis or its opposite; `Across`/`Cone`: within `spread`; `Any`: always). Candidates are the release axes themselves (both ways for `Either`), so a unit with no connection to anything present has the six model axes and "up" first.
2. **Seat leg.** `clearTravel` along the candidate for `travel + kClearMargin`, with one **corridor zone** per mate: the mate's own zone extended along the direction by `travel`. A pin leaving its hole grazes the hole the whole way; that is the fit, not a crossing. Nothing else is exempt. If it stops short of `travel + kClearMargin`: `Blocked`, with the blocker.
3. **Exit legs.** From the end of the seat leg the unit must reach open air: a pose whose box is `kExitMargin` outside `builtBounds`. Tried in order: (a) straight on along the same direction; (b) straight up (against gravity, LDraw `-y`); (c) each of the six model axes; then (d) one intermediate leg along any of those followed by any of those, up to `kMaxLegs` legs in all. Each leg is a `clearTravel` with no zones. First that reaches open air wins. None: `NoExit`.
4. The first candidate direction that completes wins. If none completes, the result carries the `Why` and blocker of the attempt that got furthest.

- [ ] **Tests** (fixture bricks, hand-written graphs as in `kin_system_test.cpp`'s `Hand`; give its `join` a release argument):
  - A brick on a brick: `ok`, direction up, `seatTravel == 4`, path ends above the model.
  - A brick under a brick, studs up, nothing else: the *upper* one leaves; asking for the lower gives `Blocked` by the upper... unless the lower is the only one connected by a release whose axis points down, in which case it leaves downward (a plate hung under a stud-down socket). Both cases.
  - A piece on two mates whose axes are square to each other: `NoDirection`.
  - A pin (`Either`) through two beams with a third beam past one end: leaves the other way.
  - A clip on a bar with a wall across the clip's opening but the bar's end free: leaves along the bar.
  - Review Focus 3: a tile in a slot with 0.2 LDU clearance each side leaves upward (`ok`); the same slot 0.2 LDU *narrower* than the tile is `Blocked`; a wall 0.3 LDU thick across the path, between two sample poses, is still hit (place it at an offset that falls between `kSweepStep` samples).
  - Boxed in on all six sides with one side two legs away from open air: `ok` with three poses in `path`; boxed in completely: `NoExit`.
  - A unit of two bricks joined to each other and to a base by parallel studs leaves as one; the corridor zones are those of both pieces' mates.
- [ ] RED, implement, GREEN, commit `feat(native): extracting a unit along its connectors`.

### Task 4: Units and grouping

**Files:** Create `native/core/include/bm/plan/units.h`, `native/core/src/plan/units.cpp`; Test `native/tests/plan_units_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::plan {
/// Where a group of pieces comes from. Earlier kinds are tried first when a single piece cannot leave.
enum class UnitSource : uint8_t { Piece, Authored, Body, Grown };
struct Candidate { Unit unit; UnitSource source; };

struct Units {
  /// Authored groups: every use of a submodel in the file (pieces sharing a `Piece::path` prefix), outermost last.
  std::vector<Unit> authored;
  /// Rigid bodies of the graph (fixed joints only) that are more than one piece.
  std::vector<Unit> bodies;
  /// Per piece: indices into `authored` and `bodies` that contain it, smallest first.
  std::vector<std::vector<uint32_t>> authoredOf, bodyOf;
};
Units findUnits(const Model&, const connect::Graph&);

/// Grows a unit from `piece` until its mates with the rest agree on a direction: adds, one at a time, the
/// present neighbour on the other side of a mate that conflicts with the direction most of its other mates share.
/// Stops at kMaxGroup or when it would take in every present piece. nullopt when no such unit exists.
std::optional<Unit> growUnit(const connect::Graph&, uint32_t piece, const collide::Present* present);
}
```
- A unit is only valid if its pieces are joined to each other through present pieces *of the unit* (it is one thing in the hand).
- Kinematic bodies (`kin::System`) are deliberately not a source: a mechanism is built from its pieces like anything else. Authored submodels and rigid bodies are.

- [ ] **Tests:** a file with a submodel used twice gives two authored units with the right pieces; a submodel inside a submodel gives both, inner first for its pieces; three bricks fixed in a row give one body unit; a piece held by two square mates, one of them to a neighbour that itself has a free direction, grows into a two-piece unit whose `leaveDirections` is not empty (Review Focus 2); the same with every neighbour also conflicting stops at `kMaxGroup` and returns nullopt; a grown unit never contains a piece that is not present.
- [ ] RED, implement, GREEN, commit `feat(native): the units a model is built from`.

### Task 5: The sequence — taking the model apart

**Files:** Create `native/core/include/bm/plan/plan.h`, `native/core/include/bm/plan/sequence.h`, `native/core/src/plan/sequence.cpp`; Test `native/tests/plan_sequence_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::plan {
enum class Flag : uint8_t {
  None,              ///< found by the planner; certified or not is the certifier's word (Task 7)
  Unjoined,          ///< the piece is joined to nothing in the file; placed after what it rests on, or last
  NoDirection,       ///< no direction satisfies all its connections, alone or in any group tried
  Blocked,           ///< every allowed direction is blocked by a piece that is built before it in every order found
  NoExit,            ///< it leaves its seat but no path of kMaxLegs legs reaches open air
  AuthoredCrossing,  ///< the author's own flight passes through a piece (Task 8)
  Budget,            ///< planning was cancelled or ran out of time before this move was settled
};
struct Move {
  Unit unit;                      ///< what goes in
  UnitSource source = UnitSource::Piece;
  Vec3 insertion;                 ///< unit, model space: the way it travels *into* its seat (minus the extraction direction)
  double seatTravel = 0;
  std::vector<Xform> path;        ///< motion from the seat: identity first, open air last (the flight is this reversed)
  Flag flag = Flag::None;
  uint32_t blocker = UINT32_MAX;  ///< for Blocked: a piece in the way
  int sub = -1;                   ///< index into Plan::subs when the unit is built on the floor first (more than one piece)
};
struct Plan {
  std::vector<Move> moves;        ///< in build order
  std::vector<Plan> subs;         ///< how each multi-piece unit is itself built, on the floor
  double planMs = 0;
  bool complete = true;           ///< false when cancelled
  std::vector<std::string> notes; ///< things the author should know that belong to no one move (Task 8)
};
struct Constraints;  // Task 8
struct Options {
  const CancelToken* cancel = nullptr;
  JobPool* pool = nullptr;        ///< null: JobPool::shared()
  double budgetSeconds = 0;       ///< 0: none
  Vec3 down{0, 1, 0};
  const Constraints* authored = nullptr;   ///< Task 8
  class Cache* cache = nullptr;            ///< Task 9
};
Plan plan(const Model&, const connect::Graph&, ldraw::PartCache&, collide::ShapeCache&, const Options& = {});
}
```
**The loop** (`sequence.cpp`), per connected group of the graph, largest first:
1. Everything present. `dirty` = every piece.
2. For each dirty piece, in parallel: `extract` it as a single-piece unit. Record the result with its blocker.
3. **Removable now** = units with `ok` whose removal leaves the present set joined: the group's graph without the unit is still one component (computed once per round with a bridge/articulation pass over present pieces, not per candidate), or the unit is the last one.
4. If none is removable: for each piece whose `why` is `NoDirection` or whose blocker is itself stuck, try in order the smallest authored unit containing it, its rigid body, then `growUnit`; `extract` each; a unit that would split the remainder is rejected the same way. Still none: the stuck pieces with the fewest present neighbours are taken off as flagged moves (`NoDirection`, `Blocked` or `NoExit` from their best attempt) so the rest can go on. A flagged move's `path` is empty.
5. Choose among the removable by the **order preference**, compared in this order (this is the reverse of the build, so "last built" is "first removed"):
   - the unit continues the current run: same authored unit, then same file step, as the unit just removed ("finish a subassembly before moving on");
   - higher first: the unit's box top is higher against `down` ("bottom-up" build);
   - outer first: further from the vertical line through the group's centre of mass ("inside-out" build);
   - smaller units before larger; then the lowest piece index (so the result is the same on every run).
6. Remove it. Append the move. Mark dirty: every present piece joined to a removed piece, and every piece whose recorded blocker was a removed piece. Go to 2.
7. Reverse the moves. A multi-piece unit gets a `sub` plan: the same loop on the unit's pieces alone, with its own bounds.

**Unjoined pieces** (no connection in the graph) are not in any group. Each is placed after the present pieces its box rests on (within `stable::kFloorSlack` above them, overlapping in plan view), dropped straight down along `down` if that sweep is clear, flag `Unjoined` (Review Focus 1). They never hold up a group.

**Stability** is not a hard rule of the spec and is not enforced here; `stable::check` with `Options::present` is run by the certifier and reported (Task 7) so tipping steps are visible.

- [ ] **Tests:**
  - A 3-brick tower plans bottom to top; every move's `insertion` is `down`.
  - A pin through two beams: one beam first, then the pin along its axis into that beam, then the second beam onto the pin along the pin's axis — never the pin after both beams if the pin's collar only allows one way and that way is covered.
  - A wheel on an axle between two beams: the order found has every move `Flag::None`.
  - A wall with a brick in the middle that can only go in before its neighbours close over it: built in an order where it is not `Blocked`.
  - A bridge: two towers and a beam across; the beam is not placed before both towers exist only if it would otherwise be joined to nothing (no floating: at every prefix of `moves` the placed set is one component per group).
  - Review Focus 4: empty model → no moves, `complete`; one piece → one move; two separate towers → both planned, the larger first, each from its own base.
  - Review Focus 1: a brick with a sticker-like piece joined to nothing lying on it → sticker placed after the brick, `Unjoined`; the same piece hanging in the air → placed last, `Unjoined`.
  - Review Focus 2: the two-square-mates piece and its neighbour go in as one unit with a `sub` plan of two moves.
  - The result is identical with a pool of 1 thread and of 8 (compare `moves` field by field).
  - 2,000 fixture bricks in a 10 x 10 x 20 block plan in under 2 s (not under sanitizers).
- [ ] RED, implement, GREEN, commit `feat(native): build order by taking the model apart`.

### Task 6: `bm plan`, and a first look at the corpus

**Files:** Create `native/tools/bm/cmd_plan.cpp`; Modify `native/tools/bm/main.cpp`, `commands.h`.

- `bm plan <file> [--explain <part>] [--threads N] [--budget seconds] [--json] [--no-studio]` prints: pieces, groups, moves, moves per flag, sub-plans, plan time; then the first 20 flagged moves with part, position, reason and blocker. `--explain <part>` prints, for every piece of that part: its releases, the directions tried, how far each got and what stopped it, and the units tried. `--json` prints the whole plan (the format of Task 10's `toJson`).
- [ ] Run on `samples/helicopter/helicopter.mpd`, `samples/5590_-_whirl_n_wheel_super_truck.mpd`, `samples/42000-1.mpd`, `samples/8880-1.mpd` and the three smallest OMR files. For every flag kind that appears, use `--explain` on three of its pieces and decide, as in earlier phases: missing connector or release data (fix in data or in Task 1's rules, with a test), a rule fault (fix the rule, add the test), or a defect of the file (record it in `native/README.md`). Do not tune tolerances to make a count go down without a physical reason written next to the constant.
- [ ] Commit `feat(native): bm plan`.

### Task 7: The certifier

**Files:** Create `native/core/include/bm/plan/certify.h`, `native/core/src/plan/certify.cpp`; Test `native/tests/plan_certify_test.cpp`.

The certifier is the scoreboard's source of truth. It must not call `extract`, `leaveDirections` or anything in `sequence.cpp`: it takes a finished `Plan` and checks each move against the three hard rules with `collide::World` and the graph directly, so a planner bug cannot certify itself.

**Interfaces — produces:**
```cpp
namespace bm::plan {
struct MoveCheck {
  bool joined = false;       ///< rule 1: once placed, the unit is joined to something already placed (or is the first of its group)
  bool clear = false;        ///< rule 2: no pose of the flight interpenetrates a placed piece (mates' corridors on the seat leg only)
  bool alongConnector = false;  ///< rule 3: the last leg into the seat satisfies every mate's release with the placed pieces
  bool tips = false;         ///< information: the placed set does not stand after this move (stable::check)
  uint32_t crossed = UINT32_MAX;
  bool certified() const { return joined && clear && alongConnector; }
};
struct Certificate {
  std::vector<MoveCheck> moves;          ///< one per Plan::moves, sub-plans checked into `subs`
  std::vector<Certificate> subs;
  int certified = 0, floating = 0, crossings = 0, offAxis = 0, flagged = 0, tipping = 0;
  bool ok() const { return floating == 0 && crossings == 0 && offAxis == 0 && flagged == 0; }
};
Certificate certify(const Model&, const connect::Graph&, ldraw::PartCache&, collide::ShapeCache&, const Plan&, const Options& = {});
}
```
- A move with a flag other than `None` is counted in `flagged` and not checked further; it is never `certified`.
- Rule 2 samples every leg at `kSweepStep`; its limit (something thinner than the skin, 0.5 LDU, between samples) is stated in `--json` output as `"sweep": "sampled 0.5"` so nobody reads it as a continuous proof.
- A multi-piece unit's flight is checked as the unit; its `sub` certificate is checked against the unit's own pieces only.

- [ ] **Tests:** a correct tower plan certifies fully; the same plan with two moves swapped so a brick lands before the one under it → that move `!joined`, `floating == 1`; a plan whose path is edited to pass through a wall → `!clear` with `crossed` the wall piece; a plan whose last leg comes in sideways onto a stud → `!alongConnector`; a flagged move is counted and not certified; a plan that leaves a tall offset stack standing on one stud mid-build has `tips` on those moves and still certifies; certifying the output of `plan()` on every fixture model of Task 5 gives `ok()` except the ones built to be flagged.
- [ ] RED, implement, GREEN. `bm plan` prints the certificate's counts; add `bm certify <file> --plan <plan.json>` for a plan made elsewhere. Commit `feat(native): independent plan certifier`.

### Task 8: Authoring wins

**Files:** Create `native/core/include/bm/plan/constraints.h`, `native/core/src/plan/constraints.cpp`; Modify `sequence.cpp`; Test `native/tests/plan_constraints_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::plan {
struct Constraints {
  /// Pieces that must be built in exactly this order, one list per pinned step (Step::pinOrder in the plan file).
  std::vector<std::vector<uint32_t>> pinned;
  /// `second` is built after `first` (AssemblyHints::after, attachTo).
  std::vector<std::pair<uint32_t, uint32_t>> after;
  /// Per piece: the insertion axis the author set, pointing out of the seat (AssemblyHints::insertionAxis); zero when unset.
  std::vector<Vec3> insertionAxis;
  /// Per piece: the author's own flight, poses from start to seat in the seat's frame (AssemblyHints::flight); empty when unset.
  std::vector<std::vector<Xform>> flight;
};
/// Reads them from a plan document. Item ids are matched to Model::pieces() by Piece::id.
Constraints readConstraints(const io::PlanDoc&, const Model&);
}
```
- Field meanings are in `src/plan/types.ts` lines 23–57 (`AssemblyHints`, `FlightPose = [x, y, z, qx, qy, qz, qw]`, "the move from the seat, in the seat's own frame (LDU)") and 68–83 (`Step.pinOrder`). Read them before writing the reader.
- In the loop: a piece with an authored `insertionAxis` has that one candidate direction; if it does not satisfy its releases the move is still made along it and the certifier reports `!alongConnector` — the author's word stands and the scoreboard shows it. A piece with an authored `flight` uses it as `path`; if it crosses, flag `AuthoredCrossing` (Review Focus 5). `pinned` and `after` restrict step 5 of the loop: a unit is only eligible when everything that must come after it has been removed. A cycle among the author's constraints is reported once (`Plan::notes`, a list of strings) and the constraints in the cycle are dropped, most recent first.
- LDraw file steps are **not** constraints (owner's decision); they remain the run-continuation preference of Task 5.

- [ ] **Tests:** a pinned step of three bricks that the planner would order otherwise comes out in the pinned order; `after` is respected across steps; an authored axis is used even when another is free; an authored flight is kept pose for pose; Review Focus 5; two `after` constraints that form a loop give a plan and one note; a plan file with none of these gives the same plan as the bare model.
- [ ] RED, implement, GREEN, commit `feat(native): authored order, axes and flights are constraints`.

### Task 9: Cancel, budget, cache, re-plan

**Files:** Create `native/core/include/bm/plan/cache.h`, `native/core/src/plan/cache.cpp`; Modify `sequence.cpp`; Test `native/tests/plan_cache_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::plan {
/// Remembers extraction results by what they depended on. Thread-safe.
class Cache {
 public:
  /// Key: the unit's parts and poses, the direction set of its releases, and the parts and poses of every present
  /// piece within the swept box of its attempts (the "neighbourhood"). Same key, same answer.
  std::optional<Extraction> find(uint64_t key) const;
  void store(uint64_t key, const Extraction&);
  size_t size() const; size_t hits() const;
};
}
```
- The key is a 64-bit hash (FNV-1a over part names, poses rounded to 0.001 LDU, and the present neighbourhood's part names and poses sorted). Piece indices are not in the key, so inserting a piece elsewhere in the file does not invalidate it.
- **Cancel / budget:** checked between rounds and inside the parallel loop. On stop, every piece still present is appended as a `Budget` move in file order and `Plan::complete` is false.
- **Re-plan:** `plan()` with the same `Cache` after an edit. Nothing else is kept between runs: the order is recomputed, which is cheap; the sweeps are what the cache saves.

- [ ] **Tests:** planning twice with one cache: the second run has `hits() > 0`, makes no `clearTravel` call for unchanged units (count them with a test-only counter on `World`), and returns an identical plan; moving one brick of a 200-brick wall and re-planning re-tests fewer than 20 units and equals a cold plan of the edited model (Review Focus 6); cancelling from another thread after 10 ms on the 2,000-brick block returns within 100 ms with `complete == false` and only `None` or `Budget` flags; a budget of 0.001 s does the same; the cache is safe under TSan with 8 threads storing and finding.
- [ ] RED, implement, GREEN, commit `feat(native): cancel, budget and an extraction cache`.

### Task 10: Timeline — from plan to animation

**Files:** Create `native/core/include/bm/plan/timeline.h`, `native/core/src/plan/timeline.cpp`; Test `native/tests/plan_timeline_test.cpp`.

**Interfaces — produces:**
```cpp
namespace bm::plan {
enum class Ease : uint8_t { Smooth, Gentle, Soft, Linear };          // MotionEase in src/plan/types.ts
struct Style { double time = 1, landing = 0.25, hover = 0.1; Ease ease = Ease::Smooth; double fps = 30, piecesPerSecond = 2; };
struct Flight {
  uint32_t move = 0;               ///< index into Plan::moves
  int startFrame = 0, frames = 0;
  Xform staging;                   ///< where the unit waits on the floor, as a motion from its seat
  std::vector<Xform> waypoints;    ///< staging, then the plan's path reversed (open air ... seat)
  std::vector<double> at;          ///< 0..1 along the flight for each waypoint (by path length)
};
struct CameraKey { int frame; Vec3 target; double distance, azimuth, elevation; };
struct Timeline {
  std::vector<Flight> flights;     ///< in build order; a flagged move has frames == 0 and appears in place
  std::vector<CameraKey> camera;
  int frames = 0;
};
Timeline buildTimeline(const Model&, ldraw::PartCache&, const Plan&, const Style& = {});
/// The pose of a unit at a frame: before its flight it is at `staging`, after it at its seat.
Xform poseAt(const Flight&, int frame, const Style&);
/// The plan as JSON for tools, and written back into a plan document the app reads:
/// each piece's `assembly.insertionAxis` and `assembly.flight` (FlightPose list in the seat's frame), steps in build order.
nlohmann::json toJson(const Plan&, const Certificate*, const Model&);
void writeInto(io::PlanDoc&, const Model&, const Plan&, const Timeline&);
}
```
- **Staging.** Units wait on the floor (the plane under the model's lowest point) in rows beside the model, in build order, spaced by their own boxes plus one stud, never overlapping each other or the model's footprint. A multi-piece unit's own pieces stage beside where the unit is built (`AssemblySpot`). `floorShift` and `floorTurn` from the plan file are applied on top.
- **Flight.** Staging → straight up to above the built model at that moment plus `kExitMargin` → across → the plan's path in reverse. The first two legs are swept like any other; if blocked, the staging spot moves outward until they are clear. Frames = path length divided by a speed that makes the mean flight `1 / piecesPerSecond`, times `style.time`; the last `landing` share covers the seat leg; `hover` holds at its start.
- **Flagged moves** do not fly: the unit appears at its seat on its frame. That is the visible form of "it says so on that piece".
- **Camera.** One key per second: target = the mean seat of the moves in the next two seconds, distance from the built bounds so far, azimuth easing a quarter turn over the whole build. No cuts.
- `writeInto` keeps every field of the document it does not own (the `PlanDoc` is ordered JSON kept verbatim) and never overwrites an authored `insertionAxis` or `flight`.

- [ ] **Tests:** staging spots do not overlap each other or the model for a 100-piece model; every flight's first waypoint is its staging and its last is the seat (identity); `poseAt` is continuous (adjacent frames differ by less than twice the mean step) and equals the seat at and after the last frame; `landing` and `hover` shares are honoured within one frame; a flagged move has `frames == 0`; total frames follow `piecesPerSecond`; `writeInto` then `readConstraints` then `plan()` reproduces the same order and axes (round trip); a document's unknown fields and authored flights survive `writeInto` byte for byte.
- [ ] RED, implement, GREEN. `bm plan <file> --out <plan.json>` writes the document (for an LDraw input it first builds one with `io`'s plan writer; if `io` cannot yet create a plan from a model, add `io::toPlan(const Model&)` in this task with a round-trip test against `fromPlan`). Commit `feat(native): build timeline from the plan`.

### Task 11: Insertion truth

**Files:** Create `native/corpus/insertion-truth.json`, `native/tests/fixtures/plan/*.ldr`, `native/core/include/bm/plan/truth.h`, `native/core/src/plan/truth.cpp`; Test `native/tests/plan_truth_test.cpp`.

The spec's "insertion truth" column has two halves: moves whose direction matches the connector's own axis (the certifier's `alongConnector`, already counted), and "a hand-checked list of cases: pins, wheels, clips, hands, swords in holders".

- `insertion-truth.json`: `{ "cases": [ { "id", "file", "piece": { "part", "at": [x,y,z] }, "axis": [x,y,z], "either": bool, "why": "..." } ] }`. A piece is named as in `benchmarks/mechanisms/*.expected.json`: part number and box centre within 12 LDU. `axis` is the way the piece travels into its seat; `either` allows the opposite. `why` says how the author knows (the connector, the instruction step).
- Small fixture models, one per rule-3 case in the spec, built from real parts (tests tagged `[data]`): a pin into a beam; an axle through a beam; a wheel onto an axle; a wheel onto a pin; a tyre over a rim; a clip onto a bar (sideways); a bar into a minifig hand (along the grip); a sword into a holder (blade-first along the slot); a stud pressed on from above, from the side (SNOT) and from below; a hinge half onto its mate (along the pin); a ball into a socket (along the opening). Before writing each, run `bm connectors <part>` to confirm the connectors exist; a part with none gets data first (shadow library, else a measured row in `native/data/extra-connectors.json` with its source), which is the same rule earlier phases used.
- Plus at least ten cases taken from the reference sets (5590, 42000, 8880, helicopter), chosen by looking at the model, each with its `why`.
- `plan::scoreInsertion(model, plan, json) -> { hit, missing, unresolved, lines }`, shaped like `kin::score`.

- [ ] **Tests:** each fixture case is a hit; a case whose piece is not in the model is `unresolved`; a wrong axis is `missing` with the angle between them in the detail.
- [ ] `bm plan <file> --truth native/corpus/insertion-truth.json` prints the score. For every miss decide data, rule or file, as in Task 6. Commit `feat(native): insertion truth list and scorer`.

### Task 12: Scoreboard, measurement, record

**Files:** Modify `native/core/include/bm/audit.h`, `native/core/src/audit/audit.cpp`, `native/tools/bm/cmd_audit.cpp`, `native/tools/compare_scoreboards.py`, `native/README.md`, this plan.

- `audit::Row` gains: `planned`, `planOk` (the certificate's `ok()`), `planMs`, `moves`, `certifiedMoves`, `planFlagged`, `buildFloating`, `buildCrossings`, `offAxis`, `unjoinedMoves`, `tippingMoves`, `subPlans`, and per-flag counts. Names `planOk`, `planMs`, `planFlagged`, `buildFloating` match the web baseline's rows (`scripts/native/baseline-worker.ts`) so `compare_scoreboards.py` lines them up. Note in the README that the web's `planOk` means "did not throw", which is weaker than the certificate.
- `bm audit --no-plan` skips planning; the per-model budget is `--plan-budget <seconds>` (default 180, the baseline's limit).
- [ ] Run the full corpus. Record in `native/README.md` "Phase 5 results": per source — models planned with every move certified; moves certified, flagged by kind, floating, crossing, off-axis; plan time median and p95; against the web baseline's numbers from `native/corpus/baseline.json`. State plainly whether the spec's speed targets and "every reference set planned" are met.
- [ ] Pick the 20 slowest models and the 10 with the most flags; for each flag kind's commonest part pairs decide data, rule or file. Fix what is a rule or data fault, with tests; record the rest under "Not done".
- [ ] ASan with UBSan and TSan runs of the whole suite (`native/build-asan`, `native/build-tsan`); fix what they find.
- [ ] Self-review against the spec's section 5 line by line; list every line not met under "Not done". Tick this plan's boxes, add a dated status note at the top if anything is left open. Commit `docs(native): phase 5 results`.

---

## What this phase does not do

- **A continuous sweep.** Flights are sampled every 0.5 LDU with a 0.5 LDU skin (phase 3). The certificate says so.
- **Curved or turning insertions** (a hinge swung shut, a piece rotated into place). Every leg is a straight line with no turning. Pieces that need one are flagged `Blocked` or `NoExit` and counted.
- **Driving mechanisms out of the way** during the build (opening a door to reach behind it). The model is built in the pose the file has it.
- **Joint strength during the build.** Tipping is reported per move, not prevented.
- **Easing curves, sound, hero orbit and the app's timeline editor.** Phases 8–9 own those; this phase ends at a timeline the CLI can write and the certifier has passed.
