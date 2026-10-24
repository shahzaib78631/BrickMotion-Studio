# Assembly spots implementation notes — 2026-10-24

Specification: `docs/superpowers/specs/2026-10-24-assembly-spots-design.md`. The final **Decisions after builder review** govern the coordinate and caching behaviour.

## Implemented

- Optional, undoable root and per-submodel-use spots in the saved plan. Automatic spots preserve legacy behaviour.
- A full Assembly outliner with status, nested model names, spot fields, undoable actions, and a loose-pieces-follow switch; floor footprint/facing markers (the old viewport chip toolbar has been removed). Drag the marker, use a translation/rotation gizmo, or drop a tile. Marker movement is preview-only until mouse release.
- Main-model follow-on uses one yaw/translation transform after planning, reusing the existing cached timeline; every move endpoint, middle waypoint, relative translation, camera box, focus box, floor box and final matrix is transformed.
- Main-model follow-off transforms the assembled model before planning and leaves the automatic floor layout anchored to the original model bounds.
- Legacy submodel spots can rotate a bay by any yaw; V2 fixed-angle spots are inserted in its staging layout. Automatic bays are laid out after fixed bays.
- The Build viewport compares played timeline final transforms to the *expected transformed source* rather than the old unmoved source; eliminates the regression where moving the whole assembly marked every brick as edited.
- Model readiness is retained through position-only edits, avoiding a disabled timeline/reload cycle; floor drag offsets are converted consistently through the root transformation.
- Overlapping staging footprints are checked in a shared floor frame and presented in Assembly and Checks, with selection of the associated spot. A manual placement is never auto-adjusted.
- Added tests for schema, undo/redo, footprint transforms, both-planner main spots, and intermediate animation poses.

## Construction V2 rotated bays — follow-up implementation

- World-rigid `Slot.pose` replaces position-only staging for V2. Manual bays retain their
  absolute X/Z coordinates and arbitrary yaw; automatic bays retain the old placement.
- Each nested scope is assembled in its parent's actual, potentially rotated bay pose.
  An independently placed child still keeps its own global-world spot and yaw.
- Transfers withdraw in the parent frame, climb into a clear air corridor, rotate the
  **entire rigid group** inside a continuously certified enclosing sphere, then travel
  and lower at the chosen bay; the reverse direction is used for assembly playback.
- Same-orientation translations continue to use continuous triangle-mesh SAT. For
  different orientations the planner conservatively rejects possibly overlapping
  swept boxes rather than overlooking a possible collision. Every operation is then
  replayed against the **actual** staged/assembled orientations.
- The V2 compiler and timeline interpolator carry shared rigid deltas/pivots, so a
  group does not collapse toward its centre or move individual members along chords
  when changing yaw. Camera, floor, and focus boxes respect the rotated bounds.
- Added triangle-mesh tests across many angles, nested rotated bays, the unaffected
  zero-angle case, main-model relocation, timeline/file round-trips, and intermediate
  animation rigidity checks.
- Saved `.brickmotion` timeline matrix references now validate the new rigid deltas,
  base matrix and rotation pivot before loading. Invalid cached animations are skipped.
- Individually dragged waiting pieces now reconnect smoothly to their existing
  waypoint path, including rigid flights. As before, a manually edited waiting
  location does not force a new collision plan: that added first leg is not
  collision-certified, unlike the planner-generated assembly transfer itself.

## In-place assembly, editor placement and viewport organization — follow-up implementation

- **Editor placement follow:** The Assembly pane permanently exposes a separate **Show model at placement in viewport** checkbox. When enabled, the Build editor displays the main model at its dropped/typed assembly spot without rewriting individual brick transforms. Turning this option on switches from timeline-follow to the finished model; further timeline playback still works normally. Dropping a new main spot likewise shows the finished model when this option is enabled. Selection bounds, gizmo editing, Move-tool gestures, lighting, fitting, and camera framing use the same displayed frame; the animation display bypasses this view-only change to avoid applying the timeline transform twice. Undo/redo and plan serialization retain the checkbox.
- **No wasted subassembly flight:** The Standard and Construction V2 planners recognize a manually located submodel whose full rigid staging matrix already equals its final matrix (including vertical position and yaw). Children build in place, and the finished submodel has a stationary attachment segment; it does not lift, turn, or return to the same spot. Matching only X/Z is insufficient—any real vertical or rotational change still requires a flight. Static parts remain collision blockers. Stationary moves serialize through the timeline codec.
- **Simpler viewport:** Removed the assembly-chip strip from the top of the canvas while retaining navigation, the left Assembly outliner, and editable floor markers.
- **Selection groups:** Right-click the selected parts for **Group selected pieces**; grouped clicking picks all members, while Alt-click picks an individual. **Ungroup selected** clears group membership; grouping leaves steps, positions, and the generated animation unchanged. Group labels are saved as optional per-item editorial metadata, scoped to the containing model.
- **Real submodel creation:** Right-click two or more selected top-level pieces and choose **Create submodel from selection…**. A name dialog checks for name conflicts; creation is one undoable edit and moves the picked parts into a newly defined submodel. Their original world poses, IDs, basic step ordering, and compatible build dependencies are preserved. Conflicting external attachment constraints are rejected instead of silently discarded. Double-click the resulting submodel to edit it.
- **Cache safety:** Display preferences and selection groups are excluded from animation planning signatures. Creating a real submodel changes the hierarchy and correctly invalidates planning.

### Focused verification for this follow-up

- Strict TypeScript checking and standalone end-to-end simulation of the Construction V2 geometry/planner/compiler modules passed, including identical spot poses, nonzero vertical differences, and independently rotated bays at 15°, 30°, 45°, 90°, 180° and 270°.
- Standalone group-editing and submodel-creation checks passed, including position preservation and rejection of a dependency cycle. New Vitest regression cases cover editor grouping, submodel conversion, in-place attachment and timeline serialization.
- 212 TypeScript/TSX source/test files passed syntax parsing. **The complete app typecheck, full Vitest suite, production build and live browser interactions remain unverified** because npm registry DNS was unavailable, dependencies were not installed, and the large LDraw asset library is not bundled.

## Submodel placement preview — follow-up correction

- **Fixed the reported mismatch:** The **Show models at build spots in viewport** option now previews the specific submodel use at its own placed build spot, not just the main model. Other automatic or unplaced parts keep their normal positions. The placed geometry follows the spot marker in both X/Z and yaw, with its base touching the common build floor. Source placements are unchanged.
- Every visible instance is assigned the most specific manually placed ancestor's rigid transform, covering nested submodels and multiple uses of one definition. A separate main-model transform is composed when **Loose pieces follow the model** is enabled. The same `fixedBayPose` math as Construction V2 computes the preview, preventing two competing placement conventions.
- Static preview and its picking bounds, selection focus, gizmo gestures, Move tool and camera framing now agree. Timeline playback uses its already planned matrices and is never double-transformed by the editor preview.
- Live marker dragging previews both the footprint and contained bricks without replanning or editing document coordinates until pointer release. Cancelling restores the previous GPU matrices.
- Submodel spot changes are recognized as geometry-preserving edits in `useModel`: no part-library reload or temporary not-ready viewport. A newly dropped spot is read from the **current plan**, not from cached assembly-node hints.
- Added regression tests for dropped submodels, yaw, nested independent/automatic uses, root follow on/off, the stale-metadata edge case, cache reuse, and editing-frame inversion.
- **Separate planning issue:** This changes the editor's finished-model display, not Construction V2's collision oracle. A `no-supported-rigid-route` planner error (such as the one in the supplied screenshot) can still occur when its route cannot be certified. The actual problem plan or LDraw file is needed to reproduce and safely improve that route; no collision checking was bypassed.

### Verification for this correction

- Independent execution of the real placement math passed at 0°, 15°, 30°, 45°, 90°, 180°, 270° and -60°, including nested submodels, correct floor height, root follow on/off, and preview-disabled behaviour.
- Independent execution of the cache-reuse comparator passed for root/nested spot edits and correctly invalidated geometry, attachment-hint and build-order edits.
- Strict TypeScript checking for the Construction V2, assembly-core, and planner-lifecycle test configurations passed.
- All TypeScript and TSX files parsed without syntax errors. A full application typecheck, Vitest suite, production build and live browser interaction remain unverified because npm dependencies / LDraw assets are missing in this environment.

## Verification in this delivery environment

- All 212 source and test TypeScript/TSX files parsed without a syntax diagnostic using the globally installed TypeScript parser.
- Standalone mathematical smoke checks of spot coordinate round-tripping and bounding-box placements passed.
- Additional Construction V2 standalone smoke runs passed for 0°, 15°, 30°, 45°, 90°, 135°, 180°, -45°, 270°, and 360° submodel angles, plus nested independently rotated spots. All 13 geometry/validation cases in the new focused test file ran successfully in an independent minimal assertion harness. Construction-only strict TypeScript checks also pass.
- Automated `npm run typecheck`, Vitest, `npm run build` and interactive browser QA could not run: npm dependencies could not be downloaded because this environment cannot resolve the npm registry; the LDraw assets normally downloaded by `npm run setup` are not included.
- On a machine with network access run `npm ci`, `npm run setup`, `npm run typecheck`, `npm test`, `npm run build` and verify the Assembly interactions in Build and Preview.
