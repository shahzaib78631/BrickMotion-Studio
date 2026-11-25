# Native app: parity with the web app

Date: 2026-11-19 · Status: draft, for the owner's review

The owner asked for Phase 8 with an Apple-grade interface that has every function the web app has
and exceeds it on every standard. This file is the acceptance checklist. Each row is something a
user can reach in the web app today (from a read of `src/App.tsx`, `src/ui/*`, `src/state/*`).

Columns:

- **Phase**: where the native rewrite spec puts it (8 shell, 9 panels, 10 extras). Proposed; the
  owner decides.
- **Engine**: does `bmcore`/`bmrender`/`bmfilm`/`bmsound` support it today? Y yes, P partly, N no.
- **Exceeds web by**: the measurable way native should beat it.

Parity means the function, not a port: native is designed from first principles
(see the native rewrite spec). Web bugs are not reproduced: the dead `⌘G`, the "Assets" rail tab
that opens the AI panel, and the Checks panel that has no rail button.

## Engine facts behind the Engine column (2026-11-19)

- `bm::Model` is loaded once and is immutable apart from `setPlacement`. There is no add, delete,
  recolour, regroup, submodel edit, step edit or undo.
- `bm::io` reads LDraw/MPD/Studio `.io`/plan JSON/`.brickmotion`. It writes plan JSON only
  (`writePlan`). There is no LDraw or `.brickmotion` writer, and `writeInto` is not done.
- `bmr::Renderer::pick(x, y)` exists. There are no gizmos, overlays, outlines for many pieces,
  marquee or snapping while dragging.
- The planner re-plans the whole model. There is no incremental re-plan or cross-run cache.
- `bmfilm` (camera director) is being built in another session. Native camera editing tools have
  a design of their own, deferred by the camera-director design.

## 1. Documents and projects

| Feature | Web | Phase | Engine | Exceeds web by |
|---|---|---|---|---|
| New / open / import model or project (.brickmotion, .json, .ldr, .mpd, .dat, .io; Rebrickable .csv and .pbg in phase 9) | Toolbar.tsx:198-330 | 8/9 | Y | Native Open and Open Recent, project documents, and untitled documents for model imports. Import Parts Inventory adds Rebrickable CSV or Studio PBG into the edited model, reports skipped rows, and undoes as a single edit. Finder previews use Quick Look. |
| Save project (.brickmotion), download plan (.json), LDraw (.mpd) | Toolbar.tsx:304-377 | 8 | N (plan JSON only) | Save, Save As, Duplicate, Revert and Versions. Export Plan and Export LDraw use native save panels and atomic writes. |
| Autosave status | Toolbar.tsx:324 | 8 | N | system autosave + versions; no "saves on this device" limit. **done (M2): autosave in place with Versions** |
| Projects dialog (list/open/delete) | ProjectsDialog.tsx | 8 | — | Welcome uses system recents with rendered previews, keyboard opening and Reveal in Finder. File management uses Finder. |
| Templates (save, apply, use-for-imports, download, import) | TemplatesDialog.tsx | 9 | N | |
| Rename project inline | Toolbar.tsx:322 | 8 | — | title-bar rename (document proxy) |
| History menu: undo/redo, rebuild steps and animation, regenerate steps only / animation only | Toolbar.tsx:341-354 | 8 | N | Named undo and redo coalesce gestures. Regenerate Build Steps preserves authored step sections. Regenerate Build Animation keeps the hand keys. |
| Command palette ⌘K (go to panels, import, fit, lay out, regenerate, theme) | Toolbar.tsx:268-398 | 8 | — | covers every menu command, fuzzy, shows shortcuts. **done (M3a): ⌘K glass palette over every enabled menu command, Open <submodel>, Go to Step n; fuzzy, shortcuts shown, recent first** |
| Parts library update prompt | PartsUpdatePrompt.tsx | 9 | N | |
| About | AboutDialog.tsx | 8 | — | Native About displays the application and engine versions. |

## 2. Model tree and browser

| Feature | Web | Phase | Engine | Exceeds web by |
|---|---|---|---|---|
| New model / submodule / from selection | ModelsPanel.tsx:203-219 | 8 | N | **done (M3a): New Submodel…, Make Submodel from Selection (⌥⌘G), Extract, Move to Model, rename and delete, all one undo step each** |
| Search models | ModelsPanel.tsx:221 | 8 | — | **done (M3a): the Models pane filter keeps matches and their ancestors** |
| Tree rows: open, show and fit, tags, counts | ModelsPanel.tsx:232-262 | 8 | P (submodel paths per piece) | Native outline with keyboard navigation, drag to reparent, counts, shared/unused marks and group tags. |
| Row menu: play its build, lay out parts, view parts, export MP4/project/LDraw, import into, open another | ModelsPanel.tsx:165-191 | 8/9 | Y | Open, Play Build, Lay Out Parts, Show and Fit, View Parts, Import Into, and exports for video, standalone project and LDraw. The standalone project retains scoped authored animation. |
| View parts dialog: steps tree, per-step show/hide, select, extract, move to step | PartsDialog.tsx | 8 | N | The Models sidebar has one scrolling browser with independent step disclosures, visible viewport visibility and submodel actions, part-and-colour groups with individual instances, and undoable extraction and moves. |
| Assembly Corrector (Python engine) | ModelsPanel.tsx:266-292 | — | superseded? | native `--correct`; Step → Seat Loose Pieces (phase 9) lists and seats them as one undo step |
| Batch export selected / all submodules | ModelsPanel.tsx:294-305 | 9 | Y | Selected Models rows and File → Export All Submodel Videos use a shared settings sheet and destination folder. The queue renders one movie per selected definition and reserves distinct names. |
| Breadcrumb back to main model | App.tsx:306 | 8 | — | **done (M3a): glass breadcrumb over the viewport; ⌘↑ goes back a level** |

## 3. Parts and colours

| Feature | Web | Phase | Engine | Exceeds web by |
|---|---|---|---|---|
| Parts: Frequent / Common / Recent, search, category | PartsPanel.tsx | 8 | P (library) | Metal previews, exact-ID ranking, category filtering and local history of committed placements. |
| Placement-hint and mirrored-pose options | PartsPanel.tsx | 8 | N | Optional documented placements, mirrored orientation, quarter turns and grip cycling. |
| Click to add, drag into viewport to snap, drag onto timeline Parts lane | PartsPanel.tsx | 8 | N (no snap-on-drag) | The library and timeline drop use one guarded placement preview with free connector snapping and an explicit commit. |
| Replace part | Inspector.tsx:308 | 8 | N | **done (M2): Object ▸ Replace Part… searches the library by number and description** |
| Colour swatches (groups, search, recent), colour for new parts | ColorSwatches.tsx | 8 | P (colour table) | Common swatches, categories, code search and recent colours are shared by new parts and selection recolouring. |

## 4. Viewport

| Feature | Web | Phase | Engine | Exceeds web by |
|---|---|---|---|---|
| View presets (front/back/right/left/top/bottom, flat-lay, centre on floor, persp/ortho), numpad keys | ViewMenu.tsx, viewControls.ts | 8 | P (orbit camera) | Native orthographic and perspective views, saved editor camera, six axis presets, flat-lay and floor centring. See the sign-off plan for the measured orbit gate. |
| Viewport renderer select (current / studio path / hybrid / ThreeRT) | ViewportChrome.tsx | 8 | P | Native Metal editing viewport and still export. The owner deferred the in-editor path-traced preview. |
| Split: lay out every part on the floor | ViewportChrome.tsx | 8 | P (staging) | The floor layout is a reversible view state and has a one-click return to the assembly. |
| Tools: select, move, move gizmo, rotate gizmo, scale, joints on/off, world/local, aim the way in, collision | ViewportChrome.tsx:109-165 | 8 | N | Axis and plane controls for move, rotate and scale, local and world axes, real joint markers, insertion-direction controls and a collision-checked placement mode. |
| Orbit 45°, projection, fit, grid + spacing, wireframe, clay, fullscreen | ViewportChrome.tsx:126-151 | 8 | P | Native full screen, adjustable grid and Metal render modes, available from View and the palette. |
| Floating selection bar (submodule, extract, group, fit together, rigid, duplicate, rotate, delete, lay out, hide) | ViewportChrome.tsx:166-190 | 8 | N | Context-sensitive commands share their actions and validation with the menu bar and palette. |
| Frame all, zoom −/%/+ | ViewportChrome.tsx:197 | 8 | P | Percentage reflects the fitted view, with accessible frame and zoom controls. |
| Nav gizmo, view label, hidden-pieces chip, laid-out chip | NavGizmo.tsx, Viewport.tsx | 8 | N | Live axes, projection label and reversible hidden/laid-out chips. |
| Joint card: hinge/ball angle, turn, select rigid group, detach | Viewport.tsx:2241 | 8 | P (bm/kin) | Native joint data, clearance checks and a single undo step for a successful turn or release. |
| Mouse: click/shift-click, marquee, drag move, orbit/pan/zoom, context menu, double-click submodel | Viewport.tsx | 8 | P (pick) | Trackpad pinch, rotate and two-finger pan. Direct dragging and catalog placement show the same snap and collision status. |
| Piece context menu (what fits, turn waiting piece, frame, fit together, open submodel, show/lay out step, organize, move to step, rotate, raise/lower plate, clipboard, clone, use colour, hide, select ▸ same part/colour/touching/connected/step/all, delete) | PieceMenu.tsx | 8 | N | Ranked compatible parts and fit previews, assembled and laid-out step actions, geometric touching and graph-based selection. Waiting orientation is available on eligible individual flights and keeps the installed pose. |
| Empty-space menu | PieceMenu.tsx:135 | 8 | — | **done (M3a): paste, select all, show all, fit all, view presets ▸, New Submodel…** |
| Flight path editing (double-click adds point, select points) | flightPathOverlay.ts | 9 | N | |

## 5. Editing

| Feature | Web | Phase | Engine | Exceeds web by |
|---|---|---|---|---|
| Move by arrows (camera-relative), raise/lower plate or brick, rotate 90° | keymap.ts | 8 | N | **done (M2)** |
| Duplicate, copy, cut, paste, clone and place | keymap.ts | 8 | N | LDraw system clipboard and a shared placement preview for catalog parts and moves. |
| Delete, hide, isolate, show all, select all/none | keymap.ts | 8 | N | **done (M2)** |
| Placing mode: Tab cycles grip, R turns, Esc cancels | Viewport.tsx:1553 | 8 | N | Native placement HUD, Return to commit and temporary Option override. |
| Collision-refused edits shown red and explained | ChecksPanel.tsx:47 | 8 | P (collide) | Red Metal preview with a reason in the placement HUD and inspector. |
| Inspector Selection: make submodule, extract, move to model, fit, group, duplicate, delete, ways to fit, marks/tags, transform fields, flies-in-from editor, part info, model overview | Inspector.tsx:174-298 | 8 | N | Selection and part-specific inspectors expose group tags, fit alternatives, insertion direction and editable geometry alongside the selection summary. |
| Inspector Part: replace, refused-edit reason, checks, connections, colour, step | Inspector.tsx:300-339 | 8 | P | Part replacement with rendered previews, native connection details and collision status. |
| New submodel dialog | NewSubmodelDialog.tsx | 8 | N | **done (M3a): a name sheet with a free name offered** |

## 6. Steps and build order

| Feature | Web | Phase | Engine | Exceeds web by |
|---|---|---|---|---|
| Step list: show all, auto-split banner, drag reorder, play, edit, expand submodels | StepsPanel.tsx | 8 | P (steps read) | Reveal all, split long steps in planned order, drag to reorder, play or stage, and browse a submodel’s steps directly from its parent step. |
| Step editor: title, notes, pause, piece order, split, gather, merge | StepsPanel.tsx:44-125 | 8 | N | **done (M3a): popover with title, notes, pause (0–10 s), piece order by drag, split and merge; typing is one undo step** |
| Step menu: select, pin order, gather, insert, move, delete | StepsPanel.tsx:317-352 | 8 | N | **done (M3a): select, insert before/after, split, merge, gather selection, pin order, edit, delete** |
| Step callout: prev/next/all, parts, stop here / play step / play to end, separated/laid out/exploded/assembled | StepCallout.tsx | 8 | P | Native viewport callout shares the build playhead and stage previews. |

## 7. Timelines

| Feature | Web | Phase | Engine | Exceeds web by |
|---|---|---|---|---|
| Build / Timeline / Motion modes | App.tsx:345 | 8 | P | Native resizable Animate workspace with a common transport. |
| Planner status chips, out-of-date, progress, auto-plan | BuildTimeline.tsx:317 | 8 | P (whole re-plan) | Cancelled jobs cannot replace a newer plan. Timing updates reuse all paths, and eligible single-leaf moves recheck affected paths. Geometry replan timing is still under evaluation. |
| Transport, zoom, fit | BuildTimeline.tsx:383 | 8 | Y (timeline) | Frame-based seeking, playhead following, edge scrubbing, pointer-anchored magnification, playback speed, looping and Fit. |
| Step blocks + step-clip menu, pause handles, submodel lanes | BuildTimeline.tsx, timelineMenus.ts | 8 | P | Chronological step runs with selection, playback, split, join, order, insertion and step motion in the native context menu. |
| Parts lane: drag arrival, force order, pin, drop parts, clip menu | PartsLane.tsx | 8 | N | Real colour and LDraw ID on stacked clips. The clip reveals the inspector, moves or splits arrivals, and edits motion. Arrival drag sets and pins the order in one undo step. |
| Pause lane | PauseLane.tsx | 8 | N | Pause length is edited against the playhead and saved with the step. |
| Camera lanes (keys, moves, auto-direct presets, key from view) | CameraTrackRow.tsx | 9 | P | Build Camera lane: add from view, drag, update, Look At, 19 move presets, delete, clear; web-compatible `cameraTracks` with undo; plays in viewport and Build export. Auto-direct and the Keyframes clock remain open. |
| Intro / Build / Hero clips | BuildTimeline.tsx:606 | 8 | P | Native playback maintains the three sequence regions and their exact times. |
| Planner error panel with diagnostics | BuildTimeline.tsx:486 | 8 | P | Each flagged row identifies a part and reason, and jumps to the relevant time in the viewport. |
| Motion popover (presets, flight time, landing, hover, easing; project/step/part) | MotionEditor.tsx | 8 | P (Style) | Shows inherited values and preserves the resolved path while changing its timing. |
| Dope sheet (insert key, auto key, nav, loop, frame, object list, properties, interpolation, scene range, check motion, build-motion layer link/bake) | KeyframeTimeline.tsx | 8 | N | Native object and property lanes, explicit bake, and sampled motion checking. Hand keys use the shared project schema and survive replanning. |
| Camera inspector (target, position, lens, moves, easing, shake, blur, presets) | CameraInspector.tsx | 9 | P (bmfilm) | camera-director editing design |

## 8. Panels (spec phase 9)

| Area | Web | Engine | Notes |
|---|---|---|---|
| Render/video: length, arrival mode, hero orbit, timing presets, camera options, look & sound, logo, output format/fps | VideoPanel.tsx | P (bmexport) | Export Video offers four frame shapes, three sizes, quality, 24–60 fps, automatic, viewport or saved cameras, and a logo in any corner at the web's size, inset and 90% opacity. The logo is app-wide like the web's and is copied when chosen, so queued jobs keep the image they were submitted with. Arrival mode, hero orbit and timing presets remain open. |
| Planner picker (V2/V3/V4/artifact), budgets, support mode | VideoPanel.tsx:264-447 | — | superseded by the native planner; confirm. Step → Build Settings (phase 9) saves Native/Standard planner, order, flight shape, grown-unit splitting and pacing per project. |
| Video renderer (live / studio path / path traced, samples) | VideoPanel.tsx:470 | P (phase 7 tasks 1–4) | |
| Staging: 9 layouts, grouping, sides, turn, put back, build order force | StagingPanel.tsx | Y (staging.cpp port) | Build Staging saves the nine layouts, grouping, sides, order and aspect with an undoable preview. Staging turn and Straighten Waiting Parts done 2026-11-22. Captured camera projection, moved waiting pieces and global order controls remain open. |
| Assembly spots outliner, transforms, markers | AssemblyPanel.tsx | P | |
| Materials: scene, floor, environment, colour source, finish, texture, studs, detail, edges, glow, glass, lens blur, AO, floor kind | MaterialsPanel.tsx | P | HDRI photo rigs are a phase 7 non-goal. View → Look (phase 9): the 34 scenes as backdrop colours, floor on/off, edge lines, AO on/off, shadows, ray-traced glass, six shadings and lights-follow-camera, saved with the web's keys where it has them. Finish, texture, glow, lens blur, edge colour, AO strength, floor kinds and gradient backdrops need renderer work in native/render and remain open. |
| Scene tools: lights, reference images, photo rigs, camera view, render region, guides, exposure | SceneTools.tsx | P | The Camera inspector can capture, recall, rename, replace and remove named camera views. Build and Keyframes movie export can use the saved lens and pose. Scene lights, reference images, region, guides and exposure remain open. |
| Export dialog with per-job progress | ExportDialog.tsx | Y | Build, authored Keyframes and Turntable MP4 use the native destination sheet, frame progress, cancellation and Finder reveal. Build offers optional snap audio. The Render Queue runs single or batch exports in the background and retains their history. |
| Capture: stills, clipboard, covers, transparent, path-traced final, COLLADA, turntable, record viewport | CapturePanel.tsx | P | Export Still path-traces a PNG in any of the four frame shapes (vertical, portrait and square serve as covers), at two sizes and three sample counts, from the viewport angle or automatic framing, optionally with the video logo, through the Render Queue. Turntable movies come from Export Video. Edit copies a PNG of the current Metal view. View → Record Viewport saves an H.264 movie of the view (2026-11-22). Transparent stills (path-tracer alpha) and COLLADA remain open. |
| Sound: snap on/off, try it, presets, click/body/space | SoundPanel.tsx | P | Snap Sound saves the mix and default for Build export, offers physical, recorded and synthesised voices with the web's presets, and auditions three sample arrivals. Live transport sound plays the same track with the Build (2026-11-22). |
| Mechanism lab: drive, gears, steering, sweeps, spatial workbench, transmission workshop, classifications, explorer | MechanismLabPanel.tsx | P (bm/kin) | |
| Checks: refused edit, overlap/floating/weak/unknown/loop/spot with reasons | ChecksPanel.tsx | Y (collide, stable, joints) | Model Checks opens geometry and connection findings in the viewport and shows the last refusal. Assembly spot diagnostics remain open. |
| Settings: appearance, accent, surfaces, Claude key + model, selection bar, wireframe, auto-plan | SettingsPanel.tsx | — | macOS Settings window; system accent; key in Keychain (the Claude key and model move to the AI phase) |

## 9. Extras (spec phase 10)

| Area | Web | Notes |
|---|---|---|
| Suggest: next pieces, open connections, techniques, calculators, viewport ghosts | SuggestPanel.tsx | Partial (Phase 10 slice 1, 2026-11-22): Find Compatible Parts lists "What Builders Put Here" from the BrickNet habits (bundled `Resources/Suggest/habits.json`): one row per part at the surveyed pose, mated to the target and clear of overlaps, colour by the web rule, explained by its model count; Add Part places it as one undo step. Open connections, ghosts, mirror/repeat, techniques and calculators remain. |
| Generate: building/castle, from prompt, remix, Claude variant | GeneratePanel.tsx | Phase 10: building/castle, brickify, remix. From prompt and Claude variant: AI phase |
| AI: generate, fix, paste, prompt | AiPanel.tsx | AI phase (separate, after Phase 10; owner 2026-11-22) |
| Bricksafe finder | BricksafePanel.tsx | needs the web dev server; superseded? |
| Instructions/booklet | none in web UI | not in web UI; native could add it |

## 10. Keyboard

Every web shortcut (inventory section 20) keeps its key unless it clashes with a macOS standard,
in which case the system key wins and the menu shows it. All commands live in the menu bar.
