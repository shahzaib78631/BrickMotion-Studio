# V8 mechanics, authoring, motion export and safety boundaries

## Start the application

```bash
npm ci
npm run setup
npm run dev
```

Go to **Mechanisms**, open a detected spatial linkage or import a reviewed spatial rig JSON. In the **V8 mechanical network composer**, choose a mechanism kind, choose the **actual joint IDs**, fill its dimensions, and select **Add to live spatial rig**. A mechanism with mismatched joint types, invalid dimensions, impossible rest geometry or contradictory motor constraints will be rejected or produce a failed-solve diagnostic instead of an invented physical motion.

### Added V8 component authoring

| Mechanic | Required joints and inputs | Ideal law / behavior |
|---|---|---|
| Offset slider-crank | Hinge `crank`, slider `slider`, crank radius `r`, connecting rod `L`, guide offset `e` | `x(θ) = r cosθ + sqrt(L² − (e − r sinθ)²) − x(0)`; requires `L > r + abs(e)` for safe whole-turn branch |
| Scotch yoke | Hinge `crank`, slider `slider`, radius `r`, optional phase | `x(θ) = r [sin(θ + phase) − sin(phase)]` |
| Linear coupler | Two sliders, nonzero signed ratio | `x_out = ratio · x_in` |
| Ideal hydraulic pair | Two sliders, two piston areas | `A₁ x₁ + A₂ x₂ = 0` |
| Backlash gear | Two hinges, tooth counts and clearance radians | Driven tooth-flank coupling with a deadband; undriven output prefers its last accepted pose when disengaged |
| Detent/selector | Hinge or slider, detent pitch, engaged flag | Constrains selector to commanded discrete index; physically simulated snap force is absent |
| Cam profile | Cam hinge, follower slider, 4–64 nonnegative lift samples, phase/lobes | Periodic smoothstep interpolation of sampled lift, zero at rest |
| Intermittent indexer | Input/output hinges, 3–24 slots and active-turn fraction | One indexed step per full input turn, with a smooth active interval and dwell |
| Differential drive | Left/right wheel hinges, forward slider, yaw hinge, wheel radius and track width | `s = r(φL+φR)/2`; `yaw = r(φR−φL)/trackWidth` |

Only ideal position constraints are solved. It is **not** safe to infer true mechanical backlash, non-slip tyre grip, motor forces, hydraulic pressure, Geneva pin clearance, follower spring action, axle friction or physical rope tension from these equations.

## V8 rig interchange

When any V8 mechanic is present, rig JSON exports use `format: brickmotion-v8-mechanics-rig`, `version: 3`. Existing rigs containing only V7 mechanics still export as V7/v2 for maximum backward compatibility. The V8 importer accepts V6/v1, V7/v2 and V8/v3. Every rig must map each spatial rigid body to actual LDraw **instance keys** present in the open model. Examples in `samples/mechanisms/*v8*` intentionally contain placeholders—replace them before importing onto a real model.

## Bake a sampled V8 spatial pose clip

With an active spatial rig, choose **Bake sampled V8 pose clip JSON**. The exporter uses the current motor range and additional motor locks to calculate 25 sequential poses over 2 seconds (12 samples/sec), or a forward-only sequence for engaged ratchets. Exported frames include body pose, driver coordinate, per-frame numerical residual, time and original body-to-instance mapping; they can be used by future render-stage tooling.

The exported evidence kind is `sampled-ideal-kinematics-only`. If any sampled motion fails, export aborts with the sample/time and an error rather than claiming success. Full-turn clips require sufficiently dense sampling to avoid incorrect quaternion winding. A pose clip **does not yet create a rendered video or saved V4 timeline**. Future work can compile the pose-and-instance frames into the existing render timeline after appropriate swept collision checks.

## Quality gates

```bash
npm run verify:v8:all
npm run typecheck:v8:math
npm run verify:v8:syntax
npm run build
```

The first three can use globally installed TypeScript without downloaded npm dependencies. `npm run build` is the production React/Vite typecheck and bundle build and requires dependencies from `npm ci`. The `.github/workflows/v8-quality.yml` workflow runs both regression and build gates on future GitHub pushes/PRs.
