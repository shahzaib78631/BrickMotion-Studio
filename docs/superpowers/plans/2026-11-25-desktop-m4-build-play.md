# BrickMotion Desktop — Milestone 4 (Build & Play) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rust app plans and plays the build video:
- The planner runs on its own (auto-plan) or on request, and shows its stage, errors and diagnostics.
- A transport (Space, start/end, previous/next step, rate, loop) with a timecode.
- The Animate workspace's live Build timeline: ruler and playhead, zoom and Fit, Intro / Build / Hero clips, step runs, the pause lane, submodel lanes and the Parts lane (arrival drag, pin, drop from the Library).
- The step callout in the viewport (play step, play to end, the four step appearances).
- Build Settings, Build Staging and Snap Sound, with live snap sound during playback.

**Architecture:**
- **Engine:** planning, playback, flights, staging and sound already live in `bmapp` (`Viewport::play/seek/playRange/playbackState/buildTimeline/arrange`, `Session::buildSettings/stagingSettings/applyStaging/snapMix/moveArrival/setSequenceDuration`, `snap_mix.h`). Unlike M3, **bmapp changes in this milestone**: the spec's "Swift logic" rule moves the timeline logic that lives in Swift today (`AnimationWorkspace` runs/step clips/submodel clips, `TimelineArrivalTarget`, `PartLaneLayout` row packing, `TimelineNavigation` maths) down into two new bmapp headers with Catch2 tests, and the Swift app is rewired to call them.
- **bmffi** grows three ABI groups (playback + timeline + lanes, arrival + sequence, build/staging/sound settings), each in its own source file, with M2/M3 conventions (guards, `BmChange`, list handles, two-call arrays, `bm_struct_size`).
- **bm** wraps them: `playback.rs`, `timeline.rs`, `settings.rs`.
- **brickmotion** gets a `Transport` (polls `playback_state()` once a frame, reads the timeline only on a new Ready version, owns the lanes and the timeline view), the live `chrome/timeline.rs`, `chrome/parts_lane.rs`, `chrome/callout.rs`, three Properties pages (`chrome/build_settings.rs`, `chrome/staging.rs`, `chrome/sound.rs`) and `sound.rs` (live snap sound with `rodio`).

**Tech Stack:** As M3, plus `rodio` 0.23 (the current release; CoreAudio through cpal) for snap sound. Its stream API changed in 0.21 (`OutputStreamBuilder::open_default_stream`, `Sink::connect_new`); read docs.rs/rodio/0.23 for `set_speed` and `try_seek` before writing `RodioSink`. The spec leaves the audio crate to the builder; this is that choice.

**Spec:** `docs/superpowers/specs/2026-11-25-rust-egui-app-design.md`, milestone 4:
> "Build & play: planner, transport, timeline, build settings, staging, sound."

Reference for behaviour: the parity ledger `docs/superpowers/specs/2026-11-19-native-app-parity.md` §6 (step callout), §7 (timelines), §8 (staging, sound, planner picker), and the Swift files it describes: `AnimationWorkspace.swift`, `AnimationTimeline.swift`, `BuildTracks.swift`, `TimelineNavigation.swift`, `TimelinePartLane.swift`, `TimelineArrivalTarget.swift`, `TimelineMenus.swift`, `TimelineSequenceTrim.swift`, `StepCallout.swift`, `BuildSettingsSheet.swift`, `StagingSheet.swift`, `SoundSettingsSheet.swift`, `TransportSound.swift`. Match their behaviour; never copy logic into Rust (Task 3 moves it into bmapp first).

Builds on branch `feat/desktop-m1` after M3 (`bb9c9f91`) and the M3 review fixes (Task 1). Rulings so far: `desktop/docs/m2-rulings.md`, `desktop/docs/m3-rulings.md`.

## Global Constraints

- Everything in M1–M3's Global Constraints still holds (stack; calm UI: one stroke-icon family, blue `#4f8cff` accent, **orange only for the playhead**, 8-px grid, 12.5-pt text, two weights; bundle id `com.brickmotion.studio.rs`; stage named files only; no commits on `main`; only `.brickmotion` is written; tests use `new_for_test` / `new_for_test_cc` and never the real support folder).
- **Engine edits are allowed only where the spec says logic moves down**: `native/app/bmapp/include/bmapp/build_lanes.h`, `timeline_view.h`, their `.cpp`, tests, and CMake lines. Planning, flights, staging and sound algorithms do not change (spec non-goal).
- **The Swift app stays green and calls the moved logic:** `ctest --test-dir native/build-app` passes with at least 619 tests, and `native/build` 462+, after Task 3. `TransportSound.swift` is the exception: the spec moves live snap sound into Rust, so Swift keeps its own.
- **Every edit is one engine command and one undo step.** Settings setters have no `continuing` (`setBuildSettings`, `setSnapMix`, `applyStaging`, `setSequenceDuration`, `setStepFields(…, false)` for holds): sliders and drags show the value live in the UI and **commit once, on release** (or on Return / focus loss for typed fields). `setBuildSettings` replans, so a drag must never call it per frame.
- **The session stays single-threaded.** Planning runs on the engine's workers; Rust only polls. `write_snap_preview` (a free function on a `SnapMix` copy) runs on a `bm-sound` worker. `Viewport::write_snap_track` is a viewport method and runs on the UI thread at play start, as `TransportSound.swift` does; if Task 12's timing test shows it too slow, that is `Ruling: needs engine change` (a viewport-free snap-track call), not a Rust workaround.
- **The timeline is read only on a new Ready version** (`state.plan == Ready && state.version != transport.version`), exactly as `AnimationWorkspace.update()`. Lanes from two plan versions never mix.
- **Time:** seconds as `f64`; seeks round to the plan's frame (`(t * fps).round() / fps`). Timecode shows `MM:SS:FF` at the plan's fps.
- **Keys** (new; no clash with M2/M3's registry):

  | Command | Key | Swift |
  |---|---|---|
  | Play / Pause | Space | Space (viewport) |
  | Go to start / end | Home / End | — |
  | Previous / next step | ⇧← / ⇧→ (Animate workspace only) | `travel` |
  | Plan Build | — | menu |

  Single-key shortcuts fire only while no text field has focus. ⇧← / ⇧→ are not bound in Build (M3's arrows nudge there).
- **Snap recordings directory** (`SoundSettingsSheet.recordings` in Swift): `$BM_SNAP_SOUNDS` if set, else `<exe>/../Resources/SnapSounds` when it exists (bundle), else `<repo>/public/sounds/snaps` (from `CARGO_MANIFEST_DIR`). `scripts/bundle.sh` copies `public/sounds/snaps` to `Resources/SnapSounds`.
- **Preferences** gain `play_snap_sounds: bool` (default true) and `auto_plan: bool` (default true) in `prefs.toml`; their toggles live in the timeline's ⋯ menu until the Preferences window exists (M8).

## Scope by ledger row

| Ledger row | Milestone |
|---|---|
| §6 Step callout (prev/next/all, play step/to end, four appearances) | **M4** (Task 9) |
| §7 Build / Timeline / Motion modes | **M4** Build Video tab; Keyframes and Motion tabs **M5** |
| §7 Planner status, progress, out-of-date, auto-plan | **M4** (Tasks 5–6) |
| §7 Transport, zoom, Fit, rate, loop, playhead following, edge scrubbing | **M4** (Tasks 5–6) |
| §7 Step blocks + step-clip menu, pause handles, submodel lanes | **M4** (Task 6) |
| §7 Parts lane (arrival drag, force order, pin, drop from Library, clip menu) | **M4** (Task 7); the clip menu's "Motion…" and "Edit Flight as Keys" **M5** |
| §7 Pause lane | **M4** (Task 6) |
| §7 Intro / Build / Hero clips | **M4** (Task 6) |
| §7 Planner error panel with diagnostics | **M4** (Task 6) |
| §7 Camera lanes, Motion popover, Dope sheet, Camera inspector | **M5** (the Camera and Keys tracks show an empty state in M4) |
| §8 Planner picker → Build Settings | **M4** (Task 11) |
| §8 Staging (9 layouts, grouping, sides, order, aspect, turn, put back, waiting-part turn) | **M4** (Task 11) |
| Waiting-part floor drag (`beginWaitingDrag` / `dragWaitingPart` / `endWaitingDrag` + `shiftWaitingPart`) | **M4** (Task 11) |
| §8 Sound (snap mix, presets, sample, live transport sound) | **M4** (Task 12) |
| §8 Render/video, video renderer, materials/Look, export, capture, record viewport | **M6** |
| §8 Scene cameras | **M5**; scene lights/reference images **M6** |
| §8 Mechanism lab | **M5** |
| §8 Checks | **M7** |
| §8 Assembly spots outliner | **M8** |
| `timeline-pro.html` extras (ripple/roll/slip/slide/razor tools, J/K/L shuttle, markers, work area, in/out, mini-map, track solo/mute/lock) | **Out of M4.** The locked calm rules override the pro mockup; the four header tools stay drawn but disabled ("coming soon" tooltip) until the owner asks. |

Commands that go live (were `When::Soon`): `video.plan_build`, `video.regenerate`, `video.order` (Regenerate Build Steps), `video.staging`, `video.straighten`, `video.flights` (opens Build Settings at Flights), `video.snap_sound`, `video.mix`, `model.build_settings`. Still Soon: the Keys and Camera groups (M5), Output (M6).

## Review Focus

1. **An edit, undo or document switch while planning or playing:** playback stops at rest, the timeline shows the last Ready build greyed as out of date (Swift's `showsStaleBuild`), and no lane, drag or drop ever uses rows from the old version against the new session. Test: Task 5 `edit_while_playing_marks_stale_and_never_mixes_versions`.
2. **A slider or drag on a setting that replans** (pieces per second, clearance, a hold, a sequence trim): one undo step and one replan per release, however many frames the drag spans. Test: Task 11 `pacing_slider_drag_is_one_undo_and_one_plan`, Task 6 `hold_drag_is_one_undo_step`.
3. **Sound that does not match the picture:** the snap track is rebuilt when `(session.version, plan version)` changes, follows seeks within 80 ms, follows rate and loop, stops on pause, rest, Keyframes tab and document switch, and a Mac with no audio device shows one notice and never panics. Test: Task 12 `sound_follows_transport` (fake sink) and `no_audio_device_is_one_notice`.
4. **A big build** (10294-1, about 9.7 k flights): a timeline frame at Fit and at 64× zoom stays under 16 ms; only visible clips are laid out and drawn; playback at Retina size keeps ≥ 30 fps through the CPU readback path. Tests: Task 7 `big_model_parts_lane`, Task 5 `playback_frame_time`.
5. **Pointer gestures that start on the timeline and end elsewhere** (scrub, clip drag, hold drag, trim released outside the window or over the viewport): the gesture ends and commits or cancels exactly once; Esc cancels a drag in progress. Test: Task 7 `arrival_drag_released_outside_commits_once`, Task 6 `scrub_release_outside_ends_scrub`.

---

## File Structure

```
native/app/bmapp/include/bmapp/build_lanes.h     (create) runs, step clips, submodel clips, arrival target, lane packing
native/app/bmapp/include/bmapp/timeline_view.h   (create) zoom/offset maths of a timeline
native/app/bmapp/src/build_lanes.cpp, timeline_view.cpp      (create)
native/app/bmapp/tests/build_lanes_test.cpp, timeline_view_test.cpp (create)
native/app/bmapp/CMakeLists.txt                  (modify) sources + tests
native/app/BrickMotion/AnimationWorkspace.swift, TimelineArrivalTarget.swift,
  TimelinePartLane.swift, TimelineNavigation.swift (modify) call bmapp instead of their own maths

desktop/bmffi/include/bmffi.h                    (modify)
desktop/bmffi/src/playback.cpp                   (create) playback, plan, timeline list, lanes, view, arrange
desktop/bmffi/src/arrival.cpp                    (create) arrivals, pins, sequence, regenerate steps, build order
desktop/bmffi/src/settings.cpp                   (create) build settings, staging, waiting parts, snap mix, snap files
desktop/bmffi/src/lists.cpp                      (modify) bm_struct_size
desktop/bmffi/tests/playback_test.cpp, arrival_test.cpp, settings_test.cpp (create)
desktop/crates/bm-sys/src/lib.rs                 (modify)
desktop/crates/bm/src/playback.rs, timeline.rs, settings.rs (create); lib.rs, session.rs, viewport.rs (modify)
desktop/crates/bm/tests/playback.rs, settings.rs (create)
desktop/crates/brickmotion/src/
  transport.rs          Transport: polls, version gate, lanes, seek/play/travel, pending play-step
  sound.rs              SnapSound: worker that writes tracks, rodio sink that follows the transport
  chrome/timeline.rs    (rewrite) header, ruler, playhead, sequence, Build track, pauses, submodels, empty Camera/Keys
  chrome/parts_lane.rs  packed part clips, selection, arrival drag, pin, menu, Library drop
  chrome/callout.rs     step callout in the viewport
  chrome/build_settings.rs, chrome/staging.rs, chrome/sound.rs   Properties pages
  commands.rs, shortcuts.rs, menubar.rs, app.rs, support.rs, viewport.rs, chrome/titlebar.rs,
  chrome/properties.rs, chrome/library.rs (modify)
desktop/crates/brickmotion/tests/transport.rs, timeline.rs, settings.rs, sound.rs (create)
desktop/scripts/bundle.sh                        (modify) copy SnapSounds
```

Header count: `crates/bm/tests/render.rs::header_and_rust_decls_agree` asserts the number of `BMFFI_API` functions (126 after M3). Each ABI task raises that literal by exactly the functions it lists.

---

### Task 1: M3 review fixes

**Files:** Modify `desktop/crates/brickmotion/src/{app.rs,placement.rs,viewport.rs,edit.rs,chrome/steps.rs}`; tests appended to `tests/steps.rs`, `tests/placement.rs`, `tests/gizmo.rs`, `tests/edit.rs`.

Found in the M3 review. Confirmed: the chosen step (probe test on `bb9c9f91`) and placement after click / live collision (against `PlacementController.swift:74-123`). By reading only, to be confirmed by the failing test before fixing: the gizmo refusal (first check whether `moveCommand`/`rotateCommand` can refuse mid-drag at all — if not, drop that test), the editor on a deleted step, and cut after a failed copy.

- [ ] **Step 1: Failing tests:**
  - `chosen_step_survives_undo_of_its_insert` (`tests/steps.rs`, 8880-1): `edit.step = Some(n-1)`; run `step.insert_after`; run `edit.undo`; `run_steps(2)` → `edit.step` is `None` or `< steps().len()`. (Probe on `bb9c9f91`: `Some(36)` with 36 steps, so placing a part is refused with "That build step no longer exists.")
  - `placement_ignores_moves_after_click` (`tests/placement.rs`, Metal): settle Snapped at point A, `accept()`, then move the pointer to B in the same frame as the next poll → the piece lands at A's previewed pose (compare `copy()` text of the new piece with a placement committed at A in a twin harness, or assert `awaiting()` stays true and `request` unchanged after the move). Swift: `PlacementController.move` returns while `awaitingCommit`.
  - `collision_toggle_updates_live_placement`: while placing, run `edit.collision` → the next preview request carries `collision == false` (`#[doc(hidden)] collision()` on `Placement`).
  - `step_editor_closes_when_its_step_goes`: open the editor on the last step, then `delete_step` through `run("step.delete")` from the menu path with the editor still open → editor is `None`, no write to a missing step, one undo restores.
  - `refused_gizmo_step_keeps_readout_true` (unit, `gizmo.rs`): `GizmoDrag::undo_last()` restores `moved` to its previous total; the viewport calls it when `translate`/`rotate` returns `refused`, and pushes one notice per drag (not per frame).
  - `cut_keeps_pieces_when_copy_fails`: with a failing clipboard (`#[cfg(test)]` seam `app.clipboard_fails = true`) `edit.cut` → piece count unchanged, one notice.
- [ ] **Step 2:** `cd desktop && cargo test -p brickmotion`. Expected: the six new tests FAIL.
- [ ] **Step 3: Implement:**
  - `StepsState::sync` clamps `app.edit.step` to `rows.len()` (None when empty) on every rebuild; it also closes the editor (`close_editor` without a write) when its step index is out of range.
  - `Placement::pointer`, `turn`, `cycle_grip`, `set_colour` return early while `awaiting`; new `set_collision(&mut self, vp, on: bool)` (same early return), called each frame from the viewport beside `set_colour`.
  - `GizmoDrag::step_move/step_rotate` keep the previous total; `undo_last(&mut self)`; viewport checks `Changed::refused`.
  - `edit::copy` returns `bool`; `cut` removes only on `true`.
- [ ] **Step 4:** `cargo test --workspace` PASS; `cargo clippy --workspace --all-targets -- -D warnings` 0.
- [ ] **Step 5: By hand (owner or implementer with `HOME=<scratchpad>/home`)** the M3 Task 13 Step 3 pass that was not done, plus ⌥E / ⌥Q on a real keyboard and ⌘C/⌘V inside a text field (the M3 ruling that needs windowed confirmation). Record results in `desktop/docs/m3-rulings.md` under "By hand".
- [ ] **Step 6: Commit.** `fix(desktop): M3 review fixes (chosen step, placement after click, gizmo refusals, cut)`.

### Task 2: Mockups for the M4 screens (owner gate)

**Files:** Create `.superpowers/brainstorm/65433-1795584607/content/m4-build-play.html` (static HTML in the locked look; reuse `final-locked.html`'s CSS and icon set).

The spec: "screens are mocked up and approved before they are built". The timeline frame is locked; these are not:

- [ ] **Step 1:** Draw, at 1440×900, in the Animate workspace:
  1. Timeline with a planned build: header (tools disabled, timecode, transport, rate, loop, ⋯ menu), ruler with orange playhead, Intro/Build/Hero strip, Build track expanded (step runs, pause lane with handles, one submodel lane, Parts lane with stacked clips, one pinned), Camera and Keys collapsed with "No keys yet" in `text3`, Snaps track with tick marks.
  2. Planning in progress (stage word + thin progress bar in the title bar's plan status) and a failed plan (error row in the timeline with Try Again / Try Standard Preview).
  3. Properties pages: **Build Settings** (Planner Native/Standard; Order Take Apart/Bottom Up; Flight Automatic/Web/Arc; pacing sliders; Restore Defaults), **Build Staging** (layout cards ×9, Group, Placement, Order, Frame Shape, Turn, Put back), **Snap Sound** (on/off, Source, Preset, Volume/Room/Stereo, Click and Body sections collapsed, Play Sample with Plate/Brick/Pin).
  4. The step callout in the Build workspace viewport (bottom left, above the selection chip): ‹ Step 4 of 38 › · Play Step · Play to End · appearance menu · ×.
- [ ] **Step 2:** Ask the owner to approve (one message with the file path and four bullet questions: placement of plan status, Properties pages vs sheets, callout position, Snaps track content). **No UI task (5–12) starts before the answer** (Task 5 draws the plan status; Tasks 3, 4 and 8 may run meanwhile). Record decisions in `desktop/docs/m4-rulings.md`. If the owner changes a layout, update the affected task's "Produces" before it starts.

### Task 3: Timeline logic moves into bmapp

**Files:** Create `native/app/bmapp/include/bmapp/{build_lanes.h,timeline_view.h}`, `src/{build_lanes.cpp,timeline_view.cpp}`, `tests/{build_lanes_test.cpp,timeline_view_test.cpp}`; modify `native/app/bmapp/CMakeLists.txt`; modify the four Swift files named in File Structure.

**Interfaces (C++, namespace `bmapp`):**
- `build_lanes.h`:
  - `struct LaneRun { size_t id; int step; double start, end, next; };` (Swift `Run`)
  - `struct LaneStep { int step; double start, end, pauseEnd; std::vector<size_t> flights; };` (Swift `StepClip`, flights as indexes into `BuildTimeline::flights`, in timeline order, sorted by `start`)
  - `struct LaneSubmodel { bool scheduled = false; int flight = -1; uint64_t item = 0; int depth = 0; double start = 0, end = 0, attach = -1; StringList path; PieceList pieces; };` (`attach < 0`: none) (Swift `SubmodelClip`, `scheduled` ↔ `.scheduled(flight)` / `.use(item)`)
  - `struct BuildLanes { uint64_t version; std::vector<LaneRun> runs; std::vector<LaneStep> steps; std::vector<LaneSubmodel> submodels; std::vector<size_t> diagnostics; };`
  - `BuildLanes buildLanes(const BuildTimeline& t, const Session& s);` — the body of `AnimationWorkspace.update()` from `let pins` to `clips = …` plus `resolvedSubmodels`, and `diagnostics` = flights whose `flag` is non-empty.
  - `bool runAt(const BuildLanes&, double seconds, size_t* run);` (false when there are no runs; bmapp headers do not use `std::optional`) (binary search as `run(at:)`)
  - `double travel(const BuildLanes&, double time, double duration, bool forward);` (Swift `travel`: next run start after `time + 0.02`, else `duration`; previous before `time − 0.02`, else 0)
  - `int64_t nearestFlight(const BuildTimeline&, double seconds, bool depth);` (−1 none)
  - `struct ArrivalTarget { bool ok = false; int step = 0; size_t before = 0; double time = 0; };` and `ArrivalTarget arrivalTarget(const BuildLanes&, const BuildTimeline&, const Session&, double time, const PieceList& excluding);` (`TimelineArrivalTarget.inRun`; `time` is the flight start or the run end the marker is drawn at)
  - `struct LaneSpan { double x = 0, width = 0; }; struct LanePacking { std::vector<uint32_t> rows; uint32_t count = 0; }; LanePacking packLane(const std::vector<LaneSpan>& sorted);` — each span's row with `PartLaneLayout.RowEnds` (place at `x + 0.0001` until `x + width + 1`); input sorted by x; `count` is the number of rows.
- `timeline_view.h`: `struct TimelineView { double zoom = 1, offset = 0, viewportWidth = 1, leadInset = 12, trailInset = 12; double logicalWidth() const; double contentWidth() const; double maximumOffset() const; double visibleStart() const; double visibleEnd() const; double x(double time, double duration) const; /* content x */ double timeAt(double screenX, double duration) const; bool magnify(double factor, double screenX); bool zoomBy(double factor, double playhead, double duration); bool fit(); bool reveal(double time, double duration, bool centred); bool panAtEdge(double screenX); }; double tickInterval(double duration, double width);` — `TimelineNavigation`'s maths with `maximumZoom = 64`; each mutator returns true when offset or zoom changed. Scroll plumbing (`awaitingZoom`, `scrollRequest`, `measure`, `scrubbing`, `followsPlayhead`) stays in each shell.

- [ ] **Step 1: Failing Catch2 tests** (fixtures: a hand-built `BuildTimeline` with 3 steps / 7 flights, one flight overlapping the next step; helicopter for the session-dependent ones):
  - `"runs merge overlapping steps"` (overlap → one run; `next` = following run start or `buildEnd`)
  - `"step clips pause to the next start"`; `"diagnostics are flagged flights"`
  - `"runAt and travel"` (times before the first run → run 0; travel forward past the last → duration)
  - `"arrival target before the first later flight, else after the last in run"`
  - `"packLane reuses the first free row"` (spans [0,10],[5,10],[12,3] → rows 0,1,0; count 2) and `"packLane grows past a power of two"` (100 overlapping spans → rows 0…99)
  - `"submodel uses not scheduled become use clips"` (helicopter, a hand timeline holding its submodel's pieces at depth 1)
  - `TimelineView`: `"magnify keeps the anchor under the pointer"`, `"zoom is clamped to 1…64"`, `"reveal scrolls only past the margins"`, `"panAtEdge speed is 2…28"`, `"tickInterval is 1-2-5"` (duration 100, width 760 → 10).
- [ ] **Step 2:** `cmake --build native/build && ctest --test-dir native/build -R "lanes|timeline view"` (`bmapp_tests` is registered there through `catch_discover_tests`, `native/app/bmapp/CMakeLists.txt:21`). Expected: compile FAIL.
- [ ] **Step 3:** Implement as a port of the Swift bodies named above (same constants).
- [ ] **Step 4:** Same command PASS. Then rewire Swift: `AnimationWorkspace.update()` calls `bmapp.buildLanes` and maps the result; `run(at:)`, `travel`, `nearestFlight` call bmapp; `TimelineArrivalTarget.inRun` calls `bmapp.arrivalTarget`; `PartLaneLayout.init` builds `LaneSpan`s and calls `bmapp.packLane` (the `RowEnds` struct is deleted); `TimelineNavigation` holds a `bmapp.TimelineView` and forwards its maths. Delete the Swift code each call replaces.
- [ ] **Step 5:** `cmake --build native/build-app && ctest --test-dir native/build-app` → all pass (≥ 619); `ctest --test-dir native/build` → all pass (≥ 462 + the new ones). Run `BrickMotion --selftest-motion` (the Swift timeline selftest) → passes.
- [ ] **Step 6: Commit.** `refactor(bmapp): build lanes and timeline view move down from Swift`.

### Task 4: Playback, timeline and arrival ABI

**Files:** Create `desktop/bmffi/src/{playback.cpp,arrival.cpp}`, `desktop/bmffi/tests/{playback_test.cpp,arrival_test.cpp}`, `desktop/crates/bm/src/{playback.rs,timeline.rs}`, `desktop/crates/bm/tests/playback.rs`; modify `bmffi.h`, `lists.cpp`, `CMakeLists.txt`, `bm-sys/src/lib.rs`, `bm/src/{lib.rs,session.rs,viewport.rs}`.

**Interfaces:**
- C (all on the UI thread's handles):
  - Enums: `BmPlanState {BM_PLAN_IDLE, BM_PLAN_PLANNING, BM_PLAN_READY, BM_PLAN_FAILED}`, `BmPlanStage {WAITING, SOLVING, CHECKING_FLIGHTS, PREPARING, STANDARD_PREVIEW}`, `BmAssemblyPreview {ASSEMBLED, SEPARATED, LAID_OUT, EXPLODED}`, `BmSegment {INTRO, BUILD, HERO}` (bmapp order).
  - `typedef struct { double seconds, duration; bool playing, waiting_to_play, at_rest, stale; BmPlanState plan; uint64_t version; BmPlanStage stage; } BmPlaybackState;`
  - `typedef struct { bool edges, floor, shadows, ambient_occlusion, auto_plan, scene_backdrop; } BmViewportPreferences;`
  - Viewport: `bm_viewport_play(v, bool)`, `bm_viewport_play_range(v, double start, double end)`, `bm_viewport_seek(v, double)`, `bm_viewport_show_rest` (exists), `bm_viewport_set_playback_rate(v, double)`, `bm_viewport_set_playback_loop(v, bool)`, `bm_viewport_request_plan(v)`, `bm_viewport_regenerate_plan(v, bool standard_preview)`, `BmPlaybackState bm_viewport_playback_state(const BmViewport*)`, `BmString bm_viewport_plan_error(const BmViewport*)`, `uint64_t bm_viewport_planned_version(const BmViewport*)`, `void bm_viewport_set_preferences(BmViewport*, BmViewportPreferences)`, `void bm_viewport_arrange(BmViewport*, int32_t step, BmAssemblyPreview)`, `size_t bm_viewport_build_order(BmViewport*, uint32_t* out, size_t cap)` (two-call).
  - Timeline (owned snapshot): `BmTimeline* bm_viewport_build_timeline(const BmViewport*)`, `typedef struct { uint64_t version; double duration, fps, build_start, build_end, planning_ms; bool standard_preview; } BmTimelineInfo; BmTimelineInfo bm_timeline_info(const BmTimeline*)`, `typedef struct { uint32_t piece; int32_t step, depth, color; double start, end; const char *name, *flag, *blocker; bool independent; } BmFlightRow;` `bm_timeline_flights_len`, `BmFlightRow bm_timeline_flight_at(const BmTimeline*, size_t)`, `bm_timeline_notes_len`, `const char* bm_timeline_note_at`, `bm_timeline_free`.
  - Lanes over a timeline: `BmLanes* bm_lanes_new(const BmTimeline*, const BmSession*)`, `typedef struct { size_t id; int32_t step; double start, end, next; } BmLaneRun;` `bm_lanes_runs_len`, `bm_lanes_run_at`, `typedef struct { int32_t step; double start, end, pause_end; size_t flights; } BmLaneStep;` `bm_lanes_steps_len`, `bm_lanes_step_at`, `size_t bm_lanes_step_flights(const BmLanes*, size_t i, size_t* out, size_t cap)`, `typedef struct { bool scheduled; int32_t flight; uint64_t item; int32_t depth; double start, end, attach; bool has_attach; const char* name; size_t pieces; } BmLaneSubmodel;` (`name` = last path element) `bm_lanes_submodels_len`, `bm_lanes_submodel_at`, `size_t bm_lanes_submodel_pieces(const BmLanes*, size_t, uint32_t*, size_t)`, `size_t bm_lanes_diagnostics(const BmLanes*, size_t* out, size_t cap)`, `int64_t bm_lanes_run_index_at(const BmLanes*, double seconds)` (−1 none), `double bm_lanes_travel(const BmLanes*, double time, double duration, bool forward)`, `bool bm_lanes_arrival_target(const BmLanes*, const BmTimeline*, const BmSession*, double time, const uint32_t* excluding, size_t n, int32_t* step, size_t* before, double* at)`, `bm_lanes_free`.
  - `size_t bm_pack_lane(const double* x, const double* width, size_t n, uint32_t* rows_out)` (returns the row count).
  - `typedef struct { double zoom, offset, viewport_width, lead_inset, trail_inset; } BmTimelineView;` `bool bm_timeline_view_magnify(BmTimelineView*, double factor, double screen_x)`, `bool bm_timeline_view_zoom_by(BmTimelineView*, double factor, double playhead, double duration)`, `bool bm_timeline_view_fit(BmTimelineView*)`, `bool bm_timeline_view_reveal(BmTimelineView*, double time, double duration, bool centred)`, `bool bm_timeline_view_pan_at_edge(BmTimelineView*, double screen_x)`, `double bm_timeline_view_time_at(BmTimelineView, double screen_x, double duration)`, `double bm_tick_interval(double duration, double width)`. (Pure read maths — `x`, visible range — are done in Rust from the struct fields with the same formulas; a test compares them to C.)
  - Session (`arrival.cpp`): `BmChange bm_session_move_arrival(s, const uint32_t*, size_t, size_t step, size_t before, bool force)`, `bm_session_reorder_arrival(s, size_t step, size_t from, size_t to)`, `bm_session_set_arrival_pinned(s, const uint32_t*, size_t, bool)`, `size_t bm_session_arrival_pins(const BmSession*, uint32_t*, size_t)`, `bm_session_set_sequence_duration(s, BmSegment, double)`, `bm_session_regenerate_steps(s, const uint32_t*, size_t)`, `bm_session_move_to_new_step(s, const uint32_t*, size_t, size_t index)`, `size_t bm_session_undo_depth(const BmSession*)` (over `Session::undoDepth`; the "one undo step" tests in Tasks 6, 7, 11 and 12 compare it before and after a gesture).
  - `bm_struct_size` learns every new struct name.
- Rust:
  - `bm::playback`: `PlanState`, `PlanStage`, `AssemblyPreview`, `Segment` enums; `PlaybackState` (fields as C, `Copy, Default, PartialEq`); `ViewportPreferences` (`Default` = bmapp defaults).
  - `bm::timeline`: `Timeline` (owns `BmTimeline*`, `!Send`): `info() -> TimelineInfo`, `flights() -> Vec<FlightRow>` (`FlightRow { piece: u32, step: i32, depth: i32, color: i32, start: f64, end: f64, name: String, flag: String, blocker: String, independent: bool }`), `notes() -> Vec<String>`. `Lanes` (owned Rust data, `Clone`): `Lanes::new(&Timeline, &Session) -> Lanes` with `runs: Vec<LaneRun>`, `steps: Vec<LaneStep>` (`flights: Vec<usize>`), `submodels: Vec<LaneSubmodel>`, `diagnostics: Vec<usize>`; `run_at(&self, seconds) -> Option<usize>`, `travel(&self, time, duration, forward) -> f64`, `arrival_target(&self, &Timeline, &Session, time: f64, excluding: &[u32]) -> Option<ArrivalTarget>` (`ArrivalTarget { step: usize, before: usize, time: f64 }`). Note: `Lanes` copies out of C once; `run_at`/`travel`/`arrival_target` keep the C `BmLanes` alive inside (`Rc`) so the maths is bmapp's. `pack_lane(spans: &[(f64, f64)]) -> (Vec<u32>, u32)`. `TimelineView` (`Copy`, fields as C, `Default` zoom 1, insets 12) with `magnify`, `zoom_by`, `fit`, `reveal`, `pan_at_edge`, `time_at`, `x(time, duration)`, `visible_start/end`; `tick_interval(duration, width)`.
  - `Viewport`: `play(&mut self, on: bool)`, `play_range(&mut self, start, end)`, `seek(&mut self, s)`, `set_playback_rate`, `set_playback_loop`, `request_plan`, `regenerate_plan(standard: bool)`, `playback_state(&self) -> PlaybackState`, `plan_error(&self) -> String`, `planned_version(&self) -> u64`, `set_preferences(&mut self, &ViewportPreferences)`, `arrange(&mut self, step: Option<usize>, AssemblyPreview)` (None = −1, full inventory), `build_order(&mut self) -> Vec<u32>`, `build_timeline(&self) -> Timeline`.
  - `Session`: `move_arrival(&self, pieces, step, before, force) -> Changed`, `reorder_arrival(step, from, to)`, `set_arrival_pinned(pieces, bool)`, `arrival_pins() -> Vec<u32>`, `set_sequence_duration(Segment, f64)`, `regenerate_steps(order: &[u32])`, `move_to_new_step(pieces, index)`, `undo_depth() -> usize`.

- [ ] **Step 1: Failing C tests** (helicopter, 640×480 viewport; plan with a 60 s deadline polling `playback_state` with `bm_viewport_draw` between polls): `"plan becomes ready"` (state READY, duration > 0, `planned_version == session version`); `"timeline rows match the plan"` (flights_len > 0, no piece twice, every flight `end >= start`; the helicopter has a submodel, so rows need not equal `piece_count`); `"seek and play range"` (seek 1.0 → `seconds` within one frame; `play_range(0, 0.5)` → playing until ≥ 0.5 then stops); `"lanes from the timeline"` (runs non-empty, `run_index_at(0) == 0`, `travel(0, d, true) > 0`); `"an edit makes the plan stale"` (move piece 0 → `stale == true` or plan not READY, `planned_version != version`); `"arrange and show rest"`; `"move arrival is one undo step"`, `"pins round trip"`, `"sequence duration sets the intro"` (intro 2.0 → after replan `build_start ≈ 2.0`); `"pack lane"` and `"timeline view magnify"` (thin wrappers agree with bmapp).
- [ ] **Step 2:** `cd native/build-rust && ninja bmffi_tests && ./bmffi/bmffi_tests`. Expected: compile FAIL. Implement; raise the header literal by the functions listed; PASS; `nm -gU bmffi/libbmffi.dylib | grep -vc ' _bm_'` → `0`.
- [ ] **Step 3: Failing Rust tests** (`bm/tests/playback.rs`, skip without Metal): the same through the wrappers, plus `timeline_view_x_matches_c` (Rust `x`/visible range against `bm_timeline_view_time_at` round trip on 20 random views). Implement; `cargo test -p bm` PASS.
- [ ] **Step 4: Commit.** `feat(desktop): playback, timeline, lanes and arrival ABI`.

### Task 5: Transport and planner in the app

**Files:** Create `desktop/crates/brickmotion/src/transport.rs`, `tests/transport.rs`; modify `app.rs`, `commands.rs`, `shortcuts.rs`, `menubar.rs`, `support.rs` (prefs), `viewport.rs`, `chrome/titlebar.rs`, `edit.rs`.

**Interfaces:**
- `pub struct Transport { pub state: PlaybackState, pub version: Option<u64>, pub timeline: Option<Rc<bm::timeline::Timeline>>, pub flights: Vec<FlightRow>, pub lanes: Option<Lanes>, pub pins: HashSet<u32>, pub info: TimelineInfo, pub failure: String, pub rate: f64, pub looping: bool, pub focused_step: Option<usize>, pub step_preview: Option<AssemblyPreview>, last_build_time: f64, pending_step: Option<(usize, bool, u64)>, rebuild_steps_at: Option<u64>, staging_preview_at: Option<u64>, generation: Option<u64> }` (`Default`; rate 1.0).
- `Transport::update(&mut self, session: &Session, vp: &mut Viewport) -> bool` (`&mut`: resolving a pending step or staging preview seeks or plays) (true when anything shown changed): the `AnimationWorkspace.update()` sequence — reset on a new generation; copy the state; read `plan_error` on Failed; when Ready and `version != state.version`: `build_timeline()`, `flights()`, `arrival_pins()`, `Lanes::new`, then resolve `pending_step` / `rebuild_steps_at` / `staging_preview_at` if their version still matches.
- `time(&self) -> f64` (`showsStaleBuild` rule: stale with a duration shows `last_build_time`; at rest shows `duration`), `duration(&self)`, `ready()`, `busy()`, `stale_shown()`, `stage_label(&self) -> &'static str` (Swift `planningLabel` words), `current_step(&self) -> Option<usize>`.
- `toggle(&mut self, vp)` (cancel placement first, at the app level), `seek(&mut self, vp, t)` (frame-rounded; clears focus and preview), `rest(&mut self, vp)`, `travel(&mut self, vp, forward)`, `play_step(&mut self, vp, session, step, through_end)` (plans first when not ready, remembering `pending_step`), `arrange(&mut self, vp, step: Option<usize>, mode)`, `plan(&mut self, vp)`, `regenerate(&mut self, vp, standard: bool)`, `regenerate_steps(&mut self, session: &Session, vp: &mut Viewport) -> Option<bm::Changed>` (Swift `regenerateSteps`/`applyStepOrder`: when ready, `session.regenerate_steps(&vp.build_order())`, one undo step, returned for `app.edited`; otherwise plans and remembers `rebuild_steps_at`, and `update` applies it later, handing the result out through `take_changed(&mut self) -> Option<Changed>`), `set_rate(vp, f64)`, `set_looping(vp, bool)`.
- App: field `pub transport: Transport`; `update` runs once per frame after `poll_loader`, before chrome; repaint every frame while `playing || waiting_to_play || busy`, else `request_repaint_after(250 ms)` while a document is open (planning state changes arrive by polling).
- Commands: `transport.play` "Play" / "Pause" (title follows state) Space [Document]; `transport.start` Home; `transport.end` End; `transport.prev_step` ⇧← and `transport.next_step` ⇧→ [Document, Animate only: a new `When::Animate` check in `enabled`]; `video.plan_build`, `video.regenerate` "Rebuild" (Standard Preview variant in the palette: `video.standard_preview`), `video.order` "Regenerate Build Steps" [Document with pieces].
- Prefs: `auto_plan` sent with `set_preferences` when a viewport is created and when toggled; `play_snap_sounds` stored for Task 12.
- Title bar: the plan status left of ⚙ shows "Planned · N pieces", the stage label with a 2-pt accent progress line (indeterminate) while planning, "Out of date" in `text3` when stale, "Plan failed" in `text2` when Failed. Clicking it runs `video.plan_build` (or switches to Animate when failed).
- While playing: placement cancels; the gizmo is hidden; editing commands that change the model still run (the engine stops playback and marks stale).

- [ ] **Step 1: Failing tests** (`tests/transport.rs`, helicopter harness, Metal; a helper `plan_ready(&mut h, 60 s)` steps until `transport.ready()`):
  - `space_plans_then_plays`: press Space with nothing planned → `busy()`; after `plan_ready`, Space → `state.playing`; Space again → paused; time advanced.
  - `home_end_seek`: End → `time() == duration()` within a frame; Home → 0.
  - `next_step_moves_to_the_next_run_start` (Animate workspace): ⇧→ → `time()` equals `lanes.runs[1].start` (rounded to a frame); in Build workspace ⇧→ does not seek.
  - `edit_while_playing_marks_stale_and_never_mixes_versions` (Review Focus 1): play, then `run("edit.nudge_right")` with piece 0 selected → next frame `state.stale || !ready()`, `transport.version` still the old one and `lanes` still the old lanes until a new Ready version arrives, after which `lanes.runs` come from `build_timeline()` of the new version (`transport.version == state.version`).
  - `document_switch_resets_transport`: open 8880-1 after the helicopter → `version == None`, `lanes == None`, `focused_step == None`.
  - `play_cancels_placement`.
  - `auto_plan_pref_is_sent`: prefs `auto_plan = false`, open → nothing plans by itself within 2 s; `video.plan_build` plans.
  - `playback_frame_time` (Review Focus 4, `#[ignore]` release): 10294-1 at 2880×1800 pixels, play 3 s → median frame (viewport draw + readback + upload + UI) printed and < 33 ms. If it fails, record it in `m4-rulings.md` and add the shared-texture task from the spec's Viewport section before Task 6.
- [ ] **Step 2:** Run; FAIL. Implement. `cargo test --workspace` PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): transport, planner status and play keys`.

### Task 6: The live Build timeline

**Files:** Rewrite `desktop/crates/brickmotion/src/chrome/timeline.rs`; create `tests/timeline.rs`; modify `app.rs`.

**Interfaces:**
- Consumes: Task 4 `TimelineView`, `tick_interval`, `Lanes`, `Segment`; Task 5 `Transport`.
- Produces (layout per the Task 2 approved mockup; sizes from the M1 placeholder: header 40, ruler 26, track heads 248 wide):
  - `pub struct TimelineState { pub view: TimelineView, pub open: HashSet<Track>, pub scrubbing: bool, pub follows_playhead: bool, drag: Option<TimelineDrag>, pub height: f32 }` with `enum Track { Camera, Build, Keys, Snaps }` (Build open by default) and `enum TimelineDrag { Scrub, Hold { run: usize, seconds: f64 }, Trim { segment: Segment, seconds: f64 }, Arrival(..) /* Task 7 */ }`.
  - **Header:** four tools (disabled, "coming soon"), timecode `MM:SS:FF` of `time()` and of `duration()`, ⏮ ▶/⏸ ⏭ (start / play / end), a rate menu (0.25×, 0.5×, 1×, 1.5×, 2×, 4×; `AnimationTimeline.swift:80`), Loop Playback toggle, Fit, zoom − / +, ⋯ menu (Plan Build, Rebuild, Try Standard Preview, Regenerate Build Steps, separator, "Play snap sounds" ✓, "Plan automatically" ✓, "Follow playhead" ✓).
  - **Ruler:** ticks every `tick_interval(duration, logical_width)`, labels `M:SS`; press and drag scrubs (`seek` each frame, `scrubbing = true`), release anywhere ends it; the playhead is an orange 1-pt line with a timecode flag, drawn over every lane. Pinch / ⌘-scroll → `magnify` around the pointer; horizontal scroll pans; while playing and following, `reveal(time)` keeps the playhead in view; dragging past either edge calls `pan_at_edge` each frame.
  - **Sequence strip** (inside Build): Intro / Build / Hero clips from `info.build_start`, `build_end`, `duration`; click seeks to its start; trailing/leading handles trim (`Trim` drag: live seconds label, clamp Intro/Hero 0.2–120 s, Build 1–1800 s, tenths; commit `set_sequence_duration` once on release).
  - **Step runs:** one block per run (`Step N` and title when it fits), the current run accented; click → `seek(run.end)` and `focused_step`; double-click → `play_step`; right-click → the step menu (M3 commands for that step plus Play Step, Play to End, Select Pieces); only runs in `visible_start..visible_end` (± 96 pt) are laid out.
  - **Pause lane:** a strip per run whose `next − end ≥ 0.12`; only the last run of a step is editable; drag sets the hold (0–10 s, tenths) with a live label; release commits `set_step_fields(step, {pause_after}, false)` once; ←/→ on a focused handle adjust 0.1 s.
  - **Submodel lanes:** one row per depth level of `lanes.submodels`, clip labelled with its name; click selects its pieces and seeks to its `end`.
  - **Camera / Keys:** collapsed rows with "No keys yet" (M5). **Snaps:** tick marks at each flight's `end` (where a snap sounds), drawn only for visible times; muted when `play_snap_sounds` is off.
  - **States:** nothing planned → a centred "Plan Build" button with the stage label; planning → the last Ready lanes greyed with the stage label; Failed → an error row (`failure` text, Try Again, Try Standard Preview); diagnostics or notes → a disclosure "N flagged flights" listing part, flag and blocker; clicking a row seeks to its start and selects the piece.
- [ ] **Step 1: Failing tests** (`tests/timeline.rs`, Animate workspace, helicopter planned):
  - `ruler_click_seeks`: click at 25 % of the lanes' width at zoom 1 → `time()` ≈ 25 % of duration (± one frame).
  - `scrub_release_outside_ends_scrub` (Review Focus 5): press on the ruler, move outside the window, release there → `scrubbing == false`, playback state not playing.
  - `pinch_zoom_keeps_time_under_pointer`.
  - `step_run_double_click_plays_that_step` (`play_range` → `state.playing`, `current_step() == Some(i)`).
  - `hold_drag_is_one_undo_step` (Review Focus 2): drag a pause handle right over 8 frames, release → `steps()[i].pause_after` grew by the dragged tenths, `undo_depth()` +1, one `edit.undo` restores; at most one replan (plan version advanced once).
  - `trim_intro_commits_once`: drag the Intro handle → after release and replan `info.build_start` equals the label's value.
  - `failed_plan_shows_try_again` (seam: `#[cfg(test)] transport.failure = "x"` with plan Failed).
  - `big_model_timeline_frame` (`#[ignore]`, release, `BM_BIG_MODEL`): planned 10294-1, frames at Fit and at zoom 64 → slowest < 16 ms.
- [ ] **Step 2:** Run; FAIL. Implement. `cargo test --workspace` PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): live Build timeline (ruler, transport, sequence, steps, pauses, submodels)`.

### Task 7: The Parts lane

**Files:** Create `desktop/crates/brickmotion/src/chrome/parts_lane.rs`; tests appended to `tests/timeline.rs`; modify `chrome/timeline.rs`, `chrome/library.rs` (tiles become drag sources).

**Interfaces:**
- `PartsLane { layout_for: Option<(u64 /*plan*/, u32 /*width px*/, u32 /*zoom×1000*/)>, clips: Vec<Clip>, rows: u32 }`, `Clip { flight: usize, rect: Rect /* content coords */, time_x: f32, label: String }`. Layout: label = part name without `.dat`, width = `clamp(text_width + 23, 52, 90)` (+10 pinned), clip width `max(label, duration − 1)`, x = `min(time_x, logical_width − width)`; sorted by x; rows from `bm::timeline::pack_lane`; rebuilt only when the plan version, width or zoom changes. Row height 20, clip 17, inset 4; mono 10-pt semibold labels; fill = the part's colour at 35 % with a 1-pt border of the colour; the selection uses the accent border.
- Drawing and hit-testing visit only clips whose rect meets the visible content range.
- Click → seek to the flight's `end`, select its piece; ⌘/⇧-click toggles it in the selection; double-click frames it in the viewport.
- Drag a clip (or the selected clips) → `Arrival` drag: an accent insertion marker at `lanes.arrival_target(time, excluding = dragged)`; release over the lane → `move_arrival(pieces, step, before, force = ⌥ held)` once; release elsewhere or Esc → nothing; edge pan while dragging.
- Right-click menu: the items and titles of `TimelinePartMenu.make` (`TimelineMenus.swift:16-130`), read in full before building it: section header "Step N · Arrival i of n", Frame in View, Open Containing Submodel, Order section (pin/unpin, Move to Step ▸, New Step ▸, Split Step at This Part, order moves via `reorder_arrival`, Split Selected Parts into New Step), Delete Part. The Motion section and "Edit Flight as Keyframes" are M5 (left out, not disabled).
- Library tiles are drag sources (egui DnD payload `LibraryDrag(PartMatch)`); dropping on the Parts lane at a target begins a placement whose commit goes to `(target.step, Some(target.before))` (extend `Placement` with `before: Option<usize>` passed to `place_part`; Task 9 of M3's API already accepts `before`).
- [ ] **Step 1: Failing tests:**
  - `lane_clips_match_flights` (count == `flights.len()`; no two clips in a row overlap).
  - `clip_click_selects_and_seeks`.
  - `arrival_drag_moves_the_piece_once` and `arrival_drag_released_outside_commits_once` (Review Focus 5): drag a clip from step 1 into step 0, release outside the window → exactly one of: one undo step added (released over the lane) or none (outside); never two.
  - `alt_drag_forces_order` (`force == true` reaches the engine: the item order in `step_items` changes and `arrival_pins()` contains it — `moveArrivalCommand` pins forced items, `commands.cpp:2702`; undo name "Move and Pin Arrival").
  - `pin_from_menu_round_trips`.
  - `library_drop_inserts_before_target` (Metal): drop 3001 on the lane before a known flight → new piece in that step at index `before`.
  - `big_model_parts_lane` (Review Focus 4, `#[ignore]` release): 10294-1 at Fit and at 64× → layout (first frame) < 50 ms, every later frame < 16 ms, clips visited per frame ≤ visible + one row.
- [ ] **Step 2:** Run; FAIL. Implement. `cargo test --workspace` PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): Parts lane with arrival drag, pins and Library drop`.

### Task 8: Settings ABI (build, staging, waiting parts, sound)

**Files:** Create `desktop/bmffi/src/settings.cpp`, `desktop/bmffi/tests/settings_test.cpp`, `desktop/crates/bm/src/settings.rs`, `desktop/crates/bm/tests/settings.rs`; modify `bmffi.h`, `lists.cpp`, `CMakeLists.txt`, `bm-sys`, `bm/src/{lib.rs,session.rs,viewport.rs}`.

**Interfaces:**
- C:
  - `typedef enum { BM_ORDER_TAKE_APART, BM_ORDER_BOTTOM_UP } BmBuildOrder; typedef enum { BM_FLIGHT_AUTOMATIC, BM_FLIGHT_WEB, BM_FLIGHT_ARC } BmFlightShape;`
  - `typedef struct { bool standard_planner; BmBuildOrder order; BmFlightShape flight; bool clean_grown_units; double pieces_per_second, gap, step_pause, clearance, corner, video_seconds; } BmBuildSettings;` `BmBuildSettings bm_session_build_settings(const BmSession*)`, `BmChange bm_session_set_build_settings(BmSession*, BmBuildSettings)`.
  - `typedef struct { const char *layout, *group, *sides, *match; double aspect; } BmStagingSettings;` (strings borrowed from a static table on read; copied on write) `BmStagingSettings bm_session_staging_settings(const BmSession*)` (the returned strings point into the session's copy and are valid until the next staging call — the wrapper copies at once), `bm_session_set_staging_settings`, `double bm_session_staging_turn`, `bm_session_set_staging_turn(s, double)`, `size_t bm_session_moved_waiting_parts`, `bm_session_put_back_waiting_parts(s)`, `bm_session_apply_staging(s, BmStagingSettings, double turn, bool straighten)`, `bm_session_turn_waiting_part(s, uint32_t, double)`, `bool bm_viewport_can_turn_waiting_part(const BmViewport*, uint32_t)`, `double bm_viewport_waiting_turn_to_match(const BmViewport*, uint32_t)`.
  - `typedef enum {BM_SNAP_PHYSICAL, BM_SNAP_RECORDED, BM_SNAP_SYNTHESISED} BmSnapSource; typedef enum {BM_SNAP_ALL, BM_SNAP_FREESOUND, BM_SNAP_OPENGAMEART} BmSnapLibrary; typedef enum {BM_SNAP_PLATE, BM_SNAP_BRICK, BM_SNAP_PIN} BmSnapExample;` `typedef struct { bool enabled; BmSnapSource source; BmSnapLibrary library; double volume, room, stereo, click, brightness, thump, thump_pitch, thump_length, pitch, variation; bool size_pitch, size_match; int32_t together; } BmSnapMix;` `bm_session_snap_mix`, `bm_session_set_snap_mix`, `BmSnapMix bm_snap_mix_preset(const char* name)`, `bool bm_write_snap_preview(BmSnapMix, BmSnapExample, const char* recordings, const char* file)`, `BmString bm_viewport_write_snap_track(BmViewport*, const char* file, const char* recordings)` (empty = written).
- Rust `bm::settings`: `BuildSettings` (`Default` = bmapp defaults: 2.0, 0.05, 0.25, 24, 20), `BuildOrder`, `FlightShape`; `StagingSettings { layout, group, sides, match_: String, aspect: f64 }` with constants `LAYOUTS: [&str; 9] = ["packed","spaced","grid","rows","scattered","showcase","gallery","fan","camera-frame"]`, `GROUPS = ["step","colour","part","size","all"]`, `SIDES = ["front-back","front","behind","sides","around"]`, `MATCHES = ["fill","nearest"]`; `SnapMix` (all fields), `SnapSource`, `SnapLibrary`, `SnapExample`, `snap_mix_preset(name) -> SnapMix`, `PRESETS: [(&str, &str); 6] = [("Part Physics","physical"),("Balanced","balanced"),("Product Video","product"),("Click Only","click"),("Soft","soft"),("Synthesised","synth")]` (title, engine id; `SoundSettingsSheet.swift:74-79`; an unknown id gives the default mix), `write_snap_preview(&SnapMix, SnapExample, recordings: &Path, file: &Path) -> bool` (free function: safe on a worker). Methods on `Session` and `Viewport` named as the C calls without the prefix; `Viewport::write_snap_track(&mut self, file: &Path, recordings: &Path) -> Result<(), String>`.
- [ ] **Step 1: Failing C tests:** `"build settings round trip and replan"` (set pieces_per_second 4 → read back 4; `planned_version` drops below version); `"staging round trip"` (layout "grid", group "colour"); `"apply staging is one undo step"`; `"snap mix round trip"`; `"presets differ"` (two named presets give different `click`); `"snap preview writes a wav"` (temp file > 44 bytes, starts with `RIFF`); `"snap track needs a plan"` (non-empty reason before planning; empty after planning with `enabled = true`).
- [ ] **Step 2:** Run; compile FAIL. Implement; header literal raised; PASS; exports `0`.
- [ ] **Step 3:** Rust tests (`bm/tests/settings.rs`): the same through wrappers, plus `write_snap_preview_on_a_worker` (call inside `std::thread::spawn`). PASS.
- [ ] **Step 4: Commit.** `feat(desktop): build, staging and snap sound settings ABI`.

### Task 9: Step callout

**Files:** Create `desktop/crates/brickmotion/src/chrome/callout.rs`; tests appended to `tests/transport.rs`; modify `chrome/mod.rs`, `chrome/steps.rs` (step menu gains Play Step / Play to End / Step Appearance ▸), `commands.rs`.

**Interfaces:**
- Shown in the Build workspace's viewport when `transport.focused_step` is set (choosing a step in the Steps tab sets it) and in Animate when a step run is chosen; position per Task 2's ruling (default: bottom left, above the selection chip). Content: ‹ "Step N of M" › (Previous / Next Step: `arrange(step ± 1, current mode)`), Play Step (`play_step(step, false)`), Play to End (`play_step(step, true)`), an appearance menu (Assembled through This Step / Separated from Earlier Steps / Lay Out These Parts / Explode This Step → `AssemblyPreview`), Show All Steps (`arrange(None, Assembled)`), × (`rest`), and "N parts" (from `StepRow::pieces`).
- Commands [Step]: `step.play`, `step.play_to_end`, `step.appearance_assembled|separated|laid_out|exploded`, `step.show_all`.
- [ ] **Step 1: Failing tests:** `choosing_a_step_shows_the_callout`; `next_step_arranges_the_next`; `play_step_plans_then_plays_that_step` (pending play resolved after Ready: `current_step() == Some(i)` and playing); `close_returns_to_rest` (`state.at_rest`).
- [ ] **Step 2:** Run; FAIL. Implement. PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): step callout with play and step appearances`.

### Task 10: Properties pages framework

**Files:** Modify `desktop/crates/brickmotion/src/chrome/properties.rs`, `app.rs`; create `chrome/widgets.rs` (shared slider-row and segmented control); unit tests in `widgets.rs`.

**Interfaces:**
- `pub enum Page { Inspector, BuildSettings, Staging, SnapSound }` with `app.properties_page: Page`. A page replaces the inspector content under a header "‹ Build Settings" (‹ returns to Inspector); `model.build_settings`, `video.flights` (scrolls to Flights), `video.staging`, `video.snap_sound`, `video.mix` open their page.
- `widgets::slider_row(ui, theme, label, value: &mut f64, range, step, unit, help) -> SliderEvent` where `enum SliderEvent { None, Changing, Committed(f64) }`: drag-to-scrub number field (M2 style) plus a thin slider; `Committed` once on drag release, Return, or focus loss after typing. `widgets::segmented(ui, theme, options: &[&str], selected: &mut usize) -> bool`.
- [ ] **Step 1: Failing unit tests:** `drag_commits_once_on_release` (kittest: drag a slider over 10 frames → nine `Changing`, one `Committed`); `typing_commits_on_return`; `escape_reverts` (value back to the start, no `Committed`).
- [ ] **Step 2:** Implement; PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): Properties pages and commit-on-release controls`.

### Task 11: Build Settings and Build Staging

**Files:** Create `chrome/build_settings.rs`, `chrome/staging.rs`, `tests/settings.rs`; modify `commands.rs`, `app.rs`, `viewport.rs` (waiting-part turn menu entries).

**Interfaces:**
- **Build Settings page** (copy from `BuildSettingsSheet.swift`): Planner segmented Native / Standard ("The standard planner has a single flight shape." when Standard); Order Take Apart ("Planned by taking it apart") / Bottom Up ("Built forward from the base"); Flight Path Automatic / Web / Arc with each one-line help; "Split grown units the planner still flags"; Pacing: Each flight (`pieces_per_second` 0.25–12, shown as the resulting seconds), Gap between parts 0–2 s, Hold at each step 0–5 s ("Never more than a fifth of the flying time in all."), Clearance 4–200 LDU, Corner rounding 0–80 LDU ("Used by Arc flights.", disabled unless Arc); when `video_seconds > 0` the pacing rows are disabled with the Swift note "The <seconds> video length sets each flight and step hold." (`BuildSettingsSheet.swift:76`); Restore Defaults. Every change: `set_build_settings(new)` once (segments on click; sliders on `Committed`) through `app.edited`.
- **Build Staging page** (copy from `StagingSheet.swift`): Staging Layout as nine small cards drawn from the Swift layout rectangles (`StagingSheet.swift:15-23`, the same numbers, our own drawing in `text3` outlines, accent when chosen); Group (By Step / Colour / Part / Size / All at Once), Placement (Front and Back / Front / Behind / Left and Right / All Around), Order (Fill in Order / Nearest to Final Position), Frame Shape (the `frameSizes` list at `StagingSheet.swift:65`, plus "Project Frame Shape" when the aspect is none of them); Turn slider −180…180° with Reset turn; "Put back the part turned or moved on the floor" (shows `moved_waiting_parts()`; disabled at 0). The page holds a draft; **Apply** calls `apply_staging(draft, turn, straighten)` once and then previews (`transport.staging_preview_at` → seek 0 after the replan, as Swift `previewStaging`); **Reset** reloads the draft from the session.
- Waiting-part floor drag (the web's staging drag): with playback paused mid-build, a primary drag that starts on a piece where `can_move_waiting_part` is true calls `begin_waiting_drag(piece, x, y)`, `drag_waiting_part(x, y)` each frame and `end_waiting_drag()` on release, then `shift_waiting_part(piece, delta)` once (one undo step, "Move Waiting Part"). Task 8 adds these to the ABI: `bool bm_viewport_can_move_waiting_part(const BmViewport*, uint32_t)`, `bool bm_viewport_begin_waiting_drag(BmViewport*, uint32_t, double, double)`, `BmVec3 bm_viewport_drag_waiting_part(BmViewport*, double, double)`, `BmVec3 bm_viewport_end_waiting_drag(BmViewport*)`, `BmChange bm_session_shift_waiting_part(BmSession*, uint32_t, BmVec3)`, `BmVec3 bm_session_waiting_shift(const BmSession*, uint32_t)`. Test: `waiting_drag_is_one_undo_step`.
- `video.straighten` → `put_back_waiting_parts()`; viewport right-click on a waiting piece during playback: Turn Waiting Part 90° / −90° / Turn to Match (`can_turn_waiting_part`, `waiting_turn_to_match`).
- [ ] **Step 1: Failing tests** (`tests/settings.rs`, helicopter):
  - `pacing_slider_drag_is_one_undo_and_one_plan` (Review Focus 2): open Build Settings, drag "Each flight" over 10 frames, release → `undo_depth()` +1, `build_settings().pieces_per_second` changed, the transport sees exactly one new plan version after it settles.
  - `segmented_order_change_replans`.
  - `restore_defaults_is_one_step`.
  - `staging_apply_is_one_undo_and_previews_from_zero` (after replan `time() == 0`).
  - `staging_reset_discards_draft` (version unchanged).
  - `straighten_puts_back` (turn a waiting part, then `video.straighten` → `moved_waiting_parts() == 0`, one undo restores 1).
  - `typing_in_a_settings_field_does_not_edit` (Review Focus 3 of M3, carried: "pmceqr" into the Clearance field → no model edit).
- [ ] **Step 2:** Run; FAIL. Implement. PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): Build Settings and Build Staging pages`.

### Task 12: Snap sound

**Files:** Create `desktop/crates/brickmotion/src/sound.rs`, `chrome/sound.rs`, `tests/sound.rs`; modify `Cargo.toml` (`rodio = { version = "0.23", default-features = false, features = ["playback", "wav"] }` (confirm the feature names with `cargo add rodio --dry-run`)), `app.rs`, `support.rs` (`snap_recordings() -> PathBuf` per Global Constraints), `scripts/bundle.sh`.

**Interfaces:**
- `pub trait Sink { fn load(&mut self, wav: Vec<u8>) -> Result<(), String>; fn play(&mut self); fn pause(&mut self); fn is_playing(&self) -> bool; fn position(&self) -> f64; fn seek(&mut self, s: f64); fn set_speed(&mut self, r: f64); fn duration(&self) -> f64; }` with `RodioSink` (one `OutputStream` opened lazily; failure → `Err`) and `#[cfg(test)] FakeSink` recording calls.
- `pub struct SnapSound<S: Sink> { sink: Option<S>, made: Option<(u64, u64)>, writing: Option<Receiver<Result<Vec<u8>, String>>>, pub failure: String, warned: bool }`; `follow(&mut self, state: &PlaybackState, rate: f64, session: &Session, vp: &mut Viewport, enabled: bool, animate_build_tab: bool, notices: &mut Vec<Notice>)` — the `TransportSound.follow` rules: off unless enabled, playing, plan Ready, `snap_mix().enabled`; a new `(session.version, state.version)` asks for a new track: the UI thread calls `vp.write_snap_track(temp, recordings)` (as Swift), reads the bytes, deletes the file and hands the bytes to the sink; `set_speed(rate)`; if not playing or `|position − seconds| > 0.08` → seek and play (never past the end). Paused, rest, document switch, Keyframes tab → `pause()`. An audio-device failure pushes one Warning notice per session and sets `failure`.
- **Snap Sound page** (copy from `SoundSettingsSheet.swift`): on/off ("Mix the sound of parts seating in Build videos."), Source (Part Physics / Recorded / Synthesised), Recordings (All / Freesound / OpenGameArt, Recorded only), Preset menu, Volume, Room, Stereo Width, Simultaneous Arrivals; collapsed sections Click (Level, Brightness, Pitch, Match Clicks to Part Size) and Body (Level, Pitch, Length, Match Pitch to Part Size), Variation; Play Sample with Plate / Brick / Pin (writes with `write_snap_preview` on `bm-sound`, plays through the same sink; "Preparing sample" while writing; "The sample could not be played." on failure). Every committed change → `set_snap_mix` once. "Include in Build Exports by Default" is an M6 export setting: shown disabled with "Export options come with Export Movie".
- [ ] **Step 1: Failing tests** (`tests/sound.rs`, FakeSink):
  - `sound_follows_transport` (Review Focus 3): play → `load` once and `play`; seek 3 s → one `seek(3.0)`; rate 2 → `set_speed(2.0)`; pause → `pause`; an edit + replan → a second `load`; Keyframes tab or `play_snap_sounds = false` → `pause`.
  - `no_audio_device_is_one_notice`: a sink whose `load` fails → one notice over 100 frames of playback, no panic.
  - `sample_plays_without_a_plan` (`write_snap_preview` path, FakeSink `load` called with a RIFF buffer).
  - `mix_slider_commits_once`.
  - `recordings_dir_resolves` (unit: env var wins; repo fallback exists in a checkout).
  - `write_snap_track_time` (`#[ignore]`, release, `BM_BIG_MODEL`): prints the time. Over 100 ms → write `Ruling: needs engine change (viewport-free snap track)` in `m4-rulings.md` and tell the owner; do not move it off-thread.
- [ ] **Step 2:** Run; FAIL. Implement. `cargo test --workspace` PASS; clippy 0. `scripts/bundle.sh` → `BrickMotion.app/Contents/Resources/SnapSounds` exists.
- [ ] **Step 3: Commit.** `feat(desktop): snap sound page, samples and live transport sound`.

### Task 13: Milestone checks

**Files:** Modify `desktop/crates/brickmotion/tests/ui.rs` (screenshots), `desktop/docs/m4-rulings.md`.

- [ ] **Step 1: Screenshots** (`BM_SCREENSHOTS=1 cargo test -p brickmotion --test ui screenshots`): `docs/m4-timeline.png` (helicopter planned, Animate, playhead mid-build, Parts lane open), `docs/m4-planning.png` (planning state), `docs/m4-build-settings.png`, `docs/m4-staging.png`, `docs/m4-sound.png`, `docs/m4-callout.png` (Build workspace, step 4 Exploded). Open each and compare with the Task 2 mockup; one line per picture in `m4-rulings.md`.
- [ ] **Step 2: Full checks:** `cd desktop && cargo test --workspace` (all pass), `cargo clippy --workspace --all-targets -- -D warnings` (0), bmffi tests (all pass), exports check (0), `ctest --test-dir native/build-app` (≥ 619, all pass), `ctest --test-dir native/build` (all pass), the four `#[ignore]` release checks (`playback_frame_time`, `big_model_timeline_frame`, `big_model_parts_lane`, `write_snap_track_time`) with `BM_BIG_MODEL=<absolute path to dist/data/omr/10294-1/10294-1.mpd>`. Record every number.
- [ ] **Step 3: By hand** with `HOME=<scratchpad>/home`: open the helicopter; switch to Animate; let it auto-plan; play with snap sound on and off; scrub; ⇧→ through steps; drag a hold and undo it in one ⌘Z; drag a part clip to an earlier step; drop a 2×4 from the Library onto the lane; change pieces per second and watch one replan; apply a staging layout; play a step from the callout in Build; save, reopen, check the edits are there. Record what was seen, including anything that did not work.
- [ ] **Step 4: Commit.** Stage `desktop/docs/m4-*.png desktop/docs/m4-rulings.md desktop/crates/brickmotion/tests/ui.rs`. Message: `docs(desktop): M4 checks and screenshots`.

---

## Not in M4 (and where it goes)

- Keyframes and Motion tabs, Camera lane, auto-direct, Motion popover, flight-as-keys, Check Motion, scene cameras — M5.
- Export Movie / Still, Render Queue, Look, record viewport, "Include snap sound in exports" — M6.
- Model Checks, Suggest, Generate, booklet, inventory import — M7.
- Pro timeline tools (ripple, roll, slip, slide, razor, J/K/L, markers, work area, in/out, mini-map, solo/mute/lock), the Preferences window, assembly spots — M8 or when the owner asks.
- Shared-texture viewport (spec "Viewport") — only if Task 5's `playback_frame_time` fails; then it becomes an M4 task before Task 6.
