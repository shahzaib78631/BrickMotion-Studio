# Assembly spots: choose where each model is built

Date: 2026-10-24
Status: design, ready to plan

## Why

Before the build starts, every loose piece lies on the floor, but nothing shows where the
model will come together. That applies to the main model and to each submodel (the police car's
"underside 1" and "underside 2" wheel assemblies, for example). Today the spot is fixed:

- **Main model:** both planners build it where its own file puts it (its LDraw origin). The loose
  pieces' floor layout is arranged around that box.
- **Submodels:** the Standard planner (`src/anim/timeline.ts`, `subInfo` / side spots, around
  lines 330–450) puts each one in an automatic side spot to the right of the model. Construction V2
  (`src/anim/construction/planner.ts`, `slots` / `pack()` / `workAreas`, around lines 50–100) packs
  "work bays" to the right of the model.

The user wants to **see and control** these spots: drop an assembly spot onto the viewport, and that
model is built there, facing that direction.

## Goals

1. Each model in the project gets an **assembly spot**: the main model, plus one per submodel use.
   A spot is a floor position plus a facing angle.
2. **Main model spot = where the finished model sits for the whole video.** The camera framing,
   close-ups and hero orbit follow it.
3. **Submodel spot = where that submodel is built** before it is carried over to the main model. The
   carry flight still ends at the submodel's true place on the model.
4. A model without a chosen spot keeps today's automatic placement ("Auto").
5. A configurable switch, on the main model's spot only: **"Loose pieces move with the model"**.
   - On: the whole floor layout moves and turns with the main spot.
   - Off: the loose pieces stay where the automatic layout put them, and only the build spot moves.
   - Default: on (my call, see "Calls made").
6. Spots are saved in the project (`.brickmotion`), so they survive reloads and exports.
7. **Both planners** (Standard and Construction V2) respect the spots.

## Non-goals

- No change to the order pieces are added in, or to the planners' route search, beyond using the
  new positions.
- No tilting of a model. A spot turns only around the vertical axis.
- No free placement in height. Spots sit on the floor.
- No per-piece spots. That already exists as `assembly.floorShift`, set by dragging a waiting piece.

## Anti-goals (failure even if it "works")

- A chosen spot that is silently ignored or moved. If a spot can't be used (for example it overlaps
  the main model or another build area), the planner reports it in **Checks**, naming the model. It
  never quietly falls back to Auto.
- Pieces teleporting, hidden pieces, or pieces passing through each other because of a moved spot.
  All existing collision certification still applies.
- Breaking existing projects. Projects without spots must plan and look exactly as they do today.

## What the user sees

### 1. A new "Assembly" tab in the left rail

It goes next to Parts in `src/App.tsx` (`Tab` union and rail list) and is laid out like
`PartsPanel.tsx`:

- **A pane header** (`PaneHead`, id `assembly`) with help text that explains dragging a tile onto
  the floor.
- **One tile per model:** the main model first, then each submodel use, in build order. A tile shows:
  - a thumbnail (reuse the model thumbnail used by the Models panel if one exists; otherwise the icon)
  - the name, for example "Main model" or "police car – underside 1"
  - a status line: "Auto", or the spot as "X 12 · Z −4 studs · 90°"
- **Tiles are draggable** onto the viewport, using a new drag type like `PART_DRAG_TYPE`
  (`src/ui/PartsLane.tsx`). Clicking a tile selects that spot.
- **Detail fields** for the selected tile:
  - X and Z in studs (number inputs)
  - facing angle in degrees (number input, 15° steps with the arrow keys)
  - a "Reset to auto" button
  - main model only: the "Loose pieces move with the model" switch
- The panel and the viewport stay in sync both ways.

### 2. An assembly toolbar in the viewport

It appears in Build view only, as a compact strip over the viewport. It holds the same chips as the
panel (name and Auto/placed state). The chips can be dragged onto the floor. It's a shortcut: same
data, same behaviour as the panel tiles.

### 3. Spot markers on the floor

They appear in Build view only, rendered in `src/ui/Viewport.tsx`.

- Each **placed** spot shows a flat outline of that model's finished footprint, sized from its
  assembled bounding box and turned to its facing. An arrow shows the facing direction, and the model
  name sits on a small label.
- **Auto** spots are not drawn, or are drawn faint and dashed (builder's choice). They become solid
  once placed.
- **Dropping** a tile or chip on the floor raycasts to the floor plane and snaps to the stud grid. The
  facing becomes 0° on the first drop and is kept on later drops.
- **Selecting** a marker selects its tile in the Assembly panel.
- **Moving** a selected marker: drag it, or use the existing gizmo in translate mode, restricted to
  X/Z.
- **Rotating** a selected marker: use the gizmo's rotate mode around Y only, in 15° snaps with Shift
  for free rotation (the same rules as the piece gizmo after the recent fix).
- **Right-clicking** a marker gives "Reset to auto".
- Markers are **not** shown in Preview or in exported video.

### 4. Video result

The planned timeline uses the spots:

- **Main spot:** the whole assembled model, its final pose, the camera's `modelBox`, close-ups and
  hero orbit all sit at the spot. The loose pieces follow it only if the switch is on.
- **Submodel spot:** that submodel's build happens at its spot. Its floor pieces are laid out around
  that spot (the same rule as today's side spots). Then the finished submodel flies to its place on
  the main model, which is itself at the main spot.

## Data model

All spots live in the plan, next to the existing `assembly.floorShift` precedent
(`src/plan/types.ts`, `src/plan/schema.ts`, `src/plan/pieceActions.ts`):

```ts
/** Floor position in studs (x, z) and facing in degrees about the vertical axis. */
export type AssemblySpot = { x: number; z: number; angle: number };

// Plan (main model)
assemblySpot?: AssemblySpot;
/** default true: loose pieces move and turn with the main spot */
loosePiecesFollow?: boolean;

// AssemblyHints, on a SubItem (one submodel use)
buildSpot?: AssemblySpot;
```

- The spot coordinates are the **centre of the model's footprint on the floor**, in the main model's
  world frame (studs; 1 stud = 20 LDU), measured from where Auto would place it today. So
  `{x:0, z:0, angle:0}` on the main model means "unchanged".
- **Per submodel use, not per submodel name** (my call): the same submodel used twice can be built
  in two places. Spots go on the `SubItem.assembly` hints, like `floorShift`.
- Optional fields only. No schema version bump is needed. Old files load unchanged, and the zod
  schema accepts the new optional keys.
- Editing goes through store actions, like the existing piece actions (undoable), for example
  `setAssemblySpot(target, spot | null)` and `setLoosePiecesFollow(bool)`.

## How the planners use it

The cleanest approach (my call; the builder may refine it) is to treat the main spot as one rigid
transform `S` (a turn about Y, then a move on the floor), applied consistently:

1. **Main spot.** Apply `S` to every final pose when the timeline is built, before either planner
   runs. The planners then see a model that already sits at the spot, so their own layout,
   collision and camera code needs no special cases.
   - With "loose pieces follow" **on**, the floor layout is computed in the model's own frame as
     today, and the whole floor is then transformed by `S`.
   - With it **off**, the floor layout is computed for the untransformed model and left in place.
     The planner must then check that the moved model doesn't overlap the floor pieces or bays. If
     it does, it reports a Check that names the main model.
2. **Submodel spots.**
   - **Standard planner:** replace the automatic side spot (`spot` / `from` in the subInfo block)
     with the chosen spot when one is set. The submodel's floor bands are then placed around it,
     using the existing `bandsAround` logic.
   - **Construction V2:** when a group node's submodel use has a `buildSpot`, set its `slots` entry
     from the spot instead of from `pack()`, and pack the remaining bays around the fixed ones.
   - If the spot overlaps the main model or another bay, report a Check (not a silent move).
3. **Camera.** No new logic: it frames `modelBox` and `subBuilds[].focus`, which now sit at the
   spots.
4. **Caching and regeneration.** Spots are part of the plan, so changing one re-plans the timeline
   through the existing `timelineService` path. Dragging a marker should only re-plan on drop, not
   on every mouse move.

## Testing

- **Unit (plan):** reading and writing spots, schema round trip, old files without spots unchanged,
  and undo/redo of spot edits.
- **Timeline, police car fixture** (`tests/fixtures/models/police-car.brickmotion`):
  - With a main spot `{x: 10, z: -5, angle: 90}`, every piece's final pose equals the original final
    pose transformed by `S`, and the camera's `modelBox` moves the same way.
  - The same check holds for both planners (`legacy` and `construction-v2`).
  - With "loose pieces follow" off, the floor pieces' start poses equal the no-spot run's.
  - With a `buildSpot` on "underside 1", that submodel's pieces land at the spot during its build,
    and its final poses are unchanged.
  - An overlapping spot produces a Check naming the model. The spot is not moved.
- **No-spot regression:** the existing timeline and police-car tests pass unchanged.
- **UI check in the browser pane:**
  - Drag a tile onto the floor and a marker appears.
  - Rotate it and the readout shows 15° steps.
  - "Reset to auto" removes the marker.
  - After playing the video, the car is built at the marker.

## Decisions after builder review (these override anything above that conflicts)

1. **When the main spot is applied.**
   - **Loose pieces follow ON (default): after planning, as one rigid transform `S`.** Plan exactly
     as today, with no spot. Then multiply every pose in the resulting timeline by `S`: final poses,
     floor/staging poses, flight paths, `floorShift` results, `modelBox`, `buildBox`, `subBuilds`
     focus boxes and camera keys. This works the same way as `applyFloorShifts`. The main spot is
     not part of the planning cache key in this mode, so changing it re-applies `S` without
     re-planning. Any angle works, because the whole scene turns rigidly.
   - **Loose pieces follow OFF: before planning.** The model's final poses are moved by `S` and the
     planner runs. The floor layout must still be computed around the **unmoved** model's box: pass
     that box to the layout code as the area to lay out around, and keep the moved model as the
     real obstacle. In this mode the spot is part of the cache key. Bounding boxes of a model turned
     by an angle that isn't a multiple of 90° may be loose; that's acceptable.
2. **Angles:** any angle is allowed. The UI snaps to 15° and Shift frees it. Store degrees as a
   number.
3. **Spot coordinates are absolute, not relative to Auto.** This replaces "relative to Auto" above.
   - `assemblySpot`: the floor position (studs, x/z) of the main model's footprint centre, plus its
     angle. The reference is the model's own unmoved frame, so `{x: c.x, z: c.z, angle: 0}`, where
     `c` is the footprint centre of the unmoved model, means "unchanged". On first drop, store the
     drop point. "Auto" means the field is absent.
   - `buildSpot`: the absolute floor position (studs) of the submodel's footprint centre and its
     angle about Y, **in the main model's own (unmoved) frame**. So when the main spot moves with
     follow ON, the submodel spots move and turn with it (they are post-transformed by `S` like
     everything else). The angle is relative to the submodel's natural build orientation (Standard:
     `naturalBasis(to)`; V2: the bay orientation, which is unrotated).
   - **Auto positions** for markers come from the latest planned timeline (`subBuilds[].focus`
     centre, `modelBox` centre). Until a timeline exists, Auto spots draw no marker and the tile
     says "Auto".
   - **A placed spot never moves** because another spot moved. Planners lay automatic bays around
     the fixed ones.
4. **Spot that can't be used** (it overlaps the main model, another placed spot, or a bay):
   - The video **still plans with the spot as given**. Every route is still collision-checked as
     today. If that makes planning fail, the usual planner error shows, as it does now.
   - The overlap is found **statically in the UI from bounding boxes** (the model's assembled box
     at its spot vs the others). It's listed in the Assembly panel on the affected tile and as a
     Checks entry: add an `assembly-spot` kind to the warnings shown by `ChecksPanel`, computed on
     the main thread. No new channel from the worker is needed.
5. **Nested submodel uses:** one spot per `SubItem`, applied to every use of its parent (the same
   rule as `floorShift`). The panel lists one tile per `SubItem` that is a submodel use, under its
   parent's name.
6. **Animating or exporting a submodel on its own:** the main spot and follow switch apply only
   when the target is the root model. A submodel rendered alone is built at its origin as today,
   and its nested `buildSpot`s still apply. `scopedPlan` must carry the nested `buildSpot` hints and
   should not carry `assemblySpot` into a submodel target.
7. **Dragged pieces (`floorShift`):** with follow ON they move and turn with `S`, like everything
   else. With follow OFF they stay where they are, and they count as floor pieces in the static
   overlap check.

## Calls made (not discussed; easy to change)

- "Loose pieces move with the model" defaults to **on**.
- Spots are stored **per submodel use** (`SubItem.assembly.buildSpot`), not per submodel name.
- Spot coordinates are **studs relative to the Auto position**, with the angle in degrees about Y.
- The main spot is applied as a **rigid transform before planning**, so the planners stay mostly
  unchanged.
- Auto spots are hidden or faint (builder's choice). Markers never render in Preview or export.
- Re-planning happens **on drop/commit**, not continuously while dragging.

## Left to the builder

- The exact visuals of markers and chips, which must match the existing polish in `src/ui/app.css`.
- Whether the toolbar strip sits top-left or along the bottom of the viewport.
- Thumbnails for model tiles, if an existing helper fits.
