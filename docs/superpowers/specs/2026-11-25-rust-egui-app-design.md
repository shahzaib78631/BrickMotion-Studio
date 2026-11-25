# BrickMotion desktop app in Rust + egui (SolidCraft-style)

Date: 2026-11-25. Status: approved; interface LOCKED 2026-11-25.

## Intent

The owner wants the native BrickMotion editor built on the same stack as SolidCraft (the CAD app
installed at /Applications/SolidCraft.app), with an interface that looks and works like
SolidCraft, in a new directory. It must do everything the web app does, except the AI features.

SolidCraft 0.49 is pure Rust: **eframe/egui 0.37** for the interface, **wgpu 30** (Metal on
macOS) for drawing, **winit 0.30** for the window, `rfd` for file dialogs, `muda` for the native
menu bar, `arboard` for the clipboard. (Read from the app bundle's licences and crate strings.)

## Decided by the owner

- **Stack:** Rust + egui/eframe + wgpu, as SolidCraft.
- **Engine:** reuse the existing C++ engine (`native/core` = `bmcore`, `native/render`,
  `native/film`, `native/sound`, and `native/app/bmapp`) through a bridge. Only the Swift
  interface is replaced. No Rust rewrite of the engine.
- **Scope:** every web feature except AI. Out: the AI panel (generate/fix/paste/prompt),
  Generate-from-prompt and Claude variants, Claude key/model settings, Brick AI models.
  In: Suggest/ghosts/techniques, Generate (building/castle, brickify, seeds, remix), booklet
  instructions, everything else.
- **New directory.**
- **Swift app frozen** (2026-11-25): it stays buildable and its tests stay green, but gets no new
  features. New work goes into the C++ engine and the Rust app only. The owner found the Swift
  interface very poor, so screens are mocked up and approved before they are built.

## Goals

1. A Mac app (`BrickMotion.app`, Rust binary) with SolidCraft's layout and interaction style.
2. Feature parity with the web app minus AI, measured against the existing ledger
   `docs/superpowers/specs/2026-11-19-native-app-parity.md` (≈96 rows; AI rows excluded).
3. The engine's behaviour is unchanged: the same documents, plans, flights, sound and exports as
   the Swift app produces today.

## Non-goals

- Windows/Linux/browser builds (Rust makes them possible later; not now).
- Any change to planning, flights, certification or sound algorithms (the native engine's
  first-principles rule stands; see memory native-no-web-base).
- AI features (a separate phase the owner will plan).

## Anti-goals (failure even if it "works")

- Copying SolidCraft's brand assets. Its icons, glyphs, built-in themes, design tokens, palettes,
  UI kit, name and logo are under LICENSE-BRAND and need written permission. We copy the
  **layout and interaction conventions**, and draw our own icons and theme.
- Forking engine logic into Rust so the two drift apart.
- Breaking the Swift app or its tests (`native/build-app` 619, `native/build` 462 on
  2026-11-25) while the new app grows. The Swift app stays buildable until the owner retires it.
- Re-implementing behaviour in Rust that already lives in Swift as logic (timeline maths, track
  editing rules, document rules). That is the drift this project must avoid (see "Swift logic").

## Calls made by the designer (owner may override)

- **Reference:** the web parity ledger (about 87 content rows, minus the AI rows) defines what
  must exist. Where the Swift app already goes further than the web app ("Exceeds web by"
  column), the Rust app matches the Swift app.
- **Swift logic:** behaviour that lives in Swift today (e.g. KeyframeTracks, BuildTracks,
  CameraTrackLane, TimelineNavigation, DocumentModel rules) moves **down into bmapp** (C++),
  with a test, and both shells call it. Only view state and layout are written in Rust. This
  means bmapp does change, wherever Swift held logic.
- **Extras** (Suggest open connections/ghosts, techniques, Generate non-AI, booklet
  instructions) are engine work in C++ following the existing plan
  `docs/superpowers/plans/2026-11-22-native-phase10-extras.md` (slice 1 done). It is part of this
  project and lands in milestone 7. The Rust app adds only the UI.
- **Autosave:** the app autosaves to the document on a timer and keeps the last N timestamped
  backups in Application Support. There is no "Browse All Versions" (that needs NSDocument).
- **Install:** while both apps exist, the Rust app uses its own bundle id
  (`com.brickmotion.studio.rs`) and is an Alternate handler for `.brickmotion`. The Quick Look
  extension stays in the Swift build. Preferences start fresh (TOML); recents are imported once
  from the Swift app's list if present.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **Rust/egui shell over the C++ engine via a C bridge** | Keeps every tested engine path; one bridge to maintain | **Picked by owner** |
| Full Rust rewrite (engine + UI) | One language; months of re-verifying engine work | Rejected |

Viewport integration (my call, see below): the C++ Metal renderer draws into an offscreen
texture that wgpu/egui shows, so egui can draw gizmos, HUDs and popovers over the 3D view
exactly as SolidCraft does. The alternative, a native CAMetalLayer view placed under the egui
window, is simpler but egui cannot draw over it reliably.

## Architecture

```
desktop/                      (new, Cargo workspace)
  Cargo.toml
  bmffi/                      C ABI over bmapp (C++ → extern "C"), built by build.rs with CMake
    include/bmffi.h
    src/*.cpp
  crates/
    bm-sys/                   raw extern "C" declarations mirroring bmffi.h (a test checks they match); links libbmffi.dylib
    bm/                       safe Rust wrappers: Session, Viewport, catalog, exports, jobs
    brickmotion/              the eframe app (UI only)
      src/app.rs, theme.rs, icons/, panels/…, viewport.rs, commands.rs, …
  assets/icons/               our own SVG icons
  scripts/bundle.sh           makes BrickMotion.app (Info.plist, bmexport helper, resources)
```

- **Bridge:** a hand-written C shim (`bmffi`) over `bmapp` with opaque handles, POD structs,
  and owned buffers (`bm_string`, `bm_u32_slice`, free functions). Rust declares them by hand
  (no libclang needed), with a test that every `BMFFI_API` name in the header is declared.
  bmffi is one shared library (`libbmffi.dylib`) that links all engine static libraries, so
  Rust links one library. Chosen over the `cxx` crate because bmapp's headers are Swift-shaped
  (SWIFT_RETURNS_RETAINED, retain/release) and a flat C surface is easiest to keep stable. The
  shim is additive: bmapp is not changed for it except where an API is missing (below).
- **Build:** `cargo build` runs CMake (`cmake -S native -B native/build-rust -DBM_APP_LIB=ON`)
  for the engine static libraries + bmffi, then links them. Today bmapp is defined inside
  `native/app/CMakeLists.txt` after `enable_language(Swift)`; its target moves to its own
  `native/app/bmapp/CMakeLists.txt`, included by both the Swift app build and `BM_APP_LIB`, so
  the Rust build needs no Swift toolchain. (bridging.h already turns the Swift annotations into
  no-ops without `<swift/bridging>`.) The Swift app's build must still pass after the move.
- **Threading:** the engine's own workers (planning, inspection, placement) keep running in C++.
  Rust polls state each frame (`PlaybackState`, job progress) and requests repaint while
  something is running. No engine call blocks the UI thread for long; long calls go on a Rust
  worker thread with a handle the UI polls.
- **Viewport:** new bmapp entry `Viewport::drawToTexture(id<MTLTexture>)`. The Rust side creates
  a wgpu texture, gets its `MTLTexture` through `wgpu::hal` (Metal backend), hands it to the C++
  viewport, and registers it with egui (`egui_wgpu::Renderer::register_native_texture`). Both
  sides must use the same `MTLDevice`: the Rust app creates wgpu from the device bmapp reports
  (`Viewport::metalDevice()`), via `wgpu::hal` adapter-from-raw. Picking, orbit/pan/zoom and
  gizmo hits use the existing bmapp calls with egui pointer coordinates. Milestone 1 may start
  with the existing offscreen path (`draw(nullptr)` then `readback()` into a CPU picture,
  uploaded each frame) and switch to the shared texture once it works; the CPU path stays as a
  fallback and for tests.
- **Things the Swift layer does today that move into Rust:** autosave/versions (NSDocument),
  recent files, Render Queue (spawns `bmexport`), live snap sound (AVAudioPlayer) → `rodio` or
  CoreAudio via `cpal`, viewport recording (AVAssetWriter) → C++/ObjC++ helper in bmffi,
  Quick Look thumbnails (keep the existing Swift appex; it is independent of the app), part
  preview cache, pasteboard, preferences (TOML in ~/Library/Application Support/BrickMotion).

## Interface (SolidCraft conventions, our own look)

**LOCKED 2026-11-25** (owner: "Looks good … Lock the design"). Reference:
`.superpowers/brainstorm/65433-1795584607/content/final-locked.html`.

```
┌ title bar: logo · Home · File · Undo/Redo · document tabs (● = edited) · plan status ⚙ ? ─┐
├ ribbon: [Workspace] │ tabs (underlined) │ labelled tool groups      │ Search commands ⌘K │
│                     │                   │ (hover card per tool)     │ [ Build | Animate ]│
├────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌Browser──────┐            breadcrumb                               (home) axis navigator│
│ │filter       │                                                     ┌Properties──────┐ │
│ │Models Steps │              3D viewport                            │collapsible     │ │
│ │Parts Library│                                                     │sections, scrub │ │
│ └─────────────┘                                                     └────────────────┘ │
│ [4 pieces selected · Step 14 · Track left]   [orbit pan zoom│fit lookat home│Pieces ⚟] │
├──────────── Animate only ──────────────────────────────────────────────────────────────┤
│ tools │ 00:12:12 ⏮ ▶ ⏭ 01:48:00 │ Tracks|Curves  zoom                                   │
│ Camera / Build (▸ submodels) / Keys / Snaps                                             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Two workspaces, switched under Search commands (top right):** **Build** (no timeline; the
  viewport takes the full height) and **Animate** (timeline docked at the bottom). Render is
  not a workspace: export lives in Animate's **Output** ribbon tab (Export Movie, Export Still,
  Render Queue) and in File. The left Workspace button mirrors the switch. (Designer's call:
  the owner did not answer where Render goes.)
- The native menu bar (muda) carries every command as well.

- **Calm first (owner 2026-11-25: the dense mockups were "too cluttered, not professional").**
  Rules that override everything below: one stroke-icon family drawn by us (no emoji or
  unicode glyphs), one accent (blue for selection, orange only for the playhead), an 8-px
  spacing grid, 12.5-pt text with two weights. Few tools visible. Everything else is reached on
  demand: hover actions on rows and tracks, a contextual inspector (empty selection shows the
  project), right-click menus, ⌘K, and modes (Tracks ↔ Curves). Tracks start collapsed.
  **Approved direction (owner 2026-11-25): `final-app.html`** = the SolidCraft-style top (title
  bar with document tabs; ribbon with Workspace button, ribbon tabs, labelled tool groups and
  "Search commands"; floating Browser and Properties panels; axis navigator; floating view bar
  with Pieces and display popovers) + the calm timeline docked at the bottom (4 top-level
  tracks: Camera, Build, Keys, Snaps; transport and timecode centred; Tracks ↔ Curves; hover
  actions; right-click clip menu). All icons are our own stroke set.
  Refinements (`final-app-v2.html`, owner 2026-11-25): a **Build | Animate switch directly
  under "Search commands" at the top right** of the ribbon; ribbon tabs underlined, not filled;
  hover cards on ribbon tools (name, shortcut, one-line description); active-tool highlight; a
  selection chip in the viewport (pieces · step · submodel); a filter field in the Browser;
  collapsible inspector sections; number fields that scrub by dragging; a modified dot on the
  document tab.
- SolidCraft patterns to follow, from the owner's screenshots (2026-11-25): a ribbon with a
  Workspace switch (Build / Animate; see LOCKED above), ribbon tabs, and grouped tool buttons with group
  labels; a floating Browser (Models / Steps / Parts / Library tabs); an axis-triad navigator
  with a home button (top right); a floating view bar at the bottom (orbit, pan, zoom, fit,
  look at, home | "what a click picks" popover | show/projection popover); a right-click menu
  with shortcuts; a command search ("Search commands", S or ⌘K) listing commands with their
  path or id; a Home screen (side menu + New cards, Recent and Samples thumbnails); Preferences
  as a window with a search field, categories (General; Look: Appearance, Layout, Viewport;
  Work: Building, Placement, Animation, Sound, Export; Input: Navigation, Shortcuts; Data:
  Parts library, Autosave), theme cards, segmented controls, info tooltips, and Restore page
  defaults / Cancel / Apply / OK. Mockups: `.superpowers/brainstorm/*/content/`.
- **Timeline = professional video-editor style** (owner 2026-11-25: "like Adobe"). Program
  monitor with timecode and transport; Effect Controls panel (per-property stopwatch, keyframe
  navigation, interpolation); sequence tabs (nested submodels open like precomps); tool strip
  (Select V, Track-select A, Ripple B, Roll N, Razor C, Slip Y, Slide U, Pen P, Hand H, Zoom Z),
  snapping with a guide line, linked selection, add marker / add key; Dope sheet ↔ Graph editor
  (bezier handles, value and speed curves); timecode / frames / steps display; zoom slider and
  mini-map. Track headers with colour label, show, lock, solo, mute, collapse; Video tracks per
  submodel holding flight clips (thumbnails, fades), expandable to per-piece flight rows and
  Position/Rotation key rows; Camera track (shot clips + keys); Staging track; Audio tracks (snap
  track waveform, music). Ruler with work area, in/out, step/chapter markers, scrubbing playhead
  with timecode flag. Editing: ripple delete, lift/extract, trim with live preview, nudge by
  frame, J/K/L shuttle, copy/paste attributes. Every gesture is one Session command (one undo
  step). Mockup: `timeline-pro.html`.
- Dockable/collapsible side panels, a command palette (⌘K) over every command, right-click
  context menus, keyboard shortcuts matching the current Swift app.
- One command registry (id, title, shortcut, enabled-when, action) drives menus, toolbar,
  palette and shortcuts, as SolidCraft's commands drive its UI, CLI and MCP alike.
- Dark theme default + light theme, our own palette; icons drawn by us as SVG (rendered with
  `egui_extras` svg loader).

## Feature scope

Source of truth: the parity ledger's sections 1–10 (about 87 content rows) minus AI rows. In summary:
documents/projects/templates; model tree and submodels; parts library, colours, replace part;
viewport (views, shading/look, floor, edges, grid, ortho, picking, marquee, gizmo, snapping);
editing (move/rotate/duplicate/delete/recolour, placement with seats, undo/redo); steps and build
order; timelines (build, keyframes, camera lane, staging, flights); panels (Look, Build
Settings, Sound, Model Checks, Seat Loose, joints/motion); extras (Suggest, techniques,
Generate non-AI, booklet instructions, inventory import); exports (MP4, stills, LDraw, project,
plan, batch submodels, Render Queue); keyboard.

Where the ledger marks a feature as not yet in the engine (Phase 9 §2–§4, Phase 10 slices 2+),
the Rust app gets it when the engine gets it; that engine work continues in C++ as planned.

## Milestones

1. **Skeleton:** workspace, CMake bridge build, eframe window with SolidCraft layout, open a
   model, viewport texture showing the C++ render, orbit/pan/zoom, view presets.
2. **Document:** new/open/save/save-as/autosave/recents, undo/redo, model tree, selection,
   properties, command registry, palette, menus, shortcuts.
3. **Editing:** parts library + previews, placement, gizmo, recolour, steps.
4. **Build & play:** planner, transport, timeline, build settings, staging, sound.
5. **Animate & camera:** keyframes, camera lane, auto-direct, motion/joints.
6. **Render & export:** look panel, stills, movies, Render Queue, LDraw/project/plan exports.
7. **Extras:** suggest, techniques, generate (non-AI), booklet, inventory import, model checks.
8. **Parity sweep:** walk the ledger row by row; self-tests ported from the Swift `--selftest-*`.

Each milestone ends with a running app the owner can try.

## Testing

- bmffi gets Catch2 tests next to bmapp's (same fixtures).
- Rust: unit tests on wrappers; `--selftest-*` flags in the app driven headlessly (like Swift's);
  screenshot snapshots of the viewport texture.
- Existing `ctest` must stay green.

## Left to the builder

Crate choices beyond eframe/wgpu/rfd/muda/arboard (audio, svg), exact panel widths, icon
drawing, how the command registry is laid out, test harness shape.
