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
original MLCad file, into `samples/`). The sha256 check makes sure the same
file is scored every time. LDraw part data (`npm run setup`, `npm run setup:shadow`)
is also needed; without it the benchmark is skipped.

Check results: `hit`, `wrong-motion` (right axis, wrong kind of motion),
`rejected` (detector considered and refused it), `missing`, and `unresolved`
(the benchmark file itself is wrong; this fails the run).
