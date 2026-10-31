# Studio-style build mode — design

Date: 2026-10-31
Status: approved by the user 2026-10-31

## Why

Building a model in BrickMotion's build mode is hard. The reference is BrickLink Studio
(the user's screen recording, `~/Desktop/videoplayback.mp4`): you grab a brick from the
palette, a see-through preview of it seats itself on the stud under the mouse, you let go
and it is placed. Moving a built piece works the same way. Pieces never end up inside
each other.

In BrickMotion today:

- A dragged piece slides on a flat plane at the height it started at
  (`Viewport.tsx` move drag, `studSnap.ts`: "the drag never changes height"). It cannot climb
  onto another brick or drop into a gap.
- The overlap check (`overlapTest`) runs only for sideways parts. Normal drags, the gizmo's
  vertical move and the arrow / E / Q keys move pieces with no check, so pieces sink into
  each other.
- A palette click drops the new part at a free spot on the floor (`findFreeSpot`), not where
  the user is looking. There is no drag from the palette into the 3D view.
- There is Duplicate (⌘D) but no copy / paste, no clone-and-place, and no box select.

The user asked for all of it: placing new parts, moving built parts, and copy / paste / clone.

## Prior art (researched)

- **LeoCAD** (open source, GPL): new parts stack on the selected part's bounding box, then
  round to a grid. It has no collision check. Copy / paste puts LDraw text on the clipboard. Only
  train track uses real connection matching. Too simple to copy, and the GPL licence rules
  out lifting its code. We take the clipboard-as-LDraw idea only.
- **BrickLink Studio / LDCad** (closed): snap to the connection point under the cursor.
  LDCad does this with the LDCad "shadow library" snap metadata (`SNAP_CYL`, `SNAP_CLP`,
  `SNAP_FGR`, `SNAP_GEN`).
- **BrickMotion already has that metadata.** `public/data/ldcad-shadow.json` is installed,
  `src/ldraw/shadow.ts` parses it, and `metricsOf(part).snaps` exposes it per part, next to
  `studs` (top studs) and the derived underside sockets (`socketsOf`). We build our own
  snapping on this data. No third-party code is copied.

## Goals

1. **Point-and-place.** Dragging a part from the Parts panel into the 3D view shows a ghost
   (see-through preview) of the part seated on the connection under the mouse, at the right
   height. Releasing places it. Clicking a palette tile keeps today's behaviour (free floor spot)
   so nothing the user relies on breaks.
2. **Grab-and-move.** Dragging a built piece (or the selection) works the same way. The
   pieces follow the mouse, jump onto the nearest compatible connection under it, and can climb
   onto, drop off and move around the model freely. They are no longer held to one height.
3. **No interpenetration.** No edit puts a piece inside another piece: drag, palette drop,
   gizmo, arrow keys, E/Q, rotate, paste. When a move would collide, the edit picks the
   nearest clean seat. If there is none, the piece stays where it was and the ghost shows red.
4. **Copy / cut / paste / clone.** ⌘C / ⌘X / ⌘V, plus Studio-style clone (C): clone
   picks up a copy of the selection that follows the mouse like a palette drop, and a
   click places it.
5. **Box select.** Drag on empty space with the Select tool to select every piece inside
   the rectangle. Shift adds to the selection, Alt removes from it.
6. **Cycle the grab point.** While dragging, Tab cycles which connection of the moving part
   is the "handle" that seats on the target (Studio behaviour). Hitting the Tab key turns the
   part over onto another face's connections where it has them (e.g. a brick's top studs vs. its
   underside), so a part can be hung beneath another.
7. **Rotate in hand.** While dragging or holding a clone / palette ghost, R rotates 90°
   about the target connection's axis (normally vertical). Shift+R rotates the other way.

## Non-goals

- A hinge / free-angle tool, flexible parts and path-bending (later project).
- Snapping Technic pins, axles, clips and bars by their own connection types. The
  engine is built so these slot in (see "Connection model"), but this project ships
  **stud ↔ anti-stud** only: top studs, underside sockets, and the shadow library's stud-type
  `SNAP_CYL` entries, including sideways studs (SNOT). Other connection types keep the
  plain move behaviour, with the collision check still applied.
- Changes to the animation, flight planning or timeline. Placement only edits plan items, as it
  does now.
- A new project file format. Clipboard text is LDraw; plan items are stored as today.

## Anti-goals (would count as failure even if it "works")

- A snap that feels jumpy: the ghost flickering between two seats while the mouse barely
  moves.
- Any path that still lets a piece sink into another without the user turning collision off.
- Breaking existing editing: undo / redo gestures, multi-select groups, submodel bays,
  floor-shift drags in "laid out" view, the gizmo's rotate / scale modes, sideways-part seating
  that works today.
- Dropping frame rate while dragging on a model of a few hundred parts.

## Connection model (decided)

One list of **connectors** per part, in part space, built from what we already have:

- `stud` (male, up axis): from `metrics.studs`, plus shadow `SNAP_CYL` entries that are
  stud-shaped and male.
- `socket` (female, anti-stud): from `socketsOf(body)` for whole-stud footprints, plus
  shadow female stud-type `SNAP_CYL` entries (covers tubes, recessed undersides and odd
  parts that `socketsOf` cannot infer).

Each connector carries a position, a unit axis (the direction a mating part comes from) and
a type tag (`stud`). A male connector mates with a female of the same type whose axis is
opposite. The type tag is the extension point for pins and axles later.

Connectors are computed once per part and cached alongside metrics.

## Placement engine (decided behaviour, builder chooses the structure)

Given the moving set (one part from the palette, or the selection), a mouse ray, and the rest of
the model:

1. **Ray hit.** Raycast the scene (excluding the moving set). Take the hit part and the hit
   point. If nothing is hit, hit the floor plane (or the baseplate, if one exists) and fall back to
   whole-stud grid placement on the floor, as today.
2. **Candidate targets.** On the hit part, take the free connectors (not already mated, not
   covered) within a small radius of the hit point. Use studs whose axis faces the camera
   side of the hit surface, and sockets when the user is pointing at an underside.
3. **Match.** For each candidate target and the active handle connector of the moving set
   (Tab cycles it; default is the handle nearest where the user grabbed the piece, or for a
   palette part its first underside socket), compute the transform that puts the handle on
   the target with axes opposed. Rotation about the axis is kept at the part's current yaw,
   snapped to 90°.
4. **Score.** Among the resulting poses, drop any that collide. Prefer poses that mate more
   connectors at once (a 2×4 lands on 8 studs, not 1). Then prefer the target nearest the
   hit point on screen.
5. **Hysteresis.** Keep the current pose until another pose's target is clearly closer
   (builder picks the threshold, roughly a third of a stud on screen). This prevents flicker.
6. **Preview.** Show the ghost at the chosen pose: translucent and tinted green when valid,
   red when no clean pose exists (the release then does nothing). Moving existing pieces
   shows the pieces themselves at the candidate pose, not a ghost.
7. **Commit.** Release writes plan items. Poses that are whole-stud, upright and 90° yaw are
   stored as `Grid` items, as today. Anything else (half-stud offsets, sideways, flipped) is
   stored as `Raw`. One undo step per gesture (`beginGesture` / `endGesture`).

The existing `studSnapper` keeps working for keyboard nudges. The new engine replaces it for
mouse drags.

## Collision (decided)

- One shared check, extending `overlapTest` (mesh-sampled, studs-in-sockets exempt), is used
  by every editing path. It is no longer limited to sideways parts.
- **Keyboard (arrows, E/Q, rotate):** apply the step. If it collides, try the nearest seat
  along the same direction (e.g. E on a plate under a brick pops it up on top of the brick).
  If that also fails, refuse the move and flash the piece red briefly.
- **Gizmo translate:** while dragging, a colliding position is clamped back to the last clean
  one, and the readout shows "blocked".
- **Toggle:** a toolbar toggle and shortcut (`K`, my pick) turn collision off for
  deliberate overlaps (decorations, imported models that already overlap). It is on by default
  and saved in app settings.
- **Already-overlapping models** (imported files): pieces that overlap from the start are not
  forced apart. The check only refuses an edit that makes overlap *worse* for the pieces being
  moved.

## Copy / paste / clone (decided)

- **⌘C** copies the selection as LDraw text (an MPD fragment with any submodels used)
  to the system clipboard, plus a private in-app copy that keeps plan metadata (step-less, ids
  dropped, assembly hints dropped except `group`).
- **⌘X** copies, then deletes.
- **⌘V** starts a placement drag with the clipboard contents as the moving set: the ghost
  follows the mouse and snaps (as a palette drop does), and a click places it. Esc cancels. If
  the mouse is outside the viewport, it pastes at a free floor spot beside the model,
  like Duplicate.
- **Pasting LDraw text from another app** (LeoCAD, Studio's LDraw export) works through the
  same path, using the existing LDraw import parser.
- **C (clone)** is copy-and-paste in one action, leaving the clipboard alone.
- **⌘D (Duplicate)** keeps today's behaviour (copy placed beside the selection), now
  collision-checked.
- Pasted pieces go into the current step (or the last one), like `addPart`, and become the
  selection.

## Box select (decided)

- **Mouse mapping changes to Studio's (user decision):** left-drag on empty space draws the
  selection rectangle; **right-drag orbits** the camera (OrbitControls left → none, right →
  rotate); a right-click without movement (≤4 px, as today) still opens the piece menu; middle
  button keeps its current mapping. Update viewport help text accordingly.
- With the Select tool, a drag starting on empty space draws a rectangle. On release, every
  piece in the editing model whose screen-space bounding box centre falls inside it is selected
  (my pick: centre-inside, which is predictable and fast). Hidden pieces are skipped. Shift adds,
  Alt removes.
- Group selection rules (`selectionForHit`) apply: picking one member of a group picks the group.

## Palette changes (decided)

- Parts tiles stay draggable onto the timeline's Parts lane (unchanged) and now also into
  the viewport (new drop target, same `PART_DRAG_TYPE`).
- HTML drag-and-drop gives poor live feedback over a canvas. The builder may instead start
  a pointer-driven "placing" mode on tile pointerdown + move into the viewport. Either is fine
  if the ghost tracks the mouse smoothly.
- New parts take the paint colour, as today.

## Where the new drag applies (builder's call, made by Claude)

- The placement engine replaces the **Move-tool** drag on pieces in the normal edit view.
- In **laid-out view**, floor-shift drags keep today's behaviour.
- In the **build view that follows the animation**, Select-tool `startFloorDrag` (moving where a
  waiting piece sits on the floor) keeps today's behaviour.
- With the **Select tool**, a press-and-drag on a piece that is already selected also starts
  the placement drag (Studio-like), so users don't have to switch tools. A plain click still
  selects.

## Submodels (builder's call, made by Claude)

- A submodel use (`SubItem`) gets a connector list built from its child parts' connectors,
  transformed into the submodel frame and cached per submodel name. Invalidate the cache
  when that submodel changes.
- Collision for a submodel use samples its child parts' meshes. Submodels are no longer
  exempt, as they are today when `overlapTest` returns `null`.
- On paste, a submodel in the clipboard whose name matches an existing submodel is reused
  if its content is identical. Otherwise it is added under a new name (`name (2)`). Nothing
  existing is ever overwritten.

## "Worse overlap" (builder's call, made by Claude)

The measure is the **set of overlapping piece pairs that involve a moved piece**. An edit is
refused only if it adds a pair that wasn't there before. A piece that starts inside another
can always move out, and moving it within the same overlap is allowed, so imported overlapping
models stay editable. `overlapTest` is extended to report which other pieces it hits, not just
yes/no.

## Build steps and placement (user decision)

- **Snap targets** are only pieces visible at the current step (`currentStep`; all pieces when
  no step is selected).
- **Collision** checks every piece in the model, including later steps. A real model can't
  overlap either.
- **New / pasted pieces** go into the current step (or the last step).
- **Moving an existing piece** so it rests on (mates with) a piece from a later step moves it to
  that later step, so it never floats during the build animation. This is part of the same undo
  step.

## Order of delivery (decided)

Three parts, each shippable and tested on its own:

1. **Collision everywhere + connector model.** The shared collision check on every edit
   path, the toggle, and the connector list per part. This alone fixes "pieces go inside other
   pieces".
2. **Placement engine.** Point-and-place from the palette and grab-and-move of built pieces
   with ghost preview, Tab handle cycling, R in hand.
3. **Clipboard and selection.** Copy / cut / paste / clone, LDraw clipboard, box select.

## Constraints

- TypeScript + React + three.js, existing store (`useStudio`), existing plan ops
  (`moveItems`, `addItem`, `insertItem`, `duplicateItems`, `transformPlanItems`). Edits go
  through `st.apply` so undo works.
- Units: LDraw (LDU, Y down) inside snapping code; plan `Grid` is studs / plates up; world is
  studs with Y up and z flipped. Keep conversions in one place.
- Submodel bays: drags already invert each item's placement (`itemPlacement`,
  `viewPlacement`). The new engine must do the same.
- Tests with vitest next to the existing ones (`tests/plan`, `tests/state`, `tests/ui`). The
  engine's pose search and collision rules should be pure functions with unit tests, e.g. "a
  2×4 brick dropped over a 2×4 plate seats on all 8 studs", "E on a plate under a brick
  lands on top of the brick", "arrow into a wall is refused", "1×1 round plate seats on a
  jumper's centre stud" (an existing behaviour that must keep working).
- Performance: build connector and collision data once per gesture, not per mouse move.
  Use a spatial grid or bounding-box prefilter so a few hundred parts stay at full frame rate.
- Work happens on a new branch from `main`. The current branch
  (`feat/timeline-motion-style`) has unrelated uncommitted camera work.

## Left to the builder

- Module layout (e.g. `src/plan/connectors.ts`, `src/plan/placementEngine.ts`,
  `src/plan/collision.ts`) and how the viewport drag code is split.
- Exact thresholds (search radius, hysteresis distance), ghost material and colours
  (follow the existing theme tokens).
- Whether the palette uses HTML drag-and-drop or a pointer-driven placing mode.
- Shortcut hints in the piece menu and toolbar tooltips.
- Help text in the Parts pane head (update it to mention dragging into the view).
