# Desktop (Rust) app: M7 review and web-parity audit, M1–M7

Date: 2026-11-27. Branch `feat/desktop-m7a` at `44685eda`. Screenshots in `docs/parity-audit/`
were taken at that commit with the kittest harness (1440×900).

**Read this first.** The parity ledger (`docs/superpowers/specs/2026-11-19-native-app-parity.md`)
says "done (M2)" / "done (M3a)" on many rows. Those marks describe the **Swift** app's Phase 8
milestones, not the Rust app's milestones 1–8. The Rust app has to reach the same rows again, and
this audit measures the Rust app only. The Rust spec says that where Swift went further than the
web app, Rust matches Swift, so the Swift command list (88 commands) is used as a second yardstick.

## Verdict

The engine side is sound. Every suite is green and M7a works. The complaint is still fair. The app
has many working parts, but it does not yet feel like one product. Three causes:

1. **Missing everyday editing.** The viewport has no piece menu, there are no submodel operations,
   and there is no "select similar". Most of the missing operations **already exist in the C++
   engine** (`bmapp`) and were used by Swift. They were never exposed over `bmffi`, so the Rust
   app could not call them.
2. **The app shell promised by the locked interface was never scheduled.** That means Home
   screen, Preferences, the light theme, About with versions, and Help. Milestones 1–7 don't name
   any of these, so nobody built them.
3. **The design system is in the spec, not in the code.** The code has 12 different text sizes,
   126 hard-coded colours outside `theme.rs`, two button styles, and filled ribbon tabs where the
   locked spec says underlined. Four of 12 ribbon tabs say "Nothing on this tab yet".

## Suites at 44685eda

| Check | Result |
|---|---|
| `cargo test --workspace` | 412 passed, 0 failed, 12 ignored |
| `cargo clippy --workspace --all-targets -D warnings` | clean |
| `bmapp_tests` | 48,417 assertions / 191 cases pass |
| `bmffi_tests` | 1,778 assertions / 91 cases pass |
| Swift `native/build-app`: build + `ctest` | builds; 676/676 pass |
| bm-sys header ↔ Rust declarations | 408 = 408 (agreement test passes) |

## Code review of the M7 commits (`cdaceab0..44685eda`, 10 commits, +14,210/−452)

M7a commits `14a83243`..`dd76602f` follow the plan: there is a mockup and rulings, the logic moved
into bmapp with tests, the bridge has tests, kittest UI tests were added, and screenshots exist.
The findings below are about `44685eda`.

| # | Severity | Finding |
|---|---|---|
| R1 | Important | **The engine behaviour changed without a C++ test.** `AssemblyInspection::changeJoint` used to refuse turns over ±90°. It now goes through the new `changeJointEx`, which allows ±360° and a slide of up to ±1000 LDU. New `jointInfo` and `changeJointEx` code (+188 lines) and 25 new `bmffi.h` functions were added. The bmapp and bmffi assertion counts are exactly what they were before the commit (48,417 / 1,778), so none of this has a C++ test. The spec says logic lives in bmapp **with a test**. The Swift app also calls `changeJoint`, so its limit changed silently too. Swift ctest still passes. |
| R2 | Important | **Animate layout breaks** (`parity-audit/e-animate-sound.png`). The view bar jumps to the top of the viewport, over the model. The selection chip "1 piece selected" is drawn on top of the Browser's Models/Steps tabs. Build workspace is fine. This was seen at HEAD; `viewbar.rs` (+169) and `chrome/mod.rs` (+153) changed in this commit. |
| R3 | Process | It is one 3,016-line "fix" commit across 34 files. It mixes engine, bridge, Smart Joints features and UI fixes, so it can't be reviewed or reverted piece by piece. |
| R4 | Design debt | The M7 diff **adds** 47 hard-coded text sizes (joints 13, checks 8, loose 8, fits 5, …) and 25 hard-coded colours (navigator 11, joints 8, …). This makes the problems below worse. |
| R5 | Minor | Model Checks rows show raw file names ("Part 1 · 3001.dat"), while Compatible Parts shows names ("Brick 2 x 4"). The tree and Properties show "helicopter - underside 1.ldr" with its extension. The Model ribbon tab has two groups both captioned "Modify". |

## Parity by milestone

Status: **Done** · **Partial** · **Missing**. Cost: **UI** (Rust only) · **Bridge** (bmapp has
it; needs bmffi + bm + UI) · **Engine** (new C++ work).

### M1 Skeleton
| Row | Status | Cost | Notes |
|---|---|---|---|
| View presets (front/back/left/right/top/bottom) | Partial | UI | Only by clicking the axis navigator. There are no View-menu or palette commands and no numpad keys. Swift had `view.front` … `view.bottom`. |
| Perspective / orthographic | Missing | UI | `bm_viewport_set_orthographic` is already exposed; nothing calls it. |
| Orbit, pan, zoom, fit, home, frame selection | Done | | |

### M2 Document
| Row | Status | Cost | Notes |
|---|---|---|---|
| New, open, save, save as, autosave, recents | Done | | |
| Close, rename, revert, import into model | Missing | Bridge (import: `Edit::ImportModel`) | Swift had all four. |
| Undo/redo with names | Done | | |
| Model tree: rows, counts, filter, breadcrumb | Done | | |
| Tree row menu | Partial | Bridge | It has only Export Video/Project/LDraw. Web/Swift also had open, play its build, lay out parts, view parts, import into, rename, delete. |
| Selection: click, shift-click | Done | | |
| Marquee (box) select | Missing | Bridge | |
| Properties | Partial | UI/Bridge | It has piece, colour, step, "In", arrives and project. It has no transform fields, no scrub-by-drag number fields (locked spec), and no group tags. |
| Command registry, ⌘K palette, shortcuts | Done | | |
| Native menu bar carries every command | Partial | UI | **67 of 101 commands are not in any menu.** There are no Model/Object, Step, Select or Help menus (Swift had Object, Select and Step menus). |

### M3 Editing
| Row | Status | Cost | Notes |
|---|---|---|---|
| Parts library, previews, placement, snapping | Done | | |
| Move/rotate gizmo, nudge, raise/lower, duplicate, clipboard, clone, delete, hide/show | Done | | |
| Scale tool | Missing | Bridge (`Edit::Scale`) | |
| Recolour, replace | Done | | |
| **Viewport piece context menu** | **Missing** | Bridge + UI | Right-click only offers the three "turn waiting part" items. The web/Swift menu has what fits, frame, fit together, open submodel, show/lay out step, move to step, rotate, raise/lower, clipboard, clone, use colour, hide, select ▸ same part/colour/step/group/connected, delete. |
| **Empty-space context menu** | **Missing** | UI | Paste, select all, show all, fit all, view presets, new submodel. |
| Make submodel / Extract / New submodel / Move to model / Rename / Delete submodel | Missing (two shown as "coming soon") | Bridge (`makeSubmodel`, `extract`, `newSubmodel`, `moveToModel`, `renameSubmodel`, `deleteSubmodel` are all in bmapp) | |
| Select same part / colour / part+colour / step / group | Missing | Bridge (`selectGroup`) / Engine for the rest | |
| Set group / remove from group | Missing | Bridge (`Edit::SetGroup`) | |
| Fit Together, Ways to Fit, Use This Colour | Missing | Bridge/UI | |
| Lay Out Parts (floor split), Centre on Floor | Missing | Bridge | |
| Steps: list, editor, insert, split, merge, move, gather, appearance | Done | | |
| Pin Order | Missing | Bridge | |

### M4 Build & play, M5 Animate & camera, M6 Render & export
These are mostly **Done**: planner, transport, timeline, build settings, staging, snap sound,
keyframes, camera lane, auto-direct, joints, Look, stills, movies, Render Queue, and the
LDraw/project/plan exports. What's left:
- The **Sound** ribbon tab is empty, although the Snap Sound and Mix commands exist under Build Video › Audio.
- The R2 layout break in Animate.

### M7 Extras
| Part | Status |
|---|---|
| M7a: Model Checks, Seat Loose, Compatible Parts (What Fits), Inventory import | Done |
| M7b: open connections, viewport ghosts, mirror/repeat, techniques, calculators | Not started |
| M7c/d: Generate (building/castle, brickify, remix), booklet instructions | Not started |

### Locked interface items that no milestone owns
The locked interface (spec "Interface", `final-app-v2.html`) lists these items, but milestones
1–7 never scheduled them. They are missing because nobody was given them, not because someone
skipped them.

| Item | Status |
|---|---|
| Home screen (side menu, New cards, Recent and Samples thumbnails) | Missing. With no document, the app shows an "Untitled" tree and "Open a model to begin". |
| Preferences window (search; General / Look / Work / Input / Data; theme cards; Apply/OK) | Missing. The title-bar gear is a disabled placeholder; Settings… is "coming soon". |
| Light theme (and accent/surface choice from the web Settings) | Missing. `Theme::DARK` is the only theme, and egui is forced to dark. |
| About | Partial. It uses the stock macOS panel with no metadata. The ledger asks for app and engine versions. |
| Help | Missing. It is a disabled placeholder in the title bar, and there is no Help menu. |
| Ribbon tabs underlined, not filled | Not met. The tabs are filled pills with off-palette `#2b4c80`. |
| Selection chip "pieces · step · submodel" | Partial. It shows "n pieces selected" only. |

## Design consistency (against the calm-UI rules)

| Rule | What the code does |
|---|---|
| 12.5-pt text, two weights (`theme::TEXT` 12.5, `SMALL` 10.5) | 12 sizes are in use: 8.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 18, 22. The most common are 11.0 and 11.5, which are not tokens at all. |
| One palette, defined once | 126 hard-coded colours outside `theme.rs`: timeline 19, parts_lane 15, widgets 8, navigator 8, joints 8, … This is what blocks a light theme. |
| One accent; orange only for the playhead | Orange is used for the logo, the workspace button, the Build switch and the model tree icons. |
| One control vocabulary | 83 raw `egui::Button`s against 28 calls to the shared `accent_button`/`secondary_button`. Hover, padding and focus differ panel to panel. The Compatible Parts search field gets a white focus ring; the Browser filter has none. |
| One panel container | 11 panels use `float_panel::show`. The joint card, breadcrumb, timeline diagnostics and part hover card are separate hand-made `egui::Area` cards with their own margins and radii. Panel heights differ too: Compatible Parts stretches to the bottom with an empty gap, while Model Checks fits its content. |
| Few tools, nothing dead | 4 empty ribbon tabs (Parts, Steps, View, Sound). Suggest has 1 tool. 8 "coming soon" strings ship, including 3 disabled "Click selects" modes in the view bar. |
| One icon family | Holds, except the word "Joints" sits as text inside the icon-only view bar. |

## Fix order (mockups first, as agreed)

1. **P0: visible breakage (UI only, small).**
   - Fix R2, the Animate overlaps.
   - Hide empty ribbon tabs or give them their commands. Parts gets library/colour, Steps the step commands, View the presets/projection/look/joints, and Sound Snap Sound/Mix.
   - Remove every "coming soon" from shipped UI.
   - Add the C++ tests for R1.
2. **P1: editing parity (bridge + UI).** One bmffi slice exposes what bmapp already has: make/new/extract/move/rename/delete submodel, set group, select group, scale, import into, lay out, pin order. Then build on it:
   - the viewport **piece and empty-space menus**;
   - a full menu bar (Model, Step, Select, Help);
   - View menu presets and orthographic.
3. **P2: design system, then the shell.**
   - Move every colour and size into theme tokens: two text sizes, `Theme::LIGHT`, underlined tabs, orange only for the playhead, one button and one panel style.
   - Then Preferences (Appearance first), the light theme, About with versions, Help, and the Home screen. Each screen gets a mockup approved first.
4. **P3: depth.** Properties transform and scrub fields, marquee select, Fit Together, Use This Colour, the full tree row menu, select same part/colour (engine).
5. **P4: M7b–d** as planned.

M8 ("parity sweep") should then confirm these rows, not discover them.
