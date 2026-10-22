# BrickMotion Studio — Design

Date: 2026-10-22
Status: reviewed by a builder check; awaiting user approval

## Intent

The user makes short vertical videos for TikTok / Instagram Reels in the style of
"Puzzleksu" brick-build clips: the parts of a small model lie neatly sorted
("knolled") on a soft white studio floor, then each piece flies into place in build
order, and the clip ends on a hero shot of the finished model (often a lineup of
several models from a series, e.g. a set of mini fighter jets). Reference clips:
`~/Downloads/snapgram.io_mj5xij5bt5n5.mp4`, `~/Downloads/ssstik.io_1792640326062.mp4`
(both ~14 s, 9:16, 30 fps).

The user wants one web app that takes them from idea to a downloaded video:

1. Come up with a fun imaginary set with an AI (inside the app, or by chatting with
   ChatGPT / Claude elsewhere) and get a build plan.
2. Import the plan, fix whatever the AI got wrong in a hands-on editor.
3. Play the 3D build animation and export an MP4.
4. Post it on social media (manually; outside the app).

Existing official sets should also be loadable and animatable.

## Goals

- **Plan format an AI can write reliably.** A simple JSON plan (below) instead of raw
  LDraw coordinates/matrices, which LLMs get wrong.
- **Built-in AI generation:** type "a tiny pirate submarine with a periscope" → plan.
  Also "fix with AI": send the current plan + a note ("left wing is upside down") and
  get a corrected plan.
- **Paste-in plans:** a "Copy AI prompt" button gives the user an instruction prompt
  (format spec + allowed parts list) to paste into ChatGPT; they paste the reply back.
- **Validation** before animating: unknown parts/colors, overlapping pieces, floating
  pieces. Warnings are shown in the editor, outlined in red, clickable to jump to the
  piece.
- **Hands-on editor** (decided with the user):
  - click to select a piece; arrow keys move 1 stud, PageUp/PageDown move 1 plate,
    R rotates 90°, Delete removes;
  - everything snaps to the stud grid;
  - side panel: change color or part of the selected piece, see/change its step;
  - parts library panel: search by name or number, thumbnails, click to add;
  - steps timeline: list of build steps, move pieces between steps, reorder steps;
  - undo/redo;
  - "fix with AI".
- **Animation in the reference style:** white/light-grey seamless studio floor, soft
  shadows, parts laid out sorted on the floor, pieces fly in one by one per step,
  slow camera move, final hero orbit of the finished model.
- **MP4 export at 1080×1920, 30 fps, in the browser** — no server.
- **Optional corner logo/watermark** uploaded in settings (the reference clips carry
  one). Off by default.
- **Load existing sets** from LDraw `.ldr` / `.mpd` files (e.g. downloaded from the
  LDraw Official Model Repository, ~1,470 sets, or exported from BrickLink Studio),
  using the file's own `0 STEP` order for the animation.
- **Projects saved locally** (browser storage) and exportable/importable as plan files.
- **Any model size** (decided by the user): small 30–60 piece models like the
  references, up to official sets with hundreds or thousands of pieces. Large models
  must still render smoothly in the editor and preview, fit the 9:16 frame, and make
  videos of a sensible length (see Pacing).
- **Sub-assemblies** (decided by the user): a model can contain submodels (an engine,
  a wing). In the animation a submodel is built off to the side first, then flies in
  as one chunk and attaches, like real instruction booklets. Imported `.mpd` files keep
  their submodels; AI plans may use them.

## Non-goals (v1)

- Music or sound effects — the user adds those in TikTok/Instagram.
- Free-angle rotation, hinges, moving parts, flexible parts (hoses, strings).
  Studs-on-grid with 90° turns covers the reference models.
- Snapping by real connector data (LDCad-style stud/anti-stud metadata). Grid snapping
  is enough for v1.
- Posting to social media from the app.
- Accounts, cloud sync, multi-user.
- Native BrickLink Studio `.io` import (user exports LDraw from Studio instead).
- Photoreal path-traced rendering. v1 uses real-time rendering tuned to look as close
  to the reference as practical; a path-traced export mode can come later.
- Building animations from Rebrickable set inventories — they list parts but have no
  positions, so they cannot be animated.

## Anti-goals (would be a failure even if it "works")

- AI-generated models that look broken in the video (floating, overlapping, pieces
  half a stud off) with no way to see or fix it.
- Export that drops frames, stutters, or depends on the machine being fast — export
  must render frame-by-frame offline, not record the live screen.
- A video that doesn't read as "clean studio brick build" — dark backgrounds, harsh
  lighting, cartoon colors.

## Data sources (researched)

- **LDraw parts library** — https://library.ldraw.org/library/updates/complete.zip
  (146 MB, ~17,000 shapes, update 2026-09, CC BY licensed; the app must show
  attribution). The site sends **no CORS headers**, so the browser cannot load parts
  from it directly. A setup script downloads and unpacks the library into the app's
  served folder once. Units: 1 stud = 20 LDU, brick height 24 LDU, plate height 8
  LDU, −Y is up. Colors come from `LDConfig.ldr` in the library.
- **Three.js `LDrawLoader`** (`three/examples/jsm/loaders/LDrawLoader.js`) loads parts
  and models, resolves `parts/`, `p/`, `s/`, `48/`, supports packed MPD files and
  build steps.
- **Rebrickable bulk CSVs** — `https://cdn.rebrickable.com/media/downloads/{parts,colors,part_categories,themes,sets,inventories,inventory_parts}.csv.gz`
  (parts.csv.gz is ~1 MB; ~65,000 parts, ~28,500 sets). Used for friendly part names,
  categories, and search. Fetched by the setup script, not at runtime. The Rebrickable
  API (key, 1 req/s limit) is not needed for v1.
- **LDraw OMR** — https://library.ldraw.org/omr — source of official set models the
  user downloads and imports.
- github.com/scottcrowley/lego was reviewed: a PHP/Laravel collection manager; useful
  only as a reference for the CSV import approach, nothing reusable.

## The plan format (decided)

JSON, versioned. Positions are on a grid so AI output and editor moves are exact.

```json
{
  "format": "brickmotion-plan",
  "version": 1,
  "name": "Mini Pirate Submarine",
  "description": "A tiny sub with a periscope",
  "steps": [
    {
      "pieces": [
        { "part": "3001", "color": "Light Bluish Grey", "x": 0, "y": 0, "z": 0, "rot": 0 },
        { "part": "3020", "color": 72, "x": 0, "y": 3, "z": 0, "rot": 90 }
      ]
    }
  ]
}
```

- `part`: LDraw part number (no `.dat`).
- `color`: LDraw color code or a color name from `LDConfig.ldr` (case-insensitive).
- `x`, `z`: studs; `y`: plates, up is positive (1 brick = 3 plates). The position is
  the **minimum corner of the piece's footprint** (after rotation) and the **bottom**
  of the piece. This is chosen because the LLM can reason about "a 2×4 brick covering
  studs 0–3 by 0–1" without knowing each part's internal origin. The app converts to
  LDraw origin + matrix using each part's measured bounding box.
- `rot`: 0, 90, 180, 270 degrees around the vertical axis.
- Pieces inside a step animate in listed order.

**Submodels.** A plan may define named submodels with their own steps, and place them
in a step like a piece:

```json
{
  "format": "brickmotion-plan",
  "version": 1,
  "name": "Mini Jet",
  "submodels": {
    "engine": { "steps": [ { "pieces": [ { "part": "3062b", "color": "Dark Bluish Grey", "x": 0, "y": 0, "z": 0, "rot": 0 } ] } ] }
  },
  "steps": [
    { "pieces": [ { "submodel": "engine", "x": 4, "y": 3, "z": 0, "rot": 90 } ] }
  ]
}
```

- A submodel placement uses the same `x/y/z/rot` convention as a piece (min corner of
  the submodel's footprint, bottom). Submodels may nest; cycles are an error.
- The same submodel can be placed more than once (two identical engines). The
  animation builds it once per placement, unless the builder finds a nicer way, such
  as building one and duplicating it.
- `.mpd` import maps each `0 FILE` to a submodel. `.ldr` export writes an `.mpd`.

**Editor with submodels.** The steps timeline is nested: a submodel placement shows as
one step entry that can be expanded to show and edit the submodel's own steps.
Selecting a placed submodel selects it as one unit: move, rotate and delete act on the
whole chunk. Double-click or "Edit submodel" enters it and edits its pieces in
isolation. Validation runs inside each submodel and on the assembled model.

The app also exports the plan as an LDraw `.ldr` (with `0 STEP`) so it opens in
Studio/LDCad/LeoCAD.

**Imported LDraw models** may have off-grid positions or non-90° rotations. They are
kept exactly as imported (raw matrix per piece); the editor's grid moves shift them by
whole studs/plates from wherever they are. They are not forced into the plan grid.

*(Builder's call, made during review.)* Such pieces are stored in the plan with an
optional `"matrix": [a,b,c,d,e,f,g,h,i]` plus `"ldu": [x,y,z]` (raw LDraw placement) in
place of `x/y/z/rot`, so imported projects save and re-import as plan files without
loss. The AI prompt never mentions these fields. "Fix with AI" is offered only when
every piece is on the grid. The overlap and floating checks run on all pieces, using
their actual placement.

## AI generation

- Provider: Claude API, called from the browser with the user's own API key entered in
  settings and stored locally. (Model choice: latest Claude model, configurable.)
- The prompt includes the plan format spec and a **curated parts palette** (a few
  hundred common bricks, plates, tiles, slopes, wedges, cones, canopies, wheels…)
  with their footprints and heights, so the AI only uses parts the app measures well.
  The editor itself can use the full library.
- "Fix with AI" sends the current plan + validation warnings + the user's note.
- The same prompt text is what "Copy AI prompt" gives for ChatGPT.

## Validation

- Unknown part / color → error, piece shown as a placeholder box.
- Overlap: two pieces' solid volumes intersect (beyond a small tolerance; studs
  entering the piece above do not count).
- Floating: a piece neither rests on the ground nor touches another piece above/below
  with overlapping footprint. Exact method left to the builder; box-based is
  acceptable in v1 as long as common parts (slopes, wedges, cones) do not raise
  false alarms in normal use.

## Animation and export

- Scene: seamless light-grey/white floor and backdrop, soft key light + fill, soft
  contact shadows, slight reflections; plain brick plastic material (slightly glossy,
  transparent parts look transparent).
- Layout: before building, all pieces of the model lie on the floor, auto-arranged in
  tidy groups (by step, then by type/size/color) around the build spot, like the
  references.
- Build: per step, each piece lifts off the floor, arcs and drops into place with an
  ease and a tiny settle; steps follow each other with a short pause.
- Camera: high three-quarter view of the floor that slowly drifts while building, then
  a hero orbit of the finished model.
- Sub-assemblies: a submodel's pieces are laid out and built at a side spot on the
  floor (the camera frames it), then the finished chunk lifts, flies and attaches to
  the main model.
- Settings: target video length, pause between steps, hero orbit on/off, logo on/off.

**Pacing (for any model size).** The user picks a target length (default ~15 s; up to
~60 s). The app picks how pieces arrive to fit it: one at a time for small models
(the reference look), several at once for medium models, and a whole step at a time
for large ones. The user can override the mode. Large models must not produce
multi-minute videos by default.

**Floor layout for large models.** The "everything sorted on the floor" look is kept
when it fits. When the model is too large for all parts to be readable on the floor
in a 9:16 frame, only the parts of the next few steps (or of the current submodel)
are laid out, refilling as the build goes. Exact approach left to the builder.

**Performance.** Editor, preview and export must stay usable for models of a few
thousand pieces (e.g. instanced rendering, cheaper shadows or reduced stud detail at
a distance). Offline export of a large model may be slow, but it shows progress and
can be cancelled.
- Preview plays in real time in the app; export renders every frame offline at
  1080×1920 / 30 fps and encodes to MP4 in the browser, then downloads it.

## Constraints

- Runs locally on the user's Mac (macOS, Chrome or the Claude desktop browser);
  started with one command.
- Stack (builder's call, recorded here): Vite + React + TypeScript + three.js.
- One-time setup downloads ~150 MB of LDraw data plus the Rebrickable CSVs.
- Credit LDraw and Rebrickable in the app's About section.

## Later (not v1, noted so the design doesn't block them)

- Series outro: a lineup of several saved models at the end of a video (as in the
  reference clips).
- Path-traced high-quality export.
- Connector-aware snapping; hinges/rotations.
- In-app OMR set browser.
- BrickLink Studio `.io` import.

## Left to the builder

- Exact UI layout and styling.
- Floor layout algorithm details, easing curves, camera paths.
- MP4 encoding approach (e.g. WebCodecs + an MP4 muxer).
- How part footprints/heights are measured and cached.
- Contents of the curated AI parts palette.
- Storage mechanism for projects.
