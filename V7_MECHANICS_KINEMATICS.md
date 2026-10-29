# BrickMotion V7 — mechanically coupled spatial kinematics

**Status:** implemented source code and offline mathematical tests. This is an ideal, user-authored and geometry-screened kinematics system; **it is not a dynamics engine or certified LEGO physical simulator**. The full browser build was not available in the offline authoring environment.

## Main architectural change

V5 had a transmission-network solver which animated ideal rigid-body revolute and prismatic coordinates. V6 had an independent full spatial linkage solver which could maintain hinged, ball, welded and fixed-length multi-body loops, but couldn't couple those bodies to transmissions in a single solve.

**V7 solves the authored transmission relations inside the same spatial nonlinear constraint system as the rigid-body assembly.** Each body has translation + orientation (6 DOF). A damped numerical Jacobian enforces joint closures plus all mechanical transmission relationships simultaneously. Stiff or contradictory loops return a failed state and residual report instead of faking a fit. Existing V4/V5 animation paths are untouched.

## Supported joint / mechanical families

| Family | V7 physical-coordinate rule | Caveat |
|---|---|---|
| Hinges, sliders, ball joints, welds, fixed-length rods | Existing V6 spatial constraints | No force, material stress or collision certification |
| Cylindrical joint | Shaft can translate and rotate on the same axis (2 DOF) | Ideal coaxial alignment |
| Planar joint | Free in 2 plane directions plus rotation about normal (3 DOF) | Not a frictional contact surface |
| Universal (cross) joint | Coincident pivot; joint axes orthogonal (2 DOF) | No cross-bearing geometry |
| Spur gears and internal ring gears | `theta_out = ± teeth_in/teeth_out * theta_in` | No involute tooth contact/backlash |
| Bevel and crown gear drives | Signed authored tooth ratio between supported shafts | Axis intersection and bevel-cone meshing not independently certified |
| Planetary / epicyclic gearset | `Ns*sun + Nr*ring = (Ns+Nr)*carrier` (Willis equation) | Ideal constraint; no planet-gear tooth geometry, carrier bearing or torque model |
| Chain & belt drives | Ideal pitch ratio; crossed belt reverses direction | No slip, tension, sag or link articulation |
| Worm gear | `theta_out = ± starts/wheel_teeth * theta_in` | No worm self-locking torque/friction |
| CV shaft coupling | Equal signed shaft angles | Authored coupling, not automatically verified |
| Hooke universal drive | `theta_out = atan2(cos(beta)*sin(theta_in), cos(theta_in))` continuously unwrapped | Ideal Cardan shaft; input/output joint axes must be independently modelled |
| Rack and pinion | `travel = ± pitchRadius * shaftRotation` | No verified tooth engagement |
| Wheel rolling (straight chassis) | `chassisTravel = ± wheelRadius * wheelRotation` | No-slip idealization; not a tyre-ground contact solver |
| Leadscrew/linear actuator | `travel = ± lead/(2π) * shaftRotation` | No static force, load or thread friction |
| Winch/block-and-tackle | `travel = ± drumRadius / supportingSegments * shaftRotation` | Rope always taut; no loads or pulley losses |
| Open differential | `theta_left + theta_right = 2 * theta_carrier` | No torque bias, no slip/dynamic tire response |
| Ackermann steering | `tan(left) = L/(L*cot(centre) - track/2)` and `tan(right) = L/(L*cot(centre) + track/2)` | Ideal rigid turning geometry, not rack/tie-rod contact or tyre forces |
| Cam-follower | `travel = lift/2*(cos(phase) - cos(lobes*angle+phase))` | Assumes positive contact, no follower spring |
| Clutch | Ideal equal-speed shafts when engaged; independent when released | No slip/torque capacity |
| Holding brake | Ideal lock to assembled rest when engaged | No brake torque or arbitrary-position hold |
| Joint hard stops | Constraint residual when hinge/slider exceeds authored min/max | Not inferred from part geometry |
| Ratchet/pawl | Solver remembers accepted travel and refuses reverse while engaged | Ideal one-way pawl without teeth/friction/impacts |

Every mechanical relation is optional. There are explicit caps (16 bodies, 48 spatial constraints, 64 mechanical relationships). All values are finite-checked; tooth counts and gear starts are required to be integers.

## Mechanism Lab workflow

1. Load an LDraw/Studio model and open **Mechanisms**.
2. Start a detected spatial linkage with an explicit ground and driver, **or** import a reviewed `*.v7-mechanics-rig.json` file with exact placed-part member IDs and rest anchors.
3. Open **V7 mechanical network composer** in the spatial workbench. Pick a spur/bevel gear, planetary gearset, chain, cam, actuator, clutch, differential, winch, ideal wheel rolling, Ackermann steering, stop, etc. The UI offers **actual hinge/slider IDs from that rig**, never imaginary shafts.
4. Configure ratios, effective radii, cam rise, pulley segments or limits; choose **Add to live spatial rig**. The engine verifies structure and rest closure before accepting.
5. Alternatively, in **V6 geometry-screened mechanisms**, use **Add screened relation to V7 rig** on a plausible pair. This path only works when each real part belongs to a known rigid body with exactly one matching joint. Anything ambiguous or lacking pitch/tooth data is rejected for manual review. **This is not an automatic confirmation of engagement**.
6. Scrub the active driver, or lock compatible secondary motors for differential/combined linkages. Review UI errors and the residual report for impossible configurations.
7. Run **Sweep active network · 33 samples**, or **Sweep ratchet · forward only** where a one-way lock makes round-trip playback physically impossible. Export the report and the **active V7 mechanics rig**. The source model and saved timeline are not edited.

An engaged ratchet disables ordinary oscillating playback. **Reset pawl + centre** clears its accepted travel. Existing V4 motion programs can still render through their old planner, but **the new V7 spatial mechanics rig is not yet baked into saved video**.

## Input file compatibility

- **V7 export:** `format: "brickmotion-v7-mechanics-rig"`, `version: 2`, plus `model.bodies`, `model.constraints`, optional `model.mechanics`, `members` and `driver`.
- **V6 import retained:** `format: "brickmotion-v6-spatial-rig"`, `version: 1`. Legacy V6 spatial rigs remain readable and export as V7 format.
- `members` must name actual placed instance keys; no imported rig is silently considered physically accurate.
- Three sample authored networks: `samples/mechanisms/gear-fourbar.v7-mechanics-rig.example.json`, `samples/mechanisms/cam-follower.v7-mechanics-rig.example.json`, and `samples/mechanisms/vehicle-steering-rolling.v7-mechanics-rig.example.json`. The vehicle sample combines Ackermann steering and wheel rolling with independently commanded steering/wheel motors. Replace the `REPLACE-WITH-*` member keys with actual placed keys before importing.

## Numerical safety and solver limitations

- Hinge motion is **unwrapped across multiple turns by accepted-pose continuation**; the user must apply angular positions in increments *less than π radians*. Large instantaneous jumps are explicitly rejected. Large gear multipliers may require much smaller increments to prevent winding ambiguity.
- Residuals use a reference length of 20 LDU per radian for angular constraints. This is a numerical solver scaling constant, not a real lever arm. Failing residuals show the offending constraint ID.
- The iterative solver uses local numerical derivatives; very singular linkages, large part counts and conflicting simultaneous motors can fail even when a true physical mechanism exists. A sampled sweep does not prove motion between samples or physical clearance.
- Straight-line no-slip wheel rolling, Ackermann steering, rack travel and fixed-contact cam profiles are **kinematic idealizations**. Spring forces, gravity, counterweights, motor torque, acceleration, friction, collision/contact dynamics, slip, backlash, and full flexible chain/string simulation remain outside this V7 update.
- Geometry proposals use bounds and connector axes, never full contact topology. No claim of superiority over Kinebrick's automatic real-set recognition is made without shared test models and ground truth.

## Verification

```bash
npm run verify:v4:mechanisms:offline
npm run verify:v5:offline
npm run verify:v6:offline
npm run verify:v7:offline
npm run typecheck:v7:math
npm run verify:v7:syntax
```

These tests include synthetic spur/bevel/planetary gears, wheel rolling, Ackermann steering, differential inputs, spatial linkages, incompatible gear cycles, joint stops, clutches/brakes/ratchets, multi-turn tracking, importer compatibility and authored two-mechanism examples. They do not establish full-browser UX correctness or official LEGO model accuracy. Run `npm ci && npm run build` with network access and manually test model previews before shipping to users.

### Design references

This implementation takes inspiration from the mechanism families and solver architecture described in [Kinebrick's catalog](https://github.com/erik-larsen/kinebrick/blob/main/docs/mechanisms/README.md) and [architecture](https://github.com/erik-larsen/kinebrick/blob/main/ARCHITECTURE.md), but all V7 code is independently written for BrickMotion's existing TypeScript/constraint design; no Kinebrick source code or data was copied into this project.
