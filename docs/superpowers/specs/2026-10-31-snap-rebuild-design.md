# Snap rebuild: the piece goes where the mouse is

## Why

Studio-style placement (shipped in feat/studio-build-mode) works in simple cases but feels
buggy on real builds. Four patches in a row each fixed one case and broke another. The
user's cases with 22885 (1 x 2 x 1 2/3 with side studs) show the causes:

1. **Aiming is 3D, from one piece.** Candidates are the free studs of the single piece the
   mouse ray hits, ranked by 3D distance from the hit point. On side faces and around small
   studs the hit point is often nearer a different stud than the one under the cursor, and
   a stud on the next piece is never considered (seam flicker).
2. **Which socket holds the part is a hidden setting.** A palette part is always held by its
   first socket; Tab cycles a list the user cannot see. One-stud overhangs need the right
   socket, so they are guesswork.
3. **Automatic fallbacks pile up.** "Most studs wins", then "nearest wins", then "try another
   socket". Each heuristic picks for the user in a way that is right for one case only.
4. **Nothing shows what will connect.** The user sees the result, not the connection.

## Goal

Dragging a piece feels like BrickLink Studio: the piece sits under the mouse, snapped onto
the nearest connection, and moving the mouse a little to one side slides it along (one stud,
overhang left, overhang right, sideways on side studs) without keys. What will connect is
visible while dragging.

## Non-goals

- New connection types (pins, axles, clips). Studs and stud sockets only, as now.
- Changing collision, the guard on keyboard and gizmo edits, clipboard, box select,
  undo/gesture handling, or the outside-change cancel. Those stay as they are.
- Hinge/rotation tools.

## Anti-goals

- The piece jumping to a spot the user is not pointing at.
- The piece turning by itself in a way R cannot undo.
- A drag that hitches: one pose search must stay well inside a frame (target < 8 ms for a
  single part on the 848-part test model).

## Design

### Input: the mouse ray, not a hit point

The viewport hands the session the mouse ray in the editing model's LDraw frame
(origin, unit direction, LDU) and, when the ray hits a fixed piece, the depth of that hit
along the ray. The display-placement mapping (bays, model spot) applies to the ray exactly
as it does to points today.

### Candidates: connections near the cursor, on any visible piece

A free target connector is a candidate when all hold:
- it lies within `PICK_RADIUS` (= 24 LDU) of the ray, measured perpendicular to the ray;
- it is not behind the surface the ray hits: its depth along the ray is at most
  hit depth + `OCCLUDE_SLACK` (= 6 LDU) (no limit when the ray hits nothing);
- it faces the camera or is side-on: dot(axis, -ray direction) > -0.05.

Candidates are ranked by their angle from the ray (perpendicular distance / depth), so
"nearest on screen". Only the best `MAX_TARGETS` (= 6) are considered. Pieces at later steps
and hidden pieces are never candidates (unchanged).

### Poses: every socket of the face, scored by where the piece ends up

For each candidate target, the part may be held by any of its connectors of the opposite
gender whose axis can face the target (at most `MAX_GRIPS` = 16, nearest the reference
point first). Each (target, grip) gives a pose with the existing `seat` (axes opposed,
current R turn about the target axis).

Each pose is scored by how far the posed part's **reference point** lands from the ray
(angle, as above). The reference point is where the user grabbed the piece (moves), or
the centre of the part's underside (new parts from the palette, paste, clone). Lowest score
wins; poses that mate more studs win ties. So:
- mouse on a 1 x 2 plate's left stud: the brick centres there (half overhanging, through the
  1 x 2 brick's centre socket) and slides to fully on, or to a one-stud overhang, as the mouse
  moves along;
- a grabbed brick keeps the spot under the hand on the cursor.

Poses are checked for collision in score order; the first clean one is shown. If none is
clean, the best one is shown red and a release does nothing (unchanged).

Tab now **locks** the grip: Tab / Shift+Tab steps through the grips and pins one; Esc-free
return to automatic is Tab past the last grip ("Auto"). R / Shift+R turn as now.

### Hysteresis

The previous pose stays while its target is still a candidate and its score is within
`HYSTERESIS_ANGLE` of the best (equivalent to about 4 LDU at the target's depth).

### Floor

No candidate: the part stands on the drawn floor where the ray meets it, whole-stud
aligned (unchanged behaviour, now fed by the ray).

### Showing the connection

While a valid pose is shown, a small ring is drawn on each mated connection of that pose
(target stud colour: the app's accent). Nothing is drawn for floor poses or invalid poses.

## Constraints

- Engine stays pure: `findPose` takes plain data (ray, connectors, targets, collision world);
  no three.js camera or DOM inside.
- Units: LDraw LDU, Y down, as today.
- The existing placement tests keep passing where their meaning is unchanged; tests whose
  meaning changes (hit-point aiming, owner-only candidates, handle-only seating) are rewritten
  to the new input with the same intent.
- Regression bench, as tests on real parts: 22885 on 3020; two 22885s each on one top stud of a
  third; 22885 sideways on 22885 side studs (flat, and half off without cutting a stud); seam
  between two plates; a 2 x 4 brick fully onto a 2 x 4 plate.

## Left to the builder

Exact constants may move by a few LDU if the bench needs it (record the change). How the
ring is rendered (mesh or sprite) is the builder's call.

## Decisions made without the user (they skipped questions)

- Ray-based aiming with perpendicular distance and an occlusion slack, instead of projecting
  to pixels (keeps the engine camera-free).
- "Reference point under the cursor" decides the grip automatically; Tab becomes a lock.
- Rings on mated connections as the only new visual feedback.
