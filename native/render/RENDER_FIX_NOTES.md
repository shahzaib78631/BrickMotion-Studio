# Viewport fringe / glass refinement — 2026-11-17

The changes in this archive are limited to compositing, glass transport,
visible glass outlines, and focused regression tests. There are no new
render targets, GPU passes, dependencies, or changes to the public API.

## 1. Bright/dashed line at object/floor silhouettes

**Cause in the previous shader:** the full pixel (including covered brick
samples) was multiplied by the floor's shadow factor:

    behind = mix(background, covered_surface, coverage) *
             (1 - floor_coverage * (1 - floor_light))

This is not coverage-correct. For example, at 50% opaque coverage and 50%
floor coverage, only the latter half should receive the floor shadow.
The previous equation both attenuated the object and left the exposed
background between the object and its shadow too bright.

**Fix (`shaders/composite.metal`):** composite the MSAA-resolved solid light
and the exposed floor/background as disjoint coverage terms:

    behind = covered_solid + background *
             (free_coverage + floor_coverage * floor_light)

The per-sample solid colour is clipped in linear space *before* coverage is
applied, matching the renderer's existing style. The floor-light upsampling
also no longer compares the floor samples against the resolved sample-0
*foreground* depth: that depth can belong to the brick at an antialiased edge.
The floor is a plane, so its light is interpolated from valid neighboring
floor pixels, with a small nearest-floor fallback only when the normal
2x2 bilinear footprint contains none.

This addresses **shadow/coverage fringes**, not arbitrary cracks in source
LDraw geometry or external image-processing artifacts.

## 2. Glass

- `shaders/glass_transport.metal`: rays seeing the ground or empty white
  background through glass now use the same `kFloorThroughGlass` attenuation
  as the preview/composite path. Reflected rays still see the studio radiance.
- `shaders/glass_transport.metal`: added a geometric-hemisphere safeguard for
  smoothed interface normals at curved edges. Exact Fresnel and Snell
  refraction are retained. A ray that would cross the wrong side of the
  *geometric* triangle is re-evaluated with the triangle normal, avoiding
  self-hits and isolated bright/dark samples.
- `shaders/brick.metal`: fast-preview glass now uses exact unpolarized
  dielectric Fresnel (matching full transport) instead of Schlick's fit.
- `src/metal/frame.mm`: opaque edges are drawn before glass, glass contours
  **after** the glass colour/depth prepass. Previously the refractive pass
  painted over its own edge lines, losing the dark moulded outlines in the
  EyeSight reference. Each edge batch is still drawn once.
- `include/bmr/tolerances.h`: the existing opaque edge opacity is unchanged;
  glass gets a separate moderate `kGlassEdgeOpacity` for legible contours.

## 3. Runtime characteristics

- No new render pass or intermediate texture.
- Common floor lookup: four floor-light texture reads at affected pixels;
  the 5x5 local fallback is evaluated only at partially covered silhouettes
  when all four bilinear floor samples were classified as non-floor.
- Opaque and glass edge batches remain single-draw; their order changes.
- No change to the expensive BVH construction / max path count; optimizing
  full-scene refraction requires profiling on the intended Mac hardware.
- Refraction shading adds a cheap hemisphere check; it recomputes the
  interface only for invalid smoothed-normal ray directions.

## 4. Validation / tests

Added `tests/composite_coverage_test.mm`: a one-pixel, controlled GPU
compositing regression with a synthetic 50%-covered red surface and a 50%
shadowed floor, deliberately using a foreground depth sample. It verifies the
linear-light coverage equation through the actual Metal composite pipeline.

Added an interior glass-contour regression in `tests/frame_test.mm`, ensuring
refractive glass still shows its edge lines in front of the pane instead of
only at its outer silhouette.

**Verified here:** shader-source embedding via `cmake/embed_shaders.cmake`,
syntax-only C++ compilation of the generated shader-source translation unit,
source/patched-file comparison, and `git diff --check`.

**Not possible here:** actual Metal shader compilation, GPU test execution,
frame-time measurements, or EyeSight pixel-error comparison. Run the project's
existing CMake test target on macOS with its required bmcore, Catch2, and LDraw
fixtures before release.

Visual checks to do on a Mac:
1. Render the red float/pontoon scene at multiple zoom levels, with floor,
   AO, and shadows enabled. Inspect the boundary against its contact shadow.
2. Toggle `floor` and `shadows` separately to distinguish shadow halos from
   genuine mesh seams / source geometry gaps.
3. Compare moving-preview and stopped full-transport glass, especially window
   borders, studs, transparent red/blue overlap, and clear glass against white.
4. Profile GPU frame times at 1080p and 4K; the 5x5 fallback should remain a
   near-silhouette exception rather than the common case.

No claim of a hardware-verified visual match is made in this archive.

## 5. Smooth stud-to-brick junction (2026-11-17 follow-up)

The regular LDraw `stud.dat` draws **two** circular outline rings: one at
its upper edge and one at the base, where the stud enters the parent brick.
These dark, depth-biased outline strokes make the lower joint appear much
sharper than the gently rounded injection-moulded joint in BrickLink EyeSight.
There is a second problem: the stud cylinder and the flat brick top are often
*separate* surfaces, so the existing convex-only `roundRenderEdges()` cannot
find that seam by looking for shared manifold edges.

**Solution (`src/prep/stud_roots.cpp`):** identify a complete 12-LDU-diameter
stud base ring, check that a flat upward-facing deck extends beyond it, and
verify the adjacent triangles are outward-facing stud walls. Then:

- Suppress only that validated **base** ring from the outline-line mesh. Keep
  the stud's upper rim, corners, underside tubes, and unrelated edge lines.
- Split just the affected stud-wall triangles at `kStudRootWidth` above the
  deck and interpolate their normals to match the deck at the root. This makes
  a narrow, smooth lighting transition without moving surface positions,
  changing the part bounding box, or affecting physics/planning geometry.
- Leave unsupported cylinders, holes, different-radius rings, incomplete
  outlines, and non-upright studs unchanged rather than guessing at geometry.
- Apply once during cached Full and Low render-mesh preparation; no new shader
  work, draw calls, render targets, or per-frame computations. The shadow mesh
  is not altered.

`kStudRootWidth` in `include/bmr/tolerances.h` controls the softness separately
from the existing outer-edge rounding (default `0.45` LDU = `0.18` mm).

The new `tests/stud_roots_test.cpp` covers a complete base ring, preserved top
rim and horizontal deck, retained area/winding/normal lengths, 2-stud bricks,
passing through the existing convex rounding, plus conservative skips for
unsupported or non-stud geometry. It was compiled and run with a standalone
C++17 compatibility harness here, including AddressSanitizer/UndefinedBehaviorSanitizer.
Full bmcore/Catch2 and Metal integration requires the user's macOS repository.

**Limitation:** this is a shading-normal microfillet, not a physically displaced
fillet. It softens close-up reflections and removes the dark stroke but does not
change the stud silhouette. No claim of a screenshot-verified match on Apple
hardware is made.
