# Candidate generation v2: connector coverage and image-first anchors (proposal, for review before it is built)

## Why (measured)

Gate 1 on synthetic shard-000 (200 steps, 639 visible true parts; `coordnet/bench_shortlist.py`). The candidate
generator (`booklet_mpd/solver/candidates.py` + `technic.py`) never produces **144 true poses**. Each was
classified by re-checking the final model (scratchpad scripts `diag_legal.py`, `diag_tech.py`, `diag_tech2.py`,
`diag3.py`):

| Cause | Poses | Detail |
|---|---|---|
| No stud/clip edge in the final model, sits on a part with no catalogue data | 67 | Hosts: 3706/3705 axles (27), 32123b/3713 bushes (19), 2780/6558/3673 pins (31), 59443 axle connector (7)... i.e. a part threaded onto Technic |
| No stud/clip edge, all neighbours catalogued | 30 | 50 of these 97 have a coaxial Technic M/F snap pair in the final model, but `technic_candidates` misses them: true slides along the axis are −7, 18.8, 25.4, −29, −34, 38 LDU (the grid is −20..20 step 10), and 9 hit `MAX_PER_PART` = 6000 |
| The part itself has no catalogue data | 33 | 4592c01, 30028, 61409, 2494, 3854, 30648, 30391, 73092, 2857, 4106329a... (several also have no LDCad snaps) |
| Real generator gaps | 13 | 30027b, 48336, 4489a, 6020... |
| 45 deg turn | 1 | |

So about two-thirds is Technic, where the slide along the axle is **continuous**. Enumerating slides cannot
cover it (and already overflows the cap). The picture fixes it.

## Proposal

### A. Axis-line candidates (Technic): an enumerated family, the slide read from the picture

`technic_candidates` keeps the discrete part (which snap pair, flip, quarter turn about the axis), but emits one
**line family** per (my snap, host snap, flip, turn) instead of 5 slides: pose(s) = R, t0 + s·axis with
s ∈ [s_lo, s_hi]. The range is where the two snap segments overlap; it is computed from the LDCad snap lengths,
not fixed at ±20. Families from round pins (not axle-shaped on either side) also get the turn as free, sampled every
22.5 deg.

Resolving s:
- **Gate-1 legality** (the bench): the true pose is legal when it lies on a family (same R; t − t0 parallel to the
  axis, within range).
- **Placement:** each family projects to a 2D segment of sites (the box centre moving along the axis). The
  centre-vote shortlist (`shortlist.py`) gets a segment instead of a point. The vote is the max over the segment
  (the closest point to each predicted centre), and the kept s is that closest point, snapped to 1 LDU. The joint
  search then scores a few s around it (±2 LDU) by the picture as usual.

### B. Connectors read from the LDraw geometry, where the catalogue has none

For a part (host or new) with `catalog().connectors(p) is None`, derive connectors from the stud primitives in
its LDraw file (recursive type-1 references with their matrices): `stud.dat`, `stud2.dat`/`stud2a.dat` (open),
`stud10`/`stud15`... (stud), `stud3.dat` (1-wide underside: hole), `stud4.dat`/`stud4a.dat` (tube),
`stud6`/`stud6a` (open)... The frame convention is checked against the catalogue on parts that have both (3001,
3020, 3062b, 4073...) before use: same positions within 0.5 LDU, same mating axis. Checked already (read-only,
2026-11-14): `stud.dat`/`stud2a.dat` sit exactly at the catalogue's stud/open positions with the same axis
(3001, 3020, 3005, 3023, 3062b, 4073). The **underside does not come from primitives**: BrickNet's "hole"
connectors (one under each stud column, at the part's bottom face, y = 8 or 24) have no primitive; `stud4.dat`
tubes sit at y = 3 with the axis flipped while the catalogue puts tubes at the bottom face; tiles (3069b) have no
stud primitives at all. So holes and tubes are inferred at the bottom face of the part's box, under the stud and
tube columns, and checked against the catalogue the same way. A part with LDCad technic snaps
only stays Technic (A). A part with neither gets nothing (as now) and is reported.

### C. Fixes in the discrete generator

- The 13 "generator gaps" are looked at one by one before any change (expected: greedy pairing in
  `build_graph`, which consumes a connector into the closest pair and can then reject the true one; and offsets
  such as jumpers).
- The 45 deg case is left (one pose).

### D. Image-first anchors (MEPNet-style), for parts the generator still misses

With the camera solved, a new part's pixels (the new mask, or the PlaceNet heatmap) give rays. The part's
contact plane is on the model so far (the depth at the mask's border, or the top of the base's stud lattice
under the mask). Intersect the rays with that plane, then snap to the lattice (20 LDU, 8 LDU vertical; half-stud
for jumpers). Score the anchor's yaws like any candidate. This is a fallback source of candidates: connectivity
filters it (it must touch the model and not collide), it does not replace the connection candidates. It covers
parts resting on a new part, uncatalogued parts and anything else the connectors miss.

## Acceptance (gate 1, synthetic shard-000, same 200 steps)

- Not legal: 144 → ≤ 20 (A+B+C), and every remaining one listed with its cause.
- Recall with answer-key offsets stays ≥ 0.89. Kept share and seconds per step are reported (a line family costs
  one projected segment, not 5 points).
- 21065 gate 1 stays 25/25.
- D is measured separately: share of the ≤ 20 remaining that an image-first anchor recovers, with answer-key
  masks.

## Tests before code

- Line family contains a true pose whose slide is off the old grid (synthetic beam + axle, s = 18.8); the
  discrete part of the family is unchanged for an on-grid pin.
- Segment vote: a centre predicted near the middle of the projected segment picks the right s within 1 LDU.
- Primitive connectors equal the catalogue's on 3001/3020/3062b (positions, axes, subtypes).
- A brick on an uncatalogued host (built from primitives) becomes legal.
- Image-first anchor: on a synthetic step, with the true mask, the true pose is among the anchors.

## Risks

- Segment sites widen the shortlist (each family covers many sites). Mitigation: vote max-over-segment, keep top
  sites as now.
- The primitive list is incomplete (new primitive names, printed parts). The catalogue cross-check catches the
  convention; unknown primitives are counted.
- D can propose floating poses where the contact-plane guess is wrong. Connectivity and collision filters stay.
