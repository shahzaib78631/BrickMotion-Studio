# BrickMotion Desktop — Milestone 6 (Render & Export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rust app saves what the model looks like and gets it out of the app:
- The **Look** panel: scene, shading, detail switches, lights, path samples.
- **Export Movie**: Build, Keyframes and Turntable sources; four frame shapes, three sizes, quality, fps; camera; logo; snap audio; one model or the whole project; batch submodel videos.
- **Export Still**: a path-traced PNG with an optional logo.
- The **Render Queue**: one helper at a time, progress, cancel, history, Show in Finder.
- **Export LDraw**, **Export Plan**, and the submodel project and LDraw exports.
- **Copy Viewport Image** and **Record Viewport**.

It also lands the owner-approved controls restyle (fill-pill sliders everywhere, the new timeline look), so the new panels are built with the new controls.

**Architecture:**
- **Swift logic moves down first (Task 3), as in M4 Task 3 and M5 Task 2.** The new bmapp header `export_options.h` (+ `.cpp`) takes over:
  - `VideoExportSheet`: frame shapes, sizes, bit rate, the default camera, helper arguments, summaries;
  - `StillExportSheet`: sizes, samples, `lookArguments`, helper arguments, summaries;
  - `DocumentModel.submodelVideoTargets`;
  - `RenderQueue.enqueueMovies`: the file-stem rule.

  `EditorMovieCommand` (argument parsing, focus, `exportMovie`, the snap-audio path) becomes `bmapp::runEditorMovie`. `MovieAudioMux` becomes `bmapp::muxSnapAudio` in a new `movie_audio.mm`. `VideoLogo.Stamp.apply` becomes `bmapp::stampLogo`, in `movie_logo.mm` beside the movie logo it must match. The Swift app is rewired to call all of these.
- **bmffi** grows `export.cpp`:
  - the render look and scene presets;
  - plan, MPD and submodel bytes;
  - the option functions;
  - `stampLogo` and `runEditorMovie`.

  It also gets `recorder.mm`, an AVAssetWriter H.264 writer. The spec puts the viewport recorder in bmffi.
- **bm** wraps these in `export.rs` and `recorder.rs`.
- **brickmotion** gets:
  - `render_queue.rs`: helper processes, staging, the destination check, history;
  - `logo.rs`: the app-wide video logo;
  - `recording.rs`;
  - `chrome/look_panel.rs`, `chrome/export_movie.rs`, `chrome/export_still.rs`, `chrome/queue_panel.rs`;
  - a `--render-editor-movie` entry in `main.rs`. The app binary is its own movie helper, as Swift's is.
- **Helpers:** `bmexport` (stills) is built in `native/build-rust` and copied to `Contents/Helpers/bmexport` by `scripts/bundle.sh`. Movies run `Contents/MacOS/brickmotion --render-editor-movie`.

**Tech Stack:** As M5. No new crates: `arboard` (already a dependency) puts the image on the clipboard, `serde_json` keeps the queue history, and `rfd` gives the save panels.

**Spec:** `docs/superpowers/specs/2026-11-25-rust-egui-app-design.md`, milestone 6:
> "Render & export: look panel, stills, movies, Render Queue, LDraw/project/plan exports."

**Behaviour reference:** the parity ledger `docs/superpowers/specs/2026-11-19-native-app-parity.md`:
- §1: "Save project … plan … LDraw".
- §2: the row menu exports and batch submodel videos.
- §8: Render/video, Materials (the native Look subset), Export dialog, Capture.

The Swift files are `LookPanel.swift`, `VideoExportSheet.swift`, `StillExportSheet.swift`, `StillExport.swift`, `VideoLogo.swift`, `RenderQueue.swift`, `RenderExportProcess.swift`, `RenderQueueWindow.swift`, `EditorMovieCommand.swift`, `MovieAudioMux.swift`, `ViewportRecorder.swift`, `SubmodelFileExport.swift` and the File/Edit/View/Window rows of `Commands.swift`. Match their behaviour. Never copy their logic into Rust: Task 3 moves it into bmapp first.

**Base:** branch `feat/desktop-m1` after M5 and its review fixes (`a761c45e`). Rulings so far: `desktop/docs/m2-rulings.md` … `m5-rulings.md` and `m5-rulings-ledger.md`.

## Global Constraints

- **M1–M5 Global Constraints still hold:**
  - Calm UI: one stroke-icon family, one blue accent `#4f8cff`, orange only for the playhead, an 8-px grid, 12.5-pt text in two weights.
  - Bundle id `com.brickmotion.studio.rs`. Stage named files only. No commits on `main`. Never push.
  - Tests use `new_for_test` / `new_for_test_cc` and never touch the real support folder.
  - The session stays single-threaded.
- **Editors are floating panels (M5 ruling):** `float_panel::show` with a new `PanelKind`, the 236/344-px widths and widgets from `chrome/widgets.rs`. Bounded values use the fill-pill `slider_row_with` (Task 2); unbounded ones stay typed fields.
- **Screens are mocked up and approved before they are built (Task 1).** The approved design wins over this plan's text.
- **Engine edits are allowed only where logic moves down:**
  - `native/app/bmapp/include/bmapp/export_options.h` and `movie_export.h`;
  - `src/export_options.cpp`, `movie_logo.mm`, `movie_audio.mm`, `editor_movie.cpp`;
  - their tests and CMake lines.

  Rendering, path tracing, encoding and snap-sound algorithms do not change (spec non-goal). Transparent stills and COLLADA stay out (ledger: engine work still open).
- **The Swift app stays green and calls the moved logic:**
  - after Task 3, `ctest --test-dir native/build-app -j8` passes with at least 649 tests (`brickmotion_selftest_render_queue` included);
  - `ctest --test-dir native/build -j8` passes with at least 463;
  - `bmapp_tests` and `bmffi_tests` run in `native/build-rust`.
- **Exports never block the UI thread.** A movie or still runs as a helper process, one at a time, from project bytes captured when the job is queued. Edits made afterwards never change a queued job. LDraw and plan exports write bytes taken on the UI thread with an atomic write: temporary file, then rename.
- **Swift's copy is the display copy**, as in the earlier milestones. Messages quoted in this plan are exact.
- **Shortcuts match the Swift app:**
  - Export LDraw ⇧⌘E. This moves the M4 placeholder ⇧⌘E off `output.export_movie`, which has no shortcut in Swift.
  - Record Viewport ⌥⇧⌘R.

  No other new shortcuts. The commands test that checks shortcuts are unique must stay green.
- **Commands:**
  - `output.export_movie`, `output.export_still` and `output.render_queue` change from `When::Soon` to real conditions.
  - `model.look` goes live.
  - New commands:
    - `file.export_ldraw`, `file.export_plan` and `file.export_submodels`;
    - `edit.copy_viewport` ("Copy Viewport Image");
    - `view.record` ("Record Viewport" / "Stop Recording Viewport");
    - `view.look` ("Look…").
  - A new `Menu::Window` carries Render Queue.

## Scope by ledger row

| Ledger row | Milestone |
|---|---|
| §8 Materials: the native Look (34 scenes, six shadings, edges, shadows, AO, floor, glass, baked studio light, lights follow camera, path samples) | **M6** (Task 5) |
| §8 Render/video: frame shapes, sizes, quality, 24–60 fps, cameras, logo, snap audio | **M6** (Task 8) |
| §8 Export dialog with per-job progress; Render Queue history | **M6** (Tasks 7, 8, 9) |
| §8 Capture: path-traced still, clipboard image, record viewport | **M6** (Tasks 6, 9, 10) |
| §1 Export Plan, Export LDraw | **M6** (Task 6) |
| §2 Row menu exports (video, project, LDraw) and batch submodel videos | **M6** (Tasks 6, 8) |
| M4 deferrals: the Snap Sound "Include in exports" switch; Staging's Frame "from Output" | **M6** (Task 8) |
| §8 Materials still open in the renderer (finish, texture, glow, lens blur, edge colour, AO strength, floor kinds, gradients); transparent stills; COLLADA; scene lights, reference images, region, guides, exposure | **Not in M6.** These need renderer work in `native/render` first. |
| Arrival mode, hero orbit, timing presets for video | **Not in M6.** Still open in the engine (ledger). |

## Review Focus

1. **A destination that is in use or changes under a job.** Two jobs aimed at one file are refused with "An export is already using that destination. Choose another file name.", comparing paths case-insensitively. If a file at the destination changes while a job renders, the job fails with "A different version of the file is at the destination. Choose a new location and export again." and nothing is overwritten. Tests (Task 7): `queue_refuses_a_reserved_destination`, `queue_keeps_a_file_changed_meanwhile`.
2. **Quitting or crashing mid-render.** On the next launch the job reads "Interrupted". Only `.brickmotion-<UUID>` staging folders beside its destination are swept; anything else in that folder is never touched. Test (Task 7): `interrupted_job_sweeps_only_its_staging`.
3. **Cancel while rendering.** The helper is killed. No file appears at the destination, the staging folder goes and the next job starts. Test (Task 7): `cancel_kills_helper_and_leaves_no_file`.
4. **A failing or missing helper.** The job fails with the helper's last diagnostic line, or "The render helper is missing from the app bundle.", and the queue moves on. Test (Task 7): `failed_helper_shows_its_last_line`.
5. **Editing after queueing, and odd submodel names.** A job renders the bytes captured when it was queued. Batch names with `/`, `:`, control characters, a leading dot, or duplicates get Swift's safe stem and " 2", " 3" suffixes, and never replace an existing file. Tests: Task 3 `safe_file_stem_cases`; Task 8 `batch_names_never_replace_files`, `queued_job_ignores_later_edits`.

## File Structure

```
native/app/bmapp/include/bmapp/export_options.h   (new) frame shapes, sizes, bit rate, camera choice, argument builders, summaries, submodel targets, safe stems
native/app/bmapp/include/bmapp/movie_export.h      + stampLogo, muxSnapAudio, runEditorMovie
native/app/bmapp/src/export_options.cpp            (new)
native/app/bmapp/src/movie_logo.mm                 + stampLogo (same rect and 90 % opacity as the movie logo)
native/app/bmapp/src/movie_audio.mm                (new) AAC encode + passthrough mux (from MovieAudioMux.swift)
native/app/bmapp/src/editor_movie.cpp              (new) runEditorMovie (from EditorMovieCommand.swift)
native/app/bmapp/tests/export_options_test.cpp     (new)
native/app/BrickMotion/*.swift                     rewired: Video/StillExportSheet, EditorMovieCommand, VideoLogo, DocumentModel, RenderQueue
desktop/bmffi/src/export.cpp, recorder.mm          (new)   desktop/bmffi/include/bmffi.h  + export & recorder ABI
desktop/crates/bm/src/export.rs, recorder.rs       (new)
desktop/crates/brickmotion/src/render_queue.rs, logo.rs, recording.rs   (new)
desktop/crates/brickmotion/src/chrome/look_panel.rs, export_movie.rs, export_still.rs, queue_panel.rs   (new)
desktop/crates/brickmotion/src/{main.rs, app.rs, commands.rs, menubar.rs, chrome/mod.rs, chrome/float_panel.rs, chrome/tree.rs, chrome/sound.rs, chrome/staging.rs, chrome/widgets.rs, chrome/timeline.rs, chrome/parts_lane.rs, chrome/keys_track.rs}
desktop/crates/brickmotion/tests/look.rs, export.rs, render_queue.rs   (new)
desktop/scripts/bundle.sh                          + Contents/Helpers/bmexport
```

---

### Task 1: Mockups for the M6 screens (owner gate)

**Files:** `.superpowers/brainstorm/65433-1795584607/content/m6-render.html` (git-ignored); `desktop/docs/m6-rulings.md` (new).

Start from the approved M5 shell and the approved controls in `m6-controls.html`: the pill slider and the timeline. Leave the colour ring out; it is on hold, and only the owner reopens it.

- [ ] **Step 1: Write one HTML file with six screens:**
  1. the Look panel;
  2. Export Movie (settings, then queued/rendering/complete states);
  3. Export Still;
  4. the Render Queue (rows with progress, Cancel, Show in Finder, Clear Finished, the empty state);
  5. the Output ribbon tab and the File menu export rows;
  6. the recording chip on the viewport ("● 0:12 · Stop").
- [ ] **Step 2: Ask the owner four questions with the file** (one `AskUserQuestion` with previews):
  1. Are Export Movie and Export Still floating panels (recommended, per the M5 ruling) or centred sheets?
  2. Is the Render Queue a floating panel (recommended) or its own window, as in Swift?
  3. Does the Look panel open from the ribbon's Look button and View → Look… only (recommended), or also show as a viewbar popover?
  4. Does the recording chip sit in the selection chip's place (recommended) or at the top centre?
- [ ] **Step 3: Iterate until approved.** Record every ruling in `desktop/docs/m6-rulings.md`, then commit:

```bash
git add desktop/docs/m6-rulings.md
git commit -m "docs(desktop): M6 approved mockup rulings"
```

Tasks 2–4 need no answer and run while waiting. Tasks 5–10 start after approval.

### Task 2: Controls restyle (approved 2026-11-26)

**Files:**
- Modify: `chrome/widgets.rs` (`slider_row_with`, `PILL_H`).
- Modify: every `slider_row` call site: camera, motion, sound, staging and build settings panels, and the viewbar look settings.
- Modify: `chrome/timeline.rs`, `chrome/parts_lane.rs`, `chrome/keys_track.rs`, `desktop/docs/m5-rulings.md` (the uncommitted "Approved for the next UI pass" section).
- Test: `tests/camera.rs`, `tests/settings.rs`, `tests/sound.rs`, `tests/timeline.rs`.

The pill slider and its two tests are already written in the working tree. They are uncommitted, with a copy in the session scratchpad. `slider_is_one_pill_with_the_value_inside` failed on the old slider ("pill height 18") and passes on the new one. Keys-panel numbers stay typed fields.

- [ ] **Step 1: Run the whole suite with the pill slider.** Fix tests that click by rect fraction (`settings`, `sound` drag tests) so they aim along the full pill width. The value text no longer takes a column. The test intent does not change.
- [ ] **Step 2: Write failing timeline tests** in `tests/timeline.rs`:
  - `playhead_flag_shows_timecode`: a node labelled `"Playhead {timecode}"` sits above the ruler and carries the orange playhead colour.
  - `clip_hover_shows_name_chip`: hovering a Parts clip shows a tooltip-layer label equal to the clip's part name.
  - `parts_clips_are_rounded_brick_colour`: the painted clip's fill equals the piece colour's sRGB at 85 % alpha, with corner radius 5. Read it from a new pub field `timeline.last_clip_paint: Option<(Color32, f32)>` (fill, corner radius), recorded each frame the way M4's `last_camera_rect` is.
- [ ] **Step 3: Run them.** Expected: FAIL (no flag node, no chip, square clips).
- [ ] **Step 4: Implement the approved timeline look** from `m6-controls.html` section 3:
  - rounded clips in brick colours;
  - quiet camera and step clips (white 10 % fill, `text2` labels);
  - the orange playhead time flag;
  - the hover name chip;
  - Keys rows drawing diamond keys joined by a 1-px line inside a soft flight band (white 6 %).
- [ ] **Step 5: Full suite and clippy green.** Run `cd desktop && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`.
- [ ] **Step 6: Commit** `feat(desktop): fill-pill sliders and timeline restyle`. Stage only the files listed above.

### Task 3: Export logic moves into bmapp

**Files:**
- Create: `export_options.h`, `export_options.cpp`, `movie_audio.mm`, `editor_movie.cpp`, `tests/export_options_test.cpp`.
- Modify: `movie_export.h`, `movie_logo.mm`, `native/app/bmapp/CMakeLists.txt`, and the Swift files listed under File Structure.

**Interfaces (Produces):**

```cpp
namespace bmapp {
enum class FrameShape { Landscape, Vertical, Portrait, Square };          // 1920×1080, 1080×1920, 1080×1350, 1080×1080
enum class MovieResolution { Small, Standard, Large };                     // ×2/3, ×1, ×2 (integer maths as Swift)
enum class MovieQuality { Compact, Standard, High };                       // factor 0.6, 1, 1.6
enum class StillQuality { Draft = 32, Standard = 128, Final = 512 };
enum class MovieCamera { Director, Track, Viewport, Saved };
struct FrameSize { int width = 0, height = 0; };
FrameSize frameSize(FrameShape);                       const char* frameRatio(FrameShape);   // "16:9", "9:16", "4:5", "1:1"
FrameSize movieSize(FrameShape, MovieResolution);      FrameSize stillSize(FrameShape, bool large);
int movieBitRate(int width, int height, int fps, MovieQuality);  // min(240'000'000, max(800'000, w*h*fps/5) * factor)
struct ViewAngles { bool present = false; double yawDeg = 0, pitchDeg = 0, fovDeg = 0; bool orthographic = false; };
ViewAngles viewAngles(const Camera& viewportCamera);
struct MovieChoice {
  MovieSource source = MovieSource::Build; FrameShape shape = FrameShape::Landscape;
  MovieResolution resolution = MovieResolution::Standard; MovieQuality quality = MovieQuality::Standard;
  int fps = 30; int turntableSeconds = 8; MovieCamera camera = MovieCamera::Director; std::string sceneCameraId;
  bool snapAudio = false, standardPreview = false; ViewAngles angles; StringList modelPath;
  std::string logo; LogoCorner logoCorner = LogoCorner::BottomRight;
};
MovieCamera defaultMovieCamera(const Session&, bool batch, bool hasViewportAngle);  // VideoExportSheet.show rules
bool movieAllowsTrack(const Session&, const MovieChoice&, bool batch, bool focusedModelChosen);
StringList movieArguments(const MovieChoice&);         // VideoExportSheet.options(for:) + VideoLogo.options, same order
std::string movieSummary(const MovieChoice&);           // "Build · 1920 × 1080 · 30 fps" (+ " · Logo")
struct StillChoice { FrameShape shape; bool large = false; StillQuality quality = StillQuality::Standard; bool viewportAngle = true; ViewAngles angles; };
StringList stillArguments(const StillChoice&, const RenderLook&);   // options + lookArguments
std::string stillSummary(const StillChoice&, bool logo); // "Still · 1920 × 1080 · Standard" (+ " · Logo")
struct VideoTarget { std::string title; StringList path; };
std::vector<VideoTarget> submodelVideoTargets(const Session&);       // DocumentModel.submodelVideoTargets
std::string safeFileStem(const std::string& name);                   // RenderQueue.enqueueMovies stem rule; "" → "Submodel"
std::string stampLogo(const std::string& png, const std::string& logo, LogoCorner);   // "" on success
std::string muxSnapAudio(const std::string& video, const std::string& wave, const std::string& destination);
int runEditorMovie(const StringList& args);   // EditorMovieCommand.run; prints Swift's messages to stderr; 0 on success
}
```

- [ ] **Step 1: Write the failing Catch2 tests** in `export_options_test.cpp`, using the existing helicopter fixture:
  - `frame sizes match Swift`: all four shapes × three resolutions, for example Portrait Small = 720×900. Stills: Large = ×2.
  - `bit rate`: 1920×1080 at 30 fps Standard = 12 441 600. 320×180 at 24 fps Compact hits the floor: 800 000 × 0.6 = 480 000. 3840×2160 at 60 fps High = 159 252 480. 7680×4320 at 60 fps High is capped at 240 000 000.
  - `movie arguments order`: Build, Landscape, Standard, 30 fps, Track, snap audio, model path `["sub.ldr"]`, logo `/tmp/l.png`, corner `tl` gives exactly `--model sub.ldr --size 1920x1080 --fps 30 --source build --bitrate 12441600 --snap-audio --camera-track --logo /tmp/l.png --logo-corner tl`. Check the order against `VideoExportSheet.options` and `VideoLogo.options` before pinning it.
  - `turntable adds duration`; `standard preview drops snap audio`; `saved camera passes its id`.
  - `default camera`: "buildView" without an angle gives Director; "buildView" with an angle gives Viewport; "track" with Build keys and no batch gives Track; "track" as a batch gives Director.
  - `still arguments`: `--size 1920x1080 --samples 128 --no-denoise --azimuth … --lights-fixed --background r,g,b`, where r,g,b is the chosen scene's background rounded to bytes. With no scene there is no `--background`.
  - `summaries`.
  - `safe_file_stem_cases`: `"a/b:c"` → `"a b c"`; `"..x.."` → `"x"`; `""` → `"Submodel"`; 70 characters cut to 60; trimming as in Swift.
  - `submodel targets`: helicopter definitions, unique, in row order, no empty definitions.
  - `stamp logo`: a 1080×1080 white PNG plus a red 100×50 logo, top-right, gives red pixels inside `logoRect` and white outside; alpha 0.9 gives a blended pixel.
- [ ] **Step 2: Run** `cd native/build-rust && ninja bmapp_tests && ./app/bmapp/bmapp_tests "[export]"`. Expected: build FAILS (header missing).
- [ ] **Step 3: Implement** by porting the Swift bodies line for line:
  - `stampLogo` reuses `logoRect`;
  - `muxSnapAudio` ports `MovieAudioMux` (AAC 48 kHz encode, passthrough export);
  - `runEditorMovie` ports `EditorMovieCommand.run`, including "Snap audio requires a native Build video." and the `Tracks-<uuid>` temporary folder. It takes the snap recordings folder from a new `--recordings <dir>` argument, which both shells pass (bmapp has no default of its own).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Rewire Swift.** The sheets, `EditorMovieCommand`, `VideoLogo.Stamp.apply`, `DocumentModel.submodelVideoTargets` and the `RenderQueue` stem call the bmapp functions; delete the Swift bodies. `MovieAudioMux.swift` and the Swift parse code go.
- [ ] **Step 6: Run both Swift suites** (`ctest --test-dir native/build-app -j8`, at least 649 tests; `native/build`, at least 463) and `bmapp_tests` (everything). Expected: all pass.
- [ ] **Step 7: Commit** `refactor(bmapp): export options, logo stamp, audio mux and editor movie move down from Swift`.

### Task 4: Export and recorder ABI

**Files:** `desktop/bmffi/include/bmffi.h`, `desktop/bmffi/src/export.cpp`, `desktop/bmffi/src/recorder.mm`, `desktop/bmffi/CMakeLists.txt`, `desktop/bmffi/tests/export_test.cpp`, `desktop/crates/bm-sys/src/lib.rs`, `desktop/crates/bm/src/export.rs`, `desktop/crates/bm/src/recorder.rs`, `desktop/crates/bm/src/lib.rs`.

**Interfaces (Produces, Rust):**
- `bm::export`:
  - `RenderLook { scene: String, shading: Shading, edges, shadows, ambient_occlusion, floor, raytraced_glass, world_gi_occlusion, lights_follow_camera: bool, path_samples: i32 }`;
  - `ScenePreset { id, label, hint, collection: SceneCollection, background: Vec3, floor: bool }` and `scenes() -> Vec<ScenePreset>`;
  - `Session::render_look()` and `Session::set_render_look(&RenderLook) -> Changed`;
  - `Session::plan_bytes() -> String`, `mpd_bytes()`, `submodel_mpd_bytes(&str)` and `submodel_project_bytes(&str)`;
  - the Task 3 enums and `MovieChoice` / `StillChoice` as plain Rust types;
  - `movie_arguments`, `movie_summary`, `still_arguments`, `still_summary`, `default_movie_camera(&Session, batch, has_angle)`, `movie_allows_track`, `submodel_video_targets(&Session) -> Vec<VideoTarget>` and `safe_file_stem`;
  - `stamp_logo(png, logo, corner) -> Result<(), String>`;
  - `run_editor_movie(args: &[String]) -> i32`.
- `bm::recorder::Recorder`:
  - `start(path, width, height) -> Result<Recorder, String>`;
  - `append(&mut self, rgba: &[u8], w, h, seconds: f64) -> bool`;
  - `finish(self) -> Result<(), String>`.

  It is H.264 with even dimensions, as `ViewportRecorder.even`. It is `Send`, not `Sync`.
- `bm::recorder::frame_count(path) -> Option<u32>`: the video track's frame count, read with AVFoundation. Tests use it to check movies.
- Strings travel as `BmString` and lists as owned list handles, following M2–M5 conventions (guards, `bm_struct_size`, two-call arrays).

- [ ] **Step 1: Failing bmffi Catch2 tests:**
  - look round-trip with one undo step;
  - `scenes` has 34 entries;
  - plan bytes parse as JSON;
  - MPD bytes start with `0 FILE`;
  - argument lists equal the bmapp ones;
  - recorder writes a 4-frame 64×48 file that AVFoundation reports as 4 frames.
- [ ] **Step 2: Failing Rust tests:**
  - `crates/bm/tests/export.rs` mirrors the above through the wrappers;
  - the header declaration test lists the new names.
- [ ] **Step 3: Run** `ninja bmffi_tests && ./bmffi/bmffi_tests` and `cargo test -p bm`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** them again, then `nm` the dylib. The check gives 0: no unexported C++ symbols leak.
- [ ] **Step 6: Commit** `feat(bmffi): look, export options and viewport recorder ABI`.

### Task 5: The Look panel

**Files:** `chrome/look_panel.rs` (new), `chrome/float_panel.rs` (`PanelKind::Look`, title "Look"), `chrome/mod.rs`, `app.rs`, `commands.rs`, `menubar.rs`, `tests/look.rs` (new).

The panel's header subtitle is "Saved with the project and used by every video.". Its sections:
- **Scene:** the 34 scenes grouped by `SceneCollection`, shown as swatch tiles named by `label`, with `hint` as the tooltip, plus "Follow appearance" (`scene == ""`).
- **Shading:** six rows with Swift's titles and descriptions. "Baked studio visibility" shows under Studio.
- **Detail:** "Edge lines", "Shadows", "Ambient occlusion", "Floor", "Ray-traced glass" ("Drawn when the view is still"), "Lights follow the camera".
- **Path samples:** a pill slider from 8 to 1024, shown only for Path Traced.

Every change is one `set_render_look` call and one named undo step. A slider commits on release.

- [ ] **Step 1: Failing tests:**
  - `look_toggle_is_one_undo_step`: clicking "Edge lines" adds one undo step and flips `render_look().edges`.
  - `look_scene_tile_sets_scene`.
  - `path_samples_commit_on_release`: a drag over 10 frames makes one call.
  - `look_command_opens_panel`: `model.look` and `view.look` both open "Look panel".
- [ ] **Step 2: Run** `cargo test -p brickmotion --test look`. Expected: FAIL.
- [ ] **Step 3: Implement**, with the approved mockup as the reference.
- [ ] **Step 4: Run** the tests, then the full suite and clippy. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Look panel`.

### Task 6: File exports, row menu exports and Copy Viewport Image

**Files:** `app.rs`, `commands.rs`, `menubar.rs`, `chrome/tree.rs`, `tests/export.rs` (new).

**Interfaces:** `app.export_bytes(kind: FileExport, model: Option<&str>)`, where `FileExport` is `Plan | Ldraw | SubmodelProject | SubmodelLdraw`.
- It asks for the destination with `rfd::FileDialog` (`dialogs_off` in tests routes it to `app.test_save_path`).
- It writes atomically: a sibling temporary file, then rename.
- The save panel titles and prompts are Swift's: "Save Submodel Project" / "Save", and "Export Submodel as LDraw" / "Export".
- The default names are the display name plus `.json`, `.mpd` or `.brickmotion`.
- If the generation changed while the panel was open, the error is "The submodel changed before the export finished."

`edit.copy_viewport` puts the viewport's `capture()` on the clipboard through `arboard::ImageData`. When the capture is empty it shows a warning notice instead of Swift's beep.

- [ ] **Step 1: Failing tests:**
  - `export_ldraw_writes_mpd`: the file starts with `0 FILE` and equals `mpd_bytes()`.
  - `export_plan_writes_json`.
  - `row_menu_exports_submodel_project`: the tree row's right-click menu has "Export Video…", "Export Project…" and "Export LDraw…"; the project file opens in a fresh session with the submodel's piece count.
  - `export_refused_after_document_changed`.
  - `copy_viewport_puts_png_on_clipboard`: it uses a test clipboard sink, `app.clipboard_image`, when the system clipboard is not available.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run the full suite and clippy, including the commands test with the new ⇧⌘E owner.
- [ ] **Step 5: Commit** `feat(desktop): LDraw, plan and submodel exports, copy viewport image`.

### Task 7: The Render Queue

**Files:** `render_queue.rs` (new), `chrome/queue_panel.rs` (new), `chrome/float_panel.rs` (`PanelKind::Queue`), `main.rs`, `app.rs`, `commands.rs`, `menubar.rs` (`Menu::Window`), `support.rs`, `scripts/bundle.sh`, `tests/render_queue.rs` (new).

**Interfaces (Produces):**

```rust
pub enum Operation { Still, Movie }
pub struct Helpers { pub still: PathBuf, pub movie: PathBuf }   // bundle: Helpers/bmexport, MacOS/brickmotion; dev: native/build-rust/render/bmexport, current_exe
pub enum JobStatus { Queued, Rendering { done: u32, total: u32 }, Cancelling, Complete, Cancelled, Interrupted, Failed(String) }
pub struct Job { pub id: String /* random 32-hex, no new crate */, pub destination: PathBuf, pub summary: String, pub status: JobStatus }
pub struct RenderQueue { /* jobs newest first, pending, one active worker thread */ }
impl RenderQueue {
    pub fn load(history: PathBuf, helpers: Helpers) -> Self;            // marks unfinished Interrupted, sweeps their staging
    pub fn enqueue(&mut self, project: Vec<u8>, op: Operation, options: Vec<String>, library: &Path,
                   destination: PathBuf, summary: String, finish: Option<Finish>) -> Result<String, String>;
    pub fn enqueue_movies(&mut self, movies: Vec<BatchMovie>, project: Vec<u8>, library: &Path, folder: &Path);
    pub fn cancel(&mut self, id: &str); pub fn clear_finished(&mut self); pub fn stop_for_quit(&mut self);
    pub fn poll(&mut self) -> bool;                                       // once a frame; true while work remains (repaint)
    pub fn jobs(&self) -> &[Job];
}
pub type Finish = Box<dyn FnOnce(&Path) -> Result<(), String> + Send>;  // e.g. stamp_logo before the move
```

Port `RenderExportProcess` and `RenderQueue` behaviour exactly:
- The project is written to `$TMPDIR/BrickMotion-<uuid>/Model.brickmotion`.
- Staging is `<dest dir>/.brickmotion-<uuid>/Render.<ext>`.
- The arguments are `[still | --render-editor-movie] <input> --out <staging file> …options`, with `BM_LDRAW_DIR` in the environment.
- stdout and stderr are read line by line. `frame d t` lines are progress; the last 4 other lines (each cut to 1200 characters) are kept as diagnostics.
- The destination version (device, inode, modified time, length) is read when the job is queued and checked again before the move.
- `rename` is used when the destination is missing; otherwise the file is replaced.
- The history keeps the active jobs plus 40 recent finished ones in `<support>/render-queue.json`.
- Destination keys are compared lowercased, after canonicalising the path.

`main.rs`: `brickmotion --render-editor-movie …` calls `bm::export::run_editor_movie` and exits before eframe starts. `bundle.sh` builds `bmexport` (`cmake --build native/build-rust --target bmexport`) and copies it to `Contents/Helpers/`.

The queue panel (`PanelKind::Queue`, "Render Queue") shows:
- rows with the file name, summary and status ("Waiting", "Frame d of t", "Cancelling…", "Complete", "Cancelled", "Interrupted", or the failure text);
- Cancel ("Cancel {file name}") and "Show in Finder" (`open -R`);
- "Clear Finished";
- the empty state "Build, Keyframes, and Turntable exports appear here.".

- [ ] **Step 1: Failing tests** in `tests/render_queue.rs`. A test helper script is written to a temporary folder: a `sh` file that prints `frame 1 2`, `frame 2 2`, writes `--out`, and exits 0, or behaves as each test needs. Each test uses a temporary support folder.
  - `queue_runs_one_job_and_moves_the_file`;
  - `queue_runs_jobs_one_at_a_time`;
  - `queue_refuses_a_reserved_destination`: exact message;
  - `queue_keeps_a_file_changed_meanwhile`: the helper touches the destination before exiting, so the job fails with Swift's message and the destination keeps the touched bytes;
  - `cancel_kills_helper_and_leaves_no_file`: the helper sleeps 30 s;
  - `failed_helper_shows_its_last_line`, and the missing-helper message;
  - `interrupted_job_sweeps_only_its_staging`: the folder holds `.brickmotion-<uuid>`, `.brickmotion-notauuid` and `keep.txt`, and only the first goes;
  - `history_keeps_40_finished`;
  - `finish_runs_before_the_move`.
- [ ] **Step 2: Run** `cargo test -p brickmotion --test render_queue`. Expected: FAIL.
- [ ] **Step 3: Implement** `render_queue.rs`, the `main.rs` entry, the queue panel and `output.render_queue`, which opens the panel and is in `Menu::Window`.
- [ ] **Step 4: Run** the tests, then the full suite and clippy. Expected: PASS.
- [ ] **Step 5: Real helper smoke test**, gated by `BM_SLOW=1`: `movie_helper_renders_two_seconds`. It runs the built `brickmotion --render-editor-movie` on the helicopter at 320×180, 12 fps, Turntable, 2 s, and expects an MP4 for which `bm::recorder::frame_count` reports 24 frames.
- [ ] **Step 6: Commit** `feat(desktop): Render Queue and movie helper entry`.

### Task 8: Export Movie

**Files:** `chrome/export_movie.rs` (new), `chrome/float_panel.rs` (`PanelKind::Movie`), `logo.rs` (new), `support.rs` (logo prefs: `video_logo_file`, `video_logo_enabled`, `video_logo_corner`), `chrome/sound.rs`, `chrome/staging.rs`, `commands.rs`, `tests/export.rs`.

The panel (`PanelKind::Movie`, "Export Video") holds these rows, using Swift's copy and order:
- **Source:** Build | Keyframes | Turntable. Keyframes is the default when the Keyframes clock is showing and the export is not a batch.
- **Frame shape:** four tiles with the ratios.
- **Resolution:** "W × H" for each size.
- **Quality:** Compact, Standard, High.
- **Frame Rate:** 24, 25, 30, 50, 60 fps.
- **Camera:** Automatic Camera, Camera Track (disabled unless `movie_allows_track`), Viewport Angle (disabled without an angle), then the saved cameras.
- **Logo:** a preview, Off or a corner, Choose…, Remove Logo.
- **Duration** (Turntable only): 4, 6, 8, 12 or 16 seconds.
- **Model:** Entire Project or the focused model. This row is shown only when focused and not a batch.
- **Include Snap Sounds:** Build source only.

The footer reads "W × H · MP4 (H.264)" and has an Export… button. Changing the camera calls `set_export_camera` ("track", "buildView" or "automatic") as `rememberCamera` does. After the job is queued, the panel shows its states: "Waiting to Render", "Frame d of t" with a progress bar and Cancel, Complete with Show in Finder, and Failed. `file.export_submodels` and the row menu's "Export Video…" open it as a batch: the destination is a folder, and the jobs go through `enqueue_movies`.

M4 deferrals:
- The Snap Sound "Include in exports" switch becomes live. It sets the default for Include Snap Sounds, saved as the snap mix's `enabled` (Swift's source).
- Staging's Frame row gains "From Output", which uses the last chosen movie frame shape.

`logo.rs` copies a chosen image into `<support>/Logos/Logo-<uuid>`, then deletes the previous copy. Queued jobs keep the file they were given.

- [ ] **Step 1: Failing tests:**
  - `export_movie_queues_build_job`: the job's arguments equal `movie_arguments` for the panel's choice, and its summary equals `movie_summary`. The test helper stands in for the movie helper.
  - `camera_choice_is_remembered`.
  - `track_disabled_for_batch`.
  - `batch_names_never_replace_files`: two submodels named `"Wing/L"` and `"Wing:L"`, plus an existing `Wing L.mp4`, give `Wing L 2.mp4` and `Wing L 3.mp4`.
  - `queued_job_ignores_later_edits`: the project bytes handed to the queue are captured before an edit made right after queueing.
  - `include_in_exports_switch_sets_default`.
  - `logo_copy_survives_source_delete`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then the full suite and clippy. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Export Movie, batch submodel videos and the video logo`.

### Task 9: Export Still

**Files:** `chrome/export_still.rs` (new), `chrome/float_panel.rs` (`PanelKind::Still`), `commands.rs`, `tests/export.rs`.

The panel (`PanelKind::Still`, "Export Still") holds:
- Frame shape tiles;
- Size: Standard or Large;
- Quality: "Draft · 32 samples", "Standard · 128 samples" or "Final · 512 samples";
- Camera: Viewport Angle or Automatic Framing;
- "Show the Video Logo" (only when a logo is set).

The footer reads "W × H · PNG" and the note "Path traced in the background. The Render Queue shows its progress.". The default file name is "{title} – {Landscape|Vertical|…}.png". With the logo on, the job's `finish` runs `stamp_logo`. Queueing opens the Render Queue panel.

- [ ] **Step 1: Failing tests:**
  - `export_still_queues_bmexport`: the operation is Still and the arguments equal `still_arguments(choice, render_look())`.
  - `still_logo_stamps_before_move`: the test helper writes a white PNG; the moved file has logo pixels.
  - `automatic_framing_drops_angles`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then the full suite and clippy. Expected: PASS. The slow smoke test (`BM_SLOW=1`) runs the real `bmexport` at 192×108 with Draft quality and checks a PNG of that size.
- [ ] **Step 5: Commit** `feat(desktop): Export Still`.

### Task 10: Record Viewport

**Files:** `recording.rs` (new), `app.rs`, `chrome/viewbar.rs` (the recording chip), `commands.rs`, `tests/export.rs`.

`view.record` starts recording; its title becomes "Stop Recording Viewport" while running, and ⌥⇧⌘R toggles it.
- The recording writes the viewport's readback at 30 frames a second of wall-clock time, never faster than frames are drawn, to `$TMPDIR/BrickMotion-Recording-<uuid>.mp4` at the view's even pixel size.
- If the size changes, the recording stops, as Swift's does.
- Stopping asks where to save, with the default name "{title} Recording.mp4", and moves the file there.
- If the encoder failed, the message is "The movie encoder stopped. Try a smaller window."
- The chip reads "● m:ss" with a Stop button, labelled "Stop recording".

- [ ] **Step 1: Failing tests:**
  - `record_viewport_writes_frames`: start, step 20 frames with `input.time` advanced 1/30 s each, stop; the saved file has 18 to 21 frames.
  - `record_title_toggles`.
  - `record_stops_on_resize`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then the full suite and clippy. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Record Viewport`.

### Task 11: Milestone checks

**Files:** `desktop/docs/m6-rulings.md`, `desktop/docs/m6-*.png`.

- [ ] **Step 1: Run every suite:**
  - `cargo test --workspace`;
  - `cargo clippy --workspace --all-targets -- -D warnings`;
  - `BM_SLOW=1 cargo test -p brickmotion --test render_queue --test export`;
  - `bmffi_tests` and `bmapp_tests` in `native/build-rust`;
  - `ctest` in `native/build-app` (at least 649) and `native/build` (at least 463);
  - the `nm` check (0).
- [ ] **Step 2: Run `scripts/bundle.sh`** and check that the bundle holds `Contents/Helpers/bmexport` and that `Contents/MacOS/brickmotion --render-editor-movie` renders the 2-second turntable from inside the bundle.
- [ ] **Step 3: Take screenshots** through kittest: `m6-look.png`, `m6-export-movie.png`, `m6-export-still.png`, `m6-queue.png`, `m6-recording.png`. Send them to the owner.
- [ ] **Step 4: Record the by-hand checks for the owner:** a full-length 1080p Build movie with snap audio, a Final still, Record Viewport while orbiting, and Show in Finder.
- [ ] **Step 5: Commit** `docs(desktop): M6 checks and screenshots`.

## Not in M6 (and where it goes)

- **Renderer looks still open in `native/render`** (finish, texture, glow, lens blur, edge colour, AO strength, floor kinds, gradient backdrops), **transparent stills, COLLADA, scene lights, reference images, render region, guides, exposure:** when the engine has them.
- **Video arrival mode, hero orbit, timing presets:** engine work first (ledger §8).
- **The colour ring:** on hold until the owner reopens it.
- **Suggest, techniques, Generate, booklet, inventory import, Model Checks:** M7.
- **M5 deferred minors** (`m5-rulings-ledger.md`): the M8 parity sweep, unless the owner pulls one forward.
