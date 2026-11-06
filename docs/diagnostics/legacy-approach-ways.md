# Legacy planner: connector approach ways (2026-11-06)

The default ("legacy") build planner (`src/anim/timeline.ts`) picks how each piece comes in
from the connectors it makes with its neighbours, and treats the final seat along such a
connector as a joint contact rather than a collision. Three faults made pieces pass through
each other, or left them with no connector way at all.

## 1. A round stud never mated a square socket

LDCad gives the underside of 1-wide plates and tiles (3024, 3023, 3069b, …) a square socket.
`snapMates.fits` only let square plugs into square sockets, so these plates had no connector
mate with the plate under them ("no mate" in the baseline). The placement engine already
accepted this pair (`isStudSnap`). Now a plain round stud (radius 6, at most 8 long) also
seats in a stud-sized square socket.

## 2. Connector ways had no side

The seat allowance applied along a connector axis in **both** directions. A bracket whose
studs go up into a 2x4 plate that is already built (Hellboy, 99780 under 3020) was dropped
from above, straight through the plate, and still certified.

`entryWays` (`snapMates.ts`) now gives each way a side, taken from the socket: a female's
sections run from its mouth into its part, so a male goes in from the mouth side and a moving
female comes onto the male the other way. Two-way: a socket that runs right through its part
(a Technic hole), clips, tyres and balls. LDCad's own axis direction for a male is not used:
it is not consistent for pins (4274's runs from its inserted end).

## 3. Hinge halves slid along the pin

Two hinge halves (finger snaps) also gave the pin axis as a way in, with the seat allowance.
Their fingers interleave, so the 6134 hinge top slid along the 3937 base's pin through its
fingers. Finger pairs now give no axial way. `hingeClipWays` gives the way a half clips on
from the side: straight away from the pin, on the side away from the other half's body (its
open side). The seat allowance applies along it for that one neighbour; the rest of the route
is still checked.

The first version took the side from the moving half's own body centre. A 2x2 hinge plate
(6134) sticks out sideways from its pin, so that pointed along the plate, partly downward:
every Hellboy hinge top got a clip way from below, which the planner rejected, and two of them
then dropped straight down through the 3937 base's fingers (the hinge pocket allowance let that
pass). The moving half's own centre is now only used when the other half is centred on the pin.

`PLANNER_VERSION` is 10, so projects saved by earlier versions are planned again on open.

## Hellboy (2) (3).brickmotion

| | uncertified pieces |
| --- | ---: |
| saved timeline (version 8) | 3 |
| version 9, as saved | 6 |
| version 9, 2x4 plate (i16) not forced | 0 |

16 of the 153 pieces are set to **Force** (build in the set order; "pieces may pass through
each other"), including the 2x4 plate. Forced, the plate goes on before the bracket whose
studs go up into it, so no clean route exists for the bracket and it is now reported as
uncertified instead of being certified through the plate. With the plate released, the
dependency graph puts the bracket first and every piece certifies.

All four 6134 hinge tops now clip on from the base's open side (`[0, 0, -51.8]` twice,
`[±52.2, 0, 0]`); the user's (ngk93nc) was a slide along the pin (`[0, 0, -84]`).

Tools: `tests/diagnostics/flightOracle.ts` samples every flight of a timeline against the
pieces already resting, with the placement collision world. It is conservative for hollow
parts (a plate's underside and the gaps between hinge fingers count as solid), so a hit
within ~10 LDU of the seat is a lead, not proof. `tests/diagnostics/loadRealPlan.ts` loads a
plan (e.g. from a project file) with the real library.
