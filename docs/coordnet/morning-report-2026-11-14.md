# Morning report — 14 Nov 2026

## What works now

**A camera for real booklet pages that needs no network and no colours.** CoordNet only knows our own render
style. On BrickHeadz 40348 it was confident on under 1% of the picture, so 30 of 41 pages got no camera at all.
The new line fit (`python/coordnet/linefit.py`) reads the camera straight off the page's drawn lines:

1. **View angle.** It compares the directions of the page's lines with the directions of the model's LDraw edges.
   That gives yaw (up to a quarter turn) and pitch in a few seconds. It found that BrickHeadz is drawn at yaw 145,
   not the standard 35, which is why the earlier search never found a camera.
2. **Position.** It tries the 8 possible views (four quarter turns, upright or turned) and searches the
   translation on the page.
3. **Exact fit.** It refines each candidate by matching the model's lines to the page's lines.
4. **Verification, as before.** A separate check looks at the tile shift and line distances, now measured in the
   booklet's own pixels. A page is dropped when two different views both pass and would label the new parts
   differently.

**Result on 40348: 15 of 41 pages kept, up from 6.** On the pages it fits, the line-fit camera is within
0.32–0.53 px of the page in the booklet's own pixels.

**Commits:** 59f0619 (line-fit camera) and f7ba24a (review fixes), on feat/booklet-mpd-phase1. All 135 coordnet
tests pass.

**Reviews:**
- Codex found 5 issues. The serious ones: a wrong section camera could be chained without being compared with
  the global search, the distance clip could make the p90 check vacuous on small pictures, and the yaw search
  assumed a quarter-turn symmetry. All 5 are fixed, each with a test.
- Big Pickle found that a half-turned view can swap two identical parts (eyes, ears) without changing the new-part
  outline. Ambiguity is now judged part by part. It also flagged that the eye was freed and that the scale
  tolerance was 5% instead of 3%; both are fixed. Roll above 4° is not supported. That is a deliberate ruling:
  booklet pages have almost no roll (21065: 0.24°).

## Why the other 26 pages are dropped (40348)

| Reason | Pages | What it means |
|---|---|---|
| New parts not verified | 11 | The camera is good, but the new parts' lines fail the check (p90 4–6.6), a part is hidden or unchanged, or a part is "not drawn" |
| Camera: no fit passes | 6 (17, 22–26) | The best fit is within 0.3–0.4 px, but line p90 is 4.1–5.5 native px against a limit of 4. The booklet artwork differs locally from the model (stickers, eyes) |
| Sub-build pictures | 8 (34–41) | The page shows a separate sub-build (the stand, the cake table), but the answer key gives the whole 114-part figure. This is a dataset/layout problem, not a camera problem |
| No base | 1 | Step 1 |

## Not yet good

- **Speed.** It takes about 5.6 minutes a page (3.9 h for 40348): every view is refined and checked with a full
  render. Ways to cut it: drop weak fits before rendering, cache the scene, stop refining once it converges.
- **Sets 42079 and 41620** are labelling now. Their numbers will be added when they finish.
- **Placement is unchanged.** PlaceNet's centre offsets are still imprecise (median 7.8 px; about 3 px is needed).
  The candidate generator misses 144 of 639 true poses on synthetic steps.

## What DeepSeek's research says to do next (ranked)

The full report is in the session scratchpad (`research-deepseek.md`). Highlights, with evidence:

1. **Repair the candidate generator** against the list of 144 missing poses. These include plain bricks (3004,
   3005, 3622), not only Technic parts. Fall back to connection geometry read from the LDraw part itself, and
   stop greedy pairing from using up connectors. Highest certainty, no new dependencies.
2. **Image-first lattice anchors**, MEPNet's core idea (Wang et al. 2022). With the camera solved, the new part's
   pixels are rays: project them onto the stud lattice, and use connectivity only to filter. This also handles
   parts that rest on another new part.
3. **A joint discrete solve** (exact cover / MILP with support and non-overlap constraints) to settle symmetric
   twins.
4. **A centre-heatmap head** (CenterNet) instead of the per-pixel offset regression, only after 1–3.
5. **A one-day test of RoMa/LoFTR foundation matching** between page and render, to decide whether it can replace
   CoordNet's role.
6. **Sub-build panel parsing.** This is what steps 34–41 above need.

The line-direction camera was DeepSeek's "geometry instead of appearance" lead. Its stud-ellipse idea is a further
cue for pitch that hasn't been tried yet.

## Suggested next steps

1. Sub-build cases (34–41): give each picture the sub-model's parts. This is cheap and unlocks 8 pages.
2. Speed up the line fit so all three sets can be labelled in an evening.
3. Candidate generator repair (research item 1).
