# Native assembly motion: order, flights and what is certified (design)

Date: 2026-11-18. Extends §5 (planner and timeline) of docs/superpowers/specs/2026-11-15-native-rewrite-design.md.

## Why

The owner played samples/helicopter/helicopter.mpd in bmview --play and found it worse than the web app:
the rotor (steps 17-22) is built first and the body built downward under it; pieces fly through
pieces already placed; flights go under the ground. Causes (diagnosed and confirmed by the advisor):

1. **Order.** sequence.cpp takeApart removes single pieces first, and tries units (authored
   submodels, rigid bodies, grown) only when no single piece in the whole model can leave. A unit
   of the latest step that must come off together (the rotor hub with the plates clipped under it)
   is postponed until the whole body has been taken apart around it. The file's step is only a
   tie-break, ranked below "same submodel as the last piece removed". 103 of 281 helicopter moves
   go in upward.
2. **Flights.** timeline.cpp buildTimeline flies staging -> up -> across -> straight down to the start
   of the planner's path -> the path. Only the path is checked. The drop goes through whatever is
   built in that column; extract.cpp has no floor, so paths start under the ground.
3. **Verification.** The certificate covers planner paths, never the motion bmview and bmexport play,
   so "crossings 0" said nothing about what the owner saw.

## Decisions (the owner's)

- Native, from the model's own geometry and steps. **The web app is not a base and nothing is ported
  from it.** It is at most a yardstick.
- **What is played is certified.** Every flight as played (every leg, every rounded corner) is swept
  against what is built at that moment and against the floor. That is the headline number.
- **The floor is solid.** After leaving its seat, no flight takes a piece below the model's base.
- **The file's steps lead the order.** Taking apart works from the latest step that still has pieces:
  that step's single pieces, then its units. An earlier step's piece is taken only when nothing of
  the latest step can leave, and each such case is counted as a step inversion. Within a step, pieces
  that go in from above come first. An authored submodel is one unit, attached at the step that
  places it.
- **Motion is continuous.** One speed curve per flight. No stop at every corner; it slows only for
  the final insertion.
- **Gates.** `bm plan` and `bm audit` report, per model:
  - played crossings;
  - played moves under the floor;
  - moves inserted upward;
  - step inversions.

  A helicopter test pins:
  - the base first;
  - the rotor near the end;
  - the underside as one move;
  - zero played crossings and nothing under the floor.

  No corpus measure may get worse than before without a recorded reason.
