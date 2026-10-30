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
`42000-1 Grand Prix Racer.mpd`, CC BY 2.0, saved as `samples/42000-1.mpd`). The sha256 check makes sure the same
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

## Sources

- 5590: hand-checked against the posed model file (see each `why`).
- 42000: the functions curated by [Kinebrick](https://github.com/erik-larsen/kinebrick)
  in `data/sets/42000-1.json` (commit 516e176), CC BY-SA 4.0, which cite the
  set's instruction books; resolved here to part positions.
