# Native Phase 8 animation and sign-off

This plan covers Milestones 4 and 5 after the Parts, placement and windows work. The mouse and keyboard workflows belong to the same document session, and every saved edit goes through the named undo history. [Phase 8 shell design](../specs/2026-11-19-native-phase8-app-shell-design.md) · [Parity ledger](../specs/2026-11-19-native-app-parity.md)

## Milestone 4

- Keep model editing in Build and open Animate as a resizable bottom split. Show the build, dope sheet and motion settings in one transport. The viewport and timeline share the same playhead.
- Lay out chronological runs of actual flights. A step can recur when the planner interleaves required moves. Keep the hit targets and labels legible at Fit, and let users zoom in to drag arrival order and pause handles. Provide step playback, staging views and a parts list. A diagnostic jumps to the part and frame it describes.
- Use a native resize grip, a full-range scrubber with a visible-range indicator, and a scrollable detailed ruler. Scrubbing follows the playhead between windows of the timeline, and trackpad magnification keeps the time beneath the gesture fixed.
- Show physical parts as colour-coded clips with their LDraw IDs. Align clip starts to the planner’s times, stack overlapping labels, and use the inspector for the selected part’s geometry and connections. Provide native context menus for part and step edits, including atomic moves into new steps, splits, joins, order, and motion overrides.
- Draw the Parts lane in one AppKit view. Pack each clip into the topmost available row with the web editor’s 10-point label type and 20-point row pitch. Index clips by row and time, reuse shaped labels across zoom levels, and create the native part menu when requested. Keep the final tick at the six-point gutter and shift labels that would overrun the axis while marking their start.
- Persist project, step and part timing using the shared plan fields. Apply overrides to existing paths for timing changes. Reuse unaffected paths when a one-piece edit passes the local checks. Run a fresh solve in the background when the dependency change is wider.
- Browse the steps of a submodel from its parent step. Offer waiting-orientation changes on eligible flights, then check the changed approach against the staged and installed pieces before showing it.
- Keep hand keys additive over the generated build. Provide per-property editing, retiming, interpolation, scene range, navigation, linking and explicit baking into editable keys. Auto Key should operate on the chosen object or submodel use. The motion check groups the selected part’s sampled contacts by frame range and opens each crossing in the viewport.
- Use the native director for read-only camera preview and show its current target, orientation and field of view in the inspector.

## Milestone 5

- Complete viewport navigation, orthographic projection, grid spacing, clay and wireframe, floor views, zoom and scale. Keep controls reachable in the menus and command palette. Use native labels, focus, system colours and materials at the minimum and default window sizes.
- The in-editor path-traced preview is deferred at the owner’s direction. Still export remains available from File.
- Exercise Welcome, Finder files, Save and reopen, imports, real placement, Timeline playback, Auto Key, motion editing, fit alternatives and Export Still in the running app. Review light and dark captures and inspect accessibility names for the same workflows. Run both CTest trees from the release build.
- Benchmark the 12,148-piece reference at 1920 × 1200 while orbiting. Measure helicopter warm open, geometry replan and edit-to-frame latency. Keep the results tied to the fixture, frame size and measurement method. The phase remains open until the outstanding acceptance items have evidence.

## Running evidence

| Gate | Reference target | Latest recorded result on Apple M1 Pro |
| --- | ---: | --- |
| Warm helicopter open to GPU-completed first frame | ≤ 500 ms | 283 ms |
| Reference orbit at 1920 × 1200 | p95 ≤ 8.33 ms | 7.68 ms in the latest run, 6.54 ms in the previous run, 120 samples each on the 12,148-piece fixture |
| Helicopter one-piece geometry replan | ≤ 300 ms | 404 ms p95 in the latest release run, down from 480 ms at the start of the sign-off pass. The edit that preserved order took 242 ms and reused 278 moves. The other five required a full solve after insertion became blocked. Flight samples now test only obstacles reachable at their distance along the segment. Fresh and cached timelines stayed byte-identical to the prior output for all six edits. |
| Helicopter exact geometry undo | Exact snapshot reuse | Six cache hits in six trials, 8–13 ms p95 in the latest runs |
| Helicopter flight timing edit | Path reuse | All 287 paths reused, 7–9 ms in the quieter runs |
| Helicopter seek to GPU-completed frame | Record baseline | 7.4 ms p95 across 120 warmed offscreen scrubs at 1920 × 1200 in the first collision-interval run |
| Helicopter playback with playhead follow | Even presentation cadence | 8.33 ms p95 in two runs with 537 and 534 presented intervals, down from 33.33 ms p95 and 238 intervals before isolating the playback clock. The 1280 × 780 point window had a 1511 × 1022 pixel viewport. The zoomed timeline followed the playhead by 510 points. |
| Helicopter move, recolour and delete to GPU-completed frame | 8.33 ms at 120 Hz | 16.0, 17.0 and 15.5 ms p95 at 1920 × 1700 in the latest release run with concurrent desktop graphics activity. A quieter run reached 11.1, 12.9 and 12.1 ms p95. |
| 12,148-piece move, recolour and delete to GPU-completed frame | One frame | 9.8, 14.0 and 14.9 ms p95 at 1920 × 1700 |

The headless `--bench-open`, `--bench-orbit`, `--bench-timeline` and `--bench-edit` routes include GPU completion where recorded. The live `--bench-playback` route measures the timestamps of presented Metal drawables with the zoomed Build timeline open. The moving playhead, transport time and overview update independently of the clip rows. The geometry replan sample includes full-solve fallback when the affected moves cannot be reused safely. Phase 8 sign-off remains open for geometry replan latency, edit frame delivery and the remaining live interaction review.

The running app was checked at its minimum light layout and at larger dark layouts. Build, Keyframes and Motion were also captured at the 900 × 600-point minimum. The live motion review verified that a Position X key and a landing-time change reached the project file. The bundled exporter wrote a test PNG, and the macOS Quick Look service rendered the embedded image from a project fixture. The release suite covers reopening an import, in-place save, arrival timing, bake, joint detachment and incremental path reuse.

The Parts lane was rendered at Fit in the 305-part helicopter in light and dark appearance. The pane test checks label width, topmost row reuse, clip hit testing, end spacing, native menu dispatch and a stable playhead during replanning. In the same isolated AppKit probe, caching repeated clip drawings brought redraw p95 from 13.79 ms to 6.41 ms with 12,000 synthetic clips and 567 visible. The release app's `--bench-part-lane` measured 6.16 ms p95 for 90 warmed redraws of its actual Parts view at that density.

The live macOS accessibility tree and actions confirmed timeline resizing, horizontal paging, selecting and seeking to a part, and opening its context menu with Show Part Menu. The pane test exercises the magnification anchor and viewport constraints. Physical trackpad gestures and spoken VoiceOver still need a pass on the Mac.

Release tests cover editing a local Build flight as keys and returning its route to Build with the installed position preserved. A whole-build bake keeps separate tracks for nested parts through save and reopen, supports retiming a submodel and its baked leaf in the same edit, rejects an outdated bake, and restores the linked Build and prior keys in one Undo. In the live macOS app, the helicopter baked all 305 flights into 18,261 editable keys, and Undo restored its prior keys. Standard Preview and switching back to the native planner were verified in the same window.
