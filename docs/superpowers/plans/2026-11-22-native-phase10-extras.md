# Native Phase 10 extras

Phase 10 brings the web editor's assistive tools to the Swift editor: Suggest, techniques, Generate and instructions. Everything that calls a language model or runs the Brick AI models is out of this phase; the owner will plan it as a separate AI phase (decided 2026-11-22). These tools use the existing engine: the placement solver, connector database, collision world, named undo history and the Render Queue. No tool writes to the document outside a single undoable command. [Phase 8 shell design](../specs/2026-11-19-native-phase8-app-shell-design.md) · [Parity ledger](../specs/2026-11-19-native-app-parity.md) · [Phase 9 panels](2026-11-21-native-phase9-editor-panels.md)

## Owner question before the later slices

- **Bricksafe finder.** The web panel needs the web dev server. The ledger asks whether it is superseded. It stays out until the owner answers.

## 1. Suggest: what builders put here

- Use the mined BrickNet joint poses (`public/data/suggest/habits.json`, 67,185 models, 2,813 anchor parts). For the selected part, list the parts builders attach to it, at the exact pose they use. Accept a suggestion only where it mates at least one of the part's free connectors and overlaps nothing. Rank by the number of models, and explain each one with that count.
- Colour follows the web: the anchor's colour where builders matched it at least half the time, otherwise the model's most common other colour.
- Show the list in the part's Compatible Parts popover above the library search. Placing a suggestion is one named undo step at the exact pose.
- Run the check on the assembly-inspection worker from a captured revision. Refuse a stale result.

**Done 2026-11-22.** `bmapp/src/habits.{h,cpp}` reads the table once (variant-letter fallback as the web's `habitsOf`). `PlacementSolver::seatAt` counts mated connectors and refuses overlaps. `AssemblyInspection::habitFits` ranks by model count (mated connectors break ties), best pose per part; a part that throws is skipped, not the list. A one-off sweep of every fourth anchor (704 placed alone) seated 98% of unturned rows and 96% of turned ones; by joint: stud 99%, axle 97%, hinge 93%, fixed 95%, ball 40% (ball mates are the weak case to look at); no table part is missing from the library. The sheet (`CompatibleParts.swift`) shows the list above the free-connection matches until a search narrows it. "Add Part" refuses a stale revision and places at the exact pose in the selected step. Tests in `bmapp/tests/habits_test.cpp`; snapshot checked light and dark at 900 × 600. Not yet exercised by hand: clicking Add Part in the running app; patterned part ids (`10128p01`) only match their own entry.

## 2. Suggest: open connections and ghosts

- List the focused model's free non-stud connectors (holes, pins, axles, clips, bars, hinges, balls), nearest the pointer first, and jump to each one.
- Draw the best suggestion as a viewport ghost on the placement preview path. Tab places it, the backtick key shows the next one, and Esc hides it.
- Add mirror and repeat suggestions from symmetry and rows, as in `src/suggest/engine.ts`.

## 3. Techniques and calculators

- Port the 43 techniques and their geometry calculators (`src/suggest/techniques.ts`, `geometry.ts`) as a native browser. A recipe is placed with the backtracking seat search and creates one undo step.

## 4. Generate

- Brickify a shape to bricks (`src/generate/brickify.ts`) in C++ with the same greedy bonded fill, and import the result as a new submodel. Building and castle seeds and remix (BrickNet search) follow. Generate from a prompt and Claude variants belong to the AI phase.

## 5. Instructions

- Add a booklet instructions export that renders steps through the Render Queue.

## Moved to the AI phase

- AI panel: generate, fix, paste and prompt through Claude, and the Claude key and model setting. The access method (Keychain key or the local CLI bridge) is that phase's first question.
- Generate from a prompt and Claude variants.
- The Brick AI shape models and BrickNet decoder, and whether native runs them in process (Core ML) or through the web build.

## Verification

Each slice adds an engine test in `bmapp_tests`, a pane self-test or `--snapshot` capture in light and dark at 900 × 600, and a parity-ledger row. The suites stay green in both build trees.
