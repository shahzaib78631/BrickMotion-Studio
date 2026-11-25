# BrickMotion Desktop — Milestone 5 (Animate & Camera) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rust app animates and films the model:
- A Keyframes clock beside the Build clock. Hand keys in the Keys track and its dope sheet: insert, select, retime, delete, interpolation, prev/next key, the key scene (fps, range, Build link), Auto Key from the gizmo.
- Bake flights to keys, Edit Flight as Keys, the flight path in the viewport, Use Edited Flight in Build, Return Flight to Planner, and Check Motion.
- The Camera track on both clocks: keys from the view, drag, 19 move presets, Look At, Auto-direct (six styles), Follow Camera, Clear. A Camera inspector (key and move fields) and named scene cameras.
- The Motion editor (project / step / parts: flight time, landing, hover, easing, inherited values, flight timing bar).
- Joint markers and the joint card (turn ±15°, detach, select rigid body), plus the insertion (arrival) direction.

**Architecture:**
- **Engine:** keys, key scene, flight bake, flight paths, motion audit, camera tracks, Auto-direct, scene cameras, motion fields, joint changes and insertion direction already live in `bmapp`. These are `Session::keyTracks/setKeys/moveKeys/moveKeyRows/setKeyScene/addFlightPathPoint/applyFlightBake/useFlightInBuild/cameraKeys/addCameraKey/setCameraKey/autoDirectCamera/sceneCameras/motionFields/setInsertionDirection/placeMoved`, `Viewport::useKeyframes/captureFlightBake/flightPath/dragFacingView/auditMotion/cameraDirectorInput/captureSceneCamera/cameraTrackView/setDirectorPreview`, and `AssemblyInspection::inspect/body/changeJoint`.
- **Swift logic moves down first (Task 2), as M4 Task 3 did:**
  - `KeyframeTracks` builds the object list and markers, clamps retimes and finds the adjacent key;
  - `KeyframeGroupTracks` computes the offset limits;
  - `KeyframeTracks.link` computes the scene length;
  - `AnimationWorkspace.openFlightKeys` computes the start time;
  - `ViewportView` converts a gizmo drag into key values for Auto Key;
  - `MotionEditor.effective` resolves inherited fields;
  - `FlightTiming` computes the phases;
  - `CameraClockInfo.of` computes the clock;
  - `CameraLaneMenu.addKey` applies the half-frame rule and `canAutoDirect`;
  - `CameraKeyMenu.aim` aims a key.

  This all goes into three new bmapp headers with Catch2 tests, and the Swift app is rewired to call them.
- **bmffi** grows three ABI groups, each in its own source file, following the M2–M4 conventions: guards, `BmChange`, owned list handles for anything with strings, two-call arrays and `bm_struct_size`.
  - `keys.cpp`: key scene, key objects, keys, key rows, flight paths, flight routes.
  - `camera.cpp`: camera track, presets, Auto-direct, scene cameras, export camera.
  - `motion.cpp`: motion fields, flight bake, motion audit, assembly inspection, joints, insertion direction.
- **bm** wraps them in `keys.rs`, `camera.rs` and `motion.rs`. `FlightBake`, `MotionAudit` and `AssemblyInspection` are `Send` (not `Sync`) handles that run on a Rust worker.
- **brickmotion** gets:
  - a clock in `Transport` (Build | Keyframes);
  - `chrome/camera_lane.rs`, `chrome/keys_track.rs` and `chrome/dope_sheet.rs`;
  - three Properties pages: `chrome/camera_page.rs`, `chrome/motion_page.rs` and `chrome/keys_page.rs` (key value editor and key scene);
  - `chrome/joints.rs` (markers and joint card);
  - `flight_path.rs` (viewport overlay);
  - `workers.rs` (bake, audit and inspection jobs guarded by generation and version).

**Tech Stack:** As M4. No new crates.

**Spec:** `docs/superpowers/specs/2026-11-25-rust-egui-app-design.md`, milestone 5:
> "Animate & camera: keyframes, camera lane, auto-direct, motion/joints."

The parity ledger `docs/superpowers/specs/2026-11-19-native-app-parity.md` is the behaviour reference:
- §4: tools ("joints on/off", "aim the way in") and the joint card.
- §7: camera lanes, the Motion popover, the dope sheet and the Camera inspector.
- §8: scene cameras.

The Swift files these rows describe are `KeyframeTracks.swift`, `KeyframeGroupTracks.swift`, `CameraTrackLane.swift`, `CameraKeyInspector.swift`, `MotionWorkspace.swift`, `JointCard.swift`, `AssemblyReview.swift`, `EditorOverlays.swift` (flight path and joint markers), `ArrivalDirection.swift`, `AnimationWorkspace.swift` (`tab`, `seekScene`, `editFlight`, `runBake`, `checkMotion`) and `ViewportView.swift` (Auto Key, path-point drag). Match their behaviour. Never copy logic into Rust: Task 2 moves it into bmapp first.

Builds on branch `feat/desktop-m1` after M4 (`8cec8178`) and the M4 review fixes (`62c29dc6`). Rulings so far: `desktop/docs/m2-rulings.md`, `m3-rulings.md`, `m4-rulings.md`.

## Global Constraints

- **M1–M4 Global Constraints still hold:**
  - Calm UI: one stroke-icon family, one blue accent `#4f8cff`, orange only for the playhead, an 8-px grid, 12.5-pt text in two weights.
  - Bundle id `com.brickmotion.studio.rs`.
  - Stage named files only. No commits on `main`.
  - Tests use `new_for_test` / `new_for_test_cc` and never touch the real support folder.
  - The session stays single-threaded, and the timeline is read only on a new Ready version.
- **The approved M4 look carries on** (`m4-rulings.md`): Properties pages are 344 px wide with the inset-form widgets in `chrome/widgets.rs` (`slider_row` / `SliderEvent`, `popup_row`, `segmented`, `switch_row`, `section_header`, `inset_group`, `page_footer`); tracks start collapsed; actions appear on hover and in right-click menus. New screens are mocked up and approved before they are built (Task 1).
- **Engine edits are allowed only where the spec says logic moves down:** `native/app/bmapp/include/bmapp/key_tracks.h`, `camera_lane.h` and `motion_fields.h`, their `.cpp` files, tests and CMake lines. Keyframe, flight, camera-director and joint algorithms do not change (spec non-goal).
- **The Swift app stays green and calls the moved logic:**
  - after Task 2, `ctest --test-dir native/build-app` passes with at least 634 tests (`brickmotion_selftest_motion` included) and `native/build` with 462 or more;
  - `bmapp_tests` run in `native/build-rust` (`BM_APP_LIB=ON`), as the M4 Task 3 ruling says.
- **Undo, the M5 rule:**
  - **Live while dragging, one undo step:** calls with a `continuing` flag (`setKeys`, `setCameraKey`, `setCameraMove`, `setFlightPathPoint`) follow Swift's two patterns.
    - Camera sliders (`CameraSliderRow`) send `false` on a drag's first change and `true` after it. A keyboard change is its own step.
    - The Auto Key gizmo and the path-point drag call `end_gesture` at drag start and send `true` on every write.

    Both end with `end_gesture` on release.
  - **Commit once, on release:** calls without that flag (`moveKeys`, `moveKeyRows`, `moveCameraKey`, `setMotionFields`, `setKeyScene`, `chooseCameraPreset`), or on Return / focus loss for a typed field.
- **Worker jobs:** `FlightBake::prepare`, `MotionAudit::check`, `AssemblyInspection::inspect` and `AssemblyInspection::changeJoint` run on one `bm-anim` worker thread each, never on the UI thread.
  - A result is applied only if `(session.generation(), session.version())` still equals what was captured. Otherwise the app shows Swift's message: "The animation changed while it was being checked." for an audit; for a bake or joint, the result is dropped silently and the page refreshes.
  - The capture calls themselves (`capture_flight_bake`, `audit_motion`, `AssemblyInspection::capture`) run on the UI thread, as in Swift.
- **Clocks:**
  - The Build clock counts seconds of the planned Build, as in M4.
  - The Keyframes clock counts seconds from the key scene's `first` frame: `frame = first + round(seconds × fps)`.
  - Its playback length, lane and seek scale are `(last − first) / fps`; this is `Viewport::length()` under `useKeyframes`.
  - The camera clock's duration is `(last − first + 1) / fps`. The two lengths differ on purpose (Swift). Task 2 pins both, and nothing may unify them.
  - The Keyframes clock needs no plan while the scene is not linked to the Build. A linked scene shows time only once the Build is planned (`canShowTime`), as in Swift.
  - `Clock::camera_clock()` maps Build to `CameraClock::Build` and Keyframes to `CameraClock::Timeline`.
- **Units:** key positions are in studs (LDU ÷ 20); rotation is in degrees; scale is a factor; visibility is 0 or 1. Swift's `KeyProperty` titles and suffixes (" studs", "°", "×") are the display copy.
- **Keys:** no new single-key shortcuts. The commands are `video.add_key` (Insert Key), `video.bake_flight`, `video.group` (the group summary rows), `video.camera_key` (Add Camera Key from View), `video.auto_direct` and `video.follow` (Follow Camera), plus new ones: `view.joints` (Joint Markers) and `object.arrival_direction` (Set Insertion Direction…). They go live in their tasks: `When::Soon` changes to a real condition.

## Scope by ledger row

| Ledger row | Milestone |
|---|---|
| §7 Build / Timeline / Motion modes: the Keyframes clock | **M5** (Task 6) |
| §7 Parts lane clip menu "Motion…", "Edit Flight as Keys", "Return Flight to Planner" | **M5** (Tasks 10, 11) |
| §7 Camera lanes (keys, moves, Auto-direct presets, key from view) on both clocks | **M5** (Task 7) |
| §7 Motion popover (presets, flight time, landing, hover, easing; project/step/part) | **M5** (Task 11) |
| §7 Dope sheet (insert key, Auto Key, prev/next, object list, properties, interpolation, scene range, check motion, Build link, bake) | **M5** (Tasks 9, 10) |
| §7 Camera inspector (target, position, lens, moves, easing, shake, blur, presets) | **M5** (Task 8) |
| §8 Scene cameras (capture, recall, rename, replace, remove, use for video, export camera) | **M5** (Task 8) |
| §4 Tools: joints on/off, aim the way in (insertion direction) | **M5** (Task 12) |
| §4 Joint card: hinge/ball angle, turn, select rigid group, detach | **M5** (Task 12) |
| §8 Mechanism lab | **Not in M5.** bmapp has no mechanism engine (ledger "P (bm/kin)"). The spec says the Rust app gets it when the engine does. |
| Tracks ↔ Curves (graph editor) | **Not in M5.** The ledger row is a dope sheet; keys have Smooth/Linear/Hold only (no bezier handles), and Swift has no graph editor. The Curves toggle stays drawn but disabled with a "coming soon" tooltip, as M4 did with the header tools. |
| Keyframes movie export, Export with camera track | **M6** (Output) |
| §8 Checks (Model Checks list) | **M7**; M5 uses `AssemblyInspection` only for joints |

## Review Focus

1. **A worker result arriving after the document changed** (bake, Check Motion, joint turn or detach, joint inspection): it is never applied to the newer version, and the user sees the stale message or a refreshed page, never a wrong pose or a double undo step. Tests: Task 10 `bake_result_after_edit_is_dropped`, `motion_check_after_edit_says_changed`; Task 12 `joint_change_after_edit_is_dropped`.
2. **A drag that spans many frames** (a camera-key slider, a flight-path point, an Auto Key gizmo drag, a key retime, a Motion slider): exactly one undo step, and for flag-less calls one engine call, on release. Tests: Task 8 `camera_slider_drag_is_one_undo_step`; Task 9 `auto_key_drag_is_one_undo_step`, `retime_drag_is_one_call`; Task 10 `path_point_drag_is_one_undo_step`; Task 11 `motion_slider_commits_once`.
3. **Switching clocks while playing or planning, and the Keyframes clock with no plan:**
   - keys, the Timeline camera track and Check Motion work without a plan;
   - Build-only actions (Auto-direct on the Timeline clock when not Build-linked, bake) are disabled with a reason;
   - switching stops playback and never mixes a Build-clock time into a Keyframes seek.

   Test: Task 6 `keyframes_clock_needs_no_plan`, `clock_switch_stops_playback`.
4. **Selections held by id across undo, redo and delete:**
   - a camera key or move selection clears when its key is gone;
   - a key selection follows a retime by the applied offset;
   - an open joint card closes when its two pieces no longer share a joint.

   Tests: Task 7 `camera_selection_clears_when_key_goes`; Task 9 `key_selection_follows_retime`; Task 12 `joint_card_closes_when_joint_goes`.
5. **A big model** (10294-1, 9,720 pieces) with the Keys track expanded: the key-object list is built once per session version (it reads `stepItems` for every step), and a timeline frame stays under 16 ms. Test: Task 9 `big_model_keys_track` (ignored; `BM_BIG_MODEL`).

---

## File Structure

| File | Responsibility |
|---|---|
| `native/app/bmapp/include/bmapp/key_tracks.h`, `src/key_tracks.cpp`, `tests/key_tracks_test.cpp` | Key objects + markers, offset limits, adjacent key, Build link, flight-keys start, Auto Key values |
| `native/app/bmapp/include/bmapp/camera_lane.h`, `src/camera_lane.cpp`, `tests/camera_lane_test.cpp` | Camera clock, key at playhead, can Auto-direct, add key from view, aim, Auto-direct with Session + Viewport |
| `native/app/bmapp/include/bmapp/motion_fields.h`, `src/motion_fields.cpp`, `tests/motion_fields_test.cpp` | Effective (inherited) motion fields, flight phases |
| `native/app/BrickMotion/{KeyframeTracks,KeyframeGroupTracks,CameraTrackLane,MotionWorkspace,AnimationWorkspace,ViewportView}.swift` | Rewired to the three headers (Task 2) |
| `desktop/bmffi/src/keys.cpp`, `camera.cpp`, `motion.cpp`; `tests/keys_test.cpp`, `camera_test.cpp`, `motion_test.cpp` | ABI |
| `desktop/crates/bm/src/keys.rs`, `camera.rs`, `motion.rs`; `tests/keys.rs`, `camera.rs`, `motion.rs` | Safe wrappers |
| `desktop/crates/brickmotion/src/transport.rs` | `Clock` (Build / Keyframes), scene seek, Keyframes timing |
| `desktop/crates/brickmotion/src/workers.rs` | `Job<T>`: a worker thread + `(generation, version)` guard; bake, audit, inspect, change-joint |
| `desktop/crates/brickmotion/src/chrome/camera_lane.rs` | Camera track lane + menus (both clocks) |
| `desktop/crates/brickmotion/src/chrome/camera_page.rs` | Camera inspector page (key / move panels) + scene cameras + export camera |
| `desktop/crates/brickmotion/src/chrome/keys_track.rs` | Keys track: object rows, markers, group rows, row picks |
| `desktop/crates/brickmotion/src/chrome/dope_sheet.rs` | Property lanes of the chosen object(s): key select, box select, retime, delete, interpolation, prev/next |
| `desktop/crates/brickmotion/src/chrome/keys_page.rs` | Key value editor (insert / update key), key scene, bake, Check Motion results |
| `desktop/crates/brickmotion/src/chrome/motion_page.rs` | Motion editor page |
| `desktop/crates/brickmotion/src/flight_path.rs` | Flight path overlay and point gestures in the viewport |
| `desktop/crates/brickmotion/src/chrome/joints.rs` | Joint markers, joint card, insertion direction row |
| `desktop/crates/brickmotion/src/chrome/{timeline,parts_lane,properties,inspector}.rs`, `viewport.rs`, `commands.rs`, `app.rs` | Wiring |
| `desktop/crates/brickmotion/tests/{keys,camera,motion,joints}.rs` | App tests |
| `desktop/docs/m5-rulings.md`, `m5-*.png` | Approved design, checks and screenshots |

---

### Task 1: Mockups for the M5 screens (owner gate)

**Files:** `.superpowers/brainstorm/<session>/content/m5-animate.html` (git-ignored); `desktop/docs/m5-rulings.md`.

The owner wants screens mocked up and approved before they are built (spec "Swift app frozen", memory "calm professional UI"). Start from the approved M4 v4 file (`.superpowers/brainstorm/65433-1795584607/content/m4-build-play-v4.html`) so the shell, track heads and Properties pages look the same.

- [ ] **Step 1: Write one HTML file with seven screens**, using M4 v4's CSS and macOS inset-form style:
  1. the timeline on the Keyframes clock (clock switch, Camera track with keys and move clips, Keys track expanded to object rows with markers, dope sheet lanes);
  2. the Camera inspector page (key panel; move panel);
  3. scene cameras and export camera;
  4. the Keys page (value editor, interpolation, key scene, Build link, Bake, Check Motion results);
  5. the Motion page (scope, inherited values, flight timing bar);
  6. the joint card over the viewport with markers;
  7. the flight path in the viewport.
- [ ] **Step 2: Ask the owner four questions with the file**, one `AskUserQuestion` with previews:
  1. Where is the clock switch? The recommendation is a two-segment control, Build | Keyframes, left of the transport. Swift uses tabs.
  2. Does the Build track hide or dim on the Keyframes clock? The recommendation is to hide it; the Camera track shows the Keyframes clock's track.
  3. Is the Motion editor a Properties page or a popover? The recommendation is a Properties page (M4 ruling: settings open as pages).
  4. Is the Curves toggle disabled (recommended) or hidden?
- [ ] **Step 3: Iterate until approved**, then record every ruling in `desktop/docs/m5-rulings.md`. The approved design wins over this plan's text. Commit:

```bash
git add desktop/docs/m5-rulings.md
git commit -m "docs(desktop): M5 approved mockup rulings"
```

Tasks 2–5 need no answer and run while waiting. Tasks 6–12 start after approval.

### Task 2: Animation logic moves into bmapp

**Files:**
- Create: `native/app/bmapp/include/bmapp/key_tracks.h`, `camera_lane.h`, `motion_fields.h`; `src/key_tracks.cpp`, `camera_lane.cpp`, `motion_fields.cpp`; `tests/key_tracks_test.cpp`, `camera_lane_test.cpp`, `motion_fields_test.cpp`.
- Modify: `native/app/bmapp/CMakeLists.txt`, `include/module.modulemap`, the six Swift files in the File Structure table.

**Interfaces:**
- Produces (C++; `namespace bmapp`):
  - `struct KeyMarker { int32_t frame; size_t channels; }`
  - `struct KeyObject { uint32_t piece; bool submodel; std::string name; bool baked; bool keyed; KeyList keys; PieceList members; std::vector<KeyMarker> markers; }`
  - `std::vector<KeyObject> keyObjects(const Session*)`. The rules are `KeyframeTracks.refresh`:
    - one object per key track, its id `(object, submodel = !baked && !isLocalPiece(object))`;
    - markers count keys per frame, sorted by frame;
    - every step item not yet listed is added (id `(pieces[0], item.submodel)`, name = submodel name or part description);
    - order: keyed first, then piece ascending, then submodel before part.
  - `struct OffsetLimits { int32_t lower, upper; }` and `OffsetLimits keyOffsetLimits(const KeyScene&, int32_t earliest, int32_t latest)` returns `{first − earliest, last − latest}`; an empty pick (earliest > latest) gives `{0, 0}`. `int32_t clampOffset(OffsetLimits, int32_t)`.
  - `bool adjacentKeyFrame(const std::vector<KeyObject>&, int32_t frame, bool after, int32_t* out)` finds the nearest marker frame strictly after or before `frame`.
  - `KeyScene linkedKeyScene(KeyScene, bool enabled, double buildDuration)`: when enabled, `last = max(last, buildStart + ceil(buildDuration / buildSpeed × fps))`.
  - `double flightKeysStart(const KeyScene&, double flightStart)` returns `min((buildStart − first)/fps + flightStart/buildSpeed, (last − first)/fps)`.
  - `enum class GizmoTool { Move, Rotate, Scale }` and `KeyList autoKeyValues(GizmoTool, Vec3 origin, Vec3 change, int32_t frame)`. Every key is `Smooth`. `origin` is the three channel values read with `keyValue` at the drag's start.
    - Move: change is the total drag in LDU, giving `origin + (x/20, −y/20, −z/20)` on PositionX/Y/Z.
    - Scale: change is the total factors `f`, giving `origin + origin × (f − 1)` on ScaleX/Y/Z.
    - Rotate: change is `handleAxis × degrees` (engine axes), giving `origin + (x, −y, −z)` on RotationX/Y/Z.

    These are the conversions in `ViewportView.swift` lines 337–400.
  - `struct AutoKeyTarget { bool ok; uint32_t piece; bool submodel; }` and `AutoKeyTarget autoKeyTarget(const Session*, const PieceList& selection, bool autoKey, int64_t keySubmodel)`. Pass −1 when there is no key submodel. This is `ViewportView.swift` 298–306:
    - `ok` is false when Auto Key is off or the selection is empty;
    - `piece = selection[0]`;
    - `submodel = !isLocalPiece(piece) && (keySubmodel == piece || selection.size() > 1 || !hasEditableFlightKeys(piece))`;
    - `ok` also needs `usePieces(piece) == selection` when `submodel` is true, else `selection.size() == 1`.
  - `struct CameraClockInfo { CameraClock clock; double fps, duration; bool ready; }`. `CameraClockInfo cameraClockInfo(CameraClock, const Session*, double buildFps, double buildDuration, bool buildReady)`. On the Timeline clock, `duration = (last − first + 1)/fps` and `ready = true`.
  - `bool cameraKeyAt(const std::vector<CameraTrackKey>&, double now, double fps, std::string* id)` finds a key within half a frame of `now`.
  - `bool canAutoDirect(CameraClock, const Session*, bool buildReady)` returns `buildReady && (clock == Build || keyScene().buildLinked)`.
  - `struct CameraKeyResult { Changed changed; std::string id; bool added; }`. `CameraKeyResult addCameraKeyFromView(Session&, Viewport&, CameraClock, double now, const CameraClockInfo&)`:
    - if a key is within half a frame of `now`, it calls `setCameraKeyView` on that key;
    - otherwise it calls `addCameraKey` and returns the id of the key nearest `now`.
  - `Changed aimCameraKey(Session&, Viewport&, CameraClock, const CameraTrackKey&, const std::string& target)`:
    - the same target is a no-op;
    - `"point"` sets the key's view from `cameraTrackView(key.seconds)`;
    - anything else calls `setCameraKeyTarget`.
  - `Changed autoDirect(Session&, Viewport&, CameraClock, const std::string& style)` calls `autoDirectCamera(clock, viewport.cameraDirectorInput(), style, 50)`. It adds no copy of its own: a refusal is whatever `autoDirectCamera` returns. Callers gate it with `canAutoDirect`, as Swift disables the menu.
  - `MotionFields effectiveMotion(const Session*, MotionScope, size_t step, const MotionFields&)`. The defaults are `{1, 0.25, 0, 0}`; the order is `MotionWorkspace.effective`.
  - `struct FlightPhases { double travel, hover, landing; }` and `FlightPhases flightPhases(const MotionFields&)`, where `hover = min(hover, max(0, 0.95 − landing))`, `travel = 1 − landing − hover`.

- [ ] **Step 1: Write the failing Catch2 tests** (tags `[key tracks]`, `[camera lane]`, `[motion fields]`, helicopter fixture as in `build_lanes_test.cpp`):
  - `"key objects list step items and keyed first"`: after `setKeys(p, {PositionX@10, PositionY@10, PositionX@20})` on a local piece, that object is first, `keyed`, with markers `{10:2, 20:1}`. Every other step item appears once.
  - `"offset limits clamp to the scene"`: scene 1–250, picks 10–40 give `{−9, 210}`; `clampOffset({−9,210}, 300) == 210`; an empty pick gives `{0, 0}`.
  - `"adjacent key frame"`: markers 10, 20 at frame 15 give after 20 and before 10; at frame 20, after is false.
  - `"linking extends the scene"`: fps 24, first 1, last 50, buildStart 1, speed 1, duration 4.0 gives `last == 97`. Unlinking keeps 97.
  - `"flight keys start"`: fps 24, first 1, buildStart 25, speed 2, flightStart 3.0 gives 2.5. It is clamped to `(last − first)/fps`.
  - `"auto key values"`:
    - Move at origin (1, 2, 3) with change (20, 40, −60) gives (2, 0, 6) on PositionX/Y/Z at the frame, all Smooth.
    - Scale at origin (1, 1, 2) with factors (2, 1, 0.5) gives (2, 1, 1).
    - Rotate at origin (0, 10, 0) with change (0, 30, 0) gives (0, −20, 0).
  - `"auto key target"`:
    - Auto Key off gives not ok;
    - one local piece gives ok and not submodel;
    - two local pieces give not ok;
    - a submodel use's piece with `keySubmodel` equal to it, and the selection equal to `usePieces`, gives ok and submodel.
  - `"camera clock on the timeline"`: scene fps 24, first 1, last 48 gives duration 2.0, ready, while the seek scale `(last − first)/fps` is 47/24.
  - `"camera key at the playhead"`: keys at 1.0 and 2.0 with fps 30; 1.01 finds 1.0, 1.02 finds none.
  - `"can auto-direct"`: Build and ready gives true; Timeline unlinked gives false; Timeline linked and ready gives true; not ready gives false.
  - `"effective motion inherits"`: project time 2, step landing 0.4, parts fields all −1, so Parts gives `{2, 0.4, 0, 0}`. Step scope ignores step fields of another step.
  - `"flight phases"`: landing 0.25, hover 0.9 gives hover 0.7, travel 0.05; landing 0.25, hover 0 gives travel 0.75.
  - With Metal (skip otherwise):
    - `"add key from view replaces the key at the playhead"`: plan, add at 1.0 (added, one key), add at 1.0 + 0.4/fps (not added, still one key, same id);
    - `"aim at the same target does nothing"`;
    - `"auto-direct without a plan is refused"`: the change is refused and no keys are written.
- [ ] **Step 2: Run, watch it fail to compile:** `cd native/build-rust && ninja bmapp_tests && ./app/bmapp/bmapp_tests "[key tracks],[camera lane],[motion fields]"`. Expected: FAIL (missing headers).
- [ ] **Step 3: Implement** by porting the Swift bodies named above. Add all three headers to `module.modulemap`. Add `using KeyObjectList = std::vector<KeyObject>` so Swift can name the vector (M4 Task 3 ruling).
- [ ] **Step 4: Rewire Swift** to call the functions and delete the Swift bodies:
  - `KeyframeTracks.refresh` keeps only the view mapping (display name, colour detail);
  - `retime`, `adjacent`, `link`, `GroupTracks.offsets` and `openFlightKeys` call the new functions;
  - `ViewportView.write` and the drag-start guard use `autoKeyValues` and `autoKeyTarget`;
  - `MotionEditor.effective` and `FlightTiming` use `effectiveMotion` and `flightPhases`;
  - `CameraClockInfo.of`, `CameraLaneMenu.addKey`, `canAutoDirect`, `CameraKeyMenu.aim` and `CameraDirectorMenu.direct` call the new functions.
- [ ] **Step 5: Run everything.** `ninja bmapp_tests && ./app/bmapp/bmapp_tests` gives PASS. `cmake --build native/build-app && ctest --test-dir native/build-app -j8` passes with at least 634 tests (including `brickmotion_selftest_motion` and `selftest_panes`). `ctest --test-dir native/build -j8` passes with at least 462.
- [ ] **Step 6: Commit:** `refactor(bmapp): key tracks, camera lane and motion fields move down from Swift`.

### Task 3: Keyframes ABI

**Files:** `desktop/bmffi/include/bmffi.h`, `src/keys.cpp`, `src/lists.cpp` (struct sizes), `tests/keys_test.cpp`; `desktop/crates/bm-sys/src/lib.rs`; `desktop/crates/bm/src/keys.rs`, `session.rs`, `viewport.rs`, `lib.rs`; `desktop/crates/bm/tests/keys.rs`, `render.rs` (header count, now 199), `document.rs` (struct sizes).

**Interfaces:**
- Consumes: Task 2's `keyObjects`, `keyOffsetLimits`, `adjacentKeyFrame`, `linkedKeyScene`, `flightKeysStart`, `autoKeyValues`.
- Produces (C):
  - Enums and structs: `BmKeyChannel` (10, in bmapp order), `BmKeyInterpolation`, `BmGizmoTool`, `BmKeyframe {channel, frame, value, interpolation}`, `BmKeyScene {fps, first, last, build_linked, build_start, build_speed}`, `BmKeyRowPick {piece, frame, submodel}`, `BmFlightPathPoint {frame, at}`.
  - Key objects: `BmKeyObjects*` (owned list) with `bm_session_key_objects`, `_len`, `_at` (giving `BmKeyObjectRow {piece, submodel, name, baked, keyed, keys, members, markers}`), `bm_key_objects_keys(o, i, BmKeyframe*, cap)`, `_members`, `_markers(o, i, int32_t* frames, size_t* channels, cap)`, `bm_key_objects_free`, and `bm_key_adjacent_frame(o, frame, after, int32_t*)`.
  - Session:
    - `bm_session_key_scene`, `_set_key_scene`;
    - `bm_session_key_value(s, piece, channel, frame, submodel)`;
    - `bm_session_set_keys(s, piece, keys, n, continuing, submodel)`;
    - `_remove_keys`, `_move_keys(…, offset, submodel)`, `_move_key_rows(picks, n, offset)`, `_remove_key_rows`;
    - `_has_editable_flight_keys`;
    - `_add_flight_path_point`, `_set_flight_path_point(piece, frame, BmVec3, continuing)`, `_delete_flight_path_point`;
    - `_return_flight_to_planner`, `_use_flight_in_build(piece, const BmFlightPose*, n)`.
  - Viewport: `bm_viewport_use_keyframes`, `bm_viewport_flight_path(v, piece) → BmFlightPath*` (owned: `line` and `keys` arrays), `bm_viewport_drag_facing_view`, `bm_viewport_edited_flight_route(v, piece, BmFlightPose*, cap)`.
  - Logic: `bm_key_offset_limits(scene, earliest, latest, int32_t* lower, int32_t* upper)`, `bm_linked_key_scene`, `bm_flight_keys_start`, `bm_auto_key_values(tool, origin, change, frame, BmKeyframe* out, cap)`, `bm_auto_key_target(s, selection, n, auto_key, int64_t key_submodel, uint32_t* piece, bool* submodel) → bool`.
- Produces (Rust):
  - `bm::keys::{KeyChannel, Interpolation, Keyframe, KeyScene, KeyObject, KeyMarker, KeyRowPick, FlightPath, GizmoTool}`;
  - `Session::{key_scene, set_key_scene, key_objects, key_value, set_keys, remove_keys, move_keys, move_key_rows, remove_key_rows, has_editable_flight_keys, add_flight_path_point, set_flight_path_point, delete_flight_path_point, return_flight_to_planner, use_flight_in_build}`;
  - `Viewport::{use_keyframes, flight_path, drag_facing_view, edited_flight_route}`;
  - free functions `key_offset_limits`, `linked_key_scene`, `flight_keys_start`, `auto_key_values`, `auto_key_target(&Session, &[u32], bool, Option<u32>) -> Option<(u32, bool)>`, `adjacent_key_frame(&[KeyObject], i32, bool) -> Option<i32>`.

  `KeyChannel::title()` and `suffix()` carry Swift's `KeyProperty` copy.

- [ ] **Step 1: Write the failing C tests** (helicopter):
  - `"keys round trip"`: `set_keys` then `key_objects` has the keys and markers;
  - `"move keys clamps nothing itself"`: record what bmapp does at the scene edge and assert it, so the ABI matches;
  - `"key rows move and remove"`;
  - `"key scene round trip"`;
  - `"flight path after bake"` (Metal): capture, prepare and apply a bake on piece 0, then `flight_path` is not empty, and `add_flight_path_point` adds a key;
  - `"use keyframes toggles the clock"` (Metal, no plan, scene unlinked, fps 24, first 1, last 49): `playback_state().duration == 2.0`, which is `(last − first)/fps` (`Viewport::length`, `endFrame`). With `build_linked` true and no plan, there is no time to show (`canShowTime`); assert that too;
  - `"auto key values"`: the same numbers as Task 2.
- [ ] **Step 2:** `cd native/build-rust && ninja bmffi_tests && ./bmffi/bmffi_tests "[keys]"`. Expected: compile FAIL.
- [ ] **Step 3: Implement.** Follow `playback.cpp`'s patterns (`copySlice`, `bmffi::change`, owned handles with string pointers valid until free). Raise the `render.rs` literal by the number of new `BMFFI_API` lines, and add each new struct to `bm_struct_size` and `struct_sizes_match`.
- [ ] **Step 4: Rust tests** in `bm/tests/keys.rs`:
  - `keys_round_trip`;
  - `key_objects_keyed_first`;
  - `offset_limits_match_c`;
  - `auto_key_values_move`;
  - `set_keys_continuing_is_one_undo_step`: `end_gesture`, then three calls with `true`, then `end_gesture`, adds one to `undo_depth`. This is the Auto Key pattern in Swift.

  Then: `cd desktop && cargo test -p bm` passes, and `nm -gU bmffi/libbmffi.dylib | grep -vc ' _bm_'` gives 0.
- [ ] **Step 5: Commit:** `feat(desktop): keyframes ABI (keys, key scene, key objects, flight paths)`.

### Task 4: Camera ABI

**Files:** `desktop/bmffi/src/camera.cpp`, `tests/camera_test.cpp`, the header, `lists.cpp`; `bm-sys`; `desktop/crates/bm/src/camera.rs`, `session.rs`, `viewport.rs`; `desktop/crates/bm/tests/camera.rs`, `render.rs`, `document.rs`.

**Interfaces:**
- Consumes: Task 2's `cameraClockInfo`, `cameraKeyAt`, `canAutoDirect`, `addCameraKeyFromView`, `aimCameraKey`, `autoDirect`.
- Produces (C):
  - `BmCameraClock {BM_CLOCK_BUILD, BM_CLOCK_TIMELINE}`, `BmSceneCamera`, `BmCameraKey` (all `CameraTrackKey` fields; strings as `const char*`), `BmCameraMove`, `BmCameraClockInfo`.
  - Owned lists: `BmCameraKeys*` (`bm_session_camera_keys(s, clock)`, `_len`, `_at`, `_free`), `BmCameraMoves*`, `BmCameraPresets*` (`bm_camera_presets()`), `BmSceneCameras*` (`bm_session_scene_cameras` with `active_id` and `use_for_video`).
  - Session (each returns `BmChange`):
    - `bm_session_camera_director_style(s, clock) → BmString`;
    - `bm_session_add_camera_key(s, clock, seconds, BmSceneCamera, fps, duration)`, `_set_camera_key_view(s, clock, id, BmSceneCamera)` (Update from View);
    - `bm_session_move_camera_key`, `_remove_camera_key`, `_set_camera_key_target`, `_set_camera_key(s, clock, BmCameraKey, continuing)`, `_set_camera_move(s, clock, BmCameraMove, continuing)`, `_choose_camera_preset(s, clock, from, preset, distance)`, `_clear_camera_track`;
    - `_export_camera → BmString`, `_set_export_camera`;
    - `_save_scene_camera`, `_remove_scene_camera`, `_activate_scene_camera`.
  - Viewport: `bm_viewport_capture_scene_camera`, `bm_viewport_recall_scene_camera`, `bm_viewport_follows_camera_track`, `bm_viewport_camera_track_view(v, seconds)`, `bm_viewport_set_director_preview`.
  - Logic:
    - `bm_camera_clock_info(clock, s, build_fps, build_duration, build_ready)`;
    - `bm_camera_key_at(keys, now, fps) → int64_t index or −1`;
    - `bm_can_auto_direct`;
    - `bm_add_camera_key_from_view(s, v, clock, now, info, BmString* id, bool* added) → BmChange`;
    - `bm_aim_camera_key(s, v, clock, BmCameraKey, target) → BmChange`;
    - `bm_auto_direct(s, v, clock, style) → BmChange`.

  `CameraDirectorInput` never crosses the ABI.
- Produces (Rust):
  - `bm::camera::{CameraClock, CameraKey, CameraMove, CameraPreset, SceneCamera, SceneCameras, ClockInfo}` (owned `String` fields);
  - `Session::{camera_keys, camera_moves, camera_director_style, add_camera_key, set_camera_key_view, move_camera_key, remove_camera_key, set_camera_key_target, set_camera_key, set_camera_move, choose_camera_preset, clear_camera_track, export_camera, set_export_camera, scene_cameras, save_scene_camera, remove_scene_camera, activate_scene_camera}`;
  - `Viewport::{capture_scene_camera, recall_scene_camera, follows_camera_track, camera_track_view, set_director_preview}`;
  - free functions `camera_presets()`, `clock_info(...)`, `camera_key_at(&[CameraKey], f64, f64) -> Option<usize>`, `can_auto_direct(...)`, `add_camera_key_from_view(&Session, &mut Viewport, …) -> (Changed, String, bool)`, `aim_camera_key(...)`, `auto_direct(...)`.

- [ ] **Step 1: Write the failing C tests:**
  - `"presets are the web's nineteen"`: `bm_camera_presets` length 19, ids non-empty;
  - `"add key from view, then the playhead key is reused"` (Metal);
  - `"camera key fields round trip with continuing"`: two calls, `false` then `true`, raise `undo_depth` by one;
  - `"auto-direct writes a track"` (Metal, after a plan): keys not empty and `director_style == "showcase"`;
  - `"scene cameras save, activate, remove"`;
  - `"export camera round trip"` (`"track"` default, `"automatic"`);
  - `"timeline clock info"`.
- [ ] **Step 2:** `ninja bmffi_tests && ./bmffi/bmffi_tests "[camera]"`. Expected: compile FAIL.
- [ ] **Step 3: Implement**, raise the literal, and add the struct sizes.
- [ ] **Step 4: Rust tests:** `camera_keys_round_trip`, `presets_have_labels`, `scene_cameras_round_trip`, `auto_direct_needs_a_plan` (refused text). Then `cargo test -p bm` passes and the `nm` check gives 0.
- [ ] **Step 5: Commit:** `feat(desktop): camera track, Auto-direct and scene cameras ABI`.

### Task 5: Motion, bake, audit and joints ABI

**Files:** `desktop/bmffi/src/motion.cpp`, `tests/motion_test.cpp`, the header, `lists.cpp`; `bm-sys`; `desktop/crates/bm/src/motion.rs`, `session.rs`, `viewport.rs`; `desktop/crates/bm/tests/motion.rs`, `render.rs`, `document.rs`.

**Interfaces:**
- Consumes: Task 2's `effectiveMotion`, `flightPhases`.
- Produces (C):
  - Motion: `BmMotionScope`, `BmMotionFields {time, landing, hover, ease}`, `bm_session_motion_fields(s, scope, step, pieces, n)`, `bm_session_set_motion_fields(…) → BmChange`, `bm_effective_motion(s, scope, step, fields)`, `bm_flight_phases(fields, double* travel, double* hover, double* landing)`.
  - Flight bake: `BmFlightBake*`, created by `bm_viewport_capture_flight_bake(v, pieces, n, detach)` (NULL if nothing is planned). Then `bm_flight_bake_replaces_keys`, `bm_flight_bake_prepare(b) → BmFlightBakeResult {flights, keys, error}` (thread-safe on one worker), `bm_session_apply_flight_bake(s, b) → BmChange`, `bm_flight_bake_free`.
  - Motion audit: `BmMotionAudit*`, created by `bm_viewport_audit_motion(v, piece)`. `bm_motion_audit_check(a) → BmMotionReport*` gives `tested_frames`, `stride`, `intervals`, `error`, and contacts `{a, b, first_frame, last_frame, part, blocker}` as a list; then `_free`.
  - Inspection: `BmInspection*`, created by `bm_inspection_capture(s)`. `bm_inspection_joints(i, selection, n, show_all) → BmJoints*` gives rows `{a, b, type, point, axis, release, angle, clearance, mate_count}` and `error`. Also `bm_inspection_body(i, piece, uint32_t*, cap)`, `bm_inspection_change_joint(i, fixed, moving, degrees, collision) → BmJointEdit*` (pieces, pivot, pose, error), and `_free`.
  - `bm_session_place_moved(s, pieces, n, pivot, BmPose, generation, version) → BmChange`; `bm_session_insertion_direction`, `_set_insertion_direction`.
  - `BmJointType` in bmapp order.
- Produces (Rust): `bm::motion::{MotionScope, MotionFields, FlightPhases, FlightBake, BakeResult, MotionAudit, MotionReport, MotionContact, Inspection, JointRow, JointType, JointEdit}`.
  - `FlightBake`, `MotionAudit` and `Inspection` are `Send` and not `Sync`, and their methods take `&mut self`.
  - `JointType::title()` copies `JointType+title.swift`.

- [ ] **Step 1: Write the failing C tests:**
  - `"motion fields round trip and inherit"`;
  - `"flight phases"`;
  - `"bake on a worker thread then apply"` (Metal: plan, capture, `std::thread` prepare, apply, `key_objects` gains baked keys);
  - `"bake capture without a plan is null"`;
  - `"motion audit reports"` (Metal, baked piece);
  - `"joints of the helicopter rotor"`: the inspection lists at least one hinge or cylindrical joint, and `change_joint(… 15 …)` gives pieces and no error;
  - `"place moved refuses a stale version"`: pass `version − 1`, and the change is refused.
- [ ] **Step 2:** `ninja bmffi_tests && ./bmffi/bmffi_tests "[motion]"`. Expected: compile FAIL.
- [ ] **Step 3: Implement**, raise the literal, and add the struct sizes.
- [ ] **Step 4: Rust tests:**
  - `motion_fields_round_trip`;
  - `bake_on_worker_thread` (`std::thread::spawn` with the moved `FlightBake`);
  - `joint_turn_round_trip` (inspect, change, `place_moved`, and the angle changes by about 15°);
  - `insertion_direction_round_trip`.

  Then `cargo test -p bm` passes and the `nm` check gives 0.
- [ ] **Step 5: Commit:** `feat(desktop): motion, flight bake, motion audit and joints ABI`.

### Task 6: The Keyframes clock

**Files:** `desktop/crates/brickmotion/src/transport.rs`, `chrome/timeline.rs`, `app.rs`; `tests/keys.rs` (new).

**Interfaces:**
- Consumes: `Viewport::use_keyframes`, `Session::key_scene`, Task 1's rulings (where the switch sits; Build track hidden or dimmed).
- Produces:
  - `pub enum Clock { Build, Keyframes }`;
  - `Transport::clock`, `Transport::set_clock(&mut self, vp, Clock)`, `Transport::seek_scene(&mut self, vp, seconds)`;
  - `Transport::key_frame(&self, &KeyScene) -> i32`, which is `first + round(time × fps)`;
  - `Transport::scene_length(&KeyScene) -> f64`, which is `(last − first)/fps`.

  On the Keyframes clock, `duration()` and `time()` read the viewport's playback state, which follows the scene once `use_keyframes(true)`.

- [ ] **Step 1: Write the failing tests:**
  - `keyframes_clock_needs_no_plan`: open the helicopter with auto-plan off and an unlinked scene (fps 24, first 1, last 49), then `set_clock(Keyframes)`.
    - The duration is 2.0, which is `(last − first)/fps`.
    - `seek_scene(1.0)` puts `key_frame` at 25.
    - Setting `build_linked` shows no time until a plan is Ready.
  - `clock_switch_stops_playback`: play on Build, switch, and playback is off and time is 0 on the new clock.
  - `clock_survives_replan`: on the Keyframes clock, a plan becoming Ready does not move the playhead.
- [ ] **Step 2:** `cargo test -p brickmotion --test keys keyframes_clock`. Expected: FAIL (no `Clock`).
- [ ] **Step 3: Implement.**
  - The clock switch follows Task 1's ruling.
  - Home and End, and ⇧← / ⇧→ (step travel), are Build-only. On Keyframes, ⇧← / ⇧→ go to the previous or next key (`adjacent_key_frame`).
  - The ruler shows frames on the Keyframes clock.
  - A document switch resets to Build.
- [ ] **Step 4:** `cargo test -p brickmotion` passes.
- [ ] **Step 5: Commit:** `feat(desktop): Keyframes clock beside the Build clock`.

### Task 7: The Camera track

**Files:** `desktop/crates/brickmotion/src/chrome/camera_lane.rs` (new), `chrome/timeline.rs` (the Camera placeholder at line 464), `commands.rs`, `app.rs`; `tests/camera.rs` (new).

**Interfaces:**
- Consumes: Task 4's API and Task 6's `Clock`.
- Produces:
  - `pub enum CameraPick { Key(String), Move(String) }` and `BrickMotionApp::camera_selection: Option<(CameraClock, CameraPick)>`;
  - `camera_lane::show(ui, app, rect, dur, clock)`;
  - `TimelineDrag::CameraKey { clock, id, start_x, original, seconds }`.

- [ ] **Step 1: Write the failing tests** (helicopter, planned):
  - `add_key_from_view_selects_it`: run `video.camera_key`; one key appears, it is selected, and Follow Camera is on.
  - `key_drag_moves_once`: drag a key 60 px; `move_camera_key` lands on release as one undo step, and the key's seconds equal the dropped time rounded to the frame.
  - `auto_direct_from_lane_menu`: Auto-Direct › Showcase gives keys, and that style is checked in the menu.
  - `camera_selection_clears_when_key_goes`: select a key, then Delete from the key menu clears the selection; undo, select, then undo again clears it.
  - `timeline_clock_has_its_own_track`: a key added on the Keyframes clock is not in the Build track's keys.
- [ ] **Step 2:** `cargo test -p brickmotion --test camera`. Expected: FAIL.
- [ ] **Step 3: Implement** to Task 1's approved look and `CameraTrackLane.swift`'s behaviour.
  - Keys are diamonds and moves are clips labelled with the preset label (fallback "Smooth glide").
  - Click a key to seek there and open the Camera page.
  - Lane menu: Add Camera Key from View, an Auto-Direct submenu (six styles with their hints, the current one checked, disabled when `can_auto_direct` is false; Swift gives no reason, so the disabled tooltip's copy is a Task 1 ruling). The ribbon button's help is Swift's: "Auto-Direct: write a camera track from the build, with keys and moves you can then change", Follow Camera (`set_director_preview`), and Clear Camera Track.
  - Key menu: Update from View (`set_camera_key_view` with `capture_scene_camera`), Look At (Model, Build, Piece, Fixed view; uses `aim_camera_key`), Delete.
  - Move menu: the 19-preset picker (`choose_camera_preset`, with distance = |eye − target| of the from-key's view).
  - Commands `video.camera_key`, `video.auto_direct` (opens the submenu at the ribbon button) and `video.follow` (checked) go live.
- [ ] **Step 4:** `cargo test -p brickmotion` passes.
- [ ] **Step 5: Commit:** `feat(desktop): Camera track with Auto-direct and Follow Camera`.

### Task 8: Camera inspector and scene cameras

**Files:** `desktop/crates/brickmotion/src/chrome/camera_page.rs` (new), `chrome/properties.rs` (`Page::Camera`), `app.rs`; `tests/camera.rs`.

**Interfaces:**
- Consumes: Task 7's `camera_selection`, Task 4's setters, M4's `slider_row` / `SliderEvent`.
- Produces: `Page::Camera`. Selecting a key or move in Task 7 opens it, and Esc returns to the Inspector.

- [ ] **Step 1: Write the failing tests:**
  - `camera_slider_drag_is_one_undo_step`: drag the Lens slider over 10 frames, and `undo_depth` rises by one; the key's `lens_mm` is the final value.
  - `move_curve_popup_commits`: choose "linear" and `camera_moves()[0].curve == "linear"`.
  - `scene_camera_save_and_recall`: Save View, rename by typing then Return, move the camera, Recall, and the camera is back. Make Default for Video gives `active_id == id`.
  - `export_camera_popup`.
- [ ] **Step 2:** `cargo test -p brickmotion --test camera camera_slider`. Expected: FAIL.
- [ ] **Step 3: Implement** to `CameraKeyInspector.swift`'s fields and Task 1's look.
  - The key panel holds:
    - target popup;
    - azimuth and elevation (degrees);
    - lens (mm);
    - Fitted switch, with margin when fitted or distance (studs) when not;
    - roll;
    - focus on target, or focus depth;
    - background blur.
  - The move panel holds:
    - preset;
    - cut and flow-through switches;
    - curve (six options);
    - strength;
    - straight;
    - orbit (shortest / cw / ccw) and extra turns;
    - overshoot, motion blur, shake and shake frequency;
    - turn in last seconds.
  - Sliders send `continuing` (`false` on the first frame), with `end_gesture` on release.
  - The scene cameras section follows `Inspector.swift` 110–175:
    - Save View: `capture_scene_camera`, then `save_scene_camera`.
    - Recall: `recall_scene_camera`.
    - Rename and Update from View: `save_scene_camera` with the same id, keeping the name for an update.
    - "Make Default for Video": `activate_scene_camera(id)`. "Use Automatic Camera for Video": `activate_scene_camera("")`. The row reads "Default for Video" when `use_for_video && active_id == id`.
    - Remove Camera.
    - The Export camera popup: Camera track / Automatic / Build view.
- [ ] **Step 4:** `cargo test -p brickmotion` passes.
- [ ] **Step 5: Commit:** `feat(desktop): Camera inspector page and scene cameras`.

### Task 9: Keys track and dope sheet

**Files:** `desktop/crates/brickmotion/src/chrome/keys_track.rs`, `chrome/dope_sheet.rs`, `chrome/keys_page.rs` (new), `chrome/timeline.rs` (the Keys placeholder at line 599), `viewport.rs` (Auto Key), `commands.rs`; `tests/keys.rs`.

**Interfaces:**
- Consumes: Task 3's API, Task 6's `Clock`, and M3's gizmo drag in `viewport.rs`.
- Produces:
  - `KeysView { objects: Rc<Vec<KeyObject>>, for_version: Option<(u64, u64)>, active: HashSet<(u32, bool)>, picks: HashSet<(KeyChannel, i32)>, row_picks: HashSet<(u32, bool, i32)>, property: KeyChannel, auto_key: bool, group_rows: bool }` on `BrickMotionApp`. It rebuilds only when `(generation, version)` changes.
  - `TimelineDrag::Keys { picks, start_x, offset }` and `TimelineDrag::KeyRows { picks, start_x, offset }`.
  - `Page::Keys`.

- [ ] **Step 1: Write the failing tests:**
  - `insert_key_at_playhead`: choose an object, set the value 2 in Position X, Insert, and a key sits at `key_frame` with value 2.
  - `key_selection_follows_retime`: select two keys, drag +5 frames, `move_keys` is called once with offset 5, and the picks are now at +5.
  - `retime_drag_is_one_call`: `undo_depth` rises by one after a 12-frame drag.
  - `retime_clamps_to_scene`: dragging past `last` moves by `upper` only.
  - `interpolation_change`: set Linear on a selected key, and the key reads back Linear.
  - `prev_next_key`.
  - `link_build_extends_scene`.
  - `auto_key_drag_is_one_undo_step`: Auto Key on, move-gizmo drag over 8 frames, one undo step, and the Position keys at the frame equal `auto_key_values` of the total change.
  - `group_rows_move_together` (`video.group` on).
  - `big_model_keys_track` (`#[ignore]`, `BM_BIG_MODEL`): Keys expanded, objects built once over 10 frames, frame < 16 ms.
- [ ] **Step 2:** `cargo test -p brickmotion --test keys`. Expected: FAIL.
- [ ] **Step 3: Implement** to Task 1's look and the behaviour of `KeyframeTracks.swift` / `KeyframeGroupTracks.swift`.
  - **Keys track:** object rows (the filter field matches name and detail), markers sized by channel count, and click to choose (⌘/⇧ to add).
  - **Dope sheet:**
    - property lanes for the chosen object;
    - only keys in the visible frame range plus an 18-px margin are drawn, and keys being dragged always are;
    - click or ⌘-click selects, and box select works;
    - drag retimes, previewed as an offset and committed once on release through `clamp_offset(key_offset_limits(...))`;
    - Delete removes;
    - the right-click menu has Smooth, Linear, Hold and Delete.
  - **Keys page:**
    - the property popup with value field (units as Global Constraints), interpolation segmented control and Insert/Update Key;
    - the key scene group (fps, first, last, Build start, Build speed; committed on Return) with the Link to Build switch (`linked_key_scene` with the Build duration);
    - the Auto Key switch.
  - **Auto Key:** at drag start on the Keyframes clock, `auto_key_target` picks the piece and submodel. Then `end_gesture` is called, and the origin is read with `key_value` at `key_frame`. Each drag frame writes `auto_key_values(tool, origin, total, frame)` through `set_keys(…, true, submodel)`, with `end_gesture` on release.
    - When the target is not ok, the drag does nothing and the app beeps (`NSBeep`), as Swift. There is no copy.
    - Off the Keyframes clock, the gizmo moves pieces as in M3.
  - Command `video.add_key` (Insert Key) and `video.group` go live.
- [ ] **Step 4:** `cargo test -p brickmotion` passes. Run `big_model_keys_track` in release with `BM_BIG_MODEL=…/dist/data/omr/10294-1/10294-1.mpd`.
- [ ] **Step 5: Commit:** `feat(desktop): Keys track, dope sheet and Auto Key`.

### Task 10: Bake, flight keys, flight path and Check Motion

**Files:** `desktop/crates/brickmotion/src/workers.rs`, `flight_path.rs` (new), `chrome/keys_page.rs`, `chrome/parts_lane.rs` (clip menu), `viewport.rs`, `commands.rs`; `tests/motion.rs` (new).

**Interfaces:**
- Consumes: Task 5's `FlightBake` and `MotionAudit`, Task 3's flight-path calls, and `flight_keys_start`.
- Produces:
  - `workers::Job<K: PartialEq, T>` with `start(key: K, FnOnce() -> T + Send)`, `poll(&mut self, current: &K) -> Option<Result<T, Stale>>` and `busy()`. Bake and audit use `K = (generation, version)`. Task 12 uses its own key.
  - `BrickMotionApp::{bake: Job<…>, audit: Job<MotionReport>}`.
  - `flight_path::show(ui, app, rect)` and `flight_path::handle_pointer(...) -> bool`.

- [ ] **Step 1: Write the failing tests** (planned helicopter):
  - `bake_selected_flights`: select piece 0, run `video.bake_flight`, wait, and a notice reads "Baked 1 flight into N editable keys."; piece 0 is `baked`.
  - `rebake_asks_first`: baking again shows a confirm, and Cancel leaves the keys unchanged.
  - `bake_result_after_edit_is_dropped`: start a bake, move a piece before it finishes, and no keys are applied and the undo depth is unchanged.
  - `edit_flight_as_keys_opens_keyframes`: from the Parts lane menu, the clock is Keyframes, piece 0 is selected, and time = `flight_keys_start`.
  - `path_point_drag_is_one_undo_step`: drag a path dot 30 px, and `undo_depth` rises by one.
  - `motion_check_after_edit_says_changed`.
  - `use_edited_flight_in_build` (refuses with Swift's text when the route is empty).
- [ ] **Step 2:** `cargo test -p brickmotion --test motion`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Bake:** on the Keys page and through `video.bake_flight`, with a Detach option. Confirm when `replaces_keys`. Capture on the UI thread, prepare on the `bm-anim` worker, then `apply_flight_bake` if `(generation, version)` still match.
  - **Parts lane clip menu** adds Edit Flight as Keys, Return Flight to Planner and Use Edited Flight in Build. These follow `AnimationWorkspace.editFlight` / `KeyframeTracks.useEditedFlight`, including the refusal strings.
  - **Flight path:** drawn when the Keyframes clock is on and one piece with flight keys is selected, cached by `(piece, version)`. The line is 2 px in the accent colour; dots are 8 px, and the dot at the playhead is 11 px.
    - Drag a dot: `drag_facing_view`, then `set_flight_path_point(…, continuing)`.
    - Double-click the line: `add_flight_path_point`.
    - Delete on a picked dot: `delete_flight_path_point` (never the first or last).
  - **Check Motion:** on the Keys page, with the result text as `AnimationWorkspace.checkMotion` and a contact list. Clicking a contact seeks its first frame, selects both pieces and frames them.
- [ ] **Step 4:** `cargo test -p brickmotion` passes.
- [ ] **Step 5: Commit:** `feat(desktop): flight bake, flight path editing and Check Motion`.

### Task 11: Motion editor

**Files:** `desktop/crates/brickmotion/src/chrome/motion_page.rs` (new), `chrome/properties.rs` (`Page::Motion`), `chrome/parts_lane.rs`, `chrome/timeline.rs` (step-run menu); `tests/motion.rs`.

**Interfaces:**
- Consumes: Task 5's `motion_fields`, `set_motion_fields`, `effective_motion`, `flight_phases`.
- Produces: `Page::Motion { scope: MotionScope, step: usize, pieces: Vec<u32> }`. Opened from the Parts lane clip menu "Motion…" (Parts scope with the clip's pieces or the selection) and the step-run menu "Step Motion…".

- [ ] **Step 1: Write the failing tests:**
  - `motion_slider_commits_once`: drag Flight time over 10 frames, and one `set_motion_fields` call and one undo step follow.
  - `inherited_values_show`: set project landing 0.4, open Parts scope, and the landing row shows the inherited 40% (formatted as `MotionEditor.valueRow` formats it) while its own field stays −1.
  - `reset_to_inherited`: the row's reset sets −1.
  - `flight_timing_bar_matches_phases`.
  - `preset_sets_all_fields`: Precise Seating gives `{1.4, 0.45, 0.12, 2}` in one undo step.
- [ ] **Step 2:** `cargo test -p brickmotion --test motion motion_`. Expected: FAIL.
- [ ] **Step 3: Implement** to `MotionWorkspace.swift`'s `MotionEditor` and Task 1's look.
  - The page is titled "Build Motion", with the scope segmented control (Project / Step / Part) and these rows:
    - Duration, a multiplier from 0.25 to 4, written as "1.5×";
    - Landing from 0.1 to 0.7 and Hover from 0 to 0.4, as percentages;
    - Easing: Smooth, Gentle, Soft, Linear, with "Inherit · <name>" as the unset choice.
  - Each row shows the inherited value when unset, with a reset.
  - A Presets menu sets every field:
    - Balanced: 1, 0.25, 0.08, 0;
    - Precise Seating: 1.4, 0.45, 0.12, 2;
    - Fast Assembly: 0.7, 0.2, 0, 1;
    - Reset All: every field −1.
  - The flight timing bar has three segments (Travel / Hover / Landing).
  - Changes commit on release.
- [ ] **Step 4:** `cargo test -p brickmotion` passes.
- [ ] **Step 5: Commit:** `feat(desktop): Motion editor page`.

### Task 12: Joints and insertion direction

**Files:** `desktop/crates/brickmotion/src/chrome/joints.rs` (new), `viewport.rs`, `chrome/inspector.rs` (or wherever M2's Inspector page lives), `commands.rs`, `app.rs`; `tests/joints.rs` (new).

**Interfaces:**
- Consumes: Task 5's `Inspection`, `place_moved` and insertion direction; Task 10's `Job<T>`; M3's `bm_project_point`.
- Consumes, already in bmffi: `bm_session_generation`, `bm_session_structure_version`, `bm_project_point` and M3's hidden list.
- Produces:
  - `JointKey { generation: u64, version: u64, structure: u64, hidden: Vec<u32>, selection: Vec<u32> }`, which is Swift's `Revision` plus `Request.selection`.
  - `JointsView { report: Option<Vec<JointRow>>, for_key: Option<JointKey>, open: Option<(u32, u32)>, error: Option<String>, changing: bool }`.

  The inspection re-runs when the `JointKey` changes, as in `AssemblyReview.update`. It passes `inspect`'s joints/geometry flags as `AssemblyReview.swift:54` does for the Show Joints request. A joint change is applied only while `(generation, version)` match, through `place_moved`.

- [ ] **Step 1: Write the failing tests** (helicopter):
  - `joint_markers_toggle`: `view.joints` on gives markers; off gives none.
  - `joint_card_turns_15`: open the rotor joint, click Rotate right, wait, the angle rises by about 15°, and there is one undo step.
  - `joint_change_after_edit_is_dropped`.
  - `detach_separates`: Detach gives one undo step and the pieces moved.
  - `select_rigid_body`: the selection equals `inspection.body(b)`.
  - `joint_card_closes_when_joint_goes`.
  - `insertion_direction_from_camera`: Set Insertion Direction › From Camera gives `insertion_direction(p)` equal to the camera's nearest axis.
- [ ] **Step 2:** `cargo test -p brickmotion --test joints`. Expected: FAIL.
- [ ] **Step 3: Implement** to `JointCard.swift`, `EditorOverlays.swift` (markers, hit radius) and Task 1's look.
  - The card shows the type title and the two part descriptions.
  - Hinge, cylindrical and ball joints get ±15° buttons around the angle. The card also shows the error line and the buttons Select Rigid Body and Detach (degrees 0).
  - Changes run on the worker and apply with `place_moved(…, generation, version)`. A non-local piece gives "Open the submodel that contains this connection."
  - Insertion direction: an Inspector row with the six axes, "From Camera" and Clear (`ArrivalDirection.swift` labels), plus the `object.arrival_direction` command. `view.joints` is a checked command in the View menu.
- [ ] **Step 4:** `cargo test -p brickmotion` passes.
- [ ] **Step 5: Commit:** `feat(desktop): joint markers, joint card and insertion direction`.

### Task 13: Milestone checks

**Files:** `desktop/docs/m5-rulings.md`, `desktop/docs/m5-*.png`.

- [ ] **Step 1: Run every suite.**
  - `cd desktop && cargo test --workspace` passes, and `cargo clippy --workspace --all-targets` has no warnings.
  - `cd native/build-rust && ninja bmffi_tests bmapp_tests && ./bmffi/bmffi_tests && ./app/bmapp/bmapp_tests` passes.
  - `ctest --test-dir native/build-app -j8` passes with at least 634 tests, and `ctest --test-dir native/build -j8` with at least 462.
  - The `nm` check gives 0.
- [ ] **Step 2: Run the big-model benchmarks** (M4's two and `big_model_keys_track`) in release, and record the numbers in `m5-rulings.md`.
- [ ] **Step 3: Take screenshots** through the kittest harness: `m5-keyframes.png`, `m5-camera.png`, `m5-camera-page.png`, `m5-motion.png`, `m5-joint.png`, `m5-flight-path.png`. Send them to the owner.
- [ ] **Step 4: Leave the by-hand windowed pass to the owner and record it in the rulings:** Auto Key with a real trackpad, the path-point drag, Follow Camera playback, and the joint card over a moving view.
- [ ] **Step 5: Commit:** `docs(desktop): M5 checks and screenshots`.

## Not in M5 (and where it goes)

- **Mechanism lab** (drive, gears, steering, sweeps): when bmapp has a mechanism engine (spec: the Rust app gets it when the engine does).
- **Curves / graph editor:** the toggle stays disabled until the owner asks for it. It needs bezier key handles in the engine first.
- **Keyframes and Camera-track movie export, scene lights, reference images:** M6.
- **Model Checks list:** M7.
- **Timeline-pro tools** (ripple, roll, slip, slide, razor, J/K/L, markers, work area): still out, as M4 ruled.
