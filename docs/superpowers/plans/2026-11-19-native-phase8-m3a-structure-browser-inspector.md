# Native Phase 8, Milestone 3a: structure editing, browser, inspector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Steps and submodels become editable with undo. The sidebar gets Models and Steps panes, the inspector its Selection, Part and Submodel tabs with colour swatches, the viewport its context menus, and every command is in one registry that drives the menu bar, the context menus and a ⌘K palette.

**Architecture:**
- **bmapp.** Gains whole-def undo records for structure edits, step and submodel commands, a *focus* (open one submodel to edit it alone), and Swift-friendly flat rows for the outline and the steps, made again only when the structure changes.
- **Swift.** One `@Observable` view model per document feeds every pane from snapshots. A command registry replaces the M2 hand-built menus. Panes are SwiftUI inside the existing `NSSplitViewController`.

**Tech Stack:** C++20, Swift 6.3 C++ interop, SwiftUI, AppKit, Metal, CMake + Ninja, Catch2.

**Spec:** `docs/superpowers/specs/2026-11-19-native-phase8-app-shell-design.md`, Milestone 3. Acceptance rows are in `docs/superpowers/specs/2026-11-19-native-app-parity.md`.

**Base:** `8dee1c0`. This plan's review range is `8dee1c0..HEAD`. The M1–M2 range, `8ec6379..8dee1c0`, still has its own whole-branch self-review pending. The owner deferred it, and it is not part of this plan.

**Scope:** Milestone 3 is split in two:
- **M3a**, this plan: structure, browser and inspector.
- **M3b**, which follows: parts, placing and app windows. Its tasks are listed at the end.

The row table below assigns every remaining Phase 8 row.

**Paths:** every path and command in this plan is from the repository root (`/Users/mac/Projects/BrickMotion-Studio`).

## Global Constraints

These are copied from the M1–M2 plan, and still bind:

- macOS 26 minimum; arm64 only; Xcode 26.5 / Swift 6.3 toolchain. `CMAKE_OSX_DEPLOYMENT_TARGET` is `26.0` **for the app target only**.
- **Paths that are not ours.** Never edit, stage or revert these: `native/render/tools/bmview/*`, `native/core/include/bm/plan/timeline.h`, `native/core/src/plan/timeline.cpp`, `native/core/*/plan/legacy*`, `native/film/src/director.cpp`, `native/film/tests/director_test.cpp`, `native/render/tools/common/*`, `native/tests/plan_test.cpp`, `native/tools/bm/cmd_plan.cpp`. Other sessions have uncommitted work there.
- **Committing.** Stage only the files this plan names, by path. Never use `git add -A` or `git add .`. Run `git status --short` before each commit.
- **Branch.** Commit per task on the current branch. Never switch, create or move branches. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Plan schema.** The file schema is kept, and native saves must open in the web app. These are the step and submodel keys the web reads (`src/plan/types.ts:59-84`):
  - a step: `pieces`, `title` (≤ 80 chars, trimmed), `notes` (≤ 1000), `pauseAfter` (seconds, 0–10, one decimal, absent when 0), `pinOrder`, `auto` and `motion`;
  - a submodel: `submodels[name].steps`;
  - an item: `id` and `assembly` (`attachTo`, `after`, `root`, `group`, ...).

  Unknown keys survive, key order included.
- **Undo** spans saves while the document is open, and is not written to the file. **Hiding, selection and focus** are view state: not commands, not undone, not saved.
- **Engine rules.** No ported web logic, and no web bugs reproduced. Where a file field's meaning is fixed by the web reader (`pinOrder` sets `assembly.root` on the step's items, `src/plan/ops.ts:32,166`), native writes the same field, because that is the format.
- **C++ style.** `-Wall -Wextra -Werror` (link `bm_warnings`).
- **What Swift sees.** Swift includes **only** `bmapp/*.h`: plain structs, enums, `std::string`, `std::vector` and integer ids. No templates of our own, no `std::function`, no `bm::`/`bmr::` headers.
- **Tests.** `ctest --test-dir native/build` and `ctest --test-dir native/build-app` both pass after every task, with `BM_LDRAW_DIR=$PWD/public/ldraw`.
- **Verification without input access.** The executor cannot click.
  - Every pane's logic lives in a view model or bmapp call that a test drives: Catch2 for bmapp, and a `--selftest-panes` ctest for Swift.
  - Every pane has a `--snapshot` state. The executor reads each snapshot PNG it makes, and lists what it could not check by hand in the task's commit message.
- **Copy.** Menu and button titles use Mac title case and the ellipsis rule (`…` when a dialog follows). Undo names are "Verb Noun" ("Split Step", "Make Submodel", "Move 3 Pieces to Step 4").

## Review Focus

1. **A structure edit inside a submodel used twice.** Split a step of a def with two uses: both uses' builds change, and undo puts the def back byte-identical in the saved project. Test: Task 1 `step edits in a shared submodel undo exactly`.
2. **Item ids and sibling references across defs.** After Make Submodel, Extract and Move to Model:
   - no model holds two items with the same `id`;
   - no `assembly.attachTo`/`after` points to an item in another model;
   - the web reader opens the result.

   Tests: Task 2 `ids stay unique and references stay inside their model`; Task 10 `import_check.sh` web read.
3. **Undo removes the def you are focused on.** Undoing Make Submodel while that submodel is open sends focus back to its parent. The path is trimmed to defs that still exist, and nothing crashes. Test: Task 3 `undo that removes the focused def falls back`.
4. **The largest model.** On `10030-1` ×4 (12,148 pieces), the outline and the steps rows are made within 50 ms. A move (a drag tick) does not raise `structureVersion`, so the panes do not rebuild. Test: Task 4 `rows are fast on 10030 x4 and a move keeps the structure stamp`.
5. **Typing a step title.** It is one undo step per editing session, not one per keystroke. ⌘Z inside the text field undoes text, not the document. Tests: Task 1 `step fields coalesce while continuing`; Task 7 selftest `title typing is one undo`.

---

## Rows: where every remaining Phase 8 row goes (my call, for the owner to check)

The table covers rows of parity sections 1–6 that are not marked done. "M3a T*n*" is a task here. "Ph 9" means the owner's phase split already moved the row.

| Row (parity §) | Goes to |
|---|---|
| §1 Projects dialog | M3b welcome window |
| §1 Command palette ⌘K | M3a T9 |
| §1 About | M3b (credits panel with the engine version) |
| §1 Quick Look thumbnails (from the open row) | M5 |
| §2 New model / submodule / from selection; New submodel dialog (§5) | M3a T2, T6 |
| §2 Search models; tree rows (open, show and fit, counts) | M3a T6 |
| §2 Tree-row tags (`assembly.group`) | M3b (with Group) |
| §2 Row menu: view parts, open | M3a T6. Play its build: M4. Lay out parts: M4 (staging). Export: Ph 9. Import into: M3b |
| §2 View parts inline (steps tree, per-step show/hide, select, extract, move to step) | M3a T6 |
| §2 Breadcrumb back to main model | M3a T3, T6 |
| §3 Parts Frequent/Common/Recent, search, category; placement hint, mirrored pose; click/drag to add; colour for new parts | M3b |
| §3 Drag onto the timeline Parts lane | M4 |
| §3 Colour swatches (groups, search, recent) | M3a T8 |
| §4 Piece context menu, empty-space menu | M3a T9. Except: "what fits" is Ph 10 (suggest); "turn waiting piece" and "show/lay out step" are M4; "connected" and "touching" are M3b |
| §4 Mouse: drag a piece itself | M3b (needs snapping) |
| §4 Floating selection bar; joint card; tools joints, aim, collision | M3b |
| §4 Ortho, flat-lay, centre on floor, orbit 45°, grid, wire, clay, full screen, zoom %, nav gizmo, view label, hidden and laid-out chips | M5 (viewport chrome) |
| §4 Tool: scale | owner to confirm. Bricks do not scale, so I propose dropping it |
| §4 Renderer select | superseded (one raster viewport); no work |
| §4 Split: lay out every part | M4 (staging) |
| §5 Placing mode; collision-refused red; Part tab's refused reason, checks, connections | M3b |
| §5 Inspector Selection: make submodule, extract, move to model, duplicate, delete, transform fields, part info, model overview | M3a T8 |
| §5 Inspector Selection: fit together, group, ways to fit, marks/tags | M3b |
| §5 Inspector Selection: flies-in-from | M4 |
| §5 Inspector Part: replace, colour, step | M3a T8 |
| §6 Step list: show all, drag reorder, edit, expand submodels; step editor (title, notes, pause, piece order, split, gather, merge); step menu (select, pin order, gather, insert, move, delete) | M3a T5, T7 |
| §6 Auto-split banner; play a step; step callout | M4 |

---

## File structure

```
native/app/bmapp/include/bmapp/types.h      + Edit kinds, StepFields, StepRow, ItemRow, OutlineRow, ColorInfo, Similar; Changed.refused
native/app/bmapp/include/bmapp/session.h    + step, submodel and focus commands; rows; colours; selectSimilar
native/app/bmapp/src/commands.h/.cpp        + DefChange record; step and submodel commands
native/app/bmapp/src/structure.cpp          (new) re-expressing items between defs, id and reference repair
native/app/bmapp/src/rows.cpp               (new) outline, steps and item rows, colours
native/app/bmapp/src/session.cpp, session_impl.h   focus, structure stamp
native/core/include/bm/doc/source.h, native/core/src/doc/source.cpp   + flatten from a named def
native/app/bmapp/tests/structure_test.cpp, submodel_test.cpp, focus_test.cpp, rows_test.cpp
native/tests/doc_source_test.cpp            + flatten-from-def case
native/app/BrickMotion/Commands.swift       (new) the command registry and menu builder
native/app/BrickMotion/DocumentModel.swift  (new) @Observable per-document view model
native/app/BrickMotion/Sidebar.swift, ModelsPane.swift, StepsPane.swift, StepEditor.swift   (new)
native/app/BrickMotion/Inspector.swift, ColorSwatches.swift                                (new)
native/app/BrickMotion/PieceMenu.swift, CommandPalette.swift, Breadcrumb.swift             (new)
native/app/BrickMotion/SelftestPanes.swift  (new) --selftest-panes
native/app/BrickMotion/Placeholders.swift   (deleted)
native/app/BrickMotion/AppDelegate.swift, WindowController.swift, ViewportView.swift, EditCommands.swift, Snapshot.swift, HeadlessSave.swift, main.swift   (modify)
native/app/CMakeLists.txt                   + brickmotion_selftest_panes, snapshot states
native/app/tests/import_check.sh            + structure edits, web reader
```

---

## Task 1: Whole-def undo records and step commands

**Files:**
- Modify: `native/app/bmapp/src/commands.h`, `native/app/bmapp/src/commands.cpp`, `native/app/bmapp/include/bmapp/types.h`, `native/app/bmapp/include/bmapp/session.h` and `native/app/bmapp/src/session.cpp`.
- Test: `native/app/bmapp/tests/structure_test.cpp`.

**Interfaces:**
- Consumes: M2's `Command`, `push`, `apply`, `finish` and `reflatten` (`commands.cpp:189-290`).
- Produces:
  - `struct DefChange { std::string name; size_t position = 0; std::optional<bm::doc::Def> before, after; };` and `Command::wholeDefs` (`std::vector<DefChange>`). Root is `name == ""`; `position` is ignored for the root.
    - **Apply forward**, in the order listed:
      - both present: replace the def's content;
      - only `after`: insert it into `submodels` at `position`;
      - only `before`: erase it.
    - **Undo** walks the same list in reverse, with the roles swapped.
    - Any `wholeDefs` makes the command structural.
  - `types.h`:
    - Add `Edit` kinds: `AddStep, DeleteStep, MoveStep, SplitStep, MergeSteps, StepFields, MoveToStep, ReorderInStep`.
    - Add `struct StepFields { std::string title, notes; double pauseAfter = 0; bool pinOrder = false; };`.
    - Add `Changed::refused` (`std::string`): non-empty means nothing changed and no undo step was made, and it holds the reason to show.
  - `Session`. Every method acts on the **focused def**, which is the root until Task 3:
    - `Changed insertStep(size_t at)`
    - `Changed deleteStep(size_t at)`
    - `Changed moveStep(size_t from, size_t to)`
    - `Changed splitStep(size_t at, const std::vector<uint32_t>& pieces)`
    - `Changed mergeSteps(size_t first)`
    - `Changed setStepFields(size_t at, const StepFields& f, bool continuing)`
    - `Changed moveToStep(const std::vector<uint32_t>& pieces, size_t step)`
    - `Changed reorderInStep(size_t step, size_t from, size_t to)`
    - `StepFields stepFields(size_t at) const`
    - `size_t stepCount() const`

- [ ] **Step 1: Write the failing tests** in `structure_test.cpp`. Use the four-brick grid of `selection_test.cpp`, with steps added: write a plan JSON fixture inline with two root steps and a submodel `Pair` (two bricks, two steps) used twice.
  - `insert, delete, move steps and undo`:
    - `insertStep(1)`: `stepCount()` goes from 2 to 3, and the undo name is `"Insert Step"`.
    - `deleteStep(0)` on a step with pieces: its pieces join step 1 at its front, and the notes are joined with `\n`.
    - `deleteStep` on the only step with pieces: `refused == "A model needs at least one step."` and the version is unchanged.
    - `moveStep(0, 1)`, then undo: `projectBytes()` equals what it was before, byte for byte.
  - `split and merge`:
    - `splitStep(0, {piece of item 1})`: step 0 keeps the other items in order, and step 1 holds the chosen ones. Undo name `"Split Step"`.
    - `mergeSteps(0)` puts it back as one step whose title is step 0's. Undo name `"Merge Steps"`.
    - A split with no pieces of that step is refused.
  - `step fields coalesce while continuing`:
    - `setStepFields(0, {title "A"}, false)`, then `{"Ab"}` and `{"Abc"}` with `continuing = true`, then `endGesture()`, give one undo step named `"Edit Step"`.
    - The saved JSON has `"title": "Abc"`.
    - A `pauseAfter` of 12.34 is saved as `10`. `0.25` is saved as `0.3`. `0` leaves the key out.
    - A title longer than 80 chars is cut to 80.
  - `pin order marks the items`:
    - `pinOrder = true` writes `"pinOrder": true` on the step and `assembly.root: true` on each of its items.
    - Turning it off removes both. If `assembly` is left empty, it is removed.
  - `move pieces to step`:
    - `moveToStep({piece in step 0}, 1)` appends the item at the end of step 1. Undo name `"Move Piece to Step 2"`, counted from 1 for people.
    - A piece inside a use moves its use item, when the whole use is selected.
    - A piece inside a shared def is refused: `"Pieces inside a submodel move with it. Open the submodel to change its steps."`
  - `reorder in step`: `reorderInStep(0, 0, 1)` swaps two items, and undo restores them.
  - `step edits in a shared submodel undo exactly`. This needs Task 3's focus, so write it now and mark it `[!mayfail]` until Task 3, or call the command layer directly with the def name. Split a step of `Pair`: the flattened piece count is unchanged, both uses' builds change, and undo restores `projectBytes()` exactly.
- [ ] **Step 2: Run** `cmake --build native/build-app && native/build-app/app/bmapp_tests "[structure]"`. Expected: FAIL to compile, because the methods are missing.
- [ ] **Step 3: Implement.**
  - Add `DefChange` to `Command`, and extend `apply` and `structural`.
  - Each step command builds the new def from a copy of the old, then pushes a `Command` with one `DefChange{def, _, before, after}`.
  - `setStepFields` with `continuing` grows the open command: it replaces the `after`, keeps the first `before`, and keeps `open = true`, as M2's drags do.
  - Field rules (trim, clamp, round, drop empty) live in one function, `normalize(StepFields)`.
  - `Session` methods call these and append `Changed` to `changes`, as the M2 methods do.
- [ ] **Step 4: Run** the same command. Expected: PASS, except the `[!mayfail]` shared case. Then run the whole of `ctest --test-dir native/build-app`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(app): step commands with whole-def undo`.

## Task 2: Submodel commands

**Files:**
- Create: `native/app/bmapp/src/structure.cpp` (+ `structure.h`, internal).
- Modify: `commands.h/.cpp`, `types.h`, `session.h/.cpp`.
- Test: `native/app/bmapp/tests/submodel_test.cpp`.

**Interfaces:**
- Consumes: Task 1's `DefChange`, `Changed::refused` and `push`.
- Produces:
  - `Edit` kinds `NewSubmodel, MakeSubmodel, Extract, MoveToModel, RenameSubmodel, DeleteSubmodel`.
  - `Session` methods:
    - `std::string freeSubmodelName(const std::string& preferred) const`: `preferred`, else `"<preferred> 2"`, `3`, … The first that is free.
    - `Changed newSubmodel(const std::string& name)`: an empty def with one empty step, used nowhere. It is listed in the outline as unused.
    - `Changed makeSubmodel(const std::vector<uint32_t>& pieces, const std::string& name)`
    - `Changed extract(uint32_t piece)`: dissolves the use that holds `piece`.
    - `Changed moveToModel(const std::vector<uint32_t>& pieces, const std::string& def)`
    - `Changed renameSubmodel(const std::string& from, const std::string& to)`
    - `Changed deleteSubmodel(const std::string& def)`
  - `structure.h`, which is internal:
    - `bm::doc::Placement reexpress(const Placement& world, const Xform& into, const Box& body)` returns a grid placement when the result lands on the grid (studs and plates, a 90° turn about y), and exact otherwise.
    - `void repairIds(std::vector<Item>& moving, const bm::doc::Def& into)`
    - `void dropForeignRefs(std::vector<Item>& items, const std::set<std::string>& idsHere)`

**Rules:**
- **Make Submodel.**
  - The items of the focused def that hold `pieces` (a whole use counts as its use item) move into a new def, `name`. They keep their old step grouping: one step per old step that held any, in order. The new def keeps the items' `id` and `extra`.
  - One use of the new def replaces them, at the anchor: the minimum corner of their boxes, snapped down to the stud and plate grid. It goes in the earliest step that held any of them, at the first one's index.
  - World placements are unchanged to 1e-6 LDU.
  - Refused with `"Choose at least two pieces."` for fewer than two items.
- **Extract.**
  - The use's def's items are placed in the parent, re-expressed through the use, in the use's step at its index, in the def's step order. Their ids are made unique in the parent (`repairIds` appends `-2`, `-3`, …, and remaps `attachTo`/`after` among the moved items).
  - The def is kept even when it is now unused.
  - Refused when `piece` is in the focused def itself.
- **Move to Model.**
  - Items move to the target def's last step, re-expressed through the target's first use in the focused tree.
  - Refused when the target has no use in the focused tree, when the target is (or holds) the def the items come from, or when a piece left behind references a moving one (`attachTo`/`after`). The reason names the piece.
  - References from moving items to items left behind are dropped (`dropForeignRefs`).
- **Rename.** Every use and the focus path are renamed. Refused when `to` exists, is empty, or ends in `.dat`.
- **Delete.** Refused while the def is used: `"<name> is used 2 times. Remove its uses first."`.
- **Undo names:** `"New Submodel"`, `"Make Submodel"`, `"Extract <name>"`, `"Move 3 Pieces to <name>"`, `"Rename <name>"`, `"Delete <name>"`.

- [ ] **Step 1: Write the failing tests** in `submodel_test.cpp`:
  - `make submodel keeps every world placement`:
    - On the helicopter (`samples/helicopter/helicopter.mpd`), take 6 pieces of the root and run `makeSubmodel(pieces, freeSubmodelName("Submodel"))`.
    - Every piece's `model.pieces()[i].world` matches its old value within 1e-6, found by part and colour order.
    - The piece count is unchanged.
    - Undo gives `projectBytes()` identical to before.
  - `extract inverts make`: Make, then `extract` on one of its pieces. The world placements match, and the def remains listed.
  - `ids stay unique and references stay inside their model`:
    - Use a plan fixture with item ids `a`, `b` and `c` in the root, where `b` has `assembly.attachTo = "a"` and `c` has `after: ["b"]`. Make a submodel from `{a, b}`.
    - The new def holds `a` and `b`, and `b` still points to `a`.
    - `c`'s `after` no longer names `b`, since `b` is not in the root now. Assert on the JSON.
    - `extract` of a use whose def is also used elsewhere: the extracted ids get `-2` and are unique in the root.
  - `move to model re-expresses and refuses loops`:
    - Move a root piece into `Pair`, used twice. Its world placement under the first use is unchanged, and a second piece appears under the second use (count +2).
    - Moving `Pair`'s own use into `Pair` is refused.
  - `rename and delete`:
    - Rename `Pair` to `Twin`: both uses now name `Twin`, and the saved `submodels` has `Twin` in `Pair`'s place (order kept).
    - Renaming to an existing name is refused.
    - Delete while used is refused. Delete after `newSubmodel("Spare")` works, and undo brings it back at the same position.
- [ ] **Step 2: Run** `native/build-app/app/bmapp_tests "[submodel]"`. Expected: FAIL to compile.
- [ ] **Step 3: Implement** in `structure.cpp` and `commands.cpp`.
  - Every submodel command is a set of `DefChange`s. The focused def, the target def, and every def whose uses are renamed are swapped whole.
  - Pin grid-placed uses with M2's `pinUses` before an edit changes a def's box.
- [ ] **Step 4: Run** `[submodel]`, then the full app ctest. Expected: PASS.
- [ ] **Step 5: Commit** `feat(app): make, extract, move to, rename and delete submodels`.

## Task 3: Focus: open a submodel to edit it alone

**Files:**
- Modify: `native/core/include/bm/doc/source.h` and `native/core/src/doc/source.cpp`. Add one overload only; other sessions' files are not touched.
- Modify: `session.h`, `session.cpp`, `session_impl.h` and `commands.cpp`.
- Test: `native/tests/doc_source_test.cpp` (+1 case) and `native/app/bmapp/tests/focus_test.cpp`.

**Interfaces:**
- Produces:
  - `bm::doc::Flat flatten(const Source&, const ldraw::Library&, ldraw::PartCache&, const std::string& rootDef)`. `""` is the existing behaviour. A def name flattens that def as the model, at identity.
  - `Session`:
    - `Changed focus(const StringList& path)`. `path` is the def names from below the root down to the def to edit; `{}` is the root. It is structural, the selection is cleared, and there is no undo step.
    - `StringList focusPath() const`
    - `std::string focused() const`
  - `Snapshot::focus` (`std::string`), the focused def's name or `""`.

**Rules:**
- Every M2 and Task 1–2 command that said "the root" now means the focused def: paste's last step, `usePieces`' use, and step commands.
- After any command, the focus path is trimmed to its longest prefix of defs that still exist and are still used along the path. A trimmed path reflattens.
- Renaming a def on the path renames it there.

- [ ] **Step 1: Write the failing tests:**
  - `doc_source_test`: `flatten from a named def`. A two-level MPD flattened from its submodel has the submodel's piece count, and the first piece sits at the def's own placement.
  - `focus_test`:
    - `focus shows one submodel`: on the Task 1 fixture, `focus({"Pair"})` gives a piece count of 2 and `Snapshot.focus == "Pair"`. `insertStep(0)` changes `Pair`'s steps.
    - `undo that removes the focused def falls back`: make a submodel, `focus` it, then `undo()` (the def is gone). `focusPath()` is empty, the piece count is the root's, and there is no crash.
    - `rename on the path`: `renameSubmodel("Pair", "Twin")` while focused gives `focusPath() == {"Twin"}`.
    - Run the `[!mayfail]` case from Task 1 again and remove its tag.
- [ ] **Step 2: Run** `ctest --test-dir native/build -R doc_source` and `bmapp_tests "[focus]"`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `Impl::focus` (`StringList`). `reflatten` calls the new overload with `focus.back()` (or `""`). Trim the path in `finish` before reflattening.
- [ ] **Step 4: Run** both suites in both trees. Expected: PASS, and the Task 1 shared-def case now passes.
- [ ] **Step 5: Commit** `feat(app): focus on a submodel to edit it alone`.

## Task 4: Outline, step and item rows; colours

**Files:**
- Create: `native/app/bmapp/src/rows.cpp`.
- Modify: `types.h`, `session.h`, `session.cpp` and `session_impl.h`.
- Test: `native/app/bmapp/tests/rows_test.cpp`.

**Interfaces:**
- Produces, in `types.h`, all flat with no nested types:
  - `struct OutlineRow { std::string id, def, name; int depth = 0; int parent = -1; size_t pieces = 0, uses = 0; bool shared = false, unused = false; uint64_t useItem = 0; }`
    - `id` is the chain of use `ItemId`s from the root, joined by `/` (`"root"` for the root, `"unused/<name>"` for an unused def). It is stable across edits that keep those items.
    - Rows are in depth-first file order. The root comes first, then every use. Unused defs come last, at depth 0.
  - `struct StepRow { size_t index = 0; std::string title, notes; double pauseAfter = 0; bool pinOrder = false, automatic = false; size_t items = 0, pieces = 0; }`
  - `struct ItemRow { uint64_t item = 0; std::string name, description, colorName; int color = 16; bool submodel = false; size_t step = 0, index = 0; std::vector<uint32_t> pieces; }`
  - `enum class Similar { Part, Color, PartAndColor, Step }`
  - `struct ColorInfo { int code = 0; std::string name; uint32_t rgb = 0; float alpha = 1; int group = 0; }`. `group`: 0 solid, 1 transparent, 2 metallic (chrome, pearl, metal), 3 other.
- And in `Session`:
  - `uint64_t structureVersion() const`: raised only by a structural `Changed` or a focus change.
  - `std::vector<OutlineRow> outline() const`
  - `std::vector<StepRow> steps() const`, for the focused def
  - `std::vector<ItemRow> stepItems(size_t step) const`
  - `std::vector<uint32_t> piecesOfRow(const std::string& outlineId) const`
  - `std::vector<uint32_t> piecesOfStep(size_t step) const`
  - `void selectSimilar(Similar kind)`: from the current selection, among pieces that are not hidden.
  - `std::vector<ColorInfo> colors() const`: sorted by group, then code. Code 16 and code 24 are left out.

  `outline()` and `steps()` are cached by `structureVersion`.

- [ ] **Step 1: Write the failing tests** in `rows_test.cpp`:
  - `outline lists uses with stable ids`:
    - On the helicopter, the root row is first with depth 0, and every use row's `parent` points to an earlier row.
    - The sum of the depth-1 rows' `pieces` plus the root's own loose pieces equals `pieceCount()`.
    - After `move()`, the row ids are unchanged.
    - After `makeSubmodel`, the ids of rows not involved are unchanged.
  - `steps and items match the file`: step titles and item counts match the Task 1 fixture. `stepItems(0)[k].pieces` are the pieces those items made.
  - `select similar`: on the grid, select piece 0 (red 3001) and `selectSimilar(Part)`; all four 3001 pieces are selected. `Color`: only piece 0.
  - `colors are grouped`: code 4 is in group 0, named "Red". Code 36 is in group 1. Code 383 (chrome silver) is in group 2.
  - `rows are fast on 10030 x4 and a move keeps the structure stamp` (tag `[.slow]`, run explicitly):
    - Open the ×4 model that `native/app/tests/bench_app.sh` makes. Build it with `native/build/render/bmshot … --repeat 2x2 --save-model`, as that script does, into the test's temp directory.
    - `outline()` and `steps()` each take ≤ 50 ms (`std::chrono::steady_clock`, best of 3).
    - Then `move({0}, {20,0,0}, false)` leaves `structureVersion()` unchanged.
- [ ] **Step 2: Run** `bmapp_tests "[rows]"` and `bmapp_tests "[rows][.slow]"`. Expected: FAIL to compile.
- [ ] **Step 3: Implement** in `rows.cpp`:
  - Walk `source` once with a use stack.
  - Piece counts come from `piecesOf`.
  - Descriptions come from the library's part header (cached per part name).
- [ ] **Step 4: Run** both. Expected: PASS. Record the 10030 ×4 times in the commit message.
- [ ] **Step 5: Commit** `feat(app): outline, step and item rows, colours, select similar`.

## Task 5: The command registry

**Files:**
- Create: `native/app/BrickMotion/Commands.swift` and `native/app/BrickMotion/SelftestPanes.swift`.
- Modify: `AppDelegate.swift` (menus built from the registry), `EditCommands.swift`, `ViewportView.swift`, `main.swift` and `native/app/CMakeLists.txt` (add `add_test(NAME brickmotion_selftest_panes COMMAND $<TARGET_FILE:BrickMotion> --selftest-panes ${CMAKE_SOURCE_DIR}/../samples/helicopter/helicopter.mpd)`).

**Interfaces:**
- Produces (Swift):

```swift
@MainActor struct AppCommand: Identifiable {
  let id: String                 // "edit.duplicate"
  let title: String              // "Duplicate"
  let symbol: String?            // SF Symbol
  let key: String                // key equivalent, "" for none
  let modifiers: NSEvent.ModifierFlags
  let menu: MenuPlace            // .file, .edit, .object, .view, .step, .submodel, .none
  let group: Int                 // separators fall between groups
  let titleFor: ((CommandContext) -> String)?   // "Undo Move Piece"
  let enabled: (CommandContext) -> Bool
  let run: (CommandContext) -> Void
}
@MainActor struct CommandContext { let document: Document?; let viewport: ViewportView?; let clickedPiece: UInt32? }
@MainActor enum Registry {
  static var all: [AppCommand] { get }
  static func command(_ id: String) -> AppCommand?
  static func menu(_ place: MenuPlace) -> NSMenu
  static func contextMenu(_ ids: [String?], context: CommandContext) -> NSMenu  // nil = separator
}
```

- Every M2 menu command moves onto the registry with its key: cut, copy, paste, duplicate, delete, select all and none, hide, hide others, show all, rotate, raise, lower, make unique, replace part, fit all, frame selection, the view presets and Export LDraw.
  - System-owned items (Undo/Redo responder chain, About, Hide, Quit, New/Open/Save/Close/Duplicate/Rename/Revert/Versions) stay `NSDocument`/`NSApplication` selectors, but are listed in the registry with `run` sending the same selector, so the palette can show them.
- The registry also adds the Task 1–3 commands:
  - Step menu: Insert Step Before, Insert Step After, Delete Step, Split Step at Selection, Merge with Next Step, Move to Step…, Pin Order.
  - Object menu: New Submodel…, Make Submodel from Selection… (⌥⌘G), Extract, Move to Model…, Open Submodel (⌘↓), Back to Parent (⌘↑).
  - Select ▸: Same Part, Same Colour, Same Part and Colour, Same Step.
- `--selftest-panes <file>` runs these checks, then exits 0 or prints the failure and exits 1:
  1. Every item in the main menu has an action whose command is in the registry, or is a system item on the allow-list.
  2. No two commands share a key and modifier set.
  3. Running `object.makeSubmodel` with three selected pieces gives the undo name `"Make Submodel"`.

  Later tasks add their checks to this file.

- [ ] **Step 1: Write** `SelftestPanes.swift` with checks 1–3 and the CMake test. **Run** `cmake --build native/build-app && ctest --test-dir native/build-app -R selftest_panes`. Expected: FAIL (the flag is unknown).
- [ ] **Step 2: Implement** the registry and `Registry.menu`. Replace `AppDelegate`'s hand-built File, Edit, Object and View menus with registry calls, adding Step and Submodel items. Validation (`NSMenuItemValidation`) asks `enabled`, and `titleFor` drives dynamic titles.
- [ ] **Step 3: Run** the selftest and `brickmotion_selftest_edit` (M2's keys must still work). Expected: PASS. Run the full app ctest.
- [ ] **Step 4: Snapshot** `--snapshot $TMP/menus.png --open samples/helicopter/helicopter.mpd`. Read the PNG; the window must be unchanged from M2.
- [ ] **Step 5: Commit** `feat(app): one command registry drives every menu`.

## Task 6: Document view model, sidebar, Models pane and breadcrumb

**Files:**
- Create: `DocumentModel.swift`, `Sidebar.swift`, `ModelsPane.swift` and `Breadcrumb.swift`.
- Delete: `Placeholders.swift`.
- Modify: `WindowController.swift`, `ViewportView.swift` (breadcrumb overlay, double-click opens a submodel), `Snapshot.swift` (`--sidebar models|steps`, `--focus Name[/Name]`, `--expand all`) and `SelftestPanes.swift`.

**Interfaces:**
- Consumes: Task 4 rows, Task 3 `focus` and Task 5 `Registry`.
- Produces:

```swift
@MainActor @Observable final class DocumentModel {
  init(document: Document)
  private(set) var snapshot: bmapp.Snapshot       // refreshed on Document.didChange
  private(set) var outline: [OutlineNode]         // rebuilt only when structureVersion changes
  private(set) var steps: [bmapp.StepRow]         // same
  var outlineQuery: String                        // filters by name, keeps ancestors
  func select(row: OutlineNode, extend: Bool)
  func open(row: OutlineNode)                     // focus to that def's path
  func back()                                     // pop one level of focus
}
struct OutlineNode: Identifiable { let id: String; let row: bmapp.OutlineRow; var children: [OutlineNode]? }
```

- `Sidebar` is a navigator with Models and Steps tabs (SF Symbols `cube`, `list.number`), plus a Parts tab placeholder that reads "Parts arrive in the next milestone" and is replaced in M3b.
- The Models pane:
  - `List` with `OutlineGroup` over `outline`, using `.searchable` on `outlineQuery`.
  - Each row shows its name, a piece-count badge, a `square.on.square` mark for shared defs, and "Unused" in secondary text.
  - Single click selects the row's pieces. Double click or Return opens the def. Type-select works.
  - Row context menu: Open, Show and Fit (selects, then frames), Select Pieces, Rename… (inline), New Submodel…, Make Submodel from Selection…, Delete (enabled only when unused).
  - Below the tree, a "Parts in <focused>" disclosure lists steps and their items (`stepItems`). Each step has an eye toggle (hide or show its pieces) and the menu Select, Extract, Move to Step ▸.
  - Dragging a row onto another row runs `moveToModel` for that row's use pieces. If it is refused, the reason shows as an alert sheet.
- The breadcrumb is a glass capsule at the viewport's top left: `Main ▸ Rotor ▸ Blade`. Each part is a button that focuses there. It is hidden at the root.
- `--selftest-panes` adds these checks:
  - The outline row count equals `session.outline().count`.
  - `open(row "Rotor")` gives `snapshot.focus == "Rotor"`, and `back()` returns to root.
  - With a query, only matching rows and their ancestors remain.
  - A `move` does not rebuild `outline`: count `DocumentModel`'s outline builds.

- [ ] **Step 1: Write the selftest checks.** Run them. Expected: FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the selftest and the full app ctest. Expected: PASS.
- [ ] **Step 4: Snapshot** these two states, in light and dark:
  - `--sidebar models --expand all --open samples/helicopter/helicopter.mpd`
  - `--sidebar models --focus <a submodel name from the outline>`

  Read each PNG: the tree has counts, and the breadcrumb shows when focused. Send the light, expanded PNG to the owner with `SendUserFile`.
- [ ] **Step 5: Commit** `feat(app): models browser, open a submodel, breadcrumb`.

## Task 7: Steps pane and step editor

**Files:**
- Create: `StepsPane.swift` and `StepEditor.swift`.
- Modify: `Sidebar.swift`, `Snapshot.swift` (`--sidebar steps --edit-step N`) and `SelftestPanes.swift`.

**Interfaces:**
- Consumes: `DocumentModel.steps`; Task 1 commands through the registry.
- Produces:
  - `StepsPane`: a `List` of the focused def's steps.
    - Each row shows "Step n", the title (if any), the item and piece counts, a pause badge (`pause.circle` and seconds), a pin badge, and "auto" in secondary text.
    - Drag reorders, through `moveStep`.
    - Selecting a row selects its pieces.
    - Row context menu, from the registry: Select Pieces, Insert Step Before, Insert Step After, Split at Selection, Merge with Next, Gather Selection Here (`moveToStep`), Pin Order (checkmark), Edit…, Delete.
  - `StepEditor`, a popover from Edit… or a double click:
    - fields: Title (`TextField`), Notes (`TextEditor`), and Pause After (`Stepper` with a field, 0–10 s, 0.1 steps);
    - a "Piece order" list with drag to reorder (`reorderInStep`);
    - Split and Merge buttons.
  - Typing commits through `setStepFields(…, continuing: true)` debounced at 0.4 s. Closing the popover calls `endGesture()`.
  - The text fields keep their own undo: the popover's first responder handles ⌘Z while editing.
- `--selftest-panes` adds these checks:
  - `title typing is one undo`: simulate three `setStepFields` calls from the editor's view model, then close. `undoName == "Edit Step"`, and one `undo()` restores the old title.
  - Dragging step 0 to position 2 in the view model gives `undoName == "Move Step"`.

- [ ] **Step 1: Write the selftest checks.** Expected: FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the selftest and the full app ctest. Expected: PASS.
- [ ] **Step 4: Snapshot** `--sidebar steps` and `--sidebar steps --edit-step 0` on the helicopter. Read both.
- [ ] **Step 5: Commit** `feat(app): steps list and step editor`.

## Task 8: Inspector tabs and colour swatches

**Files:**
- Create: `Inspector.swift` and `ColorSwatches.swift`.
- Modify: `WindowController.swift`, `Snapshot.swift` (`--inspector selection|part|submodel`) and `SelftestPanes.swift`.

**Interfaces:**
- Consumes: `snapshot.selected` (`PieceInfo`), `session.colors()`, `summarize`, and registry commands.
- Produces an `Inspector` with segmented tabs Selection, Part and Submodel:
  - **Selection** (two or more pieces):
    - the count and the distinct parts with counts;
    - a colour swatch row (recolour all);
    - a Step picker (`moveToStep`), showing "Mixed" when the steps differ;
    - buttons: Make Submodel…, Move to Model… (a menu of defs), Extract (enabled for a whole use), Duplicate, Delete;
    - a model overview when nothing is selected: the focused def's name, pieces, steps and submodels.
  - **Part** (one piece):
    - the part number and description, with a rendered thumbnail in M3b and an SF Symbol until then;
    - colour, with a swatch popover;
    - the step picker;
    - the submodel path, with "Open" buttons;
    - a shared-submodel note with a Make Unique button when `inSharedSubmodel`;
    - Replace Part… ;
    - transform fields X, Y and Z (LDU, numeric, which commit `move` with the difference) and Turn (90° buttons).
  - **Submodel** (the focused def, or the def of the selected use):
    - the name (rename on commit);
    - uses, pieces and steps;
    - Open, and Select Uses.
  - `ColorSwatches`:
    - a grid of swatches grouped Solid, Transparent (checkerboard behind) and Metallic (a sheen);
    - search by name or code;
    - Recent (the last 8 used, `UserDefaults` `recentColors`) at the top;
    - each swatch has its name as its tooltip and VoiceOver label.

    Clicking recolours the selection (`recolor`) and records the colour as recent.
- `--selftest-panes` adds these checks:
  - Choosing swatch 4 through the swatches view model with two pieces selected gives `undoName == "Recolour 2 Pieces"` and puts 4 first in recent.
  - Typing X + 20 in the Part tab's view model moves the piece 20 LDU, as one undo.

- [ ] **Step 1: Write the selftest checks.** Expected: FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the selftest and the full app ctest. Expected: PASS.
- [ ] **Step 4: Snapshot** each tab, with `--select` giving one piece for Part and three for Selection, in light and dark. Read them, and send the Part tab (light) to the owner.
- [ ] **Step 5: Commit** `feat(app): inspector tabs and colour swatches`.

## Task 9: Context menus and the ⌘K palette

**Files:**
- Create: `PieceMenu.swift` and `CommandPalette.swift`.
- Modify: `ViewportView.swift` (`menu(for:)`), `AppDelegate.swift` (the palette item ⌘K in View), `Snapshot.swift` (`--palette "query"`) and `SelftestPanes.swift`.

**Interfaces:**
- Consumes: `Registry`.
- Produces:
  - **Piece menu** (right-click or ⌃-click on a piece). A piece outside the selection is selected first. Items:
    - Frame Selection, Open Submodel;
    - Move to Step ▸ (the steps), Rotate 90°, Raise, Lower;
    - Cut, Copy, Paste, Duplicate;
    - Colour ▸ (the recent colours, then "Use This Colour", which sets it as the colour for new parts in M3b and recent for now);
    - Hide, Hide Others;
    - Select ▸ Same Part, Same Colour, Same Part and Colour, Same Step, All;
    - Make Submodel from Selection…, Extract, Make Unique;
    - Delete.

    All items are registry ids.
  - **Empty-space menu:** Paste, Select All, Show All, Fit All, the view presets ▸, New Submodel….
  - **`CommandPalette`**, opened with ⌘K:
    - a floating glass `NSPanel` over the window, 560 pt wide, with a search field and a result list;
    - results come from the registry's enabled commands, plus "Open <submodel>" for each def, plus "Go to Step n";
    - each row shows its symbol, its title and its shortcut, right-aligned;
    - fuzzy matching: subsequence over the title, scored by consecutive runs and word starts, and recent picks first when the query is empty;
    - Return runs the result, Esc closes, ↑↓ move.
  - `func paletteMatches(_ query: String, in items: [PaletteItem]) -> [PaletteItem]`, a pure function that the selftest calls.
- `--selftest-panes` adds these checks:
  - `paletteMatches("msub")` ranks "Make Submodel from Selection…" first.
  - `"dup"` ranks Duplicate first.
  - Every palette item's shortcut text equals its menu item's.
  - The piece menu for a clicked piece has no item whose id is missing from the registry.

- [ ] **Step 1: Write the selftest checks.** Expected: FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the selftest and the full app ctest. Expected: PASS.
- [ ] **Step 4: Snapshot** `--palette "sub"` on the helicopter. Read it.
- [ ] **Step 5: Commit** `feat(app): piece and empty-space menus, command palette`.

## Task 10: Web round trip, measurements and docs

**Files:**
- Modify: `native/app/BrickMotion/HeadlessSave.swift` (`--edit-structure`), `native/app/tests/import_check.sh`, `native/README.md` ("Phase 8 M3a results"), `docs/superpowers/specs/2026-11-19-native-app-parity.md` (rows marked) and this plan (status note).

**Interfaces:**
- `--edit-structure` applies these, in order, through the session:
  1. `makeSubmodel(first 3 root pieces, "Sub")`
  2. `insertStep(0)`
  3. `setStepFields(0, title "Base", pauseAfter 1.5)`
  4. `moveToStep({piece 0}, 0)`
  5. `renameSubmodel("Sub", "Sub A")`

  Then it saves.

- [ ] **Step 1: Extend** `import_check.sh`. After the existing check, run `--open … --edit-structure --save-to "$work/structure.brickmotion"`. Then:
  - Python asserts `plan.submodels["Sub A"]` exists with 3 items, `plan.steps[0].title == "Base"` and `pauseAfter == 1.5`.
  - No model has duplicate item ids.
  - When `node_modules/.bin/tsx` exists, a three-line tsx script calls `readProjectFile` (`src/io/projectFile.ts`) on it and prints the piece count, which must equal the app's `--open` count. If tsx is missing, the script prints `import_check: web reader skipped (no node_modules)` and still passes.

  Run it. Expected: FAIL (the flag is unknown).
- [ ] **Step 2: Implement** `--edit-structure`. **Run** `ctest --test-dir native/build-app -R import_check`. Expected: `import_check: ok`, with the web reader line printed (not skipped) on this machine.
- [ ] **Step 3: Measure and document.**
  - Measure the `[rows][.slow]` times, and the time from "Open Submodel" to first frame on the helicopter (`--bench-open` with `--focus`, if cheap; otherwise note "not measured").
  - Write `native/README.md` "Phase 8 M3a results".
  - Mark the parity rows this plan finished as **done (M3a)** or **partial (M3a)**, each with one line.
  - Add a status note at the top of this plan.
- [ ] **Step 4: Run** both full ctests. Expected: PASS.
- [ ] **Step 5: Commit** `docs(app): milestone 3a results`.

---

## Follows: M3b (its own plan, written when this one is done)

1. **Snapping engine, headless.** `placeAt(part, colour, ray) -> Placement?` and `snapNear(pieces, world) -> Placement?` are pure C++, built on `ConnectorDb` with a free-connector index over the focused model. Collision refuses crossings with a reason. Measure the index cost on 10030 ×4 first.
2. **Thumbnails.** An offscreen `Renderer` per worker draws part thumbnails into a disk cache. Check first that a second renderer can draw and read back off the main thread.
3. **Parts pane:** Frequent, Common, Recent, search, category, swatches for the colour of new parts, click to add, placement hint and mirrored pose.
4. **Drag into the viewport and placing mode:** a ghost, Tab cycles the grip, R turns, ⌥ drops without snapping, Esc cancels. Dragging a placed piece snaps too.
5. **Floating selection bar, joint card, joints/aim/collision tools, refused-edit red outline, Select ▸ Connected/Touching, Group and tags.**
6. **Settings window** (appearance, viewport options, auto-plan), **welcome window** (recents with thumbnails, Open, New), **About**.

## Self-review notes (kept for the executor)

- **Spec coverage.** Design M3 is "Models, Parts (thumbnails, drag to place with snapping), Steps; inspector tabs; context menus; ⌘K palette; Settings; welcome window".
  - In M3a: Models, Steps, inspector, context menus and palette.
  - Deferred to M3b and listed above: Parts, snapping, Settings and welcome.
  - The Camera inspector tab is read-only in Phase 8 and comes with M4's director view.
- **Type names used across tasks.**
  - `DefChange`, `StepFields` and `Changed::refused` (T1);
  - `focus`, `focusPath` and `Snapshot::focus` (T3);
  - `OutlineRow`, `StepRow`, `ItemRow`, `ColorInfo`, `Similar` and `structureVersion` (T4);
  - `AppCommand`, `CommandContext` and `Registry` (T5);
  - `DocumentModel` and `OutlineNode` (T6);
  - `paletteMatches` (T9).
- **Order.** T1–4 are bmapp only and testable without the app. T5 must land before any pane, so panes never add their own menus.
