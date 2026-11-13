# Foundation hardening: what is solid, what is shaky, how to fix it

Status: proposal for review. Nothing here is built. Evidence cited is from this repo's runs
(ledger `.superpowers/sdd/2026-11-11-booklet-to-mpd-phase1/progress.md`) and the sources at the end.

## What is solid (verified, with evidence)

| Piece | Evidence |
| --- | --- |
| Booklet-to-OMR pairing, whole-set split, alignment | 109 tests; 30 of 31 sets align (affine-gap group alignment) |
| OMR truth loader (embedded parts, flex chains, submodels) | OMR part counts equal official Rebrickable counts on most sets (e.g. 42105: 404 vs 405) |
| Part identity | 96.4% of 5,674 booklet parts match the OMR (exact or same physical part); 15 sets have zero booklet residual |
| Fixed camera (yaw 35, pitch 35, quarter turns) | Equals per-booklet fitting (0.73 vs 0.73 held-out). MEPNet independently reports camera rotations (0, 225±10, 30±10) from real manuals |
| Renders are separate PDF image objects | Verified on the PDFs; InDesign/Switch layouts; arrows are baked into the raster |
| Scoped visible truth | Mean silhouette IoU 0.77 to 0.83 on real steps |

## What is shaky (found in this audit)

1. **The benchmark is small, unrepresentative and partly contaminated.** 8 hand-picked studded sets: 6 train, 1 validation, 1 test.
   I tuned the step mask while looking at failures on 40351, which is the *test* set. 0 Technic sets. Only 3 of the 8 are fully certified.
2. **The answer key is not uniformly trustworthy.** Only 9 of 31 sets have zero residual both ways plus strong alignment. Scoring a correct
   placement against a wrong OMR part would look like a failure.
3. **Alignment evidence is count-only.** 31088 and 42112 match as 8 and 6 scattered OMR blocks. Per-step identity is not checked.
4. **The renderer is a union of convex hulls.** No occlusion, no edges, no concavity. IoU plateaus near 0.85 and cannot pin a pose.
5. **Mask parameters were tuned by eye on a few pictures** (tolerance 30, kernel 9). White and transparent parts are still weak (40351: 0.68).
6. **Everything is teacher-forced.** Real runs accumulate error each step; MEPNet names this its main open limitation.
7. **Experiments live in scratch scripts, not a reproducible harness**, so a regression would go unnoticed.
8. **Metrics are not comparable to the literature.** MEPNet reports component-wise pose accuracy, whole-model accuracy and Chamfer distance.

## Hardening steps (each has an acceptance test)

| # | Step | Acceptance |
| --- | --- | --- |
| H1 | **Certified truth tier.** Grade every set A/B/C from three checks: booklet-vs-OMR identity residual, official-inventory agreement, per-step visible-IoU. Benchmarks and training use grade A only. | Written grading rule; list of A sets; a test that no non-A set enters the benchmark |
| H2 | **Frozen evaluation protocol.** Tune only on `train`; report `validation`/`test` once; stratify studded vs Technic; add MEPNet's metrics (component-wise pose accuracy, whole-model accuracy, Chamfer). | Protocol doc + one command that prints all metrics; thresholds recorded before looking at test |
| H3 | **Exact renderer.** Mesh z-buffer with occlusion and black edge lines in LEGO's cel style, replacing hulls. | Mean IoU ≥ 0.90 on grade-A steps; edge-Chamfer reported |
| H4 | **Independent benchmark.** MEPNet's MIT-licensed code, generator, datasets and checkpoints (needs approval to download). Also our own synthetic manuals: render OMR models backward, step by step, with exactly known truth. | Our solver scored on data we did not align by hand; numbers comparable to MEPNet's published ones |
| H5 | **Use MEPNet's constraints.** Under scaled orthographic projection, the 2D offset between any two points of one rigid part is independent of depth, so one keypoint gives all anti-stud positions to match against base-shape studs. Add symmetry classes (rotation order 1, 2, 4) and connection-feasibility search. | Property tests on synthetic steps: exact pose recovered when truth is given |
| H6 | **Mask quality gate.** Measure mask plausibility on all 30 booklets, with thresholds chosen on `train` only. | Reported pass rate on `validation`/`test`; failing images listed, not tuned away |
| H7 | **Reproducible harness.** One `make`/script that runs audit, identity, camera and benchmark with fixed inputs, writes a report, and fails on regression. | Run twice, identical report; deliberate regression is caught |
| H8 | **Free-run measurement.** After teacher-forced placement works, run with predicted state and report error accumulation per step. | Curve of exactness vs step number |

Recommended order: H1, H2, H6, H7 first (cheap, make every later number trustworthy), then H3 and H5 (accuracy), then H4 and H8
(independent validation).

## Honest caveats on the research

- MEPNet's reported whole-model accuracies came from a garbled table extract (about 90% Classics, about 38% Architecture); verify against the paper before citing.
- MEPNet trains on synthetic manuals and its camera is chosen from real manuals; its real-booklet generalisation is on three small collected sets, not on 30 official booklets.
- The dataset download links are on the repo README; nothing has been downloaded.

## Sources

- Wang et al., Translating a Visual LEGO Manual to a Machine-Executable Plan (ECCV 2022): https://arxiv.org/pdf/2207.12572 and supplementary https://ar5iv.labs.arxiv.org/html/2207.12572
- MEPNet code (MIT): https://github.com/Relento/lego_release
- MegaPose / render-and-compare pose refinement: https://arxiv.org/pdf/2212.06870
- Abstract Render-and-Compare: https://arxiv.org/pdf/1910.03412
- LEGO on instruction design: https://www.lego.com/en-si/service/help-topics/article/how-we-design-our-building-instructions
