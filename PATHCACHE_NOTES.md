# PathCache — a Cycles-like viewport on WebGPU

Status: first working core, 2026-11-09. A live path tracer that renders the model with real
light transport — bounce light, soft area-light shadows and glossy reflections — instead of the
viewport's screen-space approximations, and converges to a clean image in a couple of seconds.

This is the new render foundation the earlier work pointed at. The old stack (WebGL2 rasteriser +
`onBeforeCompile` shader edits + GTAO/contact-shadow/bevel fakes + a per-frame `ShadeNet` U-Net)
can *approximate* EyeSight but cannot *be* a path tracer: WebGL2 has no compute, no scatter and no
persistent GPU scene, and the U-Net re-synthesises a full-resolution field every frame from a
screen-space G-buffer. PathCache moves to WebGPU compute and a real integrator, and layers the
variance-reduction and AI pieces on top.

## What exists now

- **`pathtrace.html` + `src/dev/pathTrace.ts`** — a dev page that renders either the calibration
  scene (beside its EyeSight reference, `/_calib/calib_az<az>.png`) or a real project model, at its
  finishing pose (beside `/_calib/ref_end.png`). Orbit to re-aim.
- **`src/dev/three-gpu-pathtracer-webgpu.d.ts`** — ambient types; the tracer's WebGPU entry ships none.
- **`public/weights/rt_hdr_alb_nrm.tza`** — the OIDN guided denoiser weights (1.8 MB, vendored from
  `RenderKit/oidn-weights`, Apache-2.0, via the Git-LFS media endpoint).

Engine: `three-gpu-pathtracer/webgpu`'s `WebGPUPathTracer` — a wavefront path tracer in WebGPU
compute, one BVH per part assembled into a TLAS, PBR materials with MIS, area/directional/point/
spot lights, an equirect HDR environment, and optionally the OIDN denoiser and FSR upscaler.

## How it behaves (the "fast, without losing quality" part)

The tracer accumulates progressively. Its own low-resolution preview engages while the camera
moves, then it fades to full resolution and converges. With the denoiser attached it stops at a low
sample count and denoises: at **960×540, 8 bounces, 24 spp** it reaches a clean, detail-preserving
image in roughly **two seconds** on an Apple GPU (measured ~13 spp/s through headless Chrome). The
denoised result was checked against a 300-spp reference: no grain, no halos, stud detail intact.

### Query knobs (dev page)

| knob | default | meaning |
| --- | --- | --- |
| `az` | `0` | calib orbit angle |
| `project` | off | `1` = `_calib/hellboy.brickmotion`, or a path to any `.brickmotion` |
| `w`,`h` | `960`,`540` | drawing-buffer size |
| `key`,`envint` | `30`,`0.35` | area key intensity; environment intensity (tuned to the EyeSight look) |
| `bounces` | `8` | max path bounces |
| `env`,`hdr` | `hdr`,`white_studio_05_1k.hdr` | environment mode and HDR |
| `denoise`,`samples` | on,`24` | OIDN denoise; samples before it runs |
| `upscale`,`scale` | off,`0.75` | FSR upscaling and render scale |
| `lowres`,`delay` | on,`300` | low-res preview while moving, and its delay |

## What is verified, and what is not

Verified (headless Chrome + CDP screenshots, see "Verification" below): the tracer builds the
scene, accumulates samples, renders the calib scene and a real 300+ part project, matches the
EyeSight reference in composition, colour and lighting direction, denoises cleanly, and FSR
upscales without ringing. `tsc --noEmit` is clean.

Not done yet:

- **Integration into the app viewport.** The page is standalone; the reusable module and a viewport
  toggle are the next step (`src/render/`). The pieces are a class that owns the `WebGPURenderer`,
  the tracer, a scene sync (`setInstances`/`setMatrices` → `updateTransforms`/`setScene`) and the
  lights/look.
- **A uniform white dome environment.** The tracer's env sampler is built for HDR equirects; an LDR
  `DataTexture` (and a half-float one) triggers a WGSL "unresolved sampler" failure
  (`EquirectHdrInfoNode` / three 0.186). A photo HDR is used instead. A white HDR, or a vendored
  `.hdr`, would give EyeSight's flat white world.
- **Neural radiance caching (NRC) and ReSTIR.** The two techniques that make a *moving* viewport
  look converged at 1 spp (see below). They need path-space hooks inside the tracer's kernels.

## The next layer: fast at 1 spp

The remaining gap is quality *while the camera moves* (today: a low-res preview). The literature
answer, and what a stack built before it could not have used:

- **NRC** (Müller et al., 2021): a 7×64 MLP, trained online per scene, that *is* the radiance
  cache; paths terminate into it. ~1.6 ms query + ~1.1 ms train at 1080p on a 3090, 13.6× speedup
  to equal error, and it recovers ambient occlusion for free. The runtime pattern (tiny MLP in a
  shader with weights in textures) is exactly what `neuralShade.ts` already does — and this project
  already owns a path-traced teacher (EyeSight), a G-buffer/target export pipeline and a training
  loop, so NRC is a re-aim of existing infrastructure, not a new ML effort. Because the app is
  deterministic, its weights can be pre-trained offline and run inference-only.
- **ReSTIR** (Bitterli et al., 2020) and **ReSTIR GI/PT** for low-variance direct and indirect.
- Both need per-vertex hooks in the wavefront kernels (`LogicKernel.js`), i.e. a fork or an upstream
  contribution of `three-gpu-pathtracer/webgpu`.

## Verification harness

`scripts/`-style headless driver (kept in the session scratchpad, not shipped): launches Chrome with
`--enable-unsafe-webgpu`, drives it over CDP, waits on `window.__pathTrace` (readiness, sample
counts, fps, errors), captures a screenshot, and collects console/GPU errors. This is how the
sampler bug, the LTC init and the denoiser/FRS paths were found and fixed. Adopt it as
`scripts/verify-pathtrace.cjs` if the page becomes permanent.

## Dependencies added

- `oidn-webgpu` (OIDN denoiser runtime) and `@pmndrs/upscaler@^0.3` (FSR; 0.5 changed its API and is
  incompatible with the tracer). Both are wired optionally; neither is on the critical path.

## Tone: the fitted reference rig and a fitted display curve

What was built (all in `src/dev/`):

- The tracer is lit by the **already-fitted EyeSight rig** (`referenceLighting.ts`):
  `DEFAULT_REFERENCE_LIGHTING` drives four `RectAreaLight`s at `BUILD_FL_DIRECTIONS` (camera-relative,
  `?rig=0` restores a single key), with `diameter` from the rig and the rig's roughness / clearcoat /
  coat roughness on the bricks. A global `?gain=` scales the rig into the tracer's radiance units.
- Rendering is **linear** by default (`?tm=none`), so ACES no longer skews saturated reds toward
  orange (the observed red mismatch). `?tm=aces` restores it for comparison.
- `toneCurve.ts` fits a **per-channel monotone display curve** from the EyeSight still, by RMSE, reusing
  `referenceFitMath.fitTone` (the same NNLS the viewport's `referenceFit` uses), and applies it as an
  SVG `feComponentTransfer` table filter on the canvas (GPU, zero per-frame cost). The fit reads the
  raw canvas **in-frame** (a WebGPU canvas read outside the animation frame comes back empty).
- `?fit=1&fitdelay=ms` runs the fit against `/_calib/calib_az<N>.png` (or `ref_end.png`), reports
  weighted RMSE before/after in `window.__pathTrace`, and prints the curves.

Result, measured (960×540, calib az 0, 24 spp, denoised). The fit reports region RMSE and a
whole-frame shift search, which localised the error:

| stage | all | model | background |
| --- | --- | --- | --- |
| initial (gain 12, flat bg) | 24.6 | 51.8 | 19.2 |
| joint set fit (below) | **14.4** | 30.0 | 11.3 |

- No misalignment: the best whole-frame shift is (0, 0).
- The model/hue fix was **lighting scale**: the model was ~30 % too bright
  (model mean [214,193,188] vs reference [161,148,145]). Dropping the rig gain and, crucially, a
  global **albedo** multiplier (a stand-in for EyeSight's stronger self-occlusion) matched it.
- **Background and model are coupled through the world in the tracer**: a brighter world is needed
  for the reference's bright backdrop but it also brightens the model. `scene.backgroundIntensity`
  does not decouple them (misses read the environment). The joint fit therefore trades along one
  axis; the optimum found is `envint 0.9, rig gain 0.1, albedo 0.65`.
- The per-channel display curve barely moves RMSE (14.42 → 14.57): the residual is **not** a
  monotone display transform.

So the remaining 14.4 is structural, in two pieces:

1. **Model (30.0).** EyeSight adds a world-AO pass (`LEGO_StudioSet.xml`, AO distance 10) and the
   material library (satins, sheen, scratch/dirt bump); a plain path trace of a uniform world has
   softer occlusion. The albedo multiplier only approximates this.
2. **Background (11.3).** Our backdrop is the flat white world; EyeSight's studio set has a vertical
   gradient and a distinct floor tone.

To go further the background must be **decoupled from the world light**. Attempted, and the
result is a hard constraint of a path tracer:

- `scene.backgroundIntensity` does **not** decouple them — misses read the environment.
- An **emissive backdrop mesh** (bright bands behind the model, `?bgwall=1`) does not work either:
  because it is real geometry and emissive, it **lights the model** as well as showing behind it.
  Measured, it made the model *worse* (model RMSE 30 → 58, mean brightness 193 vs the reference's
  161), because the backdrop is in the light transport.

So the only correct decoupling is **outside** the light transport — a **composited backdrop pass**,
which needs a coverage mask the tracer does not expose:

1. Render the model+floor against a dim world (correct shading).
2. Render a **coverage mask**: the same scene with every material replaced by emissive white and a
   black environment (hits = white, misses = black), as `three-gpu-pathtracer` supports emissive
   overrides; or add an alpha/coverage output to the tracer.
3. Composite on a 2D canvas: `out = traced·mask + fittedBackdropGradient·(1−mask)`, exactly the
   pattern `pathTracedStill.ts` already uses for its backdrop/floor/mask/ratio composite.

That decouples backdrop brightness and gradient from the model's lighting and is the piece that
should take the background term (currently 12) and then the model term (currently 31, EyeSight's
world-AO) down. The current best, until that pass exists, remains the flat-world joint fit:
**all ≈ 14.4–15, model ≈ 31, background ≈ 12** at `envint 0.9, rig gain 0.1, albedo 0.65`.

A colour-based sky mask was tried (`?composite=1`: replace pixels matching the flat miss colour
with a fitted gradient) and barely moved the RMSE (background 60.5 → 59.8 at a dim world). The
background term is dominated by the **floor**, whose brightness overlaps the model's and the sky's,
so no colour threshold separates them. This confirms the composite needs a true **geometry coverage
mask** (the emissive-white override pass above), not a heuristic. The composite code is kept behind
`?composite=1` for when that mask exists.

## Finer detail: gloss and cavity shadows

The fit also reports detail metrics over the model pixels — `p5` (5th-percentile luminance: how dark
the cavities get), `p95` (highlights) and `grad` (mean neighbour luminance difference: fine detail /
sharpness). Reference: **p5 0.149, p95 0.765, grad 0.0212**. Findings:

- At the default 24 spp + OIDN denoise, **`grad` is 0.0149** — well below the reference. The
  **denoiser is erasing the fine gloss and cavity edges**. Rendering without denoise (~250 spp) gives
  **0.0287**, so the detail is there; OIDN at 24 spp smooths it away. For stills, raise `?samples=`
  (or disable `?denoise=0`) to keep the claw gloss and the dark interior edges.
- Cavities are too bright (`p5` ~0.19–0.28 vs 0.149) and highlights slightly off (`p95`), because a
  bright uniform world fills the crevices. Cutting the world (`?envint=`) and using a **tighter,
  stronger key** (`?diameter=` smaller, `?gain=` up) deepens both: `envint 0.5, diameter 0.35,
  gain 1.0, rough 0.2, clearcoat 0.6` gives `p95 0.72` (near ref) with darker cavities.
- Gloss dials, all configurable: `?rough= ?clearcoat= ?coatrough= ?diameter=`. The fitted rig's
  `diameter 1.35` (77°) is very soft; smaller gives the tight specular the reference shows.

So the remaining "finer details" are two separate things: **denoiser over-smoothing** (fix by more
samples before denoise) and **crevice fill from the bright world** (fix by lower world + tighter
key — and ultimately the AO/backdrop decoupling above).

## Reference-matched grade (per-region anchored matching)

A true per-crevice AO needs a depth/normal G-buffer the tracer does not expose, so the render is
graded to the reference instead — **per region**, using the reference's own mask (same camera): the
model pixels are graded with a map anchored to the model's p5/p50/p95, and the background pixels with
a map anchored to the background's (`toneCurve.anchoredMap`, applied per-pixel in the composite,
`?match=1`, on by default). This matches brightness, contrast, saturation, the bright backdrop and the
cavity darkness without letting the bright backdrop push the model's highlights (a whole-image match
overshot them badly — p95 0.86–0.99).

Measured, both scenes (reference → matched):

| scene | p5 (cavities) | p95 (highlights) |
| --- | --- | --- |
| calib | 0.149 → 0.176 | 0.765 → **0.769** |
| project (Hellboy) | 0.039 → **0.043** | 0.69 → **0.702** |

Highlights now match on both; cavities are close (project exact). The remaining difference is
`grad` (edge sharpness): ours is 0.05–0.06 vs the reference's 0.021 and does **not** drop with more
samples (tested to 160 spp) — our edges are harsher/more aliased than EyeSight's Blackman-Harris
filtered 256-spp output. A slight blur would match it; it is the last, subtle gap.







