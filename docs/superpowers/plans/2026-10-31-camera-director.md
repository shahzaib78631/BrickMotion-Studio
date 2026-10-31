# Camera Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smooth keyframe playback, plus an editable Camera track (keys + customisable transitions with presets, Auto-direct, lens track) that drives the viewport, Preview and MP4, with depth of field and motion blur in Preview/MP4.

**Architecture:** A pure camera module (`src/anim/cameraTrack/`) owns data types, curves, presets, the sampler `cameraTrackAt` and `autoDirect`. The plan stores tracks per model (`plan.cameraTracks`), edited through pure ops with undo. The viewport, `PreviewPlayer` and `exportVideo` all sample the same function. UI: a `CameraTrackRow` in both timeline editors and a Camera tab in the Inspector.

**Tech Stack:** TypeScript, React, zustand, Three.js, zod (plan schema), vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-camera-director-design.md`

## Global Constraints

- Old projects (no `cameraTracks`) load and play exactly as before; save/load round-trips the new field.
- No extra per-frame work in the editing viewport while not playing/scrubbing a camera track; no live DOF or motion blur in the editing viewport.
- Auto-direct runs only on user action; re-running replaces only `origin: 'auto'` keys/transitions.
- One sampler (`cameraTrackAt`) for viewport, Preview and MP4.
- Works in 9:16 (primary), 16:9 and 1:1.
- Every edit is one undo step (via `useStudio.apply`).
- User transition presets are stored in app settings (all projects).

## Review Focus

1. **Track with one key** — camera holds that key for the whole video (no NaN, no jump). Test in Task 2.
2. **Keys at the same time / key outside the video length** — sampler clamps; ops keep keys sorted and unique by time (moving onto another key's time nudges by 1/fps). Tests in Tasks 2 and 4.
3. **Orbit across ±180°** — azimuth 170° → −170° goes 20° the short way, not 340°. Test in Task 2.
4. **Build replanned after Auto-direct (duration changes)** — auto keys regenerate, user keys beyond the new end are clamped to the end, not dropped. Test in Task 5.
5. **Elevation near ±90° / distance ≤ 0** — clamp elevation to [−85°, 89°], distance ≥ 0.5 world units. Test in Task 2.

---

### Task 1: Smooth keyframe curves (auto-clamped tangents)

**Files:**
- Modify: `src/anim/keyframes.ts:29-45` (`channelAt`)
- Test: `tests/anim/keyframes.test.ts`

**Interfaces:**
- Produces: `autoClampedSlope(prev: {x:number;y:number}|null, cur: {x:number;y:number}, next: {x:number;y:number}|null): number` exported from `src/anim/keyframes.ts` (reused by Task 2 for flow-through keys). `channelAt` signature unchanged.

- [ ] **Step 1: Write failing tests**

```ts
describe('smooth (bezier) keys flow through middle keys', () => {
  const keys = [0, 10, 20].map((f, i) => ({ frame: f, value: i * 10, interpolation: 'bezier' as const }));
  it('does not stop at a middle key on a steady ramp', () => {
    const v = (f: number) => channelAt(keys, f, 0);
    expect(v(10.1) - v(9.9)).toBeCloseTo(0.2, 2);       // ~linear speed through frame 10
  });
  it('still eases at the first and last key', () => {
    expect(channelAt(keys, 0.1, 0)).toBeLessThan(0.05);
    expect(20 - channelAt(keys, 19.9, 0)).toBeLessThan(0.05);
  });
  it('never overshoots at a peak key', () => {
    const peak = [0, 10, 20].map((f, i) => ({ frame: f, value: [0, 10, 0][i], interpolation: 'bezier' as const }));
    for (let f = 0; f <= 20; f += 0.25) expect(channelAt(peak, f, 0)).toBeLessThanOrEqual(10 + 1e-9);
  });
  it('linear and constant keys are unchanged', () => {
    const lin = [{ frame: 0, value: 0, interpolation: 'linear' as const }, { frame: 10, value: 10, interpolation: 'linear' as const }];
    expect(channelAt(lin, 5, 0)).toBe(5);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/anim/keyframes.test.ts` — Expected: the "middle key" and "overshoot" tests FAIL.
- [ ] **Step 3: Implement** cubic Hermite in `channelAt` for `bezier` with per-key slopes from `autoClampedSlope`: endpoints slope 0; middle key slope = Catmull-Rom slope `(next.y-prev.y)/(next.x-prev.x)`, set to 0 when `cur` is a local extremum (prev and next on the same side), and limited so the segment cannot overshoot (Fritsch–Carlson: clamp |slope| ≤ 3·min(|Δleft|,|Δright|)/Δx per side).
- [ ] **Step 4: Run** `npx vitest run tests/anim/keyframes.test.ts tests/anim/keyframePose.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "fix(keyframes): smooth keys flow through middle keys"`

---

### Task 2: Camera track types, curves and sampler

**Files:**
- Create: `src/anim/cameraTrack/types.ts`, `src/anim/cameraTrack/curves.ts`, `src/anim/cameraTrack/sample.ts`
- Modify: `src/anim/camera.ts` (export `buildFocusBox`)
- Test: `tests/anim/cameraTrack/sample.test.ts`, `tests/anim/cameraTrack/curves.test.ts`

**Interfaces:**
- Consumes: `fitDistanceAtTarget`, `sphericalPosition`, `cameraFov`, `worldBox3` from `src/anim/camera.ts`; `autoClampedSlope` (Task 1).
- Produces (`types.ts`):

```ts
export type XYZ = [number, number, number];
export type CameraTarget = { kind: 'model' } | { kind: 'build' } | { kind: 'piece' } | { kind: 'point'; at: XYZ };
export type CameraDistance = { fit: true; margin: number } | { fit: false; value: number };
export type CameraKey = { id: string; t: number; target: CameraTarget; offset: XYZ; azimuth: number; elevation: number;
  distance: CameraDistance; roll: number; lensMm: number; focus: number | 'target'; blur: number; origin: 'auto' | 'user' };
export type CurveKind = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'holdThenMove' | 'snap';
export type SpeedCurve = { kind: CurveKind; strength: number };            // strength 0..1
export type TransitionSettings = { curve: SpeedCurve; aimCurve?: SpeedCurve; lensCurve?: SpeedCurve;
  path: 'arc' | 'straight'; orbit: 'shortest' | 'cw' | 'ccw'; extraTurns: number; overshoot: number;
  motionBlur: number; shake: { amount: number; frequency: number }; cut: boolean; flowThrough: boolean };
export type CameraTransition = { from: string; to: string; preset: string; settings: TransitionSettings; origin: 'auto' | 'user' };
export type DirectorStyle = 'reference' | 'calm' | 'energetic' | 'overhead';
export type CameraTrack = { keys: CameraKey[]; transitions: CameraTransition[]; shutter: number; style?: DirectorStyle };
export type CameraClock = 'build' | 'timeline';
export type CameraTracks = Record<string, Partial<Record<CameraClock, CameraTrack>>>;
export type CameraContext = { aspect: number; sensorMm: number; duration: number;
  modelBox: THREE.Box3; buildBox(t: number): THREE.Box3; pieceBox(t: number): THREE.Box3 | null };
export type CameraShot = CamPose & { roll: number; lensMm: number; focus: number; blur: number; shutter: number };
```

- Produces (`curves.ts`): `curveAt(c: SpeedCurve, u: number): number` (0→0, 1→1, monotone except `snap` may not overshoot either), `overshootAt(u: number, amount: number): number` (extra fraction, 0 at u=0 and u=1).
- Produces (`sample.ts`): `cameraTrackAt(track: CameraTrack, t: number, ctx: CameraContext): CameraShot | null` (null when no keys); `keyRig(key: CameraKey, t: number, ctx): { target: THREE.Vector3; dist: number; az: number; el: number }`.
- Produces (`camera.ts`): `buildFocusBox(tl: Timeline, t: number): Box` — the box `frameKeys` frames at `t` (wraps `focusPlan`/`focusAt`).

- [ ] **Step 1: Write failing tests** (`sample.test.ts`), using a ctx with `modelBox` = unit cube at origin, `buildBox` = same, aspect 9/16:
  - `returns null for an empty track`
  - `one key holds for all t` — shots at t=0 and t=99 have equal position (toBeCloseTo, 6).
  - `azimuth crosses ±180 the short way` — keys az 170 and −170, linear curve; at u=0.5 the shot's azimuth (atan2 of position−target) ≈ ±180°.
  - `cw orbit with extraTurns 1 goes 360+Δ` — keys az 0 and 90, orbit 'cw', extraTurns 1; at u=0.5 azimuth ≈ 225° (mod 360).
  - `hard cut jumps at the second key` — `cut: true`; at t just before key 2 equals key 1's shot; at key 2 equals key 2.
  - `auto-fit keeps the model in frame` — `distance: {fit:true, margin:1.1}`: all 8 corners of modelBox project inside NDC [−1,1] for the returned camera.
  - `clamps elevation to [-85, 89] and distance ≥ 0.5`.
  - `flowThrough keeps speed across a middle key` — three keys az 0/45/90 at t 0/1/2, both transitions linear+flowThrough: az(1.01)−az(0.99) ≈ 0.9° (±0.2).
  - `lens and focus interpolate` — lensMm 35→85 at u=0.5 with linear lensCurve gives 60.
- [ ] **Step 2: Write failing tests** (`curves.test.ts`): every kind returns 0 at 0 and 1 at 1; `easeInOut` at 0.5 = 0.5; `holdThenMove` at 0.25 < 0.05; `overshootAt(0,a)=overshootAt(1,a)=0`, `overshootAt(0.85,0.5)>0`.
- [ ] **Step 3: Run** `npx vitest run tests/anim/cameraTrack` — Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `curves.ts`, `types.ts`, `sample.ts`. Sampling: find the transition whose keys bracket `t`; compute both keys' rigs at `t` (targets resolved live from ctx, so `build`/`piece` targets move with the build); blend target (vector lerp), `log(dist)`, az (per `orbit` + `extraTurns`), el, roll, lens with the transition's curves; `path: 'straight'` lerps camera positions instead of rig values; add `overshootAt` to the blend factor; add shake as smooth value noise (seeded by key ids) to az/el scaled by `shake.amount` degrees. FOV from `cameraFov({lensMm, sensorWidthMm: ctx.sensorMm})`. `shutter` = transition `motionBlur` during a move, `track.shutter` during holds.
- [ ] **Step 5: Run** `npx vitest run tests/anim/cameraTrack tests/anim/camera.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(camera): camera track model and sampler"`

---

### Task 3: Transition presets

**Files:**
- Create: `src/anim/cameraTrack/presets.ts`
- Test: `tests/anim/cameraTrack/presets.test.ts`

**Interfaces:**
- Produces: `type TransitionPreset = { id: string; label: string; hint: string; settings: TransitionSettings; key?: Partial<Pick<CameraKey,'azimuth'|'elevation'|'roll'|'lensMm'|'blur'>> & { distanceScale?: number } }` — `key` is a relative change applied to the *end* key when the preset is used to create a new key ("Push in" = distanceScale 0.7).
- `BUILT_IN_PRESETS: readonly TransitionPreset[]` with ids exactly: `glide, push-in, pull-back, truck-left, truck-right, pedestal-up, pedestal-down, crane-down, crane-up, orbit, arc-reveal, swoop, whip-pan, dolly-zoom, rack-focus, dutch-in, handheld, hold, cut`.
- `presetById(id: string, user: readonly TransitionPreset[]): TransitionPreset` (falls back to `glide`).
- `applyPreset(t: CameraTransition, p: TransitionPreset): CameraTransition` (copies settings, sets `preset`, `origin: 'user'`).
- `DEFAULT_TRANSITION: TransitionSettings` (= glide).

Values the spec pins: `swoop` = snap curve, strength ≥ 0.7, arc path, motionBlur ≥ 0.6, overshoot ≈ 0.15; `whip-pan` motionBlur 1; `cut` cut true; `handheld` shake.amount > 0; `dolly-zoom` changes lens and distance in opposite directions (`key.lensMm` up, `distanceScale` > 1); `truck-*`/`pedestal-*` path 'straight'.

- [ ] **Step 1: Failing tests:** all 19 ids present and unique; each settings object passes `isTransitionSettings` (exported validator); the pinned values above; `presetById('nope', [])` returns glide; a user preset with an existing built-in id is found before the built-in.
- [ ] **Step 2: Run** `npx vitest run tests/anim/cameraTrack/presets.test.ts` — FAIL.
- [ ] **Step 3: Implement** `presets.ts`; tune remaining values by eye later in Task 11.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(camera): built-in transition presets"`

---

### Task 4: Plan storage, schema and edit ops

**Files:**
- Modify: `src/plan/types.ts` (add `cameraTracks?: CameraTracks` to `Plan`), `src/plan/schema.ts` (zod `CameraTracksSchema`, optional)
- Create: `src/anim/cameraTrack/ops.ts`
- Modify: `src/state/store.ts` (camera selection state)
- Test: `tests/anim/cameraTrack/ops.test.ts`, `tests/plan/cameraTracksSchema.test.ts`

**Interfaces:**
- Produces (`ops.ts`), all pure `(p: Plan, ...) => Plan`, `ref = { model: string; clock: CameraClock }`:
  `trackOf(p, ref): CameraTrack | undefined`;
  `addCameraKey(p, ref, key: Omit<CameraKey,'id'|'origin'>, fps: number): Plan` (new key `origin:'user'`, transitions re-linked: the gap it splits keeps its settings on both sides; a new last key gets `DEFAULT_TRANSITION`);
  `updateCameraKey(p, ref, id, patch: Partial<CameraKey>): Plan` (sets `origin:'user'`);
  `moveCameraKey(p, ref, id, t: number, fps: number, duration: number): Plan` (clamp to [0,duration]; never equal to another key's t: nudge by 1/fps; keys stay sorted);
  `deleteCameraKey(p, ref, id): Plan` (merges the two transitions around it, keeping the earlier one's settings);
  `setTransition(p, ref, fromId, patch: Partial<CameraTransition>): Plan` (sets `origin:'user'`);
  `replaceAutoTrack(p, ref, auto: CameraTrack): Plan` (used by Task 5).
- Produces (`store.ts`): `cameraSelection: { kind: 'key' | 'transition'; clock: CameraClock; id: string } | null` and `selectCamera(sel)`; clearing the brick selection does not clear it, selecting bricks does.

- [ ] **Step 1: Failing tests (ops):** add → sorted, origin user, transition count = keys−1; move onto an existing key's time nudges by 1/fps; move past duration clamps; delete middle key merges transitions; ops never mutate the input plan (deep-freeze input).
- [ ] **Step 2: Failing tests (schema):** a plan without `cameraTracks` parses; a plan with a track round-trips `parsePlan(JSON.parse(JSON.stringify(p)))` deep-equal; a key with `elevation: 'x'` is rejected with a path in the error.
- [ ] **Step 3: Run** `npx vitest run tests/anim/cameraTrack/ops.test.ts tests/plan/cameraTracksSchema.test.ts` — FAIL.
- [ ] **Step 4: Implement** types, schema, ops, store selection.
- [ ] **Step 5: Run** the two test files plus `npx vitest run tests/plan` — PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(camera): store camera tracks in the plan with edit ops"`

---

### Task 5: Auto-direct

**Files:**
- Create: `src/anim/cameraTrack/autoDirect.ts`
- Test: `tests/anim/cameraTrack/autoDirect.test.ts`

**Interfaces:**
- Consumes: `Timeline` (`buildEnd`, `duration`, `modelBox`, `tracks`, `units`), `buildFocusBox` (Task 2), presets (Task 3), `replaceAutoTrack` (Task 4).
- Produces:
  `type DirectorOptions = { style: DirectorStyle; swings: number /*0 calm..1 busy*/; lensMm: number; shutter: number; front?: number /*azimuth override, degrees*/ }`;
  `autoDirect(tl: Timeline, opts: DirectorOptions): CameraTrack` (all keys/transitions `origin:'auto'`);
  `mergeAuto(existing: CameraTrack | undefined, auto: CameraTrack, duration: number): CameraTrack` (keeps user keys/transitions, drops auto keys within 0.4 s of a user key, clamps user keys to `duration`);
  `frontAzimuth(tl: Timeline): number` (side whose landing pieces' total visible face area is largest; ties → 0°).

Rules to encode (spec "Auto-direct"): opening key el 55–65° close on base box; elevation descends linearly with built height to 10–20° by `buildEnd`; side swings toward the dominant landing side of each window (window ≥ 1.5 s, at most `1 + round(swings*5)` swings), swings > 60° use `swoop`, else `orbit`/`glide`; a `pull-back`+`crane-down` key ≥ 0.6 s before any landing that raises built height by > 25%; final key at `frontAzimuth`, el ≈ hero elevation, `arc-reveal` into it, holding to `duration`. Style presets: `reference` (above), `calm` (swings 0, glide only, lens 85), `energetic` (swings 1, swoop/whip-pan, shutter 0.7), `overhead` (el 70–80 throughout, no swings).

- [ ] **Step 1: Failing tests** with a synthetic timeline (fixture builder in the test: pieces land at increasing heights; second half lands on the −Z side):
  - first key elevation in [55,65], last key elevation in [10,20];
  - elevations are non-increasing over time;
  - at least one key in the second half has azimuth within 45° of 180° (camera swings toward −Z);
  - last key azimuth = `frontAzimuth(tl)` (±1°); `opts.front` overrides it;
  - `calm` produces no `swoop`/`whip-pan`; `overhead` keeps every elevation ≥ 70;
  - every landing piece's box stays inside the frame when sampled at its landing time (via `cameraTrackAt` + projection);
  - `mergeAuto` keeps a user key at t=3 unchanged, removes auto keys within 0.4 s of it, and clamps a user key at t=50 to duration 20.
- [ ] **Step 2: Run** `npx vitest run tests/anim/cameraTrack/autoDirect.test.ts` — FAIL.
- [ ] **Step 3: Implement** `autoDirect.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(camera): auto-direct a camera track from the build"`

---

### Task 6: Playback wiring (viewport, Preview, MP4 camera)

**Files:**
- Create: `src/anim/cameraTrack/context.ts`
- Modify: `src/ui/Viewport.tsx` (render loop, ~lines 600–680), `src/ui/PreviewPlayer.tsx:90-104`, `src/export/exportVideo.ts:110,172-180,214-235,303-310`, `src/state/appSettings.ts:72` + `src/storage/settings.ts` (exportCamera adds `'track'`), `src/ui/VideoPanel.tsx:164-170` (MP4 camera option)
- Test: `tests/anim/cameraTrack/context.test.ts`, `tests/export/cameraTrackExport.test.ts`

**Interfaces:**
- Produces: `buildCameraContext(tl: Timeline, aspect: number, sensorMm: number): CameraContext`; `timelineCameraContext(animation: KeyframeAnimation, bounds: THREE.Box3, buildTimeline: Timeline | null, aspect, sensorMm): CameraContext` (maps through `buildLayerAt` like `exportVideo.ts:303`);
  `applyShot(camera: THREE.PerspectiveCamera, shot: CameraShot): void` (position, lookAt, fov, then roll about the view axis);
  `ExportOpts.cameraTrack?: CameraTrack`; `exportCamera: 'automatic' | 'buildView' | 'track'` — default becomes `'track'` when the current model has a track for that clock.
- Viewport: when the Build view follows playback (or the keyframe Timeline plays) and a track exists for `(editingModel, clock)`, `shot = cameraTrackAt(...)`; otherwise current behaviour. No sampling when not playing/scrubbing.

- [ ] **Step 1: Failing tests:** `buildCameraContext(tl).buildBox(t)` equals `worldBox3(buildFocusBox(tl,t))`; `applyShot` with roll 90° makes `camera.up` (in view space) point along +X; export with `cameraTrack` calls the track sampler (spy) for every frame and without it uses `cameraAt` (existing behaviour test still passes).
- [ ] **Step 2: Run** `npx vitest run tests/anim/cameraTrack/context.test.ts tests/export/cameraTrackExport.test.ts` — FAIL.
- [ ] **Step 3: Implement** context, `applyShot`, and the three call sites.
- [ ] **Step 4: Run** those plus `npx vitest run tests/anim/buildViewCamera.test.ts tests/anim/heroAround.test.ts tests/anim/introInto.test.ts` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(camera): viewport, preview and MP4 follow the camera track"`

---

### Task 7: Camera row in the timelines

**Files:**
- Create: `src/ui/CameraTrackRow.tsx`, `src/ui/cameraTrack.css`
- Modify: `src/ui/BuildTimeline.tsx` (row under Steps, toolbar buttons), `src/ui/KeyframeTimeline.tsx` (same row, frames↔seconds via `fps`)
- Test: `tests/ui/cameraTrackRow.test.tsx`

**Interfaces:**
- Produces: `<CameraTrackRow clock: CameraClock; model: string; duration: number; toX(t:number):number; toT(x:number):number; fps: number; onAutoDirect(): void />` renders keys (diamonds), transition bars (label = preset label, colour per preset family), and a Lens/focus sub-row showing keys whose lens/focus/blur differ from the previous key. Toolbar actions (in each timeline's toolbar): **Auto-direct** (style menu: Reference, Calm, Energetic, Overhead), **+ Key from view** (key at playhead from `viewportApi.studio.camera` → rig values relative to the track context target `build`), **Update key from view**, **Delete**.
- Drag a key → `moveCameraKey` as one undo gesture (`beginGesture`/`endGesture`); drag a bar's edge → moves that key; click → `selectCamera`.

- [ ] **Step 1: Failing tests** (React Testing Library, existing test setup): renders N diamonds and N−1 bars for a 3-key track; bar text is the preset label; clicking a bar calls `selectCamera({kind:'transition',...})`; pressing Delete with a key selected removes it; "+ Key from view" with a stubbed viewport camera adds a key at the playhead time.
- [ ] **Step 2: Run** `npx vitest run tests/ui/cameraTrackRow.test.tsx` — FAIL.
- [ ] **Step 3: Implement** row, toolbar buttons and the `cameraPoseToKey(camera, ctx, t)` helper in `src/anim/cameraTrack/context.ts` (inverse of `keyRig` with `distance:{fit:false}`).
- [ ] **Step 4: Run** — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Commit** `git commit -m "feat(camera): camera row in the build and keyframe timelines"`

---

### Task 8: Inspector Camera panel and user presets

**Files:**
- Create: `src/ui/CameraInspector.tsx`
- Modify: `src/ui/Inspector.tsx:138-145` (a **Camera** tab, auto-selected when `cameraSelection` is set), `src/state/appSettings.ts` + `src/storage/settings.ts` (`cameraPresets: TransitionPreset[]`, sanitised with `isTransitionSettings`)
- Test: `tests/ui/cameraInspector.test.tsx`, `tests/storage/cameraPresets.test.ts`

**Interfaces:**
- Key selected: fields target (Model / Building / Landing piece / Point), azimuth, elevation, distance (Auto-fit + margin, or fixed), roll, lens mm, focus (slider or "On target"), blur, each → `updateCameraKey`.
- Transition selected: preset select (built-ins then user presets, grouped), speed curve kind + strength, "Advanced" (aim curve, lens curve), path, orbit direction + extra turns, overshoot, motion blur, shake amount/frequency, cut, flow through → `setTransition`; **Save as preset** (name prompt) → appends to `cameraPresets`.

- [ ] **Step 1: Failing tests:** choosing preset "Fast swoop" writes swoop settings; changing overshoot keeps preset id but marks origin user; Save as preset adds to app settings and the new preset appears in the select; settings sanitiser drops a preset with invalid settings.
- [ ] **Step 2: Run** `npx vitest run tests/ui/cameraInspector.test.tsx tests/storage/cameraPresets.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(camera): camera inspector and saved transition presets"`

---

### Task 9: Depth of field from the track (Preview + MP4)

**Files:**
- Modify: `src/export/exportVideo.ts:144-157,182-189` (per-frame `LensChoice` from the shot), `src/ui/PreviewPlayer.tsx` (apply `LensPass` on the canvas each frame when the shot's blur > 0), `src/render/depthOfField.ts` (accept continuous blur: `LensChoice.px?: number` overriding `LENS_BLUR_PX[blur]`)
- Test: `tests/render/depthOfField.test.ts` (extend), `tests/export/cameraTrackExport.test.ts` (extend)

**Interfaces:**
- `shotLens(shot: CameraShot): LensChoice` in `src/anim/cameraTrack/context.ts`: `{ blur: shot.blur > 0 ? 'medium' : 'off', focus: shot.focus, px: shot.blur * LENS_BLUR_PX.strong }`.
- With a camera track, the track's lens replaces `materials.lens` for that video.

- [ ] **Step 1: Failing tests:** `blurRadius` honours `px`; export with a track whose blur goes 0→1 creates the `LensPass` and calls `apply` with increasing `px`; with blur 0 throughout no `LensPass` is created.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(camera): depth of field follows the camera track"`

---

### Task 10: Motion blur (Preview + MP4)

**Files:**
- Create: `src/render/motionBlur.ts`
- Modify: `src/export/exportVideo.ts:168-195` (sub-frame loop), `src/ui/PreviewPlayer.tsx` (4 sub-frames max)
- Test: `tests/render/motionBlur.test.ts`

**Interfaces:**
- `class MotionBlurAccumulator { constructor(renderer: THREE.WebGLRenderer, w: number, h: number); begin(): void; add(weight: number): void /* copies the current canvas into a float target, weighted */; resolve(): void /* draws the average back to the canvas */; dispose(): void }`.
- `subframeCount(shutter: number, movedPx: number, max: number): number` — 1 when `shutter === 0` or `movedPx < 0.75`; else `clamp(ceil(movedPx * shutter / 3), 2, max)`; MP4 `max = 12`, Preview `max = 4`.
- `movedPixels(a: CameraShot, b: CameraShot, box: THREE.Box3, w: number, h: number, bricksMoved: number): number` — max screen displacement of the box corners between the shutter-open and shutter-close camera, plus `bricksMoved` (max landing-piece displacement projected, from `poseAt`).
- Sub-frames sample camera **and** brick poses at `t + (k/(n−1) − 0.5) · shutter / fps`; DOF (Task 9) is applied once after `resolve()`.

- [ ] **Step 1: Failing tests:** `subframeCount(0, 100, 12) === 1`; `subframeCount(0.5, 0.5, 12) === 1`; `subframeCount(0.5, 60, 12) === 10`; `subframeCount(1, 1000, 4) === 4`; accumulator average of two solid-colour frames (headless GL is unavailable → test the weighting maths via an exported `accumulateWeights(n)` returning weights that sum to 1 and are symmetric).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(render): motion blur for preview and MP4"`

---

### Task 11: End-to-end check against the references

**Files:** none new (preset/style value tuning only in `presets.ts`, `autoDirect.ts`).

- [ ] **Step 1:** `npm run typecheck && npm test` — Expected: all pass.
- [ ] **Step 2:** Start the dev server (`preview_start dev`), import a BrickHeadz-sized model (e.g. `samples/5590_-_whirl_n_wheel_super_truck.mpd` or any small set), plan the build, press **Auto-direct → Reference**, play in the viewport: camera starts high, lowers, swings, ends on the front. Screenshot.
- [ ] **Step 3:** Edit one transition to **Fast swoop**, add a key from view, change a key's lens to 100 mm, save a user preset; reload the page and confirm the track and preset persist.
- [ ] **Step 4:** Old project check: load a project saved before this feature; it plays as before (no Camera row keys, automatic camera).
- [ ] **Step 5:** Export a 9:16 MP4 with the track; extract frames (`ffmpeg -vf fps=2,tile=8x4`) and compare side by side with the two references; tune Reference style values; re-run Step 1.
- [ ] **Step 6:** Measure viewport frame time idle with and without a camera track (must match within noise).
- [ ] **Step 7: Commit** `git commit -m "chore(camera): tune presets and auto-direct against references"`
