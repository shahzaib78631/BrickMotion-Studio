# Native phase 7: path tracer, denoise, stills, film and simulated sound — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bmexport still|frames|sound|video` makes denoised path-traced pictures and a film of the build with simulated snap sound, from the command line.

**Architecture:** Instanced Metal ray tracing: one primitive acceleration structure per part mesh, cached for the run, and one instance structure per frame from the `Scene`. A compute megakernel traces paths and writes beauty, albedo and normal. OIDN denoises. AVAssetWriter writes the film. The sound is a portable C++ library (`bmsound`) that turns each seating into a synthesised snap and mixes them in blocks.

**Tech Stack:** C++20, Objective-C++, Metal (shaders compiled at run time), OIDN 2.5.1 (`vendor/oidn/oidn-2.5.1.arm64.macos`), AVFoundation/VideoToolbox, Catch2.

**Spec:** `docs/superpowers/specs/2026-11-18-native-phase7-render-export-design.md` (approved; sound amended in 9e8058e).

## Global Constraints

- macOS 15+, Apple silicon, C++20 and Objective-C++, Metal; `-Wall -Wextra -Werror`; never silence a warning with a pragma.
- Third-party code: OIDN only. No sound files and no Python in the product. Shaders stay text compiled at run time (`cmake/embed_shaders.cmake`); no Metal toolchain.
- Same inputs and seed: the same picture, bit for bit. Same plan: the same sound, sample for sample.
- The look is no worse than the viewport on any column of the README's "The look, against EyeSight" table (calib 6.53 / 15.70 / 3.65; glass 17.79 / 46.54 / 6.24 / 50.37 / 15.01).
- A part with no geometry is the translucent placeholder box, never nothing.
- The film is 30 fps (`plan::Style{}.fps`), 8-bit BT.709, H.264 (`--codec hevc` for HEVC); sound is 48 kHz stereo AAC.
- Lights fixed to the model (`studioLights(camera, false)`), as the viewport does by default.
- Tests run with `BM_LDRAW_DIR=…/public/ldraw` and `BM_SHADOW_DIR=…/vendor/LDCadShadowLibrary`. Catch2 filters use wildcards.
- One commit per task, with before/after numbers where there are any. Prefixes `feat(native)`, `fix(native)`, `perf(native)`, `docs(native)`. Stage explicit paths only. Never push.

## Review Focus

1. **A film of a large build is interrupted.** It goes on where it stopped. A half-written PNG is never kept: write to a temporary name, then rename. → Task 5.
2. **A 45,000-frame film's sound.** It is mixed in blocks. The whole track is never in memory, and the samples do not depend on the block size. → Task 6.
3. **A machine or build that cannot path-trace.** No compute ray tracing, or OIDN absent from `vendor/`: a one-line error and exit code 2, never a crash. The build still configures without OIDN. → Tasks 1 and 3.
4. **Mirrored pieces and parts with no geometry.** Mirrored pieces keep outward normals. Parts with no geometry are drawn as the placeholder box. → Task 2.
5. **A frame where nothing is built yet.** The instance structure is empty: floor and world only, no crash. A model with no seatings gives a silent track, with no NaN from the normalising. → Tasks 1 and 6.

---

### Task 1: Instances and acceleration structures

**Files:**
- Create: `native/render/include/bmr/path_scene.h`, `native/render/src/prep/path_instances.cpp`, `native/render/src/metal/path_scene.mm`
- Modify: `native/render/tools/common/engine.h`, `native/render/tools/common/engine.cpp` (`Planned` keeps the `connect::Graph` that `planModel` already builds; Task 6 needs it)
- Test: `native/render/tests/path_scene_test.mm`

**Interfaces:**
- Produces (portable):
  - `struct PathInstance { float model[12]; uint32_t mesh; uint32_t material; bool mirrored; };`
  - `std::vector<PathInstance> pathInstances(const Scene&)`: leaves out `kHidden`. A placeholder group maps to its `boxMesh`. `mesh` indexes the distinct (part, `Detail::Full`) meshes in first-seen order.
- Produces (Metal):
  - `class PathScene { static std::unique_ptr<PathScene> create(std::string* error); void prepare(const Scene&, MeshLibrary&); PathSceneStats stats() const; }`
  - `struct PathSceneStats { uint32_t partStructuresBuilt, instances; double instanceBuildMs; }`
  - `create` returns null with "this Mac cannot ray-trace from compute" when `!device.supportsRaytracing`.
- Produces: `bmtools::Planned::graph`.

- [ ] **Step 1: Write the failing tests.**
  - `"path instances leave out hidden pieces"`: on the 3-piece fixture at a frame where one piece is hidden, `pathInstances` returns 2.
  - `"a part structure is built once per part per run"`: `prepare` at frames 0 and 40 of the same model. `partStructuresBuilt` equals the number of distinct parts after both calls.
  - `"nothing built is an empty instance structure"`: at frame 0, before any flight, `prepare` gives `instances == 0` and does not throw.
- [ ] **Step 2: Run them and see them fail** (`bmrender_tests "*path*"`: does not compile).
- [ ] **Step 3: Implement.** Part structures: `MTLPrimitiveAccelerationStructureDescriptor`, one per mesh, compacted, cached in the `PathScene`. Instances: `MTLInstanceAccelerationStructureDescriptor` with `MTLAccelerationStructureInstanceDescriptor` (3x4 transform, `accelerationStructureIndex = mesh`, `userID = instance index`), rebuilt each `prepare`. Mirrored: no special winding; the kernel flips the normal by the determinant (Task 2).
- [ ] **Step 4: Run them; they pass.** Also the whole `bmrender_tests` suite.
- [ ] **Step 5: Commit** `feat(native): part acceleration structures are built once per run and an instance structure per frame`.

### Task 2: The path-tracing kernel

**Files:**
- Create: `native/render/shaders/path_trace.metal`, `native/render/include/bmr/path_tracer.h`, `native/render/src/metal/path_tracer.mm`
- Modify: `native/render/include/bmr/tolerances.h` (path constants: bounce limit 16, roulette after 3, the plastic coat IOR)
- Test: `native/render/tests/path_tracer_test.mm`

**Interfaces:**
- Consumes: `PathScene` (Task 1), `Material` (material.h), `studioLights`, `kRigStrength`, `kRigSinSquared`, `kWorldStrength`, `kGlassIor`, `kGlassAbsorption`.
- Produces:
  - `struct PathOptions { int width, height, samples = 64; uint64_t seed = 0; bool floor = true, lights = true; LightRig rig; float background[3] = {1, 1, 1}; };` (`rig` defaults to `studioLights(camera, false)`)
  - `struct PathImage { int width = 0, height = 0; std::vector<float> beauty, albedo, normal; };` (RGB float, linear, row 0 at the top)
  - `PathImage PathTracer::render(PathScene&, const Camera&, const PathOptions&)`
  - `Image toImage(const PathImage&)`: the viewport's output transform, moved out of `composite.metal` into a function both use, so the two never drift.

- [ ] **Step 1: Write the failing tests.**
  - `"the same seed gives the same picture, bit for bit"`: two renders compare equal with `memcmp`. A different seed differs.
  - `"a sample's random numbers depend on the frame, pixel and sample only"`: render frame 40 alone, then frame 40 after frame 39 in the same `PathTracer`: identical.
  - `"albedo is the piece's colour"`: a red 3001 head-on. The albedo at the centre is within 1e-3 of `linearFromSrgb` of red.
  - `"a mirrored piece's normals face the camera"`: a mirrored 3001. Every hit pixel has `dot(normal, toEye) > 0`.
  - `"a part with no geometry is drawn as its placeholder box"`: the fixture with an unknown part. Pixels at its box differ from the background.
  - `"clear glass lets the floor through"`: a clear 3065 is brighter behind than a black 3065 at the same spot.
  - `"energy is kept"`: a white 1x1 tile (3070b) seen from above, lit by the world alone (`lights = false`, no floor). Its top face, which sees the whole sky, is within 5% of albedo × `kWorldStrength` at 1,024 samples.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the megakernel.**
  - One thread a pixel; samples are looped in the kernel and summed in float.
  - Random numbers: PCG hash of (seed, frame, pixel, sample, bounce). Never anything that depends on dispatch order.
  - NEE over the four disk lights (radius from `kRigSinSquared`) and the white world, combined by the power heuristic. Russian roulette after 3 bounces, at most 16.
  - Surfaces:
    - plastic: Lambert under a GGX clear coat of roughness `Material::roughness`;
    - metal: tinted GGX;
    - `alpha < 1`: dielectric of IOR `kGlassIor` with Beer absorption `kGlassAbsorption × (1 − colour)` per LDU travelled;
    - vertex colour where `Vertex::color != 0`.
  - The floor is a shadow catcher. Its pixel is background × (light reaching it with the model) / (light reaching it without), traced in the same path. A ray bent through glass sees the floor at `kFloorThroughGlass`, as the viewport does, until Task 4 fits it. No outline lines.
  - Albedo and normal come from the first non-specular hit.
- [ ] **Step 4: Run them; they pass.**
- [ ] **Step 5: Commit** `feat(native): a path tracer of the studio's lights, plastic, metal and glass`, with a picture of calib.ldr attached to the message as a path in `build/`.

### Task 3: Denoise and `bmexport still`

**Files:**
- Create: `native/render/include/bmr/denoise.h`, `native/render/src/prep/denoise.cpp`, `native/render/tools/bmexport/main.mm`, `native/render/tools/common/shot_options.h`, `native/render/tools/common/shot_options.cpp`
- Modify: `native/render/CMakeLists.txt`, `native/render/tools/bmshot/main.mm` (camera and model options move to `shot_options`)
- Test: `native/render/tests/denoise_test.cpp`, `native/render/tests/bmexport_test.cpp`

**Interfaces:**
- Consumes: `PathTracer`, `PathImage`, `toImage` (Task 2).
- Produces:
  - `enum class DenoiseDevice { Cpu, Metal };`
  - `bool denoise(PathImage&, DenoiseDevice, std::string* error)`: OIDN's `RT` filter with `albedo` and `normal`, `hdr = true`. Returns false with "built without OIDN" when `BM_HAVE_OIDN` is 0.
  - `struct ShotOptions { …bmshot's camera, size, frame and model flags… }`
  - `int parseShotOption(ShotOptions&, std::span<const std::string_view> args, size_t& i)`: 1 consumed, 0 not mine, -1 bad.
  - `bmexport still <model> --out a.png [--frame N] [--samples S] [--seed K] [--rig R] [--no-denoise] [--denoise-device cpu|metal] [camera…]`
  - `--rig`: `build-fl` only, for now. The web app's other looks are photo environments (HDRI files, studio.ts `photoEnvs`), which the spec puts out of scope, so they come with phase 9's export panel. An unknown name exits 2 and lists the rigs.

- [ ] **Step 1: Write the failing tests.**
  - `"denoising keeps the picture's mean"`: a 64-sample render's mean luminance is within 2% before and after.
  - `"a still is the same file twice"`: run `bmexport still` twice; the two PNGs are byte-identical. The CPU device is the default, because OIDN's Metal device is not guaranteed deterministic.
  - `"bmshot is unchanged by the shared options"`: bmshot's calib picture has the same bytes before and after (the reference PNG is generated at the parent commit into `build/`).
  - `"without ray tracing or OIDN, bmexport says so"`: `BM_FORCE_NO_RT=1` gives exit 2 and a one-line message.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - CMake: `find_package(OpenImageDenoise 2.5 CONFIG PATHS ${REPO}/vendor/oidn/oidn-2.5.1.arm64.macos NO_DEFAULT_PATH)`.
    - Found: link it, `BM_HAVE_OIDN=1`, headers added as `SYSTEM`, and `BUILD_RPATH` set to OIDN's `lib` (its CPU and Metal device dylibs load from there).
    - Not found: a status message and `BM_HAVE_OIDN=0`.
  - Add a `bmexport` executable linking `bmrender bmtools_common bm_warnings`.
- [ ] **Step 4: Run them; they pass.** Record the time of a 960×540 calib still at 256 samples.
- [ ] **Step 5: Commit** `feat(native): bmexport still writes a denoised path-traced picture, the same bytes each run`.

### Task 4: The look against EyeSight

**Files:**
- Modify: `native/tools/calib_eyesight.py` (`--tool bmshot|bmexport` and `--samples`; bmexport is called as `still … --samples S`), `native/render/include/bmr/tolerances.h` (the path tracer's fitted constants), `native/README.md` (rows for the path tracer)

- [ ] **Step 1: Score as it stands.** Run `calib_eyesight.py --tool bmexport --samples 512 --scene calib` and the same for `glass`. Write the rows down.
- [ ] **Step 2: Fit.** One constant at a time: glass absorption, the floor seen through glass, the coat roughness, then the world's and rigs' strengths only if needed. Each change is scored on both scenes.
- [ ] **Step 3: Gate.** No column worse than the viewport's row (Global Constraints). If one stays worse, stop and report it with the side-by-side sheet. Do not commit a regression.
- [ ] **Step 4: The side-by-side sheet.** EyeSight | viewport | path tracer for the four azimuths of both scenes, one PNG in `build/calib/`, for the owner to judge by eye.
- [ ] **Step 5: Commit** `feat(native): the path tracer's glass and floor fitted to EyeSight's renders`, with before/after rows.

### Task 5: `bmexport frames` with ranges and resume

**Files:**
- Modify: `native/render/tools/bmexport/main.mm`
- Test: `native/render/tests/bmexport_test.cpp`

**Interfaces:**
- Produces: `bmexport frames <model> --out DIR [--from A] [--to B] [--samples S] [camera…]` writes `DIR/frame-%06d.png`.
  - It skips a frame whose file exists and reads back with `readPng`.
  - It writes `DIR/frame-%06d.png.tmp` and renames.
  - It prints `rendered R, kept K`.
  - The camera follows the timeline's keys unless one is given.

- [ ] **Step 1: Write the failing tests.**
  - `"frame N of frames is still --frame N"`: frames 10–12, then `still --frame 11`. Files 11 are byte-identical.
  - `"frames resumes where it stopped"`: render 10–12, delete 11, write junk into a `frame-000012.png.tmp`, run again. Output says `rendered 1, kept 2`, file 11 is byte-identical to before, and no `.tmp` is left.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** One `PathScene` for the run; `prepare` per frame; the seed is the frame number.
- [ ] **Step 4: Run them; they pass.**
- [ ] **Step 5: Commit** `feat(native): bmexport frames renders a range and goes on where it stopped`.

### Task 6: Simulated snap sound and `bmexport sound`

**Files:**
- Create:
  - `native/sound/CMakeLists.txt` (library `bmsound`, portable C++, links `bmcore`)
  - `native/sound/include/bms/snap_events.h`, `native/sound/include/bms/snap_synth.h`, `native/sound/include/bms/wav.h`, `native/sound/include/bms/tolerances.h`
  - `native/sound/src/snap_events.cpp`, `native/sound/src/snap_synth.cpp`, `native/sound/src/wav.cpp`
- Modify: `native/CMakeLists.txt` (add `sound`), `native/render/tools/bmexport/main.mm`
- Test: `native/sound/tests/snap_events_test.cpp`, `native/sound/tests/snap_synth_test.cpp`

**Interfaces:**
- Consumes: `bmtools::Planned{plan, timeline, graph}` (Task 1), `plan::poseAt`, `bmr::Camera` for panning.
- Produces:
  ```cpp
  namespace bms {
  struct SnapEvent {
    int frame;                 // the first frame poseAt puts the unit in its seat
    uint32_t move;
    uint16_t mates;            // connector pairs between the unit and pieces already built
    bool ridge;                // one of them grips (Connection::friction): a pin's click
    double grip;               // LDU engaged
    bm::connect::JointKind joint;  // Fixed if any is; else the first in enum order
    bm::Box unit, touching, built;  // the unit, the built pieces it joins, everything built
    uint32_t builtPieces;
    double seatSeconds;        // how long its last travel into the seat took
    double pan;                // -1..1: the unit's centre across the screen at `frame`
  };
  std::vector<SnapEvent> snapEvents(const bm::Model&, const bm::connect::Graph&, const bm::plan::Plan&,
                                    const bm::plan::Timeline&, std::span<const bm::Box> pieceBoxes,
                                    const std::function<double(int frame, bm::Vec3 point)>& screenX);
  struct SoundOptions { int sampleRate = 48000; double peak = 0.89, room = 0.2, stereo = 0.25; };
  class Mixer {
   public:
    Mixer(std::vector<SnapEvent>, int frames, double fps, SoundOptions = {});
    uint64_t length() const;            // ceil(frames / fps * sampleRate)
    void render(float* left, float* right, size_t count);  // the next `count` samples, normalised
  };
  bool writeWav(Mixer&, const std::filesystem::path&);  // 16-bit PCM, streamed in blocks
  }
  ```
- Produces: `bmexport sound <model> --out snaps.wav`.

**The simulation** (the spec's "my call"; every constant lives in `bms/tolerances.h` as a starting value, tuned by ear):
- **Events.** One event per top-level move that has `Flag::None` and `frames > 0`. Flagged moves appear without a flight and are silent. A sub-build attaching is one event, its connections being those between the unit and what is built.
- **Slide.** Noise band-passed at 3.2 kHz × the unit's ring pitch, Q 0.8, rising over `min(seatSeconds, 0.08)` before the seat. Louder with `ridge`; with no clicking mates (an axle's grip) it is the whole sound.
- **Clicks.** 2, 3 or 4 by `mates` (≤2, ≤6, more), as the web does, `0.014 + 0.003·min(log2 mates, 4)` s apart, the first at the seat. Each is a half-sine force pulse of 0.2 ms into a modal bank:
  - the unit's footprint as a thin ABS plate. Modes are f_mn = (π/2)·√(D/ρh)·((m/a)² + (n/b)²) for m, n = 1..3 below 20 kHz, with D = Eh³/12(1−ν²); start E 2.3 GPa, ρ 1,050 kg/m³, ν 0.35, h 1.5 mm, 1 LDU = 0.4 mm. Amplitude is sin(mπx/a)·sin(nπy/b)/(mn) at that click's stud row. Decay is τ = 1/(π f η), with η starting at 0.03.
  - the same for `touching`, at half the level.
- **Thump.** A tone falling from 1.5× to 1× of a pitch over 30 ms, plus 40 ms of noise low-passed at 500 Hz. Pitch and length follow the web's `snapCharacter`: brick or plate from the unit's height, and the size from `built`, so it deepens as the model grows.
- **Room.** A deterministic Schroeder reverb (4 combs, 2 all-passes) over the whole track, at `room`; it keeps its state across blocks.
- **Pan.** Equal-power, `pan × stereo`.
- **Determinism.** A splitmix64 seeded by `move`; no `std::` distributions.
- **Normalising.** A first pass finds the peak; `render` scales by `peak / max(found, 1e-9)`. Silence stays zero.

- [ ] **Step 1: Write the failing tests.**
  - `"a seating sounds at the first frame its unit is in its seat"`: on the 3-piece fixture, each event's `frame` is the first f with `poseAt(flight, f)` the identity.
  - `"flagged moves are silent"`: a fixture with an unjoined piece gives one event fewer.
  - `"the same events give the same samples, in any block size"`: blocks of 1, 997 and the whole length compare equal.
  - `"the track is exactly as long as the film"`: `length() == ceil(frames / 30.0 * 48000)`.
  - `"each click lands on its frame"`: one event at frame 30. The loudest sample is within [48000, 48000 + 3 ms].
  - `"more mates give more clicks"`: 1 mate vs 8 mates; count envelope peaks more than 8 ms apart: 2 vs 4.
  - `"a bigger part rings lower"`: the spectral centroid of a 2x4 brick's click is below a 1x1 tile's.
  - `"a bigger model thumps lower"`: the same unit onto `builtPieces` 10 vs 2,000. The low band's peak frequency is lower.
  - `"no seatings is silence"`: every sample is 0, and none is NaN.
  - `"the loudest sample is the peak asked for"`: within 1e-6 of 0.89.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** to the interfaces and the simulation above.
- [ ] **Step 4: Run them; they pass.**
- [ ] **Step 5: The listening gate.**
  - Write `build/sound/gallery/`: a 1x1 tile on a plate, a 2x4 brick on a 2x4, a 2x4 onto a 2,000-piece model, a Technic pin, an axle, and twenty 1x2 plates in a row. Also write `bmexport sound` of 42000.
  - Ask the owner to listen. Tune the constants until they say it sounds like real assembly. Until then the task is not done.
- [ ] **Step 6: Commit** `feat(native): snaps simulated from the connections made, mixed in blocks; bmexport sound`, naming the constants the owner settled.

### Task 7: The film

**Files:**
- Create: `native/render/include/bmr/video_writer.h`, `native/render/src/metal/video_writer.mm`
- Modify: `native/render/CMakeLists.txt` (AVFoundation, CoreMedia, CoreVideo; `bmexport` links `bmsound`), `native/render/tools/bmexport/main.mm`
- Test: `native/render/tests/video_writer_test.mm`, `native/render/tests/bmexport_test.cpp`

**Interfaces:**
- Consumes: `Mixer` (Task 6), `PathTracer` and `denoise` (Tasks 2–3), `Renderer` (phase 6).
- Produces:
  - `enum class Codec { H264, Hevc };`
  - `class VideoWriter { static std::unique_ptr<VideoWriter> open(const std::filesystem::path&, int width, int height, double fps, Codec, std::string* error); bool frame(const Image&); bool audio(bms::Mixer&); bool finish(); }`
  - `bmexport video <model> --out build.mp4 [--renderer path|viewport] [--samples S] [--codec h264|hevc] [--subframes N] [--no-sound] [--from-frames DIR]`
  - `--subframes N` averages N viewport renders across the frame's open shutter (viewport only). `--from-frames` reads `frame-%06d.png` and fails, naming the first missing frame.
- [ ] **Step 1: Write the failing tests.**
  - `"a film plays at the timeline's rate with its sound"`: a 3-piece model with `--renderer viewport`. The `AVAsset` has duration `frames/30` ± 1 frame, video at 30 fps BT.709, and audio at 48 kHz in 2 channels.
  - `"frame N of the film is the picture of frame N"`: `AVAssetImageGenerator` at exact time N/30, against `bmshot --frame N`. The mean absolute difference is below 3/255.
  - `"the sound is in step"`: decode the audio. The loudest sample near the first seating is within one frame (1,600 samples) of `event.frame / 30`.
  - `"from-frames names the gap"`: delete one PNG. Exit 2, and the message names it.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `AVAssetWriterInput` for H.264/HEVC with BT.709 colour properties, fed through a `CVPixelBufferPool`. AAC at 192 kbps, fed from the `Mixer` in 4,096-sample blocks, interleaved with the video by presentation time.
- [ ] **Step 4: Run them; they pass.**
- [ ] **Step 5: Commit** `feat(native): bmexport video writes the build's film with its simulated sound`.

### Task 8: Measurements and docs

**Files:**
- Modify: `native/README.md` (phase 7 section, look rows, timings, what is not done), `docs/superpowers/specs/2026-11-18-native-phase7-render-export-design.md` (status)

- [ ] **Step 1: Measure on the M1 Pro, nothing else running:**
  - a 1920×1080 still of 42000 and of 10030-1 at the default samples;
  - one film frame of 42000;
  - the instance-structure build for the 12,148-piece 2×2 scene (`repeated(…, 2, 2, …)`, as bmshot's bench). Its part structures must be built once.
- [ ] **Step 2: Write it up.** The README gets the timings, the look rows from Task 4, the sound's settled constants, and the honest limits: no ray-tracing hardware on M1, and film hours for large builds.
- [ ] **Step 3: Commit** `docs(native): phase 7 measured`, then hand the branch to the final review.
