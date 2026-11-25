# BrickMotion Desktop — Milestone 2 (Document) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rust app becomes a real document editor shell:
- New, Open, Save, Save As, autosave with backups, and Open Recent.
- Undo and Redo, and Delete as the first edit.
- Selection driven by the model tree and the viewport, and a Properties panel that reads it.
- One command registry that drives the ribbon, ⌘K, keyboard shortcuts and the native menu bar.

**Architecture:**
- **Engine:** `bmapp` is not changed. `bmffi` grows a document ABI over calls `bmapp::Session` already has:
  - `newBlank`, `projectBytes`, `imported`, `dirty`, `markSaved`, `version`;
  - undo and redo with their names;
  - `remove`, select all and select none, hide and show;
  - `snapshot`, `outline`, `piecesOfRow`, `structureVersion`, `colors`.
- **Rust:** `bm` wraps that ABI safely. `brickmotion` gets:
  - a support folder (preferences, recents, backups) that tests can inject;
  - a document lifecycle with a dirty guard;
  - a state-aware command registry with a single dispatcher;
  - a palette, a muda menu bar, a virtualised model tree and the Properties panel.
- **Viewport:** it already catches up with session edits (`Viewport::catchUp`), so an edit only needs a repaint.

**Tech Stack:** As M1 (Rust 1.97, edition 2024, eframe/egui 0.37 with wgpu, egui_kittest, rfd, Catch2), plus:
- `muda` 0.17 (menu bar);
- `serde` and `toml` 0.8 (preferences and recents);
- `chrono` 0.4 (local timestamps for backup names).

**Spec:** `docs/superpowers/specs/2026-11-25-rust-egui-app-design.md`, milestone 2:
> "new/open/save/save-as/autosave/recents, undo/redo, model tree, selection, properties, command registry, palette, menus, shortcuts"

Builds on branch `feat/desktop-m1` (M1 plan `docs/superpowers/plans/2026-11-25-desktop-m1-skeleton.md`).

## Global Constraints

- Everything in M1's Global Constraints still holds:
  - stack;
  - Swift app frozen with its tests green;
  - no SolidCraft assets;
  - calm UI (one icon family, blue `#4f8cff` accent, orange only for the playhead, 8-px grid, 12.5-pt text);
  - bundle id `com.brickmotion.studio.rs`;
  - stage named files only, never `git add -A`;
  - no commits on `main`.
- **No engine edits in this milestone.** Every file under `native/` that M2 could touch carries the owner's uncommitted work:
  - `session.h`/`.cpp`;
  - `viewport.h`/`.mm`;
  - `renderer.h`/`.mm`.

  Only `desktop/` changes. If a task finds it needs a `bmapp` or render change, it stops, writes `Ruling: needs engine change <what>` in the ledger, and leaves the behaviour out. It does not put the logic in Rust instead.
- **One branch:** work continues on `feat/desktop-m1`, or on `feat/desktop-m2` cut from its tip if M1 has merged by then.
- **The project file is `.brickmotion`.** Only `.brickmotion` is ever written by Save or autosave. A document opened from any other extension (`.ldr .mpd .dat .io .json`) is *imported* (`Session::imported()`):
  - Save on an imported document runs Save As;
  - Save never writes project bytes over the source file.
- **Atomic writes:** write to `<name>.tmp-<pid>` in the same folder, then rename. `mark_saved` runs only after the rename succeeds.
- **Support folder:** `~/Library/Application Support/BrickMotion` holds `preferences.toml`, `recents.toml` and `Backups/`. Code reaches it only through `Support`. Tests and `BrickMotionApp::new_for_test` use a temp folder and never touch the real one.
- **Shortcuts match the Swift app:**

  | Command | Shortcut |
  |---|---|
  | New | ⌘N |
  | Open | ⌘O |
  | Save | ⌘S |
  | Undo | ⌘Z |
  | Redo | ⇧⌘Z |
  | Select All | ⌘A |
  | Command Palette | ⌘K |
  | Frame Selection | ⌘F |
  | Delete | ⌫ |

  - Save As is ⇧⌘S. The Swift app's ⇧⌘S is Duplicate, which has no meaning without NSDocument.
  - Single-key shortcuts (F fit, H home, S search) fire only while no text field has focus.
- **Every edit is one engine command and one undo step.** The app never patches its own copy of the model.

## Review Focus

1. **Closing or replacing an edited document:** Open, New, a finished background load, and Quit on a dirty document all ask "Save changes to <title>?" with Save, Don't Save and Cancel. Cancel keeps everything. Test: Task 5 `dirty_document_asks_before_replace` and `quit_with_changes_asks`.
2. **Saving where the write fails** (read-only folder, disk full): an error notice names the file, the document stays dirty, and no half-written file is left behind. Test: Task 5 `failed_save_keeps_dirty_and_no_partial_file`.
3. **Save on an imported LDraw file:** it goes to Save As with `<stem>.brickmotion` suggested, and the `.ldr` on disk is byte-for-byte unchanged. Test: Task 5 `save_never_overwrites_imported_source`.
4. **New, Save, then reopen an empty project:** it opens. The M1 zero-piece refusal is narrowed to imported files. Test: Task 5 `empty_project_round_trips`.
5. **Huge model tree** (Sagrada, about 12k parts and hundreds of submodel uses): the Browser stays under 16 ms per frame. Only visible rows are laid out, and the outline is rebuilt only when `structure_version` changes. Test: Task 9 `tree_rebuilds_only_on_structure_change`, plus the `BM_BIG_MODEL` frame-time test extended to the Models tab.

---

## File Structure

```
desktop/bmffi/include/bmffi.h          (modify) document ABI, list handles, bm_struct_size
desktop/bmffi/src/bmffi.cpp            (modify)
desktop/bmffi/src/lists.cpp            (create) outline / colours list handles
desktop/bmffi/tests/document_test.cpp  (create)
desktop/crates/bm-sys/src/lib.rs       (modify) mirror + DECLARED
desktop/crates/bm/src/session.rs       (modify) document methods
desktop/crates/bm/src/outline.rs       (create) OutlineRow, Snapshot, ColorInfo, Changed
desktop/crates/bm/tests/document.rs    (create)
desktop/crates/brickmotion/src/
  support.rs        Support { dir }, Prefs, Recents
  document.rs       DocState: path, imported, save/save_as/new, atomic write
  autosave.rs       Autosaver { last, interval, keep } tick(now) → backups
  commands.rs       (rewrite) When, Ctx, Shortcut, registry, run()
  shortcuts.rs      key handling from the registry
  palette.rs        ⌘K popup over the registry
  menubar.rs        muda binding over menu_model()
  chrome/confirm.rs "Save changes?" modal
  chrome/tree.rs    Models tab, virtualised
  chrome/properties.rs (rewrite) project / one piece / many pieces
desktop/crates/brickmotion/tests/document.rs, tests/commands.rs, tests/tree.rs
```

---

### Task 1: bmffi document ABI

**Files:**
- Modify: `desktop/bmffi/include/bmffi.h`
- Modify: `desktop/bmffi/src/bmffi.cpp`
- Create: `desktop/bmffi/src/lists.cpp`
- Test: `desktop/bmffi/tests/document_test.cpp`

**Interfaces:**
- Produces (C; every entry point keeps M1's guard/never-throw rule, and every `BmString` is freed with `bm_string_free`):
  - **Documents:**
    - `BmOpenResult bm_session_new_blank(BmSession*)`
    - `BmString bm_session_project_bytes(const BmSession*)`
    - `bool bm_session_imported(const BmSession*)`
    - `bool bm_session_dirty(const BmSession*)`
    - `void bm_session_mark_saved(BmSession*)`
    - `uint64_t bm_session_version(const BmSession*)`
    - `uint64_t bm_session_structure_version(const BmSession*)`
  - **Undo:**
    - `bool bm_session_can_undo(const BmSession*)` and `bm_session_can_redo`
    - `BmString bm_session_undo_name(const BmSession*)` and `bm_session_redo_name`
    - `BmChange bm_session_undo(BmSession*)` and `bm_session_redo`
  - **Edits:**
    - `BmChange bm_session_remove(BmSession*, const uint32_t* pieces, size_t n)`
    - `typedef struct { bool structure; uint64_t version; BmString refused; } BmChange;`
    - `void bm_change_free(BmChange)`
  - **Selection:**
    - `void bm_session_select_all(BmSession*)` and `bm_session_select_none`
    - `void bm_session_hide(BmSession*, const uint32_t*, size_t)`
    - `void bm_session_show_all(BmSession*)`
    - `size_t bm_session_pieces_of_row(const BmSession*, const char* outline_id, uint32_t* out, size_t cap)`: same two-call convention as `bm_session_selection`.
  - **Viewport:** `void bm_viewport_frame_selection(BmViewport*)` over `Viewport::frameSelection()`.
  - **List handles** (one convention for every list of structs: an opaque handle owns the strings, and rows borrow `const char*` that stay valid until `*_free`):
    - `BmOutline* bm_session_outline(const BmSession*)`, `size_t bm_outline_len(const BmOutline*)`, `BmOutlineRow bm_outline_row(const BmOutline*, size_t i)`, `void bm_outline_free(BmOutline*)`
    - `typedef struct { const char *id, *def, *name, *group; int32_t depth, parent; size_t pieces, uses; bool shared, unused; } BmOutlineRow;`
    - `BmSnapshot* bm_session_snapshot(const BmSession*)`, with accessors:
      - `bm_snapshot_info(const BmSnapshot*) -> BmSnapshotInfo { uint64_t version; size_t pieces, selected, hidden; bool dirty; }` (`selected` is the total selection count);
      - `bm_snapshot_piece_len`;
      - `bm_snapshot_piece(const BmSnapshot*, size_t) -> BmPieceInfo { uint32_t piece; const char *part, *description, *color_name, *submodel_path; int32_t color, step; bool in_shared_submodel; }`;
      - `bm_snapshot_free`.
    - `BmColors* bm_colors(const BmSession*)`, `bm_colors_len`, `bm_colors_at -> BmColor { int32_t code; const char* name; uint32_t rgb; float alpha; int32_t group; }`, `bm_colors_free`.
  - **Layout check:** `size_t bm_struct_size(const char* name)` returns `sizeof` for `"BmOutlineRow" "BmPieceInfo" "BmSnapshotInfo" "BmColor" "BmChange" "BmOpenResult" "BmString"`, and 0 for any other name.
- Consumes: M1's `BmSession`, `BmString`, `BmOpenResult`, `make`, `guard`.

- [ ] **Step 1: Write the failing tests** in `document_test.cpp`:
  - `TEST_CASE("blank document is clean and saves bytes that reopen")`: `new_blank` ok, `dirty` false, `imported` false, piece count 0, `project_bytes` non-empty; write them to a temp `.brickmotion`, `bm_session_open` it, and expect ok.
  - `TEST_CASE("remove is one undo step")` on helicopter: `remove({0})` gives `refused.len == 0`; piece count is n-1; `dirty` true; `can_undo`; `undo_name` non-empty; `undo` gives count n; `redo` gives n-1.
  - `TEST_CASE("remove of nothing is refused or a no-op")`: `remove(nullptr,0)` leaves the version unchanged.
  - `TEST_CASE("outline rows and pieces of row")` on helicopter: `outline_len >= 1`; row 0 has id `"root"`, depth 0 and parent -1; `pieces_of_row("root")` equals the piece count.
  - `TEST_CASE("snapshot follows selection")`: select {0,1}, then `info.selected == 2` and `piece_len == 2` with non-empty `part`.
  - `TEST_CASE("imported ldraw")`: helicopter.mpd gives `imported` true.
  - `TEST_CASE("struct sizes")`: `bm_struct_size("BmOutlineRow") == sizeof(BmOutlineRow)` and likewise for each, plus `bm_struct_size("nope") == 0`.
- [ ] **Step 2:** `cd native/build-rust && ninja bmffi_tests && ./bmffi/bmffi_tests`. Expected: compile FAIL (undeclared `bm_session_new_blank`).
- [ ] **Step 3:** Implement in `bmffi.cpp` (scalars) and `lists.cpp` (handles). Each handle is a struct holding the `std::vector` of engine rows; `*_row` returns `c_str()` pointers into it.
- [ ] **Step 4:** Run the same command. Expected: all bmffi cases pass. Then run `nm -gU build-rust/bmffi/libbmffi.dylib | grep -vc ' _bm_'`, expected `0`.
- [ ] **Step 5: Commit.** Stage `desktop/bmffi/include/bmffi.h desktop/bmffi/src/bmffi.cpp desktop/bmffi/src/lists.cpp desktop/bmffi/tests/document_test.cpp`, message `feat(desktop): bmffi document ABI (save bytes, undo, remove, outline, snapshot)`.

### Task 2: Safe document wrappers in `bm`

**Files:**
- Modify: `desktop/crates/bm-sys/src/lib.rs`
- Modify: `desktop/crates/bm/src/session.rs`
- Modify: `desktop/crates/bm/src/lib.rs`
- Create: `desktop/crates/bm/src/outline.rs`
- Test: `desktop/crates/bm/tests/document.rs`

**Interfaces:**
- Consumes: Task 1 ABI.
- Produces:
  - **On `Session`:**
    - `new_blank(&mut self) -> Result<OpenInfo, OpenError>`
    - `project_bytes(&self) -> Vec<u8>`
    - `imported(&self) -> bool`
    - `dirty(&self) -> bool`
    - `mark_saved(&mut self)`
    - `version(&self) -> u64`
    - `structure_version(&self) -> u64`
    - `can_undo/can_redo(&self) -> bool`
    - `undo_name/redo_name(&self) -> String`
    - `undo/redo(&mut self) -> Changed`
    - `remove(&mut self, &[u32]) -> Changed`
    - `select_all/select_none(&mut self)`
    - `hide(&mut self, &[u32])`
    - `show_all(&mut self)`
    - `pieces_of_row(&self, id: &str) -> Vec<u32>`
    - `outline(&self) -> Vec<OutlineRow>`
    - `snapshot(&self) -> Snapshot`
    - `colors(&self) -> Vec<ColorInfo>`
  - **In `outline.rs`:**
    - `pub struct Changed { pub structure: bool, pub version: u64, pub refused: Option<String> }`
    - `pub struct OutlineRow { pub id, def, name, group: String, pub depth: u32, pub parent: Option<usize>, pub pieces, uses: usize, pub shared, unused: bool }`
    - `pub struct Snapshot { pub version: u64, pub pieces, selected, hidden: usize, pub dirty: bool, pub described: Vec<PieceInfo> }`
    - `pub struct PieceInfo { pub piece: u32, pub part, description, color_name, submodel_path: String, pub color: i32, pub step: i32, pub in_shared_submodel: bool }`
    - `pub struct ColorInfo { pub code: i32, pub name: String, pub rgb: [u8; 3], pub alpha: f32, pub group: i32 }`
  - **On `Viewport`:** `frame_selection(&mut self)`.
  - **In bm-sys:** `#[repr(C)]` mirrors of each struct.

- [ ] **Step 1: Write the failing tests** in `tests/document.rs`:
  - `blank_round_trip`: new_blank, write `project_bytes` to a temp `.brickmotion`, and `Session::open` it returns `Ok`.
  - `remove_undo_redo`: on HELI, `remove(&[0]).refused == None` and the count drops by 1; `undo` brings it back; `undo_name()` is non-empty before the undo.
  - `outline_root_row`: `outline()[0]` has id `"root"` and `parent == None`.
  - `snapshot_describes_selection`: select `[0, 1]`, then `snapshot().selected == 2`.
  - `struct_sizes_match`: for each mirrored struct, `bm_struct_size(c"Name") == size_of::<bm_sys::Name>()`.
  - Extend the existing `header_and_rust_decls_agree` count from 28 to the new total.
- [ ] **Step 2:** `cd desktop && cargo test -p bm --test document`. Expected: compile FAIL (no method `new_blank`).
- [ ] **Step 3:** Implement. Copy borrowed rows into owned Rust values before calling `*_free`.
- [ ] **Step 4:** `cargo test -p bm`. Expected: all pass.
- [ ] **Step 5: Commit** the five named files, message `feat(desktop): bm document wrappers`.

### Task 3: Support folder, preferences, recents

**Files:**
- Create: `desktop/crates/brickmotion/src/support.rs`
- Modify: `desktop/crates/brickmotion/Cargo.toml` (`serde` with derive, `toml`)
- Modify: `src/lib.rs`
- Test: in-file `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `pub struct Support { pub dir: PathBuf }`:
    - `Support::user() -> Support` gives `~/Library/Application Support/BrickMotion`;
    - `Support::at(dir) -> Support`;
    - `backups(&self) -> PathBuf` gives `dir/Backups`.
  - `#[derive(Serialize, Deserialize)] pub struct Prefs { pub autosave_seconds: u64, pub backups_kept: usize }`:
    - `Default` is `{ autosave_seconds: 30, backups_kept: 10 }`;
    - `Prefs::load(&Support) -> Prefs`: a missing or malformed file gives the defaults;
    - `save(&self, &Support) -> io::Result<()>`, written atomically.
  - `pub struct Recents(Vec<PathBuf>)`:
    - `load(&Support)` and `save(&Support)`;
    - `add(&mut self, PathBuf)`: moves the path to the front, removes duplicates, keeps at most 10;
    - `existing(&self) -> Vec<&Path>`: hides missing files without forgetting them;
    - `clear()`.
  - `pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()>`: temp file in the same folder, then rename; the temp file is removed on error. Task 5 uses it.

- [ ] **Step 1: Write the failing tests:**
  - `prefs_default_when_missing_or_bad`: a missing file and a file holding `"autosave_seconds = 'x'"` both give `Prefs::default()`.
  - `prefs_round_trip`.
  - `recents_dedupe_front_and_cap`: adding a,b,a gives `[a,b]`; adding 12 paths gives length 10.
  - `recents_hide_missing_but_keep`.
  - `write_atomic_leaves_no_temp_on_error`: target in a folder made read-only gives `Err`, and no `*.tmp-*` file is left.
- [ ] **Step 2:** `cargo test -p brickmotion --lib support`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: pass.
- [ ] **Step 5: Commit**, message `feat(desktop): support folder, preferences, recents`.

**Ruling recorded by the planner:** the spec says recents are "imported once from the Swift app's list if present". The Swift app uses AppKit's own Open Recent list. It lives in `com.apple.sharedfilelist`, which is TCC-protected: listing it from this machine returns "Operation not permitted". There is no plain list to import, so recents start empty. If that is wrong, the owner exports the list once by hand.

### Task 4: State-aware command registry, dispatcher, shortcuts

**Files:**
- Rewrite: `desktop/crates/brickmotion/src/commands.rs`
- Create: `src/shortcuts.rs`
- Modify: `src/app.rs`, `src/chrome/ribbon.rs`, `src/chrome/titlebar.rs`, `src/chrome/viewbar.rs`
- Test: `tests/commands.rs`, and `tests/ui.rs` updated

**Interfaces:**
- Consumes: Task 2 `Session` methods.
- Produces:
  - `pub enum When { Always, Document, Pieces, Selection, CanUndo, CanRedo, Soon }`. `Soon` is a command not built yet; it keeps M1's " — coming soon" tip.
  - `pub struct Ctx { pub has_document: bool, pub pieces: usize, pub selected: usize, pub can_undo: bool, pub can_redo: bool, pub undo_name: String, pub redo_name: String, pub text_focus: bool }`, built once per frame by `BrickMotionApp::ctx()`.
  - `pub struct Shortcut { pub key: egui::Key, pub mods: egui::Modifiers }`, with `Shortcut::parse("⇧⌘Z") -> Option<Shortcut>` and `label(&self) -> String`.
  - `Command` keeps `id, title, icon, tip, workspace, tab, group`. It replaces `enabled: bool` with `when: When` and `shortcut: Option<&'static str>` with `keys: Option<&'static str>`, which must parse. It adds `menu: Menu`, where `pub enum Menu { App, File, Edit, View, None }`.
  - `pub fn enabled(c: &Command, ctx: &Ctx) -> bool` and `pub fn title(c: &Command, ctx: &Ctx) -> String`, which gives "Undo Delete" or "Undo" from `undo_name`.
  - `pub fn run(app: &mut BrickMotionApp, id: &str) -> bool` is the only dispatcher: ribbon, palette, shortcuts and menu all call it. It returns false for unknown or disabled ids.
  - New command ids:

    | Id | Title | Keys | Enabled when | Menu |
    |---|---|---|---|---|
    | `file.new` | New | ⌘N | Always | File |
    | `file.save` | Save | ⌘S | Document | File |
    | `file.save_as` | Save As… | ⇧⌘S | Document | File |
    | `edit.undo` | Undo | ⌘Z | CanUndo | Edit |
    | `edit.redo` | Redo | ⇧⌘Z | CanRedo | Edit |
    | `edit.delete` | Delete | ⌫ | Selection | Edit |
    | `edit.select_all` | Select All | ⌘A | Pieces | Edit |
    | `edit.select_none` | Select None | Esc | Selection | Edit |
    | `edit.hide` | Hide Selection | — | Selection | Edit |
    | `edit.show_all` | Show All | — | Pieces | Edit |
    | `view.frame_selection` | Frame Selection | ⌘F | Selection | View |
    | `view.palette` | Command Palette… | ⌘K | Always | View |

  - Existing ids `file.open`, `model.import`, `view.fit` (F) and `view.home` (H) keep their behaviour. `view.frame_selection` queues a new `ViewOp::FrameSelection`, which calls Task 2's `Viewport::frame_selection`.
  - Edits from `run` request an egui repaint. The engine viewport catches up with the edit by itself.
  - Test hook `BrickMotionApp::dialogs_off(&mut self)`: from then on, `file.open`, `model.import` and `file.save_as` push a `DialogRequest { kind: &'static str, suggested: Option<String> }` onto `app.dialog_requests` instead of opening an rfd panel. Task 5 adds the Save As suggestion.
  - `pub fn handle(app: &mut BrickMotionApp, ctx: &egui::Context)` in `shortcuts.rs` runs the commands whose keys were pressed this frame. It skips keys with no ⌘ while `text_focus`, and consumes the key so egui widgets don't also see it.

- [ ] **Step 1: Write the failing tests** in `tests/commands.rs`:
  - `every_shortcut_parses_and_is_unique`: every `keys` parses, and no two commands share (key, mods).
  - `every_enabled_command_runs`: on an app with HELI loaded and one piece selected, every command with `when != Soon` and `enabled(..)` gives `run(..) == true`. The file-dialog ids (`file.open`, `model.import`, `file.save_as`) use the test hook `app.dialogs_off()`, which turns them into recorded requests.
  - `undo_title_names_the_edit`: after `run("edit.delete")`, `title(find("edit.undo"), &app.ctx())` starts with `"Undo "`, and `run("edit.undo")` restores the piece count.
  - `delete_with_nothing_selected_is_disabled`.
  - `single_key_shortcut_ignored_while_typing` (kittest): focus Search commands, type "f", and the view is not fitted. Assert through the viewport's queued-op counter in the test hook.
  - `cmd_z_undoes` (kittest): select a piece, press ⌫ and then ⌘Z, and the piece count is back.
  - Update `ui.rs::disabled_commands_say_so` to iterate `When::Soon`.
- [ ] **Step 2:** `cargo test -p brickmotion --test commands`. Expected: compile FAIL.
- [ ] **Step 3:** Implement. Titlebar Undo/Redo buttons call `run` and show `title(..)` as their hover text. The ribbon reads `enabled(c, &ctx)`.
- [ ] **Step 4:** `cargo test -p brickmotion`. Expected: all pass (M1's tests included).
- [ ] **Step 5: Commit**, message `feat(desktop): state-aware command registry, dispatcher and shortcuts`.

### Task 5: Document lifecycle — New, Save, Save As, dirty guard, recents

**Files:**
- Create: `desktop/crates/brickmotion/src/document.rs`, `src/chrome/confirm.rs`
- Modify: `src/app.rs`, `src/loader.rs`, `src/chrome/titlebar.rs`, `src/main.rs`
- Test: `tests/document.rs`, and `tests/open.rs` updated

**Interfaces:**
- Consumes: Task 3 `Support`, `Recents`, `write_atomic`; Task 4 `run`, `When`.
- Produces:
  - `pub struct DocState { pub path: Option<PathBuf>, pub imported: bool }`, held in `BrickMotionApp` beside `doc`, where `path` is the `.brickmotion` file it saves to. Saves go to `path` only when it is `Some` and `!imported`.
  - `pub fn save_to(session: &mut bm::Session, path: &Path) -> Result<(), String>`: `write_atomic(project_bytes)`, then `mark_saved` only on `Ok`. The error text is `"<file name>: <io error>"`.
  - App methods:
    - `new_document()`;
    - `save()`: runs Save As when there is no path or the document is imported;
    - `save_as()`: rfd save dialog, `.brickmotion` filter, suggested `<title stem>.brickmotion`;
    - `save_as_path(PathBuf)` for tests;
    - `request(next: Pending)`.
  - `pub enum Pending { Open(PathBuf), New, Quit, Adopt(Loaded) }`. Anything that would replace or close a dirty document becomes `self.confirm = Some(pending)`. `chrome/confirm.rs` shows "Save changes to <title>?" with **Save**, **Don't Save** and **Cancel**. Save saves first, and if that fails it shows the error and keeps the dialog.
  - Test hook `answer_confirm(Answer::{Save, DontSave, Cancel})`.
  - **Quit:** in `ui()`, `ctx.input(|i| i.viewport().close_requested())` on a dirty document sends `ViewportCommand::CancelClose` and sets `Pending::Quit`. On Save or Don't Save it sends `ViewportCommand::Close`.
  - **Loads:** a background load finishing while the document is dirty is held as `Pending::Adopt`. Opening a file the user picked checks dirty *before* starting the load, so the dialog appears at once. `Adopt` covers a load already in flight when an edit happened.
  - **Zero pieces:** `open_model` refuses 0 pieces only when the extension is not `brickmotion`. This narrows the M1 fix.
  - **Recents:**
    - every successful open and save calls `recents.add(path)` and saves;
    - the Home button's File menu lists `recents.existing()` under "Open Recent", with "Clear Menu".
  - The titlebar document tab shows a dot when `session.dirty()`, and the title `Untitled` for a new document.
  - `new_for_test` takes a temp `Support`.

- [ ] **Step 1: Write the failing tests** in `tests/document.rs`:
  - `new_document_is_untitled_and_clean`.
  - `empty_project_round_trips`: new, `save_as_path(tmp/"e.brickmotion")`, open it, and expect no error notice and title `"e"`.
  - `save_never_overwrites_imported_source`: copy HELI to tmp `h.mpd`, open it, delete a piece, `run("file.save")` with dialogs off, and the recorded request is Save As with suggestion `"helicopter.brickmotion"`. The bytes of `h.mpd` are unchanged.
  - `save_clears_dirty_and_writes_project`: open, delete, save as `tmp/x.brickmotion`. The document is not dirty, the file starts with `{`, reopening it gives the count n-1, and recents' first entry is that path.
  - `failed_save_keeps_dirty_and_no_partial_file`: save as into a read-only temp folder gives an error notice titled `"Couldn't save x.brickmotion"`, `dirty()` stays true, and the folder has no `*.tmp-*`.
  - `dirty_document_asks_before_replace`: delete, then `open(other)` gives `confirm.is_some()` with the document unchanged. `Cancel` keeps the doc and starts no load. `DontSave` loads the other file.
  - `quit_with_changes_asks` (kittest): dirty, then send `ViewportCommand::Close`. The harness stays open and the confirm modal is visible by its label "Save changes to helicopter?".
  - Rename `open.rs::model_without_pieces_is_refused` to `ldraw_without_pieces_is_refused`; the assertions are unchanged.
- [ ] **Step 2:** `cargo test -p brickmotion --test document`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test -p brickmotion`. Expected: all pass.
- [ ] **Step 5: Commit**, message `feat(desktop): new, save, save as, dirty guard, recents`.

### Task 6: Autosave with backups

**Files:**
- Create: `desktop/crates/brickmotion/src/autosave.rs`
- Modify: `Cargo.toml` (`chrono`), `src/app.rs`
- Test: in-file tests, plus `tests/document.rs`

**Interfaces:**
- Consumes: Task 3 `Prefs`, `Support`, `write_atomic`; Task 5 `DocState`, `save_to`.
- Produces:
  - `pub struct Autosaver { last: Option<Instant>, seen_version: u64 }`.
  - `pub fn tick(&mut self, now: Instant, wall: chrono::DateTime<Local>, doc: &mut bm::Session, state: &DocState, prefs: &Prefs, support: &Support) -> Option<Result<PathBuf, String>>`. It returns the backup written, if any. Behaviour:
    - Nothing happens unless `doc.dirty()`, `doc.version() != seen_version`, and `interval` has passed since `last`, where `interval` is `prefs.autosave_seconds`.
    - Every autosave writes a backup to `Backups/<stem>/<YYYY-MM-DD HH.MM.SS>.brickmotion`. `<stem>` is the title, or `Untitled` for a new document.
    - It then prunes that folder to the newest `prefs.backups_kept`.
    - When `state.path` is a non-imported `.brickmotion`, it also saves in place with `save_to`, which marks the document saved. This matches the Swift app's `autosavesInPlace`.
    - Untitled and imported documents get the backup only and stay dirty, so the Quit guard still asks.
    - An error becomes a warning notice once per distinct message, never a modal.
  - The app calls `tick(Instant::now(), Local::now(), ..)` each frame. While the document is dirty it requests a repaint after `autosave_seconds`, so an idle window still autosaves.

- [ ] **Step 1: Write the failing tests** (in-file, with a fake `Instant` base plus offsets):
  - `nothing_before_interval`.
  - `titled_project_saved_in_place_and_backed_up`: the file is written, `dirty() == false`, and there is one backup.
  - `untitled_gets_backup_only_and_stays_dirty`.
  - `imported_source_untouched`: the `.mpd` bytes are unchanged and a backup exists.
  - `prunes_to_kept`: with `backups_kept = 3`, five ticks at new versions leave 3 files, the newest ones.
  - `same_version_not_saved_twice`.
- [ ] **Step 2:** `cargo test -p brickmotion --lib autosave`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test -p brickmotion`. Expected: pass.
- [ ] **Step 5: Commit**, message `feat(desktop): autosave with timestamped backups`.

### Task 7: Command palette (⌘K, S, Search commands field)

**Files:**
- Create: `desktop/crates/brickmotion/src/palette.rs`
- Modify: `src/chrome/ribbon.rs` (the field opens the palette), `src/app.rs`
- Test: `tests/commands.rs`

**Interfaces:**
- Consumes: Task 4 `registry`, `enabled`, `title`, `run`, `Shortcut::label`.
- Produces:
  - `pub fn rank(query: &str, ctx: &Ctx) -> Vec<&'static Command>`:
    - case-insensitive subsequence match on `title` and then `id`;
    - order: prefix-of-title first, then match start, then registry order;
    - an empty query lists every command;
    - `Soon` commands are listed after enabled ones.
  - `pub struct Palette { pub open: bool, query: String, cursor: usize }`. Each row shows the icon, the title, the path `"<tab> › <group>"` (or the id when it has no tab) and the shortcut label.
    - Disabled rows are dimmed and say why: "Needs a selection", "Nothing to undo", "Coming soon".
    - ↑ and ↓ move the cursor; Enter runs the row and closes; Esc closes.
- [ ] **Step 1: Write the failing tests:**
  - `rank_prefers_prefix`: `rank("und")[0].id == "edit.undo"`.
  - `rank_subsequence`: `rank("svas")` contains `file.save_as`.
  - `empty_query_lists_all`.
  - `palette_enter_runs` (kittest): ⌘K, type "select all", Enter, and the selection equals the piece count.
  - `palette_disabled_row_says_why` (kittest): on an empty launch, type "delete" and the label "Needs a selection" exists.
- [ ] **Step 2:** `cargo test -p brickmotion --test commands palette`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test -p brickmotion`. Expected: pass.
- [ ] **Step 5: Commit**, message `feat(desktop): command palette`.

### Task 8: Native menu bar (muda)

**Files:**
- Create: `desktop/crates/brickmotion/src/menubar.rs`
- Modify: `Cargo.toml` (`muda`), `src/main.rs`, `src/app.rs`
- Test: in-file tests

**Interfaces:**
- Consumes: Task 4 `registry`, `Menu`, `enabled`, `title`, `run`; Task 3 `Recents`.
- Produces:
  - `pub struct MenuSection { pub title: &'static str, pub items: Vec<MenuEntry> }` and `pub enum MenuEntry { Command(&'static str), Separator, Recent }`.
  - `pub fn menu_model() -> Vec<MenuSection>` (pure, tested). Sections:
    - **BrickMotion:** About, Settings (Soon), Hide, Quit (predefined items);
    - **File:** New, Open, Open Recent ▸, separator, Save, Save As;
    - **Edit:** Undo, Redo, separator, Delete, Select All, Select None, Hide Selection, Show All;
    - **View:** Fit All, Home View, Frame Selection, separator, Command Palette;
    - **Window:** predefined.
  - `pub struct MenuBar` with `install() -> MenuBar` (main thread, after the window exists, through `menu.init_for_nsapp()`) and `sync(&mut self, ctx: &Ctx, recents: &Recents)`. `sync` sets enabled and text only for items whose value changed.
  - `pub fn poll(app: &mut BrickMotionApp)` drains `muda::MenuEvent::receiver()` into `run(app, id)`. The muda item id is the command id.
  - Menu accelerators are the command's keys. AppKit consumes ⌘-key equivalents before winit, so ⌘-shortcuts run once, through the menu. `shortcuts::handle` still runs them when no menu is installed (tests and kittest).
- [ ] **Step 1: Spike** (no commit). Install a muda menu with a single ⌘Z item in the running app, press ⌘Z once, and log both the menu event and the egui key event.
  - Expected: exactly one of the two fires. If both fire, `shortcuts::handle` skips ⌘-keys while `MenuBar` is installed. Ledger the ruling.
  - Also check that winit's default app menu is replaced, not duplicated.
- [ ] **Step 2: Write the failing tests:**
  - `menu_model_ids_exist`: every `Command(id)` is in the registry.
  - `every_menu_command_in_model`: every registry command with `menu != None` appears exactly once.
  - `edit_menu_order`: matches the list above.
- [ ] **Step 3:** `cargo test -p brickmotion --lib menubar`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `cargo test -p brickmotion`. Expected: pass. Then the manual check, written to the ledger: `cargo run -p brickmotion -- samples/helicopter/helicopter.mpd`, Edit menu, delete a selected piece, then Undo from the menu. The piece count is restored, and the menu says "Undo Delete" before the undo.
- [ ] **Step 6: Commit**, message `feat(desktop): native menu bar from the command registry`.

### Task 9: Model tree (Browser › Models)

**Files:**
- Create: `desktop/crates/brickmotion/src/chrome/tree.rs`
- Modify: `src/chrome/browser.rs`, `src/app.rs`
- Test: `tests/tree.rs`

**Interfaces:**
- Consumes: Task 2 `outline`, `structure_version`, `pieces_of_row`, `select`, `selection`.
- Produces:
  - `pub struct Tree { rows: Vec<bm::OutlineRow>, built_for: (u64 /*generation*/, u64 /*structure*/), open: HashSet<String>, pub rebuilds: usize }`.
  - `fn sync(&mut self, s: &bm::Session)` rebuilds only when `(generation, structure_version)` changed. The root is open by default.
  - `fn visible(&self, filter: &str) -> Vec<usize>`:
    - rows whose ancestors are all open;
    - with a non-empty filter, rows whose name contains it (case-insensitive), plus their ancestors, ignoring the open state.
  - `show(ui, app, area)`: one 24-px row per visible row, laid out with `ScrollArea::show_rows`. Each row shows:
    - an indent of 16 px per depth;
    - a disclosure when the row has children;
    - the name;
    - the piece count, right-aligned and dimmed;
    - "×N" when shared.
  - Clicks:
    - click selects `pieces_of_row(id)` with `Replace`;
    - ⇧ adds and ⌘ toggles (the same modes as the viewport);
    - a row is highlighted when all its pieces are selected and it has at least one piece.
  - Unused submodels sit under a dimmed "Not used" header row.
  - The Browser's filter field feeds `visible`.
- [ ] **Step 1: Write the failing tests** in `tests/tree.rs`:
  - `tree_rebuilds_only_on_structure_change`: `sync` twice gives `rebuilds == 1`; after `remove` (a structure change) and `sync`, it is 2; after `select` and `sync`, it is still 2.
  - `click_row_selects_its_pieces` (kittest): click the label "helicopter", or whatever row 0's name is, read from `outline()`. The selection length equals the piece count.
  - `filter_keeps_ancestors`: a filter matching a depth-2 row keeps its parent and root visible.
  - `big_model_tree_frame_time` (behind `BM_BIG_MODEL`, release): Models tab open, scroll to the end, and the slowest frame is under 16 ms.
- [ ] **Step 2:** `cargo test -p brickmotion --test tree`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test -p brickmotion`. Expected: pass. Also run `BM_BIG_MODEL=<sagrada> cargo test -p brickmotion --release --test tree big_model` if the file is present; record "skipped (no file)" otherwise.
- [ ] **Step 5: Commit**, message `feat(desktop): model tree with selection`.

### Task 10: Properties panel

**Files:**
- Rewrite: `desktop/crates/brickmotion/src/chrome/properties.rs`
- Modify: `src/app.rs` (cache the snapshot)
- Test: `tests/ui.rs`

**Interfaces:**
- Consumes: Task 2 `snapshot`, `colors`, `outline`; Task 4 `run`.
- Produces: `app.snapshot()` is cached on `(generation, version, selection)` and rebuilt only when one of them changes. The panel has three states, each a collapsible section in M1's `panel_header` style:
  - **Nothing selected — "Project":**
    - title;
    - file (the path, or "Not saved");
    - pieces;
    - submodels (outline rows with `def != ""`, deduped by `def`);
    - hidden count, with a "Show All" link that runs `edit.show_all`;
    - "Edited" or "Saved".
  - **One piece — "Piece":**
    - part description and file (`"Brick 2 x 4"`, `3001.dat`);
    - colour swatch from `colors()` by code, plus `color_name`;
    - step (1-based);
    - submodel path, or "Main model";
    - a calm note "Shared submodel: edits change every use" when `in_shared_submodel`.
  - **Many — "<n> pieces":**
    - the distinct parts among the described pieces, as up to 8 rows of `"<count> × <description>"`, then "and N more";
    - a note "Showing the first 200" when `selected > described.len()`.
- [ ] **Step 1: Write the failing tests** (kittest):
  - `properties_show_project_when_nothing_selected`: labels "Project" and "Not saved" exist for an imported HELI.
  - `properties_show_one_piece`: select piece 0, and labels "Piece" and that piece's `description` exist.
  - `properties_show_many`: select all, and the label `format!("{} pieces", n)` exists.
- [ ] **Step 2:** `cargo test -p brickmotion --test ui properties`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test --workspace`, `cargo clippy --workspace --all-targets` (0 warnings), `BM_SCREENSHOTS=1 cargo test -p brickmotion --test ui screenshots` (refresh `docs/m2-*.png`), and `ctest --test-dir native/build-app` (619 pass, Swift unchanged).
- [ ] **Step 5: Commit**, message `feat(desktop): properties panel`.

---

## Not in this plan (and why)

- **Shared GPU texture viewport** (promised for M2 in the M1 plan): it needs a new engine entry (`Renderer` final texture → `Viewport::frameTexture()`). `renderer.h`/`.mm` and `viewport.h`/`.mm` both carry the owner's uncommitted changes, and committing around them would ship their work. It is deferred until the owner commits those files. The CPU readback path stays; its slowest frame is 27 ms on 1.3k pieces.
- **Preferences window, Home screen:** these are milestone 8 parity work. M2 ships the TOML file and its two autosave keys only.
- **Hide, Show and Delete beyond the selection commands; every other edit:** milestone 3.
