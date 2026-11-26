# BrickMotion Desktop — Milestone 7a (Assembly Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rust app gets the four extras the engine already has:
- **Model Checks:** overlaps, unsupported parts, unstable groups, single-connector attachments, missing definitions, unknown colours, submodel loops, and the last refused edit, each finding selecting and framing its pieces.
- **Seat Loose Pieces:** pieces placed a little off their connector, seated exactly in one undo step.
- **What Fits** (Swift "Find Compatible Parts…"): what BrickNet builders put on the selected part, placed at their exact pose, and library parts that fit a free connection.
- **Import Parts Inventory:** a Rebrickable CSV or Studio `.pbg` laid out as pieces in one undo step.

**Architecture:**
- **Swift logic moves down first (Task 2), as in M4–M6.**
  - Seat Loose's choice rules (`LoosePiecesSheet.swift`: which rows start checked, `waitingOn`, `uncheck`, the row detail text) become free functions in `bmapp/assembly_inspection.h`.
  - The suggestion's "why" line (`AssemblyInspectionWorker.Suggestion.why`) becomes `bmapp::habitWhy`.
  - Swift is rewired to call them.
- **bmffi** grows `inspection.cpp` with model checks, loose pieces and their choice rules, habit fits, fitting parts and seat pieces, and `inventory.cpp` with capture, prepare and import. These sit next to the existing `bm_inspection_*` joint functions.
- **bm** extends `motion.rs` `Inspection` and adds `inventory.rs`.
- **brickmotion** gets three floating panels: `chrome/checks_panel.rs`, `chrome/loose_panel.rs` and `chrome/fits_panel.rs`. It also gets `inventory.rs` (open panel, worker, notices) and a habits-file locator in `support.rs`.
- **Background work:**
  - All inspection work runs on the `workers.rs` `Job`, keyed by (generation, version), from an `Inspection` captured on the UI thread.
  - A result that comes back after the document changed is dropped (`Stale`).
  - Inventory `prepare` runs on its own thread. `import_inventory` commits on the UI thread.

**Tech Stack:** As M6. No new crates.

**Spec:** `docs/superpowers/specs/2026-11-25-rust-egui-app-design.md`, milestone 7:
> "Extras: suggest, techniques, generate (non-AI), booklet, inventory import, model checks."

This plan covers the part of milestone 7 whose engine work is done: model checks, inventory import, and Suggest slice 1 ("What Builders Put Here", Phase 10 §1). It adds Seat Loose, which is a ledger panel the earlier milestones left on `When::Soon`. The rest of milestone 7 needs C++ ports or owner decisions first, so it gets its own plans (see "Milestone 7 split" at the end).

**Behaviour reference:**
- **Parity ledger** `docs/superpowers/specs/2026-11-19-native-app-parity.md`:
  - row 36: Rebrickable `.csv` and `.pbg` import;
  - row 142: Checks;
  - row 149: Suggest, slice 1.
- **Swift files:** `ModelChecksSheet.swift`, `ModelChecksResult.swift`, `LoosePiecesSheet.swift`, `CompatibleParts.swift`, `AssemblyInspectionWorker.swift`, `InventoryImportSheet.swift`, and the `file.importInventory`, `object.compatibleParts`, `step.modelChecks` and `step.loosePieces` rows of `Commands.swift`.

  Match their behaviour and copy. Never copy their logic into Rust: Task 2 moves it into bmapp first.

**Base:** `main` at `cdaceab0` (M6 and its minors merged). Work on a new branch `feat/desktop-m7a`. Rulings so far: `desktop/docs/m2-rulings.md` … `m6-rulings.md`.

## Global Constraints

- **M1–M6 Global Constraints still hold:**
  - Calm UI: one stroke-icon family, one blue accent `#4f8cff`, orange only for the playhead, an 8-px grid, 12.5-pt text in two weights.
  - Bundle id `com.brickmotion.studio.rs`. Stage named files only. No commits on `main`. Never push.
  - Tests use `new_for_test` / `new_for_test_cc` and never touch the real support folder.
  - The session stays single-threaded.
- **Editors are floating panels (M5 ruling):** `float_panel::show` with a new `PanelKind`, widgets from `chrome/widgets.rs`, and fill-pill sliders for bounded values. Panels open below the axis navigator (`navigator::CLEARANCE`).
- **Screens are mocked up and approved before they are built (Task 1).** The approved design wins over this plan's text.
- **Engine edits are allowed only where logic moves down:**
  - `native/app/bmapp/include/bmapp/assembly_inspection.h` and `src/assembly_inspection.cpp` (the Seat Loose rules and `habitWhy`);
  - their tests in `native/app/bmapp/tests/`.

  Checks, seating, the habits search and inventory layout algorithms do not change (spec non-goal).
- **The Swift app stays green and calls the moved logic:**
  - `ctest --test-dir native/build-app -j8` passes with at least 674;
  - `ctest --test-dir native/build -j8` passes with at least 475;
  - `bmapp_tests` and `bmffi_tests` pass in `native/build-rust`.
- **Every document change is one named undo step and refuses a stale revision:**
  - seating uses `Session::seatPieces(moves, generation, version)`;
  - a suggestion uses `place_part(…, generation, version)`;
  - an inventory uses `Session::importInventory`.

  Each takes the (generation, version) the result was computed from. A refused change is a notice, never a partial edit.
- **Swift's copy is the display copy.** Strings quoted in this plan are exact.
- **The habits table:**
  - The Rust app finds `habits.json` from `BM_HABITS`, then `Contents/Resources/Suggest/habits.json`, then `public/data/suggest/habits.json` in the repo. This is `support::habits_file()`, modelled on `snap_recordings()`.
  - `main` sets `BM_HABITS` before any engine call, as Swift's `main.swift` does.
  - `scripts/bundle.sh` copies the table into the bundle.
  - A missing table gives an empty "What Builders Put Here" list, never an error (`habitFits` already returns empty).
- **Commands:**
  - `model.what_fits`, `model.seat_loose` and `model.inventory` leave `When::Soon`.
  - New commands: `inspect.model_checks` ("Model Checks") and `file.import_inventory` ("Import Parts Inventory…", `Menu::File`).
  - New `When` cases:
    - `OnePiece`: exactly one piece selected (Swift `selection.count == 1`);
    - `SeveralPieces`: the document has more than one piece (Swift `pieceCount() > 1`).
  - No new shortcuts.
- **Out of scope:**
  - `model.submodel`, `model.extract` and `app.settings` stay `When::Soon` for M8's sweep.
  - Bricksafe stays out until the owner answers the ledger's question.

## Scope by ledger row

| Ledger row | Plan |
|---|---|
| 142 Checks: overlap, unsupported, tipping, single connector, missing definition, unknown colour, submodel loop, refused edit | **M7a** (Task 4) |
| Seat Loose Pieces (Phase 9 panel) | **M7a** (Tasks 2, 5) |
| 149 Suggest slice 1: What Builders Put Here; Fits a Free Connection | **M7a** (Tasks 2, 6) |
| 36 Import Rebrickable `.csv` / Studio `.pbg` inventory | **M7a** (Task 7) |
| 149 Suggest §2: open connections, ghosts, mirror, repeat; §3: techniques and calculators | **M7b** (C++ port first) |
| 150 Generate: brickify, building, castle, remix | **M7c** (C++ port first; remix needs owner answers) |
| 153 Booklet instructions | **M7d** (design with the owner first) |

## Review Focus

1. **The document changes while a check runs.** A result computed from an older (generation, version) is dropped: nothing is shown as current and nothing is placed or seated. The panel starts a fresh check. Tests (Task 4): `checks_drop_a_stale_result`. Task 6: `fit_refuses_a_stale_revision`.
2. **The document is closed or another is opened while a panel is open.** The panel closes, or shows the new document's result. A late result never lands on the new document. Test (Task 4): `checks_close_with_the_document`.
3. **Seat Loose chains.** A piece seated onto an unchecked listed piece cannot be checked; it reads "Seated onto NAME: check it first". Unchecking a piece unchecks everything seated onto it, at any depth. Cycles in `onto` do not hang. Test (Task 2): `loose_choice_rules` (bmapp), including a two-piece `onto` cycle.
4. **An inventory with unknown parts, spares and bad rows.** Known parts are imported as one undo step, and a notice lists them as Swift's report does:
   - "Unreadable rows: n";
   - "Spare pieces skipped: n";
   - "Missing part files: …" with at most 8 names, then "n more missing part files".

   A file with no usable rows changes nothing and says "No Parts to Import". Test (Task 7): `inventory_reports_skipped_rows`.
5. **No selection, or the habits table missing.** What Fits is disabled unless exactly one piece is selected. With `BM_HABITS` pointing at a missing file, the panel still lists "Fits a Free Connection" and shows no error. Test (Task 6): `fits_without_habits_table`.

---

### Task 1: Mockup and owner gate

**Files:**
- Create: `desktop/docs/m7a-tools-mockup.html` (copied from the brainstorm content folder)
- Create: `desktop/docs/m7a-rulings.md`

- [ ] **Step 1: Mock up the four surfaces in the approved style (`final-app-v2.html`, the M5/M6 panels), dark and light:**
  - **Model Checks panel:** grouped findings, the "Last Refused Edit" section with Dismiss, and a frame button on each row.
  - **Seat Loose Pieces panel:** checkbox rows, the detail line, a frame button, and the footer "n of m selected" with "Seat n Pieces".
  - **Compatible Parts panel:** a search field, the "What Builders Put Here" and "Fits a Free Connection" sections with part previews, and "Add Part" / "Preview Placement".
  - **Import Parts Inventory:** the open panel, then the report notice.
- [ ] **Step 2: Put these questions to the owner with the mockup:**
  1. Do Model Checks and Seat Loose sit on the empty **Inspect** ribbon tab (recommended), or stay on Model › Fit?
  2. Does What Fits move to the empty **Suggest** tab, with M7b's ghosts and techniques joining it later (recommended), or stay on Model › Fit?
  3. Ribbon labels: keep the short ones ("What Fits", "Seat Loose", "Inventory"), with the Swift titles as panel headers (recommended)?
- [ ] **Step 3: Record the answers in `m7a-rulings.md`** under "Approved mockup", in the M6 format. Then commit both files: `docs(desktop): M7a mockup and rulings`.

### Task 2: Seat Loose rules and the suggestion line move into bmapp

**Files:**
- Modify: `native/app/bmapp/include/bmapp/assembly_inspection.h`, `native/app/bmapp/src/assembly_inspection.cpp`
- Modify: `native/app/BrickMotion/LoosePiecesSheet.swift`, `native/app/BrickMotion/AssemblyInspectionWorker.swift`
- Test: `native/app/bmapp/tests/loose_choice_test.cpp` (new; add it to the bmapp tests list)

**Interfaces:**
- Produces (namespace `bmapp`):
  - `using LoosePieceList = std::vector<LoosePiece>;` (for clean Swift C++ interop alongside `PieceList`).
  - `PieceList initialLooseChoice(const LoosePieceList& rows)`: the safe rows, minus every row that rests (at any depth) on a row that is not chosen.
  - `uint32_t looseWaitingOn(const LoosePieceList& rows, uint32_t piece, const PieceList& chosen)`: the first listed holder up the `onto` chain that is not chosen, or `UINT32_MAX`. Stops on a cycle.
  - `PieceList looseUncheck(const LoosePieceList& rows, uint32_t piece, const PieceList& chosen)`: `chosen` without `piece` and every listed piece seated onto it, at any depth.
  - `std::string looseDetail(const LoosePiece& row, const std::string& ontoName)`: Swift's `detail(_:)`.
    - The parts are joined by `" · "` (UTF-8 U+00B7): `"%.1f LDU off"` when offset ≥ 0.05, `"turned %.1f°"` (UTF-8 U+00B0) when angle ≥ 0.05, then `"on NAME"`.
    - An unsafe row appends `" · would cross another part"`, or `" · NOTE"` when it has a note.
  - `std::string habitWhy(const HabitFit& fit)`:
    - The text is `"In M of T BrickNet models"`, with M and T comma-grouped as in Swift's en-US `formatted()`, e.g. `"1,234"`.
    - `" · JOINT"` is appended unless the joint is empty or `"stud"`.
  - Note: `native/app/bmapp/CMakeLists.txt` globs `tests/*_test.cpp` with `CONFIGURE_DEPENDS`, so `loose_choice_test.cpp` is picked up automatically. `AssemblyInspectionWorker.Suggestion` stores `let why: String` populated directly from `String(bmapp.habitWhy(fit))`.

- [ ] **Step 1: Write `loose_choice_test.cpp`, TEST_CASE "loose_choice_rules" "[bmapp][correct]"** on hand-built rows (no session):
  - rows: A (safe, onto 9 unlisted), B (safe, onto A), C (unsafe, onto 9), D (safe, onto C).
  - `initialLooseChoice` gives {A, B}: D is dropped because C is not chosen.
  - `looseWaitingOn(rows, D, {A, B})` is C.
  - `looseUncheck(rows, A, {A, B})` is {}.
  - A two-row cycle (E onto F, F onto E, both safe) returns without hanging. `initialLooseChoice` keeps both.
- [ ] **Step 2: Add TEST_CASE "loose_detail_and_habit_why"** with these CHECKs:
  - `looseDetail({offset 3, angle 0, safe true}, "Blue Brick 2 x 4") == "3.0 LDU off · on Blue Brick 2 x 4"`
  - an unsafe row with an empty note ends with " · would cross another part"
  - `habitWhy({models 1234, total 67185, joint "stud"}) == "In 1,234 of 67,185 BrickNet models"`
  - `habitWhy({…, joint "hinge"})` ends with " · hinge"
- [ ] **Step 3: Run it to see it fail.** `cmake --build native/build-rust --target bmapp_tests && native/build-rust/app/bmapp/bmapp_tests "[correct],[suggest]"`. Expected: compile errors for the missing functions.
- [ ] **Step 4: Implement the five functions** in `assembly_inspection.cpp`. Group thousands with "," (Swift's en-US `formatted()`).
- [ ] **Step 5: Rewire Swift.** `LoosePiecesSheet` calls `initialLooseChoice`, `looseWaitingOn`, `looseUncheck` and `looseDetail`. `Suggestion.why` calls `habitWhy`. Delete the Swift bodies.
- [ ] **Step 6: Run the suites.** Run `bmapp_tests`, then `ctest --test-dir native/build-app -j8`. Expected: both pass; build-app has at least 674 tests.
- [ ] **Step 7: Commit:** `refactor(bmapp): Seat Loose choice rules and the suggestion line move into the engine`.

### Task 3: The bridge (bmffi, bm-sys, bm)

**Files:**
- Create: `desktop/bmffi/src/inspection.cpp`, `desktop/bmffi/src/inventory.cpp`
- Modify: `desktop/bmffi/src/internal.h` (move `struct BmInspection` from `motion.cpp` so `inspection.cpp` shares it), `desktop/bmffi/src/motion.cpp`, `desktop/bmffi/include/bmffi.h`, `desktop/crates/bm-sys/src/lib.rs` (declarations + `DECLARED`)
- Modify: `desktop/crates/bm/src/motion.rs`, `desktop/crates/bm/src/lib.rs` (`pub mod inventory;`)
- Create: `desktop/crates/bm/src/inventory.rs`
- Modify: `desktop/crates/bm/src/session.rs`, `desktop/crates/bm/tests/render.rs` (the pinned count, from 350 to the new total)
- Test: `desktop/bmffi/tests/inspection_test.cpp`, `desktop/crates/bm/tests/inspection.rs`

**Interfaces:**
- **C:** follows the joints pattern: an opaque result handle with `_len`, `_at`, string accessors and `_free`.
  - `bm_session_show(BmSession*, const uint32_t* pieces, size_t n)`: unhides listed pieces (matching Swift `session.show(ids)` when revealing findings or loose pieces).
  - `bm_session_part_at(const BmSession*, uint32_t piece, BmString* name, BmString* description, BmString* category)` and `bm_session_part_color(const BmSession*, uint32_t piece) -> int32_t`: exact piece part/colour lookup (used by Seat Loose naming and Compatible Parts target subtitle).
  - `bm_inspection_check_model(BmInspection*) -> BmModelChecks*` returns rows `{int32_t kind; …}`. `kind` is 0..6, in `ModelCheckKind` order. Accessors return the error, title, detail and pieces.
  - `bm_inspection_loose_pieces(BmInspection*) -> BmLoosePieces*` returns rows `{uint32_t piece, onto; BmMat3 rotation; BmVec3 position; double offset, angle; bool safe}`, plus `_note(i)` and `_error`.
  - `bm_loose_initial_choice`, `bm_loose_waiting_on`, `bm_loose_uncheck` and `bm_loose_detail` work over a `const BmLoosePieces*`.
  - `bm_inspection_habit_fits(BmInspection*, uint32_t piece, size_t limit) -> BmHabitFits*` returns the color, pose, models, total and links per row, plus `_name`, `_description`, `_joint` and `_why`.
  - `bm_inspection_fitting_parts(BmInspection*, uint32_t piece, const char* const* candidates, size_t n, size_t limit) -> BmFittingParts*` returns the name and contact per row.
  - `bm_session_seat_pieces(BmSession*, const BmPieceMove* moves, size_t n, uint64_t generation, uint64_t version) -> BmChange` where `BmPieceMove` is `{uint32_t piece; BmMat3 rotation; BmVec3 position;}`.
  - `bm_inventory_capture(const BmSession*, int32_t step) -> BmInventory*`
  - `bm_inventory_prepare(BmInventory*, const char* path) -> BmInventoryReport*` returns the error, pieces, spares, invalid rows and missing names (`_len` / `_at` / `_free`).
  - `bm_session_import_inventory(BmSession*, const BmInventory*) -> BmChange`
  - `bm_inventory_free`
- **Rust (`bm`):**
  - `Session::show(&self, pieces: &[u32])`, `Session::part_at(&self, piece: u32) -> PartMatch`, `Session::part_color(&self, piece: u32) -> i32`.
  - `Inspection::check_model(&mut self) -> ModelChecks { findings: Vec<ModelCheck { kind: CheckKind, title, detail, pieces: Vec<u32> }>, error: Option<String> }`
  - `Inspection::loose_pieces(&mut self) -> LoosePieces` (`Send`, owns `*mut sys::BmLoosePieces` freed in `Drop` so rule methods call the engine directly without re-marshaling; exposes `pub rows: Vec<LoosePiece>`, `pub error: Option<String>`, and methods `initial_choice()`, `waiting_on(piece, &chosen) -> Option<u32>`, `uncheck(piece, &chosen) -> Vec<u32>` and `detail(i, onto_name) -> String`).
  - `Inspection::habit_fits(&mut self, piece: u32, limit: usize) -> Vec<HabitFit { name, description, color: i32, pose: Pose, models, total, links, joint, why }>`
  - `Inspection::fitting_parts(&mut self, piece: u32, candidates: &[String], limit: usize) -> Vec<FittingPart { name, contact: Vec3 }>`
  - `Session::seat_pieces(&self, moves: &[(u32, Pose)], generation: u64, version: u64) -> Changed`
  - `inventory::Inventory::capture(&Session, step: Option<usize>) -> Option<Inventory>` (`Send`)
  - `Inventory::prepare(&mut self, path: &Path) -> InventoryReport { error: Option<String>, pieces, spares, invalid_rows, missing: Vec<String> }`
  - `Session::import_inventory(&self, &Inventory) -> Changed`
  - `CheckKind`: `Overlap`, `Unsupported`, `Tipping`, `SingleConnector`, `MissingDefinition`, `UnknownColour` and `SubmodelLoop`. Its `title()` gives Swift's section names: "Overlaps", "Unsupported Parts", "Unstable Groups", "Single-Connector Attachments", "Missing Definitions", "Unknown Colours", "Submodel Loops".

- [ ] **Step 1: Write `bmffi/tests/inspection_test.cpp`.** It uses the same three-brick session as bmapp's loose-pieces test: 3001 at (0,0,0), (3,−24,0) and (200,0,0).
  - `bm_inspection_loose_pieces` has one row with piece 1, onto 0, safe.
  - After `bm_session_seat_pieces` with that pose, `bm_session_can_undo` is true and a fresh `loose_pieces` is empty.
  - A second session with two 3001s at one position gives an Overlap finding listing both pieces.
- [ ] **Step 2: Write `crates/bm/tests/inspection.rs`** with the same three cases through the Rust wrappers, and `CheckKind::Overlap.title() == "Overlaps"`.
- [ ] **Step 3: Add `inventory_counts_rows`** to the same file. It writes a CSV in Swift's test format (header `"Quantity",Color,Part,Is Spare`; rows `2,4,"3001.DAT",False` / `5,7,3022,yes` / `2,4,brickmotion_unknown_part,false` / `x,1,3001,false`) and runs capture, prepare and import. Expect pieces 2, spares 5, invalid rows 1, missing `["brickmotion_unknown_part"]`, and two more pieces in the session.
- [ ] **Step 4: Run both to see them fail.** Run `cmake --build native/build-rust --target bmffi_tests` and `cargo test -p bm --test inspection`. Expected: unknown functions.
- [ ] **Step 5: Implement** the C functions, the bm-sys declarations, `DECLARED` and the wrappers. Move the header count in `header_and_rust_decls_agree` to the new total.
- [ ] **Step 6: Run** `bmffi_tests`, `cargo test -p bm`, and `nm -gU native/build-rust/bmffi/libbmffi.dylib | awk '{print $3}' | grep -vc '^_bm_'`. Expected: all pass; the `nm` count is 0.
- [ ] **Step 7: Commit:** `feat(bmffi): model checks, loose pieces, habit fits, fitting parts, seat pieces and inventory over the C ABI`.

### Task 4: Model Checks panel

**Files:**
- Create: `desktop/crates/brickmotion/src/chrome/checks_panel.rs`
- Modify: `chrome/mod.rs` (the `editing` list and `show`), `chrome/float_panel.rs` (`PanelKind::Checks` "Model Checks"), `commands.rs`, `app.rs` (run arm, `last_refusal`), `icons.rs`
- Create: `desktop/crates/brickmotion/assets/icons/checks.svg` (a shield with a tick, drawn in our 1.5-px stroke set like `seat.svg`)
- Test: `desktop/crates/brickmotion/tests/inspect.rs` (new)

**Interfaces:**
- Consumes: `Inspection::check_model` (Task 3), `workers::Job<(u64, u64), ModelChecks>`.
- Produces:
  - `pub struct ChecksPanel { pub open: bool, job, result: Option<((u64,u64), ModelChecks)> }`
  - `checks_panel::toggle(app)`
  - `app.last_refusal: Option<String>`: the `refused` text of the last edit refused in `edited()`. Dismiss clears it.

- [ ] **Step 1: Write the tests in `tests/inspect.rs`.** Each writes its own model with `std::fs::write`, following `export.rs` `app_with`.
  - `model_checks_group_findings`: two `3001.dat` at one position. Run `inspect.model_checks`, then step until the panel leaves "Checking the model…". The "Overlaps" heading is shown. Clicking the row's frame button selects both pieces.
  - `model_checks_none`: one brick shows "No Findings" and "The model passed the available geometry and connection checks."
  - `checks_drop_a_stale_result`: start a check, add a piece before polling, then step. The panel shows the new document's result (three pieces in the finding) and never the first one.
  - `checks_close_with_the_document`: open the panel, open another model, step. Assert the panel is closed.
  - `last_refused_edit_shows_and_dismisses`: make an edit the engine refuses (for example `place_part` with a stale version). The "Last Refused Edit" section shows its text, and Dismiss removes it.
- [ ] **Step 2: Run them to see them fail.** `cargo test -p brickmotion --test inspect`. Expected: unknown command `inspect.model_checks`.
- [ ] **Step 3: Implement.**
  - Wiring:
    - `inspect.model_checks` uses `When::Document`, the new icon `Icon::Checks` ("checks"), tab "Inspect" (or the Task 1 ruling) and group "Checks".
    - Opening captures an `Inspection` and starts the job. A changed (generation, version) starts a new one. Reset/close on `adopt()` and `new_document_now()`. Record `last_refusal` in `app.edited()` and `poll_placement` refusals. Highlight ribbon button while open.
  - Copy:
    - while checking: "Checking the model…";
    - on error: "Couldn’t Check the Model" plus the error;
    - section headings in `CheckKind` order.
  - The frame button rests playback, unhides via `session.show(&pieces)`, selects the finding's pieces, and runs `view.frame_selection` (guarded on matching generation/version).
- [ ] **Step 4: Run the tests to see them pass.** `cargo test -p brickmotion --test inspect`. Expected: pass.
- [ ] **Step 5: Commit:** `feat(desktop): Model Checks`.

### Task 5: Seat Loose Pieces panel

**Files:**
- Create: `desktop/crates/brickmotion/src/chrome/loose_panel.rs`
- Modify: `chrome/mod.rs`, `chrome/float_panel.rs` (`PanelKind::Loose` "Seat Loose Pieces"), `commands.rs` (`model.seat_loose` → `When::SeveralPieces`), `app.rs`
- Test: `tests/inspect.rs`

**Interfaces:**
- Consumes: `Inspection::loose_pieces`, `LoosePieces::{initial_choice, waiting_on, uncheck, detail}`, `Session::seat_pieces`.
- Produces: `pub struct LoosePanel { pub open: bool, pub chosen: Vec<u32>, … }`

- [ ] **Step 1: Write the tests.**
  - `seat_loose_seats_in_one_undo`: the three-brick model (3001 at (0,0,0) colour 4, (3,-24,0) colour 1, (200,0,0) colour 14 — or colour 4 on piece 1 so its label is "Seat Red Brick 2 x 4").
    - The panel lists one row. Its accessible label is "Seat Red Brick 2 x 4" (colour name plus display name, as Swift's `name(_:)`) and it is checked.
    - The footer reads "1 of 1 selected". The button reads "Seat Piece".
    - After clicking it, the piece is at y −24, x 0 (verified via `session.copy(&[1])`), and one `edit.undo` puts it back at x 3.
  - `seat_loose_none`: a seated model shows "Every Piece Is Seated".
  - `seat_loose_refuses_stale`: compute, edit the document, then click Seat. Nothing moves and the panel recomputes.
- [ ] **Step 2: Run them to see them fail.** `cargo test -p brickmotion --test inspect seat_loose`. Expected: fail.
- [ ] **Step 3: Implement.**
  - Copy:
    - header subtitle: "Pieces placed a little off their studs, pins or clips, set exactly in place.";
    - while working: "Looking for loose pieces…";
    - a waiting row reads "Seated onto NAME: check it first".
  - Piece names come from `session.part_at(piece)`, `session.part_color(piece)`, `bm::export::display_name`, and `app.colors()`.
  - Row checkboxes call `uncheck` and `waiting_on`; the initial set is `initial_choice`.
  - While computing, a stale in-flight result is dropped and recomputed; once shown, edits leave the shown list until Seat is clicked (so stale Seat refuses via `seat_pieces`, pushes notice via `edited`, leaves pieces unmoved, and starts a fresh check). Reset/close on `adopt()` and `new_document_now()`.
  - The reveal button guards `(generation, version)`, rests playback, calls `session.show(&[row.piece, row.onto])`, selects both, and runs `view.frame_selection`.
  - Seat runs `seat_pieces` with the poses of the chosen rows and the result's (generation, version); on success closes the panel; on refusal recomputes.
- [ ] **Step 4: Run the tests to see them pass.** Expected: pass.
- [ ] **Step 5: Commit:** `feat(desktop): Seat Loose Pieces`.

### Task 6: Compatible Parts (What Fits) panel and the habits table

**Files:**
- Create: `desktop/crates/brickmotion/src/chrome/fits_panel.rs`
- Modify: `chrome/mod.rs`, `chrome/float_panel.rs` (`PanelKind::Fits` "Compatible Parts"), `commands.rs` (`model.what_fits` → `When::OnePiece`), `app.rs`, `support.rs` (`habits_file()`), `main.rs` (set `BM_HABITS`), `desktop/scripts/bundle.sh`
- Test: `tests/inspect.rs`

**Interfaces:**
- Consumes:
  - `Inspection::{habit_fits, fitting_parts}`;
  - `bm::library::{common_parts, library_parts}`;
  - `Session::place_part`;
  - `app.begin_placement_at`;
  - `bm::gizmo::project(camera, view, point) -> Option<Vec2>` (the contact in viewport pixels);
  - `PartPreview` thumbnails, as the Parts tab draws them.
- Produces:
  - `pub fn habits_file() -> PathBuf` in `support.rs`;
  - `app.begin_placement_from(part: PartMatch, at: Option<bm::Vec2>)`: as `begin_placement`, but the ghost starts at `at` (viewport pixels from the top left) when it is given. `begin_placement_at` keeps the centre default.

- [ ] **Step 1: Write the tests.**
  - `fits_lists_builders_and_free_connections`: one `3001.dat`, selected.
    - The panel shows "What Builders Put Here" with at most 8 rows, each detail line starting "In ".
    - Below it is "Fits a Free Connection".
    - Typing "3003" in "Search by part name or number" hides the builders' section.
  - `fit_adds_part_at_pose`: select the first builders' row and click "Add Part". The piece count goes up by one, one undo removes it, and the panel closes.
  - `fit_refuses_a_stale_revision`: compute, edit, then Add Part. The count is unchanged and a notice is shown.
  - `fits_without_habits_table`: set `BM_HABITS` to a missing file (serialized with a process-wide env-var mutex and restored on drop, since Rust 2024 `set_var` is `unsafe` and tests run in parallel) before creating the app. The builders' section is absent, free connections are listed, and there is no notice.
  - `habits_file_prefers_env`: a unit test in `support.rs` (using a pure helper or mutex-guarded env var).
- [ ] **Step 2: Run them to see them fail.** Expected: fail.
- [ ] **Step 3: Implement.**
  - Copy:
    - title: "Compatible Parts"; the subtitle is the target's display name (`bm::export::display_name` of `part_at(piece).description`, falling back to `name`);
    - while loading: "Checking free connections…";
    - empty: "No Matching Parts", with "Search the library for other parts." (no query) or "Try a different name or part number.".
  - Search:
    - It waits 140 ms after the last keystroke, then searches with `library_parts(query, "", 160)`, or `common_parts()` when the query is empty.
    - The candidates are the result names; then call `fitting_parts(piece, &names, 30)` (matching Swift `AssemblyInspectionWorker.fitting`).
  - The default button is "Add Part" for a builders' row, else "Preview Placement".
  - **Add Part** calls `session.place_part(name, color, &pose, step, None, result_gen, result_ver)` and `app.edited(c)`; closes the panel on success (a stale revision leaves count unchanged and shows a notice).
  - **Preview Placement** checks `(generation, version)` matches (otherwise shows a notice), closes the panel, and calls `begin_placement_from` with the part. `at` is the match's contact projected through `bm::gizmo::project(&cam, view, contact)` (already top-left viewport pixels) when finite and inside `(0..view.x, 0..view.y)`, else `None`.
  - `main.rs` sets `BM_HABITS` before creating the app when unset and `support::habits_file()` exists. Reset/close `FitsPanel` on `adopt()` and `new_document_now()`.
- [ ] **Step 4: Bundle the table.** `bundle.sh` copies `public/data/suggest/habits.json` to `Contents/Resources/Suggest/habits.json`. Run `scripts/bundle.sh` and check the file is there.
- [ ] **Step 5: Run the tests to see them pass.** Expected: pass.
- [ ] **Step 6: Commit:** `feat(desktop): Compatible Parts with What Builders Put Here`.

### Task 7: Import Parts Inventory

**Files:**
- Create: `desktop/crates/brickmotion/src/inventory.rs`
- Modify: `commands.rs` (`file.import_inventory` in `Menu::File` after `Open Recent`, matching Swift File menu group 0; `model.inventory` runs the same action), `app.rs` (run arm, `dialog_requests` kind "inventory", `finish_inventory(path)`, polling from `tick_background`, cancel on `adopt()`/`new_document_now()`), `menubar.rs` (insert `file.import_inventory` after `Recent` and update pinned order test)
- Test: `tests/inspect.rs`

**Interfaces:**
- Consumes: `inventory::Inventory`, `Session::import_inventory`, `bm::export::display_name`, `view.frame_selection`.
- Produces: `app.finish_inventory(path: PathBuf)` (the open panel's answer, as `finish_export`); `app.inventory_pending() -> bool`.

- [ ] **Step 1: Write the tests.**
  - `inventory_imports_and_frames`: a clean CSV (`2,4,3001,False`). After `finish_inventory` and stepping until it is no longer pending, there are 2 more pieces, one undo removes them, and there is no notice.
  - `inventory_reports_skipped_rows`: the Task 3 mixed CSV.
    - The notice title is "Imported 2 Parts".
    - The detail is exactly "Unreadable rows: 1\nSpare pieces skipped: 5\nMissing part files: brickmotion_unknown_part".
  - `inventory_nothing_to_import`: a CSV with only spares. The notice is "No Parts to Import" and the document is unchanged.
  - The open panel's title is "Import Parts Inventory" and its message "Choose a Rebrickable CSV or a Studio parts-bin file." It accepts `csv` and `pbg`. Tests see `dialog_requests` kind "inventory".
- [ ] **Step 2: Run them to see them fail.** Expected: fail.
- [ ] **Step 3: Implement.**
  - Capture the inventory with the selected step (ignoring re-entry while `inventory_pending()`), prepare it on a thread (waking the window via `ctx_handle`), then commit on the UI thread if (generation, version) is unchanged.
  - Errors & reports (matching Swift `InventoryImportSheet.swift`):
    - an engine prepare error gives "Couldn’t Import Parts" plus the error;
    - `pieces == 0` gives "No Parts to Import" with details (or "The file contains no part entries." if empty);
    - a stale revision (generation/version changed while reading, or `import_inventory` refused) gives "Couldn’t Import Parts" with "The document changed while the file was read. Import it again.";
    - successful import frames selection (`view.frame_selection`), and if `invalid_rows > 0 || !missing.is_empty()` shows "Imported 1 Part" / "Imported N Parts" with `details`.
  - Detail lines follow Swift's `Summary.details` exactly, with missing names passed through `bm::export::display_name` (stripping `.dat`) and numbers comma-grouped as in Task 2.
- [ ] **Step 4: Run the tests to see them pass.** Expected: pass.
- [ ] **Step 5: Commit:** `feat(desktop): Import Parts Inventory`.

### Task 8: Checks, screenshots and ledger

**Files:**
- Modify: `desktop/docs/m7a-rulings.md` (checks table, by-hand checks), `docs/superpowers/specs/2026-11-19-native-app-parity.md` (rows 36, 142, 149)
- Create: `desktop/docs/m7a-{checks,loose,fits}.png` with an ignored `m7a_screenshots` test in `tests/inspect.rs` (`M7A_SHOTS=<absolute dir>`)

- [ ] **Step 1: Run every suite and record the results** in the M6 table format:
  - `cargo test --workspace`;
  - clippy with `-D warnings`;
  - `bmapp_tests`, `bmffi_tests`;
  - both `ctest` trees;
  - `nm`;
  - `scripts/bundle.sh`, with the habits table in Resources.
- [ ] **Step 2: Write the screenshots** with the absolute path, and check them against the approved mockup. Fix any difference with a test, or rule on it.
- [ ] **Step 3: Update the ledger rows** to say the Rust app has them, and list the by-hand checks:
  - Add Part on a Technic beam;
  - Seat Loose on a real model;
  - a large `.pbg`.
- [ ] **Step 4: Commit:** `docs(desktop): M7a checks and screenshots`.

---

## Milestone 7 split

Each later part needs its own plan, written when its first question is answered:

- **M7b, Suggest and techniques** (Phase 10 §2–§3):
  - Port `src/suggest/engine.ts` (329 lines), `fitsAt.ts` (226), `geometry.ts` (186) and `techniques.ts` (397: 43 techniques and their calculators) to bmapp, with Catch2 tests against the web outputs on shared fixtures.
  - Then the ghost on the placement preview path, with Tab, the backtick key and Esc.
  - First question: are the web's mirror and repeat suggestions wanted as they are?
- **M7c, Generate** (Phase 10 §4):
  - Brickify (`brickify.ts` 383, `voxels.ts` 88, `certify.ts` 193, `priors.ts` 77), then the building and castle seeds (`building.ts` 572, `castle.ts` 682).
  - Remix needs owner answers first:
    - it searches CLIP caption embeddings (`public/data/ai/bricknet_index.*`, about 40 MB, plus 279 MB of decoded models), which may count as the AI phase;
    - the BrickNet terms for shipping the data in the app are unknown.
- **M7d, Booklet instructions** (Phase 10 §5): there is no web UI to match. It needs a design pass with the owner (page layout, parts call-outs, sub-builds, export format) before a plan. The Sagrada teach-build and booklet-solver work may feed it.
