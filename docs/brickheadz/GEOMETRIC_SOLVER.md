# Geometry-first solver (from scratch)

A response to path B's wall: instead of searching tens of thousands of poses and
ranking them, encode the *structure* of LEGO builds. `python/brickheadz/geometric_solver.py`.

## The three facts it exploits

1. **Bottom-up build** → a new part's `y` is the *support surface* under its
   footprint, not a free variable. We keep a height field
   `H[(x,z)] = top occupied plate` and set `y = support(H, footprint)`.
2. **Affine projection** → for a fixed orientation `R` and height `y`, the grid
   `(x, z)` that lands the part's centroid on a pixel is solved in closed form
   (`solve_xz`). Combined with (1) this is a fixed point (`candidate`), plus a ±1
   local refinement because the rendered pixel centroid differs from the vertex
   centroid by up to a stud.
3. **Orientation is constrained, not searched.** Only physically valid studs-up
   orientations are allowed (`STUDS_UP_ROTS`), which removes the flip ambiguity
   where a plate looks identical upside-down.

Instance separation is by **shape**: parts are assigned to the colour mask's
connected components by silhouette match, greedily by score (`solve_step`).

Result: a handful of candidates per part instead of tens of thousands, each
already non-overlapping and on support.

## Speed

| | search + learned re-rank | geometry-first |
| --- | --- | --- |
| Full model (135 pieces), synthetic | ~5+ min for 5 steps | **~18 s for all 30 steps** |

## A corrected evaluation (important)

While measuring this I found the benchmark was wrong:

- It compared **absolute** matrices, but the OMR has its own origin (step 1 sits
  at `y≈6–7` while the model's lowest piece is at `y≈1`). Comparisons must be
  **up to a global translation**.
- It required **exact rotation**, but a symmetric part placed with any equivalent
  matrix is the same geometry. Matching must be **symmetry-invariant**.

`score_against_truth` now aligns by centroid translation and matches by
**body-box corner sets** (Hausdorff). Every earlier accuracy number reported
against the old metric (the "15%", "3/20") was measured in a broken frame and is
**invalid**.

## Honest result and the real blocker

Under the corrected metric the geometry-first solver reconstructs **~0–2 / 135**.
The blocker is now precisely identified:

**Depth is the irreducible ambiguity.** In one orthographic view, `y` and `(x,z)`
trade off — a part at `(x, z, y)` and one at `(x+δx, z+δz, y+δy)` project to the
same pixels. With nothing built below, the fixed point happily converges to the
ground (`y=0`) explanation, which is *consistent with the image* but wrong.
`test_exact_pose_reproduces_silhouette` confirms the geometry is exact (IoU > 0.99
at the true pose); `candidate` returns a lower-but-valid ground pose instead.

So per-piece local decisions cannot resolve depth. It must be resolved
**globally**: the whole model has to be one connected, supported, non-overlapping
structure, which pins the relative depth of every piece. That is a joint
constraint-satisfaction / optimisation problem over the whole model, not a
per-part solve — the natural next algorithm to build.

## What works (unit-tested)

- Support field (`heights_update`, `support_at`).
- Exact analytic placement when the depth is known (`_iou_at` IoU > 0.99).
- High-scoring candidate search.
- The corrected, translation- and symmetry-invariant metric.
