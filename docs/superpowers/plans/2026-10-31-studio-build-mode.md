# Studio-style Build Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make building in BrickMotion feel like BrickLink Studio. Parts snap to the connection under the mouse, pieces never end up inside each other, and copy / paste / clone and box select work.

**Architecture:** Three pure modules carry the logic, each unit-tested with real LDraw parts:
- `connectors.ts`: stud / socket connectors per part and per submodel.
- `collision.ts`: which pieces a moved set would newly overlap.
- `placementEngine.ts`: ray hit → best collision-free seated pose, with hysteresis.

The editing layer (`editing.ts`, a new `placing.ts` session store) routes every edit path through them. The viewport only gathers inputs (ray, hit, keys) and draws the ghost.

**Tech Stack:** TypeScript, React, three.js, zustand stores (`useStudio`, `useAppSettings`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-studio-build-mode-design.md`

## Global Constraints

- Work on a new branch `feat/studio-build-mode` cut from `main`, in a git worktree. The current branch `feat/timeline-motion-style` has unrelated uncommitted work, so do not touch it.
- No third-party editor code is copied (LeoCAD is GPL). Our own implementation is built on our LDCad shadow data.
- Units: LDU with Y down inside connector / collision / pose code. Plan `Grid` is studs (x, z) and plates (y up). World is studs, Y up, z flipped. Convert only through `LDU_TO_WORLD` / `WORLD_TO_LDU` (export them from `src/plan/gizmo.ts`).
- Every edit goes through `useStudio.getState().apply`. A drag gesture is one undo step (`beginGesture` / `endGesture`).
- This project ships stud ↔ anti-stud connections only. Other connection types keep plain moves, still collision-checked.
- Collision is **on by default**, toggled with **K** and a toolbar button, and persisted as `AppSettings.collision: boolean`.
- Overlap rule: an edit is refused only if it **adds** an overlapping pair involving a moved piece. Pairs that existed before are allowed to stay.
- Snap targets: only pieces visible at `currentStep` (all pieces when `currentStep` is null), minus hidden pieces. Collision is checked against **every** piece in the model.
- A moved piece that ends up mated to a later-step piece moves to that step in the same undo step. New and pasted pieces go into `currentStep` (or the last step).
- Mouse: left-drag on empty space = box select; **right-drag = orbit**; right-click ≤ 4 px = piece menu (as today); middle button unchanged.
- Performance: build connector / collision data once per gesture, not per mouse move. A few hundred parts must stay smooth while dragging.
- Existing behaviour that must keep working: a 1×1 round plate seats on a jumper's centre stud (`tests/plan/studSnap.test.ts`); sideways-part seating; laid-out floor-shift drags; build-view `startFloorDrag`; gizmo rotate / scale; group selection.

## Review Focus

1. **Imported models that already overlap.** Moving an overlapping piece out, or within the same overlap, must be allowed. Task 2 test `allows moving out of an existing overlap`.
2. **Dragging over empty floor, off the model.** The ghost must fall back to whole-stud floor placement, with no null crash. Task 4 test `falls back to the floor grid when nothing is hit`.
3. **Snap flicker when the mouse sits between two studs.** Hysteresis must hold the pose. Task 4 test `keeps the previous pose within the hysteresis distance`.
4. **Pieces inside a placed submodel bay (rotated preview).** Pose deltas must go through `itemPlacement` / `viewPlacement` like today's drag. Task 6 test `commits the same plan item for a submodel shown at a rotated bay`.
5. **Paste with a submodel name that already exists but has different content.** It must rename the copy and never overwrite. Task 8 test `renames a clashing submodel and leaves the original untouched`.

---

## Part 1: Collision everywhere and connectors

### Task 1: Connector model

**Files:**
- Create: `src/plan/connectors.ts`
- Modify: `src/anim/construction/connections.ts:18-20`: move `isStudSnap` into `connectors.ts` and import it back from there.
- Test: `tests/plan/connectors.test.ts`

**Interfaces:**
- Produces:
  - `type Connector = { pos: Vec3; axis: Vec3; gender: 'M' | 'F'; type: 'stud' }`, in LDU part space (or submodel space). `axis` is the unit direction **out of** the connector, toward where a mate comes from: a top stud points up (−Y), an underside socket points down (+Y). A male and a female mate when their `pos` coincide and `axis` vectors are opposite.
  - `isStudSnap(s: Snap): boolean` (moved, unchanged).
  - `partConnectors(m: PartMetrics): Connector[]`, cached in a `WeakMap<PartMetrics, Connector[]>`.
  - `submodelConnectors(plan: Plan, name: string, metrics: Metrics, colors: Map<number, ColorDef>): Connector[]`, built from `assemble(...)` instances, transformed into the submodel frame. Cache it keyed on the submodel's `steps` array identity.
  - `worldConnectors(list: Connector[], world: ArrayLike<number>): Connector[]` (column-major 4×4).

- [ ] **Step 1: Write the failing tests** (`skipIf(!ready)` with the `PartLibrary` setup from `tests/plan/studSnap.test.ts`, and shadow loaded from `public/data/ldcad-shadow.json` through `shadowLookupFrom`):
  - `gives a 2x4 brick 8 up studs and 8 down sockets`: `partConnectors(3001)` has 8 `M` with axis ≈ `[0,-1,0]` and 8 `F` with axis ≈ `[0,1,0]`. The socket y equals `body.max[1]`.
  - `gives a 1x2 jumper one centre stud` (3794b): one `M` at x = 0, z = 0.
  - `gives a SNOT brick a sideways stud` (87087): there is an `M` with axis ≈ `[0,0,-1]` or `[±1,0,0]`.
  - `dedupes studs found by both metrics.studs and shadow snaps`: no two connectors with the same gender closer than 1 LDU.
  - `builds submodel connectors in the submodel frame`: a plan with submodel `s` holding one 3001 at Grid {x:0,y:0,z:0,rot:0} yields the same 16 connectors as `partConnectors(3001)` moved by that item's placement.
- [ ] **Step 2: Run** `npx vitest run tests/plan/connectors.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/plan/connectors.ts`. Sources, merged and deduped:
  - `metrics.studs` (base point, axis base → tip) as `M`.
  - `socketsOf(body)` (from `studSnap.ts`) as `F` with axis +Y.
  - Shadow `snaps.filter(isStudSnap)`. The pos is `start` (for `center` snaps, the centre). The axis is the snap axis, oriented out of the part: for `M`, toward the stud tip; for `F`, toward the open end.
- [ ] **Step 4: Run tests.** Expected: PASS. Also run `npx vitest run tests/anim` and confirm nothing regressed from moving `isStudSnap`.
- [ ] **Step 5: Commit** `feat(plan): stud/socket connector model`.

### Task 2: Collision that reports new overlaps

**Files:**
- Create: `src/plan/collision.ts`
- Modify: `src/plan/studSnap.ts`: `overlapTest` becomes a thin wrapper over the new sampler (same behaviour). Export `lineSpan` and `inStud` if they are needed.
- Test: `tests/plan/collision.test.ts`

**Interfaces:**
- Consumes: `SnapPart` from `studSnap.ts`.
- Produces:
  - `type Solid = SnapPart & { id: string }`. `id` is the top-level plan item id (a submodel use contributes one `Solid` per child part, all with the use's id).
  - `type CollisionWorld = { hits(moving: readonly Solid[], shiftLdu?: readonly number[]): Set<string> }` returns the ids of non-moving solids that the moving solids penetrate. Studs sitting in sockets don't count. Touching faces don't count (keep `overlapTest`'s slack).
  - `collisionWorld(solids: readonly Solid[]): CollisionWorld` uses a uniform spatial hash (cell size 40 LDU) over world boxes, built once.
  - `addsOverlap(before: Set<string>, after: Set<string>): boolean`, true if `after` has any id not in `before`.
  - `solidsFor(instances: readonly Instance[], metrics: Metrics): Solid[]`, the instance → `Solid` adapter (id = `inst.key.split('/')[0]`, skip placeholders).

- [ ] **Step 1: Write the failing tests** (real parts, as in Task 1):
  - `reports a brick pushed into another brick`: 3001 at the origin, another 3001 shifted 10 LDU in x at the same height → `hits` = {'a'}.
  - `does not report a brick stacked on studs`: the second 3001 is 24 LDU up (seated) → empty.
  - `does not report bricks side by side touching`: shifted exactly 40 LDU in x → empty.
  - `reports a plate raised into the brick above it`: 3023 under 3001, plate shifted −8 LDU in y (into the brick) → {'brick'}.
  - `allows moving out of an existing overlap`: pieces a and b overlap. `addsOverlap(hits at start, hits after a moves 10 LDU away)` is false, and so is staying put. Moving a into a third piece c is true.
  - `treats a submodel's child parts as one id`: two `Solid`s with id 's' → result contains 's' once.
- [ ] **Step 2: Run** `npx vitest run tests/plan/collision.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `collision.ts`. Move the point sampling and the in-mesh test out of `overlapTest` into it, keeping the stud exemption. Make `overlapTest(moving, others)` return `(shift) => collisionWorld(others as Solid[]).hits(moving as Solid[], shift).size > 0` with dummy ids.
- [ ] **Step 4: Run** the new tests plus `npx vitest run tests/plan/studSnap.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(plan): collision world reporting new overlaps`.

### Task 3: Guard every keyboard / gizmo edit, plus the K toggle

**Files:**
- Modify: `src/state/appSettings.ts`: add `collision: boolean` (default `true`) and `setCollision(on: boolean)`. Persist it through `toSettings` / `applySettings` and `src/storage/settings.ts`.
- Modify: `src/state/keymap.ts`: add `{ kind: 'collision' }` for `k` / `K` without a modifier.
- Modify: `src/state/editing.ts`: `runCommand` uses `guardedApply` for move / rotate / duplicate.
- Create: `src/state/guard.ts`
- Modify: `src/ui/Viewport.tsx` (gizmo translate branch, ~lines 395-410): clamp to the last clean delta and show "Blocked" in `readoutRef`.
- Modify: `src/ui/Toolbar.tsx`: a "Collision" toggle button with hint `K`.
- Test: `tests/state/guard.test.ts`, `tests/state/keymap.test.ts` (add a case)

**Interfaces:**
- Consumes: `collisionWorld`, `solidsFor`, `addsOverlap` (Task 2); `snapperFor` (existing).
- Produces:
  - `guardEdit(before: Plan, after: Plan, m: ModelName, ids: string[]): boolean`: true when the edit is clean (or collision is off). It assembles both plans for model `m`, builds the world from non-moving solids of `after`, and compares the moved ids' hits before and after.
  - `guardedApply(m: ModelName, ids: string[], edit: (p: Plan) => Plan, retry?: (p: Plan) => Plan | null): 'ok' | 'retried' | 'blocked'`. It applies `edit`. If that collides, it tries `retry`. If both collide, it applies nothing and calls `useStudio.getState().flashBlocked(ids)`.
  - `flashBlocked(ids: string[]): void` on the store. It sets `blocked: { ids, at: number }`, which the Viewport renders as a red tint for 400 ms.
  - Keyboard retry for a vertical move (E / Q / Shift+↑↓): step on in the same direction one plate at a time, up to 12 plates (`RETRY_PLATES = 12`), and take the first clean height. For a horizontal arrow there is no retry: it is refused.

- [ ] **Step 1: Write the failing tests** in `tests/state/guard.test.ts`. Set up the store with a plan (as in `tests/state/store.test.ts`) and real parts through `partService` test helpers (`tests/helpers`):
  - `refuses an arrow move into a wall`: 3001 'a' at x 0, 3001 'wall' at x 4 (same height). Moving 'a' +x four times: after 2 moves 'a' is at x 2, and the 3rd move returns 'blocked' and leaves the plan unchanged.
  - `E on a plate under a brick lands on top of the brick`: 3023 'p' at y 0, 3001 'b' at y 1 directly above. Raise 'p' → 'retried', and 'p' ends at y 4 (one plate + one brick).
  - `moves freely when collision is off`: `setCollision(false)`, then the wall move succeeds.
  - `duplicate is collision-checked`: duplicate into an occupied spot steps further +x until clean (retry = shift +1 stud, up to 12).
  - In `keymap.test.ts`: `K toggles collision`: `commandForKey({key:'k',...},0)` → `{kind:'collision'}`.
- [ ] **Step 2: Run** `npx vitest run tests/state/guard.test.ts tests/state/keymap.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `guard.ts`, the store `blocked` / `flashBlocked`, the settings field, the keymap entry, and the `runCommand` wiring. Sideways selections keep using `sidewaysMove` first, then the guard.
- [ ] **Step 4: Implement the gizmo clamp.** Keep the last clean `delta` in the gesture closure. When the new delta fails `guardEdit`, apply the last clean one instead and set the readout to `Blocked`. Clear the readout on pointer-up.
- [ ] **Step 5: Run** `npx vitest run tests/state tests/plan` and `npx tsc --noEmit`. Expected: PASS, no type errors.
- [ ] **Step 6: Verify in the browser** (preview server). Arrow a brick into another: it stops, flashes red. E on a plate under a brick: it pops on top. K: it now passes through. Gizmo up-drag into a brick: it stops with "Blocked".
- [ ] **Step 7: Commit** `feat(edit): collision guard on keyboard, duplicate and gizmo edits`.

---

## Part 2: Placement engine

### Task 4: Pose search

**Files:**
- Create: `src/plan/placementEngine.ts`
- Test: `tests/plan/placementEngine.test.ts`

**Interfaces:**
- Consumes: `Connector`, `worldConnectors` (Task 1); `CollisionWorld`, `Solid` (Task 2).
- Produces:
  ```ts
  type Target = Connector & { owner: string };            // world LDU, free (unmated, uncovered)
  type PoseQuery = {
    moving: { solids: Solid[]; connectors: Connector[] }; // in the moving set's CURRENT world pose (LDU)
    targets: Target[];                                    // candidates already filtered to visible pieces
    hit: { point: Vec3; owner: string | null };           // LDU; owner null = floor
    handle: number;                                       // index into the moving male/female connectors usable as handle
    yaw: 0 | 90 | 180 | 270;                              // extra quarter turns about the target axis (R / Shift+R)
    world: CollisionWorld | null;                         // null = collision off
    before: Set<string>;                                  // hits at gesture start (overlap rule)
    prev: Pose | null;                                    // for hysteresis
  };
  type Pose = { delta: number[]; mated: number; owners: string[]; valid: boolean; handle: number };
  // delta: column-major 4x4 LDU transform applied to the moving set's current world pose
  function findPose(q: PoseQuery): Pose;
  function handleCount(moving: PoseQuery['moving']): number;
  function freeTargets(connectors: { list: Connector[]; owner: string }[], solids: Solid[]): Target[];
  ```
  Constants: `SEARCH_RADIUS = 30` LDU around the hit point; `HYSTERESIS = 7` LDU (about a third of a stud); `FLOOR_Y = 0`.

- [ ] **Step 1: Write the failing tests** (real parts):
  - `seats a 2x4 brick on all 8 studs of a 2x4 plate`: plate 3020 at the origin, brick 3001 held at an arbitrary point, hit on the plate's top near a corner stud → `valid`, `mated === 8`, and the brick's final position is exactly on the plate.
  - `uses the stud nearest the hit point`: 1×1 plate 3024 over a 2×4 plate, hit near stud (1,0) → it lands on that stud.
  - `climbs onto a taller part`: the target brick top is 24 LDU higher than the start. The delta includes the −24 y change (no fixed height).
  - `seats a 1x1 round plate on a jumper's centre stud` (3794b + 4073) → x offset 10 LDU from the grid.
  - `hangs a part under another when the handle is a top stud`: `handle` = index of a male stud of 3024, target = a socket of a 3001 above → it lands below.
  - `skips a colliding pose and takes the next best`: an occupied stud next to the hit gives the free neighbour; if all are occupied → `valid: false`.
  - `keeps the previous pose within the hysteresis distance`: with `prev` = the pose at stud A, a hit 6 LDU toward stud B keeps A; at 14 LDU it switches to B.
  - `falls back to the floor grid when nothing is hit`: `hit.owner = null`, point (33, 0, 47) → the moving set's bottom on y 0, x / z rounded to whole studs, `mated 0`, `valid` true.
  - `rotates in hand`: `yaw: 90` turns a 1×2 plate across the studs and it still mates 2.
- [ ] **Step 2: Run** `npx vitest run tests/plan/placementEngine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `findPose`:
  1. Candidates: targets with `owner === hit.owner` (or all targets when there's none at the hit) within `SEARCH_RADIUS` of `hit.point`.
  2. For each candidate whose gender is the opposite of the handle's: build the rotation taking `handle.axis` to `−target.axis`. Keep the moving set's current yaw, then apply `q.yaw` about the target axis. Translate so the handle lands on `target.pos`.
  3. Score: count how many moving connectors land within 1 LDU of an opposite free target with opposed axes (`mated`).
  4. Drop poses where `world && addsOverlap(before, world.hits(...))`.
  5. Choose max `mated`, then the smallest distance from `target.pos` to `hit.point`.
  6. Hysteresis: if `prev` is valid and its handle target is within `dist(best) + HYSTERESIS` of the hit, return `prev`.
  7. Floor fallback as tested.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(plan): placement pose search`.

### Task 5: Committing a pose to the plan

**Files:**
- Create: `src/plan/commitPose.ts`
- Test: `tests/plan/commitPose.test.ts`

**Interfaces:**
- Consumes: `Pose` (Task 4); `transformPlanItems`, `LDU_TO_WORLD`, `WORLD_TO_LDU` (gizmo.ts, now exported); `moveItemsToStep`, `findItem` (ops.ts).
- Produces:
  - `commitPose(plan: Plan, m: ModelName, ids: string[], nodes: ANode[], pose: Pose, stepOf: (owner: string) => number): Plan`. It converts `pose.delta` (LDU) to a world delta and calls `transformPlanItems` (which keeps `Grid` where possible, else `Raw`). Then, if `max(stepOf(o) for o in pose.owners)` is later than a moved item's step, it moves that item to that step with `moveItemsToStep`.
  - `addPosedPart(plan: Plan, m: ModelName, step: number, item: PieceItem, pose: Pose, body: Box): Plan`, for palette and paste: the item's placement is the pose applied to an identity-yaw placement at the origin.

- [ ] **Step 1: Write the failing tests:**
  - `keeps a whole-stud upright result as a Grid item`: a pure translate pose of 2 studs → the item still has `x/y/z/rot`, x + 2.
  - `stores a half-stud result as Raw`: 10 LDU x → the item has `ldu/matrix`, no `rot` key.
  - `moves a piece to the later step it now rests on`: piece in step 0, pose owners = ['top'] with stepOf('top') = 2 → the piece is in step 2.
  - `leaves the step alone when resting on an earlier piece`.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** and confirm PASS.
- [ ] **Step 5: Commit** `feat(plan): commit placement poses to the plan`.

### Task 6: Grab-and-move in the viewport

**Files:**
- Create: `src/state/placing.ts`: the gesture session (shared by Tasks 6, 7 and 8).
- Modify: `src/ui/Viewport.tsx`: replace the Move-tool drag body (~lines 1278-1330) with a `placing` session. Add Select-tool press-drag on an already-selected piece. Handle keys Tab / Shift+Tab / R / Shift+R / Esc during a session.
- Create: `src/render/ghost.ts`: a translucent clone of the moving instances, tinted with theme tokens `--accent` (valid) and `--danger` (invalid), opacity 0.55.
- Test: `tests/state/placing.test.ts`

**Interfaces:**
- Consumes: `findPose`, `freeTargets`, `handleCount` (Task 4); `commitPose`, `addPosedPart` (Task 5); `collisionWorld`, `solidsFor` (Task 2); `partConnectors`, `submodelConnectors`, `worldConnectors` (Task 1).
- Produces (`src/state/placing.ts`):
  ```ts
  type PlacingSource =
    | { kind: 'move'; model: ModelName; ids: string[] }
    | { kind: 'new'; model: ModelName; items: PlanItem[]; submodels?: Record<string, Submodel> }; // palette / paste / clone
  type PlacingState = { source: PlacingSource; pose: Pose | null; handle: number; yaw: 0|90|180|270 } | null;
  const usePlacing: UseBoundStore<StoreApi<{ state: PlacingState }>>;
  function beginPlacing(src: PlacingSource): void;   // builds targets/world/before ONCE; beginGesture() for 'move'
  function updatePlacing(hit: { point: Vec3; owner: string | null }): Pose | null; // LDU, display frame already inverted
  function cycleHandle(dir: 1 | -1): void;
  function turnInHand(dir: 1 | -1): void;
  function commitPlacing(): string[] | null;         // ids placed/moved, selects them; null if pose invalid
  function cancelPlacing(): void;                    // restores (endGesture without change for 'move')
  ```
  Targets are restricted to items visible at `currentStep`, minus `hidden[model]`. The world holds every non-moving piece. For `move`, the moving pieces stay rendered at the live pose (apply the pose each update inside the gesture). For `new`, the ghost is drawn and nothing is in the plan until commit.
  The default handle is the moving connector nearest the grab point for `move`, and the first female (socket) for `new`.

- [ ] **Step 1: Write the failing tests** in `tests/state/placing.test.ts` (store + real parts):
  - `drags a brick from the floor onto a plate and commits once`: begin `move` on 'brick', update with a hit on the plate, commit. The brick sits on the plate and undo restores it in one step.
  - `cancel restores the original position`.
  - `does not target pieces from later steps`: the plate is in step 3 and `currentStep` is 1, so the pose falls back to the floor.
  - `commits the same plan item for a submodel shown at a rotated bay`: a submodel use with `buildSpot` angle 90. Updating with a display-frame hit gives the same plan result as the unrotated case.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** `placing.ts`. For display-frame inversion, reuse `itemPlacement` / `viewPlacement` exactly as the current drag does (move the helpers out of `Viewport.tsx` into `src/ui/modelPlacement.ts` if they're private).
- [ ] **Step 4: Wire into the Viewport:**
  - pointerdown (Move tool on a piece, or Select tool on an already-selected piece, ≥ 4 px movement before it starts) → `beginPlacing`.
  - pointermove → raycast the scene excluding the moving keys (`pickAt` with an exclude set). On a miss, intersect the floor plane. Convert to LDU, then `updatePlacing`.
  - pointerup → `commitPlacing`. Esc → `cancelPlacing`. Tab / Shift+Tab → `cycleHandle`. R / Shift+R → `turnInHand` (only while placing; otherwise R keeps today's rotate).
  - Keep `startFloorDrag` and laid-out floor-shift checks **before** this branch, unchanged.
- [ ] **Step 5: Run** `npx vitest run tests/state tests/plan tests/ui` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Verify in the browser.** Build a tower: drag a brick from the floor onto another brick, then onto the side of a SNOT brick. Tab flips to hanging under. Red ghost over an occupied spot. Undo is one step. Then laid-out view: the floor drag still works.
- [ ] **Step 7: Commit** `feat(viewport): Studio-style grab-and-move with snapping`.

### Task 7: Point-and-place from the Parts panel

**Files:**
- Modify: `src/ui/PartsPanel.tsx`: on tile pointerdown + move ≥ 4 px, call `beginPlacing({kind:'new', ...})` with a fresh `PieceItem` in `paintColor`. Keep click = `addPart` and HTML `draggable` for the timeline lane. Update the pane help text to: "Drag a part into the view to snap it onto the model, or click to add it beside the model. Drag onto the timeline's Parts lane to add it at that moment."
- Modify: `src/ui/Viewport.tsx`: while `usePlacing.state?.source.kind === 'new'`, window pointermove over the canvas drives `updatePlacing`, pointerup over the canvas commits, and pointerup elsewhere cancels.
- Test: `tests/ui/partsPanelPlacing.test.tsx`

**Interfaces:**
- Consumes: `beginPlacing`, `commitPlacing`, `cancelPlacing` (Task 6); `ensureParts` (partService).

- [ ] **Step 1: Write the failing tests** (Testing Library, as in existing `tests/ui` files):
  - `starts a placing session when a tile is dragged`: pointerDown + pointerMove 10 px on a tile → `usePlacing.getState().state.source.kind === 'new'`.
  - `a plain click still adds at a free spot`: click → plan gains one item, and there is no placing session.
- [ ] **Step 2: Run** and confirm FAIL. **Step 3: Implement.** **Step 4: Run** and confirm PASS.
- [ ] **Step 5: Verify in the browser.** Drag a 2×4 from the palette onto a plate. The ghost tracks, it snaps, and release places it in the current step in the paint colour.
- [ ] **Step 6: Commit** `feat(parts): drag parts from the palette into the view`.

---

## Part 3: Clipboard and selection

### Task 8: Copy / cut / paste / clone

**Files:**
- Create: `src/plan/clipboard.ts`
- Modify: `src/state/keymap.ts`: ⌘C `copy`, ⌘X `cut`, ⌘V `paste`, plain `c`/`C` `clone`. (Check that `c` is not already bound; it isn't today.)
- Modify: `src/state/editing.ts` (`runCommand`).
- Modify: `src/ui/PieceMenu.tsx`: Copy / Cut / Paste / Clone entries with hints.
- Test: `tests/plan/clipboard.test.ts`, `tests/state/keymap.test.ts`

**Interfaces:**
- Consumes: `exportLDraw` (io/ldrawExport.ts), `importLDraw` (io/ldrawImport.ts), `beginPlacing` (Task 6).
- Produces:
  ```ts
  type Clip = { items: PlanItem[]; submodels: Record<string, Submodel> }; // ids stripped, assembly hints stripped except `group`
  function copyItems(plan: Plan, m: ModelName, ids: string[]): Clip;      // includes every submodel reached, recursively
  function clipToLDraw(clip: Clip, metrics: Metrics, colors: Map<number, ColorDef>): string; // MPD text
  function clipFromLDraw(text: string): Clip | null;                       // via importLDraw; null if no pieces
  function mergeSubmodels(plan: Plan, clip: Clip): { plan: Plan; clip: Clip }; // identical name+content → reuse; clash → "name (2)", "name (3)"…, and item references are rewritten
  ```
  `runCommand`:
  - `copy` writes `navigator.clipboard.writeText(clipToLDraw(...))` and keeps the in-app `Clip` in a module variable.
  - `cut` = copy + delete.
  - `paste`: use the in-app `Clip` if the system clipboard text equals the last text we wrote, else `clipFromLDraw(text)`. Then `mergeSubmodels`. If the mouse is over the viewport (`viewportApi.pointerInside: boolean`, a new field set by the canvas's pointerenter / pointerleave in this task), `beginPlacing({kind:'new', items, submodels})`; otherwise place it beside the model like Duplicate (guarded).
  - `clone` = `beginPlacing` with `copyItems` of the selection, leaving the clipboard alone.

- [ ] **Step 1: Write the failing tests:**
  - `copies a selection without ids`: two pieces → `clip.items` has 2, no `id`, and `assembly` only keeps `group`.
  - `includes nested submodels`: a selection with a use of A, where A uses B → `clip.submodels` has A and B.
  - `round-trips through LDraw text`: `clipFromLDraw(clipToLDraw(clip))` gives the same parts, colours and placements.
  - `reuses an identical submodel`: the plan already has A with the same steps → no new submodel.
  - `renames a clashing submodel and leaves the original untouched`: the plan's A differs → the clip becomes `A (2)`, the item references are `A (2)`, and the plan's A is deep-equal to before.
  - keymap: ⌘C / ⌘X / ⌘V / c map to `copy` / `cut` / `paste` / `clone`, and ⌘D is still `duplicate`.
- [ ] **Step 2: Run** and confirm FAIL. **Step 3: Implement.** **Step 4: Run** and confirm PASS.
- [ ] **Step 5: Verify in the browser.** Select 3 bricks, ⌘C, move the mouse into the view, ⌘V: the ghost follows, snaps, click places it. C clones. Paste LDraw text copied from a `.ldr` file in a text editor and confirm it places.
- [ ] **Step 6: Commit** `feat(edit): copy, cut, paste and clone with snapping placement`.

### Task 9: Box select and Studio mouse mapping

**Files:**
- Create: `src/ui/boxSelect.ts`
- Modify: `src/ui/viewControls.ts` (and wherever `OrbitControls` is created): `mouseButtons.LEFT = null` (or `-1`), `RIGHT = THREE.MOUSE.ROTATE`. Keep the existing MIDDLE logic. Touch controls are unchanged.
- Modify: `src/ui/Viewport.tsx`: on a Select-tool left-drag on empty space, draw a rectangle overlay (`.box-select`, theme tokens) and select on release. The right-click menu still opens only when movement ≤ 4 px (existing `rightDown` check), so a right-drag orbit never opens it.
- Modify: viewport help / tooltip text that says left-drag orbits.
- Test: `tests/ui/boxSelect.test.ts`

**Interfaces:**
- Produces: `boxSelect(instances: readonly Instance[], camera: THREE.Camera, rect: { x0: number; y0: number; x1: number; y1: number }, size: { w: number; h: number }, hidden: ReadonlySet<string>): string[]`. It returns the top-level item ids whose world-box centre projects inside the rect (pixels), skipping hidden ids. The caller combines the result with `selectionForHit` group expansion, Shift (add) and Alt (remove).

- [ ] **Step 1: Write the failing tests:**
  - `selects pieces whose centre is inside the rectangle`: an orthographic camera looking down and three instances, two inside → those two ids.
  - `skips hidden pieces`.
  - `returns each submodel use once` (instances `s/0`, `s/1` → 's').
- [ ] **Step 2: Run** and confirm FAIL. **Step 3: Implement.** **Step 4: Run** and confirm PASS.
- [ ] **Step 5: Verify in the browser.** Right-drag orbits and a right-click opens the menu. Left-drag on empty space draws a box and selects. Shift adds, Alt removes. Left-drag on a piece with the Move tool still moves it.
- [ ] **Step 6: Commit** `feat(viewport): box select and right-drag orbit`.

### Task 10: Final pass

- [ ] **Step 1:** `npm test` (full vitest) and `npx tsc --noEmit`. Expected: all pass. Report any test failures and do not skip them.
- [ ] **Step 2:** Performance check in the browser with `public/data/test-10001.mpd` (a few hundred parts). Drag a piece across the model with the frame-time readout or the Performance panel: no sustained frames over 33 ms.
- [ ] **Step 3:** Re-run the "existing behaviour that must keep working" list from Global Constraints by hand in the browser.
- [ ] **Step 4: Commit** any fixes: `fix(build-mode): final pass`.
