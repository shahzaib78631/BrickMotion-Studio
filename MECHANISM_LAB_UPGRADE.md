# Mechanism Lab and Studio `.io` import

This release adds interactive, non-destructive mechanical inspection to BrickMotion Studio. The design is inspired by Kinebrick's connector-first motion exploration and leverages BrickMotion's existing Standard Motion V4 solver and LDCad Shadow metadata, without copying Kinebrick's implementation.

## What's new

1. **Mechanisms rail tab / command palette.** The tab inspects the fully assembled model *on demand*, without launching an expensive animation planning job. It uses the existing LDCad world-space connector matcher, typed mechanical graph and automatic mechanics detector.
2. **Model topology overview.** Counts scanned parts, probable connector pairs, movable joints and inferred gear meshes. Categorizes gears, hinges, turntables, axles, wheels etc., with warnings when LDraw headers or connector metadata are missing.
3. **Live 3D driver.** Choose a solver-valid auto-detected mechanism, scrub its position, play/pause its motion, and set its motion range and cycles/minute. Supported V4 driven rotations, slides, rigid followers, and constrained gear pairs move together. The original LDraw matrices, build plan, edit history and authored keyframes are **not altered**.
4. **Manual motion sandbox.** Choose any loaded part, rotate/slide along world X/Y/Z, choose the bounds centre or enter a custom LDraw-world pivot. This is for interactive experimentation when the model lacks sufficient connector data; manual motion **is not proof of real articulation**.
5. **Connection explorer.** Browse moving interfaces, filter by part, motion or joint, click to select/frame the source part, inspect isolated/uncertain bodies and see the evidence behind gear pair hints.
6. **Diagnostic exports.** Download a structured JSON report or a Graphviz `.dot` graph for deeper mechanism analysis.
7. **Optional Standard Motion V4 render handoff.** Send the selected program to the existing V4 planner via *Use as V4 render demo*. The render planner separately assesses collision clearance and may report BLOCKED or UNVERIFIED.
8. **BrickLink Studio `.io` import.** Import a `.io` file from **Projects → Import model or project** or the command palette. Extracts the standard `model.ldr` ZIP member directly in the browser, including conventional deflated/stored files and legacy Studio ZIPCrypto files with the published `.io` format password. Preserves the existing LDraw import pipeline and auto-step behavior.

## Basic workflow

- Install dependencies and the LDraw geometry library using the repository's standard setup (see `README.md`).
- Open a `.ldr`, `.mpd`, `.io`, or native BrickMotion project.
- Open **Mechanisms** in the left rail. The inspection runs once for each loaded model geometry.
- Under *Live motion driver*, choose a suggested gear or hinge if any are safely representable by V4. Drag the position slider or press **Play**.
- If there are no suitable suggestions, expand **Manual motion sandbox**, select a part and experiment with X/Y/Z rotation or sliding. Choose a custom pivot for a hinge offset from the part's centre.
- Under *Connection explorer*, inspect and select joints. Download the JSON or DOT graph for complete evidence (the on-screen list shows up to 80 entries to avoid a huge DOM).
- To produce a video of a candidate, press **Use as V4 render demo**. Inspect the planner's clearance result before trusting or exporting it.

## Design and safety details

**Non-destructive preview:** `src/state/mechanismLab.ts` is an ephemeral Zustand store, never serialized into projects. `Viewport.tsx` maintains a per-model `MechanismSolver` and applies rigid deltas to GPU matrices only. Preview is suspended for normal build playback, Timeline editing, piece movement, or active transform selections. Exiting preview restores the existing editor's placement matrices.

**Evidence not certainty:** An LDCad connection suggests a joint but cannot prove physical tolerances, stopping angles or collision-free travel. Inferred gear meshes use the existing conservative V4 pitch rule and are explicitly labeled as requiring review. Manual joints are intentionally unverified. Neither this feature nor Kinebrick's viewer is a production-grade force solver.

**Safety bounds:** Interactive graph inference is limited to 2,500 displayed instances. `.io` import is limited to 96 MB compressed input, 32 MB uncompressed model and 12,000 ZIP entries. The importer validates central-directory boundaries, expected size and CRC; split, ZIP64, AES and arbitrary passwords are unsupported. It never uploads model data. Browsers must support `DecompressionStream('deflate-raw')` to import compressed ZIP members (otherwise export `.ldr`/`.mpd` from Studio).

**Content limits:** Studio-only custom geometry not packaged in the embedded LDraw/MPD text may remain unresolved until an equivalent LDraw part is supplied. The import does not reconstruct Studio's non-LDraw scene metadata, decorations or custom materials.

## Files of interest

- `src/anim/motion/v4/mechanismLab.ts` – assembly adaptation, joint detection, report formats, rigid follower preview.
- `src/state/mechanismLab.ts` – ephemeral UI driver state.
- `src/ui/MechanismLabPanel.tsx` – explorer, live controls, manual joint sandbox, report downloads.
- `src/ui/Viewport.tsx` – non-destructive live GPU pose integration.
- `src/io/studioIo.ts` – bounded `.io` ZIP/ZIPCrypto extraction.
- `src/ui/Toolbar.tsx` / `src/App.tsx` – import commands, navigation and panel integration.
- `tests/anim/mechanismLab.test.ts` / `tests/io/studioIo.test.ts` – regression tests.

## Verification

```bash
npm install
npm run typecheck
npm test -- tests/anim/mechanismLab.test.ts tests/io/studioIo.test.ts
npm run build
```

The complete test/build suite requires dependencies to be installed locally. The delivery environment used for this update did not have cached npm dependencies or working internet access, so a complete Vite/React build could not be run there. Available checks included TypeScript syntax validation, strict isolated `.io` type checking, five real ZIP fixture tests (including password protection) and the ten independent V4 solver invariants in the existing offline verifier (via the preinstalled TypeScript transpiler).
