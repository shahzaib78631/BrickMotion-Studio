# 🧱 BrickMotion Studio

Design brick-built sets, or have Claude invent them, then export a vertical (9:16) build animation for TikTok, Reels or Shorts. Parts start laid out on a white studio floor, fly into place in build order, and the video ends on a hero orbit.

## Setup

Needs Node 22+ and Chrome (MP4 export uses the browser's H.264 encoder).

```bash
npm install
npm run setup   # once: downloads the LDraw parts library (~150 MB zip, ~620 MB unpacked) and the Rebrickable catalog
npm run dev     # open http://localhost:5173
```

`npm run setup` puts the parts in `public/ldraw/` and the catalog in `public/data/`. Both are git-ignored. `npm run build` copies them into `dist/` too (≈700 MB), so the app is meant to run locally.

## Workflow

1. **Get a plan**
   - **✨ AI → Generate with Claude**: describe a set ("a tiny orange seaplane with twin floats"). Needs your Claude API key in **☰ → Settings**. The key stays in this browser.
   - **✨ AI → Copy AI prompt**: copies a prompt for any chat assistant (ChatGPT, Claude.ai…). Paste its answer under **✨ AI → Paste plan**.
   - **Import…**: open a `.json` plan, or an LDraw `.ldr` / `.mpd` model (for example an official set from the LDraw OMR).
   - Or build by hand: pick parts on the left; arrow keys move, PageUp/PageDown change height, R rotates, Delete removes.
2. **Fix it**: the **Checks** panel lists floating and overlapping pieces. Click a piece to move it, recolour it or swap the part. **✨ AI → Fix with Claude** sends the checks and your note back to Claude.
3. **Preview**: **▶ Preview** plays the animation inside a 9:16 frame. Set the length (5–60 s), how pieces arrive (one by one, in batches, step by step), the export FPS, the hero orbit and an optional logo. Flights rise above already assembled pieces before crossing the scene, with swept-volume collision checks for simultaneous flights.
4. **Export MP4**: 1080×1920, H.264 at a selectable 24, 25, 30, 48, 50, 60, 90 or 120 fps, rendered at fixed timestamps frame by frame. Browser support for high FPS varies.

Projects save automatically (📁 Projects), and the last one reopens on load.

## Plan format

```json
{
  "format": "brickmotion-plan",
  "version": 1,
  "name": "Mini Jet",
  "steps": [
    { "pieces": [{ "part": "3034", "color": "Dark Bluish Grey", "x": 2, "y": 0, "z": 0, "rot": 0 }] },
    { "pieces": [{ "submodel": "engine", "x": 4, "y": 1, "z": -3, "rot": 0 }] }
  ],
  "submodels": {
    "engine": { "steps": [{ "pieces": [{ "part": "3710", "color": "Dark Bluish Grey", "x": 0, "y": 0, "z": 0, "rot": 0 }] }] }
  }
}
```

- `part` is an LDraw part id (`3001` = Brick 2 × 4). `color` is an LDraw colour name or code.
- `x`, `z` are in studs and `y` is in plates (1 brick = 3 plates, up is positive). The position is the minimum corner of the rotated footprint and the bottom of the piece. `rot` is 0, 90, 180 or 270.
- Submodels are built aside and then attached in one move. They can be placed several times.
- Imported LDraw pieces that sit off the grid use `"ldu": [x, y, z]` and `"matrix": [9 numbers]` instead of `x/y/z/rot`.

A sample is in [`samples/mini-jet.plan.json`](samples/mini-jet.plan.json).

## Development

```bash
npm test            # Vitest
npm run typecheck
npm run build
```

Code map: `src/ldraw` (parsing and geometry), `src/plan` (format and edits), `src/model` (assembly and checks), `src/anim` (pacing, floor layout, flights, camera), `src/export` (MP4), `src/ai` (prompts and the Claude call), `src/ui` (React).

## Credits

- Part geometry: the [LDraw parts library](https://library.ldraw.org/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (ldraw.org).
- Part names and categories: [Rebrickable.com](https://rebrickable.com/).
- three.js for 3D, Mediabunny for MP4 encoding.

LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.
