# Joint arrow location and direction: expanded real corpus

The new catalog contains 120 distinct official LEGO instruction PDFs (120 distinct sets and PDF SHA-256 hashes). There are 7,340 source pages. These pages have **not** all been annotated. A coding agent visually reviewed 600 proposed 96×96 source-image crops and accepted selected arrowhead/negative regions. Of the 120 new booklets, 112 contribute accepted arrowheads; eight contribute reviewed negatives only. This is agent-reviewed ground truth, without independent human annotation.

The source manifest is `benchmarks/instructions/arrow-catalog-100-sources.json`. Every accepted crop records the source URL/PDF hash, page, render DPI, crop rectangle, pixel hash, local tip, approximate directional anchor and completeness. `arrow-catalog-100-review.json` preserves accepted/rejected decisions and the proposals as they appeared at review. `arrow-catalog-100-labels.json` is the materialized training/evaluation dataset. The builder refuses accepted proposals whose pixels or coordinates changed after review.

## Dataset split

| Split | Source booklets | Regions | Arrowheads | Complete regions |
| --- | ---: | ---: | ---: | ---: |
| Train | 102 | 501 | 511 | 341 |
| Validation | 12 | 48 | 49 | 40 |
| Test | 12 | 52 | 54 | 42 |

Training includes 96 new catalog sources (88 with arrowheads, eight with negatives only), plus the earlier six training booklets. Earlier validation/test annotations are excluded from training. Each new held-out split contains all five main instruction families. There are 37 validation heads and 39 test heads inside complete regions; other held-out heads provide partial-label diagnostics. Entire sets remain in one split; exact PDF and cross-split image hashes are checked.

This corpus is dominated by red/green, fairly straight arrows. Black arrows, curved arrows, rotation symbols and full-page clutter need broader independent annotation. Similar templated artwork can occur across different sets even though the PDF and exact image hashes differ.

## Model and selection

`python/brickheadz/joint_arrows.py` adds jointly trainable arrow heatmap, subpixel offset and local direction heads sharing RGB-preserving features. The earlier stud detector stays frozen. Known positives in partial regions are supervised, while unlabelled pixels remain unknown; complete regions and reviewed negatives supervise background. Training uses book-balanced sampling, rotations/translations, 80% real images and 20% existing synthetic train scenes.

The run uses seed 79, batch 16 and 2,400 optimization steps. The checkpoint and confidence threshold are selected using directed F1 on complete validation regions, breaking ties with location F1. Correct directed detections require a tip within four original-image pixels and direction within 15 degrees. Test data is evaluated only after checkpoint selection. Evaluation has no geometric arrow fallback.

Artifacts are under `.cache/instructions/joint-arrows/catalog-100/`: `best.pt`, `latest.pt`, `dataset.json`, `history.json`, `report.json`, `transfer-report.json` and prediction contact sheets. The transfer report separately measures the earlier larger City/Doctor Doom regions and compares with a previous-model baseline whose threshold is calibrated on the new validation split. Do not compare crop metrics directly with whole-page performance.

## Measured result

The 2,400-step run selected step 1,800 using validation only, with arrow confidence threshold 0.55. Every training booklet was sampled 300–301 times. Both the location/offset and direction weights changed; the frozen stud detector and the original classifier/verifier files remained unchanged.

On 42 complete test regions containing 39 heads:

| Method | Tips found | False positives | Located with correct direction | Directed F1 |
| --- | ---: | ---: | ---: | ---: |
| Previous learned model, threshold calibrated on new validation | 20/39 | 8 | 20/39 | 59.7% |
| Previous saved model with geometric fallback | 29/39 | 10 | 26/39 | 66.7% |
| New jointly trained model, no geometric fallback | 24/39 | 3 | 22/39 | 66.7% |

Thus the new learned model reduces false alarms, but it does not beat the earlier hybrid's directed F1 and misses more heads than that hybrid. Its mean direction error on located test tips is 4.82 degrees. On a further 15 known heads in partial test regions it finds six, all with correct direction; precision/F1 cannot be measured there.

On the earlier larger City regions, it finds 8/14 tips with one false positive, all eight directions correct. On Doctor Doom it finds 0/8 with three false positives. The previous saved hybrid found 8/14 City tips with four false positives and 2/8 Doom tips with none. Transfer is still inadequate for reliable general booklet reconstruction; more training steps alone did not resolve it. Broader real annotation of difficult/black/curved arrows and larger contextual regions remains necessary.

The checked-in compact result is `benchmarks/instructions/joint-arrows-catalog-100-result.json`; detailed local reports retain per-book predictions, validation history and training exposure. The tests passed: 19 joint/direction tests and 36 existing keypoint, connector-parser and placement tests. The CLI was smoke-tested against the selected saved checkpoint.

## Reproduction

Run these from the repository root, using the existing Python environment:

```sh
python/.venv/bin/python scripts/acquire_instruction_catalog.py --target 120
python/.venv/bin/python scripts/sample_arrow_catalog.py
# Visually review source crops; proposals alone must never be marked reviewed.
python/.venv/bin/python scripts/build_arrow_catalog_labels.py
python/.venv/bin/python scripts/train_joint_arrows.py
python/.venv/bin/python scripts/evaluate_joint_arrows.py
```

The checked-in review decisions bind the currently cached crop pixels/coordinates. Regenerated proposals require a new review if either changes. The PDFs and crop images are local cache artifacts, not bundled with the source manifest.

For inference on a rendered instruction page, use native-resolution overlapping tiles:

```sh
PYTHONPATH=python python/.venv/bin/python -m brickheadz.joint_arrows \
  --checkpoint .cache/instructions/joint-arrows/catalog-100/best.pt \
  /absolute/path/to/page.png
```

The CLI returns tip coordinates and base→tip direction vectors in original image pixels (x right, y down), plus uncalibrated detection scores. It merges overlapping tile predictions within four pixels. Arrow purpose, shaft tracing, 3D displacement and complete-set reconstruction are not supplied by this model. The existing `DirectionObserver` and `evaluate_learned_booklet.py --direction-checkpoint` accept this joint checkpoint. Stud handling stays on the frozen detector; arrows use native tiles. Direction vectors remain image metadata rather than 3D assembly constraints. Existing pipeline defaults are not switched automatically.
