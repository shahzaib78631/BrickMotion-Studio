# Path B: learned placement (status and measurements)

Goal: accurate reconstruction **without** an OMR. Path B adds a learned component
on top of the deterministic solver, trained self-supervised on data we can make
in unlimited quantity.

## Infrastructure

- **Self-supervised dataset** (`brickheadz/place_learn.py::build_dataset`). The
  procedural generator produces grid-posed figures, so we render instruction-style
  step images with exact ground-truth poses and label candidate poses true/false.
  No human labelling, unbounded data.
- **Learned scorer** (`place_learn.train/score`) — L2 logistic regression in pure
  numpy over 10 features, standardised. No framework needed.
- **Driver** (`scripts/train_placement.py`): builds the dataset, trains, reports
  hold-out top-1 accuracy vs the hand-tuned IoU baseline.

Features: `iou, precision, recall, builtOver, collision, supported, sizeRatio,
compPrec, compRec, compSize` (the last three are instance-exclusive: how well the
candidate alone explains the largest unclaimed blob).

## Measured

| Setting | Result |
| --- | --- |
| Dataset (40 train figs) | 8250 candidates, 750 positive |
| Hold-out **local** top-1 (12 figs, 372 parts), IoU baseline | **0.105** |
| Hold-out **local** top-1, learned scorer | **0.153** (+46% relative) |
| Full-solver end-to-end (Aquaman synthetic, 5 steps), IoU | **3/20** exact |
| Full-solver end-to-end, learned **re-ranker** | **0/20** exact |

## Findings (the important part)

1. **Local ranking is not the bottleneck.** Both IoU (0.105) and the learned
   scorer (0.153) are poor on the local 27-way problem. In a step with
   same-colour parts, a pose shifted onto *another* part's pixels scores higher
   than the true pose — the colour mask is shared, so the signal is ambiguous.
2. **A feature-based scorer trained on near-miss candidates does not transfer.**
   Re-ranking the solver's real candidates with it *hurt* (0/20 vs 3/20): the
   training distribution (local perturbations) differs from the solver's
   candidate set (cross-instance, cross-orientation), and 10 scalar features
   cannot encode the spatial context needed to tell one blob from another.

## CNN spatial verifier (PyTorch)

Installed `torch` and added `brickheadz/verify_learn.py`: a small CNN that scores a
*candidate pose* from a local 48×48 patch of 4 channels — step image (grey), the
part's colour mask, the candidate's rendered silhouette, and the already-built
silhouette. That spatial context is what 10 scalars could not carry.

- Candidates are generated **exactly as the solver does** — the colour mask's
  connected components (cross-instance negatives), local perturbations, and random
  poses — so train and inference share a distribution.
- `scripts/train_verifier.py` builds the dataset (40 figures), trains, and reports
  hold-out top-1 vs the IoU baseline.

| | IoU baseline | CNN verifier |
| --- | --- | --- |
| Hold-out top-1 (solver-style candidates, 372 parts) | 0.543 | **0.858** |
| End-to-end, Aquaman synthetic 5 steps @160 | 0/20 | **1/20** |
| End-to-end, Aquaman synthetic 5 steps @256 (IoU) | 3/20 | — |

The verifier **more than halves the ranking error local to a step** (0.54 → 0.86),
which is the learned component working as intended. End-to-end it is still weak,
for two reasons that are now clearly separated from ranking:

1. **Cascade** — one wrong placement blocks the true poses that follow via the
   occupancy constraint. Ranking correct can't fix a committed mistake.
2. **Distribution** — at inference `y` ranges over 0–39 and all 24 orientations,
   wider than training; and render scale (160 vs 256) changes patch appearance
   (no scale normalisation yet).

## Conclusion

Local candidate ranking is now solved to a useful degree (CNN 0.86). The remaining
gap to a trustworthy OMR-less model is **not** a better ranker; it is:

1. **Joint per-step assignment** with disjoint colour claims + physical
   constraints, with limited backtracking, to kill the cascade.
2. **Scale/position-normalised patches** (or multi-scale training) so the verifier
   transfers across render sizes and remains usable on real booklet crops.
3. Train on the exact inference candidate distribution (full `y` range, all
   orientations, occlusion cases).

Both the scalar scorer and the CNN verifier are **opt-in** and off by default in
the end-to-end driver, because as integrated neither yet beats plain IoU
end-to-end. The dataset builder, both learned models, and the benchmark stay in
place so each next change is measurable.

## Conclusion (original)

The fix is not a stronger classifier on these features. It is:

1. **Train on the real candidate distribution**, including cross-instance
   negatives, not just local perturbations.
2. **A spatial verifier** — a small CNN (PyTorch) over the local image patch +
   rendered candidate mask + built mask — so the model can see edges/context
   rather than 10 scalars. This is what the numpy-only constraint blocked.
3. **Joint per-step assignment** with disjoint claims (each part explains a
   distinct blob) and physical constraints, instead of greedy commits.

The learned scorer is wired but **opt-in** (`--learn`) and **not** on by default,
because as trained it regresses the solver. The dataset builder, learner, and
benchmark stay in place so the next iteration is measurable.
