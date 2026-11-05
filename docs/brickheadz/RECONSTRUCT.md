# Reconstruct from instructions (Path A)

`python -m brickheadz reconstruct` assembles a model from a booklet. It has two
modes and never emits a silent wrong model.

## OMR mode (trusted)

When a verified OMR/parts MPD exists, geometry is exact and the booklet supplies
only the build order:

```sh
python -m brickheadz reconstruct \
  --omr .cache/aquaman/omr/aquaman-assembled.mpd \
  --out .cache/aquaman/reconstruct --name Aquaman
```

Writes `Aquaman.plan.json`, `Aquaman.mpd`, `reconstruct.json`, `reconstruct.md`.
`trusted: true`.

## Image mode (proposals, not trusted)

With no OMR, the step-image solver runs and **only placements above
`--min-confidence` are committed** to the MPD; the rest are listed for a human:

```sh
python -m brickheadz reconstruct --steps spec.json --out out/ --name Foo --min-confidence 0.6
```

`spec.json` is either a list of steps or an object pinning the camera:

```json
{ "cam": {"yaw": 30, "pitch": 25, "scale": 0.9, "ox": 40, "oy": 40},
  "steps": [{"image": "step1.png", "parts": [["3001", 4], ["3003", 1]]}] }
```

Writes `proposal.json` / `proposal.md` (per-piece status + confidence) and
`Foo.committed.mpd` / `Foo.committed.plan.json` containing only committed pieces.
`trusted: false`.

Statuses: `committed` (≥ threshold), `low_confidence` (below), `unplaced` (the
solver could not place it — e.g. a new part hidden behind another).

## Why this shape

The image solver is correct stage-by-stage but not yet accurate on full models
(same-colour instance confusion, mutual occlusion of new parts, greedy cascade —
see `INSTRUCTION_TO_MODEL.md`). Path A makes it *useful without lying*: exact
when we have an OMR, and an explicit, confidence-scored worklist when we do not.

## Related scripts

- `scripts/make_synthetic_spec.py` — build a `spec.json` + step images from an
  OMR, to test image mode end to end.
- `scripts/reconstruct_aquaman.py` — full-model synthetic benchmark vs the OMR.
