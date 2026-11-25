# Native Phase 9 editor panels

Phase 9 adds the remaining tools to the Swift editor. The web app establishes the workflow inventory. Use the native command registry, document undo history, inspector and timeline for the editor experience. Track the separate Phase 8 performance and live interaction gates in the [Phase 8 sign-off plan](2026-11-20-native-phase8-animation-and-signoff.md). The editor's path-traced preview stays deferred.

**File → Export Video** renders Build, Keyframes, or a turntable from the editor's playback engine. Build follows project holds and flight overrides. Keyframes include the full authored range and can retain a linked Build. Native Build can include synthesised snap sounds. The original export sheet was exercised live at 1080 × 1920 and 30 fps, including frame progress, cancellation and a clean destination folder. The editor movie test decodes keyed motion and checks authored timing, turntable duration and the snap audio track.

**Step → Build Staging** exposes the nine engine layouts, grouping, side, order and output shape for Camera Frame bands. Apply and Preview saves the settings as one undo step and shows the beginning of the resulting Build. Saving a camera projection with the layout is a separate scene tools task.

**Step → Model Checks** uses a captured model revision to report solid overlaps, groups without floor support, tipping, single-connector attachments, missing definitions, unknown colours and loops. Selection and framing use the same revision. The panel can also show the last refused edit.

**Camera inspector** saves the whole-project viewport's position, target, lens and projection as a named camera. Recall, rename, update from view and select a default for video. The movie sheet can use any saved camera for a whole-project Build or Keyframes video. Camera edits preserve other scene settings and undo through the document. The project round-trip test uses the shared scene coordinate system, and the movie test decodes different saved lenses.

**Edit → Copy Viewport Image** places a PNG of the current Metal view at its native pixel resolution on the macOS clipboard. The capture leaves the next onscreen redraw pending. The pane self-test decodes the PNG from a private pasteboard.

**File → Import Parts Inventory** reads Rebrickable CSV and Studio PBG in a worker. It keeps each part's colour and quantity, excludes spares, reports missing definitions and invalid rows, and packs the pieces onto the floor next to the current assembly. The import goes into the selected step or the model's last step as one undoable action.

**Window → Render Queue** keeps video work running when the export sheet closes. One job renders at a time, and cancellation and Finder reveal are available from the queue. Completed, failed and interrupted jobs remain in the history after relaunch. A job uses the document snapshot and destination file identity captured at submission.

**Submodel export** is available from the Models context menu and File → Export All Submodel Videos. Multiple selected definitions render to a folder with one set of settings. Repeated uses export once, and existing files keep their names. A single submodel can also be saved as a standalone project or MPD. The standalone project keeps the descendant definitions, scoped authored tracks and project video settings.

**Step → Snap Sound** saves a project mix and the default for Build video export. Audition a plate, brick or friction pin with the physical, recorded or synthesised voice. The export worker uses the same mixes and recordings. Live transport sound: done 2026-11-22 (below).

**View → Look** (inspector tab and the viewport's palette popover) saves the project's scene, shading and picture details. Scene, edge lines, AO and floor use the web's keys (`video.studioLook`, `edgeLines`, `materials`); shading (Standard, Studio, Neural, Hybrid RT, Screen-Space Bounce, Path Traced: bmview's g/r/p/h/k/n/v keys), shadows, ray-traced glass, baked studio visibility and lights-follow-camera live under `settings.native.look`. Each scene draws as one backdrop colour (the web gradient's middle). Every video export reads the whole look, and a path-traced movie refines each frame to its sample count. Export Still passes only the backdrop and light rig to `bmexport still`, which has no floor, edge or shading options. Editor Settings keeps a viewer-only switch for the scene backdrop. Each change is one "Change Look" undo step. Tests: `render_settings_test` (keys, undo, reopen, refusals, backdrop, every shading differs from Standard) and the movie check (green-screen corners in Build, Keyframes and Turntable).

**Step → Build Settings** saves bmview's planner flags under `settings.native.build`: planner (Native or Standard, `--planner`), order (Take Apart or Bottom Up, `--order reverse|forward`), flight shape (`--flight auto|web|arc`), splitting grown units (`--clean-grown`), each flight's length, gap, step hold, clearance and Arc corner rounding. Only non-default values are written. The timeline's "Use Native Planner" turns a saved Standard planner back to Native. Seat speed was left out: the planner does not read it. A test changes each setting alone and checks its effect on the plan; build order is only checked to replan, as the three-part test model builds the same either way.

**Step → Seat Loose Pieces** lists pieces placed a little off their connector (bm plan `--correct`) and seats the checked ones as one undo step. Rows whose seat would cross another part start unchecked, and a piece seated onto a listed piece that is left as it is cannot be checked.

## 1. Export and capture

- Begin with generated Build MP4 export for the project or the open submodel. Deliver four output shapes, frame rate, automatic camera or viewport angle, native destination selection, frame progress, cancellation and Finder reveal. Use the bundled renderer and AVFoundation. Write completed output to the selected destination only after encoding succeeds.
- ~~Extend authored export with additional output quality and frame-rate options, sound presets, and branding.~~ Done 2026-11-22: Quality and 24–60 fps in Export Video, the web's sound presets in Snap Sound, and an app-wide video logo (corner, on/off) composited into every exported frame. `movie_logo_test` checks placement and the blend; the movie check decodes a branded frame.
- In progress 2026-11-22: Export Still is a sheet (shape, size, samples, camera, logo) submitted to the Render Queue, which now accepts stills and a post-render step; covers are its vertical, portrait and square shapes. Still open from this bullet: transparent backgrounds (needs alpha from the path tracer in `native/render`), viewport recording and interchange exports.
- Bring still and sequence capture into the same workflow. Add still dimensions, clipboard, transparent backgrounds, project covers, turntables, viewport recording, path-traced final render and applicable interchange exports. Export an explicit project or model scope with a predictable file name.

## 2. Staging, materials and scene tools

- Extend staging with the captured camera projection, global turn, waiting-part placement and reset, and build-order controls. Keep staging positions and assembly spot transforms selectable in the viewport and editable with the existing gizmo.
- Add document-backed lighting, background, floor and material controls: the Materials panel set in the parity ledger (scene, floor, environment, colour source, finish, texture, studs, detail, edge lines, glow, glass, lens blur, AO, floor kind). Presets and temporary preview changes have different undo behavior. Cover scene cameras, reference images, render regions, exposure and guides with enabled states that reflect renderer capabilities.
- ~~Add live transport sound.~~ Done 2026-11-22: the Build tab plays the export's snap track (the project's mix) in step with the playhead, its rate and loop (TransportSound.swift over `Viewport::writeSnapTrack`); Settings → Planning and Playback Options switch it off. Not yet heard in a live session. 1 × 1 parts sound silent with the physical voice (the engine is unchanged, by the owner's physics rule).
- Done 2026-11-22: **View → Record Viewport** (⌥⇧⌘R) records the Metal view as H.264 at 30 fps with a recording badge; the panes self-test checks frames, size and duration.
- Done 2026-11-22: staging **turn** (the web's `stagingTurns[model]`, swung about the model's footprint and faded along each route; core `Flight::swing`) and **Straighten Waiting Parts** in Build Staging. Moving waiting pieces (floorShift) and the captured camera projection remain open.

## 3. Camera and motion authoring

- Camera timeline: done in part 2026-11-22. The Build timeline's **Camera** lane shows the web's `cameraTracks[model].build` keys and moves; add a key from the view at the playhead, drag a key, Update Key from View, Look At (fixed view, whole model, what is being built, landing piece), choose one of the web's 19 move presets per gap (presets that are a move set the end key), delete, clear. Every edit is one named undo step and other fields (roll, focus, blur, the Timeline clock's track) round-trip. `camera_track.cpp` ports the web sampler, sampled at the exact time (cuts stay cuts between frames); with Follow Camera on it films the viewport, and a Build export using the automatic camera (not the viewport angle or a saved camera) follows it too (the export route is not covered by a test yet). Rack focus and Dutch tilt are kept for web projects but cannot be chosen natively. Still open: a camera inspector (numeric target/lens/easing/shake), Auto-direct, the Keyframes clock's track, roll and depth of field (no renderer support), submodel close-ups in the "what is being built" target.
- Add editable flight paths with handles and point selection. Preview and audit the edited route before applying it to the source animation.
- Verify scene camera, automatic camera and authored camera in the viewport and every supported export route.

## 4. Analysis, project tools and parity

- Extend Model Checks to assembly spot diagnostics when assembly locations can be authored in the viewport.
- Bring mechanism lab workflows to the existing assembly and motion inspectors. Cover drive, gears, steering, sweeps, transmissions and the spatial tools in the parity ledger.
- Add templates, parts library updates, the remaining native settings and interchange exports in the parity ledger.
- Review the [parity ledger](../specs/2026-11-19-native-app-parity.md) against the shipped native entry points. Verify live interactions at the minimum window size in light and dark, keyboard and accessibility flows, saved-project round trips and performance on the helicopter and large reference build.
