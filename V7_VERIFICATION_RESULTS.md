# BrickMotion V7 mechanics verification results

## Source and test status

The following checks completed successfully during V7 development in the offline build environment:

| Check | Result | Interpretation |
|---|---:|---|
| `npm run verify:v4:mechanisms:offline` | 10 pass | Legacy V4 mechanistic regression cases |
| `npm run verify:v5:offline` | 42 pass | Existing V5 transmission and staged-animation regression cases |
| `npm run verify:v6:offline` | 33 pass | Existing V6 spatial-linkage, geometry-screen and importer tests |
| `npm run verify:v7:offline` | 52 pass | V7 spatial mechanics, authored transmissions, one-way pawls, drive loops, vehicle examples and V4 checks re-included by the harness |
| `npm run typecheck:v7:math` | pass | Isolated dependency-light V7 solver and geometry-screen TS typecheck |
| `npm run verify:v7:syntax` | 9 pass | Syntax-only AST parsing of the nine modified TypeScript/TSX modules |

**Totals:** 137 offline test reports (10+42+33+52); the V7 script incorporates some of the V4 test cases, so these are *not* 137 independent mechanisms. Nine additional syntax checks passed. No test cases failed in the final offline run.

## Covered V7 mechanisms

Spur/internal/bevel gears, multi-stage gears, worm transmissions, belts and chains, constant-velocity shafts, Cardan universal joints, screw actuators, winches, rack-and-pinion motion, open differentials, planetary epicyclic gearsets, cam followers, engageable clutches, brakes, one-way ratchets, hard stops, ideal Ackermann steering, and straight-line no-slip wheel rolling. Spatial joints include hinge, slider, ball, weld, distance link, cylindrical, universal and planar. Integration tests include a gearbox coupled to a four-bar loop and a simultaneous steering + rolling two-driver network.

Other tests reject contradictory shaft ratios, incompatible drive commands, invalid teeth/axes/inputs, model size violations and reversal against an engaged ratchet; test multi-turn accepted-pose continuation; and preserve V6 JSON rig import support.

## Not verified

- **Full production build and browser runtime**: not run successfully because npm dependencies were unavailable in this offline environment. The mathematics and syntax checks do **not** substitute for `npm ci && npm run build`, a browser smoke test or UI interaction testing.
- **Real LEGO-set function accuracy**: synthetic rig examples and earlier V4/V5/V6 tests, not a head-to-head benchmark with Kinebrick or a large collection of real-set ground truth.
- **Physical dynamics**: no motor torque, spring response, friction, braking force, gravity contact, tyre slip, backlash, rope tension or flexible track simulation.
- **Collision clearance**: no continuous contact or collision certification for the new V7 ideal kinematic rigs. Existing V4 collision-verification tooling remains separate.
- **Saved video baking for V7 spatial rigs**: V7 is currently live viewport preview, rig JSON interchange and sampled diagnostics. Existing V4/V5 saved-animation paths are unchanged.

## Reproduce

```bash
npm run verify:v7:all
```

With dependencies installed, additionally run:

```bash
npm ci
npm run build
npm run dev
```

Open **Mechanisms → V7 spatial mechanics workbench** with a supported detected linkage or a reviewed V7 sample rig; create/update mechanical relationships, preview, sweep the motion and export diagnostics. Replace example member placeholders with placed part keys and adjust rest coordinates/anchors before importing onto a real model.
