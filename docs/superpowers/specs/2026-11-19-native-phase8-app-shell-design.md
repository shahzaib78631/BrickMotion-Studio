# Native Phase 8: the app shell — design

Date: 2026-11-19 · Status: approved by the owner 2026-11-19; plan `docs/superpowers/plans/2026-11-19-native-phase8-m1-m2-shell-editing.md`

## Intent

The native rewrite (spec `2026-11-15-native-rewrite-design.md`) has its engine (phases 0–5), Metal
viewport (6), path tracer and sound (7), and a camera director in progress (`native/film`). Today
the only window is `bmview`, a viewer that opens one file and plays its build.

The owner asked for Phase 8 with an **Apple-grade interface: very sophisticated, every function the
web app has, and better than the web on every standard**. On 2026-11-19 the owner settled:

- Phase 8 is the **shell** as the spec defines it: documents, model browser, inspector, editing and
  timelines, ending in a daily-usable editor. Phase 9 (remaining panels) and Phase 10 (extras)
  follow, and together the three cover every web function.
- Approach **A**: a SwiftUI app over a thin C++ bridge, with the engine running every edit.
- The main window layout below ("ok").
- The design round stays in text (no browser mockups).

The acceptance checklist for "every web function" is
`docs/superpowers/specs/2026-11-19-native-app-parity.md`: about 200 rows, each with its phase,
today's engine support and how native should exceed the web.

## Goals

1. **A daily-usable editor.** Open any model the engine reads, edit it, save it as a real file, and
   play and scrub its build, without falling back to the web app for any Phase 8 row of the parity
   checklist.
2. **Apple-grade feel.** It behaves like a first-party Mac app:
   - documents: Open Recent, Finder double-click, autosave, Versions, Revert, Duplicate, proxy icon;
   - unlimited undo, named in the Edit menu ("Undo Recolour 3 Pieces");
   - every command in the menu bar with its shortcut, and in a ⌘K palette;
   - trackpad gestures (pinch zoom, two-finger pan, rotate);
   - full keyboard access, VoiceOver labels on every control, Dynamic Type in panels;
   - light and dark, system accent colour, macOS 26 materials;
   - no spinners on the main thread: planning, loading and thumbnails run in the background.
3. **Better than the web, measured.** These are the Phase 8 gates:

   | Measure | Web today | Native gate |
   |---|---|---|
   | Viewport, 10030-1 ×4 (12,148 pieces), 1920×1200 | not reached | p95 frame ≤ 8.33 ms orbiting (Phase 6 gate) |
   | Open the helicopter (305 pieces) to first frame | — (measure) | ≤ 0.5 s warm cache |
   | Edit to screen (move, recolour, delete) | — (measure) | ≤ 1 frame |
   | Undo depth | session only | unlimited, survives a save |
   | Re-plan after a one-piece edit, helicopter | whole re-plan | ≤ 0.3 s (incremental) |
   | Data safety | browser storage | files on disk, autosave, Versions |

   The web columns marked "measure" are filled in before the gate is judged.
4. **Phase 9 and 10 slot in without rework.** The sidebar, inspector, timeline lanes, menus and
   palette are registries that later panels add to.

## Non-goals (Phase 8)

- Phase 9 panels: render/video, staging, materials, scene tools, capture, export dialog, sound,
  mechanism lab, checks panel, templates. Phase 8 keeps today's `bmexport` route reachable from
  a menu item only.
- Phase 10: suggest, generate, AI, remix, Bricksafe, instructions.
- Native camera editing tools (camera lanes, camera inspector). The camera-director design gives
  them a design of their own; Phase 8 shows the director's camera read-only.
- iPad, Windows, a web build.

## Anti-goals

Failing any of these means the phase failed even if every row works:

- **A web clone in a Mac window.** The layout keeps the web's regions, but the controls, menus,
  documents and gestures are the Mac's own.
- **Ported web logic.** Native is designed from first principles; only flight/snap motion and
  staging were ported, at the owner's request. Web bugs are not reproduced (the dead ⌘G, the
  "Assets" tab that opens AI, Checks with no rail button).
- **Drift between views.** The viewport, browser, inspector, timeline and file must never show
  different states of the model.
- **Frame drops while editing** on models the viewport already plays smoothly.

## Constraints

- macOS 26 minimum (the owner's Mac runs 26; the app gets the current system look). Xcode 26.5,
  Swift 6.3, arm64 only.
- The engine (`bmcore`, `bmrender`, `bmfilm`, `bmsound`) stays C++ and is built by CMake.
- Other sessions work in this tree. `native/render/tools/bmview/*`, `native/core/*/plan/timeline.*`,
  `native/film/src/director.cpp` and `native/core/*/plan/legacy*` have uncommitted work that is not
  ours: never edit, stage or revert it. The app lives in a new `native/app/`; engine changes go in
  new files where possible, and touch shared files only after checking `git status`.
- Commit per task on the current branch; never move branches.
- Plan file schema is kept (spec, "Data and migration"); additions are additive.

## Approaches considered

- **A. SwiftUI app + thin C++ bridge + engine-run edits (chosen by the owner).** SwiftUI for
  sidebar, inspector, forms, palette and Settings; AppKit views for the Metal viewport and the
  timelines. Swift calls a small C++ layer, `bmapp`, through Swift's C++ interop. Every edit is an
  engine command; one command log drives undo, autosave, versions and re-planning.
- **B. The same with an Objective-C++ layer.** Most proven (bmview works this way), but every engine
  call is wrapped twice, which slows every later panel.
- **C. Grow bmview in AppKit.** Fastest start; the current system look is much harder without
  SwiftUI, which works against the main goal.

## Architecture

```
┌ BrickMotion.app (Swift, SwiftUI + AppKit) ─────────────────────────────┐
│ Document (NSDocument)   Window scene   Panels   Palette   Settings      │
│        │ observes snapshots, sends commands                             │
├────────┴───────────────────────────────────────────────────────────────┤
│ bmapp (C++20, Swift-friendly headers: value types, ids, no templates)   │
│   Session · Command log · Snapshots · Selection · Plan jobs · Thumbnails│
├────────────────────────────────────────────────────────────────────────┤
│ bmcore        bmrender        bmfilm        bmsound   (unchanged APIs   │
│ (model, io,   (renderer,      (camera)      (audio)    plus the edits   │
│  joints, ...)  pick, overlays)                         listed below)    │
└────────────────────────────────────────────────────────────────────────┘
```

### bmapp: the bridge

- **Swift sees only bmapp.** Its headers use plain structs, enums, `std::string`, `std::vector`
  and integer ids; no templates, `std::function`, or engine headers leak through. This keeps Swift
  C++ interop on well-supported ground and lets the engine change behind it.
- **Session** owns one open document: model, library and caches, connection graph, renderer,
  plan and timeline.
- **Commands.** Every change is a command with `apply` and `revert` (move, rotate, recolour,
  add, delete, replace part, group, make/extract submodel, step edits, motion overrides, hide).
  A gesture (a drag, a slider) coalesces into one command. The log is the single source of truth:
  - undo/redo walk the log, and the Edit menu names the command;
  - the document is dirty when the log is past the saved mark;
  - each command reports which pieces and steps it touched, which drives incremental re-planning,
    renderer instance updates and the timeline's redraw.
- **Snapshots.** After each command bmapp publishes an immutable, versioned snapshot (tree rows,
  steps, selection, inspector values, checks). SwiftUI observes snapshots and never reads the
  live model; this is what keeps views from drifting.
- **Background jobs.** Planning, loading, thumbnails and export run on the engine's job pool. A new
  command cancels a stale plan. Results come back on the main queue tagged with the snapshot
  version they belong to.

### Engine work Phase 8 needs

The engine today loads a model once and can only move a piece (`Model::setPlacement`).

1. **Editable model.** Add/remove pieces, colour, part, submodel membership, step, hidden, tags;
   stable piece ids across edits.
2. **Writers.**
   - `.brickmotion` project and plan JSON, through the existing `PlanDoc` so fields the engine
     doesn't know survive.
   - LDraw `.mpd` that keeps submodels and steps (today's `toLDraw` flattens).
   - The `writeInto` path the planner notes as missing.
3. **Renderer edits.** Add, remove and recolour instances without rebuilding the renderer;
   multi-selection outline (exists), hover highlight, marquee, gizmos (move, rotate), grid, ghost
   pieces while placing, refused-edit red outline, joint markers.
4. **Placing and snapping.** While dragging a part, the connector database finds the nearest
   free connector that mates; collision refuses crossings. Tab cycles the grip, R turns. Alt drops
   without snapping.
5. **Incremental re-plan.** Re-plan the units and steps a command touched, reusing the rest. Falls
   back to a full plan in the background when the change is too wide.
6. **Snapshot export.** `BrickMotion --snapshot out.png --open file [--state …]` renders the whole
   window, so layouts can be checked without someone at the screen and sent to the owner.

### The window

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● ● ●  ◧  Helicopter ▾        [ Build | Animate ]     ⌘K  ▶  ⇪  ◨     │
├───────────────┬──────────────────────────────────────┬───────────────┤
│ ▣ ▤ ≣         │ ┌tools┐                   ┌view ▾ ⊞ ◐┐│ Selection Part│
│ Models        │ │ ↖ ✥ │                   └──────────┘│ Submodel  Cam │
│ ▾ Main        │ │ ⟳ ⤢ │                               │               │
│   ▾ Rotor  12 │ └─────┘      Metal viewport           │ 3001 Brick 2×4│
│     Blade  4  │                                       │ ● Red         │
│   Tail     31 │           [⧉ Group ✂ ⎘ ⟲ 🗑]          │ Step 14 ▾     │
│               │              floating bar        ✛xyz │ Joints  3 ›   │
├───────────────┴──────────────────────────────────────┴───────────────┤
│ Build  Timeline  Motion   ◀ ▶ ▶▶  00:12.4 ───●──────── step 14 / 62  │
│ ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭  steps · parts · pauses · camera                    │
└──────────────────────────────────────────────────────────────────────┘
```

- **Toolbar:** document title menu (rename, versions, Show in Finder), Build/Animate switch,
  ⌘K, Preview, Export (menu to `bmexport` in Phase 8), sidebar and inspector toggles.
- **Sidebar** (navigator tabs, like Xcode): Models (submodel tree with counts, search, drag to
  reparent, row menus), Parts (library with thumbnails drawn by the Metal renderer, frequent/common/
  recent, search, categories, colour swatches, drag into the viewport), Steps (list, drag reorder,
  step editor, step menu).
- **Viewport:** Metal, filling the centre. Floating glass panels: tools (select, move, rotate,
  joints, world/local, collision), view (presets, projection, grid, wire, clay), axis gizmo, a
  selection bar beside the selection, zoom, hidden-pieces and laid-out chips, joint card. Mouse
  and keys as the web's (parity checklist §4–5), plus trackpad gestures.
- **Inspector:** Selection, Part, Submodel, Camera (read-only in Phase 8) tabs, as the parity
  checklist rows describe, plus the step callout in Animate mode.
- **Timeline** (Animate mode only, resizable): Build, Timeline (dope sheet), Motion. Transport,
  zoom, step blocks, parts lane, pause lane, submodel lanes, intro/build/hero clips, planner status
  and flagged moves with their reasons, motion popover at project/step/part level.
- **Menus and palette:** every command in the menu bar with its shortcut and in ⌘K. Web shortcuts
  keep their keys unless they clash with a macOS standard, where the system key wins.
- **Settings window:** appearance (system / light / dark), viewport options, auto-plan. The Claude
  key (Phase 10) will live in the Keychain.
- **Start:** a welcome window with recent documents and thumbnails, Open, and New.

### Visual language (my calls, open to the owner)

- System materials and controls throughout; the viewport is the only custom-drawn surface besides
  the timeline. SF Symbols for every icon. SF Pro, system sizes.
- The accent is the system accent colour; selection outline, playhead and keyframes use it.
- The viewport's floating panels use the macOS 26 glass material and hide while orbiting.
- Motion: panels and sheets use system animations; nothing animates longer than 0.3 s; Reduce
  Motion is honoured.

## Milestones (each ends in something the owner can run)

1. **Skeleton.** Xcode project in `native/app/` linking the CMake libraries; bmapp session;
   document opens any model the engine reads; viewport in the window; `--snapshot`. Proves the
   Swift ↔ C++ build before anything else is built on it.
2. **Editing core.** Command log, undo, snapshots, selection, picking, marquee, move/rotate/
   delete/duplicate/recolour/hide, keyboard moves, gizmos, writers and Save.
3. **Browser and inspector.** Models, Parts (thumbnails, drag to place with snapping), Steps;
   inspector tabs; context menus; ⌘K palette; Settings; welcome window.
4. **Timelines.** Build timeline with lanes, incremental re-plan, motion popover, dope sheet,
   step callout, preview playback.
5. **Polish and gates.** Accessibility, gestures, the measured gates above, parity checklist pass
   for every Phase 8 row.

## Decisions after the builder check

The owner settled these on 2026-11-19 ("yes, your picks"):

1. **Files.** A `.brickmotion` stays the single JSON file the web app reads (`brickmotion-project`
   version 1 wrapping a plan), not a package. Native saves must open in the web app and the Python
   tools. Edits are written in the plan's existing grid form where they fit. A piece off the stud
   grid or turned off the 90° steps gets one additive field holding its exact placement. The web
   ignores that field and keeps its grid placement. Opening `.ldr`, `.mpd`, `.dat` or `.io` makes
   a new untitled project, the way Keynote opens a PowerPoint file. ⌘S never overwrites the source,
   and **File ▸ Export LDraw…** writes `.mpd` with submodels and steps.
2. **Shared submodels.** Editing a piece inside a submodel edits the submodel, so every use
   changes, as in LDraw and Studio. **Make Unique** forks one use into its own submodel. The
   editable model therefore keeps the submodel hierarchy as its source. The flat piece list the
   planner and renderer read is derived from it, with each edit fanned out to every use.
3. **Hand keys.** Dope-sheet keys are a layer over the planned timeline, stored additively in the
   project. Re-planning replaces the planned layer and keeps the hand keys. **Bake** copies planned
   motion into keys only when asked.

My calls, marked for the owner to check:

- Undo spans saves while the document is open, as in other Mac apps. The log is not stored in the
  file.
- The Phase 8 gate is every parity-checklist row whose phase is 8. Rebrickable `.csv` and `.pbg`
  import move to Phase 9. Rows marked "superseded?" wait for the owner's review of the checklist.
  Where a row is split 8/9, its export parts go to Phase 9.
- A local, unsandboxed developer build that reads the LDraw library from `BM_LDRAW_DIR` or
  `public/ldraw`. Sandboxing and distribution come later.
- The owner chose a text-only design round, so approving this document is the interface sign-off
  the rewrite spec asks for.

## Settled while planning (2026-11-19)

- **Off-grid pieces need no new field.** The plan file already stores exact placements as `ldu` + `matrix`, and the web reads them (`src/io/ldrawImport.ts`).
- **An edited project drops the web's cached animation.** In a `.brickmotion`, `timelines` is a cache of planned animation that the web plans again when it is missing (`src/io/projectFile.ts`). An edited save drops it; an unedited save keeps it. `settings` and unknown keys are always kept.
- **Build.** CMake + Ninja builds the Swift app too, in its own tree (`native/build-app`, `-DBM_APP=ON`), so it never breaks the engine build other sessions use.
- **Window shell.** AppKit `NSDocument` + `NSSplitViewController` (sidebar and inspector items) hosts SwiftUI panes and the AppKit Metal viewport.

## Left to the builder

- Exact bmapp API shape, command list granularity, and snapshot diffing.
- The incremental re-plan's unit of reuse, provided full re-plans still match exactly.
- Thumbnail cache location and size.
