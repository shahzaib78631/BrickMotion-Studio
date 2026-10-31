# Snap Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dragged pieces sit under the mouse, snapped onto the nearest connection on any visible piece, with the grip chosen by where the piece lands, and the connection shown as rings.

**Architecture:** The viewport passes the mouse ray (model LDraw frame) instead of a hit point. A pure `aim.ts` ranks free targets by angle from the ray with an occlusion check. `findPose` tries (target × grip) poses and scores each by how far the posed reference point lands from the ray; collision is checked in score order. The placing session holds the reference point and an optional grip lock; the viewport draws rings at the pose's links.

**Tech Stack:** TypeScript, three.js, zustand, vitest.

**Spec:** docs/superpowers/specs/2026-10-31-snap-rebuild-design.md

## Global Constraints

- `PICK_RADIUS` = 24 LDU; `OCCLUDE_SLACK` = 6 LDU; facing test dot(axis, -dir) > -0.05; `MAX_TARGETS` = 6; `MAX_GRIPS` = 16.
- Reference point: grab point for moves; centre of the part's underside (box centre x/z, box max y in LDraw) for new parts.
- Score = perpendicular distance of the posed reference point from the ray ÷ its depth along the ray; ties: more mated wins.
- Hysteresis: keep the previous pose while its target is still a candidate and its score ≤ best + `HYSTERESIS_ANGLE`, where `HYSTERESIS_ANGLE` = 4 LDU ÷ (previous target's depth along the ray).
- Single-part pose search < 8 ms on the 848-part test model.
- Engine stays pure (no camera/DOM in `src/plan`). Units LDU, Y down.
- Unchanged: collision world, `studPokesIn`, solid drawn floor, guard, clipboard, box select, gesture/outside-change handling.

## Review Focus

1. **Pieces shown at a submodel bay or model spot.** The ray maps through the hit piece's display placement (root when none); a candidate on a piece in a different bay must not be picked from the wrong frame. Task 4 test `maps the ray through the hit piece's placement`.
2. **A camera looking almost along a face (grazing).** Side studs seen edge-on still count (facing > -0.05); studs on the far side do not. Task 1 test `drops connectors facing away and ones behind the hit surface`.
3. **A moving set whose only connectors are studs (a tile-less plate hung under something).** Grips of gender M seat on F targets. Task 2 test `hangs a plate under a plate by its studs`.
4. **A whole submodel being dragged.** Grip count is capped (16) and collision runs in score order, stopping at the first clean pose. Task 6 perf probe.
5. **Symmetric parts with equal-score poses.** Hysteresis must hold the shown pose. Task 2 test `holds the pose when two are equally near`.

---

### Task 1: Aim — candidates near the ray

**Files:**
- Create: `src/plan/aim.ts`
- Test: `tests/plan/aim.test.ts`

**Interfaces:**
- Produces: `type Ray = { origin: Vec3; dir: Vec3 }` (dir unit, LDU, model frame); `type Aim = { ray: Ray; hitDepth: number | null; floorPoint: Vec3 | null }`; `rayAngle(ray: Ray, p: Vec3): number` (perpendicular distance ÷ depth; Infinity when depth ≤ 0); `rayDepth(ray: Ray, p: Vec3): number`; `candidates(targets: readonly Target[], aim: Aim, max?: number): Target[]` (ranked, nearest angle first); constants `PICK_RADIUS = 24`, `OCCLUDE_SLACK = 6`, `MAX_TARGETS = 6`.

- [ ] **Step 1: Write the failing tests** (synthetic targets, ray straight down from (0,-500,0), dir (0,1,0)):
  - `ranks targets by how near the ray they are`: targets at x = 30, 5, 15 (y 0, axis (0,-1,0)) → order 5, 15; the one at 30 is out (> 24).
  - `drops connectors facing away and ones behind the hit surface`: a stud with axis (0,1,0) at x 0 is dropped; with hitDepth 500 a stud at depth 520 is dropped, one at 504 is kept; a side stud with axis (1,0,0) is kept.
  - `keeps at most MAX_TARGETS`: 10 targets within radius → 6 returned.
  - `rayAngle is distance over depth`: point (10, 0, 0) → 10/500.
- [ ] **Step 2: Run** `npx vitest run tests/plan/aim.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `aim.ts` with the signatures above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(plan): aim candidates by the mouse ray`.

### Task 2: Pose search scored by where the piece lands

**Files:**
- Modify: `src/plan/placementEngine.ts` (`PoseQuery`, `Pose`, `findPose`, `floorPose`; remove `SEARCH_RADIUS`, owner filter and the other-socket fallback; keep `seat`, `freeTargets`, `targetIndex`, `studPokesIn`, `boxOf`, floor rule)
- Test: `tests/plan/placementEngine.test.ts` (rewrite queries to the new input; keep each test's intent), `tests/plan/freeTargetsScale.test.ts` (new input)

**Interfaces:**
- Consumes: Task 1 `Aim`, `candidates`, `rayAngle`, `rayDepth`.
- Produces: `PoseQuery = { moving: { solids: Solid[]; connectors: Connector[] }; targets: Target[]; aim: Aim; ref: Vec3; lock: number | null; yaw: Quarter; world: CollisionWorld | null; before: ReadonlySet<string>; prev: Pose | null; floor?: number }`.
  `Pose = { delta: number[]; mated: number; owners: string[]; valid: boolean; handle: number; yaw: Quarter; at: Vec3 | null; links: { pos: Vec3; axis: Vec3 }[]; score: number }` (`links` = the mated target connectors; `handle` = grip used, -1 on the floor). Export `MAX_GRIPS = 16`.
  Grips: `lock !== null` → only that connector; else connectors of the opposite gender to the target, nearest `ref` first, capped at `MAX_GRIPS`.

- [ ] **Step 1: Write the failing tests** (real parts, `measureReal`; helper `aimAt(p: Vec3, from?: Vec3)` = ray from `from` (default p + (0,-400,0)) toward p, hitDepth = distance):
  - `seats a 2x4 brick on all 8 studs of a 2x4 plate` (new ref = brick underside centre; aim at the plate centre) → mated 8.
  - `slides a 1x2 brick along a 1x2 plate's row as the mouse moves` (3004 on 3023: aim x = 0 → brick centre 0, mated 2; aim x = -10 → centre -10 (centre socket? only if the part has one; for 3004 the nearest valid: centre -10 is not a pose → expect centre 0 or -20, whichever is nearer -10: assert |centre - (-10)| ≤ 10 and mated ≥ 1); aim x = -22 → centre -20, mated 1.
  - `puts a 22885 on one top stud of another, either side` (aim at x = -20 → centre -20, mated 1; aim x = +20 → centre 20).
  - `second 22885 beside the first, each on one stud` (first fixed at centre -20; aim x = 20 → valid, centre 20).
  - `mounts a 22885 flat on side studs` (aim at the side face centre from the front, ray along +z) → mated 2.
  - `never leaves a side stud cutting into the wall` (keep, new input).
  - `holds still on the seam between two plates` (two 3020 side by side; aims at x = 38 then 42 with prev) → same pose.
  - `holds the pose when two are equally near` (1x1 plate on 2x2 plate, aim exactly between two studs, prev = left) → left kept.
  - `hangs a plate under a plate by its studs` (moving 3023, target = underside sockets of a fixed 3020, ray from below) → valid, mated 2.
  - `a locked grip is the only one used` (lock = index of 3004's right socket, aim at a 3023 left stud → centre -20).
  - Keep: floor fallback (aim with floorPoint, no candidates), drawn floor, empty moving set invalid, rotates in hand, hysteresis-free floor alignment.
- [ ] **Step 2: Run** `npx vitest run tests/plan/placementEngine.test.ts tests/plan/freeTargetsScale.test.ts` — Expected: FAIL (new fields).
- [ ] **Step 3: Implement** the new `findPose`:
  ```
  cands = candidates(targets, aim)           // none → floorPose(aim.floorPoint)
  for t in cands, for g in grips(t): m = seat(g, t, yaw); score = rayAngle(ray, m·ref)
  sort by score, then mated desc
  hysteresis: prev valid, prev.at among cands, prev.score' (recomputed) ≤ best + 4/rayDepth(prev.at) → prev
  first unblocked in order → valid pose; none → best, valid false
  ```
- [ ] **Step 4: Run** — Expected: PASS; also `npx vitest run tests/plan` green.
- [ ] **Step 5: Commit** `feat(plan): poses scored by where the piece lands under the mouse`.

### Task 3: Placing session on the new input

**Files:**
- Modify: `src/state/placing.ts` (`updatePlacing(aim: Aim)`, session `ref`, `lock`; `cycleHandle` → lock cycling with Auto), `src/state/editing.ts` (`placeClip` floor placement passes an `Aim` with only `floorPoint`)
- Test: `tests/state/placing.test.ts`

**Interfaces:**
- Consumes: Task 2 `PoseQuery`, `Pose`; Task 1 `Aim`.
- Produces: `updatePlacing(aim: Aim): Pose | null`; `PlacingState = { source; ids; pose; lock: number | null; yaw }`; `cycleHandle(dir)` steps lock null → 0 → … → n-1 → null; `beginPlacing(src, grab?)` sets `ref` = grab ?? underside centre of the moving set.

- [ ] **Step 1: Rewrite tests** to call `updatePlacing({ ray, hitDepth, floorPoint })` (helper `aimDown(p)`); add `cycles the grip lock through Auto` (null → 0 → … → null) and `a new part's reference is its underside centre`.
- [ ] **Step 2: Run** `npx vitest run tests/state/placing.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/state tests/plan` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(placing): session follows the mouse ray`.

### Task 4: Viewport passes the ray

**Files:**
- Modify: `src/ui/Viewport.tsx` (`placingHit` → `placingAim(ev, skip): Aim | null`, all four callers), `src/ui/modelPlacement.ts` (add `placingRayOf`)
- Test: `tests/ui/placingPoint.test.ts`

**Interfaces:**
- Produces: `placingRayOf(origin: THREE.Vector3, dir: THREE.Vector3, key: string | null, placements, root): Ray` — maps a view-space ray to the model LDraw frame through the hit piece's placement (root when none); dir re-normalised.
- `placingAim`: ray from the camera through the cursor; `hitDepth` = distance from the mapped origin to the mapped hit point (null when nothing is hit); `floorPoint` = the mapped ray ∩ drawn floor (session floor).

- [ ] **Step 1: Write the failing test** `maps the ray through the hit piece's placement` (root spot transform and a bay; a ray built in view space toward a known model point maps to a model ray whose rayAngle to that point is < 1e-6).
- [ ] **Step 2: Run** `npx vitest run tests/ui/placingPoint.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, replace the four `placingHit` call sites (pointer move, drag, palette dragover, follow-mouse paste).
- [ ] **Step 4: Run** `npx vitest run tests/ui && npx tsc --noEmit -p .` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(viewport): placement follows the mouse ray`.

### Task 5: Rings on the connections

**Files:**
- Create: `src/render/linkRings.ts`
- Modify: `src/ui/Viewport.tsx` (show rings for `usePlacing` pose links when valid; clear otherwise)
- Test: `tests/render/linkRings.test.ts`

**Interfaces:**
- Produces: `class LinkRings { constructor(scene: THREE.Object3D); show(links: { pos: Vec3; axis: Vec3 }[], toView: THREE.Matrix4): void; clear(): void; dispose(): void }` — one torus (radius 7 LDU → 0.35 view units, tube 0.06) per link, facing the link axis, accent colour, `depthTest: false`, renderOrder high.

- [ ] **Step 1: Write the failing test** `places one ring per link facing its axis` (2 links → 2 visible children at the mapped positions; `clear()` → none visible).
- [ ] **Step 2: Run** `npx vitest run tests/render/linkRings.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; wire into Viewport (toView = LDU→view with the session's root placement).
- [ ] **Step 4: Run** the test and `npx tsc --noEmit -p .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(viewport): rings show what will connect`.

### Task 6: Bench, speed and browser check

**Files:**
- Modify: none expected (fixes go in the owning file with a test)

- [ ] **Step 1:** Node probe on `public/data/test-10001.mpd` (real parts): single 3001 pose search median and p90 < 8 ms; whole-submodel drag p90 recorded. Probe file under `.superpowers/tmp/`, deleted after.
- [ ] **Step 2:** Browser check on the dev server: the user's 22885 cases (one stud each side, sideways on side studs) by scripted pointer drags; rings visible; no console errors.
- [ ] **Step 3:** `npx vitest run` — only the pre-existing `minifigInsertion` failure; `npx tsc --noEmit -p .` clean.
- [ ] **Step 4: Commit** any fixes with their tests.
