# Independent solver audit: 41488

This handoff is for the active `feat/booklet-mpd-phase1` solver work. The diagnostic code, fixtures and tests are separate files; production solver, scorer, confidence and benchmark artifacts were not edited by this audit. Reference poses are used only in evaluation and explicitly labelled counterfactuals.

## What to fix first

**Preserve camera hypotheses until new-part placement has been evaluated.** The first actual divergence is printed step 2, page 4. Step 1 is a correct two-part assembly in a symmetry-equivalent frame. In step 2, supplying the correct previous assembly and the correct new-part identities still produces zero exact placements out of three with the exact collision oracle enabled.

All correct connector poses are available before placement:

| Part | Colour | Candidate poses | Exact target poses present |
| --- | ---: | ---: | ---: |
| 3010 | 15 | 356 | 2 |
| 2420 | 71 | 296 | 1 |
| 2420 | 71 | 296 | 1 |

For the first placed part (3010), changing only the camera in candidate scoring produces:

| Camera | Correct candidate rank | Correct score | Best candidate score | Correct pose collides? |
| --- | ---: | ---: | ---: | --- |
| Solver's estimated camera | 265 | -774 | 712 | No |
| Camera fitted to reference completed step | 1 | 2043 | 2043 | No |

The estimated camera has yaw 69.5°, pitch 16°, scale 0.981 and one upright cube orientation. The diagnostic camera has yaw 55°, pitch 32.5°, scale 1.135 and a different upright cube orientation. A small local re-registration around the selected wrong view cannot change that discrete orientation.

With that reference-fitted camera fixed, the existing placement beam recovers **3/3 exact new parts**, compared with **0/3** under its estimated camera, with the exact collision oracle enabled in both runs.

The reference-fitted camera is **not a production solution**. It demonstrates that camera selection can reverse candidate ranking while the correct connector pose is already available and collision-valid. The target change is a joint camera/placement search: retain diverse orientation hypotheses, place new parts under each, re-register the completed hypotheses and compare their image evidence. Avoid returning to training or enlarging connector coverage to address this particular failure first.

## Scoring regression: step 1 is not a placement failure

The existing `solver.evaluate.aligned()` derives a transform from an anchor's stored orientation matrix. It does not enumerate rotations that leave that anchor's geometry unchanged. The 3031 square plate permits a 90° equivalent frame; rotating the entire predicted first-step assembly in that frame makes both parts exact. The current alignment returns only one exact part.

`diagnostic_audit.seed_frame_transforms()` enumerates cube turns and accepts only transforms that preserve the seed's actual geometry. It is an evaluation-only helper, not an inference dependency. The source-derived fixture and regression test establish two exact parts for this example. A deliberately displaced part remains incorrect, so the helper does not simply forgive placement errors.

Fix alignment before interpreting first-failure statistics or fitting confidence from frame-free exactness labels. This audit does not claim a newly corrected score for the entire final model; the cached final score remains 2/89 under the existing scorer.

## Completion and confidence findings

`pipeline.run()` sets `failed_from` only when status is non-OK, a returned fit falls below 0.35, or fewer parts are placed than were read. Consequently, `incomplete_from: null` means no operational give-up; it does not establish a correct model. The exported MPD already labels itself experimental and flags uncertain parts.

There are concrete gaps beyond that semantic distinction:

- `step.solve()` takes `fit_iou` from `views[0][0]` before placement and returns it even after selecting/re-registering another view. The step-2 replay reports IoU 0.8403 despite zero of three placements being exact. Rename or retain this as pre-placement evidence and measure completed-hypothesis fit separately.
- Repeats at printed steps 8 and 23 are recorded but do not trigger the completion marker, although the pipeline documents repeated-subassembly placement as unsupported. The source-only audit flags the first such operation at step 8. Unresolved parts and empty reads also need explicit review/failure reasons instead of relying on the number of successfully identified parts alone.
- The written file has 65 flagged parts and 26 unflagged parts. Only one of the 26 is exact under the existing final-model scoring. These are the original written markers, not a threshold chosen after observing this example.
- Two saved confidence values lie outside [0, 1]. The current default loader has no `solver/confidence_model.json` installed and therefore uses its margin heuristic. The historical run did not save a confidence-model hash, so its exact calibration provenance cannot be established from its report.

Recommended contract: report operational failure, unsupported construction features and review-required uncertainty separately; never equate a successful search with verified correctness. Persist the confidence model/version/hash and threshold. Clamp or reject invalid identity confidence inputs, and calibrate on complete training/validation rollouts rather than assuming teacher-forced confidence transfers to an accumulating free run. This audit does not select new confidence thresholds on the scored example.

## Reproduce

From the repository root:

```sh
python/.venv/bin/python scripts/audit_booklet_solver_failure.py --set 41488
python/.venv/bin/python scripts/audit_booklet_solver_failure.py --set 41488 --replay-step
python/.venv/bin/python -m pytest -q python/tests/test_booklet_mpd_diagnostic_audit.py
```

The first command reads the cached free-run MPD/report, snapshots them if no snapshot exists, checks symmetry-aware prefixes and correct-pose candidate coverage, and writes source-only completion evidence. `--replay-step` additionally uses reference previous parts/identities and a reference-completed-step camera for controlled diagnostics. It must remain outside the production inference path. It neither downloads new sources nor overwrites solver benchmark results. Existing audit snapshots are retained unless `--refresh-snapshot` is explicitly supplied.

Artifacts:

- `.cache/booklet-mpd/independent-diagnostics/41488/audit.json`: complete diagnostic evidence, source hashes and camera replay results.
- `.cache/booklet-mpd/independent-diagnostics/41488/snapshots/`: original completed benchmark JSON/MPD.
- `benchmarks/booklet-mpd/41488-anchor-symmetry-regression.json`: two-part frame regression.
- `benchmarks/booklet-mpd/41488-camera-selection-regression.json`: source image hash, reference matrices and fixed-camera ranking regression.
- `python/tests/test_booklet_mpd_diagnostic_audit.py`: six passing tests, including real source-derived geometry checks.
