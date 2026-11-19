# Native Camera Director — Phase 1 (Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native camera that films a build. Planners only report what happens; a director turns those reports into a shot list. A camera body turns the shot list into a camera for each frame, for a given aspect ratio. bmshot, bmexport and bmview all use that camera.

**Architecture:**
- **New library `bmfilm`** in `native/film/`. It is portable C++ that links `bmcore` and does not use Metal.
- **The pipeline:**
  1. `beatsOf` turns a `plan::Timeline` into events (`film::Beat`).
  2. `direct` turns the events into a shot list (`film::Shot`).
  3. `shoot` turns the shot list, plus a frame shape, into a `film::Track` holding one `film::Frame` per frame.
  4. `measure` scores the track against the gates.
- **The render tools** convert a `film::Frame` into a `bmr::Camera` in `render/tools/common/engine.*`.
- **bmview** gets the track as one `plan::CameraKey` per frame in `timeline.camera`. That way `ViewportView.mm`, which holds the owner's uncommitted work, needs no change.

**Tech Stack:** C++20, CMake/Ninja, Catch2 v3, nlohmann/json; objective-C++ only in the existing render tools.

**Spec:** `docs/superpowers/specs/2026-11-19-native-camera-director-design.md`. Read it first. This plan covers its phase 1 (Engine). Phase 2 (the authored layer: saved tracks film by default, `--camera director`) gets its own plan.

## Global Constraints

- C++20; `-Wall -Wextra -Werror` (link `bm_warnings`); no new dependencies.
- Every constant lives in `native/film/include/bmf/tolerances.h` with a comment saying what it is and why it has its value. Code holds no unnamed numbers.
- Units: LDU, LDraw space (+y is down, so `up` is `{0,-1,0}`). Angles in radians internally. Azimuth uses `bmr::OrbitCamera`'s convention: 0 is the front view from −z, with +x to the right. Elevation above 0 means the eye is above the target.
- **Lens:** the vertical field of view is `2·atan(sensorMm / (2·lensMm))`. This is the web's `fovForLens` convention, so saved tracks match. Defaults: 50 mm lens, 36 mm sensor.
- **Editing rules:**
  - minimum shot length 1.5 s;
  - at most one cut per 4 s on average over any 20 s window;
  - no jump cuts: a cut changes the angle by at least 30° or the size by at least one class;
  - no cut crosses the line of action of a flight in progress;
  - a followed piece has more frame ahead of it than behind;
  - the seat of every landing is in the safe frame from the start of its hover to its rest.
- **Model front:** the LDraw front (azimuth 0) unless the project saves one. No guessing.
- **Waiting pieces stay out of the shot.** The floor is in frame only in the establishing shot and while a unit is built on its spot.
- **Determinism:** the same inputs give a bit-identical track, whether planned on 1 thread or 8.
- **Speed:** director plus body for one track takes under 5% of planning time at OMR p50, and under 1 s on the largest owner project.
- **Files off limits:**
  - Never stage the owner's uncommitted files.
  - Never touch `render/include/bmr/renderer.h`, `scene.h`, `render/src/metal/renderer.mm`, `render/src/prep/scene.cpp` or `render/tools/bmview/ViewportView.mm`.
  - Other work is editing `plan/timeline.*` and `bmexport/main.mm` at the same time. Re-read a file just before changing it, and stage only this work's hunks (`git add -p`).
- Tests run with `BM_LDRAW_DIR=$PWD/../public/ldraw BM_SHADOW_DIR=$PWD/../vendor/LDCadShadowLibrary` from `native/`. Test 258 (the lever) already fails on the baseline.

## Review Focus

- **An empty or one-piece build.** It still gets an opening and a finish shot, and no division by zero. Test: Task 4, `"a one-piece build has an opening and a finish"`.
- **A very tall, thin or flat model in 9:16 and 21:9.** The fit uses the projected points for that aspect, so the model is never cropped. Test: Task 1, `"a tall model fits a wide frame and a wide model fits a tall one"`.
- **A flight whose seat is hidden from every angle (inside the model).** The director picks the angle that sees most, and the measurement reports the miss rather than crashing. Test: Task 6, `"a seat no angle sees is reported, not hidden"`.
- **A build longer than an hour, or with thousands of flights.** The shot count is bounded by the cut-rate rule, and time grows linearly with flights. Test: Task 4, `"a long build keeps to the cut rate"`.
- **A subject that grows past the eye** (a tall part lands where the camera was). The body moves the eye out along the shot's arc and never jumps. Test: Task 5, `"the eye backs away from a part that grows into it"`.

---

## File Structure

```
native/film/CMakeLists.txt                 bmfilm library + bmfilm_tests (pattern: native/sound/CMakeLists.txt)
native/film/include/bmf/tolerances.h       every constant
native/film/include/bmf/lens.h  src/lens.cpp       lens → fov; fit a point set into the safe frame; composition offsets
native/film/include/bmf/beats.h src/beats.cpp      Beat, beatsOf(timeline, plan, model, world)
native/film/include/bmf/shots.h src/shots.cpp      Shot, Subject, Size, Move, Enter; JSON in/out
native/film/include/bmf/rules.h src/rules.cpp      editing-rule checks over a shot list
native/film/include/bmf/director.h src/director.cpp  direct(beats, ...) → shots (Reference style)
native/film/include/bmf/body.h  src/body.cpp       Frame, Track, FrameShape, shoot(...), cameraAt(...)
native/film/include/bmf/measure.h src/measure.cpp  Report, measure(...)
native/film/tests/fixture.h                 a Scene builder (as tests/plan_test.cpp's) + plan + timeline
native/film/tests/*_test.cpp
native/tools/bm/cmd_film.cpp                `bm film`
native/CMakeLists.txt                       add_subdirectory(film) (before render)
native/tools/bm/CMakeLists.txt, main.cpp, commands.h   link bmfilm, register `film`
native/render/CMakeLists.txt                bmtools_common links bmfilm
native/render/tools/common/engine.{h,cpp}   film track in Planned; toCamera(Frame); keys for bmview
native/render/tools/common/shot_options.{h,cpp}  --strip N
native/render/tools/bmshot/main.mm, bmexport/main.mm   use the track at --frame; --strip
```

---

### Task 1: The bmfilm library, lens and fit

**Files:**
- Create: `native/film/CMakeLists.txt`, `native/film/include/bmf/tolerances.h`, `native/film/include/bmf/lens.h`, `native/film/src/lens.cpp`, `native/film/tests/lens_test.cpp`
- Modify: `native/CMakeLists.txt` (add `add_subdirectory(film)` after `sound`)

**Interfaces:**
- Produces (namespace `bm::film`):
  - `double fovY(double lensMm, double sensorMm)`, in radians.
  - `struct FrameShape { double aspect = 16.0/9; double sensorMm = kSensorMm; double safe = kSafeFrame; };` where `safe` is the share of each side the subject may use.
  - `struct Rig { Vec3 target; double azimuth, elevation, distance, roll = 0, lensMm = kLensMm; };` plus `Vec3 eyeOf(const Rig&)` and `Vec3 upOf(const Rig&)`, which tilts `{0,-1,0}` by `roll`.
  - `double fitDistance(const std::vector<Vec3>& points, Vec3 target, double azimuth, double elevation, double lensMm, const FrameShape&, double fill)` returns the smallest distance at which every point lies within `fill` of the safe frame, both horizontally and vertically, for this aspect.
  - `Vec3 composedTarget(const std::vector<Vec3>& points, double azimuth, double elevation, Vec3 lead)` returns the aim point. It is the points' screen-space centre, shifted toward `-lead` so a followed subject gets lead room (`lead` is zero for a hold).
- Constants in `tolerances.h`:
  - `kLensMm = 50`, `kSensorMm = 36`;
  - `kSafeFrame = 0.9`;
  - `kFill[3] = {0.85, 0.6, 0.35}` for Wide, Medium and Close (the subject's share of the safe frame);
  - `kLeadShare = 0.12` (lead room, as a share of the frame);
  - `kMinDistance = 10`.

- [ ] **Step 1: Write the failing tests** (`lens_test.cpp`)
  - `"a 50 mm lens on 36 mm is 39.6 degrees tall"`: `REQUIRE(fovY(50, 36) == Approx(0.6911).margin(1e-4))`.
  - `"a cube fits exactly: every corner is inside the frame and one touches its edge"`: the eight corners of a 40 LDU cube, target at its centre, az 0.6, el 0.45, fill 1. Project each corner through `eyeOf` and `fovY` with aspect 16:9. Every |ndc| ≤ `safe` + 1e-6, and the largest equals `safe` within 1e-3.
  - `"a tall model fits a wide frame and a wide model fits a tall one"`: a 20×400×20 box at aspect 21:9, and a 400×20×20 box at aspect 9:16. Both fit by the same projection check. The tall box's limiting axis is vertical and the wide box's is horizontal.
  - `"lead room puts the subject behind the centre"`: with `lead = {1,0,0}` seen from the front, the subject's screen centre is left of 0 by `kLeadShare` ± 0.01.

- [ ] **Step 2: Run to see them fail.**
  Run: `cmake --build build && ./build/film/bmfilm_tests "[lens]"`.
  Expected: build error or FAIL on the missing functions.

- [ ] **Step 3: Implement `lens.cpp`**
  - **CMake:** `bmfilm` STATIC links `bmcore` publicly and `bm_warnings` privately. `bmfilm_tests` links `Catch2WithMain`, with `BM_FIXTURES` pointing at `${CMAKE_SOURCE_DIR}/tests/fixtures` and `catch_discover_tests`.
  - **`fitDistance`:** for each point, using the camera basis at `distance = 1`, solve in closed form the distance at which its normalised x and y reach the limit. Take the maximum, and never go below `kMinDistance`.

- [ ] **Step 4: Run.** `./build/film/bmfilm_tests "[lens]"`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(film): the camera's lens, and fitting what it films into the frame`.

---

### Task 2: Beats from the timeline

**Files:**
- Create: `native/film/include/bmf/beats.h`, `native/film/src/beats.cpp`, `native/film/tests/fixture.h`, `native/film/tests/beats_test.cpp`

**Interfaces:**
- Consumes:
  - `plan::Timeline`, `plan::Flight` (`startFrame`, `frames`, `phases`, `seatAt`, `parent`, `depth`, `appearFrame`, `flag`);
  - `plan::motionAt`, `plan::piecesOf`, `plan::stepsOf`;
  - `collide::World::box(piece)`.
- Produces:
  - `enum class BeatKind { Flight, UnitBuild, Step, Growth, Reveal, Motion };`
  - `struct Beat { BeatKind kind; int start, end; int flight = -1; double importance; Box seat; std::vector<int> steps; };`
    - `start` and `end` are frames.
    - `seat` is the world box of the flight's pieces at their seat, or the box of what the step adds.
  - `struct Beats {` with members:
    - `std::vector<Beat> list;` sorted by `(start, kind, flight)`;
    - `std::vector<Box> builtBox;` the box of everything seated, indexed by frame;
    - `Box model;`
    - `int frames;`
    - `}`
  - `Beats beatsOf(const plan::Timeline&, const plan::Plan&, const Model&, const collide::World&)`
  - `Box flyingBox(const Beats&, const plan::Timeline&, const plan::Plan&, const collide::World&, int flight, double frame)` gives the flight's pieces' box at that frame, using `motionAt` and the per-piece world boxes.
  - `std::vector<Vec3> corners(const Box&)`
- **Importance** is the sum of these weights, clamped to [0, 1]. Each weight is a constant in tolerances.h.
  - `kImportanceSize = 0.5` × the unit's box volume ÷ the model's.
  - `kImportanceUnit = 0.3` if the flight builds a unit (it has sub-flights).
  - `kImportanceFirst = 0.15` if it is a step's first flight.
  - `kImportanceSilhouette = 0.4` if `builtBox` grows by more than `kSilhouetteGrow = 0.08` of the model's height or width at its landing.

- [ ] **Step 1: Write the failing tests** (`beats_test.cpp`; `fixture.h` copies the `Scene` builder from `tests/plan_test.cpp:22-80` and adds `plan()` and `timeline()` helpers).
  - `"one flight per flown move, spanning its flight"`: 3 stacked bricks. `list` has 3 `Flight` beats, with `start == startFrame` and `end == startFrame + frames`. Each `seat` equals that brick's world box.
  - `"the built box grows as pieces land"`: `builtBox[0]` is empty, `builtBox[frames-1] == model`, and `builtBox` never shrinks.
  - `"a unit built on its spot is a UnitBuild beat before its flight"`: a two-brick submodel. One `UnitBuild` beat ends no later than its unit's `Flight` beat starts.
  - `"a tall last piece is more important than a small middle one"`: a 1×1 plate tucked in versus a 2×4 brick on top. The top's importance is higher by at least `kImportanceSilhouette` × 0.5.
  - `"the build ends in a Reveal beat"`: the last beat is `Reveal`, starting at the last landing and ending at `frames`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement `beatsOf` and `flyingBox`.** Steps come from the first flight of each new `stepsOf` value, in timeline order. The `Motion` kind is declared but not made in phase 1.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(film): what happens in a build, as beats a camera can film`.

---

### Task 3: The shot list

**Files:**
- Create: `native/film/include/bmf/shots.h`, `native/film/src/shots.cpp`, `native/film/tests/shots_test.cpp`

**Interfaces:**
- Produces:
  - `enum class SubjectKind { Model, BuiltSoFar, Unit, Piece, Point };`
  - `struct Subject { SubjectKind kind; int flight = -1; Vec3 point; };`
  - `enum class Size { Wide, Medium, Close };`
  - `enum class MoveKind { Hold, Push, Orbit, Crane, Follow, ArcReveal };`
  - `struct Move { MoveKind kind = MoveKind::Hold; double amount = 0; };` where `amount` is the push's distance factor, the orbit's radians (signed), or the crane's radians (signed).
  - `enum class EnterKind { Cut, Blend };`
  - `struct Shot {` with members:
    - `std::string id;`
    - `double start, end;` in seconds;
    - `Subject subject;`
    - `Size size;`
    - `double azimuth, elevation;` relative to the model's front;
    - `Move move;`
    - `double lensMm;`
    - `EnterKind enter;`
    - `double blendSeconds;`
    - `std::string origin;` set to `"auto"` in phase 1;
    - `bool pinned = false;`
    - `}`
  - `nlohmann::json toJson(const std::vector<Shot>&)` and `std::vector<Shot> shotsFromJson(const nlohmann::json&)`. Enums are written as lower-case names, angles in degrees and times in seconds.
  - `std::string shotId(const Shot&)` hashes the subject, size, rounded angle and start (to 0.1 s) into 8 hex characters. It is stable across runs.

- [ ] **Step 1: Write the failing tests**
  - `"a shot list survives JSON exactly"`: three shots, one of each enter kind. Round trip, then compare every field (doubles within 1e-9).
  - `"ids are stable and differ for different shots"`: the same shot built twice gets the same id; a shot with azimuth +31° gets a different id.
  - `"unknown names are refused"`: `"size":"huge"` makes `shotsFromJson` throw `std::runtime_error` naming the field.

- [ ] **Step 2: Run, see them fail. Step 3: Implement. Step 4: Run, PASS.**

- [ ] **Step 5: Commit** `feat(film): a shot list that can be saved, read back and edited`.

---

### Task 4: Editing rules and the Reference-style director

**Files:**
- Create: `native/film/include/bmf/rules.h`, `src/rules.cpp`, `include/bmf/director.h`, `src/director.cpp`, `tests/director_test.cpp`
- Modify: `tolerances.h`

**Interfaces:**
- Consumes: `Beats`, `Shot` and the related types, `corners`, `flyingBox`, and `collide::World`. The world is used for visibility: rays from candidate eyes to seat points pass through `collide::throughSurface` against the pieces seated by then.
- Produces:
  - `struct RuleMiss { std::string rule; std::string shot; double at; std::string detail; };`
  - `std::vector<RuleMiss> checkEditing(const std::vector<Shot>&, const Beats&, double fps)`. Rules are named `"min-length"`, `"cut-rate"`, `"jump-cut"`, `"line"` and `"lead"`; their values are in Global Constraints.
  - `struct DirectorStyle { double elStart, elEnd, finishEl, cutAt, insertThreshold, lensMm; };`
  - `DirectorStyle referenceStyle()`, with the values from the web's `reference` rules: elStart 60°, elEnd 15°, finishEl 10°, cutAt 0.8, insertThreshold 0.6, lens 50 mm.
  - `std::vector<Shot> direct(const Beats&, const plan::Timeline&, const plan::Plan&, const collide::World&, const DirectorStyle&, double fps, double front = 0)`
- **Constants:**
  - `kMinShotSeconds = 1.5`;
  - `kCutWindowSeconds = 20`, `kCutsPerWindow = 5`;
  - `kJumpCutRadians = 0.5236`;
  - `kAnticipateSeconds = 0.6`;
  - `kCoverageAzimuths = 16` (candidates round the model);
  - `kVisibilityRays = 9` per seat (corners and centre).

- [ ] **Step 1: Write the failing tests** (`director_test.cpp`)
  - `"a one-piece build has an opening and a finish"`: one brick, so `direct` returns at least 2 shots. The first is `Wide` on `BuiltSoFar` at elevation `elStart`; the last ends at `frames/fps` and faces the front (azimuth 0 ± 1e-9). Also `checkEditing` is empty.
  - `"the camera swings to the side being built"`: a base, then 6 bricks stepped onto its +x side (step 2), then 6 onto its −x side (step 3). The main shot covering step 2 has azimuth in (0, π), and step 3's is in (−π, 0).
  - `"elevation comes down as the model grows"`: a 10-brick tower, one per step. The main shots' elevations do not increase, and they run from `elStart` to within 5° of `elEnd` before the finish.
  - `"the move toward a scene starts before its first piece leaves"`: for the +x/−x model, the blend into step 3's shot starts at least `kAnticipateSeconds` before step 3's first `startFrame/fps`.
  - `"a long build keeps to the cut rate"`: 400 one-brick steps alternating ±x (Scene::add in a loop) give `checkEditing(...)` with no `"cut-rate"` or `"min-length"` misses, and `direct` takes under 0.2 s.
  - `"the same build directs the same shots"`: run `direct` twice and compare the JSON byte for byte.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement `checkEditing`.** It is a plain pass over consecutive shots. For `"line"`, take the flights in progress at each cut and require both shots' azimuths to be on the same side of the line from the flight's staging to its seat, projected on the floor.

- [ ] **Step 4: Implement `direct`** in the order the spec gives:
  1. Opening.
  2. Scenes. A scene is one `UnitBuild`, or a run of steps whose seats' centroids lie within 90° of each other round the model's vertical axis.
  3. Each scene's main shot:
     - Azimuth: the candidate (of `kCoverageAzimuths`) that sees the most of the scene's seat points, with ties going to the one closest to the previous shot.
     - Elevation: interpolated from `elStart` to `elEnd` by `builtBox` height ÷ model height.
     - Subject: `BuiltSoFar`, size `Wide`.
  4. Anticipation, as Blend shots starting `kAnticipateSeconds` early.
  5. Inserts: a `Close` `Piece` shot for each beat above `insertThreshold`, kept only if `checkEditing` stays clean with it.
  6. Finish at `cutAt` of the build: a Cut to `Medium` `Model` at azimuth 0 (relative to the front), elevation `finishEl`, then an `ArcReveal` move to the end.

  Merge any shot shorter than `kMinShotSeconds` into its neighbour.

- [ ] **Step 5: Run.** Expected: PASS.

- [ ] **Step 6: Commit** `feat(film): a director that turns a build into a shot list, by the editing rules`.

---

### Task 5: The camera body

**Files:**
- Create: `native/film/include/bmf/body.h`, `src/body.cpp`, `tests/body_test.cpp`
- Modify: `tolerances.h`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `struct Frame { Vec3 eye, target, up; double fovY; double focus, aperture, shutter; int shot; bool cut; };`
  - `struct Track { std::vector<Frame> frames; FrameShape shape; double fps; };`
  - `Track shoot(const std::vector<Shot>&, const Beats&, const plan::Timeline&, const plan::Plan&, const collide::World&, const FrameShape&, double fps, double front = 0)`
  - `Frame cameraAt(const Track&, double frame)` interpolates between whole frames, never across a `cut`, and clamps to the ends.
  - `Rig rigOf(const Frame&)` (the inverse of `eyeOf`), for bmview's keys.
- **Constants:**
  - `kEyeClearance = 8` LDU: from any shown piece's box, and above the floor plane.
  - `kSmoothSeconds = 0.5`: the zero-phase filter's window.
  - `kAvoidStep = 0.05` rad: the arc step when swinging clear.
  - `kFocusAperture = 0` (stored only).
  - `kShutter = 0.5`.

- [ ] **Step 1: Write the failing tests** (`body_test.cpp`)
  - `"every landing seat is in frame, in 16:9 and in 9:16"`: the ±x model from Task 4, shot at both aspects. For every `Flight` beat, from `seatAt` to rest, the seat's 8 corners project inside the safe frame.
  - `"the eye never enters the model or the floor"`: a 6-brick arch. For every frame, the eye is at least `kEyeClearance` − 1e-6 outside every shown piece's box, and its y ≤ the floor's (LDraw +y down).
  - `"the eye backs away from a part that grows into it"`: a close shot on a base, then a tall column landing where the eye was. The eye moves at most `kAvoidStep × distance × 2` per frame, and still meets the clearance.
  - `"motion inside a shot is smooth"`: the tower. Within each shot, the second difference of the eye is at most 0.5 LDU per frame², and the target jumps at most 2 LDU per frame.
  - `"a cut resets: the frame after a cut is the next shot's own"`: the frame after a `cut` is the next shot's solved frame, with no blend from before.
  - `"cameraAt between frames is between them, and not across a cut"`.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement `shoot`.** For each frame:
  1. Resolve the shot's subject points (`corners` of the built, unit, flying or model box).
  2. Rig angles: the shot's angle plus its move's progress, eased by minimum jerk over the shot.
  3. `fitDistance` with `kFill[size]`.
  4. `composedTarget`, with lead set to the flying piece's velocity direction for `Follow`.
  5. Avoidance: while the eye is within `kEyeClearance` of a shown piece's box or the floor, step the azimuth by `kAvoidStep` toward the side with more room, then raise the elevation, at most 32 steps. If nothing is clear, raise the distance.

  Then, for each rig channel, run a zero-phase moving-average over `kSmoothSeconds`. The filter runs forward and back and resets at each cut. Azimuth is unwrapped before smoothing.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(film): a camera body that films any shot for any frame shape, clear of the model and smooth`.

---

### Task 6: Measurements and `bm film`

**Files:**
- Create: `native/film/include/bmf/measure.h`, `src/measure.cpp`, `tests/measure_test.cpp`, `native/tools/bm/cmd_film.cpp`
- Modify:
  - `native/tools/bm/CMakeLists.txt`: link `bmfilm`.
  - `native/tools/bm/commands.h`: add `int cmdFilm(const Args&)`.
  - `native/tools/bm/main.cpp`: register `film` with the help text `"the camera: the shot list and how it films the build"`.

**Interfaces:**
- Produces:
  - `struct Report {` with members:
    - `int landings, landingsInFrame;`
    - `std::vector<int> missed;` the flight indices;
    - `int insideFrames;`
    - `double maxJerk, maxTargetJump;`
    - `double cutsPerMinute, shortestShot;`
    - `std::vector<RuleMiss> rules;`
    - `double ms;` the director plus body time;
    - `}`
  - `Report measure(const Track&, const std::vector<Shot>&, const Beats&, const plan::Timeline&, const plan::Plan&, const collide::World&)`
  - **`bm film <file> [--aspect W:H] [--fps N] [--out shots.json] [--correct] [--threads N]`**
    - It plans as `bm plan` does (the same `plan::planModel`, the same `--correct`).
    - It prints the shots as one line each, `start–end  size  subject  az/el  move  enter`.
    - It then prints the report as `landings in frame N of M`, `inside 0`, `jerk`, `cuts/min`, `shortest`, and the rule misses.
    - `--out` writes the shot list JSON together with `"report"`.

- [ ] **Step 1: Write the failing tests**
  - `"a seat no angle sees is reported, not hidden"`: a brick enclosed by a box of 6 bricks round it, placed last-but-one. `measure` lists that flight in `missed`, and does not crash.
  - `"a clean build measures clean"`: the tower, at 16:9. `landingsInFrame == landings`, `insideFrames == 0`, `rules` is empty.

- [ ] **Step 2: Run, see them fail. Step 3: Implement `measure` and `cmd_film.cpp`. Step 4: Run, PASS.**

- [ ] **Step 5: Run it on Deadpool.**
  Run: `BM_LDRAW_DIR=$PWD/../public/ldraw build/tools/bm/bm film "/Users/mac/Projects/BrickMotion-Data/01 - Deadpool/deadpool.mpd" --correct`
  Expected: a shot list, and `inside 0`. Note the landings figure for Task 8.

- [ ] **Step 6: Commit** `feat(film): the camera measured, and bm film to show it`.

---

### Task 7: The apps film with the director

**Files:**
- Modify:
  - `native/render/CMakeLists.txt`: `bmtools_common` links `bmfilm`.
  - `native/render/tools/common/engine.{h,cpp}`.
  - `native/render/tools/common/shot_options.{h,cpp}`.
  - `native/render/tools/bmshot/main.mm`.
  - `native/render/tools/bmexport/main.mm`. Re-read it first; other work is editing it.
  - `native/render/tools/bmview/AppDelegate.mm`.

**Interfaces:**
- Consumes: `direct`, `shoot`, `cameraAt`, `rigOf`, `beatsOf`, `referenceStyle`.
- Produces:
  - `bmtools::Planned` gains `std::vector<bm::film::Shot> shots; bm::film::Track track;`.
  - `planModel(..., double aspect = 16.0 / 9)` fills them, after planning, with the world it already built.
  - `bmr::Camera bmtools::toCamera(const bm::film::Frame&, double aspect)`.
  - `void bmtools::keysFromTrack(const bm::film::Track&, bm::plan::Timeline&)` replaces `timeline.camera` with one `CameraKey` per frame from `rigOf`. This is how bmview plays the director's camera; the lens stays bmview's.
  - `ShotOptions::strip` (`--strip N`): bmshot writes N frames, evenly spaced from 0 to the end, as one contact sheet PNG in a grid of `ceil(sqrt(N))` columns at `--size` each, in reading order, with no labels.

- [ ] **Step 1: Write the failing test.** Create `native/render/tests/film_camera_test.cpp`; the owner's uncommitted `scene_test.cpp` is not touched. Add `bmtools_common` to `bmrender_tests`' links in `native/render/CMakeLists.txt`. The test `"toCamera keeps the eye, target and lens of a frame"` builds a `Frame` by hand and checks that the `bmr::Camera` fields equal it, with `aspect` passed through.

- [ ] **Step 2: Run, see it fail. Step 3: Implement.**
  - **engine:** compute beats, shots and track in `planModel`.
  - **bmshot and bmexport still:** at `--frame N` with no explicit camera or azimuth, use `toCamera(cameraAt(track, N), aspect)`, where the aspect is `--size` width over height.
  - **bmview:** `AppDelegate` calls `keysFromTrack` before `session->planned` is set.

- [ ] **Step 4: Run** `ctest --test-dir build -R "film|toCamera"`. Expected: PASS. Then run the whole suite. Expected: only test 258 fails, as it does on the baseline.

- [ ] **Step 5: Commit**, staging only this work's hunks: `feat(native): bmshot, bmexport and bmview film the build with the director's camera`.

---

### Task 8: Measured on the owner's projects, shown to the owner

**Files:**
- Modify: `native/README.md` (a "Camera director" results section), `native/film/include/bmf/tolerances.h` (if tuning is needed)
- Create: `native/film/tests/corpus_film.sh` (the measurement loop, kept for reruns)

- [ ] **Step 1: Measure.** Write `corpus_film.sh`.
  - It runs `bm film --correct` at 16:9 and at 9:16 on the 19 projects, `/Users/mac/Projects/BrickMotion-Data/*/*.brickmotion`, and on the corpus smoke tier (`native/corpus/manifest.json`, `--tier smoke`).
  - It collects each report into one table: model, landings in frame, inside, jerk, cuts/min, shortest, rule misses, ms.
  - Expected: `inside 0` everywhere. Director landings in frame 100% on the 19 projects, or each miss listed with its cause. No rule misses.

- [ ] **Step 2: Fix and retune** constants where the gates miss, rerunning Step 1 each time. Record each change and why in tolerances.h comments.

- [ ] **Step 3: Check determinism and speed.**
  - Run `bm film --threads 1` and `--threads 8` on Deadpool and two OMR files, with `--out`. Expected: the JSON files are identical (`cmp`).
  - Expected time: `ms` under 5% of `bm plan`'s plan time at OMR p50, and under 1 s on the largest owner project.

- [ ] **Step 4: Make the contact sheets.**
  - Run `bmshot --strip 16 --size 640x360` and `--size 360x640` for Deadpool, Hellboy and Batgirl, with `--correct`.
  - For comparison, make the same strips with today's orbit (`git stash` the engine change, or from the commit before Task 7).
  - Put them in the session scratchpad and send them to the owner.

- [ ] **Step 5: Owner gate.** The owner approves the look by eye. Until they do, the phase is not done; their notes become tuning or follow-up tasks.

- [ ] **Step 6: Commit** `docs(native): the camera director measured on the owner's projects and the corpus`.

---

## Self-review notes

- **Spec coverage:**
  - Events: Task 2.
  - The shot list as plain, serialisable data: Task 3.
  - The director, the editing rules, the style and the front: Task 4.
  - The body (lens, fit, composition, avoidance, smoothing, focus and shutter stored): Tasks 1 and 5.
  - Every app showing the same camera: Task 7.
  - Measurements and gates: Tasks 6 and 8.
  - The authored layer, the other styles, `Motion` beats and editing in bmview belong to later plans (spec phases 2–4).
- **Interface types** are checked across tasks: `Beats`, `Shot`, `Track`, `Frame`, `FrameShape`, `Rig`, `RuleMiss` and `Report`.
- **Task 7's test file is new,** so the owner's uncommitted `scene_test.cpp` is not touched.
