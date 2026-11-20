# Native Phase 8 animation and sign-off

This plan covers Milestones 4 and 5 after the Parts, placement and windows work. The mouse and keyboard workflows belong to the same document session, and every saved edit goes through the named undo history. [Phase 8 shell design](../specs/2026-11-19-native-phase8-app-shell-design.md) · [Parity ledger](../specs/2026-11-19-native-app-parity.md)

## Milestone 4

- Keep model editing in Build and open Animate as a resizable bottom split. Show the build, dope sheet and motion settings in one transport. The viewport and timeline share the same playhead.
- Lay out chronological runs of actual flights. A step can recur when the planner interleaves required moves. Keep the hit targets and labels legible at Fit, and let users zoom in to drag arrival order and pause handles. Provide step playback, staging views and a parts list. A diagnostic jumps to the part and frame it describes.
- Persist project, step and part timing using the shared plan fields. Apply overrides to existing paths for timing changes. Reuse unaffected paths when a one-piece edit passes the local checks. Run a fresh solve in the background when the dependency change is wider.
- Browse the steps of a submodel from its parent step. Offer waiting-orientation changes on eligible flights, then check the changed approach against the staged and installed pieces before showing it.
- Keep hand keys additive over the generated build. Provide per-property editing, retiming, interpolation, scene range, navigation, linking and explicit baking into editable keys. Auto Key should operate on the chosen object or submodel use. A motion check reports the first sampled crossing with the affected objects and frame.
- Use the native director for read-only camera preview and show its current target, orientation and field of view in the inspector.

## Milestone 5

- Complete viewport navigation, orthographic projection, grid spacing, clay and wireframe, floor views, zoom and scale. Keep controls reachable in the menus and command palette. Use native labels, focus, system colours and materials at the minimum and default window sizes.
- Exercise Welcome, Finder files, Save and reopen, imports, real placement, Timeline playback, Auto Key, motion editing, fit alternatives and Export Still in the running app. Review light and dark captures and inspect accessibility names for the same workflows. Run both CTest trees from the release build.
- Benchmark the 12,148-piece reference at 1920 × 1200 while orbiting. Measure helicopter warm open, geometry replan and edit-to-frame latency. Keep the results tied to the fixture, frame size and measurement method. The phase remains open until the outstanding acceptance items have evidence.

## Running evidence

| Gate | Reference target | Latest recorded result on Apple M1 Pro |
| --- | ---: | --- |
| Warm helicopter open to GPU-completed first frame | ≤ 500 ms | 283 ms |
| Reference orbit at 1920 × 1200 | p95 ≤ 8.33 ms | 8.27 and 9.03 ms, 120 samples per run |
| Helicopter one-piece geometry replan | ≤ 300 ms | 1,827 ms p95 for six 2 LDU edits to independent piece 35. The local solve reused up to 283 of 294 insertion paths. |
| Helicopter flight timing edit | Path reuse | 11.1 ms with all 294 paths reused |
| Helicopter move, recolour and delete to GPU-completed frame | One frame | 26.3, 28.0 and 27.1 ms p95 at 1920 × 1700 |
| 12,148-piece move, recolour and delete to GPU-completed frame | One frame | 21.8, 29.3 and 24.8 ms p95 at 1920 × 1700 |

These measurements use the app’s headless `--bench-open`, `--bench-orbit`, `--bench-timeline` and `--bench-edit` routes. The edit figures include GPU completion. The geometry replan sample includes full-solve fallback when the affected moves cannot be reused safely. Phase 8 sign-off remains open while orbit varies across the target and geometry replan and edit latency exceed their gates.

The running app was checked at its minimum light layout and at larger dark layouts. The live motion review verified that a Position X key and a landing-time change reached the project file. The bundled exporter wrote a test PNG, and the macOS Quick Look service rendered the embedded image from a project fixture. The release suite covers reopening an import, in-place save, arrival timing, bake, joint detachment and incremental path reuse.
