# BrickLink Studio — Complete Rendering Pipeline

Reverse-engineered from the installed BrickLink Studio 2.0 build
(`/Applications/Studio 2.0/`) with REA (`rea-agents`), 2026-11-05, and mapped onto
BrickMotion Studio's Three.js renderer.

## Architecture

BrickLink Studio renders in three separate engines:

| Stage | Engine | Where |
| --- | --- | --- |
| Interactive viewport | Unity (Mono), OpenGL/Metal | `Studio.app` (`Contents/Resources/Data/Managed/`) |
| Photorealistic still/video | **EyeSight** — a standalone fork of Blender's Cycles path tracer (`ccl::` namespaces) | `PhotoRealisticRenderer/mac/eyesight` |
| POV-Ray export | POV-Ray 3.7 + LGEO parts library | `povray/` |

The viewport is a real-time approximation; EyeSight is the reference pipeline.
Its scene format is Cycles XML (`<eyesight version="2.24">`), authored from
Blender-style node shaders (`background_shader`, `emission`, `connect
from_node=… to_socket=Surface`).

## EyeSight pipeline (the reference)

```
scene (Cycles XML) → BVH build → path tracing → film → denoise → post (glare + tonemap) → encode
```

### 1. Scene conversion
Studio exports the model to EyeSight XML: LDraw parts tessellated with
`eyesight.dicing_rate=4.0`, `texel_per_pixel=4.0`, max subdivisions 12, mip levels
up to 4, one time step, spatial-split BVH off.

### 2. Path-tracing integrator (`settings_v1.xml`, integrator element)
- Method: unidirectional **path tracing** (`method="path"`)
- Bounces: total 32; diffuse ≤ 3, glossy ≤ 4, transmission ≤ 32, volume ≤ 32
- Sampling: **correlated multi-jitter**, animated seed, 128 AA samples (viewport) / **256 samples** (final)
- Variance control: `filter_glossy=1.0`, `sample_clamp_indirect=40.0`,
  `light_sampling_threshold=0.01`, sample all lights direct + indirect, MIS
- Tiles: **64×64**, Hilbert-spiral order, progressive refine off
- Volume: 1024 steps, equiangular sampling

### 3. Film
- Exposure 1.0; reconstruction filter **Blackman–Harris, width 1.5 px**
- Passes: combined, ambient occlusion, emission (`pass_alpha_threshold=0.5`)
- Denoiser (feature/pass based, radius 10, strength 0.5; glossy/transmission/scatter
  passes denoised, diffuse/emission left raw)

### 4. Post-processing (Cycles post nodes found in the binary)
- **Glare** (`PostprocessGlareNode`): threshold, ghost, streaks, simple-star, fog-glow mixers
- **Tonemap** (`PostprocessTonemapNode` + `PhotoreceptorTonemapOperation`)
- Lens dirt texture (`textures/LEGO_LensDirtTexture.jpg`) and scratch textures
  (`LEGO_ScratchTexture*`) feed the post stack

### 5. Camera (`settings_camera_light.xml`, camera element)
Physical lens model: 50 mm lens, 36 mm horizontal sensor, aperture (radius type,
blades, rotation), focal distance, lens shift, 1920×1080, near 0.1 / far 8000.
Aperture size 0 (pinhole) by default; DOF comes from `focaldistance` + aperture.

### 6. Lighting rigs
`settings_camera_light.xml` ships named presets. Each preset is N distant lights
(Cycles sun: direction, size = softbox diameter, emission colour, strength,
`use_mis`) plus optionally one ambient light. Defaults (all white emission):

**DEFAULT** (ambient rgb 0.01 × 1.0 + 3 suns):

| light | size | strength | direction (subject→lamp, Y-up) |
| --- | --- | --- | --- |
| Hemi.002 (key) | 0.1 | 2.0 | (-0.57, 0.50, -0.65) |
| Hemi (fill) | 0.5 | 1.5 | (0.88, 0.34, 0.35) |
| Hemi.001 (rim) | 0.2 | 1.0 | (-0.61, 0.65, 0.45) |

**BUILD** (4 equal 1.0-size softboxes, no ambient; strongest = key):

| light | strength | direction |
| --- | --- | --- |
| Light_FL (key) | 3.0 | (-0.61, 0.65, 0.45) |
| Light_FR | 1.0 | (0.61, 0.78, 0.15) |
| Light_RL | 1.0 | (-0.57, 0.50, -0.65) |
| Light_RR | 1.0 | (0.66, 0.50, -0.56) |

**MECHANIC** (6 suns; Main 1.0, two greys at 0.22, subs at 0.2–0.5, sizes 0.1–0.8):

| light | size | strength | direction |
| --- | --- | --- | --- |
| Light_Main (key) | 0.15 | 1.0 | (-0.50, 0.37, 0.79) |
| Light_Sub01 | 0.8 | 0.5 | (-0.60, 0.13, 0.79) |
| Light_Sub03 | 0.15 | 1.0, grey 0.22 | (-0.51, 0.38, -0.77) |
| Light_Sub02 | 0.3 | 0.3 | (-0.60, 0.40, -0.70) |
| Light_Sub04 | 0.1 | 0.2 | (0.89, 0.33, 0.31) |

Directions above are decoded from the preset matrices (light travel = −Z column of
the transform), converted from Z-up to Y-up and negated to the
subject→lamp convention used by `photoRigs.ts` / `looks.ts` keyDirections.

### 7. Environments and set
- `LEGO_StudioSet.xml`: background shader colour (0.30, 0.55, 0.65) × strength 0.15
  → sRGB ≈ `#94C3D2` teal studio backdrop; AO distance 10, factor 0 (off by default)
- `HDR/TexturesCom_Pano029.hdr`, `HDR/TexturesCom_Pano040.hdr`: IBL skies

### 8. Output
PNG/TGA/TIFF (8/16/32-bit, float), JPEG, GIF, HDR; video via bundled ffmpeg.

## LGEO material model (POV-Ray export pipeline)

`povray/LGEO/lg/lg_color.inc` (LGPL, updated by "blstudio" tweaks) maps every
LDraw colour to one of these finishes (assumed_gamma 1.0, conserve_energy):

| finish | diffuse | specular | reflection | notes |
| --- | --- | --- | --- | --- |
| lg_solid | 1, brilliance 1, phong size 40 | phong 1 | 0.025, falloff 1 | standard ABS |
| lg_chrome | 0.6, brilliance 5, metallic | 0.7, roughness 0.01 | 0.35, falloff 2 | mirror metal |
| lg_metallic | 1, phong size 10 | 0.3, roughness 0.2 | 0.025 metallic, falloff 0.5 | silver/metallic |
| lg_pearl | 1, phong size 40 | 1, roughness 0.1 | 0.015 | pearl |
| lg_rubber | 1, phong 0.5 size 20 | — | 0 | tyres |
| lg_transparent | 1, phong size 40 | phong 1 | 0.015 | clear glass |
| lg_transparent_neon | diffuse 2, ambient 0.05, **emission 0.05** | phong size 40 | 0.01 | light-up |
| lg_milky | diffuse 1, ambient 0.05, **emission 0.05** | phong size 40 | 0.01 | frosted |
| lg_glitter | ambient 0.2, phong 0.2 size 40 | — | 0.015 | crackle pigment flakes |

Normals: bumps 0.05 scaled per finish (chrome scale 50, metal 0.02, pearl 0.01,
rubber 0.1) — the "moulded grain".

## Mapping into BrickMotion Studio

Implemented (this commit):

- **`photoRigs.ts`** — the exact decoded EyeSight rigs as editable rigs:
  `default` (DEFAULT), `building` (BUILD), `mechanic` (MECHANIC), each as
  3 suns + 1 ambient with the decoded directions, sizes → shadow softness,
  strengths scaled into the app's intensity range.
- **`looks.ts`** — new photo scene `eyesight` (teal `#94C3D2` backdrop, DEFAULT rig
  as its studio lighting); new finish `chrome` (LGEO chrome); new glass look
  `milky` (LGEO milky); new texture `scratches` (LEGO_ScratchTexture style);
  the two EyeSight skies as environments (`public/hdri/bricklink_pano029_1k.hdr`
  and `bricklink_pano040_1k.hdr`, downscaled 1k copies of the TexturesCom HDRs
  bundled with Studio — see `public/hdri/CREDITS.txt`).
- **`materials.ts`** — `milky` glass and `scratches` texture shader branch;
  glass choice now drives transparent parts in the viewport, not only path-traced
  renders.
- **`pathTracedStill.ts`** — EyeSight integrator parity: bounces 8
  (3 diffuse + 4 glossy + headroom), transmissive bounces 32, filterGlossyFactor
  1.0 (EyeSight `filter_glossy=1.0`), `milky` glass handling.

Viewport quality pass (matching an EyeSight product reference frame):

- New photo scene **`bricklink-white`** ("BrickLink product"): white seamless
  backdrop, strong upper-front-right key, low fill/rim/env for real modelling,
  soft PCF shadows, AO 0.85/0.5, no outline edges — now the default studio look
  for fresh settings.
- Photo scenes' ambient occlusion deepened (0.65 → 0.8, radius 0.5), and the
  AO shader's upright-face floor raised (0.25 → 0.4) so seams between stacked
  bricks darken like the path-traced reference instead of reading flat.
- `catalog` and `render` finishes get broader, softer highlights (higher
  roughness and clearcoat roughness, more sheen), closer to the EyeSight
  satin-ABS look.

Not yet implemented (documented as future work):

- Cycles-grade denoiser, glare post node, lens dirt compositing
- 64×64 Hilbert tiles (the app's 384 px tiles are a GPU-watchdog workaround)
- POV-Ray/LGEO export path (LGEO is LGPL; a wasm POV-Ray build would make it possible)

## Beyond rendering: connection analysis

BrickLink Studio ships per-part connectivity data (`ldraw/connectivity/*.conn`,
LDCad format). BrickMotion derives the same connections at runtime from the
measured geometry and the shadow library (`src/plan/connectors.ts`), and now
also reasons over the mated pairs:

- **`src/plan/connectionGraph.ts`** — `modelConnections()` finds every mated
  pair in the assembly (stud/socket, pin/hole, bar/clip, finger-hinge knuckle
  runs, each pair counted per stud), and `connectionChecks()` adds Studio-style
  stability warnings: a piece held by a single stud or clip is flagged as
  `weak` (a pin holds firmly, a hinge is meant to swivel, and the supporting
  piece under a single stud is not weak).
- **Inspector → Connections** — the selected piece's mates are listed
  ("8× stud to 3001 · 1× pin to 4274").
- **Checks panel** — the new `Weak connection` group, clickable to select the
  piece.

## Driving the real EyeSight binary (reverse-engineered CLI)

EyeSight can be run outside Studio. Confirmed contract (from the binary's own
option table and from live runs):

```
eyesight [options] [settings.xml] [inc_settings.xml] ...
  --daefile <path>          COLLADA .dae model (the geometry; NOT in the scene XML)
  --daewindingorder <cw|ccw>  Collada vertex winding order
  --dae-transx/y/z <cm>     move the collada scene
  --dae-rotx/y/z <deg>      rotate the collada scene
  --dae-scale <f>           scale the collada scene
  --defaultlightcamera      use the built-in default camera and lights
  --defaultlight / --adddefaultlight
  --preset <name>           active preset config
  --param <node> <n> <v>    override a shader parameter
  --output <file> --img-format <png|jpg|exr|...>
  --fps, --time-start/end, --frame-start/end/current/sub   (movie frames)
  --device <name>, --device-count <n>, --logpath, --tmp-dir, --spotname
```

Run it from `PhotoRealisticRenderer/mac/` (it loads `./lib/*.dylib` by relative
path) or copy `eyesight`, `lib/`, `textures/` and `HDR/` somewhere writable — it
writes `logs/` next to itself and hangs at exit once it has saved the image
(kill it after the `Simultion result is saved to` line).

Settings XML files (all under `PhotoRealisticRenderer/mac/`):
- `settings_v1.xml` — the LEGO material library: node groups `SOLID-GROUP`,
  `CHROME-GROUP`, `PEARL-GROUP`, `MILKY-*`, `RUBBER-*`, `SATIN-GROUP`,
  `GLITTER-TRANS-GROUP`, `STICKER-GROUP`, plus the limit-free integrator and
  film defaults and the procedural scratch/dirt/bump texture graphs
  (`BigScratchTexture`, `DirtOnScratchMixGroup`, …). Materials are named after
  LEGO colours (`SOLID-WHITE`, `METAL-BLACK`, `PEARL-BLUE`, …).
- `settings_camera_light.xml` — camera + the lighting presets (DEFAULT, BUILD_FL/FR/RL/RR, MECHANIC_*, NO_LIGHT)
- `LEGO_StudioSet.xml` — the studio set (background shader, AO)
- `settings_image_format.xml`, `settings_movie_format.xml`, `lib/extra.khm` (postprocess graph: colour curves, clip)

Scene XML shape (verified: parses, and camera/background/lights/integrator/film
all render):

```xml
<eyesight version="2.24">
  <integrator .../><film .../>
  <background><shader>…background_shader + connect…</shader></background>
  <camera …><transform matrix="row-major 16 floats"/></camera>
  <light type="distant" …><transform …/><shader>…emission + connect…</shader></light>
  <group>
    <shader name="…">…bsdf nodes + connect…</shader>   <!-- shaders are group-scoped -->
    <transform matrix="…"><object name="…"><state shader="…">…</state></object></transform>
  </group>
</eyesight>
```

The scene reader's known node names are exactly: `integrator`, `postprocess`,
`curves`, `camera`, `background`, `light`, `transform`, `preset`, `movie_format`,
`image_format`, `include`, `group` (with `shader` definitions), `film`.
There is **no mesh/object/state node in the scene reader** — geometry comes only
from the COLLADA file passed with `--daefile`.

Geometry source in the install: `data/collada_mesh/<part>-<surface>.xml` — one
COLLADA `<geometry>` fragment per part (positions + normals, `material="Base"`).

**Open item:** a hand-written `.dae` (COLLADA 1.4.1, Z_UP, cm units, triangles +
material binding) loads without error but contributes no visible geometry, at any
scale or winding order — so the loader wants something more (likely the exact
document/materials shape Studio's own exporter writes). The fastest way to close
this is to export once from Studio (File → Export As → Collada) or capture the
argument list Studio passes to `eyesight` during a render; everything else in the
pipeline (camera, lights, background, materials, integrator, film, output) is
already verified working.

### Studio's own .dae export (verified working through EyeSight)

A real `File → Export As → Collada` file from Studio renders correctly through the
`eyesight` binary (`--daefile model.dae --output out.png settings_v1.xml`). Its
shape, which `scripts/render-eyesight.ts` reproduces:

- `<asset>`: `<unit name="LDU" meter="0.04"/>` and `<up_axis>Y_UP</up_axis>`
- `library_cameras`: one `<camera id="camera_id_main">` with `aspect_ratio`/`xfov`
  and an `eyesight` extra carrying `resolution_x`/`resolution_y`
- `library_lights`: `<directional>` and `<ambient>` with `eyesight` extras
  (`<size>`, `<intensity>`); the visual-scene light nodes add `cast_shadow`,
  `use_mis`, `max_bounces`, `samples`
- `library_effects` + `library_materials`: one material per LDraw colour, **named
  with Studio's material library convention** (`SOLID-ORANGE`,
  `SOLID-LIGHT_BLUISH_GRAY`, `TRANS-…`, `CHROME-…`; `-logo` variants for stud
  logos) so settings_v1.xml binds its real shaders
- `library_geometries`: one `<geometry>` per part — duplicated per-corner
  positions + normals and `<triangles material="Base">`
- `library_visual_scenes`: `<node id="Model"><matrix>1 0 0 0 0 -1 0 0 0 0 1 0 0 0 0 1</matrix>`
  (LDraw Y-down → COLLADA Y-up), piece nodes with LDU matrices and
  `bind_material`/`instance_material symbol="Base"`, a camera node, light nodes
- `<scene><instance_visual_scene url="#VisualScene1"/></scene>`

`scripts/render-eyesight.ts` writes exactly this (plus the project's saved camera
scaled from studs to LDU), then runs EyeSight with `settings_v1.xml` and
`LEGO_StudioSet.xml` and saves `render.png`. `--dae-only` stops after the COLLADA
file.

The render now uses the app's own in-app exporter (`src/export/collada.ts`): the app's
LDraw→world root transform (rotX(π), 1/20 scale) is baked into every node matrix,
the camera and lights are given in the same stud-space, and the file is written in
Studio's row-major matrix dialect. That keeps geometry, camera and rig in one
coordinate space — the earlier empty renders came from mixing a Y-flipped LDU
model with a stud-space camera. With this, `npm run render:eyesight -- model.brickmotion`
produces a correctly framed, lit EyeSight still of the project.
