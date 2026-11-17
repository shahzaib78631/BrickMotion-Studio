# Native Phase 6: Metal Viewport — Implementation Plan

> **Status (2026-11-17): done, gate partly met.** Tasks 1–11 committed on `feat/native-engine`
> (e8a4d87 … the `docs(native): phase 6 results` commit). The 120 fps gate (10030-1 ×4, 12,148 pieces,
> 1920×1200) is met in two of three runs with nothing moving (p95 8.64 / 7.63 / 7.23 ms) and not while a
> build plays (11.4–13.3 ms). bmview was checked from the shell only; its interactive checks are open.
> ASan and TSan clean; 283 tests pass; all 71 smoke models draw. Results: `native/README.md`, "Phase 6 results".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A Mac window that shows any model the engine loads, plays its build animation, and holds 120 frames a second on a 12,000-piece scene on an M1 Pro, drawn by a new library `bmrender` that only reads engine state.

**Architecture:** `bmrender` is a static library in `native/render/` with two halves. The *prep* half is portable C++20 with no Apple headers: it turns a `bm::Model` into draw-ready data (render meshes with normals, levels of detail, instance groups per part and material, per-frame poses from a `bm::plan::Timeline`, culling). The *metal* half is Objective-C++ and owns every Metal object. Two small programs sit on top: `bmshot` renders one frame to a PNG with no window (this is what tests and the benchmark use) and `bmview` is an AppKit window with orbit, playback and a frame-time readout.

**Tech Stack:** C++20, Objective-C++ (ARC), Metal 3 on macOS 15+, AppKit, QuartzCore (`CAMetalLayer`, `CAMetalDisplayLink`), ImageIO for PNG, CMake + Ninja, Catch2 3.7.1. No new third-party code.

**Spec:** `docs/superpowers/specs/2026-11-15-native-rewrite-design.md` — read "Goals" (5 and 7), "Architecture", "bmrender", "Phases" and "Constraints" before starting. Results of earlier phases: `native/README.md`.

---

## Read this first: how work is done in this repository

You are continuing a rewrite that five phases have already shaped. The owner expects phase 6 to read as if the same hand wrote it. These are the habits that produced the earlier phases; they are requirements, not style advice.

**Working rules**

1. **Branch and staging.** Work on branch `feat/native-engine`. The working tree holds a great deal of the owner's uncommitted work outside `native/` (the web app, Python tools). Never stage it, never revert it, never run `git add -A` or `git add .`. Stage only `native/` and this plan file: `git add native docs/superpowers/plans/2026-11-17-native-phase6-viewport.md`. One commit per task, never push.
2. **Commit messages** are one plain sentence saying what is now true, prefixed `feat(native):`, `perf(native):`, `fix(native):`, `test(native):` or `docs(native):`. Example from history: `perf(native): a sweep past another piece is one walk of the trees, not one per pose`. End every message with the line `Co-Authored-By:` naming the model that did the work.
3. **Build and test** (run from the repository root):
   ```bash
   cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
   cmake --build native/build
   BM_LDRAW_DIR=$PWD/public/ldraw BM_SHADOW_DIR=$PWD/vendor/LDCadShadowLibrary ctest --test-dir native/build
   ```
   All 230 existing tests must still pass after every task. Sanitizer builds exist (`-DBM_SANITIZE=address` into `native/build-asan`, `thread` into `native/build-tsan`); run both before the final task and fix what they find.
4. **Warnings are errors** (`-Wall -Wextra -Werror` through the `bm_warnings` interface target). Link it into every new target. Do not silence a warning with a pragma; fix the code.
5. **Every number has a name and a reason.** No bare constants in code. Each area has a `tolerances.h` (see `native/core/include/bm/collide/tolerances.h`) where every threshold is an `inline constexpr` with a comment saying what it is, its unit, and why it has that value. This plan gives you the values; put them in `native/render/include/bmr/tolerances.h`.
6. **Comments explain why, in plain words.** Read `native/core/src/collide/world.cpp` for the voice: short sentences, the reason a thing is done, no restating of the code. Public headers document every function: what it returns for bad input, whether it is thread-safe, units.
7. **Never throw on bad data, never crash.** A model with a missing part, an empty mesh, a NaN transform or a zero-size window still draws what it can. Tests pin this for each task.
8. **Tests are sentences.** Catch2 test names say the behaviour: `"a clean stack has no overlaps; studs in their sockets are exempt"`. Tests that need the real part library are tagged `[data]` and call `SKIP("BM_LDRAW_DIR is not set")` without it. Tests that need a GPU are tagged `[gpu]` and `SKIP` when `MTLCreateSystemDefaultDevice()` returns nil.
9. **Write the test first, watch it fail, then write the code.** Each task below lists its tests as code. Do not weaken an assertion to make it pass; if a value in this plan turns out wrong, measure, change the named constant, and say so in the results.

**Reasoning rules** (this is what "same quality" means here)

1. **Measure before changing anything for speed.** Phase 5's planner was made 12 times faster by profiling four times and fixing only what each profile showed. The method: run the slow case, take a profile (`sample <process> 5 -file out.txt`, or a `MTLCounterSampleBuffer` / frame capture for GPU work), find the one largest cost, form a hypothesis about *why* it is large, confirm it with a counter, then fix that one thing and measure again. Never apply two speed changes at once. Remove measuring code before committing.
2. **A speed change must not change answers.** When you replace a slow path with a fast one, keep the slow one as the oracle in a test and assert they agree on real inputs (`native/tests/collide_pair_test.cpp`, "a whole way looked at in one go gives what looking pose by pose gives", is the pattern). For rendering: a culled, level-of-detail frame must match the unculled full-detail frame within the tolerance given in Task 7.
3. **Prefer one general rule to a special case.** No per-set, per-part or per-model branches in engine or renderer code. If one model needs something, it becomes data or a rule that the whole corpus then proves harmless.
4. **Report what is true.** Every phase ends with a results section in `native/README.md` containing a table of measured numbers, then "What the corpus corrected" (things you believed that the data disproved), then "Not done" (everything in the spec or this plan that is missing or below target, stated without softening). If the 120 fps target is missed, the heading says so in bold with the measured figure. Never describe unmeasured work as working.
5. **When this plan and reality disagree, reality wins and the plan is annotated.** Add a dated `> **Status YYYY-MM-DD.**` block at the top of this file listing each task's actual outcome and every deviation, as the phase 5 plan has.
6. **Stop and ask the owner** only for the two items under "Owner decisions" below. Everything else is decided here or under the spec's "Left to the builder".

**Facts about the machine and code you will otherwise trip over**

- **The offline Metal shader compiler is not installed** (`xcrun metal` fails with "missing Metal Toolchain") and disk is tight (about 21 GB free). Do not download the toolchain. Shaders are compiled at run time from source text with `-[MTLDevice newLibraryWithSource:options:error:]`. Task 4 embeds the `.metal` files as strings at build time and Task 4's test compiles every one of them, so a shader error fails `ctest`, not the first launch.
- **LDraw space:** units are LDU (1 stud = 20 LDU, a brick is 24 LDU tall), **−y is up**, right-handed. `bm::Xform` is `{Mat3 r; Vec3 t}` with `Mat3::m[9]` row-major; a point maps as `r * p + t`. `bm::Box` is `{Vec3 min, max}`, with `empty()`, `merge`, `grow`, `transformed(Xform)`. All of `bm/math.h` is double precision; the GPU gets floats relative to the scene centre (Task 3) so that large models keep precision.
- **`bm::ldraw::Mesh`** (`native/core/include/bm/ldraw/mesh.h`) has `positions` (xyz floats, welded), `triangles` (counter-clockwise from outside), `triColor` (per triangle; **16 means "the piece's own colour"**, 24 its edge colour, anything else is a fixed colour code), `edges` (xyz pairs, the part's outline lines) and `bounds`. It has **no normals**; Task 2 makes them.
- **Colours:** `model.library().colors()` is `unordered_map<int, ldraw::Color>` with `rgb` (0xRRGGBB, sRGB), `edge`, `alpha` and `finish` (`Solid, Chrome, Metal, Pearl, Rubber, Trans`). An unknown code must draw as mid grey `0x888888`, never fail.
- **Meshes come from** `model.mesh(piece.part, partCache)` (never null; empty for a missing part). `ldraw::PartCache` is thread-safe; `PartCache::defaultDirectory()` is where tools keep it.
- **Animation:** `bm::plan::plan(model, graph, parts, shapes, options)` then `certify`, then `buildTimeline(model, parts, plan)` gives `Timeline{flights, camera, frames}`; `poseAt(flight, frame)` is the unit's motion **from its seat** (identity when seated). A piece's world placement at a frame is `poseAt(flight, frame) * piece.world` for every piece in `plan.moves[flight.move].unit.pieces`. `native/tools/bm/cmd_plan.cpp` shows the whole call sequence, including building the connector database and graph; copy that sequence, do not invent another.
- **Threads:** `bm::JobPool::shared().parallelFor(n, fn)` is the only thread pool. Do not create threads of your own in the prep half.
- **No complete file of the 12,000-piece target set (Sagrada 21065) exists yet.** The benchmark scene is therefore synthetic and fixed: `omr/models/10030-1/10030-1.mpd` (3,037 pieces, the largest OMR sample) placed four times in a 2 × 2 grid, 12,148 pieces (Task 9 builds it; `BM_DATA_DIR`, default `/Users/mac/Projects/BrickMotion-Data`, holds the corpus).

## Global Constraints

- macOS 15+, Apple silicon only; C++20; CMake for libraries and tests. (`CMAKE_OSX_DEPLOYMENT_TARGET` 15.0 and `arm64` are already set in `native/CMakeLists.txt`.)
- `bmrender` draws a `bmcore` scene and **never mutates it**: every engine object it receives is `const`.
- `bmcore` stays portable: no Apple header, no Objective-C, no include of anything under `native/render/` from `native/core/`.
- The prep half of `bmrender` (`native/render/src/prep/`, `native/render/include/bmr/*.h`) includes no Apple header either, so its tests run without a GPU. Public headers never mention an Objective-C type; Metal objects cross as `void*` only where this plan says so.
- Third-party code kept small: no new dependency. PNG goes through ImageIO.
- No per-set special cases in code.
- Viewport target: **120 fps on a 12,000-part model on an M1 Pro**, measured as in Task 9: a frame budget of 8.33 ms, with the 95th percentile of CPU frame time plus GPU frame time under it at 1920 × 1200.
- The web app must keep working: touch nothing outside `native/` and this file.

## Scope

**In this plan (phase 6):** instanced drawing per (mesh, material), CPU frustum culling, three levels of detail, physically based brick materials for all six finishes, studio image-based lighting with one shadowed key light, outline edges, transparent parts, a floor that catches the shadow, ambient occlusion, piece picking and a selection outline, timeline playback, an orbit camera, the window, the headless frame tool, the benchmark.

**Not in this plan** (spec "bmrender" lists them; they get their own plan after the benchmark shows how much frame time is left): bevels, contact shadows beyond the key light's shadow, HDRI files, depth of field, motion blur, looks, gizmos and overlays other than the selection outline and the frame-time readout. The path tracer and export are phase 7. The C interface `bm_*.h` for the Swift app is phase 8; `bmview` is Objective-C++ and calls the C++ headers directly.

**Owner decisions (ask, then continue with the default if there is no answer):**
1. *Tone and look.* Default: neutral tone curve (Task 5), white studio. The look is matched by eye in a later calibration round, not here.
2. *If 120 fps is missed after Task 9's three permitted fixes,* stop optimising, record the numbers and what a further fix would be, and hand back.

## File Structure

```
native/render/
  CMakeLists.txt                 targets bmrender, bmrender_tests, bmshot, bmview; shader embedding
  cmake/embed_shaders.cmake      turns shaders/*.metal into one generated .cpp of string literals
  include/bmr/
    tolerances.h                 every number the renderer uses
    render_mesh.h                RenderMesh, buildRenderMesh, MeshLibrary (levels of detail)
    material.h                   Material, materialFor(Color)
    scene.h                      Scene: groups, instances, bounds; buildScene; applyFrame
    camera.h                     Camera, OrbitCamera, Frustum, matrices
    cull.h                       cull(): visible instances and their level of detail
    renderer.h                   Renderer (opaque), FrameOptions, FrameStats; no Apple types
    image.h                      Image (RGBA8), writePng, compare
  src/prep/                      portable C++: render_mesh.cpp material.cpp scene.cpp camera.cpp cull.cpp image_compare.cpp
  src/metal/                     Objective-C++: device.mm pipelines.mm buffers.mm environment.mm
                                 shadow.mm frame.mm picking.mm renderer.mm png.mm
  shaders/                       common.metal brick.metal edges.metal shadow.metal floor.metal
                                 environment.metal ao.metal composite.metal
  tools/bmshot/main.mm           one frame to a PNG; --bench
  tools/bmview/                  main.mm AppDelegate.mm ViewportView.mm (AppKit window)
  tests/                         render_mesh_test.cpp material_test.cpp scene_test.cpp camera_test.cpp
                                 cull_test.cpp shaders_test.mm frame_test.mm picking_test.mm playback_test.mm
```

One responsibility per file. Nothing in `src/metal/` decides *what* to draw; it draws the lists the prep half hands it. That split is what lets most of the phase be tested without a GPU.

## Review Focus

1. **A model with missing or empty parts** — the window opens and every other piece draws; missing parts draw as their placeholder box (`bm::kPlaceholderBox`), translucent grey. (Task 3 test.)
2. **A window resized to zero, minimised, or moved between displays with different scale factors** — no crash, no stretched image, drawing resumes. (Task 8 test on `Renderer::resize`.)
3. **A very large or far-from-origin model** (pieces at coordinates of 100,000 LDU) — no shimmering or swimming geometry; positions are sent relative to the scene centre. (Task 3 and Task 6 tests.)
4. **Mirrored placements** (a piece whose transform has negative determinant) — faces still point outward and are lit from outside. (Task 3 and Task 6 tests.)
5. **Scrubbing playback backwards and jumping to any frame** — every piece is exactly where `poseAt` says for that frame, with no state left over from the frame shown before. (Task 8 test.)

---

### Task 1: The `bmrender` targets, tolerances, and an image type

**Files:**
- Create: `native/render/CMakeLists.txt`, `native/render/include/bmr/tolerances.h`, `native/render/include/bmr/image.h`, `native/render/src/prep/image_compare.cpp`, `native/render/src/metal/png.mm`, `native/render/tests/image_test.cpp`
- Modify: `native/CMakeLists.txt` (add `OBJCXX` to `project(... LANGUAGES C CXX OBJCXX)`, `add_subdirectory(render)` after `core`)

**Interfaces — produces:**
```cpp
namespace bmr {
struct Image {                       // 8-bit RGBA, row 0 at the top, sRGB
  int width = 0, height = 0;
  std::vector<uint8_t> rgba;         // width * height * 4
  bool empty() const;
  const uint8_t* at(int x, int y) const;   // nullptr outside the image
};
/// False if the file cannot be written or the image is empty. Never throws.
bool writePng(const Image& image, const std::filesystem::path& file);
/// Empty image if the file is missing or not a PNG.
Image readPng(const std::filesystem::path& file);
struct Difference { double meanAbs = 0; double worstBlock = 0; bool sameSize = true; };
/// meanAbs: mean absolute difference per channel, 0..255. worstBlock: the largest mean over
/// any kBlock x kBlock block, so a small wrong patch is not averaged away.
Difference compare(const Image& a, const Image& b);
}
```
`tolerances.h` starts with: `kBlock = 16` (pixels; the block `compare` uses), and gains constants in every later task.

CMake: `bmrender` is `STATIC`, sources `src/prep/*.cpp` and `src/metal/*.mm`, `PUBLIC include`, links `bmcore` publicly and `bm_warnings` privately, plus `"-framework Metal" "-framework QuartzCore" "-framework ImageIO" "-framework CoreGraphics" "-framework Foundation"`. `.mm` files compile with `-fobjc-arc`. `bmrender_tests` globs `tests/*_test.cpp` and `tests/*_test.mm`, links `Catch2::Catch2WithMain`, gets `BM_FIXTURES` pointing at `native/tests/fixtures` (reuse the core fixtures: `lib/` has `3001.dat`, `3005.dat`, `c1x1.dat`), and is registered with `catch_discover_tests`.

- [x] **Step 1: Write the failing tests** in `image_test.cpp`:
```cpp
TEST_CASE("an image written as a PNG reads back the same", "[image]") {
  bmr::Image img{3, 2, std::vector<uint8_t>(24, 0)};
  img.rgba = {255,0,0,255, 0,255,0,255, 0,0,255,255,  10,20,30,255, 40,50,60,128, 0,0,0,0};
  const auto file = std::filesystem::temp_directory_path() / "bmr_image_test.png";
  REQUIRE(bmr::writePng(img, file));
  const bmr::Image back = bmr::readPng(file);
  REQUIRE(back.width == 3); REQUIRE(back.height == 2);
  REQUIRE(back.rgba == img.rgba);              // straight alpha, no premultiplying on the way
}
TEST_CASE("an empty image is not written; a missing file reads as empty", "[image]") {
  REQUIRE_FALSE(bmr::writePng({}, std::filesystem::temp_directory_path() / "bmr_none.png"));
  REQUIRE(bmr::readPng("/nonexistent/x.png").empty());
}
TEST_CASE("a small wrong patch shows in the worst block, not only the mean", "[image]") {
  bmr::Image a{64, 64, std::vector<uint8_t>(64*64*4, 100)}, b = a;
  for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) b.rgba[(y*64+x)*4] = 200;   // one block, red channel
  const auto d = bmr::compare(a, b);
  REQUIRE(d.sameSize); REQUIRE(d.meanAbs < 2.0); REQUIRE(d.worstBlock == Catch::Approx(25.0));
  REQUIRE_FALSE(bmr::compare(a, bmr::Image{8, 8, std::vector<uint8_t>(256, 0)}).sameSize);
}
```
- [x] **Step 2: Run** `cmake --build native/build && native/build/render/bmrender_tests "[image]"` — expect a build failure (no such headers).
- [x] **Step 3: Implement.** `png.mm` uses `CGImageDestination` / `CGImageSource` with `kCGImageAlphaLast` data so alpha is not premultiplied (the first test catches premultiplication on the `128` pixel).
- [x] **Step 4: Run the tests and the whole suite** — all pass.
- [x] **Step 5: Commit** `feat(native): bmrender library skeleton, image type and PNG`.

### Task 2: Render meshes — normals, edges and three levels of detail

LDraw meshes have no normals and far more triangles than a small on-screen piece needs.

**Files:**
- Create: `native/render/include/bmr/render_mesh.h`, `native/render/src/prep/render_mesh.cpp`, `native/render/tests/render_mesh_test.cpp`
- Modify: `native/core/include/bm/ldraw/mesh.h` and `native/core/src/ldraw/flatten.cpp` (add `bool lowResPrimitives = false;` to `FlattenOptions`: use the LDraw library's `p/8/` primitive of the same name where one exists, the normal one otherwise; mutually exclusive with `hiResPrimitives`, low wins), `native/core/src/cache/part_cache.cpp` (its `optionBits` at line 36 folds the options into the cache key: add the new flag as bit 4, so low-detail meshes never collide with full ones on disk), `native/tests/ldraw_flatten_test.cpp`

**Interfaces — produces:**
```cpp
namespace bmr {
struct Vertex { float px, py, pz; float nx, ny, nz; uint32_t color; };   // color: 0 = the piece's own; else 0xFFRRGGBB fixed, sRGB
struct RenderMesh {
  std::vector<Vertex> vertices;
  std::vector<uint32_t> indices;      // triangles
  std::vector<float> edges;           // xyz pairs, as ldraw::Mesh::edges
  bm::Box bounds;
  bool empty() const { return indices.empty(); }
};
/// Normals are area-weighted over the triangles that share a corner and whose normals are
/// within kCreaseDegrees of each other; a sharper turn splits the corner. Triangles with no
/// area are dropped. `colors` resolves fixed triangle colours (code 16 stays 0; an unknown
/// code is 0xFF888888). Never throws.
RenderMesh buildRenderMesh(const bm::ldraw::Mesh& mesh, const std::unordered_map<int, bm::ldraw::Color>& colors);
/// A box with flat normals: the furthest level of detail, and the stand-in for a missing part.
RenderMesh boxMesh(const bm::Box& box);

enum class Detail : uint8_t { Full = 0, Low = 1, Box = 2 };
/// The render meshes of the parts of one model, built on first use. Thread-safe.
class MeshLibrary {
 public:
  MeshLibrary(const bm::Model& model, bm::ldraw::PartCache& full, bm::ldraw::PartCache& low);
  /// Never null. Detail::Low falls back to Full when the low mesh has no fewer triangles.
  std::shared_ptr<const RenderMesh> get(const std::string& part, Detail detail);
};
}
```
Tolerances: `kCreaseDegrees = 35.0` (LDraw curved primitives turn 22.5° per facet at 16 sides and 45° at 8, real edges are 90°: 35° smooths a 16-sided cylinder and keeps every true edge; an 8-sided low-detail cylinder is therefore faceted, which is correct at the size it is shown).

- [x] **Step 1: Write the failing tests:**
```cpp
TEST_CASE("a brick's faces are flat and its normals point outward", "[mesh]") {
  const auto lib = ldraw::Library(fs::path(BM_FIXTURES) / "lib");
  const RenderMesh m = buildRenderMesh(ldraw::flatten("3005.dat", lib), lib.colors());   // the 20 x 24 x 20 body
  REQUIRE_FALSE(m.empty());
  const Vec3 centre = (m.bounds.min + m.bounds.max) * 0.5;
  for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
    const Vertex &a = m.vertices[m.indices[i]], &b = m.vertices[m.indices[i+1]], &c = m.vertices[m.indices[i+2]];
    const Vec3 face = normalized(cross(P(b) - P(a), P(c) - P(a)));
    for (const Vertex* v : {&a, &b, &c}) REQUIRE(dot(N(*v), face) > 0.999);   // flat: every corner has its face's normal
    REQUIRE(dot(face, (P(a) + P(b) + P(c)) * (1.0/3) - centre) > 0);         // outward
  }
}
TEST_CASE("a cylinder is smooth around and sharp at its rim", "[mesh][data]") { /* 3062b.dat (round 1x1): on the side wall, normals of the two triangles meeting at a facet edge agree at the shared corner (dot > 0.999); at the top rim they differ (dot < 0.2) */ }
TEST_CASE("fixed colours are carried per vertex; the piece's own colour is 0", "[mesh]") { /* a mesh with triColor {16, 4, 9999}: colours 0, 0xFFC91A09 from LDConfig code 4, 0xFF888888 */ }
TEST_CASE("empty and degenerate meshes give an empty render mesh", "[mesh]") { /* Mesh{}, three points on a line, indices out of range: empty(), no throw */ }
TEST_CASE("a box mesh has 12 triangles, 24 vertices and outward flat normals", "[mesh]") {}
TEST_CASE("low detail has fewer triangles for a round part and the same bounds within a stud's roundness", "[mesh][data]") {
  // 3941.dat: Low < 0.6 x Full triangles; bounds differ by less than 1 LDU on every side.
  // 3005.dat (no curved primitive but its stud): Low <= Full; get(part, Low) never returns more triangles than Full.
}
TEST_CASE("low-resolution primitives are used where they exist", "[ldraw][flatten][data]") { /* in native/tests: flatten("3941.dat", lib, {.lowResPrimitives = true}).triangles.size() < flatten("3941.dat", lib).triangles.size() */ }
```
Write the commented tests out in full; the comment gives the assertion and the values.
- [x] **Step 2: Run, see them fail.**
- [x] **Step 3: Implement.** Corner splitting: for each vertex, group its incident triangles greedily by normal agreement (compare with the group's running area-weighted normal), one output vertex per (position, group, colour).
- [x] **Step 4: Run the tests and the whole suite.** The part cache directory for low detail is `PartCache::defaultDirectory().parent_path() / "parts-low"`.
- [x] **Step 5: Commit** `feat(native): render meshes with creased normals and a low-detail level`.

### Task 3: Materials, the scene, and poses per frame

**Files:**
- Create: `native/render/include/bmr/material.h`, `native/render/include/bmr/scene.h`, `native/render/src/prep/material.cpp`, `native/render/src/prep/scene.cpp`, `native/render/tests/material_test.cpp`, `native/render/tests/scene_test.cpp`

**Interfaces — produces:**
```cpp
namespace bmr {
struct Material {
  float base[3];        // linear, 0..1
  float alpha;          // 1 opaque
  float roughness, metalness, clearcoat;
  float edge[3];        // linear
  bool transparent() const { return alpha < 1; }
  bool operator==(const Material&) const = default;
};
/// From an LDraw colour. sRGB to linear by the exact sRGB curve, not a 2.2 power.
Material materialFor(const bm::ldraw::Color& color);
Material placeholderMaterial();   // a missing part: 0xb8bcc2, alpha 0.6, roughness 0.6

struct Instance {       // one piece as drawn
  float model[12];      // rows of a 3x4 matrix, relative to Scene::origin, LDU
  uint32_t piece;       // index into Model::pieces()
  uint32_t flags;       // bit 0: mirrored (determinant < 0); bit 1: selected
};
struct Group {          // everything drawn with one mesh and one material
  std::string part;
  Material material;
  bool placeholder = false;
  std::vector<Instance> instances;
  std::vector<bm::Box> restBoxes;   // per instance, world space, at rest
};
struct Scene {
  bm::Vec3 origin;                  // centre of the model's bounds; subtracted from every position sent to the GPU
  bm::Box bounds;                   // world space, at rest
  std::vector<Group> groups;        // opaque groups first, then transparent; within each, sorted by part then colour code
  std::vector<std::pair<uint32_t, uint32_t>> where;   // per piece: (group, instance)
};
/// Groups the model's pieces by (part, colour). A piece whose part has no geometry goes into
/// a placeholder group drawn as kPlaceholderBox. A piece with a non-finite or singular
/// transform is left out and counted in `skipped`. Never throws.
Scene buildScene(const bm::Model& model, bm::ldraw::PartCache& parts, size_t* skipped = nullptr);
/// Sets every instance to where its piece is at `frame`: its flight's pose times its rest
/// placement; pieces of no flight stay at rest. Depends only on (timeline, frame): calling
/// it for frame 10 gives the same scene whatever frame was applied before. Returns the
/// (group, instance) pairs that changed since the last call, for partial buffer updates.
std::vector<std::pair<uint32_t, uint32_t>> applyFrame(Scene& scene, const bm::Model& model, const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, int frame);
}
```
Material values by finish (the web app's, `src/render/materials.ts:123-138`, so the two apps look alike until calibration):

| Finish | roughness | metalness | clearcoat |
|---|---|---|---|
| Solid | 0.38 | 0.0 | 0.35 |
| Trans | 0.05 | 0.0 | 0.35 |
| Chrome | 0.08 | 1.0 | 0.35 |
| Metal | 0.20 | 0.7 | 0.35 |
| Pearl | 0.10 | 0.5 | 0.35 |
| Rubber | 0.86 | 0.0 | 0.0 |

Solid is the web app's default look, "BrickLink plastic" (`src/render/looks.ts:412`: roughness 0.38, clearcoat 0.35, clearcoat roughness 0.2). The other rows are the per-finish overrides at `src/render/materials.ts:135-138`, which change roughness and metalness and leave the look's clearcoat, except rubber, which has none. Trans roughness is this plan's value: the web app's glass is a separate optics model that phase 6 does not port. The clearcoat lobe's own roughness is `kClearcoatRoughness = 0.2`.

- [x] **Step 1: Write the failing tests:**
```cpp
TEST_CASE("sRGB becomes linear by the sRGB curve", "[material]") {
  ldraw::Color c; c.rgb = 0x808080;
  REQUIRE(materialFor(c).base[0] == Catch::Approx(0.21586).margin(1e-4));
  c.rgb = 0x000000; REQUIRE(materialFor(c).base[1] == 0.0f);
  c.rgb = 0xFFFFFF; REQUIRE(materialFor(c).base[2] == Catch::Approx(1.0f));
}
TEST_CASE("each finish has its own surface; alpha below one is transparent", "[material]") { /* the table above, all six; Trans with alpha 0.5 is transparent() */ }
TEST_CASE("pieces of one part and colour share a group; opaque groups come first", "[scene]") {
  // model: 3 x 3005 red (4), 2 x 3005 trans-red (36), 1 x 3001 red -> 3 groups; groups[0..1] opaque, groups[2] transparent;
  // sizes 1 (3001), 3, 2 in the sorted order; `where` round-trips: scene.groups[g].instances[i].piece == p for every piece p.
}
TEST_CASE("positions are sent relative to the scene's centre", "[scene]") {
  // two bricks at x = 100000 and x = 100040: origin.x == Approx(100020); the instances' translations are -20 and +20 exactly.
}
TEST_CASE("a mirrored piece is marked; a missing part is a placeholder; a broken transform is left out", "[scene]") {
  // LDraw line with matrix -1 0 0 0 1 0 0 0 1: flags & 1. Part "nosuch.dat": placeholder group. Matrix of zeros: skipped == 1.
}
TEST_CASE("a frame's poses depend only on the frame", "[scene][playback]") {
  // model of 4 stacked 3005; plan + timeline as cmd_plan.cpp does. Apply frame 0, then timeline.frames, then 7; copy the
  // instances; build a fresh scene and apply 7 directly: every model[12] equal within 1e-5.
  // At frame timeline.frames every instance equals its rest placement. At frame 0 no piece is at rest.
}
TEST_CASE("an empty model gives an empty scene", "[scene]") {}
```
- [x] **Step 2: Run, see them fail.** - [x] **Step 3: Implement.** - [x] **Step 4: Run all tests.**
- [x] **Step 5: Commit** `feat(native): render scene grouped by part and material, with poses per frame`.

### Task 4: Camera, and the Metal device with every shader compiled

**Files:**
- Create: `native/render/include/bmr/camera.h`, `native/render/src/prep/camera.cpp`, `native/render/tests/camera_test.cpp`, `native/render/cmake/embed_shaders.cmake`, `native/render/shaders/common.metal` (and an empty-but-valid file for each shader named under File Structure), `native/render/src/metal/device.mm`, `native/render/src/metal/device.h` (private), `native/render/tests/shaders_test.mm`

**Interfaces — produces:**
```cpp
namespace bmr {
struct Camera {                    // looks from `eye` at `target`
  bm::Vec3 eye, target;
  bm::Vec3 up{0, -1, 0};           // LDraw: -y is up
  double fovY = 0.6;               // radians (about 34 degrees, a 70 mm lens on full frame)
  double near = 1, far = 1e5;      // LDU
  double aspect = 1;
};
struct Mat4 { float m[16]; };      // column-major, as Metal shaders read it
Mat4 viewMatrix(const Camera&, bm::Vec3 origin);        // world relative to `origin` -> view
Mat4 projectionMatrix(const Camera&);                    // reversed depth: near -> 1, far -> 0, Metal clip space
struct Frustum { float planes[6][4]; };                  // inward normals, in world space relative to origin
Frustum frustumOf(const Camera&, bm::Vec3 origin);
bool outside(const Frustum&, const bm::Box& box, bm::Vec3 origin);   // true only if the whole box is outside one plane

struct OrbitCamera {               // what the window and the timeline drive
  bm::Vec3 target; double distance = 400, azimuth = 0.6, elevation = 0.45;   // radians; elevation > 0 looks down
  void orbit(double dAzimuth, double dElevation);   // elevation clamped to +-kMaxElevation
  void zoom(double factor);                          // distance clamped to [kMinDistance, kMaxDistance]
  void pan(double dxPixels, double dyPixels, double viewportHeight, double fovY);
  Camera camera(double aspect, const bm::Box& sceneBounds) const;   // near and far fitted to the bounds
  static OrbitCamera framing(const bm::Box& bounds, double fovY, double aspect);  // the whole box in view with kFrameMargin
  static OrbitCamera from(const bm::plan::CameraKey& key);
};
}
```
Tolerances: `kMaxElevation = 1.5533` (89°), `kMinDistance = 10`, `kMaxDistance = 1e6`, `kFrameMargin = 1.15`. Reversed depth is chosen because large scenes need depth precision far from the eye; it requires a `Depth32Float` target, depth cleared to 0 and compare `greaterEqual` everywhere — say so in a comment in `common.metal`.

Private `device.h`: `struct Device { id<MTLDevice> device; id<MTLCommandQueue> queue; id<MTLLibrary> library; }`, `Device* sharedDevice()` (nullptr when there is no Metal device or the shaders do not compile; the compile error text is kept and returned by `const char* shaderError()`).

`embed_shaders.cmake` writes `${CMAKE_CURRENT_BINARY_DIR}/shaders_embedded.cpp` defining `extern const char* const kShaderSource;` as the concatenation of `common.metal` followed by the other files in name order, as raw string literals (split each file into chunks under 16,000 characters; one literal has a compiler limit). It reruns when any `.metal` file changes (`add_custom_command` with `DEPENDS`).

- [x] **Step 1: Write the failing tests:**
```cpp
TEST_CASE("the framing camera has the whole box in view", "[camera]") {
  const Box box{{-100, -300, -50}, {100, 0, 50}};
  for (double aspect : {0.5, 1.0, 2.4}) {
    const OrbitCamera o = OrbitCamera::framing(box, 0.6, aspect);
    const Camera c = o.camera(aspect, box);
    for (corner of box) { project with viewMatrix(c, {}) and projectionMatrix(c); REQUIRE(|x| <= w); REQUIRE(|y| <= w); REQUIRE(z between 0 and w); }
    REQUIRE_FALSE(outside(frustumOf(c, {}), box, {}));
  }
}
TEST_CASE("depth is reversed: near maps to one, far to zero", "[camera]") {}
TEST_CASE("a box behind the camera or beside the view is outside; one that straddles an edge is not", "[camera]") {}
TEST_CASE("up on the screen is -y of the model", "[camera]") { /* the point target + (0,-10,0) projects above the target */ }
TEST_CASE("orbiting and zooming stay within their limits; a camera key converts", "[camera]") {}
TEST_CASE("every shader compiles", "[gpu][shaders]") {
  if (!MTLCreateSystemDefaultDevice()) SKIP("no Metal device");
  INFO(bmr::shaderError());
  REQUIRE(bmr::sharedDevice() != nullptr);
}
```
- [x] **Step 2: Run, see them fail.** - [x] **Step 3: Implement.** - [x] **Step 4: Run all tests.**
- [x] **Step 5: Commit** `feat(native): camera, frustum, and a Metal device whose shaders compile under test`.

### Task 5: The first frame — instanced opaque bricks, lit, to a PNG

**Files:**
- Create: `native/render/include/bmr/renderer.h`, `native/render/src/metal/{buffers,pipelines,environment,frame,renderer}.mm`, `native/render/shaders/{brick,environment,composite}.metal`, `native/render/tools/bmshot/main.mm`, `native/render/tests/frame_test.mm`
- Modify: `native/render/CMakeLists.txt` (`bmshot` executable)

**Interfaces — produces:**
```cpp
namespace bmr {
struct FrameOptions {
  bool edges = true, shadows = true, ambientOcclusion = true, floor = true;
  bool cull = true; int forceDetail = -1;        // -1: by size on screen; 0..2: that Detail for everything (tests, benchmark)
  float background[3] = {1, 1, 1};               // linear
};
struct FrameStats {
  double cpuMs = 0, gpuMs = 0;                   // gpuMs from the command buffer's GPUStartTime/GPUEndTime
  uint32_t drawCalls = 0, instances = 0, culled = 0; uint64_t triangles = 0;
  uint32_t byDetail[3] = {0, 0, 0};
};
class Renderer {
 public:
  /// nullptr when there is no usable Metal device. `model` and `parts` must outlive it.
  static std::unique_ptr<Renderer> create(const bm::Model& model, bm::ldraw::PartCache& parts);
  ~Renderer();
  const Scene& scene() const;
  void resize(int width, int height, double scale);    // pixels; anything < 1 is held as 1 and nothing is drawn
  /// Draws into `drawable` (an id<CAMetalDrawable> passed as void*) or, when null, offscreen.
  FrameStats draw(const Camera& camera, const FrameOptions& options, void* drawable = nullptr);
  Image readback();                                      // the last frame drawn offscreen
  void setFrame(const bm::plan::Plan& plan, const bm::plan::Timeline& timeline, int frame);   // Task 8
  /// The piece under a pixel of the last frame, or UINT32_MAX. Task 8.
  uint32_t pick(int x, int y);
  void select(const std::vector<uint32_t>& pieces);     // Task 8
};
}
```
Decisions:
- **Targets:** colour `RGBA16Float` (linear), depth `Depth32Float` reversed, 4× MSAA resolved before post. The final pass tone-maps and writes `BGRA8Unorm_sRGB`. Tone curve: the Khronos PBR Neutral curve (it leaves brick colours unchanged below the shoulder, which a colour-critical brick renderer needs; ACES shifts hues).
- **Buffers:** one vertex and one index buffer per (mesh, detail), built lazily; one instance buffer per group, `MTLResourceStorageModeShared`, written once and then only where `applyFrame` reports a change. Instance layout is `bmr::Instance` plus the material is a per-draw uniform.
- **One draw call per (group, detail)** with `instanceCount`; the visible instance indices for that detail are written to a per-frame index buffer and the vertex shader reads the instance through it (so culling never rewrites the instance buffer).
- **Mirrored instances** are drawn with the opposite winding: a second draw of the same buffers with `MTLWindingClockwise`. The normal matrix is the inverse transpose of the model matrix's 3×3 part, computed in the vertex shader from the three rows.
- **Lighting:** a procedural studio environment rendered once into a 256² cube map with mips (a white room, `kRoomLuminance = 1.0`, with one large soft box overhead-front at `kKeyDirection = normalize(0.35, -0.8, 0.5)` in model space, `kKeyLuminance = 12.0`), prefiltered by roughness into the mip chain (GGX importance sampling, 64 samples per texel, done once at start-up on the GPU), with the standard split-sum lookup texture computed the same way; plus one analytic directional light along `kKeyDirection` with intensity `kKeyIntensity = 3.0`. Shading is Cook–Torrance GGX with Smith visibility and Schlick Fresnel, `F0 = 0.04` for non-metals, plus a clearcoat lobe (`kClearcoatRoughness`, `F0 = 0.04`) weighted by `Material::clearcoat`.
- A piece's own colour is the group material's; a vertex with a fixed colour (non-zero `Vertex::color`) uses that colour, converted to linear in the vertex shader.

`bmshot <model file> --out <png> [--size WxH] [--frame N] [--azimuth a --elevation e] [--no-edges] [--no-shadows] [--no-ao] [--detail 0|1|2] [--stats]` frames the model with `OrbitCamera::framing`, draws offscreen, writes the PNG, and with `--stats` prints `FrameStats` as one line of JSON. Exit codes as `bm`: 0, 1 failure, 2 usage.

- [x] **Step 1: Write the failing tests** (all `[gpu]`; helper `Image shot(const std::string& ldrText, FrameOptions, int w = 256, int h = 256)` builds a model from text as `native/tests/collide_world_test.cpp`'s `Rig::model` does):
```cpp
TEST_CASE("one red brick fills the middle of the frame with red and leaves the corners background", "[gpu][frame]") {
  const Image img = shot(piece("3005.dat", 0, 0, 0, /*color*/ 4), plain());   // plain(): no edges, shadows, ao, floor
  const uint8_t* mid = img.at(128, 128);
  REQUIRE(mid[0] > 120); REQUIRE(mid[0] > 3 * mid[1]); REQUIRE(mid[0] > 3 * mid[2]);
  for (auto [x, y] : {std::pair{2, 2}, {253, 2}, {2, 253}, {253, 253}}) { REQUIRE(img.at(x, y)[0] > 250); REQUIRE(img.at(x, y)[1] > 250); }
}
TEST_CASE("a face turned to the key light is brighter than one turned away", "[gpu][frame]") {}   // sample the top face and a side face of one white brick seen from above-front
TEST_CASE("a mirrored brick is lit like its unmirrored twin", "[gpu][frame]") { /* compare(shot(normal), shot(mirrored about x)).meanAbs < 1.0 for the symmetric 3005 */ }
TEST_CASE("a brick 100000 LDU from the origin draws the same as one at the origin", "[gpu][frame]") { /* compare(...).worstBlock < 1.0 */ }
TEST_CASE("an empty model, a model of only missing parts, and a zero-size target draw without failing", "[gpu][frame]") {}
TEST_CASE("the same frame drawn twice is the same image", "[gpu][frame]") { /* compare == 0 exactly */ }
TEST_CASE("chrome reflects the room; rubber does not", "[gpu][frame]") { /* variance of luminance across a curved 3062b in chrome (383) > 4 x that in rubber black (256) */ }
```
- [x] **Step 2: Run, see them fail.** - [x] **Step 3: Implement.**
- [x] **Step 4: Run all tests; look at the picture.** Run `native/build/render/bmshot samples/helicopter/helicopter.mpd --out <scratch>/heli.png --size 1600x1000` and open it. It must read as a lit plastic model: correct colours, no black or inside-out pieces, no missing pieces against `bm load`'s piece count. If something looks wrong, find the cause before going on; a test that passes on a picture that is wrong is a missing test — add it.
- [x] **Step 5: Commit** `feat(native): first frame — instanced, lit bricks drawn offscreen, and bmshot`.

### Task 6: Shadow, floor, edges and transparent parts

**Files:**
- Create: `native/render/src/metal/shadow.mm`, `native/render/shaders/{shadow,floor,edges}.metal`; extend `frame.mm`, `pipelines.mm`, `frame_test.mm`

Decisions:
- **Shadow:** one 4096² `Depth32Float` map for the key light, an orthographic projection fitted each frame to the scene's current bounds (rest bounds merged with the staging area while a timeline plays), snapped to texel steps so it does not crawl as pieces move. Sampled with a 3×3 comparison filter. Depth bias `kShadowBias = 1.5` texels, slope-scaled.
- **Floor:** a plane at the highest y of the scene bounds (the floor is under the model: +y is down), extending `kFloorExtent = 4` times the bounds' diagonal, coloured as the background, receiving shadow and ambient occlusion only, fading to the background by distance so it has no visible edge.
- **Edges:** each mesh's `edges` as instanced line segments in the group's `Material::edge` colour, `kEdgeOpacity = 0.3` (the web app's `EDGE_OPACITY`, `src/render/materials.ts:192`), depth-tested with a small bias toward the eye, drawn only for `Detail::Full` instances.
- **Transparent groups:** drawn after everything opaque with depth writes off, using weighted blended order-independent transparency (McGuire and Bavoil 2013): accumulate premultiplied colour times weight into `RGBA16Float` and revealage into `R8Unorm`, composite once. Weight `w = alpha * clamp(0.03 / (1e-5 + pow(viewDepth / kOitDepthScale, 4)), 1e-2, 3e3)` with `kOitDepthScale = 2000` LDU. This is chosen over sorting because pieces interpenetrate at studs and sorting by centre flickers during playback.

- [x] **Step 1: Write the failing tests:**
```cpp
TEST_CASE("a brick casts a shadow on the floor on the side away from the key light", "[gpu][frame]") {}   // floor pixel in shadow darker by > 15 levels than a floor pixel on the lit side; with shadows off, equal within 2
TEST_CASE("a brick behind a transparent brick shows through it, tinted", "[gpu][frame]") {}        // blue brick behind trans-red: centre pixel has red > 60 and blue > 60
TEST_CASE("two overlapping transparent bricks look the same whichever is listed first", "[gpu][frame]") {}   // compare(...).meanAbs == 0
TEST_CASE("edges darken a brick's outline and nothing else", "[gpu][frame]") {}   // edges on vs off: difference confined to within 3 px of the silhouette and creases; the face centre is unchanged
TEST_CASE("the floor has no visible edge", "[gpu][frame]") {}   // far corners of a wide low shot equal the background within 2 levels
```
Write each out with the pixel positions you derive from the framing camera; state in a comment how each position was chosen.
- [x] **Step 2: Run, see them fail.** - [x] **Step 3: Implement.** - [x] **Step 4: Run all tests; look at the helicopter and at `samples/42000-1.mpd` again.**
- [x] **Step 5: Commit** `feat(native): key-light shadow, floor, outline edges and order-independent transparency`.

### Task 7: Culling and levels of detail, proven not to change the picture

**Files:**
- Create: `native/render/include/bmr/cull.h`, `native/render/src/prep/cull.cpp`, `native/render/tests/cull_test.cpp`; extend `frame.mm`, `frame_test.mm`

**Interfaces — produces:**
```cpp
namespace bmr {
struct Visible { std::vector<uint32_t> byDetail[3]; uint32_t culled = 0; };   // instance indices of one group
/// For each group, which instances are in view and at which detail. An instance's box is its
/// mesh's bounds under its current matrix. Detail is chosen from the box's projected size:
/// Full at or above kFullPixels, Low at or above kLowPixels, Box below; nothing is dropped
/// for being small. Runs on the shared job pool; deterministic.
std::vector<Visible> cull(const Scene& scene, const std::vector<bm::Box>& meshBounds, const Camera& camera, int viewportHeight, int forceDetail = -1);
}
```
Tolerances: `kFullPixels = 48` (below this a stud is under 3 pixels wide and 16-sided and 8-sided studs cannot be told apart), `kLowPixels = 6` (below this a piece is a few pixels and its box is indistinguishable). These are starting values: the test below is what holds them, and Task 9 may raise them only while that test still passes.

- [x] **Step 1: Write the failing tests:**
```cpp
TEST_CASE("pieces outside the view are culled and those inside are kept", "[cull]") {}      // a row of 100 bricks along x, camera seeing the middle 20: culled + kept == 100; every kept box intersects the frustum; no box fully inside is culled
TEST_CASE("detail falls with size on screen and nothing is dropped", "[cull]") {}            // one brick at distances giving 200, 20 and 2 px: Full, Low, Box
TEST_CASE("culling is the same on one thread and many", "[cull]") {}
TEST_CASE("a culled, level-of-detail frame matches the full frame", "[gpu][frame][data]") {
  // helicopter.mpd at 1600x1000 from 4 azimuths: draw with {cull=false, forceDetail=0} and with defaults.
  // compare(...).meanAbs < 0.5 and worstBlock < 6.0  (kDetailMeanTolerance, kDetailBlockTolerance)
}
TEST_CASE("a far model is mostly low detail and boxes, and still looks like itself", "[gpu][frame][data]") {
  // 42000-1.mpd framed, then distance x 6: byDetail[0] < 10% of instances; against the forced-full frame meanAbs < 0.5, worstBlock < 6.0
}
```
- [x] **Step 2: Run, see them fail.** - [x] **Step 3: Implement.**
- [x] **Step 4: Run all tests.** If the equivalence test fails, the fix is in the level-of-detail mesh or the thresholds, never in the tolerance.
- [x] **Step 5: Commit** `perf(native): frustum culling and three levels of detail, equal to the full picture within tolerance`.

### Task 8: Playback, picking, selection, and resize

**Files:**
- Create: `native/render/src/metal/picking.mm`, `native/render/tests/{picking,playback}_test.mm`; extend `renderer.mm`, `frame.mm`, `composite.metal`, `bmshot/main.mm` (`--frame N` plans the model as `cmd_plan.cpp` does, builds the timeline, and shows frame N with the timeline's camera for that frame, interpolated between `CameraKey`s)

Decisions:
- **Picking:** the opaque and transparent passes also write `piece + 1` to an `R32Uint` attachment (not multisampled: a separate small pass at 1 sample, drawn only when `pick` is called after a frame, reusing the frame's visible lists). `pick` reads one pixel back.
- **Selection:** selected pieces set bit 1 of `Instance::flags`; the composite pass draws a `kSelectionWidth = 2` pixel outline in `kSelectionColor = (0.0, 0.48, 1.0)` (the system accent blue) where a selected piece's coverage meets anything else, from a 1-sample mask of selected pieces.
- **`setFrame`** calls `applyFrame` and uploads only the changed instances.
- **`resize`** recreates the size-dependent targets; a size under 1 in either direction is held and `draw` returns zeroed stats.

- [x] **Step 1: Write the failing tests:**
```cpp
TEST_CASE("the piece under a pixel is the nearest one; the background is none", "[gpu][picking]") {}   // two bricks, one in front: centre -> the front one's index; a corner -> UINT32_MAX; out of range -> UINT32_MAX
TEST_CASE("a transparent piece in front is the one picked", "[gpu][picking]") {}
TEST_CASE("a selected piece gets an outline and nothing else changes", "[gpu][picking]") {}             // difference confined to within 4 px of the piece's silhouette; some outline pixel has blue > 200 and red < 60
TEST_CASE("at the last frame the picture is the finished model; at the first no piece is at its seat", "[gpu][playback]") {}   // compare(shot at frames, shot with no timeline) == 0 with the same camera
TEST_CASE("going back to a frame gives the picture it gave before", "[gpu][playback]") {}             // frames 5, 40, 5: first and third identical
TEST_CASE("resizing, to zero and back, keeps drawing", "[gpu][frame]") {}                              // 256x256 -> 0x0 (stats all zero, no crash) -> 512x300: image has that size and the brick is in the middle
```
- [x] **Step 2: Run, see them fail.** - [x] **Step 3: Implement.** - [x] **Step 4: Run all tests.**
- [x] **Step 5: Commit** `feat(native): playback of a build, picking, selection outline, resize`.

### Task 9: The benchmark, ambient occlusion, and the 120 fps gate

**Files:**
- Create: `native/render/src/prep/bench_scene.cpp` + declaration in `scene.h` (`bm::Model repeated(const bm::Model& model, int columns, int rows, double gapLdu)`: copies of the model on a grid in x and z, piece ids prefixed `r<i>/`), `native/render/shaders/ao.metal`, `native/render/tests/bench_test.cpp`; extend `bmshot/main.mm`, `frame.mm`, `scene_test.cpp`

`bmshot <file> --bench <frames> [--repeat CxR] [--size WxH]` draws `<frames>` offscreen frames while the camera orbits one full turn at the framing distance, waits for each command buffer, and prints one JSON object: `{pieces, triangles, frames, cpuMs:{p50,p95,max}, gpuMs:{p50,p95,max}, frameMs:{p50,p95,max}, byDetail:[..], drawCalls}` where `frameMs = cpuMs + gpuMs` per frame. The first 30 frames are left out (pipeline and buffer warm-up).

**Ambient occlusion** goes in first so that the gate is measured with every effect of this plan on: horizon-based occlusion from the depth buffer at half resolution, `kAoRadius = 16` LDU, 8 directions × 4 steps, a 4×4 depth-aware blur, applied to the ambient (image-based) term only. Test: `"a brick standing on a plate darkens the plate beside it"` (the plate pixel 2 px from the brick's foot is darker by > 8 levels than one 30 px away; with `ambientOcclusion = false`, within 2).

**The gate:**
```bash
native/build/render/bmshot $BM_DATA_DIR/omr/models/10030-1/10030-1.mpd --repeat 2x2 --bench 600 --size 1920x1200
```
Pass: `pieces == 12148` and `frameMs.p95 < 8.33`.

- [x] **Step 1:** tests for `repeated` (piece count × copies, bounds grow by the grid, ids unique) and ambient occlusion; **Step 2:** fail; **Step 3:** implement; **Step 4:** pass; **Step 5:** commit `feat(native): ambient occlusion and the viewport benchmark`.
- [x] **Step 6: Run the gate three times; record all three results.** Also run it on `samples/helicopter/helicopter.mpd` and on `10030-1` alone.
- [x] **Step 7: If the gate fails, follow the reasoning rules — one cause at a time.** Read `gpuMs` against `cpuMs` to see which side is over. Then measure before choosing; the fixes this plan permits, in the order to consider them, each only if the measurement points at it and each followed by the Task 7 equivalence test:
  1. *CPU over budget in culling or list building:* a bounding-volume tree over instances at rest so whole subtrees are culled at once; pieces in flight are tested individually.
  2. *GPU over budget in vertex work* (triangle count in the stats is high, time falls when `--detail 2` is forced): raise `kFullPixels` while the equivalence test passes; then merge static, far, `Detail::Box` instances into one draw.
  3. *GPU over budget in fragment work* (time falls sharply at half the size): ambient occlusion at quarter resolution, a 2048² shadow map, 2× MSAA — each measured separately, and each one's effect on the picture recorded.
  Stop after these. Do not add occlusion culling, meshlets or indirect draws in this phase; if the gate still fails, that is the result, and the "Not done" section says what the profile shows the next fix would be.
- [x] **Step 8: Commit each fix separately** as `perf(native): <what is now true>` with the before and after `frameMs.p95` in the commit body.

### Task 10: `bmview` — the window

**Files:**
- Create: `native/render/tools/bmview/{main.mm,AppDelegate.h,AppDelegate.mm,ViewportView.h,ViewportView.mm}`; modify `native/render/CMakeLists.txt` (`add_executable(bmview MACOSX_BUNDLE ...)`, `-framework AppKit`)

`bmview <model file> [--play]` opens one window titled with the file name, 1280 × 800 points, resizable.
- `ViewportView` is an `NSView` backed by a `CAMetalLayer` (`pixelFormat` `BGRA8Unorm_sRGB`, `framebufferOnly` YES, `colorspace` sRGB, `contentsScale` following `viewDidChangeBackingProperties`), driven by a `CAMetalDisplayLink` with `preferredFrameRateRange` (60, 120, 120) so a ProMotion display runs at 120 Hz. Draw only when something changed (camera moved, frame advanced, size changed, selection changed): an idle window uses no GPU.
- Mouse: left drag orbits (`0.008` radians per point), right drag or two-finger scroll pans, pinch and scroll-wheel zoom toward the cursor, click selects the piece under the cursor (`pick`), click on nothing clears it, double-click frames the selection or the whole model.
- Keys: space plays and pauses, left and right step one frame, Home and End go to the first and last frame, F frames the model, E / S / A toggle edges / shadows / ambient occlusion, I toggles the readout.
- Playback advances by wall-clock time at the timeline's `Style::fps`, dropping frames rather than slowing down. The plan is computed on the shared job pool after the window is already showing the model; until it is ready the title says "planning…" and space does nothing. While playing, the camera follows the timeline's camera keys unless the user has moved it since play began.
- Readout (top-left, `NSTextField` over the view, monospaced digits): `frame n / N · cpu x.x ms · gpu x.x ms · drawn/total pieces · F/L/B counts`, updated four times a second from a running average.
- A model that fails to load shows an alert with the load report and exits with status 1.

There is no automated test for the window itself. Its logic is in `OrbitCamera`, `Renderer` and `applyFrame`, which are tested.

- [x] **Step 1: Implement.**
- [~] **Step 2: Verify by using it,** (lines 1 and 6 checked from the shell; 2-5 and 7 need someone at the screen — see the results) and record each line as checked or failed in the results:
  1. `bmview samples/helicopter/helicopter.mpd` shows the model within one second of launch.
  2. Orbit, pan and zoom are smooth and the readout shows under 8.33 ms on a 120 Hz display.
  3. Space plays the build; pieces fly in and seat; scrubbing back with the arrow keys shows earlier frames correctly.
  4. Clicking a piece outlines it; clicking the background clears it.
  5. Resizing the window, entering full screen, and dragging it to a display of another scale factor keep the picture sharp and undistorted.
  6. With the window idle for ten seconds, Activity Monitor shows `bmview` near 0% GPU.
  7. `bmview <the 2x2 benchmark scene saved by bmshot --repeat 2x2 --save-model>` orbits at the frame time the gate measured.
- [x] **Step 3: Commit** `feat(native): bmview, a window on the Metal viewport`.

### Task 11: Sanitizers, results, status

- [x] **Step 1:** Build and run the whole suite under `-DBM_SANITIZE=address` and `-DBM_SANITIZE=thread`; fix every finding (GPU tests may be slower: time limits are already disabled under `BM_SANITIZED`).
- [x] **Step 2:** Run `bmshot --stats` over every `smoke`-tier model in `native/corpus/manifest.json` (71 files). Every one must exit 0 and write an image; record piece count against `bm load`, skipped pieces, placeholder pieces and frame time. Look at a contact sheet of all 71 images; anything that looks wrong is a bug to find or a line under "Not done".
- [x] **Step 3:** Write `## Phase 6 results (<date>): the Metal viewport` in `native/README.md` after the phase 5 section: commands, how it works (one paragraph per decision above that survived), the benchmark table (scene, pieces, triangles, cpu/gpu/frame p50 and p95, detail split — helicopter, 10030-1, the 2 × 2 gate scene), the 71-model sweep, "What the corpus corrected", and "Not done" (everything under "Not in this plan", every failed line of Task 10 Step 2, the gate if missed). Update the spec's goal 5 line with the measured figure, as goal 3 was restated.
- [x] **Step 4:** Add the dated status block at the top of this file; tick the boxes that are done.
- [x] **Step 5:** Self-review: read the diff of the whole phase against "Global Constraints", "Review Focus" and the working rules, and fix what does not meet them. Then commit `docs(native): phase 6 results`.

---

## Self-review of this plan against the spec

- **Goal 5** (120 fps, 12,000 parts, M1 Pro): Task 9's gate, on a stated synthetic scene because the real file does not exist yet.
- **"Raster viewport: instanced draws per (part, material)"** Task 3 and 5; **"GPU culling"** is done on the CPU here (12,000 boxes cost microseconds on the job pool; moving it to the GPU is only worth it if Task 9 measures otherwise) — a deliberate deviation, to be recorded in the results; **PBR brick materials** Task 3 and 5; **AO** Task 9; **selection** Task 8; **HDRI, looks, bevels, contact shadows, depth of field, motion blur, gizmos, overlays** are listed under "Not in this plan".
- **"bmrender draws a bmcore scene; never mutates it"**: every engine parameter in every interface above is `const`.
- **Phase table, "Ends with: window showing a model, playback at target frame rate"**: Tasks 8, 9, 10.
- **Constraints**: no new third-party code; CMake only; the Xcode project arrives with the app in phase 8.
