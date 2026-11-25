# Milestone 2: rulings and deferred minors

From the execution ledger of `docs/superpowers/plans/2026-11-25-desktop-m2-document.md` (branch `feat/desktop-m1`, 961cb91..fabc090). Each ruling reads: what was decided — why — what it costs if wrong.

## Rulings

- Task 2: Ruling: header test count is 63, not the plan's implied 'new total' from grep (65 counted the #define and a comment) — the test parses BMFFI_API-prefixed lines only — none
- Task 3: Ruling: recents start empty (planner's ruling: Swift's list is TCC-protected sharedfilelist) — carried as written — owner exports by hand if wanted
- Task 4: Ruling: model.import loses ⌘O (file.open owns it) and model.what_fits loses F (view.fit owns it) — the plan's uniqueness test forbids shared keys and its table gives F to fit — hover cards no longer show those keys
- Task 4: Ruling: ⌘ parses to Modifiers{command} only (not mac_cmd) — egui's cmd_ctrl_matches requires mac_cmd on the event when the pattern has it; winit sets both on macOS, so command-only matches real and synthetic ⌘ — none
- Task 4: Ruling: the typing test focuses the Browser filter (given an accessible label "Filter models and parts"), not Search commands — Search commands is not a text field until Task 7 makes it open the palette — none
- Task 4: Ruling: file.new makes a new blank document and file.save/save_as only record the dialog request here; Task 5 adds the dirty guard and real saving — the every_enabled_command_runs test needs them dispatchable now — none after Task 5
- Task 4: Ruling: hiding the selection also clears it; disabled Undo/Redo tips say "nothing to undo/redo", not "coming soon" (icon_button_tip added) — hidden pieces cannot be picked, so keeping them selected would leave Delete acting on invisible pieces — if wrong, owner expects hidden pieces to stay selected
- Task 4: Ruling: has_document is an app flag set by a finished load or New — the engine session exists from launch with no document — none
- Task 5: Ruling: save_never_overwrites_imported_source copies HELI to tmp/helicopter.mpd, not h.mpd — the plan expects suggestion "helicopter.brickmotion" but the title comes from the file name — none
- Task 5: Ruling: Save in place needs path Some, !imported AND a .brickmotion extension (DocState::save_path) — a .json the engine reads as a project is not imported, and the constraint says only .brickmotion is written — a .json project's first Save asks for a .brickmotion name
- Task 5: Ruling: Pending::Adopt holds Box<(PathBuf, Document, OpenInfo)>, not Loaded — DocState needs the path and Loaded has none — none
- Task 5: Ruling: after "Don't Save"/"Save" the load the person agreed to is adopted without asking again (replace_ok = version at the answer); an edit made after the answer asks again — otherwise Open on a dirty doc asked twice — none
- Task 5: Ruling: app.title() is the saved project's stem, else the engine's title, else "Untitled" for a new document — the engine keeps the imported file's title after Save As — none
- Task 5: Ruling: kittest harnesses use new_for_test_cc (temp Support); quit test injects ViewportEvent::Close into raw input — kittest does not turn ViewportCommand::Close into close_requested, and harness apps must not write the real recents — real-window quit not exercised here (Task 8 by-hand check)
- Task 6: Ruling: the first dirty tick starts the clock (no save); a later tick at a new version saves once the interval has passed since then or since the last autosave; a new document (generation) resets the saver — the brief says "interval has passed since last" with no rule for the first edit — the first autosave comes up to one interval after the first edit
- Task 6: Ruling: the backup folder is the file stem of state.path (the imported source's name for imports), "Untitled" without one; the app's autosave is a pub method the frame calls, tested in tests/document.rs (app_autosaves_backups_and_warns_once) — none
- Task 7: Ruling: S opens the palette through a fixed check in shortcuts::handle, not a registry key — a command has one `keys`, ⌘K is the listed one, and the plan names S as a single-key shortcut — S is not shown in menus
- Task 7: Ruling: app.palette_open (Task 4) became app.palette: Palette { open, .. } as the brief's struct says; the palette's disabled rows show the reason where the place would be; palette_disabled_row_says_why checks at least one "Needs a selection" (id matches like edit.select_none also hit "delete") — none
- Task 7: Ruling: the Search commands field is a button that opens the palette (the field lives in the palette) — none
- Task 8: Ruling: spike answered from winit 0.30.13's source instead of a key press: its view does not override performKeyEquivalent and its sendEvent override only forwards ⌘ key-UPs, so AppKit's menu takes ⌘ key-downs first; shortcuts::handle also skips ⌘ keys while a MenuBar is installed, so a double fire cannot happen either way — a synthetic key press needs the owner's accessibility grant — if AppKit ever let a ⌘ key through to the window, that key would do nothing (not twice)
- Task 8: Ruling: only ⌘ shortcuts become menu key equivalents; F, H, ⌫, Esc stay with the window — a plain-key equivalent would fire while typing in a text field — those menu items show no shortcut
- Task 8: Ruling: Select All, Undo and Redo menu items turn off while a text field has focus (menu_enabled) — otherwise ⌘A/⌘Z in a field would act on the model — needs the owner's by-hand check that AppKit passes a disabled item's key on to the field
- Task 8: Ruling: Quit is the registry command app.quit (⌘Q) through request(Pending::Quit), not muda's predefined Quit; Settings… is app.settings (Soon); About/Hide/Hide Others/Show All and the Window menu are predefined (MenuEntry::System) — predefined Quit calls NSApp terminate and skips the Save changes guard — none
- Task 9: Ruling: filter_keeps_ancestors uses samples/8880-1.mpd (outline depth 3), not helicopter — helicopter's outline is only one deep — none
- Task 9: Ruling: the big-model check times the tree's own layout (Tree::last_show), not the whole harness frame — the frame also draws the 3D view, which M1 measured at 27 ms for 1.3k pieces, so a 16-ms whole-frame bound measures the renderer, not the Browser — the 3D frame time stays as M1 left it
- Task 9: Ruling: rows are found as Role::TreeItem by name (the document tab also carries the title); the tree replaces M1's single root row once a document is open; pieces per row are cached until the next rebuild — none
- Task 10: Ruling: properties_show_many counts "<n> pieces" labels (title bar, chip, Properties: ≥3) and at least two "N × part" rows — the title bar and selection chip already show "<n> pieces", so a single-label check passes without the panel — none
- Task 10: Ruling: an imported document's Project section shows File "Not saved" plus "Imported from <file>"; hide/show_all drop the cached snapshot (they change neither version nor, for Show All, the selection) — none
- Task 10: Ruling: screenshots test writes docs/m2-document.png (tree + one piece) and docs/m2-palette.png beside the M1 pictures — none

## Deferred minors

All M1 and M2 deferred minors were fixed on 2026-11-25 (commits 64205139, e3bc7697, 97b8b88c,
89f93f13). Rulings made while fixing them:

- Fix: Ruling: the Document's session can't be swapped because session edits now take `&self` and Document hands out only `&Session` (Session is not Sync) — the engine viewport retains its session (viewport.mm Viewport::create), so a swap was memory-safe but could race across threads — costs nothing; `open`/`new_blank` keep `&mut self` for worker sessions
- Fix: Ruling: bm_session_adopt, Session::adopt and Document::replace removed (no caller since the worker builds the whole Document); header count stays 63 with bm_metal_available added
- Fix: Ruling: "no Metal" only when bm_metal_available() is false; a null viewport with Metal says "The 3D view could not start"
- Fix: Ruling: the command-line file opens on the first frame (after the view's size is known), not in the constructor; window-less test apps start it in wait_loaded — one frame later than before
- Fix: Ruling: a superseded load is cancelled by a flag checked before and after parsing; parsing itself is not interrupted (the engine has no cancel hook) — a huge superseded file still parses to the end on its thread
- Fix: Ruling: replaced documents drop on a bm-retire thread (Document is Send; it was built on a worker already)
- Fix: Ruling: open errors are checked in open_model: missing ("There is no file here any more."), folder, unreadable ("BrickMotion can't read this file (permission denied).") — before the extension check, so a missing .stl says missing
- Fix: Ruling: notices keep the newest 4; an identical notice moves to the top instead of repeating
- Fix: Ruling: hover cards and the palette hide keys of Soon commands (P, M, R, C do nothing yet); F and H already work
- Fix: Ruling: the title bar's Open button uses Icon::File; Home stays only in the view bar / navigator
- Fix: Ruling: closing the window while Save changes? is up for something else sets quit_after; Save/Don't Save then quits instead of doing the other thing; Cancel forgets the close
- Fix: Ruling: the menu bar resyncs only when MenuKey (generation, version, selection count, text focus, has_document, recents) changes — a recent file deleted while the app runs stays listed until the next change
- Fix: Ruling: autosave measured on 10294-1 (9,720 pieces): project_bytes 25 ms, plus write_atomic's full fsync — serialising stays on the UI thread (Session is not Sync); the writes run on bm-autosave, and the in-place save is marked saved only if generation and version still match; Save and Quit wait for an autosave in flight (save_during_an_autosave_keeps_the_newest reproduced the overwrite 3/3 before the fix) — a 25 ms hitch every interval remains on very big models
- Fix: the M1 ledger's "0 passed" evidence lines were a process slip (filtered test names); M2 and these fixes record real counts

## Checks outside the test suite

- Task 5: Ruling: kittest harnesses use new_for_test_cc (temp Support); quit test injects ViewportEvent::Close into raw input — kittest does not turn ViewportCommand::Close into close_requested, and harness apps must not write the real recents — real-window quit not exercised here (Task 8 by-hand check)
- Task 8: Ruling: Select All, Undo and Redo menu items turn off while a text field has focus (menu_enabled) — otherwise ⌘A/⌘Z in a field would act on the model — needs the owner's by-hand check that AppKit passes a disabled item's key on to the field
- Task 8: by-hand (System Events against target/debug/brickmotion helicopter.mpd): menus = Apple, brickmotion, File, Edit, View, Window (winit's default replaced, not duplicated); Edit › Select All then Delete → Edit shows "Undo Delete 305 Pieces" enabled; Undo → "Redo Delete 305 Pieces" enabled; edited + Quit BrickMotion → process stays (guard); clean + Quit → process exits. The confirm modal itself was not seen (no screen-recording grant; AX lists no egui window) — covered by kittest quit_with_changes_asks
- Task 9: big model: BM_BIG_MODEL=dist/data/omr/10294-1/10294-1.mpd (absolute) → 698 rows, slowest tree layout 1.12 ms; dist/data/bricknet/sft_21065.ldr (Sagrada, flat LDraw, 1 row) → 22 µs; the test now asserts the model opened
- Task 10: checks: cargo test --workspace all green; clippy --workspace --all-targets 0 warnings; ctest --test-dir native/build-app 619/619 (Swift app unchanged)
- Final: fixed relative open paths stored in recents and DocState (by-hand run put "../samples/…" in recents) — relative_open_is_remembered_absolute RED→GREEN, suite green
- Final: menu key equivalents read through AX on the real app (HOME in scratchpad): ⌘N ⌘O ⌘S ⇧⌘S ⌘Z ⇧⌘Z ⌘A ⌘F ⌘K ⌘Q registered; a real key press was NOT sent (app not frontmost) — unverified by keystroke
- Final: tree timing with everything selected, 10294-1 (698 rows): 1.26 ms; no Sagrada-scale nested model exists locally (sft_21065 is flat)
- Final: by-hand runs earlier wrote the owner's real ~/Library/Application Support/BrickMotion (recents.toml with a relative helicopter path, Backups/helicopter/2026-11-25 15.05.43.brickmotion) — left in place for the owner
- Fixes: cargo test --workspace 104 passed; clippy 0 warnings; bmffi 71 assertions / 13 cases; ctest native/build-app 619/619; release app opened helicopter.mpd from the command line with HOME in the scratchpad, ran 6 s, no errors
