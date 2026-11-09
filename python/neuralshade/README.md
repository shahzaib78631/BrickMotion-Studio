# neuralshade: a learned shader for the viewport

A small U-Net that turns what the three.js viewport knows about each pixel into the pixel BrickLink
Studio's EyeSight path tracer would draw. EyeSight is the teacher; the viewport runs the student on the GPU
(`src/render/neuralShade.ts`, WebGL2, no extra dependencies).

**Input (12 channels):** the viewport's own frame (3), EyeSight colours of the bricks (3), world normal (3),
brick coverage (1), view distance ÷ 2000 (1), height above the floor ÷ 64 studs (1).
**Output:** `clamp(frame + correction)`. Fully convolutional, so any resolution works.

## The loop (everything lives in `data/neuralshade/`, which is not committed)
1. `npm run neural:scenes -- --count 48 --seed 3`: packs 2×2…5×5 grids of different models (BrickNet, OMR sets, the character
   projects except Hellboy) under random cameras. Writes `scene_<id>/scene.json` + `scene.dae`.
2. `npm run neural:targets`: EyeSight renders every scene without a `target.png` (about 9 minutes each; resumable).
   Add `-- --prefix scene_03` to do one batch first.
3. G-buffers, from a dev server (`npm run dev`): open `/neural.html?queue=scene_03000,scene_03001,…`. Each scene saves
   `frame / albedo / normal / pos .bin.gz`, then the page moves on to the next one by itself.
4. `npm run neural:train -- --steps 5000 --holdout 1`: trains on every scene that has a target and buffers; the last one is held out.
5. `npm run neural:export -- ../../data/neuralshade/shadenet_vN.pt --out ../../public/models/shadenet_vN`: weights for the browser.
6. Try it: `studio.setNeural('/models/shadenet_vN')`. Pages: `/neural-live.html?scene=…&x=…&y=…&model=…` (viewport / network / EyeSight),
   `/neural-test.html?model=…` (WebGL vs PyTorch on one crop, after `python -m neuralshade.dump_test`),
   `/calibrate.html?t=55&ref=ref_mid.png` (the Hellboy project against its EyeSight frames; `calib.studio.setNeural(url)`).

## Things learned the hard way
- GL rows run bottom-up, the training images top-down: the conv shader mirrors the vertical taps.
- Packed 16-bit bytes cannot be antialiased: depth/height go in a half-float target.
- A trained network's activations need the exact weights uploaded: three.js leaves `UNPACK_FLIP_Y_WEBGL` on after image uploads, so the
  constructor uploads with default pixel-store state.
- Albedo is an sRGB render target; the pack shader re-encodes it so the network sees the stored bytes it trained on.
- Keep Hellboy (`BrickMotion-Data/02 - Hellboy`) out of training: it is the real-world check.
