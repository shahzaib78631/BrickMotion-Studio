# Finite-candidate geometric solver and verifier

`GEOMETRIC_SOLVER.md` ends with the honest blocker and the shape of its fix:

> *Depth is the irreducible ambiguity … it must be resolved … globally: the whole
> model has to be one connected, supported, non-overlapping structure … a joint
> constraint-satisfaction / optimisation problem over the whole model.*

**Current status (2026-11-10): research prototype, not complete-set PDF reconstruction.**
A certificate proves an optimum within the supplied finite candidate tables. It
proves neither that the true pose is in those tables nor that a placement matches
the booklet, has compatible LEGO connectors, or is physically stable. The benchmark
renders synthetic images from known geometry, derives its camera from known
correspondences, and injects truth after failed/skipped steps. It is not a
measurement of a model reconstructed from an actual PDF.

Modules: `brickheadz/axonometric.py`, `new_segment.py`, `pose_domain.py`,
`global_prove.py`, `certificate.py`; benchmark `scripts/reconstruct_certified.py`.
Dependency: `z3-solver` (and only numpy/pymupdf besides).

## Pipeline

```
step image ─▶ 1 camera recovery (closed form)        → CameraCertificate
           ─▶ 2 palette segmentation + built/new      → blobs + residual
 known parts ─▶ 3 finite, physically-pruned pose domain
           ─▶ 4 z3 Optimize → v* → UNSAT-core proof     → assignment + certificate
           ─▶ 5 independent verifier (recompute)        → verified
           ─▶ 6 MPD
```

## 1. Camera recovery (closed form)

An instruction drawing is orthographic-axonometric. With `R = Rx(pitch)·Ry(yaw)`:

```
u = s·(R·p)_x + ox
v = s·(R·p)_y + oy          ⇔   (u, v) = A·p + o,
A = [ s·R[0] ; s·R[1] ]  (2×3),  o = (ox, oy).
```

`(A, o)` is **linear** in the data, so ≥4 non-degenerate model→pixel correspondences give
it by least squares; the columns of `A` are the images of the world axes (the *axonometric
axes*). `(A, o)` factors back exactly: `s` is the common length of the rows of `A`, the
rows give `R[0]`, `R[1]`, and `R[2] = R[0] × R[1]` (orthonormalised by polar decomposition
when the data is noisy). Then `yaw = atan2(R[0,2], R[0,0])`, `pitch = atan2(R[2,1], R[1,1])`.

**Lemma (camera recovery).** If the correspondences satisfy the model exactly, the
8-parameter solve has a unique solution iff the design matrix has rank 8, and the
factorisation returns the true `(yaw, pitch, s, ox, oy)`. *Proof:* rank 8 gives `(A,o)`
uniquely; the unique polar factor of the affine part is a rotation; the two recovered rows
are orthonormal so `R` is the true rotation. Degenerate (coplanar) data drops the rank and
is flagged. The certificate records the pixel residual and the raw orthonormality defect
`max|R·Rᵀ − I|` — re-checkable.

Measured: residual `≈ 1e-12 px`, orthonormality `≈ 1e-15` on the Aquaman benchmark.

## 2. Segmentation

One distance (CIELAB, D65) and three thresholds: background = near the corner median;
**new-part** pixels = non-background, `chroma > sat_min`, nearest LDraw palette colour ∈
the step's new colours and within `dist_tol`. Connected components are the part instances.
The mean palette distance is a re-checkable *residual*.

## 3. Finite pose domain

For part `i`, a pose is `(x, z)` grid cell, an orientation `R` (studs-up about Y here), and a
height `y` from the support field. Orthographic projection is affine, so for fixed `(R, y)`
the `(x, z)` that lands the centroid on a blob pixel is solved in closed form (`solve_xz`);
a small integer window is enumerated. Pruning: exclude poses that overlap already-placed
cells (the exact triangle oracle lives in the studio; the student-grid cells are exact),
and require the silhouette to land on new pixels (`on_new`). Each candidate is scored by
`on_new` and silhouette IoU against its colour.

## 4. The global solve and its proof

The reconstruction of one step is the finite optimisation

```
maximise   Σ_{i,p}  score(i,p) · x[i,p]
subject to ExactlyOne_p per part i
           AtMostOne over the exact 3-D cells of any two chosen candidates
           x[i,p] → supported(i,p)        (ground, a pre-existing piece, or a
                                           same-step piece whose top meets its bottom
                                           over a shared column)
           symmetry breaking between interchangeable parts (by candidate index)
```

**Depth remains ambiguous.** Support and non-overlap eliminate many impossible
poses, but multiple connected, supported arrangements can explain the same pixels.
These constraints do not establish identifiability. `unique` refers to the finite
candidate assignment, with valid symmetries removed, not to a unique real model.

**Theorem (optimality certificate).** Let `W` be the solver's assignment and `v = Σ score(W)`.
If (a) `W` satisfies all constraints (a witness) and (b) the constraint set together with
`Σ score·x ≥ v + 1` is unsatisfiable (an UNSAT core), then no feasible assignment has a
strictly greater objective, so `W` is globally optimal. Both facts are independently
re-checkable; together they are a complete certificate.

z3 supplies both: `Optimize` gives `v*` and the witness; a second `Solver` with
`assert_and_track` on every constraint group plus the bound `≥ v*+1` returns `unsat` and
its core (the subset of constraints that proves the bound). Scores are integers (scaled by
10⁶) so the argument is exact.

## 5. Verification

`certificate.verify` recomputes, from the certificate's own data, that the assignment is
exactly-one, non-overlapping, supported, and that the objective is consistent, then
re-runs the optimality proof. `verify_step_scores` is the second, independent source: it
re-renders every candidate against the step image and re-checks the recorded scores, so a
forged score table (which a data-only check cannot police) is caught.

## Certificate schema (`*.cert.json`)

```
{ format, version, name, camera: {residual, rms, orthonormality, scale, n_points, rank, ok},
  steps: [ { step, parts: [{part,color}], candidates: [[{x,y,z,R,cells,score,on_new,iou}]],
             pick: [int], objective: int, status: "optimal"|"unsat", core: [labels],
             pre_tops: {"cx,cz": top}, camera, segmentation } ] }
```

## Measured results

Run: `cd python && uv run python ../scripts/reconstruct_certified.py 7`
(and `uv run pytest -q` for the unit + end-to-end tests).

| Result | Value |
| --- | --- |
| Camera recovery (Aquaman, all truth points) | residual `6.5e-13 px`, orthonormality `6.7e-16`, exact `(yaw 30, pitch 25, s 2.233)` |
| Steps proven `optimal` (certificate verifies) | **5 / 6** attempted of the first 7 |
| Exact reconstruction on those steps | **2 / 18** pieces |
| End-to-end controlled model (`test_brickheadz_certified_end_to_end`) | **exact** (3/3 pieces), certificate verifies and round-trips |
| Unit tests | 46 passed (camera, segmentation, pose domain, prover + brute-force cross-check, verifier, end-to-end; plus the pre-existing geometric/instruction/reconstruct suites) |

The controlled test shows the chain is sound end to end. On the real Aquaman OMR the proof
machinery works (4/6 steps prove optimal and verify) but exactness is still low, and the
benchmark diagnoses *why* — these are the next targets, not hidden:

- **Built/new separation for low-chroma parts.** Grey new parts (LBG 71) fail the
  `chroma > sat_min` test and yield no blob (Aquaman step 4 had 0 candidates). Needs a
  learned or booklet-specific separation.
- **Disconnected step sub-assemblies.** The OMR's step 1 groups pieces two plates apart
  (a sub-build), which no bottom-up support rule can connect → `unsat`. The support model
  must accept documented sub-builds.
- **SNOT pieces.** Side-stud placements are outside the studs-up support model and are
  skipped (1 step here).
- **Objective ties / occlusion.** When two candidates explain the same pixels equally, the
  optimum is not unique (the certificate is still *an* optimum). A uniqueness certificate
  (enumerate the second-best) and an occlusion-aware coverage term are the natural next
  step.

The camera and the proof are exact; closing the segmentation and support gaps is what
remains between this and a fully trusted booklet→MPD engine.

## Refinements (second pass)

Four targeted improvements, each measured on the benchmark and covered by a unit test:

- **Prior-frame segmentation.** `segment(..., prior=…)` adds a per-pixel change test
  against the previous step's image as a second way to be "new", so a grey part on a grey
  layer (no chroma cue) is recovered. Aquaman step 4 went from 0 candidates (`unsat`) to
  `optimal` — this is the jump from 4/6 to 5/6.
- **Contact support.** `support_from_aabb` treats any face contact (not just a vertical
  stack) as support, matched against the world bounds of the selected parts and the
  already-built model. This is the physically correct rule for laterally attached and
  side-stud pieces, and the verifier recomputes it from the recorded boxes.
- **Uniqueness certificate.** After proving `v*`, the prover checks whether a *different*
  assignment attains `v*`; `unique` is stored and the verifier recomputes it. A non-unique
  optimum is the honest signal that the image does not yet single out one reconstruction.
- **Blob shape tie-breaker.** A candidate's IoU is taken against the single blob it
  overlaps most as well as the whole colour mask, so a pose straddling two merged
  same-colour pieces scores below one that matches a shape.

A hard "one blob per part" constraint was tried and **rejected**: adjacent same-colour
pieces merge into one connected blob, so the rule over-constrains and goes unsat. Blob
identity is kept as per-candidate metadata (and the shape tie-breaker) instead.

What still holds the exact rate low is the objective's non-uniqueness (`uniq=0` on most
steps): several poses explain the new pixels equally well, and a stronger analysis-by-
synthesis term (union coverage / occlusion) is the next lever. The end-to-end controlled
test remains exact, so the chain is sound; it is the real-booklet single-view ambiguity
that is not yet resolved.


## Reconstruction corrections (2026-11-10)

- LDraw and image vertical coordinates now both increase downward. Old synthetic
  camera specifications can opt into `screen_y: -1`; regenerate old rendered
  fixtures/camera records for the corrected default `screen_y: 1`.
- Contact uses body bounds excluding male stud protrusions. Ground contact must
  occur at the floor; interpenetration is not face contact. Support chains must
  reach ground or prior geometry, so floating cycles are rejected. This remains
  a conservative body-box approximation, not a connector/stability certificate.
- Only genuinely interchangeable candidate tables can share index-based symmetry
  constraints. Unknown/timeout results are no longer labelled unsatisfiable.
- Verification checks the selected support graph, pins the actual witness against
  all constraints, and rejects malformed picks. Pixel-score verification uses
  the same-colour blob score as the placement objective.
- Candidate search enumerates elevations before solving image projection and
  has no BrickHeadz-only 24-stud position bound. The benchmark still caps each
  part at 24 candidates; its summary reports domain inclusion before/after that cap.
- Optional union coverage rewards different pieces explaining different image
  pixels. It remains experimental (`--coverage`); it has not demonstrated a
  real-booklet accuracy improvement.
- `summary.json` labels synthetic evidence and every ground-truth injection.
  Use `--out` to keep benchmark runs separate.
- Source MPD reconstruction expands nested/repeated local sub-models and preserves
  parent attachment steps, empty turn steps, inherited colours, and transform
  composition. Unused definitions, missing sub-models, and cycles are handled
  explicitly. Source geometry reuse is separate from PDF inference.


### Latest diagnostic run

`cd python && uv run python -u ../scripts/reconstruct_certified.py 7 --teacher-forced --out .cache/instructions/reconstruction-benchmark/final-isolated`

With the corrected solver, **2/18 attempted pieces** match the benchmark geometry,
even when each step is given the correct prior state. The true body pose appears
in the generated domain for **12/18** pieces, and in the capped tables for **9/18**.
One SNOT step is skipped. These are synthetic, oracle-camera, isolated-step
measurements; they do not demonstrate reconstruction from Superman, Batman, or
the fishing PDF. The next accuracy work must address missing/occluded instances,
candidate pruning, image scoring, and the meaning of exploded/attachment views.


## Actual-booklet milestone: separate feature-based solver

`brickheadz/booklet_vision.py` and `scripts/reconstruct_real_sequence.py` now run
small sequences on real PDF crops. Superman steps 1–4 recover 6/6 pieces,
including a foundation omitted from the callout and an exploded placement.
Its separate step-34 panel build recovers 3/3 pieces; a Batman opening holdout
recovers 3/3. These use image stud/arrow features and projected polygon masks,
without oracle cameras, reference poses, or prior-truth injection. Reference
files are evaluation-only and opened after inference/export. See the README's
real-booklet milestone for reproduction, fixtures, and limitations.

The experiment is limited to small studs-up plate/tile foundations, one addition
or two identical additions, and a two-panel covering-tile build. A black tile
panel without visible studs uses persistent footprint boundaries for camera
translation/scale. It does not yet infer full-model attachment transforms or
handle SNOT. Low image agreement and inconsistent cameras stop the reconstruction.
The polygon/feature scoring is separate from this document's synthetic z3
benchmark; its results do not improve that benchmark by relabelling its inputs.

A body measurement error was found during this experiment: male snap records for
underside tubes were treated as outward protrusions. Face-boundary geometry now
prevents shrinking a plate whose outer walls already reach that plane. For
example, 3710's body remains 0..8 LDU rather than incorrectly becoming 0..4 LDU.
