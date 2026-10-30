# Real-model mechanism benchmarks

Each `<id>.expected.json` lists the mechanisms a real LEGO model actually has,
checked by hand, and what the detector should find for each one (turning
shafts, sliding racks, gear meshes, a ready-to-drive suggestion). Parts are
found by part number and position, so internal ids can change freely.

```
npm run bench:mechanisms                # print scores
BENCH_WRITE=1 npm run bench:mechanisms  # refresh <id>.results.json / .txt
```

The model files are not committed. Put them at the path named in
`model.file` (for 5590: copy `5590_-_whirl_n_wheel_super_truck.mpd`, the
original MLCad file, into `samples/`; for 42000: the LDraw OMR file
`42000-1 Grand Prix Racer.mpd`, CC BY 2.0, saved as `samples/42000-1.mpd`; for
8880: the LDraw OMR `8880-1.mpd`, saved as `samples/8880-1.mpd`). The sha256 check makes sure the same
file is scored every time. LDraw part data (`npm run setup`, `npm run setup:shadow`)
is also needed; without it the benchmark is skipped.

Check results: `hit`, `wrong-motion` (right axis, wrong kind of motion),
`rejected` (detector considered and refused it), `missing`, and `unresolved`
(the benchmark file itself is wrong; this fails the run).

Check types: `rotates` / `slides` (a joint on an axis), `gearMesh`,
`rackPinion`, `fourBar`, `suggested` (any suggestion drives the parts) and
`function`. A `function` check is the strictest: a suggestion named as one of
`kinds` must be driven at `driver`, and running it to both ends of its travel
must move every `moves` part (0.5 LDU or 1°) and leave every `stays` part put.

A mechanism may carry `phase` (default 3): the spec phase expected to find
it. Scores are also reported per phase, so a gearbox (phase 4) does not count
as a phase 3 miss.

## Results

Current scores are in `<id>.results.txt`. Phase 3 (classifier and
suggestions): 5590 17/17; 42000 phase 3 16/18. The two 42000 misses are
connector-data gaps, not loosened tolerances: the rear CV ball sits 5 LDU
from the hub socket (so the rear wheel does not reach the engine; the drive
train is driven at the axle), and the front pushrods are 6.8 LDU off their
balls. Rim 44772's pin holes, missing from the upstream LDCad shadow file,
come from a local patch (`src/ldraw/shadowPatches.ts`).

Phase 4 (gearbox modes): 8880 5/7 — both driving rings and their clutch
gears, neutral at rest, 1st 2.25:1 and 3rd 0.75:1 as in the manual. 2nd
(1.5:1) and 4th (0.5:1) are missed because of the model-file defect below;
with the missing axle supplied the mode table gives all four ratios (see
`tests/anim/gearbox/shiftModes.test.ts`). 8880 phase 3: 7/9. 42000 phase 4:
0/2 — the clutch gears are found, but the small linear actuators 92693c01 are
not yet recognised as screws, so the wing and covers do not move.

## Sources

- 5590: hand-checked against the posed model file (see each `why`).
- 42000: the functions curated by [Kinebrick](https://github.com/erik-larsen/kinebrick)
  in `data/sets/42000-1.json` (commit 516e176), CC BY-SA 4.0, which cite the
  set's instruction books; resolved here to part positions.
- 8880: LDraw OMR `8880-1.mpd` (Orion Pobursky, CC BY 2.0,
  <https://library.ldraw.org/omr/sets/908>). Gear ratios from
  [Kinebrick](https://github.com/erik-larsen/kinebrick)'s
  `tests/sets/8880-super-car.test.ts` (CC BY-SA 4.0), used as an oracle.
  The ratios are measured from the gearbox input gear `4019@[20,-54,390]`,
  which the crank drives 1:1 through a chain (chains are phase 6).
  **Model-file defect:** the 8T gear `3647` at [-60,-14,-70] has no axle, so
  2nd and 4th never reach the wheels; adding an Axle 8 (`3707`) centred at
  (-60,-14,0) along z fixes it.
