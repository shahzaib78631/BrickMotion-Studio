# M6 rulings (Render & Export)

## Approved mockup (Task 1, 2026-11-26)

Mockup: `desktop/docs/m6-render-mockup.html` (copy of `.superpowers/brainstorm/65433-1795584607/content/m6-render.html`). The owner answered the four gate questions with the recommendations and raised nothing on the screens, so v1 is the approved design.

- **Export Video and Export Still are floating panels** (`PanelKind::Movie`, `PanelKind::Still`), like the M5 editors. The Export Video panel changes state in place: settings → Waiting to Render → Frame n of N with Cancel → Export Complete with Show in Finder / Done, or the failure.
- **The Render Queue is a floating panel** (`PanelKind::Queue`), opened from Output → Render Queue and Window → Render Queue. Header subtitle counts the exports still to finish (Swift's "n exports in progress"; the mockup's three counts did not fit the panel header). Queueing a still closes Export Still and opens the queue.
- **Look opens from the ribbon's Look button and View → Look… only** (no viewbar popover). Header "Look · Project"; the first line of the body is "Saved with the project and used by every video.". Scenes are 30-px swatches (selected: 2-px accent outline), the hovered or chosen scene's name and hint under them; shading is a list of six rows (title + description, chosen row accent-tinted); Detail is one inset group of switch rows; Path tracing Samples is a pill slider shown only with Path Traced.
- **The recording chip sits bottom left**, in the selection chip's place: red dot, "m:ss" in mono, Stop.
- Ribbon: Animate → Output tab holds the Output group (Export Movie, Export Still, Render Queue) and a View group (Look, Record).
- File menu: Export Movie…, Export Still…, Export All Submodel Videos…, Export LDraw… ⇧⌘E, Export Plan…. Model row menu: Export Video…, Export Project…, Export LDraw….
- Frame shapes are four tiles (outline of the shape, name, ratio); the chosen tile is accent-outlined and tinted.

## Milestone checks (Task 11, 2026-11-26)

Every suite, run on `feat/desktop-m1` at the M6 head:

| Check | Result |
|---|---|
| `cargo test --workspace` | 366 passed, 0 failed |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `BM_SLOW=1 cargo test -p brickmotion --test render_queue --test export` | 14 + 20 passed (real movie helper: 24 frames; real `bmexport`: a 192×108 PNG) |
| `bmapp_tests` | 189 test cases passed |
| `bmffi_tests` | 87 test cases passed |
| `ctest` `native/build-app` | 674/674 |
| `ctest` `native/build` | 475/475 |
| `nm -gU libbmffi.dylib` outside `_bm_*` | 0 |
| `scripts/bundle.sh` | builds; `Contents/Helpers/bmexport` is in the bundle; the bundled `Contents/MacOS/brickmotion --render-editor-movie` rendered the 2-second 320×180 turntable (24 frames) |

Screenshots (kittest, `M6_SHOTS=desktop/docs cargo test -p brickmotion --test export m6_screenshots -- --ignored`): `m6-look.png`, `m6-export-movie.png`, `m6-export-still.png`, `m6-queue.png`, `m6-recording.png`.

### By hand, for the owner

Not covered by the suites; to try in the bundled app:

1. **A full-length 1080p Build movie with snap audio:** Animate › Output › Export Movie, Build, Landscape 1920 × 1080, Include Snap Sounds on. The movie plays to the end with the snaps in time, and the Render Queue shows its frames counting up.
2. **A Final still:** Export Still, Final · 512 samples, with and without the video logo. The PNG has the project's scene backdrop, and the logo sits in its corner.
3. **Record Viewport while orbiting:** View › Record Viewport (⌥⇧⌘R), orbit for about ten seconds, then Stop. The saved movie runs at wall-clock speed without stalls.
4. **Show in Finder:** from the Render Queue and from the finished Export Video panel. Finder opens with the file selected.
