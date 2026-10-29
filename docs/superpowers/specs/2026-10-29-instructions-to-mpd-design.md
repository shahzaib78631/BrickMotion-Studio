# Instruction PDFs → MPD (BrickHeadz first)

Date: 2026-10-29 · Status: draft for approval

## Intent

Many sets the user wants to animate in BrickMotion have no MPD/LDR file anywhere, only LEGO's
official building-instruction PDFs (e.g. `https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6668730.pdf`).
This tool turns a set's booklets plus its parts list into an MPD that matches the official build
**as closely as possible**: same parts, same colours, same step order, same sub-builds. The user
will spend time fixing what the tool gets wrong; accuracy beats full automation.

The heavy lifting is delegated to two external coding agents the user already has, at the user's
request:

- **OpenCode + `opencode/big-pickle`** — the *builder*. Text only: it **cannot read images**
  (verified: it answers "this model can't accept image input").
- **CommandCode + `deepseek/deepseek-v4.1-flash`** — the *eyes*. Reads images (verified on
  booklet page 6 of 6668730): it gets step numbers, counts, layout and "what was added where"
  right, but misreads shapes (called round 2×2 parts "square") and some colours (red studs →
  "black"). So it describes placement; it does **not** identify parts.

Everything that can be done deterministically is done by our scripts, not by an agent.

## Goals

1. From the booklets of one set + its parts list, produce `<set>.mpd` that loads in BrickMotion via
   the existing importer (`src/io/ldrawImport.ts`) with official steps (`0 STEP`) and sub-builds as
   MPD submodels.
2. Correct parts and colours for every piece (deterministic matching, not AI guessing).
3. Positions/rotations as close to the booklet as the pipeline can get, verified per step against
   the booklet picture.
4. A per-step report (score, flags) telling the user exactly which steps to check by hand.
5. Resumable: a long run can stop and continue from the last good step; the user can hand-fix a
   step and re-run from there.

## Non-goals (v1)

- Themes other than BrickHeadz. Technic, hinges, clips at angles, flexible parts are out of scope;
  if one appears it is placed beside the model and flagged.
- An in-app UI. v1 is terminal scripts; the user opens the resulting MPD in BrickMotion and fixes
  it with the existing editor (raise/lower shortcuts, gizmo, etc.).
- Zero-review perfection.

## Anti-goals (would make this a failure even if it "works")

- Silently guessed parts or colours. A part that can't be identified confidently must be flagged,
  never quietly substituted.
- A model that *looks* finished but has steps in the wrong order or pieces merged into the wrong
  step — the build animation depends on the official order.
- Agent output trusted without verification: every agent placement passes through `check` and
  `score` before it is accepted.

## Inputs

- **Booklet PDFs** of one set, as local files or lego.com URLs (downloaded to a work folder).
  Example set **40859** (Batman & Superman BrickHeadz) = booklets `6668729`–`6668733`. Facts
  observed:
  - Pages are 383×289 pt. Step numbers and part counts ("1x", "2x") are real PDF **text** with
    positions. Callout boxes are pale-blue rounded rectangles with **one embedded image per part**.
    Each step picture is one embedded JPEG. No highlight marks new parts; the camera barely moves
    between consecutive steps.
  - Only the **last** booklet of a set holds the inventory page, as text: `2x 243126 1x 6639188 …`
    (count + LEGO **element ID**, each element = one part in one colour) with a part image above
    each. Booklets 1–3 have no inventory. Some booklet IDs may be language duplicates (6668729 and
    6668730 have identical page counts/text) — dedupe by content.
- **Parts list** from the user (e.g. a BrickLink/Rebrickable-style screenshot or export): design
  IDs like `3023`, `22885`, `3069b`, printed parts like `87079pr0255`, with counts; colour shown only
  as a picture. The user's first screenshot appears cut off at the top (no red/yellow/skin-tone
  parts though the booklets use them) — the tool must report count mismatches against the booklet
  inventory rather than trust either list blindly.

## Pipeline

Six stages, each writing to a per-set work folder (`work/<set>/…`) so any stage can be re-run.

1. **Gather** (script, no AI). Download/dedupe booklets; split into steps in booklet order using
   step-number text; for each step record: step number, page, step-picture crop, callout part
   crops with their counts (count text nearest each callout image), sub-build boundaries (see
   below), and the inventory (element ID + count + crop) from the last booklet.
2. **Identify** (script, no AI). Get the set's inventory from the **Rebrickable API** (user's
   decision): each row gives element ID, quantity, and the LDraw part and LDraw colour IDs directly.
   Key from env `REBRICKABLE_API_KEY`.
   Assign each callout crop to an inventory element by image similarity against the inventory
   crops (same booklet art style — this is the reliable match), constrained by remaining counts.
   Printed parts with no LDraw file fall back to the unprinted part and are flagged.
   Output: `parts-by-step.json`, every entry `{part, color, count, confidence}`.
3. **Describe** (DeepSeek Flash via CommandCode, headless `commandcode -p … -m deepseek/deepseek-v4.1-flash`).
   Per step, give it the previous and current step pictures plus the *known* parts for the step
   (names, colours — so it doesn't have to identify them) and ask where each new part went,
   relative to visible features, in a fixed JSON shape. Output: `describe/<step>.json`.
4. **Build** (Big Pickle via OpenCode, headless `opencode run -m opencode/big-pickle`). It works
   step by step through a small CLI we provide (below), turning the description into placements,
   then `check`s and `score`s until accepted. It never edits the MPD file directly.
5. **Verify** (script + DeepSeek). `score` renders the step from the booklet camera and compares
   it with the booklet picture. Below threshold, DeepSeek gets render + booklet picture side by side
   and returns a short text diff ("grey round plate should sit one plate higher"), which is passed
   back to Big Pickle. Bounded retries per step; a step that still fails is accepted *as flagged*.
6. **Output.** `40859.mpd` + `report.md` (per step: score, attempts, flags, unidentified parts).

### Builder CLI (what Big Pickle drives)

Commands over the work folder's current model, all text in/out, deterministic:

- `parts <step>` — the identified parts for this step and what's still unplaced.
- `place <part> <color> <x> <y> <z> <rot>` / `move` / `rotate` / `remove` — stud-grid coordinates
  (x/z in studs, y in plates, rot in 90° turns), same convention as BrickMotion plans
  (`src/plan/types.ts`, `moveItems` in `src/plan/ops.ts`), so placements map straight onto existing code.
  SNOT (sideways) parts in BrickHeadz need orientation beyond Y-rotation: support the 6 axis-aligned
  "up" directions × 4 turns.
- `check` — collisions and unsupported/floating parts, using the app's existing geometry/metrics.
- `score <step>` — match percentage plus a coarse text diff by image region and colour.
- `accept <step>` — commit the step; `save` — write the MPD.

## Sub-builds

Booklet sub-builds (framed panels / "1 2 3" sequence markers, the arrow attaching a finished
sub-build) become MPD submodels referenced from the parent step, so BrickMotion animates them as
units. If detection is uncertain, keep the parts inline in the parent and flag it — never drop
or duplicate parts.

## Constraints

- Runs on the user's Mac from the repo (`scripts/…`, `npm run …`), Node + TypeScript like the
  existing scripts; reuse `src/ldraw/*`, `src/plan/*`, `src/io/ldrawExport.ts` rather than
  re-implementing LDraw handling.
- Agents are invoked headless and must be scriptable/resumable; each call's prompt, inputs and
  output are logged in the work folder.
- Downloaded PDFs are untrusted data: read them, never execute anything from them.

## Decided by the user

- Parts come from the Rebrickable API.

- Start with BrickHeadz; fidelity first; user will hand-fix remaining errors.
- User supplies the parts list per set.
- Builder = OpenCode / Big Pickle. Visual work = CommandCode / DeepSeek Flash.
- Terminal pipeline producing an MPD (user said "write a script or something").

## My calls (user should check)

- Parts are identified by our scripts (callout crop ↔ inventory crop matching + element IDs), not by
  either agent, because DeepSeek misread shapes/colours in the probe.
- `deepseek-v4.1-flash` over `deepseek-v4-flash-vision-exp`: both claim vision; 4.1 is the
  non-experimental one and passed the probe.
- Verification renders headless with the app's own three.js pipeline in a headless Chromium
  (Playwright as a dev dependency). Nothing in the repo renders outside the browser today.
- First target set: 40859.
- **Multi-figure sets → one MPD.** Each figure/build (Batman, Superman) is a submodel built in
  booklet order; the main model places them side by side. One file keeps both in one BrickMotion
  project; the existing importer already handles submodels.
- **The booklet inventory is the source of truth** for parts and colours (element IDs). The user's
  parts list is a cross-check and a fallback for sets whose booklets lack an inventory. If it is a
  screenshot, its design IDs and counts are read as text (they are printed text, unlike colours);
  colour comes from the booklet. Count mismatches between the two go in the report.
- **Our script runs the step loop**, calling each agent once per step/attempt with a prepared prompt
  and parsing its answer. Agents get no shell in the repo. This makes resume, logging and safety
  ours. The builder CLI commands are exposed to Big Pickle as the allowed actions in its answer
  format, executed by our script.
- **Colour mapping:** taken from the Rebrickable API's LDraw external IDs (user chose the API); a
  colour without one is flagged, never guessed. The API inventory replaces the user's parts list
  as the cross-check and as match images for booklets without an inventory page.

## Delegated by the user ("proceed as you deem fit") — my calls

- **Two phases.** *Phase 1 (no AI):* stages 1, 2 and 6 — an MPD with correct parts, colours, step
  order and sub-builds, each step's new parts laid out beside the model (not placed), plus the
  report. Useful on its own and the base for Phase 2. *Phase 2:* stages 3–5 — agent placement and
  verification. Each phase ships separately.
- **Success on 40859:** Phase 1 — every inventory part accounted for in exactly one step with the
  right colour (or flagged), step count equal to the booklets'. Phase 2 — at least 80% of steps
  accepted unflagged, with the rest listed in the report.
- **Playwright** is added as a dev dependency for headless rendering in `score`.
- **Budget:** describe and score every step; at most 3 build/verify retries per step; every agent
  call is logged with its duration so cost per set is visible. A `--max-calls` flag stops the run
  cleanly (resumable) when reached.

## Left to the builder

- Image-similarity method for callout↔inventory matching, and the score metric.
- Booklet camera estimation for `score` (e.g. fit from the first steps' known geometry).
- Retry limits and the score threshold (tune on 40859).
- Exact prompt wording for both agents, and work-folder layout.
