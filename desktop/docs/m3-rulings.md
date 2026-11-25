# Milestone 3: rulings, screenshots and checks

From the implementation of `docs/superpowers/plans/2026-11-25-desktop-m3-editing.md` (branch `feat/desktop-m1`, `ae081100..HEAD`). Each ruling reads: what was decided — why — what it costs if wrong.

## Rulings

- Task 1: Ruling: multi-step gestures (`move`, `rotate`, `set_step_fields`) pass `continuing = true` starting on the first call (preceded and ended by `end_gesture()`) — `bmapp`'s `commands.cpp` sets `c.open = continuing` on creation, so passing `false` on call 1 closes the step and causes call 2 to create a second undo step — none; matches Swift's gizmo and step-editor drag behaviour
- Task 1: Ruling: `bm_session_recolor` on an empty piece list is a no-op (version unchanged, `refused` empty) and `replaceCommand` normalizes any part name without refusing unknown `.dat` names — `bmapp` returns `unchanged(s)` for empty recolor and allows arbitrary part strings in `replacePart`, so refusal tests exercise `bm_session_paste("")` (Task 1/2) and full-step `bm_session_split_step` (Task 10) — none
- Task 2: Ruling: `edit.copy`, `edit.cut`, and `edit.paste` use an in-memory clipboard buffer when `dialogs_off()` is active (headless tests) and `arboard::Clipboard` in normal runs — keeps `every_enabled_command_runs` from clobbering the owner's macOS pasteboard while `BM_CLIPBOARD=1` exercises the real pasteboard — none
- Task 2: Ruling: `menubar::menu_enabled` disables `edit.copy`, `edit.cut`, and `edit.paste` alongside `edit.select_all`, `edit.undo`, and `edit.redo` while a text field has focus — lets AppKit forward ⌘C/⌘X/⌘V to the focused text input instead of acting on the 3D selection — needs by-hand confirmation in the windowed app
- Task 4: Ruling: gizmo hit tolerance is 8 pt in the viewport (6 pt in engine unit tests), and Move axes draw subtle arrowheads plus an origin cap while keeping the calm 3-axis colour convention — makes picking narrow axis lines comfortable on HiDPI displays without adding visual clutter — none
- Task 6: Ruling: `Previews` spawns its `bm-previews` worker lazily on first `get()` and relies on `bmapp`'s existing `public/data/catalog.json` loader and disk-first `part-previews-v3` PNG cache — keeps window-less tests free of Metal/worker overhead and avoids redundant geometry loads or Metal renders for already-cached parts — none
- Task 9: Ruling: added safe `bm::Document::parts(&mut self) -> (&Session, Option<&mut Viewport>)` — lets placement begin/poll borrow both session and viewport without `unsafe` in `brickmotion` — none
- Task 11: Ruling: Browser tabs carry `Role::Tab` in AccessKit — distinguishes Browser's `Steps` and `Parts` tabs from the Ribbon's `Steps` and `Parts` buttons for screen readers and kittest — none
- Task 11: Ruling: `model.to_step` keeps `"To Step"` as its ribbon title while the Steps context menu labels it `"Gather Selection Here"` — preserves the locked ribbon layout while matching the Swift step menu wording — none
- Task 13: Ruling: Library `ScrollArea` uses `min_scrolled_height(300.0)`, the Step editor frames `Pause after` and outlines the `Pin build order` checkbox, and Properties frames `Replace…` — spotted when inspecting the first M3 screenshots (Library had shrunk to 1 row, and the unchecked checkbox/scrub field blended into `bg2`) — none

## Screenshots

Captured via `BM_SCREENSHOTS=1 cargo test -p brickmotion --test ui screenshots` and inspected:

- `desktop/docs/m3-gizmo.png`: helicopter with piece 0 selected, RGB Move gizmo with arrowheads and translucent plane squares over the piece, Move highlighted in both the ribbon and view bar, and Properties showing the framed `Replace…` button and Red colour swatch.
- `desktop/docs/m3-library.png`: Library tab open on Common parts showing all 12 Light Bluish Grey brick previews in a crisp 4×3 grid with labels, colour chip, and category menu cleanly aligned above.
- `desktop/docs/m3-placing.png`: translucent red 2×4 brick (`3001`) snapped onto the helicopter roof with the bottom-left placement HUD (`3001 Snapped Click to place · R turn · Tab grip · Esc cancel`).
- `desktop/docs/m3-steps.png`: Technic `8880-1` in the Steps tab with Step 1 selected and the floating `Edit Step 1` popover open (Title focused, Notes, framed `0.0 s` Pause after, visible `Pin build order` checkbox, and accent `Done` button).

## Checks

- `cd desktop && cargo test --workspace`: 167 passed, 0 failed (26 in `bm`, 141 in `brickmotion`; 3 ignored: clipboard pasteboard + 2 release perf tests).
- `cd desktop && cargo clippy --workspace --all-targets -- -D warnings`: 0 warnings.
- `cd desktop && cargo test -p brickmotion --release --test library -- --ignored`: passed — `library scroll slowest layout: 482.916µs` (< 16 ms).
- `BM_BIG_MODEL=/Users/mac/Projects/BrickMotion-Studio/dist/data/omr/10294-1/10294-1.mpd cargo test -p brickmotion --release --test steps big_model -- --ignored`: passed — Titanic (9,720 pieces): `steps=10.791µs, parts=9.709µs` (< 16 ms).
- `cd native/build-rust && ninja bmffi_tests && ./bmffi/bmffi_tests`: 216 assertions in 38 test cases, all passed.
- `nm -gU native/build-rust/bmffi/libbmffi.dylib | grep -vc ' _bm_'`: `0`.
- `ctest --test-dir native/build-app`: 619/619 passed (100%).

## Checks outside the test suite

- Interactive by-hand pass in the windowed app (live mouse drag on gizmo, placing three parts, ⌘Z undo, recolouring from Properties, editing a step title, gathering into step 1, saving and reopening with `HOME=<scratchpad>/home`) is ready for the owner to try in `desktop/target/release/brickmotion` or `cargo run --release` — automated harness tests cover every one of those flows headlessly.

## By hand (open)

Not yet done in the windowed app (M3 Task 13 Step 3, carried into M4 Task 1 Step 5): place three parts, gizmo drag + one ⌘Z, R turn, recolour from Properties, edit a step title, gather into step 1, save and reopen with `HOME=<scratchpad>/home`; also ⌥E / ⌥Q on a real keyboard and ⌘C / ⌘V inside a text field (the Task 2 menu ruling). For the owner to try.

## Review fixes (M4 Task 1)

- The chosen step is clamped to the step list every frame (it pointed past the last step after undoing an insert, so placing was refused).
- A placement ignores pointer moves, turns, grip and colour changes after the click until the commit lands, and follows the K collision toggle live (as `PlacementController.swift`).
- The step editor closes without writing when the number of steps changes under it.
- Cut removes pieces only once their copy is on the clipboard.
- Dropped: a gizmo-refusal fix. `moveCommand`/`rotateCommand` never refuse, so the readout cannot drift.
