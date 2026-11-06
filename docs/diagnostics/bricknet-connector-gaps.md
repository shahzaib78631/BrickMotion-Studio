# BrickNet connector catalogue vs the editor's connectors

BrickNet (Kulits & Schmid, CVPR 2026, MIT; copy in `python/knowledge/bricknet`) labels 14,603
parts with typed connectors. This compares it with what the editor sees for each part: LDCad
shadow snaps after `SNAP_INCL`/`SNAP_CLEAR` (`src/ldraw/shadow.ts`), the local patches
(`shadowPatches.ts`), `connectorLibrary.ts` and the generated wheel seats. These are the same
snaps `PartLibrary.loadPart` returns. The hand-written cases in `src/ldraw/connectors.ts`
(the 2878 bogie, the 3816/3817 feet and the 3899 cup) are underside socket faces for build
ordering, not snaps. They overlap no BrickNet gap below.

Reproduce: `npx tsx scripts/bricknet-connectors.ts audit` (about 8 minutes; needs `public/ldraw`,
`public/data/ldcad-shadow.json` and the `xz` command).

## Families

BrickNet → family: `stud`/`open`/`hole`/`tube`/`post` → stud; `axle`: `pin`/`socket`/`axle`/`cross`/`hole`
→ axle; `axle`: `bar`/`clip` → clip/bar; `hinge`, `ball`, `fixed` as named.

Editor snap → family (heuristic): `SNAP_CLP` → clip/bar; `SNAP_FGR` → hinge; `SNAP_GEN` sph → ball,
other `SNAP_GEN` → fixed; `SNAP_CYL` with an `A` section → axle; with an `S` section, or round,
radius 6 and at most 6.5 long without slide → stud; radius ≤ 4.6 → clip/bar (bars, bar holes);
other round (pins, pin holes) → axle.

## Palette (public/data/catalog.json: 24,640 parts; 15,737 resolve to a BrickNet part)

| family | parts with BrickNet rows | editor has none | editor has fewer |
| --- | ---: | ---: | ---: |
| stud/hole | 14,091 | 3,065 | 6,176 |
| axle/pin/socket/cross | 5,424 | 450 | 279 |
| clip/bar | 6,966 | 1,239 | 746 |
| hinge | 2,056 | 1,713 | 5 |
| ball | 168 | 72 | 6 |
| fixed | 2,609 | 2,445 | 155 |
| hinge or ball, and no rotational connector at all (no finger, clip, round pin or ball) | 2,217 | 178 | |

947 palette parts have no editor snaps at all but have BrickNet connectors.

## BrickHeadz corpus (79 models, 579 distinct parts, 438 resolve)

| family | parts with BrickNet rows | editor has none | editor has fewer | "none" weighted by uses |
| --- | ---: | ---: | ---: | ---: |
| stud/hole | 409 | 30 | 244 | 98 |
| axle | 37 | 0 | 2 | 0 |
| clip/bar | 262 | 32 | 18 | 304 |
| hinge | 11 | 2 (2429, 2430) | 0 | 12 |
| ball | 1 | 0 | 0 | 0 |
| fixed | 0 | 0 | 0 | 0 |

## What the gaps are

- **Stud/hole "fewer"** is mostly counting granularity: BrickNet has a row per hole, tube and
  post, while LDCad describes an underside with a few grid snaps. Placement snapping does not depend on
  it anyway: `plan/connectors.ts` takes studs from the measured geometry and sockets from the
  body grid, and only pins and bars from the shadow snaps.
- **Stud "none" and clip/bar "none"** in the corpus are mostly one connection that BrickNet labels and
  the editor deliberately leaves out: a bar pushed into a hollow stud. BrickNet labels the hollow of
  an open stud `axle/clip` and the end of a bar `hole/post` (3062b, 4070, 24201, 30374, 87994,
  3957b and others). `plan/connectors.ts` excludes the 4 LDU stud hollow from its bar family on
  purpose. In the palette, the rest are old or rare parts with no shadow file (277, 502, 506, 776…).
- **Hinge**: 1,713 parts have BrickNet hinges and no LDCad finger, but most of them already turn on
  a round pin or a clip (2429/2430 turn on their R4 pivot pin; minifig hands on their wrist pin).
  178 parts have no rotational connector at all. Also, the editor locks every minifig arm to its
  torso. The shoulder peg is round, 6 LDU across and 7 long, so `connectorFreedom` reads it as
  a stud friction fit ("fixed"). BrickNet says it is a hinge.
- **Ball**: 72 parts with BrickNet balls have none in the editor: 2908, 3779, 6253, 20474,
  23922(c01/c02), 24010, 24190, 30187c0x, 30395, the printed 32474p01/p02, 817c0x and others.
  `shadow.ts` does parse balls (`SNAP_GEN bounding=sph … placement=free`), and smart joints
  already turn them; these parts just have no shadow entry.
- **Fixed**: 2,445 parts (minifig torsos, hips, old assemblies, …). These are rigid attachments,
  not rotations.

## What was implemented

`src/data/bricknetConnectors.generated.ts` (from `scripts/bricknet-connectors.ts generate`): the
hinge and ball rows of 1,524 parts (2,617 connectors, 105 aliases), listed only where some palette
part using them has no LDCad snap of that family. `src/data/bricknetJoints.ts` turns them into
snaps (`source: 'bricknet'`):

- hinge → `SNAP_FGR`-like finger, group `bricknet-hinge<type>`, axis = frame -Y (pitch about x,
  roll about z), 2.5 LDU long, centred on the row, so it keeps BrickNet's 3 LDU matching tolerance
  along the axis (1.2 LDU across, as for every finger).
- ball → `SNAP_GEN sph placement=free`, with LDCad's own conventions so the snaps also mate LDCad
  balls: type 0 = group `techBallJnt`, radius 12.7; type 1 = `match=size`, radius 8.
- BrickNet `in` is the male side and `on` the female (checked against LDCad 3731/3730 and 3938/3937).

They are used by smart joints (`detectEditorJoints`) and by hinge and ball placement (next
section), and only for a part with no LDCad finger (hinges) or no LDCad ball (balls). They are
never added to `PartMetrics.snaps`, so collision columns, bores, stud/pin/bar targets and build
animation are unchanged: a finger snap there would become a bar-sized collision column and a
minifig-hand placement target.

Per pair of parts, LDCad stays primary (`preferLdcad` in `smartJoints.ts`):

1. If LDCad gives the pair a moving mate (pin, clip, finger, ball), BrickNet is ignored.
2. Otherwise a BrickNet hinge or ball replaces the LDCad "fixed" mates within 6 LDU of its own
   pivot. That fixed label is the editor's own guess from the connector size, not LDCad data.
   LDCad mates elsewhere on the pair (studs) still lock it.

Effects: minifig arms hinge at the shoulder (plain, printed and alias torsos). Printed ball parts and the
72 ball-less parts get ball joints, which also work against LDCad balls. Snap-less hinge pairs of the same BrickNet type
hinge. Joints that use BrickNet data say so in the joint status line ("Estimated from BrickNet
connector data …").

## Hinge and ball placement snapping

Drag placement can now drop a part onto a hinge or a ball. `plan/connectors.ts` has two more
connector types, `hinge` and `ball`, from `jointConnectors`: the part's LDCad balls
(`SNAP_GEN sph`) plus the BrickNet fallback hinges and balls above. Each carries a `fit` key it
must match, as LDCad mates them: the snap group, or for an ungrouped `match=size` ball its
radius (`r:8.0`). LDCad fingers are left as they were (a hand's grip, `bar`), since their halves
carry no consistent gender.

- **Where they are used.** Only drag placement (`state/placing.ts`, via `placementConnectors`)
  and the collision allowance below. `partConnectors` is unchanged, so fit, documented
  attachments and build-order connections see the same connectors as before.
- **Seat rule** (`seat` in `placementEngine.ts`, `connectorsMate` in `connectors.ts`). A ball
  seats on its centre alone and keeps the part's orientation; R turns it about the vertical
  through the ball. A hinge seats with its axis on the target's line, whichever way round turns
  the part least; R swings it about the hinge in quarter turns. Studs, pins and bars still need
  opposed axes.
- **Picking.** A joint target is taken from any side (a hinge axis is a line, a ball has none),
  and may sit up to 16 LDU behind the surface the mouse ray hits, since a ball centre is inside
  its part (`JOINT_OCCLUDE_SLACK` in `aim.ts`).
- **Collision allowance** (`collision.ts`). A ball sits inside its socket and hinge knuckles
  inside each other, so the mesh test would always refuse a seated joint. Material is exempt only
  between the two parts whose joint halves meet (same type and fit, opposite gender, centres
  within 1.5 LDU, hinge axes parallel), and only near the joint: within the ball radius + 3 LDU of
  the centre, or within 8 LDU of the hinge axis and 12 LDU along it from the pivot. Solids carry
  their joints (`Solid.joints`, set by `solidsFor`). Nothing else in the collision rules changed.

Tests: `tests/plan/jointPlacement.test.ts`. Real-part cases: a 23922 socket dropped onto a 2908
ball (it is refused without the allowance, and again 4 LDU off the ball), the same socket onto
3731's LDCad ball, and a 3819 arm onto the 973 torso's shoulder hinge, then swung with R.

Limits: the hinge allowance is a fixed cylinder, so a hinge whose knuckles reach further than
12 LDU from its BrickNet pivot (a wide hinge plate) can still be refused. Hinge angles step in
quarter turns, like every R turn.

## Not done, and what it would take

- **BrickNet hinge ↔ LDCad finger.** BrickNet hinge types do not map onto LDCad finger groups with a
  consistent gender (LDCad gives both halves of a locking hinge `genderOfs=M`), so a BrickNet hinge
  only mates another BrickNet hinge. A reviewed type → group table would let one side come from
  each source.
- **Fixed connectors.** These would become `fixed` joints and lock selections that move freely
  today (missing data reads as "free"). Their rows also carry an orientation (yaw 90/270 pairs)
  that needs its own mating rule. Review them before using them.
- **Bar into a hollow stud.** BrickNet has this data. The editor excludes the 4 LDU hollow from the
  bar family on purpose, so this is a placement-rule decision.
