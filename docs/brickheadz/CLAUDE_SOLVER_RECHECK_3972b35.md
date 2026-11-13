# Independent recheck of the camera fix

Reviewed commit `3972b35` and the concurrent working-copy changes in `solver/step.py` and `solver/register.py`. The working copy requests diverse registrations before truncating to three orientations, addressing a gap in the commit where six refined registrations could belong to fewer distinct orientations.

## Confirmed changes

- Symmetry-aware alignment now recognizes the equivalent first-step assembly.
- Unsupported repeats affect the exported incomplete marker; review reasons are reported separately.
- Pre-placement IoU is labelled `pre_fit_iou` rather than presented as completed-model fit.
- Identity confidence is clamped to [0, 1], and reports identify the confidence model or unfitted heuristic.
- Camera hypotheses are compared using completed-step image evidence.

The fresh focused suite passes **18 tests**, with the longer existing 40349 end-to-end test deliberately deselected. The real 41488 source-derived symmetry and reference-camera diagnostic tests are included.

## Remaining failure

Replaying step 2 with correct previous geometry and correct new-part identities still yields **0/3 exact placements**, using the exact collision oracle. The solver reports `ok` and three completed scores: 1.0855658, 1.0508353 and 1.0947717.

Instrumentation shows three diverse orientations were tried: **2, 20 and 0**. The reference-completed-step camera from the earlier successful diagnostic uses orientation **22**, which was not retained. Thus carrying multiple hypotheses is implemented, but the three-orientation pre-placement shortlist still excludes the useful orientation in this frame. This is a search-coverage issue; the correct connector candidates already exist. Trying all four upright orientations is an appropriate next ablation, not an established fix.

The diagnostic script supports that ablation without editing production code:

```sh
python/.venv/bin/python scripts/recheck_41488_camera_fix.py --step2-only --hypotheses 4
```

The actual PDF/parts-reader rollout through the first two steps yields **2/5 exact parts**, with all five parts read and placed. The first step contributes the two correct parts; the three second-step placements remain wrong. Both rows report `ok`, and no operational/unsupported/review marker appears in this two-step prefix. This illustrates the remaining difference between successful execution and correct reconstruction.

The tested solver source hashes and Git HEAD stayed unchanged throughout the replay. The default command additionally performs this two-step PDF rollout. Results and source hashes are under `.cache/booklet-mpd/independent-diagnostics/41488/camera-fix-recheck/`.

## Geometry interruption during verification

The installed `public/ldraw/parts` and `public/ldraw/p` trees lost core geometry while the first checks were running. Those earlier failures were discarded as invalid for solver comparison. Missing files were recovered from the intact `.cache/parts-stage/ldraw` library; existing files were not overwritten. Verification found all **37,151 staged DAT files present** before the valid rerun.

A bug consistent with this loss exists in `scripts/update-parts.ts`: a snapshot unpacks to `.cache/parts-stage/ldraw/`, but the script calls `apply(stage, dest, true, ...)` using `.cache/parts-stage`. `apply()` expects direct `parts/` and `p/` children and prunes destination DAT files absent from its `seen` set. A nested archive can therefore produce an empty set and prune the installed geometry. Resolve the actual library root and refuse pruning for an empty/invalid source before running another update. This audit does not establish which process invoked that updater.

The replay uses the installed `node_modules/.bin/tsx` to launch the same `scripts/lab-oracle.ts`, avoiding an unrelated wait in `npm exec`. Production solver source files were not changed by this recheck.
