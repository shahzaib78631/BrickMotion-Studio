# Automatic mechanism recognition and simulation — design

Status: proposal, 2026-10-30. Scope: recognize the moving parts of an assembled
LEGO Technic model and drive them: linkages, gearbox shifting, whole-vehicle
kinematics, tracks, chains and ropes.

## 0. Principles

1. **Evidence ladder.** Every joint, mesh and mechanism records where it came
   from: *measured* (gear/wheel/sprocket table) > *connector* (LDCad shadow
   snaps) > *posed* (the file shows it moved) > *inferred*. Only measured or
   connector evidence may create a constraint; posed and inferred evidence may
   only rank or label.
2. **Fail closed.** A mechanism we cannot prove over its whole travel is not
   offered. A rejection always comes with a plain reason ("pinion is 30 LDU past
   the end of the rack").
3. **Rank, not counting.** Mobility comes from the rank of the constraint
   Jacobian, never from Grübler–Kutzbach. LEGO models are full of redundant
   constraints (two pins in one hole pair, parallelogram frames), which is
   exactly where counting formulas fail ([Notre Dame note][nd], [exceptional
   mechanisms][wampler]).
4. **Benchmark-driven.** Each phase below has a benchmark target. A change only
   lands if recall goes up and unrelated suggestions do not.

## 1. What exists today (and is kept)

| Piece | Where | Role in the new design |
|---|---|---|
| LDCad shadow snaps, profiled cylinder mates | `construction/profiledCylinderMate.ts`, `mechanicalConstraintGraph.ts` | Raw contact evidence for stage A |
| Rigid clusters, body graph | `v4/mechanismGraph.ts`, `v4/bodyGraph.ts` | Replaced by stage B (computed, not hand-classified) |
| Measured gear table, spur/bevel/rack meshing | `gears/` | Seed of the higher-pair library (stage C) |
| Joint-coordinate solver with closures, transmissions, rack-on-arc contact | `v4/mechanismSolver.ts` | Now a front end of the unified solver (Phase 2 ✓) |
| 6-DOF spatial solver with Ackermann, winch and differential-drive laws | was `v6/spatialConstraints.ts` | Retired in Phase 2: its API is `kinematics/spatialModel.ts`, its laws `kinematics/laws.ts` |
| Rack steering assembler, 5590 benchmark | `v4/drivetrainSuggestions.ts`, `benchmarks/mechanisms/` | Kept as the measured rack-steering builder; it leads the ranked suggestions, and the classifier (stage E) names the same mechanism (Phase 3) |

Two solvers with overlapping features were the main structural debt. Since
Phase 2 there is one (`src/anim/motion/kinematics/`). This
design ends with one.

## 2. Recognition pipeline

```
snaps ─A→ pairwise wrenches ─B→ joints & bodies ─C→ + higher pairs
      ─D→ mobility basis (SVD) ─E→ named mechanisms ─F→ drivers & suggestions
```

### A. Contacts as constraint wrenches (screw theory)

Each matched snap pair (cylinder section overlap, stud, clip, ball, axle cross)
becomes a set of **constraint wrenches** in world coordinates, following the
reciprocal-screw method of Xiong et al. ([2016][xiong]) and the form-closure
treatment of lower pairs in Dawari's thesis ([IISc][dawari]):

- round cylinder overlap (axle in round hole, pin in hole): 4 wrenches
  (2 forces ⟂ axis at each end of the overlap, which also blocks tilt);
  friction pins add nothing kinematically.
- cross (A) section in cross hole: + 1 couple about the axis (no spin).
- stud in anti-stud / clip / square: + axial force and spin couple (fixed).
- ball in socket: 3 forces through the centre.
- shoulders/stops (section boundaries): unilateral axial force, kept for
  joint limits rather than mobility.

### B. Joints and bodies from wrench rank

For each part pair, stack its wrenches into a 6×k matrix and take its SVD
(`mobility/screw.ts`; symmetric eigen solve with a 0.1-stud tolerance).
Read from the full Xiong paper: their position constraint is a force through
the global origin, (a; 0), which gets an off-origin hinge wrong. We put each
force on its own line (moment p × f). Their whole-assembly step (twist
union/intersection) is first order only and is not used; D replaces it.
The **reciprocal twist space** (dimension 6 − rank) *is* the joint: 0 =
fixed, 1 rotation = revolute, 1 translation = prismatic, rotation + translation
on one axis = cylindrical, 3 rotations = spherical. This replaces the
hand-written motion classification (`rotatesOf`, `effectiveMotions`) and
handles combinations for free:

- two coaxial pins → revolute; two parallel, non-coaxial pins → fixed;
- a gear on a cross axle → prismatic along the axle (slides, cannot turn), so
  a shaft is automatically everything locked in rotation about one axis;
- a pin plus a stud → fixed.

Bodies = connected components under fixed joints (union-find). Because the
joint type is computed, the noise in today's benchmark (268 movable joints, many
of them stud/socket "sliding") drops wherever two connectors jointly lock a
pair.

### C. Higher pairs (measured library)

Extend `gears/gearTable.ts` into a part-function library, each entry with
measured geometry and an engagement predicate that is evaluated **every frame**,
not only at rest:

| Function | Parts (examples) | Constraint |
|---|---|---|
| Spur / bevel / double bevel | 3647, 3648, 4143, 32270, 32269, 32498 | ratio, sign from contact velocity (done for single bevels) |
| Rack | 3743 | rolling, straight or on an arc (done) |
| Worm | 4716 | starts : teeth, one-way flag |
| Clutch gear + driving ring | 6542a, 2471, 6539, 32187 | engageable coupling (section 4) |
| Differential | 6573, 62821 | carrier = (left + right)/2 |
| Wheel / tyre | rim and tyre pairs | rolling radius = tyre outer radius |
| Pulley / belt | 4185a, rubber belts | ratio by effective radii, slip allowed |
| Sprocket / chain / tread | 3711, 3873, 57518 | wrap path (section 6) |
| Shock absorber | 731, 2909, 32181 | prismatic with spring range |
| String / winch drum | string parts, axle + string end | wound length (section 6) |

The data source for measurements is the Kinebrick corrections set (CC BY-SA,
credited) plus our own measurement of each part's LDraw geometry. Each entry
gets a unit test placing it from its matrix.

*Phase 3:* the part-function table (`parts/partFunctions.ts`, built by
scanning every LDraw part: 11517 of 29577 parts have a function) supplies
teeth, seats, slides and tyres; `pairs/higherPairs.ts` finds spur, bevel,
crown, rack, worm, screw and clutch pairs between bodies with an engagement
test per frame. Fits accepted only within a tolerance (a section misfit up
to 0.5 LDU, ball play up to half the ball radius, mesh error) are listed per
part pair in the Lab and the JSON export, worst first, so the model file can
be corrected (`construction/toleratedFit.ts`).

### D. Mobility discovery (the core)

Implemented in `src/anim/motion/mobility/` (Phase 1). Grounded in the full
text of Wampler, Hauenstein & Sommese, "Mechanism Mobility and a Local
Dimension Test" ([preprint][nd]), which is explicit that the Jacobian rank
only gives an upper bound: N − rank(df) ≥ dim, with equality only at regular
points.

1. **Loops.** Bodies and joints form a graph; its biconnected blocks hold the
   loops. A joint in no loop moves with its own DOF. Inside a block a spanning
   tree gives every body a pose as a product of exponentials of the joint
   twists (spatial POE); each non-tree joint closes a loop with 12 equations.
   This is the cut-body form of Müller ([cutjoint], read from the full-text
   XML): γ = N − M + 1 fundamental cycles, joint signs from the root-directed
   tree, closure f_l = I. Müller leaves redundant loop equations to the
   solver, which is what step 3 handles. For Phase 3: when a loop contains a
   higher pair (gear mesh, cam, pin-in-slot), pick the tree so that pair is
   the cut joint (his Fig. 8), so every tree joint stays a lower pair.
2. **First-order bound.** The closure Jacobian at the assembled pose is the
   signed sum of joint twists around each loop. Its corank c bounds mobility
   from above and also counts shaky (infinitesimal) freedoms.
3. **Exact local dimension.** Lyapunov–Schmidt reduction: solve the
   independent closure rows for the pivot coordinates as truncated power
   series in the c free ones, substitute into the rest, then run the paper's
   local dimension test (Macaulay matrix coranks under k random slices; the
   smallest k whose corank sequence stabilises is the dimension; LocalDimFinder,
   sec. 8). Depth bound 5 as in the paper. The implementation reproduces the
   paper's Table 2 exactly (general four-bar 1,1; folded four-bar 1,2,2 with
   multiplicity 2; degenerate four-bar never stabilises at k = 1, so 2 DOF).
   Blocks with c > 4 keep only the first-order bound and are marked not exact.
4. **Drivers.** k free coordinates, preferred ones first, that leave the pose
   isolated when fixed (same Macaulay test with coordinate slices).
5. **Real motion.** The test is over the complex numbers. Real and complex
   dimension agree at regular points. At singular ones we also step each driver
   ±0.02 and re-close the loops with Gauss–Newton. The hypo-paradoxical paper
   ([hypo]) gives geometric proofs only, no algorithm; its lesson is that rank
   deficiency is not proof of motion, which steps 3 and 5 address.
6. **Merging.** Locked blocks (dimension 0) and joints that cannot move even to
   first order inside a moving block become one body, and recognition repeats.
   A lone pin or axle (male in every connection) turning on one line between
   two or more bodies is an idle spin: it is folded into its heaviest
   neighbour, which composes its joints in series. Axial slides of axles and
   pins are off by default (friction fits; `axialSlides` turns them on).

Verified cases: four-bar 1; parallelogram with a redundant third crank 1
(Grübler 0); pinned triangle 0; flat triangle shaky but rigid (first order 1,
dimension 0); folded four-bar 2 → 1; slider-crank 1; spherical four-bar 1;
Bennett linkage 1 (Grübler −2); four revolutes on general skew axes 0.

### E. Mechanism classification

Find the independent loops from a spanning tree of the body graph: each
non-tree joint closes one loop, and #loops = J − N (the cut-joint formulation in
[Mech. Sci. 2015][cutjoint] and Featherstone). Then match patterns over bodies,
joints and loops:

- four-bar, parallelogram, slider-crank, Watt/Stephenson six-bars (loop
  sizes and joint types);
- gear train (path of higher pairs), differential, worm drive;
- steering (rack or arm linkage driving wheel hubs that pivot about kingpins),
  suspension (loop with a hub and a shock absorber), turntable;
- gearbox (section 4), track or chain (section 6), winch (section 6).

Each match is a named mechanism with its drivers, which is what the UI lists
and the benchmark scores.

*Phase 3* (`classify/loops.ts`, `classify/patterns.ts`): loops are taken at
their shortest through each joint (pattern matching wants the smallest loop),
and whole functions absorb their pieces (an engine its slider-cranks, a
suspension its wishbone four-bars, steering its gear train). Found in 42000:
the V8 (8 pistons on one crankshaft), the differential, rack steering with
both front hubs, four suspensions, three gear trains; in 5590: rack steering
on a four-bar tie rod and the trailer turntable.

### F. Drivers and suggestions

A suggestion = one finite motion from D with its classified mechanism from E,
proven over its whole travel by the solver (as `provenSuggestion` does today),
carrying everything attached to its bodies (`carriedBodies`). Ranking: named
whole-function mechanisms (steering, gearbox, crane) > single named joints
(turntable) > generic hinges.

*Phase 3* (`classify/suggest.ts`): each named mechanism becomes a solver
program — a joint tree grown from the frame (slides, then hinges, then balls;
a ball in the tree turns as a universal joint on its pin or about its planar
loop's axis), point closures for the joints left over, gear and rack laws
signed by the measured contact point, and carried parts as followers. It is
offered only after solving over the largest of ±90°…±6° that works with every
loop closed and every mesh engaged. An engine, its gears and a differential
join into one drive train driven at the axle with the differential turning
as one (driving straight). A suspension is driven at the lowest arm its hub
hangs from.

## 3. Unified solver

Implemented in `src/anim/motion/kinematics/` (Phase 2): `system.ts` (joint
coordinates on a spanning tree, cut joints with six closure equations, point,
distance and rolling equations, exact Jacobian including the inverse left
Jacobian of SO(3)), `laws.ts` (all 27 v6 mechanics), `solve.ts` (corrector,
bisecting continuation, active set, dead-point stop) and `spatialModel.ts`
(the former v6 rig API). Authored closure tolerances (v4) are soft rows,
minimised inside the exact constraints.

One kinematic solver; dynamics are out of scope.

- **Coordinates:** joint coordinates on the spanning tree from E (as today's
  v4 solver), loop closures at the cut joints, and higher pairs as equations.
  Reduced coordinates keep joint semantics exact and the system small.
- **Corrector:** Levenberg–Marquardt with analytic Jacobians (today's solver
  uses finite differences).
- **Predictor:** step along the null-space tangent from D before correcting.
  This keeps closed loops on one branch and avoids today's 0.35 rad step
  clamping.
- **Singularities:** watch the smallest singular value; near zero (a toggle
  position or a four-bar going flat) stop and report a limit instead of jumping
  branches.
- **Several drivers at once:** all chosen drivers are fixed in one solve; the
  remaining null space is solved as minimum change. This is the "simultaneous"
  solver: steering and drive and shifting in one frame.
- **Limits and contact:** joint stops from the collision sweep become
  inequality constraints with an active set. Higher-pair engagement predicates
  are checked every frame.
- **Migration:** move the v6 laws (Ackermann, winch, differential drive, cam,
  slider-crank) into this solver as equations, port the spatial rig tests, then
  retire v6.

XPBD ([Macklin et al. 2016][xpbd], rigid bodies in [Müller et al. 2020][xpbd-rb])
is used only for secondary visuals (rope sag, track slack), never to decide
mechanism kinematics.

## 4. Gearbox shifting (hybrid modes)

The dog-clutch literature models shifting as discrete engagement states over a
continuous system ([hybrid automata][jjmie]; engagement studies [ZČU][zcu],
[ČVUT][cvut]). Here:

1. **Recognize shift elements:** a body that slides along its shaft (stage B
   prismatic) and carries teeth (a driving ring, or a gear on a cross axle).
   Sweep its slide range analytically and record, from tooth overlap, which
   meshes or couplings are engaged in each interval. The result is a mode table
   like "neutral | 1st (24:8) | 2nd (16:16)", found without running the solver.
2. **Mode = set of active higher pairs.** The selector (lever, knob or rotary
   changeover catch) is an ordinary driver; crossing an interval boundary
   switches mode.
3. **Rebuild on shift:** when the mode changes, the solver rebuilds its
   constraint set and computes each newly engaged pair's phase offset at the
   current pose (so nothing jumps), then checks rank. A contradiction (two
   gears engaged at once, or a lock-up) is reported as a crash, not hidden.
4. **Tooth alignment:** engagement only happens within half a tooth of
   alignment; otherwise the selector stalls at the boundary, as dogs do.
5. **UI:** a gear-ratio table per mode, and a shift track in the timeline that
   animates the selector and the change of output speed.

*Phase 4 as built* (`src/anim/motion/gearbox/`): shift rings are found from
part seats (a wide female seat coaxial with another body's axle) rather than a
stage B prismatic joint, and couplings from toothed parts whose seats sit
within dog reach. The mode table carries rates outward over two-body relations
(meshes, locked differentials, ring on shaft, engaged clutch); a body reached
at two speeds is a lock-up. A gear counts only when every hinge of its body
lies on its own line. The shift track lives in the mechanism program
(`shiftTrack`, `selectors`) and plays in the Lab, not yet in the timeline.

## 5. Vehicle kinematics

1. **Recognize the vehicle:** wheels from the wheel table touching the lowest
   plane; chassis = the body the wheel axles are mounted on; mode switches to
   "vehicle", where the terrain is ground and the chassis has planar x, z, yaw
   (plus pitch, roll and heave when suspension exists).
2. **Rolling:** for a commanded chassis path (straight, circle, user-drawn
   curve), each wheel spins by the distance its own contact point travels
   divided by its rolling radius. Inner and outer wheels then differ, as they
   should.
3. **Steering geometry:** steer angles come from the solved steering mechanism
   (e.g. the 5590 rack four-bar). The instantaneous centre of rotation (ICR) is
   the least-squares intersection of all wheel axle lines.
   - **Ackermann error** = spread of the axle-line intersections.
   - **Tyre scrub** per wheel = slip angle between the wheel's heading and its
     contact velocity about the ICR. Pure Ackermann gives zero at low speed;
     real geometry and tandem axles do not ([Ackermann geometry][ackermann],
     [SAE 2006-01-3638][sae]).
   - The 5590 has tandem rear axles, so it will show real scrub; that is a good
     honesty test.
4. **Yaw:** chassis yaw rate = v / R, with R from the ICR. A kinematic bicycle
   model is the fallback when the steering mechanism is not recognized.
5. **Differential:** an open differential splits wheel speeds by ICR distance
   (carrier = mean). Without one, a solid axle reports scrub instead of
   inventing slip-free motion.
6. **Suspension:** a loop with a hub and a shock absorber gets its prismatic
   range from the part. Terrain height under each wheel drives the loop, the
   solver gives wheel travel, and sweeping travel gives camber gain and bump
   steer (toe change caused by the steering link's arc). Analytic cross-checks
   follow Tanik's double-wishbone formulation ([Hacettepe][tanik]).

*Phase 5 as built* (`src/anim/motion/vehicle/`): ground tyres are found from
tyre parts with a horizontal seat axis whose bottoms share the lowest ground
line; the chassis is the largest body, and wheels reached only through a
non-steering vertical hinge are towed (the 5590 trailer's 8 tyres: carried
rigidly, articulation not modelled). The ICR is the least-squares point of
the axle lines; each wheel's slip and spin follow from it, solid axles report
longitudinal scrub, and a bicycle model stands in when no steering mechanism
is recognised. The vehicle suggestion reuses the steering program: its slider
steers and Play drives the chassis round the ICR with each wheel spinning by
its own rolling distance. A shock's stroke comes from its parts (piston rod in
the bore, collar to the outer part's end; 42000 4254-in-4255: −24..+18 LDU)
and becomes the suspension slide's verified limits; sweeping the driver gives
camber gain and bump steer. Not built: terrain height (sweeps drive the
suspension directly), differential wheel coupling (wheels are free), trailer
articulation, Tanik cross-check.

## 6. Tracks, chains, ropes and cables

**Recognition.** Chain and tread links (3711, 3873, 57518) whose pins connect
in a cycle form a closed chain. The wrap wheels are the sprockets/wheels whose
measured pitch circle is tangent to that link polyline, and the wrap order and
side (inside/outside) are read from the posed links, as multibody track tools
require ([MotionSolve tutorial][altair]).

**Track and chain kinematics (exact, no stretching).**
1. Build the path: common tangent segments between successive pitch circles,
   joined by arcs.
2. The driver sprocket angle θ advances arc position s₀ by R·θ.
3. Place the links by marching: each next pin is the point on the path at
   chord distance p (the link pitch) from the previous one (circle/line
   intersections). On a sprocket the pins therefore sit on the pitch
   *polygon*, so the chordal speed variation (polygon effect,
   [IJHVS 2024][polygon]) appears by itself.
4. Leftover length closes as slack on the longest free span (sag drawn with a
   short XPBD pass).
5. Idlers and road wheels turn by s / R. A tracked vehicle drives with
   differential track speeds (the existing differential-drive law).

**Ropes and winches.**
1. Recognize: string parts with one end on an axle-mounted drum (the winch) and
   the other on a hook or load. Pulleys on the way are wrap wheels as above.
2. Wound length = drum radius × drum angle (plus layer growth when a lap is
   full). Free length = total − wound. The hook height follows by kinematics.
3. Render the free spans as an inextensible XPBD rope (distance constraints;
   Cosserat rods per [Kugelstadt & Schömer 2016][cosserat] only if bending or
   twist must show). The rope never changes length; the winch only moves
   length between drum and span.
4. A ratchet or worm on the drum shaft (already recognized as one-way) holds
   the load.

## 7. Benchmarks

- Keep the 5590 file and add official models with known functions covering
  every section. Candidates: Kinebrick's curated set functions (CC BY-SA, with
  attribution), plus LDraw OMR models of 8880 (gearbox, differential,
  four-wheel steering, suspension), a crawler with treads, and a crane with a
  winch.
- New check types: `mobility` (expected degrees of freedom), `shiftModes`
  (expected ratio table), `scrub` (expected sign and order of magnitude),
  `trackClosed`, `winchLength`.
- Report per mechanism: recall, unrelated suggestions, solver residuals and the
  stage that rejected each miss.

## 8. Phases and acceptance

| Phase | Builds | Done when |
|---|---|---|
| 1 ✓ | Wrench joints (A–B), loop basis, local-dimension mobility (D) | Done: 5590 movable connector edges 314 → 129 (92 body joints), still 17/17; mobility suite passes (incl. Wampler Table 2 and Bennett) |
| 2 ✓ | Unified solver: analytic Jacobian, predictor-corrector, singularity stop, several drivers; port v6 laws | Done: v6 deleted; vitest 893 pass (only the pre-existing minifig failure), verify:v8:all 192/192, 5590 17/17 at unchanged speed (≈1.55 s); new solver suite covers full-turn crank, 3 rad jump on one branch, dead-point stop, redundant parallelogram, two drivers, stops, Bennett |
| 3 ✓ | Higher-pair library (C) and classifier (E); suggestions from mobility | Done: 5590 17/17; 42000 phase 3 16/18 (89 %, was 12/18): steering, rear suspension, V8 drive train and both front wheels. The two misses are connector-data gaps, listed rather than loosened (rear CV ball 5 LDU from its hub socket, so the drive train is driven at the axle; front pushrods 6.8 LDU off). Rim 44772's missing pin holes are added as a local shadow patch (`ldraw/shadowPatches.ts`). vitest 966 pass (only the pre-existing minifig failure), verify:v8:all pass, tsc and vite build clean |
| 4 ✓ | Gearbox modes | Done: 8880 phase 4 5/7. The ratio table gives the manual's 2.25 and 0.75; 2nd (1.5) and 4th (0.5) are missed only because the model file's 8T gear 3647 has no axle — with that axle supplied, all four ratios match the manual. Shifting keeps each clutch's phase (no jump), stalls in neutral while the dogs are out of line, and throws on lock-up; the Lab shows the mode table and plays a shift track. 42000 phase 4 0/2: its selector's clutch gears are found, but the small linear actuators 92693c01 have no screw pair yet (a phase 3 gap), so the wing and covers do not move. 5590 17/17, 42000 phase 3 16/18 unchanged. vitest 990 pass (minifig fails as before; two speed limits miss only under full parallel load and pass alone), verify:v8:all pass, tsc and vite build clean |
| 5 ✓ | Vehicle mode: rolling, ICR, scrub, differential, suspension | Done: 5590 phase 5 3/3 — 10 tyres on 3 axles (front steered, 8 trailer tyres towed), drives a 755 LDU circle as posed with each wheel at its own spin (outer 3.29, inner 2.61 turns per 1000 LDU); tandem axles scrub −4.58° / +4.58° (atan(60/755) = 4.54°); its parallel steering leaves a 54.8 LDU Ackermann error. 42000 phase 5 3/3 — 4 wheels on 2 axles; both rear suspensions sweep 31.4 LDU with 0.000° bump steer and no camber gain, shock stroke −24..+18 LDU from the parts. 5590 phase 3 17/17, 42000 phase 3 16/18, 8880 phase 4 5/7 unchanged. vitest 1014 pass (minifig fails as before; four timing tests miss only under full parallel load and pass alone), verify:v8:all pass, tsc and vite build clean |
| 6 | Tracks, chains, ropes | Track links never stretch (pitch error < 0.01 LDU); hook height = winch maths to 0.1 LDU |

## 9. Where this goes beyond Kinebrick

Kinebrick has measured parts, curated per-set functions and good meshing rules.
On top of that, this design adds:
- computed joint types (screw theory) instead of rules per connector;
- exact mobility (local dimension test), not just Jacobian rank;
- one solver that runs several drivers at once and stops at singularities;
- gear shifting as explicit modes with crash detection;
- vehicle-level checks (Ackermann error, scrub, bump steer);
- exact chain and track placement (polygon effect);
- a scored, reproducible benchmark that every change must improve.

## 10. Caveats on sources

Xiong et al. 2016, Wampler–Hauenstein–Sommese, Müller 2015 (cut joints)
and the hypo-paradoxical linkages paper were read in full (Phase 1 is built on them). The other papers
were read from abstracts and published summaries. The formulas above are standard kinematics, written for this design.
One web formula for camber gain (Firgelli blog) has inconsistent units and was
not used.

[xiong]: https://ideas.repec.org/a/hin/jnlmpe/1761968.html
[dawari]: https://etd.iisc.ac.in/handle/2005/2277
[nd]: https://bertini.nd.edu:443/LocalDimFinder/Mechanism_Mobility.pdf
[wampler]: https://academicweb.nd.edu/~cwample1/Preprints/Exceptional_Mechanisms_via_Numerical_Algebraic_Geometry.pdf
[hypo]: https://arxiv.org/html/2507.20371v2
[cutjoint]: https://ms.copernicus.org/articles/6/137/2015/ms-6-137-2015.pdf
[xpbd]: https://ipsj.ixsq.nii.ac.jp/record/183598/files/IPSJ-CG17167010.pdf
[xpbd-rb]: https://diglib.eg.org/handle/10.1111/cgf14105
[jjmie]: https://jjmie.hu.edu.jo/vol17/vol17-1/10-JJMIE-278-22.pdf
[zcu]: https://otik.uk.zcu.cz/handle/11025/34963?locale=en
[cvut]: https://dspace.cvut.cz/handle/10467/85182
[ackermann]: https://the-contact-patch.com/book/road/c0504-ackermann-geometry
[sae]: https://saemobilus.sae.org/content/2006-01-3638
[tanik]: https://openaccess.hacettepe.edu.tr/handle/11655/18993?show=full
[altair]: https://help.altair.com/hwsolvers/ms/topics/tutorials/mv/tut_mv_7031_tracked_vehicle_modeling.htm
[polygon]: https://inderscience.com/filter.php?aid=136243
[cosserat]: https://diglib.eg.org/handle/10.2312/sca20161234
