# Milestone 4 rulings

## Approved mockup (owner, 2026-11-25)

The owner approved `.superpowers/brainstorm/65433-1795584607/content/m4-build-play-v4.html` after three rounds (v1 → v4).
Where this file and the plan differ, this file wins: it records the approved screens.

### Plan status (Task 5)
- Title bar, right, before settings and help: "Checking Flight Paths…" (the stage word) with a 72-px, 2-px accent progress line while planning; "Planned · N pieces" when ready.
- A failed plan is one row in the timeline: the reason, then **Try Standard Preview** and **Try Again** (accent).

### Properties pages, not sheets (Tasks 10–12)
- Build Settings, Build Staging and Snap Sound open as pages in the Properties panel (‹ returns to the inspector).
- The panel is 344 px wide for these pages.

### Step callout (Task 9)
- Bottom left of the Build viewport, above the selection chip, as drawn on screen 4.

### Snaps track (Task 6)
- Seat ticks only: one thin tick at each part's seat time.

## Shared widgets (Task 10, replaces the plan's widget look)
Behaviour stays as planned: `SliderEvent` commits once on release, Return or focus loss, and Esc reverts.

The look follows the macOS inset form:
- **Section header:** 11 pt semibold in `text3`, above its group.
- **Group:** radius 9, fill white 4.5 %, a 0.5-px white 6 % edge, rows split by 0.5-px white 7 % hairlines inset 12 px.
- **Row:** min height 36, label `text1` 12.5 pt on the left, value `text2` on the right.
- **Slider row:** label left, value right, then a full-width slider under them. The track is 4 px (white 12 %) with an accent fill and a 15-px white knob with a soft shadow. Double-clicking the value makes it editable.
- **Segmented control:** height 24, track white 7 %, the chosen segment white 17 % with a small shadow.
- **Pop-up row:** value plus a ⌃⌄ glyph. **Switch row:** 28×16 accent switch.
- **Footnote:** 11 pt `text3` under a group.

## Build Settings page (Task 11): v2 page with the v3 Pace group
1. **Summary card** (top):
   - "0:52" (the plan's build length, 22 pt semibold), then "build · N steps · N parts".
   - A rhythm bar of one step: three flights, gaps and the hold, proportional to the current settings and redrawn live while dragging.
   - The note "Changes below re-time the build at once — no replanning."
   - Ruling: keep "no replanning" only if Task 11 shows a pacing change does not re-check flights. If it does, the note reads "Changes below re-time the build." Cost if wrong: one misleading sentence.
2. **Pace** (v3 inset group):
   - Segmented control: Relaxed / Standard / Quick / Custom.
   - Sliders: Each flight, Gap between parts, Hold at each step.
   - Footnote: "Re-times the build straight away. Motion's flight time scales each flight."
   - Ruling, the preset values:
     - Standard = bmapp defaults.
     - Relaxed = flight time ×1.5, gap 0.10 s, hold 0.50 s.
     - Quick = flight time ×0.6, gap 0.02 s, hold 0.15 s.
     - Custom is shown whenever the values match none of them. Picking a preset is one `set_build_settings`.
     - Cost if wrong: the owner tunes three numbers.
   - When `video_seconds > 0` the group is disabled with the Swift note.
3. **How it's planned** (tagged "Replans"):
   - Order as two cards with small drawings: Take Apart, "Planned by taking it apart"; Bottom Up, "Built forward from the base".
   - Flight path segmented Automatic / Web / Arc, with its one-line help.
4. **Advanced** (folded; subtitle "Planner, clearance, grown units"): Planner Native / Standard, Clearance, Corner rounding (Arc only), Split grown units.
5. **Footer:** "Saved with the project" and Restore Defaults.

## Build Staging page (Task 11): v3 without the preview
- **Layout** group:
  - The header shows the chosen layout's name on the right.
  - A 3×3 grid of tiles (aspect 1.6) drawn from the Swift layout rectangles as filled white 14 % blocks.
  - The chosen tile gets an accent tint and a 2-px accent ring. The tile tooltip is the layout name.
- **Waiting Parts** group:
  - Pop-ups for Group, Position (the Swift "Placement" values) and Order, then a Turn slider (−180…180°).
  - Frame: the mockup's "from Output" needs the Output workspace (M6). Ruling: until then Frame is a pop-up of the Swift frame sizes, plus "Project Frame Shape". Cost if wrong: one row changes in M6.
- **Put back** switch row ("Put back parts moved by hand"), with the footnote "N parts were turned or moved on the floor". Disabled at 0.
- **Footer:** "Edited" in `text3` when the draft differs, then Revert and Apply (accent). The draft and Apply semantics are as planned.

## Snap Sound page (Task 12): v2 page with the v3 Mix group
1. **Header row:**
   - "Snap sound" with "Heard when you play the build and in exports" and the on/off switch.
2. **Hear it:**
   - Three tiles, Plate / Brick / Pin, each with a play glyph and a waveform. The last-played tile is outlined in accent.
   - Ruling: the waveform is drawn from the written preview WAV and is a flat line until first played. Cost: none.
   - Footnote: "Plays straight away — no planning needed. Each change replays the last sample."
3. **Character:**
   - The six presets as tiles (`bm::settings::PRESETS`).
   - Under them, the source line "Source: Part Physics — …" with **Change…**, which opens the Source menu. It also opens the Recordings menu when the source is Recorded.
4. **Mix** (v3 inset group): Volume, Room, Stereo width.
5. **Click and Body** (folded):
   - Dimmed unless the source is Recorded or Synthesised.
   - Holds the Click and Body sliders, Variation, Simultaneous Arrivals and the two Match toggles.
6. **Footer:**
   - "Include in exports" switch: disabled with the note "Export options come with Export Movie" until M6.
   - Restore Defaults.

## Parts lane (Task 7): v3, replaces the plan's clip look
The interaction rules are unchanged: click, ⌘/⇧-click, double-click, arrival drag, ⌥ force, menu, Library drop.
- **Zoomed out:** used while a flight is narrower than the minimum clip width of 52 px.
  - Each flight is an 8-px dot at its seat time, in the part's colour, with a 1-px white 28 % ring so black and white parts show.
  - A pinned arrival gets a second ring (gap, then `text1`). The selected part gets a 3-px accent ring.
  - Lane height 32. Dots hit-test like clips.
- **Zoomed in:** soft clips 20 px high, radius 5, fill white 6.5 %, no border. Each holds a 7-px colour dot and the part name (11 pt, proportional). Rows come from `pack_lane`.
  - Selected: accent 20 % fill with a 1-px accent edge. Hover: white 11 %.
  - Pinned: a pin glyph at the right.
- **Chosen step:** an accent 7 % band behind the lane across the chosen step. Step names appear only in the Steps lane.
- **Hover card:** part name with a colour dot; Part, Step "i of n" and Flies "a – b"; then "Drag to retime · ⌥ drag to pin · Double-click to frame".

## Milestone 4 implementation rulings & checks (2026-11-25)

### Empirical rulings
- **Build Settings summary note (Task 11):** Verified in `tests/settings.rs::pacing_slider_drag_is_one_undo_and_one_plan` that changing a pacing slider enters `CheckingFlights` (`saw_checking_flights=true`). Per the ruling above, the summary card note reads `"Changes below re-time the build."` (without `"no replanning"`).
- **Snap track generation (Task 12):** `write_snap_track_time` in release mode on `samples/8880-1.mpd` (1,410 pieces, native planner) took **2.854 s** (140.6 MB WAV), exceeding the 100 ms main-thread budget. **Ruling: needs engine change (viewport-free snap track)** so snap track rendering can run on a worker thread without holding `bmapp::Viewport`.
- **Playback texture upload (Task 5):** `playback_frame_time` at 2880×1800 on `10294-1.mpd` (9,720 flights) achieved median **13.70 ms** / p95 **18.94 ms** (< 33 ms budget). No shared-texture detour was needed for Milestone 4.

### Verification summary
- C++ `bmffi_tests`: **61/61 test cases passed (1,279 assertions)**.
- `libbmffi.dylib` ABI surface: **199** `BMFFI_API` functions; `nm -gU native/build-rust/bmffi/libbmffi.dylib | grep -vc ' _bm_'` = **0**.
- Swift/app `ctest --test-dir native/build-app`: **634 tests, 0 failed**.
- Core engine `ctest --test-dir native/build`: **462 tests, 0 failed**.
- Rust `cargo test --workspace`: **all tests passed** (0 failures across `bm`, `bm-sys`, `brickmotion` unit & integration suites).
- Rust `cargo clippy --workspace --all-targets -- -D warnings`: **0 warnings**.

### Release performance benchmarks
- `playback_frame_time` (`10294-1.mpd`, 2880×1800, Standard Preview 9,720 flights): **205 frames in 3 s, median 13.70 ms, p95 18.94 ms** (budget < 33 ms — PASS).
- `big_model_timeline_frame` (`10294-1.mpd`, Fit & 64× zoom): **slowest timeline frame 452.75 µs** (budget < 16 ms — PASS).
- `big_model_parts_lane` (`10294-1.mpd`, 9,720 flights): **Fit layout 369 µs / show 80.3 µs; 64× layout 607.1 µs / show 8.17 µs / 157 clips visited** (budgets < 50 ms / < 16 ms — PASS).
- `write_snap_track_time` (`8880-1.mpd`, 1,410 pieces, native planner): **2.854 s** (140.6 MB WAV; > 100 ms budget — recorded as engine change ruling above).

### Visual inspection (`desktop/docs/m4-*.png`)
- `m4-timeline.png`: Planned helicopter mid-build with orange playhead at `01:15:10`, highlighted `Step 9`, Pause hold pill, and zoomed-in 2-row packed Parts clips with colour dots and labels; crisp alignment, no overlap.
- `m4-planning.png`: `8880-1.mpd` (1,410 pieces) actively planning with `"Solving Build Order…"` + 72-px accent progress bar in the title bar and centered planning indicator in the timeline.
- `m4-build-settings.png`: Assembled helicopter with 344-px Build Settings page showing `2:47` summary card, live rhythm bar, macOS inset Pace group, `How it's planned · Replans` order cards, pinned footer, and Navigator shifted clear to the left.
- `m4-staging.png`: Animate workspace at `00:00:00` showing waiting parts laid out on the floor alongside the 344-px Build Staging page with 3×3 block-diagram layout grid, Waiting Parts group, and Revert/Apply footer.
- `m4-sound.png`: Animate workspace with full-fit timeline (zoomed-out coloured Parts dots) and 344-px Snap Sound page showing blue switch ON, rendered PCM waveform on the accented `Brick` Hear It tile, 6 Character preset tiles, and disabled export switch footer.
- `m4-callout.png`: Build workspace with Steps tab and Step 4 Exploded in the viewport; floating Step Callout sits bottom-left directly above the `16 pieces selected` chip with Previous/Next, Play Step, Play to End, `Exploded ▾`, Show All, and Close.
