# BrickMotion Desktop — Milestone 3 (Editing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rust app becomes a model editor:
- Keyboard edits: nudge, raise/lower, turn, clone, duplicate, copy/cut/paste.
- Move and Rotate gizmos in the viewport, world or local axes.
- Colour swatches: recolour the selection, choose the colour for new parts.
- The parts Library with rendered previews, and the model's Parts list.
- Placement: pick a library part, see it snap under the pointer, click to place.
- Replace Part.
- The Steps tab: step list, step items, step menu and step editor.

**Architecture:**
- **Engine:** `bmapp` is not changed. Everything M3 needs already exists:
  - `Session`: `move`, `rotate`, `recolor`, `duplicate`, `replacePart`, `copy`, `paste`, `endGesture`, `axesOf`, `placePartBefore`, the step calls (`steps`, `stepItems`, `piecesOfStep`, `insertStep`, `deleteStep`, `moveStep`, `splitStep`, `mergeSteps`, `setStepFields`, `moveToStep`, `reorderInStep`);
  - `Viewport`: `camera`, `selectionCenter`, `previewPart`, `placementPreview`, `clearPlacementPreview`, `showRest`;
  - `gizmo.h` (`gizmoShape`, `hitGizmo`, `handleAxis`, `dragMove`, `dragRotate`, `projectPoint`), `keys.h` (`arrowAxis`, `kStud`, `kPlate`, `kBrick`);
  - `part_catalog.h` (`libraryParts`, `partCategories`, `commonParts`) and `part_preview.h` (`PartPreview`).
- **bmffi** grows four ABI groups (edits+camera, gizmo, library+previews, placement, steps), each in its own source file, all following M2's conventions (guards, `BmChange`, list handles, two-call arrays, `bm_struct_size`).
- **bm** wraps them safely: `geom.rs`, `gizmo.rs`, `library.rs`, `placement.rs`, `steps.rs`.
- **brickmotion** gets an `EditState` (tool, axes, collision, colour, chosen step, placement) owned by the app and lent to the viewport each frame. The gizmo is drawn with egui's painter over the viewport texture. The placement controller and gizmo drag are small state machines with headless tests. Part previews render on one worker thread that owns the engine's `PartPreview`.

**Tech Stack:** As M2, plus `arboard` 3 (clipboard; the spec lists it).

**Spec:** `docs/superpowers/specs/2026-11-25-rust-egui-app-design.md`, milestone 3:
> "Editing: parts library + previews, placement, gizmo, recolour, steps."

Reference for behaviour: the parity ledger `docs/superpowers/specs/2026-11-19-native-app-parity.md` §3 (parts and colours), §4 (tools, mouse), §5 (editing), §6 (steps), and the Swift app it describes (`native/app/BrickMotion/EditCommands.swift`, `ViewportView.swift` gizmo code, `PlacementController.swift`, `PartsHistory.swift`, `ColorSwatches.swift`, `StepEditor.swift`). Match the Swift app's behaviour; do not copy its logic into Rust where the engine already has it.

Builds on branch `feat/desktop-m1` at `42485c38` (M2 plus the M1/M2 deferred fixes). Rulings so far: `desktop/docs/m2-rulings.md`.

## Global Constraints

- Everything in M1's and M2's Global Constraints still holds: the stack; the Swift app frozen with `ctest --test-dir native/build-app` 619/619; no SolidCraft assets; calm UI (one stroke-icon family, blue `#4f8cff` accent, orange only for the playhead, 8-px grid, 12.5-pt text, two weights); bundle id `com.brickmotion.studio.rs`; stage named files only, never `git add -A`; no commits on `main`; only `.brickmotion` is ever written; tests never touch the real support folder (`new_for_test` / `new_for_test_cc`, `Support::at(temp)`).
- **No engine edits.** Only `desktop/` changes. If a task finds a `bmapp` call missing or wrong, it writes `Ruling: needs engine change <what>` in the ledger and leaves that behaviour out. It never re-implements engine logic in Rust.
- **Every edit is one engine command and one undo step.** A drag (gizmo, step-title typing) passes `continuing = true` after its first call and ends with `Session::end_gesture()`, so the whole gesture is one undo step. Every command goes through `commands::run` (blocked while "Save changes?" is up).
- **The session stays single-threaded.** `bm::Session` is not `Sync`; nothing but the UI thread touches the app's document. `PartPreview` lives on its own worker thread and never sees a session.
- **Points are from the top left of the view**, in points (not pixels), for every gizmo, pick and placement call. egui's coordinates already are; subtract the viewport rect's top-left. Never flip y.
- **Units:** LDU. `STUD = 20`, `PLATE = 8`, `BRICK = 24`. −y is up.
- **Shortcuts match the Swift app** (`EditCommands.swift:editKey`) where the M2 registry has no clash:

  | Command | Key | Swift |
  |---|---|---|
  | Select tool | V | V |
  | Move tool | M | M |
  | Turn 90° clockwise / anticlockwise | R / ⇧R | R / ⇧R |
  | Clone in place | C | C |
  | Raise / lower one plate (⌥: one brick) | E / Q | E / Q |
  | Nudge one stud along the view | ← → ↑ ↓ | arrows |
  | Local axes on/off | L | L |
  | Collision checks on/off | K | K |
  | Duplicate (offset one stud) | ⌘D | menu |
  | Copy / Cut / Paste | ⌘C / ⌘X / ⌘V | menu |
  | Add Part (opens Library search) | P | — |

  - M2's registry had Recolour on C; C becomes Clone (Swift), and Recolour has no key.
  - H stays Home View (M2 ruling); Hide stays a menu/palette command.
  - Single-key shortcuts fire only while no text field has focus (M2's rule). While placing, Tab, ⇧Tab, R, Return and Esc belong to the placement, before the registry.
- **Colour for new parts** starts at 71 (Light Bluish Grey, the engine's `PlacementInput` default).
- **History** (recent and frequent parts, recent colours) is stored in the support folder as `history.toml`, with the Swift rules: parts list newest first, at most 96 entries, a count per part capped at 10 000; Recent = first 8; Frequent = count > 1, by count then recency, first 8; recent colours = 8, newest first, no repeats.

## Review Focus

1. **The model changes under a live placement** (undo, a finished background load, an edit from the menu while the preview follows the pointer): the placement cancels and never commits a stale pose; the engine's generation/version check is the backstop. Test: Task 9 `placement_cancels_when_the_model_changes`.
2. **A gizmo drag is one undo step**, however many frames it spans, for move and rotate; releasing outside the viewport still ends the gesture. Test: Task 4 `gizmo_drag_is_one_undo_step`.
3. **Single-key shortcuts while typing** in the Library search, the swatch search or a step title: P, M, C, E, Q, R, V, L, K and the arrows type text and do nothing else. Test: Task 2 `typing_does_not_edit`, extended in Task 7 and Task 11.
4. **A big library list** (a category or search returning thousands of parts): only tiles on screen request previews; scrolled-away requests are dropped before they render; a frame stays under 16 ms. Test: Task 7 `library_requests_only_visible_previews`.
5. **An edit the engine refuses** (empty selection, a turn or move that collides, a split that would empty a step): nothing changes, the version is unchanged, and one notice says the engine's reason. Test: Task 2 `refused_edit_shows_reason_and_changes_nothing`.

---

## File Structure

```
desktop/bmffi/include/bmffi.h            (modify) M3 ABI, grouped by section
desktop/bmffi/src/edit.cpp               (create) edits, camera, arrow axis, gizmo
desktop/bmffi/src/library.cpp            (create) catalog lists, part previews, pictures
desktop/bmffi/src/placement.cpp          (create) placement preview + commit
desktop/bmffi/src/steps.cpp              (create) step lists and step edits
desktop/bmffi/src/lists.cpp              (modify) bm_struct_size learns the new structs
desktop/bmffi/tests/edit_test.cpp, library_test.cpp, placement_test.cpp, steps_test.cpp (create)
desktop/bmffi/CMakeLists.txt             (modify) new sources and tests
desktop/crates/bm-sys/src/lib.rs         (modify) mirrors + DECLARED
desktop/crates/bm/src/geom.rs            (create) Vec2, Vec3, Mat3, Pose, Camera, Arrow, units, arrow_axis
desktop/crates/bm/src/gizmo.rs           (create) GizmoShape, Handle, drag maths
desktop/crates/bm/src/library.rs         (create) PartMatch, catalog calls, PartPreview
desktop/crates/bm/src/placement.rs       (create) PlacementInput, PlacementPreview, PlacementState
desktop/crates/bm/src/steps.rs           (create) StepRow, ItemRow, StepFields
desktop/crates/bm/src/session.rs, viewport.rs, lib.rs (modify)
desktop/crates/bm/tests/edit.rs, library.rs, placement.rs, steps.rs (create)
desktop/crates/brickmotion/src/
  edit.rs              EditState, Tool; the keyboard edits behind the registry
  gizmo.rs             GizmoDrag (pure), drawing and input over the viewport
  history.rs           PartsHistory + recent colours in history.toml
  previews.rs          preview worker + texture cache
  placement.rs         Placement controller and its HUD
  chrome/swatches.rs   colour popover
  chrome/library.rs    Library tab (Common / Frequent / Recent, categories, search, tiles)
  chrome/parts.rs      Parts tab (what this model uses)
  chrome/steps.rs      Steps tab, step menu, step editor popover
  chrome/replace.rs    Replace Part sheet
  commands.rs, shortcuts.rs, menubar.rs, app.rs, viewport.rs, chrome/browser.rs, chrome/properties.rs (modify)
desktop/crates/brickmotion/tests/edit.rs, gizmo.rs, library.rs, placement.rs, steps.rs (create)
```

Header count: `crates/bm/tests/render.rs::header_and_rust_decls_agree` asserts the number of `BMFFI_API` functions (63 at the start). Each ABI task raises that literal by the number it adds (stated in the task); the test also checks each one's parameter count against bm-sys.

---

### Task 1: Edit ABI and wrappers

**Files:**
- Modify: `desktop/bmffi/include/bmffi.h`, `desktop/bmffi/src/lists.cpp`, `desktop/bmffi/CMakeLists.txt`
- Create: `desktop/bmffi/src/edit.cpp`, `desktop/bmffi/tests/edit_test.cpp`
- Modify: `desktop/crates/bm-sys/src/lib.rs`, `desktop/crates/bm/src/{session.rs,viewport.rs,lib.rs}`
- Create: `desktop/crates/bm/src/geom.rs`, `desktop/crates/bm/tests/edit.rs`

**Interfaces:**
- Produces (C, 12 functions; header count 63 → 75):
  - `typedef struct { double x, y; } BmVec2; typedef struct { double x, y, z; } BmVec3; typedef struct { double m[9]; } BmMat3;` (row-major, as `bmapp::Mat3`)
  - `typedef struct { double yaw, pitch, distance; BmVec3 target; bool orthographic; double vertical_fov; } BmCamera;`
  - `typedef enum { BM_ARROW_LEFT, BM_ARROW_RIGHT, BM_ARROW_UP, BM_ARROW_DOWN } BmArrow;`
  - `BmChange bm_session_move(BmSession*, const uint32_t* pieces, size_t n, BmVec3 delta, bool continuing)`
  - `BmChange bm_session_rotate(BmSession*, const uint32_t*, size_t, BmVec3 axis, double degrees, BmVec3 pivot, bool continuing)`
  - `BmChange bm_session_recolor(BmSession*, const uint32_t*, size_t, int32_t code)`
  - `BmChange bm_session_duplicate(BmSession*, const uint32_t*, size_t, BmVec3 offset)`
  - `BmChange bm_session_replace_part(BmSession*, const uint32_t*, size_t, const char* part)`
  - `void bm_session_end_gesture(BmSession*)`
  - `BmMat3 bm_session_axes_of(const BmSession*, uint32_t piece)`
  - `BmString bm_session_copy(const BmSession*, const uint32_t*, size_t)`
  - `BmChange bm_session_paste(BmSession*, const char* ldraw_text, BmVec3 offset)`
  - `BmCamera bm_viewport_camera(const BmViewport*)`
  - `BmVec3 bm_viewport_selection_center(BmViewport*)`
  - `BmVec3 bm_arrow_axis(BmCamera, BmArrow)`
  - `bm_struct_size` learns `"BmVec2" "BmVec3" "BmMat3" "BmCamera"`.
- Produces (Rust):
  - `bm::geom`: `Vec2 { x, y: f64 }`, `Vec3 { x, y, z: f64 }` (both `Copy, Default, PartialEq, Debug`), `Mat3 { m: [f64; 9] }` with `Default` = identity, `Pose { rotation: Mat3, position: Vec3 }`, `Camera { yaw, pitch, distance: f64, target: Vec3, orthographic: bool, vertical_fov: f64 }`, `enum Arrow { Left, Right, Up, Down }`, `pub const STUD: f64 = 20.0; PLATE = 8.0; BRICK = 24.0`, `pub fn arrow_axis(camera: &Camera, arrow: Arrow) -> Vec3`. Re-exported from `bm`.
  - On `Session` (all `&self`, as M2's edits): `translate(&self, pieces: &[u32], delta: Vec3, continuing: bool) -> Changed` (`move` is a keyword), `rotate(&self, pieces, axis: Vec3, degrees: f64, pivot: Vec3, continuing: bool) -> Changed`, `recolor(&self, pieces, code: i32) -> Changed`, `duplicate(&self, pieces, offset: Vec3) -> Changed`, `replace_part(&self, pieces, part: &str) -> Changed`, `end_gesture(&self)`, `axes_of(&self, piece: u32) -> Mat3`, `copy(&self, pieces) -> String`, `paste(&self, text: &str, offset: Vec3) -> Changed`.
  - On `Viewport`: `camera(&self) -> Camera`, `selection_center(&mut self) -> Vec3`.
- Consumes: M2's `BmChange`/`take_change`, `guard`, `make`, `change()` helper in `bmffi.cpp` (move it to `internal.h` so `edit.cpp` can use it).

- [ ] **Step 1: Write the failing C tests** in `edit_test.cpp` (helicopter, as `document_test.cpp`'s `openHeli`):
  - `"move is one undo step and moves nothing else"`: select piece 0's version `v`; `bm_session_move({0}, {20,0,0}, false)` → `refused.len == 0`, `structure == false`, version > v; undo restores version-equivalent state (`can_redo`).
  - `"a continuing move joins the previous step"`: move {0} by x 20 (false), then by x 20 (true), `end_gesture`; one `undo` leaves `can_undo == false`.
  - `"rotate, recolor, duplicate, replace"`: rotate {0} about y 90° at its `axes_of` origin pivot → ok; recolor {0} to 4 → ok; duplicate {0} with offset {20,0,0} → piece count +1; `replace_part({0}, "3001.dat")` → ok.
  - `"recolor of nothing is refused"`: `recolor(nullptr, 0, 4)` → `refused.len > 0`, version unchanged.
  - `"copy then paste adds the pieces"`: `copy({0,1})` non-empty and contains `"1 "`; `paste(text, {0,0,0})` → piece count +2.
  - `"camera and arrow axis"`: with a viewport, `bm_viewport_camera` distance > 0; `bm_arrow_axis(cam, BM_ARROW_RIGHT)` has `y == 0` and unit length on x or z.
  - `"struct sizes"` extended for the four new names.
- [ ] **Step 2:** `cd native/build-rust && ninja bmffi_tests && ./bmffi/bmffi_tests`. Expected: compile FAIL (`bm_session_move` undeclared).
- [ ] **Step 3:** Implement in `edit.cpp` over the `bmapp` calls named above; add the source and test to `desktop/bmffi/CMakeLists.txt`. `bm_session_paste` with a null or empty text returns a refused change ("nothing to paste").
- [ ] **Step 4:** Same command. Expected: all bmffi cases pass. `nm -gU bmffi/libbmffi.dylib | grep -vc ' _bm_'` → `0`.
- [ ] **Step 5: Write the failing Rust tests** in `crates/bm/tests/edit.rs`:
  - `translate_then_continuing_is_one_undo`: as the C case, through `Session`.
  - `recolor_changes_the_snapshot_colour`: select {0}, `recolor(&[0], 4)`, `snapshot().selected[0].color == 4`.
  - `copy_paste_round_trip`: piece count +n.
  - `arrow_axis_lies_on_the_floor`: `arrow_axis(&cam, Arrow::Up).y == 0.0`.
  - Raise the header count literal to 75.
- [ ] **Step 6:** `cd desktop && cargo test -p bm`. Expected: FAIL to compile (no `translate`). Implement the wrappers and `geom.rs`; re-run. Expected: PASS, including `header_and_rust_decls_agree`.
- [ ] **Step 7: Commit.** Stage the files above by name. Message: `feat(desktop): edit ABI (move, rotate, recolour, duplicate, replace, clipboard, camera)`.

### Task 2: Keyboard and menu edits

**Files:**
- Create: `desktop/crates/brickmotion/src/edit.rs`, `desktop/crates/brickmotion/tests/edit.rs`
- Modify: `commands.rs`, `shortcuts.rs`, `app.rs`, `lib.rs`, `menubar.rs` (Edit menu gains the new items), `Cargo.toml` (`arboard = "3"`)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `pub enum Tool { Select, Move, Rotate }` and `pub struct EditState { pub tool: Tool, pub local_axes: bool, pub collision: bool, pub colour: i32, pub step: Option<usize> }` (Default: Select, false, true, 71, None), field `pub edit: EditState` on the app. Later tasks add `placement`.
  - `edit::nudge(app, delta: Vec3)`, `edit::nudge_along(app, Arrow)` (`arrow_axis × STUD`, y = 0), `edit::turn(app, clockwise: bool)` (axis +y, ±90°, pivot = `viewport.selection_center()`; −y is up, so +90 about +y is clockwise seen from above), `edit::clone(app)` (duplicate, offset 0), `edit::duplicate(app)` (offset x = STUD), `edit::copy/cut/paste(app)` (arboard text; paste offset 0). Each goes through one helper `edit::selection_edit(app, f: impl FnOnce(&Session, &[u32]) -> Changed)` that calls `app.edited(c)` (M2's notice-on-refusal path).
  - Registry entries (ids are new unless noted; `When` in brackets): `tool.select` V [Document], `model.move` M → Move tool [Document] (was Soon), `model.rotate_tool` "Rotate Tool" no key [Document], `model.rotate` R "Turn" [Selection] (was Soon), `model.rotate_back` ⇧R "Turn Back" [Selection], `edit.clone` C [Selection], `model.duplicate` ⌘D [Selection] (was Soon), `edit.raise` E, `edit.lower` Q, `edit.nudge_left/right/up/down` ← → ↑ ↓ [Selection], `edit.copy` ⌘C [Selection], `edit.cut` ⌘X [Selection], `edit.paste` ⌘V [Document], `view.local_axes` L [Document], `edit.collision` K [Document], `model.recolour` loses C.
  - `Shortcut::parse` learns `←→↑↓` (egui `ArrowLeft…`) and `⌥` held for `edit.raise/lower` (one brick instead of one plate: the handler reads `i.modifiers.alt`, the registry key stays E/Q).
  - Title of `view.local_axes` and `edit.collision` shows state: "Local Axes" / "World Axes", "Collision Checks On/Off" (via M2's `title(c, ctx)`; `Ctx` gains `local_axes: bool, collision: bool, tool: Tool`).

- [ ] **Step 1: Write the failing tests** in `tests/edit.rs` (window-less `heli_app()` as `tests/commands.rs`):
  - `nudge_moves_one_stud_and_is_one_undo`: select {0}; `run("edit.nudge_right")`; `can_undo`, undo name non-empty; one `edit.undo` restores the version-equivalent state.
  - `raise_moves_up_one_plate`: select {0}; read y as the 4th whitespace field of `session.copy(&[0])` (an LDraw type-1 line: `1 colour x y z …`); `run("edit.raise")` → y is 8 less. With ⌥ held (harness key event with `alt`) → 24 less.
  - `turn_needs_a_selection`: nothing selected → `run("model.rotate")` returns false.
  - `clone_adds_one_piece_in_place`: count +1, the new piece selected.
  - `copy_paste_through_clipboard`: `#[ignore]` unless `BM_CLIPBOARD=1` (CI has no pasteboard); count +n.
  - `refused_edit_shows_reason_and_changes_nothing` (Review Focus 5): select a piece, run an edit the engine refuses (`edit::selection_edit` with `replace_part("no-such-part.dat")`) → version unchanged, exactly one `Notice::Warning` whose detail is the engine's reason.
  - `typing_does_not_edit` (Review Focus 3): harness, focus the Browser filter, type `"pmceqrvlk"` and press ←; version unchanged, tool still Select, filter text is `"pmceqrvlk"`.
  - `registry_keys_unique` (M2's test) still passes with the new keys.
- [ ] **Step 2:** `cargo test -p brickmotion --test edit`. Expected: compile FAIL.
- [ ] **Step 3:** Implement `edit.rs`, the registry entries, `Ctx` fields and `execute` arms; menu items for Copy/Cut/Paste/Duplicate/Clone/Turn under Edit.
- [ ] **Step 4:** `cargo test --workspace`. Expected: all pass (M2's suites included). `cargo clippy --workspace --all-targets` → 0 warnings.
- [ ] **Step 5: Commit.** `feat(desktop): keyboard and menu edits (nudge, raise, turn, clone, duplicate, clipboard)`.

### Task 3: Gizmo ABI and wrappers

**Files:**
- Modify: `bmffi.h`, `edit.cpp`, `lists.cpp`, `edit_test.cpp`, `bm-sys/src/lib.rs`, `bm/src/lib.rs`
- Create: `desktop/crates/bm/src/gizmo.rs`, tests appended to `crates/bm/tests/edit.rs`

**Interfaces:**
- Produces (C, 12 functions; header count 75 → 87):
  - `typedef enum { BM_GIZMO_MOVE = 1, BM_GIZMO_ROTATE = 2 } BmGizmoKind;`
  - `typedef enum { BM_HANDLE_NONE, BM_HANDLE_X, BM_HANDLE_Y, BM_HANDLE_Z, BM_HANDLE_XY, BM_HANDLE_YZ, BM_HANDLE_XZ, BM_HANDLE_VIEW } BmHandle;` (same order as `bmapp::Handle`)
  - `typedef struct BmGizmo BmGizmo;` owning a `bmapp::GizmoShape`
  - `BmGizmo* bm_gizmo_shape(BmCamera, BmVec2 view_points, BmVec3 origin, BmMat3 axes, BmGizmoKind)`, `void bm_gizmo_free(BmGizmo*)`
  - `size_t bm_gizmo_line_len(const BmGizmo*)`, `void bm_gizmo_line(const BmGizmo*, size_t i, BmVec2* a, BmVec2* b, BmHandle* h)`
  - `size_t bm_gizmo_ring_len(const BmGizmo*)`, `BmHandle bm_gizmo_ring_handle(const BmGizmo*, size_t i)`, `size_t bm_gizmo_ring(const BmGizmo*, size_t i, BmVec2* out, size_t cap)` (two-call)
  - `BmHandle bm_gizmo_hit(const BmGizmo*, BmVec2 point, double tolerance)`
  - `BmVec3 bm_handle_axis(BmCamera, BmMat3 axes, BmHandle)`
  - `BmVec3 bm_drag_move(BmCamera, BmVec2 view, BmVec3 origin, BmMat3 axes, BmHandle, BmVec2 a, BmVec2 b, BmVec3 snap)`
  - `double bm_drag_rotate(BmCamera, BmVec2 view, BmVec3 origin, BmMat3 axes, BmHandle, BmVec2 a, BmVec2 b, bool free)`
  - `bool bm_project_point(BmCamera, BmVec2 view, BmVec3 p, BmVec2* out)` (false when behind the eye: `projectPoint` gave NaN)
- Produces (Rust `bm::gizmo`): `enum GizmoKind { Move, Rotate }`, `enum Handle { None, X, Y, Z, XY, YZ, XZ, View }`, `struct GizmoShape { pub lines: Vec<(Vec2, Vec2, Handle)>, pub rings: Vec<(Vec<Vec2>, Handle)>, raw }` with `GizmoShape::new(camera: &Camera, view: Vec2, origin: Vec3, axes: Mat3, kind: GizmoKind) -> GizmoShape`, `hit(&self, p: Vec2, tolerance: f64) -> Handle`, `Drop`; free functions `handle_axis(&Camera, Mat3, Handle) -> Vec3`, `drag_move(&Camera, view: Vec2, origin: Vec3, axes: Mat3, Handle, a: Vec2, b: Vec2, snap: Vec3) -> Vec3`, `drag_rotate(&Camera, Vec2, Vec3, Mat3, Handle, a: Vec2, b: Vec2, free: bool) -> f64`, `project(&Camera, view: Vec2, p: Vec3) -> Option<Vec2>`.

- [ ] **Step 1: Failing tests.** C (`edit_test.cpp`): `"move gizmo has three axes and three planes"` (`line_len == 3`, `ring_len == 3`, ring handles are XY/YZ/XZ in some order); `"rotate gizmo rings"` (`ring_len >= 3`, includes `BM_HANDLE_VIEW`); `"hit at an axis tip"` (hit at line 0's `b` with tolerance 6 → that line's handle; hit at (−1000,−1000) → NONE); `"drag along x snaps to studs"` (`bm_drag_move` along the X line by its own screen vector → `|x|` a multiple of 20, y = z = 0). Rust (`tests/edit.rs`): `gizmo_hit_matches_line_handle`, `rotate_drag_snaps_to_15_degrees` (a quarter-circle drag on the Y ring with `free = false` → result % 15 == 0).
- [ ] **Step 2:** Run bmffi and `cargo test -p bm --test edit`. Expected: compile FAIL.
- [ ] **Step 3:** Implement (C in `edit.cpp`; Rust `gizmo.rs`); header literal → 87.
- [ ] **Step 4:** Both suites pass; exports check `0`.
- [ ] **Step 5: Commit.** `feat(desktop): gizmo ABI (shape, hit, drag maths, projection)`.

### Task 4: Gizmo in the viewport

**Files:**
- Create: `desktop/crates/brickmotion/src/gizmo.rs`, `desktop/crates/brickmotion/tests/gizmo.rs`
- Modify: `viewport.rs` (`ViewportWidget::show(&mut self, ui, doc, edit: &mut EditState)`), `app.rs`, `chrome/viewbar.rs` (tool buttons Select / Move / Rotate, active one highlighted), `commands.rs`

**Interfaces:**
- Consumes: Task 2 `EditState`/`Tool`, Task 3 `bm::gizmo`.
- Produces:
  - `pub struct GizmoDrag { pub handle: Handle, pub start: Vec2, pub origin: Vec3, pub axes: Mat3, pub pieces: Vec<u32>, moved: Vec3, turned: f64 }` with `GizmoDrag::step_move(&mut self, total: Vec3) -> Option<Vec3>` (returns `total − moved` when non-zero and records `total`) and `step_rotate(&mut self, degrees: f64) -> Option<f64>` (same, for angles). Pure; unit-tested.
  - `gizmo::axes(session, edit) -> Mat3`: identity unless `local_axes` and something is selected, then `session.axes_of(first selected)`.
  - In `ViewportWidget`: fields `gizmo: Option<GizmoShape>`, `hovered: Handle`, `drag: Option<GizmoDrag>`. Each frame with `tool != Select`, a selection and no placement: build the shape (origin = drag's origin while dragging, else `selection_center()`), paint it, hit-test the hover point.
  - Input: a primary press on a handle starts a drag (`session.end_gesture()` first, as Swift); otherwise primary drag orbits as in M1. Move: `snap = (STUD, PLATE, STUD)`, `⌥` held → free (zero). Rotate: `⇧` held → free. Each frame's step goes to `translate`/`rotate` with `continuing = true`; release (or the pointer leaving the window while released) calls `end_gesture()`. A readout label near the pointer shows the move in studs/plates (`"+2 studs x"`) or the angle (`"90°"`).
  - Drawing (calm rules): axes x red `#e5484d`, y green `#30a46c`, z blue `#4f8cff`, 2-pt lines, hovered or dragged handle 3 pt and full opacity, others 85 %; plane squares filled at 15 %; rings 1.5 pt; View ring neutral grey. These three axis colours are the only hues added; they are the standard axis convention, not accents.

- [ ] **Step 1: Failing unit tests** in `src/gizmo.rs`: `step_move_returns_increments` (totals (20,0,0) then (40,0,0) then (40,0,0) → Some(20,0,0), Some(20,0,0), None); `step_rotate_returns_increments` (15, 30, 30 → Some 15, Some 15, None).
- [ ] **Step 2: Failing harness tests** in `tests/gizmo.rs` (`heli_harness`, select {0}, press M):
  - `move_tool_shows_a_gizmo`: after `run_steps(2)`, the widget's `gizmo` is `Some` with 3 lines (expose `#[doc(hidden)] pub fn gizmo_lines(&self) -> usize` on the app).
  - `gizmo_drag_is_one_undo_step` (Review Focus 2): press on the X line's tip (`gizmo` line 0 `b` + viewport rect min), drag 120 pt along it over 6 frames, release; piece 0 moved (copy text differs); then exactly one `edit.undo` makes `can_undo` false and restores piece 0's copy text.
  - `rotate_drag_is_one_undo_step`: same on the Y ring with the Rotate tool.
  - `press_off_the_gizmo_orbits`: drag on empty viewport space with Move tool → version unchanged (camera changed instead).
  - `select_tool_has_no_gizmo`.
- [ ] **Step 3:** `cargo test -p brickmotion --test gizmo --lib gizmo`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `cargo test --workspace` and clippy. Expected: all pass, 0 warnings.
- [ ] **Step 6: Commit.** `feat(desktop): move and rotate gizmos in the viewport`.

### Task 5: Colours: swatches, recolour, colour for new parts, history store

**Files:**
- Create: `desktop/crates/brickmotion/src/history.rs`, `desktop/crates/brickmotion/src/chrome/swatches.rs`
- Modify: `commands.rs` (`model.recolour` [Selection], was Soon), `app.rs`, `chrome/properties.rs` (the colour row of one piece / many pieces is a swatch button that opens the popover), `chrome/mod.rs`, `support.rs` (nothing but `Support::file("history.toml")`)
- Test: unit tests in `history.rs`, harness tests appended to `tests/edit.rs`

**Interfaces:**
- Consumes: M2 `Session::colors() -> Vec<ColorInfo>` (cached as `app.colors`), Task 1 `recolor`.
- Produces:
  - `history::History { parts: Vec<PartEntry>, colours: Vec<i32> }`, `PartEntry { name: String, description: String, category: String, count: u32 }`, `History::load(&Support) -> History`, `save(&self, &Support) -> io::Result<()>` (M2's `write_atomic`), `record_part(&mut self, name: &str, description: &str, category: &str)`, `recent_parts(&self) -> Vec<&PartEntry>`, `frequent_parts(&self) -> Vec<&PartEntry>`, `record_colour(&mut self, code: i32)`, rules exactly as Global Constraints. App field `pub history: History`; it is saved after every change.
  - `swatches::Target { Selection, NewParts }`, `swatches::show(ui, app, target)` popover: search field ("Search colours", matches name words or exact code), a Recent row (when the search is empty), then groups Solid / Transparent / Metallic / Other (`ColorInfo.group` 0–3), 20-pt square swatches, tooltip "Name (code)". Choosing: `Selection` → `recolor(selection, code)` as one undo step and `record_colour`; `NewParts` → `app.edit.colour = code` and `record_colour`. The popover closes on choose and on Esc.
  - The ribbon's Recolour button and the palette entry open it with `Target::Selection`; Properties' colour row does too; the Library header (Task 7) opens it with `Target::NewParts`.

- [ ] **Step 1: Failing unit tests** (`history.rs`): `recent_is_newest_first_eight`; `frequent_needs_two_uses_sorted_by_count_then_recency`; `parts_cap_at_96`; `colours_dedupe_newest_first_cap_8`; `round_trips_through_history_toml` (temp `Support`).
- [ ] **Step 2: Failing harness tests** (`tests/edit.rs`): `recolour_selection_from_swatches` (select {0}, run `model.recolour`, click the swatch labelled "Red (4)", `snapshot().selected[0].color == 4`, one undo restores, `history.colours[0] == 4`); `swatch_search_by_code` (type "4" → "Red (4)" visible, "Blue (1)" not); `new_part_colour_set_from_swatches` (Target::NewParts sets `edit.colour`, version unchanged); `typing_in_swatch_search_does_not_edit` (Review Focus 3).
- [ ] **Step 3:** Run; expected FAIL. Implement. Run `cargo test --workspace`; expected PASS; clippy 0.
- [ ] **Step 4: Commit.** `feat(desktop): colour swatches, recolour and history store`.

### Task 6: Library and part-preview ABI, preview worker

**Files:**
- Create: `desktop/bmffi/src/library.cpp`, `desktop/bmffi/tests/library_test.cpp`, `desktop/crates/bm/src/library.rs`, `desktop/crates/bm/tests/library.rs`, `desktop/crates/brickmotion/src/previews.rs`
- Modify: `bmffi.h`, `lists.cpp`, `CMakeLists.txt`, `bm-sys/src/lib.rs`, `bm/src/lib.rs`, `brickmotion/src/{app.rs,lib.rs,history.rs}`

**Interfaces:**
- Produces (C, 15 functions; header count 87 → 102). The LDraw directory is the engine's own (`Session::ldrawDirectory()`); a library call with no library returns an empty list.
  - `typedef struct BmParts BmParts; typedef struct { const char *name, *description, *category; } BmPartMatch;`
  - `BmParts* bm_library_parts(const char* query, const char* category, size_t limit)`, `BmParts* bm_common_parts(void)`, `size_t bm_parts_len(const BmParts*)`, `BmPartMatch bm_parts_at(const BmParts*, size_t)`, `void bm_parts_free(BmParts*)`
  - `typedef struct BmStrings BmStrings;` `BmStrings* bm_part_categories(void)`, `size_t bm_strings_len(const BmStrings*)`, `const char* bm_strings_at(const BmStrings*, size_t)` (`""` out of range), `void bm_strings_free(BmStrings*)`
  - `typedef struct BmPartPreview BmPartPreview; typedef struct BmPicture BmPicture;` `BmPartPreview* bm_part_preview_new(void)` (NULL without a library or Metal), `void bm_part_preview_free(BmPartPreview*)`, `BmPicture* bm_part_preview_render(BmPartPreview*, const char* part, int32_t color, bool dark)`, `void bm_picture_info(const BmPicture*, int* w, int* h)`, `const uint8_t* bm_picture_rgba(const BmPicture*)` (borrowed until free), `void bm_picture_free(BmPicture*)`
  - `bm_struct_size` learns `"BmPartMatch"`.
- Produces (Rust `bm::library`): `PartMatch { name, description, category: String }` (`Clone, Debug, PartialEq`), `library_parts(query: &str, category: &str, limit: usize) -> Vec<PartMatch>`, `common_parts() -> Vec<PartMatch>`, `part_categories() -> Vec<String>`, `PartPreview` (`Send`, not `Sync`): `PartPreview::new() -> Option<PartPreview>`, `render(&mut self, part: &str, color: i32, dark: bool) -> Option<Frame>` (`None` for an empty picture). M1's `bm::Frame { width, height, rgba }` is reused.
- Produces (app `previews.rs`): `Previews::new(ctx: egui::Context) -> Previews` (spawns `bm-previews`, which makes the `PartPreview` on itself), `Previews::get(&mut self, part: &str, color: i32) -> Preview` where `enum Preview { Ready(egui::TextureHandle), Pending, Missing }`; `Previews::frame_begin(&mut self)` / `frame_end(&mut self)`: requests not asked for again during the frame are dropped from the queue before they render (Review Focus 4). Textures are cached by `(part, color)`, at most 512, least recently used goes first. Results wake the UI with `ctx.request_repaint()`. Dark previews always (the app is dark-only in M3).

- [ ] **Step 1: Failing C tests** (`library_test.cpp`): `"search finds 3001 first"` (`bm_library_parts("3001", "", 20)` first name `"3001.dat"`); `"categories are listed"` (len > 10, includes `"Brick"`); `"common parts"` (len > 0); `"preview renders a square"` (when `bm_part_preview_new` is non-NULL: render "3001.dat" colour 4 → w == h > 0 and the centre pixel's alpha > 0); `"unknown part renders nothing"` (empty picture: w == 0).
- [ ] **Step 2:** Run; expected compile FAIL. Implement `library.cpp`; header literal → 102. Run; expected PASS; exports `0`.
- [ ] **Step 3: Failing Rust tests** (`bm/tests/library.rs`): `library_search_ranks_exact_number_first`, `preview_is_square` (skips without Metal via `bm::metal_available()`), `preview_moves_to_a_worker` (`PartPreview::new()` inside `std::thread::spawn`, render there). App unit tests in `previews.rs`: `unasked_requests_are_dropped` (ask for 50 parts in frame 1, only 2 in frame 2 → at most 2 + one in flight ever render; count via a `#[cfg(test)]` render counter), `missing_part_is_missing_not_pending_forever`.
- [ ] **Step 4:** Implement; `cargo test --workspace`; PASS; clippy 0.
- [ ] **Step 5: Commit.** `feat(desktop): library ABI, part previews on a worker`.

### Task 7: Library and Parts tabs

**Files:**
- Create: `desktop/crates/brickmotion/src/chrome/library.rs`, `desktop/crates/brickmotion/tests/library.rs`
- Modify: `chrome/browser.rs` (tab 3 shows it), `commands.rs` (`model.add_part` P [Document], was Soon: shows the Library tab and focuses its search), `app.rs`

**Interfaces:**
- Consumes: Task 5 `History`, swatches `Target::NewParts`; Task 6 `bm::library`, `Previews`. (The Parts tab needs the steps ABI, so it lands in Task 11.)
- Produces:
  - Library tab layout, top to bottom: the new-part colour chip (opens swatches with `Target::NewParts`) and a category menu ("All parts" + `part_categories()`); the shared Browser filter field searches the library while this tab is open (`library_parts(filter, category, 200)`, run only when the filter or category changes); with an empty filter and "All parts": sections Recent, Frequent (from `History`) and Common (`common_parts()`); else one result grid.
  - Tiles: 64-pt square, preview in the new-part colour, name under it (`3001`, without `.dat`), hover card with the description. Grid virtualised with `ScrollArea::show_rows` by tile row; `Previews::get` is called only for rows shown.
  - Clicking a tile starts placement (Task 9) with that part; until Task 9 lands it records nothing and does nothing (the click handler is `app.begin_placement(part)` defined in Task 9; Task 7 adds it as a stub that returns without effect and is replaced there).

- [ ] **Step 1: Failing harness tests** (`tests/library.rs`):
  - `library_shows_common_parts`: switch to Library, empty filter → a label "Common" and at least one tile labelled from `common_parts()[0]`.
  - `search_shows_results`: type "3001" into the filter → tile "3001" first.
  - `category_filters`: choose "Brick" → every tile's category is "Brick".
  - `add_part_opens_library_search`: run `model.add_part` → `browser_tab == 3` and the filter has focus.
  - `library_requests_only_visible_previews` (Review Focus 4): with `BM_BIG_MODEL`-free data: category "Brick" (hundreds of parts) in a 300×400 Browser → `previews.requested_this_frame() <= visible tiles + one row`; scroll to the end over 10 frames → slowest frame < 16 ms in release (`#[ignore]` in debug; run with `--release -- --ignored`).
  - `typing_in_library_search_does_not_edit` (Review Focus 3): select {0}, type "pmceqr" → version unchanged, tool Select.
- [ ] **Step 2:** Run; expected FAIL. Implement. `cargo test --workspace`; PASS; clippy 0. Release perf test: `cargo test -p brickmotion --release --test library -- --ignored`; expected PASS, slowest frame printed.
- [ ] **Step 3: Commit.** `feat(desktop): Library tab with previews, categories and search`.

### Task 8: Placement ABI and wrappers

**Files:**
- Create: `desktop/bmffi/src/placement.cpp`, `desktop/bmffi/tests/placement_test.cpp`, `desktop/crates/bm/src/placement.rs`, `desktop/crates/bm/tests/placement.rs`
- Modify: `bmffi.h`, `lists.cpp`, `CMakeLists.txt`, `bm-sys/src/lib.rs`, `bm/src/{lib.rs,viewport.rs,session.rs}`

**Interfaces:**
- Produces (C, 6 functions; header count 102 → 108):
  - `typedef enum { BM_PLACE_INACTIVE, BM_PLACE_PREPARING, BM_PLACE_FREE, BM_PLACE_SNAPPED, BM_PLACE_REFERENCE, BM_PLACE_BLOCKED, BM_PLACE_UNAVAILABLE } BmPlacementState;` (order of `bmapp::PlacementState`)
  - `typedef struct { const char* part; int32_t color, grip, turns; bool mirrored, snap, reference, collision; uint32_t anchor; BmVec2 grab; const uint32_t* selection; size_t selection_len; } BmPlacementInput;` (`anchor = BM_NO_PIECE` for a library part)
  - `typedef struct { BmPlacementState state; BmMat3 rotation; BmVec3 position, contact; uint32_t grip, grip_count; uint64_t generation, version, request; BmString reason; } BmPlacementPreview;` freed with `void bm_placement_preview_free(BmPlacementPreview)`
  - `uint64_t bm_viewport_preview_part(BmViewport*, const BmPlacementInput*, BmVec2 point)` (0 = unavailable)
  - `BmPlacementPreview bm_viewport_placement_preview(const BmViewport*)`
  - `void bm_viewport_clear_placement_preview(BmViewport*)`, `void bm_viewport_show_rest(BmViewport*)`
  - `BmChange bm_session_place_part(BmSession*, const char* part, int32_t color, BmMat3 rotation, BmVec3 position, int32_t step, int32_t before, uint64_t generation, uint64_t version)` over `placePartBefore` (step −1 = last step; before −1 = end of step)
  - `bm_struct_size` learns `"BmPlacementInput" "BmPlacementPreview"`.
- Produces (Rust `bm::placement`): `PlacementState` enum (same seven), `PlacementInput { part: String, color: i32, grip: i32, turns: i32, mirrored: bool, snap: bool, reference: bool, collision: bool, anchor: Option<u32>, grab: Vec2, selection: Vec<u32> }` with `Default` = engine defaults (color 71, grip −1, snap true, collision true), `PlacementPreview { state, pose: Pose, contact: Vec3, grip: u32, grip_count: u32, generation: u64, version: u64, request: u64, reason: String }`; `Viewport::preview_part(&mut self, &PlacementInput, at: Vec2) -> u64`, `placement_preview(&self) -> PlacementPreview`, `clear_placement_preview(&mut self)`, `show_rest(&mut self)`; `Session::place_part(&self, part: &str, color: i32, pose: &Pose, step: Option<usize>, before: Option<usize>, generation: u64, version: u64) -> Changed`.

- [ ] **Step 1: Failing C tests** (`placement_test.cpp`, helicopter with a 640×480 viewport drawn once): `"preview answers its request"` (`preview_part({"3001.dat", 4, …}, centre)` → request r > 0; poll `placement_preview` with `bm_viewport_draw` between polls until `request == r` or 5 s; state is FREE, SNAPPED or BLOCKED); `"place at the previewed pose adds one piece"` (when state FREE/SNAPPED: `place_part` with its pose, generation, version → count +1, one undo removes it); `"a stale version is refused"` (remove piece 0, then `place_part` with the old version → refused non-empty, count unchanged).
- [ ] **Step 2:** Run; expected compile FAIL. Implement; header literal → 108. Run; PASS; exports `0`.
- [ ] **Step 3: Failing Rust tests** (`bm/tests/placement.rs`): the same three through the wrappers (skip without Metal). Implement; `cargo test -p bm`; PASS.
- [ ] **Step 4: Commit.** `feat(desktop): placement ABI (preview, commit, stale guard)`.

### Task 9: Placing parts

**Files:**
- Create: `desktop/crates/brickmotion/src/placement.rs`, `desktop/crates/brickmotion/tests/placement.rs`
- Modify: `edit.rs` (`EditState` gains `pub placement: Option<Placement>`), `viewport.rs`, `shortcuts.rs`, `app.rs` (`begin_placement` replaces Task 7's stub), `chrome/library.rs` (tile click), `chrome/viewbar.rs` (selection chip shows the placement HUD while placing)

**Interfaces:**
- Consumes: Task 8; Task 5 `History::record_part`; Task 2 `EditState.colour`, `.collision`, `.step`.
- Produces:
  - `pub struct Placement { pub part: PartMatch, input: PlacementInput, at: Vec2, request: u64, generation: u64, version: u64, step: Option<usize>, awaiting: bool, pub state: PlacementState, pub reason: String, pub grip_count: u32, auto_grip: u32 }`.
  - `Placement::begin(part: PartMatch, colour: i32, collision: bool, step: Option<usize>, session: &Session, vp: &mut Viewport, at: Vec2) -> Placement` (calls `show_rest`, records generation/version, previews at `at`).
  - `pointer(&mut self, vp, at: Vec2, free: bool)` (⌥ = free: `snap = false`), `turn(&mut self, vp)` (`turns = (turns + 1) % 4`), `cycle_grip(&mut self, vp, back: bool)` (only when `grip_count > 1`; from `auto_grip` when `grip < 0`), `accept(&mut self)` (sets `awaiting`), `poll(&mut self, vp: &Viewport, session: &Session) -> Option<Placed>` where `enum Placed { Done, Refused(String) }`: reads `placement_preview()`; updates state/reason/grip_count (and `auto_grip` when Snapped); when awaiting and the preview's request is this one: if the state is Free, Snapped or Reference, `place_part(part, colour, pose, step, None, preview.generation, preview.version)`; returns `Done` on success (the caller records history and ends the placement) or `Refused(reason)` (state becomes Unavailable, placement stays).
  - `Placement::stale(&self, session: &Session) -> bool` (generation or version moved).
  - App: `begin_placement(&mut self, part: PartMatch)` (pointer at the viewport centre if it is not over the viewport); each frame while placing: cancel if `stale`; pointer moves → `pointer`; a primary click in the viewport → `accept` (no selection change, no orbit); Return → `accept`; Tab / ⇧Tab → `cycle_grip`; R → `turn`; Esc → cancel (`clear_placement_preview`). Keys are consumed before `shortcuts::handle`. `request_repaint_after(30 ms)` while placing.
  - HUD (in the selection chip's place): part name, state word ("Snapped", "Free", "Blocked: <reason>"), and key hints "Click to place · R turn · Tab grip · Esc cancel" in `text3`.
  - New parts go into `edit.step` (the step chosen in the Steps tab) or the last step.

- [ ] **Step 1: Failing tests** (`tests/placement.rs`, harness with helicopter, skip without Metal):
  - `click_places_one_piece`: `begin_placement(3001)`, move the pointer to the viewport centre, run frames until `state` is Free or Snapped (5 s), click → piece count +1, `history.recent_parts()[0].name == "3001.dat"`, placement ended, one undo removes it.
  - `escape_cancels`: begin, Esc → no placement, count unchanged.
  - `r_turns_the_preview_not_the_selection`: select {0}, begin, R → `input.turns == 1` (`#[doc(hidden)] turns()`), piece 0 unchanged.
  - `placement_cancels_when_the_model_changes` (Review Focus 1): begin; delete piece 0 through `run("edit.delete")` → placement ended on the next frame; then a click in the viewport places nothing (count = n − 1).
  - `hud_follows_the_state`: while placing, the HUD shows the word for the current `state` ("Snapped", "Free", "Blocked", …) and, when `reason` is non-empty, the reason.
  - `return_does_nothing_unless_placeable`: unit test on `Placement::poll` with a preview whose state is Blocked or Unavailable and whose request matches → returns `None`, places nothing, `awaiting` cleared (build the preview by hand; `poll` takes it through a `#[cfg(test)]` seam `poll_with(preview, session)`).
  - `new_part_uses_the_chosen_colour`: `edit.colour = 4`, place → the new piece's `snapshot` colour is 4.
- [ ] **Step 2:** Run; expected FAIL. Implement. `cargo test --workspace`; PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): place library parts with snapping preview`.

### Task 10: Steps ABI and wrappers

**Files:**
- Create: `desktop/bmffi/src/steps.cpp`, `desktop/bmffi/tests/steps_test.cpp`, `desktop/crates/bm/src/steps.rs`, `desktop/crates/bm/tests/steps.rs`
- Modify: `bmffi.h`, `lists.cpp`, `CMakeLists.txt`, `bm-sys/src/lib.rs`, `bm/src/{lib.rs,session.rs}`

**Interfaces:**
- Produces (C, 18 functions; header count 108 → 126):
  - Lists: `typedef struct BmSteps BmSteps; typedef struct { size_t index; const char *title, *notes; double pause_after; bool pin_order, automatic; size_t items, pieces, submodels; } BmStepRow;` `BmSteps* bm_session_steps(const BmSession*)`, `bm_steps_len`, `BmStepRow bm_steps_at(const BmSteps*, size_t)`, `bm_steps_free`. `typedef struct BmItems BmItems; typedef struct { uint64_t item; const char *name, *description, *color_name, *group; int32_t color; bool submodel; size_t step, index, pieces; } BmItemRow;` `BmItems* bm_session_step_items(const BmSession*, size_t step)`, `bm_items_len`, `BmItemRow bm_items_at(const BmItems*, size_t)`, `size_t bm_item_pieces(const BmItems*, size_t i, uint32_t* out, size_t cap)` (two-call), `bm_items_free`.
  - `size_t bm_session_pieces_of_step(const BmSession*, size_t step, uint32_t* out, size_t cap)` (two-call).
  - Edits (each `BmChange`): `bm_session_insert_step(s, size_t at)`, `bm_session_delete_step(s, size_t at)`, `bm_session_move_step(s, size_t from, size_t to)`, `bm_session_split_step(s, size_t at, const uint32_t*, size_t)`, `bm_session_merge_steps(s, size_t first)`, `bm_session_set_step_fields(s, size_t at, const char* title, const char* notes, double pause_after, bool pin_order, bool continuing)`, `bm_session_move_to_step(s, const uint32_t*, size_t, size_t step)`, `bm_session_reorder_in_step(s, size_t step, size_t from, size_t to)`.
  - `bm_struct_size` learns `"BmStepRow" "BmItemRow"`.
- Produces (Rust `bm::steps`): `StepRow { index: usize, title, notes: String, pause_after: f64, pin_order, automatic: bool, items, pieces, submodels: usize }`, `ItemRow { item: u64, name, description, color_name, group: String, color: i32, submodel: bool, step, index: usize, pieces: Vec<u32> }`, `StepFields { title, notes: String, pause_after: f64, pin_order: bool }`; on `Session`: `steps() -> Vec<StepRow>`, `step_items(step: usize) -> Vec<ItemRow>`, `pieces_of_step(step) -> Vec<u32>`, `insert_step(at) -> Changed`, `delete_step(at)`, `move_step(from, to)`, `split_step(at, &[u32])`, `merge_steps(first)`, `set_step_fields(at, &StepFields, continuing: bool)`, `move_to_step(&[u32], step)`, `reorder_in_step(step, from, to)`.

- [ ] **Step 1: Failing C tests** (`steps_test.cpp`, `samples/8880-1.mpd` or helicopter, whichever has ≥ 2 steps; say which in the test): `"steps list"` (len == `stepCount`, row 0 `pieces > 0`); `"items of a step carry their pieces"` (sum of item pieces of step 0 == `pieces_of_step(0)` length); `"insert then delete a step"` (len +1 then back, two undo steps); `"split moves the chosen pieces to a new step"`; `"merge joins two steps"`; `"fields: typing is one undo step"` (set title "A" continuing false, "AB" continuing true, `end_gesture`; one undo restores the original title); `"move to step"` (piece of step 1 into step 0: `pieces_of_step(0)` contains it); `"a split that empties a step is refused"` (split step 0 with all its pieces → refused non-empty, len unchanged).
- [ ] **Step 2:** Run; expected compile FAIL. Implement; header literal → 126. Run; PASS; exports `0`.
- [ ] **Step 3: Failing Rust tests** (`bm/tests/steps.rs`): the same through wrappers. Implement; `cargo test -p bm`; PASS.
- [ ] **Step 4: Commit.** `feat(desktop): steps ABI (lists, items, step edits)`.

### Task 11: Steps and Parts tabs

**Files:**
- Create: `desktop/crates/brickmotion/src/chrome/steps.rs`, `desktop/crates/brickmotion/src/chrome/parts.rs`, `desktop/crates/brickmotion/tests/steps.rs`
- Modify: `chrome/browser.rs` (tab 1 Steps, tab 2 Parts), `commands.rs` (`When::Step` and `Ctx { step: Option<usize>, steps: usize }`; `model.to_step` [Step + Selection], was Soon), `app.rs`

**Interfaces:**
- Consumes: Task 10; Task 2 `EditState.step`; M2 tree row style (`chrome/tree.rs` `show_rows`).
- Produces:
  - **Steps tab:** one row per step: "Step N", its title in `text2` when set, piece count right-aligned; rows virtualised; the list is rebuilt only when `structure_version` changes (as the tree). Clicking a row sets `edit.step = Some(i)` and selects `pieces_of_step(i)`; a disclosure shows its items (name, colour dot, count; a submodel item is marked) and clicking an item selects its pieces. The Browser filter filters by step title and item name.
  - **Step menu** (right-click a row, and the commands, all [Step]): `step.edit` "Edit Step…", `step.insert_before`, `step.insert_after`, `step.split` "Split at Selection" [Step + Selection], `step.merge` "Merge with Next" (off on the last step), `model.to_step` "Gather Selection Here", `step.move_up`, `step.move_down`, `step.delete`. Each is one engine call through `app.edited`.
  - **Step editor popover** (`step.edit`, or double-click a row): Title (≤ 80 chars), Notes (multi-line, ≤ 1000), Pause after (0–10 s, one decimal, a drag-to-scrub number field), Pin order checkbox. Typing writes `set_step_fields(..., continuing = true)` after the first write, at most every 300 ms; closing the popover writes what is pending and calls `end_gesture()`: the whole edit is one undo step (as Swift's `StepEditorModel`).
  - **Parts tab:** what this model uses, from every step's items (rebuilt only on `structure_version` change): one row per (part, colour) for part items, and one row per submodel for submodel uses (marked as a submodel, counting the pieces its uses make). Each row: colour dot (none for a submodel), name, description, count of pieces; clicking selects all those pieces. Sorted by count, then name.

- [ ] **Step 1: Failing harness tests** (`tests/steps.rs`):
  - `steps_tab_lists_steps`: one row labelled "Step 1" … per `steps()`.
  - `clicking_a_step_selects_its_pieces`: selection == `pieces_of_step(0)`, `edit.step == Some(0)`.
  - `insert_after_adds_a_step_and_undo_removes_it`.
  - `gather_selection_moves_pieces_to_the_chosen_step`.
  - `step_title_typing_is_one_undo_step`: open the editor, type "Wheels", close; title is "Wheels"; one `edit.undo` restores the old title.
  - `typing_in_step_title_does_not_edit` (Review Focus 3): with a selection, type "eqrc" in the title → only the title changes (version moves by the title edit only: piece positions' copy text unchanged).
  - `parts_tab_counts_parts`: the rows' counts sum to `piece_count()`; clicking the first row selects that many pieces.
  - `new_parts_go_into_the_chosen_step` (with Metal): choose step 0, place 3001 → `pieces_of_step(0)` grows by one.
- [ ] **Step 2:** Run; expected FAIL. Implement. `cargo test --workspace`; PASS; clippy 0. Big model: `BM_BIG_MODEL=<absolute path to dist/data/omr/10294-1/10294-1.mpd> cargo test -p brickmotion --release --test steps big_model -- --ignored` (a new test timing the Steps and Parts tabs' own layout, as M2's tree test): each < 16 ms.
- [ ] **Step 3: Commit.** `feat(desktop): Steps and Parts tabs with step menu and editor`.

### Task 12: Replace Part

**Files:**
- Create: `desktop/crates/brickmotion/src/chrome/replace.rs`
- Modify: `commands.rs` (`model.replace` "Replace Part…" [Selection], was Soon), `chrome/properties.rs` (a Replace button on one piece), `app.rs`
- Test: appended to `tests/library.rs`

**Interfaces:**
- Consumes: Task 1 `replace_part`, Task 6 `library_parts` and `Previews`.
- Produces: a modal sheet "Replace <n> pieces" with a search field (prefilled empty, focused), results as Library tiles in the selection's first colour, Cancel and Replace buttons; Replace (or Return / double-click a tile) calls `replace_part(selection, chosen.name)` as one undo step and closes; a refusal keeps the sheet open and shows the engine's reason under the field.

- [ ] **Step 1: Failing tests:** `replace_swaps_the_part_and_keeps_colour` (select {0} (record colour), run `model.replace`, type "3001", choose the first tile, Replace → `snapshot().selected[0].part == "3001.dat"`, colour unchanged, one undo restores); `replace_needs_a_selection` (`run` returns false with nothing selected); `cancel_changes_nothing`.
- [ ] **Step 2:** Run; FAIL. Implement. `cargo test --workspace`; PASS; clippy 0.
- [ ] **Step 3: Commit.** `feat(desktop): Replace Part sheet`.

### Task 13: Milestone checks

**Files:**
- Modify: `desktop/crates/brickmotion/tests/ui.rs` (screenshots), `desktop/docs/m3-rulings.md` (create: rulings, deferred minors, checks)

- [ ] **Step 1:** Screenshots: extend `screenshots` (`BM_SCREENSHOTS=1 cargo test -p brickmotion --test ui screenshots`) to write `docs/m3-gizmo.png` (Move tool on a selected piece), `docs/m3-library.png` (Library tab, Common), `docs/m3-placing.png` (a snapped preview with HUD), `docs/m3-steps.png` (Steps tab with the editor open). Expected: four PNGs written; look at each and record one line per picture in `m3-rulings.md`.
- [ ] **Step 2:** Full checks: `cd desktop && cargo test --workspace` (all pass), `cargo clippy --workspace --all-targets` (0), `cd native/build-rust && ninja bmffi_tests && ./bmffi/bmffi_tests` (all pass), `nm -gU bmffi/libbmffi.dylib | grep -vc ' _bm_'` (0), `ctest --test-dir native/build-app` (619/619). Record the numbers.
- [ ] **Step 3: By hand** with `HOME=<scratchpad>/home` (never the real support folder): open the helicopter; place three parts from the Library (one snapped onto a stud); move one with the gizmo and undo it in one ⌘Z; turn with R; recolour from Properties; edit a step title; gather a selection into step 1; save, reopen, and check the edits are there. Record what was seen.
- [ ] **Step 4: Commit.** Stage `desktop/docs/m3-*.png desktop/docs/m3-rulings.md desktop/crates/brickmotion/tests/ui.rs`. Message: `docs(desktop): M3 checks and screenshots`.

---

## Not in M3 (and where it goes)

- Scale tool, marquee selection, dragging selected pieces directly with snapping (`placeMoved`), double-click into a submodel, the piece context menu, view presets on 1/3/7, flight-path editing — parity sweep (M8) unless the owner asks sooner.
- Submodel commands (make, extract, move to model, rename, delete), groups, Make Unique, What Fits, Seat Loose, Inventory import — M7 (extras) and M8.
- Gizmo editing of keyframes — M5. Placement onto the timeline Parts lane — M4.
- Mirrored placement and reference (documented) placements: the input fields are wired (`mirrored`, `reference`), but no UI toggles them in M3.
