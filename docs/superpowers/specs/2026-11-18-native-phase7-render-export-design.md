# Native phase 7: path tracer, denoise, stills, video and sound — design

**Status:** approved by the owner, 2026-11-18 ("start phase 7"); open questions settled below.
**Parent spec:** `2026-11-15-native-rewrite-design.md` ("bmrender", goal 6, phase 7: *CLI renders stills and video*).

## Intent

Make the pictures and films BrickMotion is for, from the command line, without the web app: a
path-traced still of a model or of any moment of its build, and a film of the whole build with the
sound of each piece seating. They should look like BrickLink Studio's EyeSight renders, as the
viewport already does as far as a raster can, and better where it cannot (glass bending light, wall
thickness, soft contact shadows). This replaces `three-gpu-pathtracer`, ThreeRT and the web MP4
export (`src/export/exportVideo.ts`, `pathTracedStill.ts`, `src/audio/snapSound.ts`).

## What exists

- `bmrender` (phase 6): `Scene` (one group per part and colour, one instance per piece, 3x4 matrices
  relative to `Scene::origin`), `MeshLibrary` (part meshes at three levels of detail, vertex colours
  for printed parts), `Material` (base, alpha, roughness, metalness, clearcoat), `applyFrame` (pieces
  where the build has them at a frame; pieces not yet in are `kHidden`), cameras, offscreen drawing and
  readback, PNG writing. Shaders are text compiled at run time (`cmake/embed_shaders.cmake`), so no
  Metal toolchain is needed.
- The owner's ray-traced glass (111539e, behind `FrameOptions::refractiveGlass`): every triangle
  of the scene copied to world space, one CPU BVH plus one Metal primitive acceleration structure,
  rebuilt whenever a piece moves; exact Fresnel and Snell through the walls (`glass_transport.metal`).
- The look, fitted against EyeSight (README, "The look, against EyeSight"): its BUILD_FL rig (four
  distant disk lights, 45° in radius, fixed to the model as EyeSight's are, white world; 66a6a80),
  plastic of roughness 0.1 under a clear coat, Studio's linear colours, the floor a shadow catcher, glass IOR
  1.49. `native/tools/calib_eyesight.py` scores a picture against EyeSight's renders of `calib.ldr`
  and `glass.ldr` from four azimuths (viewport now: RMSE 6.53 calib, 17.79 glass).
- The timeline (phase 5): 30 fps, one flight per move with its start and length, a camera key a second.
- Sound in the web app: CC0 recordings of real snaps (`public/sounds/snaps/*.wav`, 244 KB, credits in
  `CREDITS.txt`) picked by part size, layered over a synthesised thump and ring, one per seating.

## Goals (phase 7 is done when)

1. `bmexport still <model> --out a.png [--frame N] [--samples S] [--size WxH] [camera] [--rig R]`
   writes a denoised path-traced picture. Same inputs and seed: the same picture, bit for bit.
2. `bmexport video <model> --out build.mp4 [--renderer path|viewport] [--samples S] [--no-sound]`
   writes an MP4 of the whole build (H.264, or HEVC with `--codec hevc`) that plays in QuickTime, with
   the snap track. Frame N of the film is the still of frame N. `bmexport frames` writes PNGs instead.
3. The look: `calib.ldr` and `glass.ldr` scored with `calib_eyesight.py`, shown side by side with
   EyeSight for the owner to judge by eye (the spec's bar), and no worse than the viewport on any column.
4. Part acceleration structures are built once per part per run; a frame where pieces move rebuilds
   only the instance structure. Measured and recorded: a 1920×1080 still of 42000 and 10030-1, a
   frame of film, and the structure build for the 12,148-piece 2×2 scene, on the M1 Pro.

## Non-goals

A path-traced preview inside `bmview` (the app's ▶ Preview can use this later). HDRI files, EXR or
16-bit output, depth of field and output frame rates other than the timeline's (later, in the export
panel of phase 9). Caustics on the floor (a shadow catcher has none, nor has EyeSight). Collada export.

## Anti-goals

- A part with no geometry drawn as nothing: it is the translucent placeholder box, as in the viewport.
- Pictures that change from run to run with the same seed: tests compare them.
- A look further from EyeSight than the viewport's.
- A film whose sound is out of step with its pictures.

## Constraints

macOS 15+, Apple silicon, C++20 and Objective-C++, Metal; `-Wall -Wextra -Werror`. Third-party code:
OIDN only (named in the parent spec). Shaders keep being compiled at run time. The M1 Pro has no
ray-tracing hardware: Metal's intersector runs on the shader cores there, faster on M3 and later.

## Approaches

- **A. Instanced Metal ray tracing (recommended).** One primitive acceleration structure per part
  mesh, cached; one instance structure per frame from the `Scene`'s instances, hidden pieces left out.
  A compute kernel traces paths and accumulates samples; albedo and normal are written alongside for
  the denoiser. Memory grows with distinct parts, not pieces, and a moving piece costs one instance.
- **B. Grow the glass transport into the path tracer.** Least new code at first, but every triangle of
  every piece is copied and rebuilt when anything moves: gigabytes and seconds a frame at 12,000 pieces,
  so it cannot film a build. Its optics (Fresnel, Snell, the safeguard at smoothed edges) carry over to A.
- **C. Render through Blender Cycles**, the renderer EyeSight is. Closest look, but Blender becomes a
  dependency of the app, against the spec's one Metal implementation and small third-party code.
- **D. Hierarchical transport fields** (a proposal the owner passed on, 2026-11-18): keep the raster
  for what is seen, give each part precomputed transport patches and convex occlusion cells, light
  them by clipping each light against the occluders projected around every patch (integrated with
  linearly transformed cosines), and solve the light between patches as a hierarchical linear system
  updated as pieces move. No noise and deterministic, aimed at the live viewport, not at stills and
  film. Not phase 7's way: it is research of months; its cost is unproven where it matters (EyeSight's
  four lights are disks 90° across, so nearly every nearby part falls in them; LDraw parts are far
  from convex; a flying piece changes what static patches see of each other, not only its own rows
  of the system; bricks touching everywhere is where patch methods leak light); and glass leaving one
  piece mostly enters another, so it needs ray queries between parts anyway. It needs a reference to
  be judged against on more than the two EyeSight scenes, which this phase's path tracer is. Worth a
  spike after this phase: its own first step (two boxes and a floor, on the CPU), measured against
  path-traced pictures, by its own gates.

## The how (my calls unless marked)

- **Integrator:** paths with next-event estimation of the rig's lights and multiple importance
  sampling, Russian roulette after three bounces, up to 16 (glass needs many). Seeded per frame,
  pixel and sample, so pictures repeat.
- **Surfaces** from `Material`: plastic is diffuse under a GGX clear coat; metals a tinted GGX
  conductor; transparent colours a dielectric of IOR 1.49 with absorption by distance travelled,
  fitted with the harness; printed parts take their vertex colours.
- **Light:** EyeSight's BUILD_FL by default, fixed to the model (settled, 3); the web app's photo rigs as options.
  The floor is a shadow catcher as in EyeSight (what a ray bent through glass sees of it is fitted).
  No outline lines (EyeSight has none).
- **Denoise:** OIDN's RT filter with albedo and normal, per frame for film; `--no-denoise` keeps
  the raw picture. The spec names OIDN; fetching it needs the owner's yes (below).
- **Film:** AVAssetWriter with VideoToolbox, 8-bit BT.709, the timeline's 30 fps and camera. The
  `viewport` renderer is the phase 6 renderer, optionally with motion blur averaged over subframes
  as the web export does.
- **Long films:** a path-traced film of a large build runs for hours (3,000 moves at two pieces a
  second is 25 minutes of film, 45,000 frames). `frames` takes a frame range and skips frames already
  on disk, so a render can stop and go on; `video --from-frames <dir>` makes the MP4 and its sound from them.
- **Sound:** snaps at each flight's seating frame, chosen and varied as the web app does, from the
  same CC0 recordings, mixed by portable C++ at 48 kHz and written as AAC into the MP4. My call
  against the spec's AVAudioEngine: a mix of short one-shot samples gains nothing from it, and plain
  C++ can be tested sample for sample.
- **Tool:** a new `bmexport` (the library already owns the name `bmrender`), sharing `bmshot`'s
  camera and model options.

## Settled with the owner (2026-11-18)

1. **OIDN** 2.5.1 (`oidn-2.5.1.arm64.macos.tar.gz`, GitHub release `RenderKit/oidn`, sha256 checked)
   is in `vendor/oidn/oidn-2.5.1.arm64.macos`, outside git. It has a CPU and a Metal device.
2. **The render work** landed first: 111539e (glass behind its flag, rounded edges, stud roots, the
   composite fix).
3. **Where the lights are:** fixed to the model, as EyeSight's are, with strengths fitted to its renders
   (66a6a80); stills and film do the same.

## Left to the builder

Kernel layout (one kernel or a wavefront), sampler, how hidden pieces are left out (mask or rebuild),
buffer formats, the AAC bitrate, option names beyond those above, and the order of the plan's tasks.
