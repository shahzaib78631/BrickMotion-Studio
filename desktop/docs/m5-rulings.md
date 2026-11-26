# Milestone 5 rulings

## Approved mockup (owner, 2026-11-26)

The owner approved `.superpowers/brainstorm/65433-1795584607/content/m5-animate.html` (v7) after seven rounds.
Where this file and the plan differ, this file wins: it records the approved screens.

### Timeline on the Keyframes clock (Tasks 6, 7, 9)
- **Clock switch:** a two-part segmented control, **Build | Keyframes**, in the timeline header, just left of the time readout and transport (not tabs).
- **Build track:** hidden on the Keyframes clock. Camera and Keys remain; the Camera track shows the Keyframes clock's keys.
- **Camera track:** gold diamonds for keys; the move between two keys is a soft gold clip with its name ("Glide", "Orbit · 3.0 s", "Push In").
- **Keys track:** opens to one row per keyed object, with a thin span from first to last key and a dot per keyed frame (the dot grows when more than three channels are keyed there). The selected object opens its channel lanes (dope sheet).
- **Key shape shows interpolation:** rotated square = Smooth, square = Linear, small upright square = Constant. The selected key has an accent ring.
- Frames outside the key scene are shaded.
- **Auto Key:** a red record toggle at the right of the header. **Curves:** shown disabled, with the tooltip "The curve editor comes in a later milestone".
- **Auto-Direct disabled tooltip** (Camera track menu, Keyframes clock, key scene not following the build): "Auto-Direct follows the build. Switch to the Build clock, or turn on Follow build in the key scene." Before a build plan exists: "Auto-Direct needs a build plan. Plan the build first."

### Editors are floating panels (Tasks 7–12)
- Camera Key, Camera (scene cameras, export camera, camera track), Keys, Build Motion and Joint open as **floating panels** over the viewport, SolidCraft style, not as fixed Properties pages and not as popovers.
- Panel header: grip (drag to move), icon, title, a grey subtitle (for example "2.42 s", "frame 58"), ⌄ folds the panel to its header, × closes it.
- Default place: top right of the viewport, just below the ribbon, 320 px wide, scrolling inside when taller than the view.
- Contents use the M4 inset-form widgets. Changes save live (one undo step per release); footers carry only actions like Remove Key or Reset All.
- Ruling (owner did not answer): each panel remembers its position and folded state for the session. Cost if wrong: a reset on open, a small change.

### Top bar: floating cards over the viewport (shell, both workspaces)
- The ribbon no longer sits attached under the title bar. The viewport runs up under it, and two cards float over it, 8 px from the window edges:
  1. **Workspace card**: the workspace icon, name and "Workspace ⌄", with a 3-px accent line along its top edge.
  2. **Ribbon card**: top row = workspace tabs on the left, **Search commands (⌘K)** on the right, with a hairline under the row. Second row = tool groups on the left (group labels with a small ⌄, thin dividers between groups) and the **Build | Animate** switch on the right, vertically centred. No divider between the tools and the switch.
- Cards: fill `bg2` at 97 %, 1-px `border2` edge, radius 10, soft drop shadow.
- Active tab: a solid blue pill (#2b4c80) with light-blue text (#d6e4ff). Active tool: accent tint with a 1-px accent outline.
- Icons stay one colour (calm UI rule), not SolidCraft's coloured icons.
- The timeline is a matching floating card (radius 10, 8-px margins).
- This shell change applies to the Build workspace too, so the two workspaces match.

### Camera panel (Tasks 7, 8)
- Key group: Time, Lens slider, Aim (Free | Point | Selection), Target, then "Set Key from View" and "Go to Key" links.
- "Move to next key" shows the move styles as tiles with a line drawing each (Cut, Glide, Orbit, Push In, Pull Out, Crane, …), then the move's fields and Easing.
- Scene cameras: a list with the active one marked "Active", "Look Through" on the others, and "Save View as Camera" (named "Camera N"). Export camera: "Video records" Viewport | Camera Track | Scene Camera, then the camera picker.

### Keys panel (Tasks 9, 10)
- Groups in order: Key at frame N (channel values, "not keyed · Add" for missing channels, Interpolation), Key scene (Frames, Frame rate, Length, Follow build), Flights (Bake Flights to Keys with "replaces N keys", Use in Build, Return to Planner), Check Motion (collisions and near contacts, Check Motion Again).

### Build Motion panel (Task 11)
- Title "Build Motion". "Edit for": Project | This Step | Selected Parts, with a note on how many values this scope sets.
- Values not set in this scope read "Inherit · value" in grey, with a grey slider fill.
- A flight timing bar under the sliders: Approach and Landing with their seconds.
- Presets as three tiles (Balanced, Precise Seating, Fast Assembly); Reset All in the footer.

### Joints (Task 12)
- Picking a part with a joint draws the axis (dashed accent line), the pivot (accent dot) and a turn ring in the viewport, and a small card beside it: joint type ("Turn and Slide"), a short description, −15° / angle / +15°, then Select Rigid Body and Detach.
- The Joint panel (type, angle, mates, clearance, "All joints in step", "Check geometry") floats at the top right.

### Flight path (Task 10)
- A 2-px accent line, 8-px dots at keys, an 11-px playhead dot in the playhead colour, and a hint: "Drag a point to reshape · double-click the line to add one · ⌫ deletes".

## Milestone checks (Task 13, 2026-11-26)

### Verification summary
- Rust `cargo test --workspace`: all pass (36 test groups, 0 failures). `cargo clippy --workspace --all-targets -- -D warnings`: 0 warnings.
- C++ `bmffi_tests`: 82 test cases, 1,678 assertions, all pass. `bmapp_tests`: 176 test cases, 48,317 assertions, all pass.
- `nm -gU native/build-rust/bmffi/libbmffi.dylib | grep -vc ' _bm_'` = **0**.
- Swift/app `ctest --test-dir native/build-app`: **649 tests, 0 failed** (floor 634). Core `ctest --test-dir native/build`: **463 tests, 0 failed** (floor 462).

### Release benchmarks (`10294-1.mpd`, 9,720 flights)
- `big_model_timeline_frame`: slowest timeline frame **452.4 µs** (budget < 16 ms: pass; M4 452.75 µs).
- `big_model_parts_lane`: Fit layout **159.5 µs** / show **80.4 µs**; 64× layout **76.3 µs** / show **8.75 µs** / 157 clips visited (budgets < 50 ms / < 16 ms: pass).
- `big_model_keys_track`: worst Keys frame **513.5 µs** (budget < 16 ms: pass).

### Fix found by the screenshots
- `switch_row` centred itself in all the height left in its panel, so the last switch in a floating panel (Camera › Follow Camera) floated mid-panel and pushed "Clear Camera Track" out of view. It is now one 36-px row (`tests/camera.rs::camera_panel_switch_row_stays_compact`).

### Screenshots (`desktop/docs/m5-*.png`, `BM_M5_SCREENSHOTS=1 cargo test -p brickmotion --test ui m5_screenshots`)
- `m5-flight-path.png`: piece 32's flight baked to keys on the Keyframes clock: the path in accent with its dots and hint, the Keys panel, the dope sheet.
- `m5-keyframes.png`: the same with Group on.
- `m5-camera.png`: Camera Key panel over the camera lane.
- `m5-camera-page.png`: the Camera panel (scene cameras, export camera, camera track).
- `m5-motion.png`: Build Motion for one part, the values inherited in grey.
- `m5-joint.png`: Joint Markers on, a Turn and Slide joint open with its card and the Joint panel.

### By hand, windowed (left to the owner)
- Auto Key with a real trackpad.
- Dragging a path point.
- Follow Camera playback.
- The joint card over a moving view (orbit while a joint is open).

## Approved for the next UI pass (owner, 2026-11-26)
Mockup: `.superpowers/brainstorm/65433-1795584607/content/m6-controls.html`.
- **Approved:** fill-pill sliders in every floating panel (label inside left, value right, thin white value bar, accent fill while dragging, grey when inherited, double-click to type, one undo step per release).
- **Approved:** timeline restyle: rounded clips in the brick colour, quiet camera and step clips, an orange time flag on the playhead, a name chip on hover, and expanded keyed parts showing diamond keys joined by a line in a soft flight band.
- **On hold:** the radial colour ring. v1 and v2 both missed the owner's reference; leave it until the owner brings it back.
- **Sliders everywhere they fit:** use the fill-pill slider for every bounded value in the app (floating panels, Build Settings, Snap Sound, Staging, viewbar look settings…). Unbounded numbers (a key's Position X/Y/Z, Rotation, Scale in the Keys panel) stay typed fields, since a slider needs a range.
