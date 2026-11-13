# Research brief: every possible route to solving LEGO instruction booklets

**Read-only for the repository: do not edit, create or delete files in it, do not change git state.** You may read
any file, view images, run read-only Python (`cd python && .venv/bin/python -c ...` printing to stdout), and search
the web as much as you like. Your final reply is the research report.

## Goal

Given a LEGO instruction booklet (PDF pages: step pictures drawn in the booklet's own style) and the parts
catalogue (LDraw), recover the 3D model step by step: for each step, the camera of the picture and the exact pose
(position + rotation on the stud/connection lattice) of every new part, pixel-perfect against the page. Fast (about
camera speed), learned and spatial, and it must generalise to any booklet style (BrickHeadz, Friends, Technic,
architecture sets...). Read `docs/coordnet/DESIGN.md`, `docs/coordnet/placement-v2-design.md`,
`docs/coordnet/realpage-design.md`, `docs/coordnet/linefit-design.md` and the code in `python/coordnet/`.

## The barriers we keep hitting (measured, not guessed)

1. **Style domain gap for the camera network.** CoordNet (a RAFT-style flow net between page and our render)
   is confident on < 1% of pixels on real BrickHeadz pages and calls 52-66% of the picture "new", even from the right
   view. It was trained only on our own render style. 30/41 pages of set 40348 got no camera at all.
2. **Placement network centre offsets are imprecise.** PlaceNet v2 predicts the new-part mask well (IoU 0.86) but
   the per-pixel offset to the part's drawn centre has median error 7.8 px (predicting zero: 16.5 px); only 4.8% of
   pixels are within 2 px. The centre-vote shortlist needs ~3 px.
3. **Candidate generation misses legal poses.** With answer-key offsets the shortlist lists 89% of true parts on
   synthetic steps; 144/639 true poses are not produced by the connection-candidate generator at all.
4. **Real-page labels are scarce and must be trustworthy.** Colour comparisons fail across booklet palettes; we now
   verify with line maps, tile phase-correlation and per-part removal counterfactuals; we are building a network-free
   camera fit to the page's drawn lines (coarse search + point-to-line ICP). Few kept pages so far.
5. **Ambiguity:** symmetric models/parts, repeated stud lattices (aliasing by one stud pitch), hidden parts.
6. **Booklet layout:** sub-build panels, callouts, tiled images, pages with several pictures.

## What to research (be exhaustive, then be ruthless)

Think as broadly as you can -- computer vision, photogrammetry, graphics, robotics, crystallography, document
analysis, program synthesis, physics, even ideas from fiction -- but **every lead must come with evidence**: a paper,
a dataset, a code base, a measurement you ran here, or a concrete argument from this repository's data. Speculation
is welcome only when labelled as such with a way to test it cheaply.

Directions to check at least (add your own):
- Prior work on LEGO/assembly instructions: MEPNet (Wang et al., "Translating a Visual LEGO Manual to a Machine-
  Executable Plan"), LEGO-related datasets, IKEA assembly (IKEA-Manual, IKEA ASM), "Image2Lego", program synthesis
  from manuals, StableText2Brick/BrickGPT, and what each did about style gap, pose, and lattice.
- Style-invariant matching: edge/line-drawing domain (line drawings vs renders), non-photorealistic rendering for
  training data, domain randomisation, foundation features (DINOv2/v3, RoMa, LoFTR, MASt3R/DUSt3R, LightGlue,
  SuperPoint), sketch-based retrieval, contour-based pose (e.g. RAPID, region-based tracking, Chamfer/oriented
  chamfer, distance-transform pose), render-and-compare (DeepIM, MegaPose, FoundationPose, GigaPose).
- Line-drawing camera calibration: vanishing points on axis-aligned bricks, the known booklet isometric-like view,
  stud ellipses as conics (ellipse fitting gives camera orientation directly), lattice/grid priors, Hough on stud
  pitch, 2.5D sketch.
- Discrete pose on a lattice: treating placement as classification over connection sites, assembly graphs,
  constraint satisfaction, beam search with render verification, probabilistic programs.
- Self-training on real booklets: pseudo-labels from verified pages, cycle consistency between consecutive steps
  (step N's model is step N+1's base), the booklet's own parts list per step (it tells us which parts are new!),
  the step's callout/arrow cues.
- Anything that turns the per-pixel offset problem into something easier (keypoints, heatmaps of stud centres,
  instance segmentation + classification of the part type, dense correspondence to the catalogue part).

## Deliverable

A ranked report: for each barrier above, the 3-6 most promising approaches, each with (a) the evidence and source
links, (b) why it fits our setting and data, (c) the cheapest experiment that would confirm or kill it here (files,
data, expected numbers), (d) effort and risk. Then an overall recommended plan. Mark clearly what you verified by
running code here versus what you read. Be direct; no padding.
