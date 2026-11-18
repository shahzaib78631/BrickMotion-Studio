# Native Assembly Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The build order follows the file's steps, every flight is collision-free as played and above the floor, and what is played is what is certified.

**Architecture:** A play certifier (`certifyPlay`) sweeps the timeline that bmview and bmexport play. The floor becomes an obstacle in `extract`. `takeApart` becomes step-led, with units first-class. `poseAt` moves through corners without stopping. New measures go into `bm plan` and `bm audit`.

**Tech Stack:** C++20, Catch2, CMake (native/), `collide::World::clearTravel` for every sweep.

**Spec:** docs/superpowers/specs/2026-11-18-native-assembly-motion-design.md (extends §5 of docs/superpowers/specs/2026-11-15-native-rewrite-design.md)

## Global Constraints

- Native only: nothing ported from src/anim or any web code (owner, 2026-11-18).
- LDraw: y points down; `Options::down` = {0, 1, 0}.
- Every sweep goes through `World::clearTravel` (continuous, not sampled). Pass tolerance `kTravelTol` = 0.1 LDU.
- Determinism: the same plan and the same timeline on 1 or 8 threads (existing test "the same plan on one thread and on eight").
- Branch codex/m1-incremental-evaluation: one commit per task; stage explicit paths; never push; leave the owner's uncommitted scripts/*.ts, tests/ldraw/*, docs/independent-measurements.md and docs/data/ alone.
- Build and test: `cd native/build && cmake --build . && BM_LDRAW_DIR=<repo>/public/ldraw BM_SHADOW_DIR=<repo>/vendor/LDCadShadowLibrary ctest -j4`.

## Review Focus

1. A piece whose seat is on the underside of the base (a tile under the bottom plate) can only leave downward. It must be flagged (`Flag::NoExit`), not flown under the floor. Pinned in Task 2.
2. Sub-assemblies (`Plan::subs`) appear pre-built at their staging spot. The play certifier must sweep the unit's whole box as one piece, and their pieces become present only when their top-level move lands. Pinned in Task 1.
3. A flagged move does not fly (`frames == 0`). The play certifier skips it and does not count it as a crossing. Pinned in Task 1.
4. A model with no steps (every piece at step 0) must plan exactly as before: no inversions, same order rules within the step. Pinned in Task 3.
5. Authored flights (`Constraints::flight`) carry rotations. `poseAt` must still end exactly at the seat, and the sweep covers translation only (ledgered). Pinned in Task 4.

---

### Task 1: The play certifier

**Files:**
- Modify: `native/core/include/bm/plan/certify.h` (add the declarations below)
- Create: `native/core/src/plan/certify_play.cpp`
- Modify: `native/tools/bm/cmd_plan.cpp` (print a "played" block)
- Test: `native/tests/plan_test.cpp`

**Interfaces:**
- Consumes: `Timeline`, `Flight`, `poseAt` (timeline.h); `World::clearTravel`.
- Produces:
  - `struct PlayCheck { int flights = 0, crossings = 0, underFloor = 0, upward = 0, inversions = 0; std::vector<uint32_t> crossed; /* move index per crossing flight */ };`
  - `std::vector<Vec3> playedPath(const Flight& f, double spacing);` returns the unit's translation along its flight, start to seat, with points at most `spacing` LDU apart. It samples the same curve `poseAt` plays, densely in time.
  - `PlayCheck certifyPlay(const Model&, const connect::Graph&, ldraw::PartCache&, collide::ShapeCache&, const Plan&, const Timeline&, Vec3 down = {0, 1, 0});`

What each field counts:
- `crossings`: flights where some segment of `playedPath(f, 2.0)` is stopped short by a present piece. Present means every piece of an earlier top-level move. The final seat leg (insertion) keeps its mates' zones exempt, as `certify` does.
- `underFloor`: flights where some point puts the unit's box more than `seatTravel + kClearMargin` below the floor. The floor is the model's largest `dot(down, box.max)`.
- `upward`: moves with `dot(insertion, down) < -0.5`.
- `inversions`: pairs of top-level moves built against their file step. Count, for each move, the earlier moves whose lowest piece step is greater than this move's highest.

- [ ] **Step 1: Write the failing tests** in `plan_test.cpp`, tagged `[plan][play]`:
  - "the play certifier passes a tower": the 3-brick tower from the timeline test. `certifyPlay` gives `flights == 3`, `crossings == 0`, `underFloor == 0`, `upward == 0`, `inversions == 0`.
  - "the play certifier sees a flight through a placed piece": the tower, with move 2's `path` replaced by `{identity, shift(0, 30, 0), shift(0, 200, 0)}`. It comes up from below through bricks a and b, and `insertion` is set to {0, -1, 0}. Expect `crossings >= 1`, `crossed` holds 2, `underFloor == 1` and `upward == 1`.
  - "a flagged move is not swept": move 2 flagged `Blocked` gives `flights == 2` and `crossings == 0`.
  - "inversions count moves built against their steps": hand-set `Model` piece steps 0, 1, 2 on the tower, with the plan reordered so step 2 is built before step 1. Expect `inversions == 1`.
  - "a sub-assembly is swept as one": a unit of 2 pieces with a sub plan; one flight; `crossings == 0`.
- [ ] **Step 2: Run** `./tests/bm_tests "[play]"`. Expected: fails to compile (no `certifyPlay`).
- [ ] **Step 3: Implement** `certify_play.cpp`: build `World`, walk the flights in order, and sweep each consecutive pair of `playedPath` points with `clearTravel(unit, dir, len, &placed, zones (last leg only), &hit, Xform at the first point)`. After each move, mark its pieces placed. In `cmd_plan.cpp`, after "certified", print:

  ```
  played        <flights> flights: crossings <n>, under floor <n>
    upward      <n>
    inversions  <n>
  ```

  using `buildTimeline` with the default `Style`.
- [ ] **Step 4: Run** `./tests/bm_tests "[play]"` (PASS), then the full ctest (PASS). Record `bm plan samples/helicopter/helicopter.mpd` "played" numbers in the ledger as the before.
- [ ] **Step 5: Commit** `feat(native): certify what is played: every flight swept against what is built and the floor`.

### Task 2: The floor is solid

**Files:**
- Modify: `native/core/include/bm/plan/plan.h` (`Context::floor`)
- Modify: `native/core/src/plan/extract.cpp` (`Context::Context`, `extract`)
- Test: `native/tests/plan_test.cpp`

**Interfaces:**
- Produces: `double Context::floor`, the largest `dot(down, world.box(p).max)` over all pieces, set in the constructor. After the seat leg, `extract` never keeps a leg that ends with the unit's box below `floor + kTravelTol` along `down`. The seat leg itself may go below by at most its own travel.

- [ ] **Step 1: Write the failing tests** (`[plan][floor]`):
  - "a piece hung under a bridge leaves sideways, not through the floor": towers a1(0,0,0)/a2(0,-24,0) and b1(60,0,0)/b2(60,-24,0). A hand graph joins bridge pieces c(20,-48,0) and d(40,-48,0) over the towers' tops (c on a2, d on b2, c joined to d). Piece e(20,-24,0) is hung under c by a stud join with leaves = down. Expect:
    - every `path` point of e's move keeps e's box `dot(down, max) <= floor + seatTravel + kClearMargin`;
    - `certifyPlay` gives `underFloor == 0` and `crossings == 0`.
  - "a piece that can only leave through the floor is flagged": a brick under the bottom brick of a tower, joined with leaves = down, gives that move `Flag::NoExit`.
- [ ] **Step 2: Run** `./tests/bm_tests "[floor]"`. Expected: FAIL (the path goes down through the floor).
- [ ] **Step 3: Implement** the floor check inside `extract`'s `leg` lambda and the one-turn search: reject a leg whose end box is below the floor.
- [ ] **Step 4: Run** `[floor]`, `[play]`, then the full ctest. Record the helicopter "played" numbers.
- [ ] **Step 5: Commit** `feat(native): the floor is solid: no flight leaves a piece under the model's base`.

### Task 3: The file's steps lead the order

**Files:**
- Modify: `native/core/src/plan/sequence.cpp` (`Sequencer::takeApart`: the `before` comparator and the selection loop)
- Test: `native/tests/plan_test.cpp`

**Interfaces:**
- Consumes: `Piece::step`, `Units::authoredOf`, `Units::bodyOf`, `growUnit`.
- Produces: a selection with this order, each round:
  1. **Frontier.** `frontier` = the highest step among present pieces of the set.
  2. **Authored units at the frontier.** Units wholly present whose pieces all have step == frontier and that are not the whole set. Tried as one: `extract` straight, then with one turn.
  3. **Single pieces at the frontier.** Those that are ready, `free`, and keep the rest `joined`. Ranked:
     1. exit direction `dot(direction, -down) > 0.5` first;
     2. then same submodel path as the last removed;
     3. then height;
     4. then radial distance;
     5. then index.
  4. **One-turn exits** for the frontier's single pieces.
  5. **Bodies and grown units at the frontier.** `growUnit` is limited to pieces of step >= frontier.
  6. **Fallback.** Only if 2–5 took nothing: today's search over all present pieces, highest step first. Counted in `Plan::notes` as `"step inversion: <part> (step s) before step <frontier>"`.

- [ ] **Step 1: Write the failing tests** (`[plan][steps]`):
  - "a step's pieces that only come off together are built last, not first": the hub-and-blade trap.
    - Tower a(0,0,0) step 0, b(0,-24,0) step 1.
    - Tower d(20,0,0) step 0, f(20,-24,0) step 1.
    - Blade c(0,-48,0) step 3, hung under hub h(0,-72,0) step 3 (stud, leaves = down). c rests on b with no join.
    - h joined to f by a hand stud with leaves = up.
    - Free-standing g0(-60,0,0) step 0 and g1(-60,-24,0) step 1, with g1 joined to g0 and g0 joined to a.

    Expect the last top-level move is the unit {c, h}, and g1 is built before it.
  - "a model with no steps plans as before": the existing tower and "brick shut in" tests keep their orders (rerun them, unchanged).
  - "a submodel placed in a step goes in as one at that step": existing "each use of a submodel is a unit of its own" still passes, plus its use's move index is after every move of a lower step.
- [ ] **Step 2: Run** `./tests/bm_tests "[steps]"`. Expected: FAIL (g1 is taken before the unit, so {c, h} comes first in the build).
- [ ] **Step 3: Implement** the selection above in `takeApart` (the rest of the function and the cache logic, `stillHolds` / `togetherBefore` / `grownBefore`, stay).
- [ ] **Step 4: Run** `[plan]` and the full ctest. Record the helicopter "played" numbers, `certified` and the plan time. The plan time must stay under 2x the before.
- [ ] **Step 5: Commit** `feat(native): the file's steps lead the build; a step's units come off before an earlier step is touched`.

### Task 4: Flights that move like a hand

**Files:**
- Modify: `native/core/include/bm/plan/timeline.h` (`Style`: add `double corner = 40`, the largest corner radius in LDU)
- Modify: `native/core/src/plan/timeline.cpp` (`buildTimeline`, `poseAt`)
- Test: `native/tests/plan_test.cpp` (update "the timeline stages units on the floor and flies each to its seat")

**Interfaces:**
- Produces: `poseAt` moves along the air legs (staging -> up -> across -> down to the path's start, and the path's own legs before the seat leg) at one continuous speed:
  - one smoothstep in arc length over all of them;
  - each corner between air legs rounded by a quadratic Bezier of radius `min(style.corner, 0.4 * shorter adjacent leg)`;
  - then the hover (unchanged share), then the seat leg (unchanged `landing` share), straight.

  `Flight::at` keeps its meaning for the hover and seat waypoints. `playedPath` (Task 1) samples this curve.

- [ ] **Step 1: Update the timeline test**:
  - remove the per-corner stop assertions;
  - add "no stop before the hover": the frame-to-frame step never falls below 25% of its median while `u` is in `[0.1, at[hover] - 0.05]`;
  - add "no jump": every step is under 400;
  - add the poseAt-ends-at-seat check;
  - add `certifyPlay` crossings == 0 for the tower and the bridge scene;
  - add a move with an authored flight carrying a rotation ends at identity.
- [ ] **Step 2: Run** `[timeline]`. Expected: FAIL (it stops at every corner).
- [ ] **Step 3: Implement** in `timeline.cpp`.
- [ ] **Step 4: Run** `[timeline]`, `[play]`, and the full ctest.
- [ ] **Step 5: Commit** `feat(native): flights move at one speed through rounded corners and slow only to land`.

### Task 5: Gates: the helicopter and the corpus

**Files:**
- Modify: `native/tools/bm/cmd_audit.cpp` (row fields `played_crossings`, `under_floor`, `upward`, `inversions` when `--plan` is given)
- Test: `native/tests/plan_test.cpp` (`[plan][data]` helicopter test)
- Modify: `native/README.md` (results)

- [ ] **Step 1: Write the failing helicopter test**: "the helicopter is built from its base up", tagged `[plan][data]`. It skips without BM_LDRAW_DIR / BM_SHADOW_DIR, and loads `<repo>/samples/helicopter/helicopter.mpd` with the real graph. Expect:
  - the first move's lowest step is the model's lowest step;
  - the "helicopter - underside 1.ldr" use is one move;
  - the rotor hub (2711 at y -229) is in the last 25 moves;
  - `certifyPlay` gives `crossings == 0` and `underFloor == 0`;
  - `upward` <= 20;
  - `certify` certified >= 310.
- [ ] **Step 2: Run.** It passes only if Tasks 1–4 did their job. If it fails, fix in the owning task's code (a ledgered ruling), never by loosening this test.
- [ ] **Step 3:** Add the audit fields. Run `bm audit --manifest native/corpus/manifest.json --tier smoke --plan 30 --out <dir>` before (at the Task 1 commit) and after, and compare with `python3 native/tools/compare_scoreboards.py`. Gate: certified, floating and flagged are not worse on any model without a ledgered reason; played crossings and under floor are summed and must drop.
- [ ] **Step 4:** Record the results table in `native/README.md` ("Assembly motion, 2026-11-18").
- [ ] **Step 5: Commit** `test(native): the helicopter is built from its base up; audit reports what is played`.
