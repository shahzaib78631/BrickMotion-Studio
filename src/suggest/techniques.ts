/**
 * Building techniques, from the Brick Builder's Handbook techniques index
 * (https://brickbuildershandbook.com/lego-building-techniques-index/, 36 entries, read
 * 2026-11-06 and written up in our own words) plus a few common techniques.
 *
 * A technique with a `recipe` can be placed: each step puts one part on a free connector of
 * the anchor (the selected piece, step -1) or of an earlier step, on a face named in that
 * piece's own frame ('top' = its studs, 'side' = a sideways stud or hole, 'under' = its
 * underside). The suggestion engine seats every step with the editor's own connectors and
 * collision test, so a recipe is only offered where it really fits. `calc` names a
 * calculator in geometry.ts for the techniques that are maths rather than parts.
 */

export type Face = 'top' | 'side' | 'under';
export type RecipeStep = { part: string; on: number; face: Face };
export type Technique = {
  id: string;
  section: string;
  name: string;
  url: string;
  /** what it is for, in one line */
  goal: string;
  /** LDraw part ids it uses */
  parts: string[];
  /** the geometry that makes it work */
  rule: string;
  steps: string[];
  pitfall?: string;
  recipe?: RecipeStep[];
  calc?: 'angledWall' | 'roundWall' | 'wedgeFor' | 'technicPolygon' | 'lowellSphere' | 'snotSpacing' | 'taper';
  /** words a search box should find it by */
  tags: string[];
};

const HB = 'https://brickbuildershandbook.com';
const SNOT = `${HB}/2022/01/20/isnt-that-stud-supposed-to-be-on-top-no-its-snot-building-sideways-using-lego`;
const JUMP = `${HB}/2021/12/01/dont-underestimate-that-jumper-plate-half-stud-offsets-in-lego-models`;
const ANGLE = `${HB}/2021/11/15/thinking-outside-the-grid-building-angled-walls-using-lego`;
const ROUND = `${HB}/2021/09/05/squaring-the-circle-building-round-shapes-using-lego`;
const MATH1 = `${HB}/2022/01/29/the-math-behind-lego-building-techniques-volume-1`;
const MATH2 = `${HB}/2022/05/16/the-math-behind-lego-building-techniques-volume-2`;
const MATH3 = `${HB}/2023/08/11/the-math-behind-lego-building-techniques-volume-3/`;

export const TECHNIQUES: Technique[] = [
  // ---------------------------------------------------------------- 1. SNOT
  {
    id: 'snot-geometry', section: 'Building sideways (SNOT)', name: 'The geometry of LEGO bricks', url: `${SNOT}#geometry-LEGO-bricks`,
    goal: 'Know which sideways and upright sizes line up.',
    parts: [], rule: '1 stud = 20 LDU = 2.5 plates; 1 brick = 3 plates; so 2 studs = 5 plates = 1 brick + 2 plates. A 1×6 plate on its side is 15 plates, the height of 5 bricks.',
    steps: ['Count sideways lengths in plates (2.5 per stud).', 'Make every sideways section a whole number of plates, or plan a half-plate offset.'],
    calc: 'snotSpacing', tags: ['snot', 'sideways', 'measure', 'plates', 'grid'],
  },
  {
    id: 'snot-headlight', section: 'Building sideways (SNOT)', name: 'Headlight brick', url: `${SNOT}#headlight-brick`,
    goal: 'Get one sideways stud from a 1×1 footprint.',
    parts: ['4070', '3070b'], rule: 'Its side stud is recessed half a plate; the back has a square anti-stud, so it also attaches turned 90°. Four make a square with studs on four sides, eight a cube with studs on six.',
    steps: ['Put a headlight brick on a top stud.', 'Attach a tile or plate to its side stud (it sits half a plate further in than a plain brick face).'],
    recipe: [{ part: '4070', on: -1, face: 'top' }, { part: '3070b', on: 0, face: 'side' }],
    tags: ['snot', 'headlight', 'erling', 'side stud', 'recessed', 'detail'],
  },
  {
    id: 'snot-side-stud-brick', section: 'Building sideways (SNOT)', name: 'Bricks with studs on their sides', url: `${SNOT}#bricks-studs-on-sides`,
    goal: 'Turn the next layer of detail 90° so tiles and slopes face outward.',
    parts: ['87087', '47905', '26604', '4733', '32952', '3070b'],
    rule: 'Side studs line up with the grid when side-stud layers are 1 brick + 2 plates (5 plates = 2 studs) apart.',
    steps: ['Build side-stud bricks into the wall.', 'Attach plates, tiles or slopes to the side studs.'],
    recipe: [{ part: '87087', on: -1, face: 'top' }, { part: '3070b', on: 0, face: 'side' }],
    tags: ['snot', 'side stud', '87087', 'tile', 'facade', 'wall'],
  },
  {
    id: 'snot-corner', section: 'Building sideways (SNOT)', name: 'Corner with studs on two adjacent sides', url: `${SNOT}#bricks-studs-on-sides`,
    goal: 'Wrap sideways detail round an outside corner.',
    parts: ['26604', '3070b'], rule: 'The 1×1 with studs on two adjacent sides goes at the corner; single side-stud bricks fill the faces between.',
    steps: ['Put the two-sided brick on the corner stud.', 'Tile both faces.'],
    recipe: [{ part: '26604', on: -1, face: 'top' }, { part: '3070b', on: 0, face: 'side' }, { part: '3070b', on: 0, face: 'side' }],
    tags: ['snot', 'corner', 'column', '26604'],
  },
  {
    id: 'snot-two-sides', section: 'Building sideways (SNOT)', name: 'Studs on two opposite sides', url: `${SNOT}#bricks-studs-on-sides`,
    goal: 'Sideways detail on both faces of a thin wall or column.',
    parts: ['47905', '3070b'], rule: 'Same 5-plate rhythm as single side-stud bricks.',
    steps: ['Put the two-sided brick on a top stud.', 'Attach a tile to each side.'],
    recipe: [{ part: '47905', on: -1, face: 'top' }, { part: '3070b', on: 0, face: 'side' }, { part: '3070b', on: 0, face: 'side' }],
    tags: ['snot', 'column', 'both sides', '47905'],
  },
  {
    id: 'snot-wall-spacing', section: 'Building sideways (SNOT)', name: 'Sandwich two plates between side-stud layers', url: `${SNOT}#bricks-studs-on-sides`,
    goal: 'A sideways tile or plate that spans two side-stud layers.',
    parts: ['87087', '3024', '3069b'], rule: '1 brick + 2 plates = 5 plates = 2 studs, so the side studs of the two layers are exactly 2 studs apart.',
    steps: ['Side-stud brick.', 'Two 1×1 plates on it.', 'Another side-stud brick.', 'A 1×2 tile across both side studs, standing up.'],
    recipe: [
      { part: '87087', on: -1, face: 'top' }, { part: '3024', on: 0, face: 'top' }, { part: '3024', on: 1, face: 'top' },
      { part: '87087', on: 2, face: 'top' }, { part: '3069b', on: 3, face: 'side' },
    ],
    tags: ['snot', 'spacing', 'sandwich', 'two plates', 'facade', 'grid'],
  },
  {
    id: 'snot-plate-side-studs', section: 'Building sideways (SNOT)', name: 'Plates with studs on their sides', url: `${SNOT}#plates-studs-on-sides`,
    goal: 'Sideways studs that also strap the layer together.',
    parts: ['99206', '87609', '3069b'], rule: 'The modified plate is 2 plates thick, so it replaces the two sandwiched plates: brick + this plate = 5 plates.',
    steps: ['Put the 2×2 plate with side studs on a 2×2 area of studs.', 'Attach tiles to its side studs.'],
    recipe: [{ part: '99206', on: -1, face: 'top' }, { part: '3069b', on: 0, face: 'side' }],
    tags: ['snot', '99206', 'plate', 'side stud', 'roof'],
  },
  {
    id: 'snot-bracket', section: 'Building sideways (SNOT)', name: 'Brackets', url: `${SNOT}#brackets`,
    goal: 'A sideways mounting face sticking out from a plate.',
    parts: ['99781', '36841', '44728', '3023b'], rule: 'The extension is half a plate thick. A regular bracket\'s extension is flush with the plate\'s top.',
    steps: ['Put the bracket on a top stud.', 'Attach a plate or tile to the upright face.'],
    recipe: [{ part: '99781', on: -1, face: 'top' }, { part: '3023b', on: 0, face: 'side' }],
    tags: ['snot', 'bracket', 'mount', 'face', '99781'],
  },
  {
    id: 'snot-half-plate', section: 'Building sideways (SNOT)', name: 'Half-plate offsets', url: `${SNOT}#half-plate-offsets`,
    goal: 'Push a sideways section out (or in) by half a plate, for an odd number of studs.',
    parts: ['99780', '4070', '3024', '3023b'], rule: 'An even number of studs is a whole number of plates (2 studs = 5); an odd number leaves half a plate. Inverted brackets push out half a plate; a headlight brick sits half a plate in.',
    steps: ['Put an inverted bracket on a top stud.', 'Attach the sideways section to its face; it now stands half a plate further out.'],
    pitfall: 'A 1-stud curved slope + 1×1 plate is only 2 plates thick and sits half a plate in; one more plate makes it stick out. Use the inverted bracket.',
    recipe: [{ part: '99780', on: -1, face: 'top' }, { part: '3023b', on: 0, face: 'side' }],
    tags: ['snot', 'offset', 'half plate', 'inverted bracket', 'flush'],
  },
  {
    id: 'snot-quarter-plate', section: 'Building sideways (SNOT)', name: 'Quarter-plate offsets', url: `${SNOT}#quarter-plate-offsets`,
    goal: 'Mostly academic: sideways faces a quarter plate apart.',
    parts: ['4070', '87087', '15573', '3024'], rule: 'Half a stud is 1.25 plates, and 1.25 − 1 = 0.25. Two side-stud bricks side by side, one moved by a jumper plate and the other given a 1×1 plate on its face: their fronts are 0.25 plate apart.',
    steps: ['Headlight brick + 1 plate = 3 plates.', 'Jumper (1.25) + headlight (2) = 3.25.', 'Side-stud brick (2.5) + 1 plate = 3.5.', 'Jumper + side-stud brick = 3.75.', 'Plate + bracket + plate = 4; with a jumper = 4.25.'],
    tags: ['snot', 'quarter plate', 'offset', 'fine'],
  },
  {
    id: 'snot-stud-reversal', section: 'Building sideways (SNOT)', name: 'Stud reversal', url: `${SNOT}#stud-reversal`,
    goal: 'Turn studs 180° so a section faces down or back.',
    parts: ['87087', '47905', '99780'], rule: 'Two SNOT turns of 90° make 180°. Build the two halves with studs facing opposite ways and join them with side-stud bricks.',
    steps: ['Build a side-stud layer.', 'Attach the reversed section to it, then turn again with a second side-stud brick.'],
    recipe: [{ part: '47905', on: -1, face: 'top' }, { part: '3023b', on: 0, face: 'side' }],
    tags: ['snot', 'reverse', 'upside down', '180'],
  },
  // ---------------------------------------------------------------- 2. jumper plates
  {
    id: 'jumper-half-stud', section: 'Half-stud offsets (jumper plates)', name: 'Half-stud offset in one direction', url: `${JUMP}#half-stud-offsets`,
    goal: 'Set a wall or window back half a stud.',
    parts: ['15573', '3794b', '3004'], rule: 'A 1×2 jumper has one stud midway between where a 1×2 plate\'s two would be: everything on it moves half a stud.',
    steps: ['Put a 1×2 jumper plate where the setback starts.', 'Build the recessed section on it.', 'Add a jumper above the opening too, to get back on the grid.'],
    pitfall: 'One offset must be countered or the wall above stays off the grid.',
    recipe: [{ part: '15573', on: -1, face: 'top' }, { part: '3004', on: 0, face: 'top' }],
    tags: ['jumper', 'half stud', 'offset', 'recess', 'window'],
  },
  {
    id: 'jumper-two-way', section: 'Half-stud offsets (jumper plates)', name: 'Half-stud offset in two directions', url: `${JUMP}#half-stud-offsets`,
    goal: 'Offset half a stud both ways, e.g. to centre a part.',
    parts: ['87580', '34103', '65509'], rule: 'The 2×2 jumper\'s single stud is at the centre of its four.',
    steps: ['Put a 2×2 jumper on a 2×2 area.', 'Build on its centre stud.'],
    recipe: [{ part: '87580', on: -1, face: 'top' }],
    tags: ['jumper', '2x2', 'centre', 'center', 'offset'],
  },
  {
    id: 'jumper-recess', section: 'Half-stud offsets (jumper plates)', name: 'Recessed walls and windows', url: `${JUMP}#recessed-wall-sections`,
    goal: 'A subtle recess in a facade.',
    parts: ['15573'], rule: 'Half-stud setback with a counter-offset above.',
    steps: ['Jumper under the recessed section.', 'Counter-jumper above the window.'],
    tags: ['jumper', 'recess', 'window', 'facade'],
  },
  {
    id: 'jumper-centering', section: 'Half-stud offsets (jumper plates)', name: 'Centring odd on even widths', url: `${JUMP}#centering-odd-even-studs`,
    goal: 'Centre a 1-wide (or 7-wide) part on a 2-wide (or 6-wide) one.',
    parts: ['15573', '3005'], rule: 'Odd over even is half a stud off centre: a jumper fixes it.',
    steps: ['Put a jumper across the two middle studs.', 'Put the odd-width part on its centre stud.'],
    recipe: [{ part: '15573', on: -1, face: 'top' }, { part: '3005', on: 0, face: 'top' }],
    tags: ['jumper', 'centre', 'center', 'odd', 'even', 'symmetry'],
  },
  {
    id: 'jumper-taper', section: 'Half-stud offsets (jumper plates)', name: 'Smoother tapers', url: `${JUMP}#smoother-tapers`,
    goal: 'A tower that narrows smoothly.',
    parts: ['87580'], rule: 'Plain parts step in 1 stud per side about every 4 floors; 2×2 jumpers step half a stud per side every 2.',
    steps: ['Work out the taper rate.', 'Step in with jumpers where plain parts would jump too far.'],
    pitfall: 'Where vertical wings meet a tapered wall, half-stud gaps appear; cover them with tiles.',
    calc: 'taper', tags: ['jumper', 'taper', 'tower', 'pyramid', 'skyscraper'],
  },
  {
    id: 'jumper-taper-2d', section: 'Half-stud offsets (jumper plates)', name: 'Tapering by different amounts each way', url: `${JUMP}#tapering-unequal-amounts`,
    goal: 'Long and short sides narrowing at different rates.',
    parts: ['15573', '87580'], rule: 'Mix 1×2 jumpers in two orientations with 2×2 jumpers so each side steps at its own rate.',
    steps: ['Taper rate per side.', 'Turn the 1×2 jumpers to step along one axis only.'],
    calc: 'taper', tags: ['jumper', 'taper', 'unequal', 'tower'],
  },
  {
    id: 'jumper-clutch', section: 'Half-stud offsets (jumper plates)', name: 'Jumpers at seams', url: `${JUMP}#other-uses-jumper-plates`,
    goal: 'A section that lifts off cleanly.',
    parts: ['15573'], rule: 'A jumper holds the layer below (2 anti-studs) harder than the one above (1 stud).',
    steps: ['Tile the seam.', 'Mix in a few jumpers so the top section clicks on but comes off where you want.'],
    recipe: [{ part: '15573', on: -1, face: 'top' }],
    tags: ['jumper', 'seam', 'removable', 'clutch', 'modular'],
  },
  {
    id: 'jumper-technic-snot', section: 'Half-stud offsets (jumper plates)', name: 'SNOT with half-stud offset (Technic)', url: `${JUMP}#SNOT-half-stud-offsets`,
    goal: 'A sideways stud half a stud off the usual grid.',
    parts: ['3700', '4274'], rule: 'A Technic brick\'s hole sits between its studs; a half pin in it becomes a side stud half a stud over.',
    steps: ['Technic 1×2 brick with hole.', 'Half pin into the hole: a sideways stud.'],
    recipe: [{ part: '3700', on: -1, face: 'top' }, { part: '4274', on: 0, face: 'side' }],
    tags: ['technic', 'pin', 'snot', 'half stud', 'offset'],
  },
  // ---------------------------------------------------------------- 3. angled walls
  {
    id: 'angle-basics', section: 'Angled walls', name: 'Angled wall basics (3-4-5)', url: `${ANGLE}#angled-wall-basics`,
    goal: 'A wall at an angle with no gaps at its ends.',
    parts: ['3024', '3009'], rule: '3² + 4² = 5²: two 1×1 plates 3 and 4 studs from a corner are 5 studs apart, the end-stud distance of a 1×6 brick. Exact right triangles up to 25: 3-4-5, 5-12-13, 6-8-10, 7-24-25, 8-15-17, 9-12-15, 12-16-20.',
    steps: ['Pick a triangle for the angle.', '1×1 plates as spacers at the two legs.', 'Bridge them with a brick one stud longer than the span.'],
    calc: 'angledWall', tags: ['angle', 'diagonal', 'pythagoras', 'triangle', 'wall'],
  },
  {
    id: 'angle-hinge', section: 'Angled walls', name: 'Angled walls with hinge plates', url: `${ANGLE}#angled-walls-using-hinges`,
    goal: 'An angled wall without corner gaps.',
    parts: ['73983', '78329'], rule: 'Two 1×4 hinge plates bridged by a 1×5 plate span 5 studs corner to corner (3-4-5).',
    steps: ['Two hinge plates on the base.', 'Bridge them with a plate as long as the span.', 'Swing to the triangle\'s angle.'],
    calc: 'angledWall', tags: ['angle', 'hinge', 'wall', 'diagonal'],
  },
  {
    id: 'angle-turntable', section: 'Angled walls', name: 'Angled walls with turntables', url: `${ANGLE}#angled-walls-using-turntables`,
    goal: 'Angle a whole section, e.g. a bridge.',
    parts: ['3680c01', '61485'], rule: 'Measure the triangle between the turntables\' centres (6-8-10 in LEGO 80107).',
    steps: ['Turntable on the base.', 'Build the angled section on its top.'],
    recipe: [{ part: '3680c01', on: -1, face: 'top' }],
    calc: 'angledWall', tags: ['angle', 'turntable', 'rotate', 'bridge'],
  },
  {
    id: 'angle-near-triples', section: 'Angled walls', name: 'Near triples', url: `${ANGLE}#near-triples`,
    goal: '45° (and other) walls where no exact triangle exists.',
    parts: ['73983'], rule: 'Close-enough triangles with hinge play: 5-5-7, 7-7-10, 12-12-17, 17-17-24 (45°); 4-7-8, 4-8-9.',
    steps: ['Pick a near triple.', 'Join with hinges so the small mismatch is taken up.'],
    calc: 'angledWall', tags: ['angle', '45', 'near triple', 'chamfer', 'octagon'],
  },
  {
    id: 'angle-jumper', section: 'Angled walls', name: 'Angled walls with jumper plates', url: `${ANGLE}#angled-walls-jumper-plates`,
    goal: 'More angle choices with half-stud legs.',
    parts: ['15573'], rule: 'Jumpers allow half-stud legs: 8.5-8.5-12 is half of 17-17-24.',
    steps: ['Halve a triple.', 'Put the half-stud end on a jumper.'],
    calc: 'angledWall', tags: ['angle', 'jumper', 'half stud'],
  },
  {
    id: 'angle-mirrored', section: 'Angled walls', name: 'Mirrored hypotenuse', url: `${ANGLE}#mirrored-hypotenuse`,
    goal: 'Angles whose span is not a whole number of studs.',
    parts: ['54384', '54383', '73983'], rule: 'Mirror the triangle across its long side and build along the other two. Two mirrored 6×3 wedges (18.43° each) give 36.87°, the 3-4-5 angle (tan 2θ = 3/4).',
    steps: ['Find the wedge angle (half the angle you want).', 'Mirror two wedges.', 'Join the triangles with hinges.'],
    calc: 'wedgeFor', tags: ['angle', 'wedge', 'mirror', 'floor', 'roof'],
  },
  {
    id: 'angle-switched', section: 'Angled walls', name: 'Switched diagonals', url: `${ANGLE}#switched-diagonals`,
    goal: 'A plate turned to nearly 45°.',
    parts: ['3035', '3024'], rule: 'A rectangle\'s two diagonals are equal: turn it so one diagonal lies where the other was. A 4×8 plate comes closest to 45°.',
    steps: ['1×1 plates as spacers at the corners.', 'Turn the plate so its other diagonal lines up.'],
    tags: ['angle', 'diagonal', 'rotate', 'plate'],
  },
  // ---------------------------------------------------------------- 4. round shapes
  {
    id: 'round-snot-cylinder', section: 'Round shapes', name: 'Small cylinders with SNOT', url: `${ROUND}#SNOT-small-cylinders`,
    goal: 'A round column, any diameter, in 2-stud heights.',
    parts: ['4733', '11477', '15068'], rule: 'A SNOT core with curved slopes on every side.',
    steps: ['1×1 brick with studs on four sides.', 'A curved slope on each side stud.'],
    recipe: [
      { part: '4733', on: -1, face: 'top' }, { part: '11477', on: 0, face: 'side' }, { part: '11477', on: 0, face: 'side' },
      { part: '11477', on: 0, face: 'side' }, { part: '11477', on: 0, face: 'side' },
    ],
    tags: ['round', 'cylinder', 'column', 'curved', 'snot', 'minaret'],
  },
  {
    id: 'round-bending', section: 'Round shapes', name: 'Bent walls', url: `${ROUND}#bending-LEGO-walls`,
    goal: 'Large smooth circles.',
    parts: ['3004'], rule: 'About 72 1×2 bricks per layer bend into a stable circle.',
    steps: ['Lay 1×2 bricks in a ring, each on one stud of the one below.'],
    pitfall: 'Most brick bending strains parts (not a legal technique), and digital tools cannot reproduce it.',
    tags: ['round', 'circle', 'bend', 'wall'],
  },
  {
    id: 'round-round-bricks', section: 'Round shapes', name: 'Round bricks between straight ones', url: `${ROUND}#mixing-regular-round-bricks`,
    goal: 'Legal round walls, smaller than bending allows.',
    parts: ['3062b', '3622', '4070', '2431'], rule: '1×1 round bricks act as hinges between 1×3 (or 1×2) bricks. Variant: headlight bricks joined by 1×3 plates, faced with 1×4 tiles.',
    steps: ['Alternate round 1×1 bricks and 1×3 bricks.', 'Bend at the round bricks.', 'Tile the face to hide the texture.'],
    recipe: [{ part: '3062b', on: -1, face: 'top' }],
    tags: ['round', 'wall', 'circle', 'hinge'],
  },
  {
    id: 'round-hinge-wall', section: 'Round shapes', name: 'Round walls from hinge plates', url: `${ROUND}#round-walls-using-hinges`,
    goal: 'A round wall of exact polygon sides.',
    parts: ['73983'], rule: 'Each 1×4 hinge plate is two 2-stud sides: plates ≈ π·d / 4, turn 360 / (2n). 18 studs inside → 14 plates, 28 sides, 12.86°. 14 and 23 also work.',
    steps: ['Work out the number of hinge plates.', 'Set each hinge to the turn angle.', 'Fix the ring to the base at its grid-aligned points.'],
    pitfall: 'Held at only 2 or 4 points the ring can distort.',
    calc: 'roundWall', tags: ['round', 'hinge', 'circle', 'polygon', 'tower'],
  },
  {
    id: 'round-digital', section: 'Round shapes', name: 'Round walls digitally', url: `${ROUND}#building-round-walls-digitally`,
    goal: 'Set exact hinge angles in a digital model.',
    parts: ['73983'], rule: 'Enter the turn angle (360 / sides) on each hinge.',
    steps: ['Select a hinge.', 'Type the angle.', 'Copy the hinge pair round the ring.'],
    calc: 'roundWall', tags: ['round', 'hinge', 'digital', 'angle'],
  },
  {
    id: 'round-sphere-stack', section: 'Round shapes', name: 'Spheres by stacking', url: `${ROUND}#spheres-by-stacking`,
    goal: 'A sphere from layers.',
    parts: ['3005', '3024'], rule: 'A 1×1 brick is 6/5 as tall as wide, so stack an ellipsoid 5/6 as tall (e.g. 36 × 36 × 30); with plates use 5/2.',
    steps: ['Generate an ellipsoid at the brick ratio.', 'Build it layer by layer.'],
    tags: ['sphere', 'ball', 'dome', 'stack', 'round'],
  },
  {
    id: 'round-lowell', section: 'Round shapes', name: 'Lowell spheres', url: `${ROUND}#lowell-spheres`,
    goal: 'A smooth sphere with no visible gaps.',
    parts: ['4733', '4070'], rule: 'A SNOT cube core with studs in six directions and six identical curved panels of plates, each longer than wide so they interlock. Diameter = core + 2 × panel plates / 2.5 (16 + 28 / 2.5 = 27.2).',
    steps: ['Build a SNOT core.', 'Build one panel, stagger its seams, reuse it six times.'],
    calc: 'lowellSphere', tags: ['sphere', 'lowell', 'dome', 'snot', 'round'],
  },
  // ---------------------------------------------------------------- 5. maths case studies
  {
    id: 'math-boutique', section: 'Maths case studies', name: 'Boutique Hotel 10297', url: `${MATH1}#boutique-hotel`,
    goal: 'Angled walls, floor and roof that agree.',
    parts: ['73983', '54384', '54383'], rule: 'Six 3-4-5 triangles (36.87°); two mirrored 6×3 wedges give the same angle for floors and roof.',
    steps: ['3-4-5 walls on hinges.', 'Mirrored 6×3 wedges to match the angle in the floor.'],
    calc: 'wedgeFor', tags: ['angle', 'case study', 'modular', 'wedge'],
  },
  {
    id: 'math-lantern', section: 'Maths case studies', name: 'Spring Lantern Festival 80107', url: `${MATH2}#spring-lantern-festival`,
    goal: 'A footbridge at an angle.',
    parts: ['61485'], rule: '4×4 turntables on a 6-8-10 triangle.',
    steps: ['Turntables at the triangle\'s ends.', 'Bridge across.'],
    calc: 'angledWall', tags: ['angle', 'turntable', 'bridge', 'case study'],
  },
  {
    id: 'math-garage', section: 'Maths case studies', name: 'Corner Garage 10264', url: `${MATH2}#corner-garage`,
    goal: 'A 45° facade.',
    parts: ['3027'], rule: 'A 2×16 plate at 45° spans 17 studs: near triple 12-12-17.',
    steps: ['Connection points 12 and 12 studs out.', 'Bridge with the plate on rounded 1×2 plates.'],
    calc: 'angledWall', tags: ['45', 'facade', 'near triple', 'case study'],
  },
  {
    id: 'math-orchid', section: 'Maths case studies', name: 'Orchid 10311 vase', url: `${MATH2}#orchid`,
    goal: 'A round vase core.',
    parts: ['74611', '4274'], rule: 'Four 8×8 round plates, each layer 5 plates (2 studs) tall; every other layer turned 22.5° so 16 pin columns carry 16 liftarms and double slopes.',
    steps: ['Stack layers, alternating 22.5°.', 'Pins round the edge, liftarms on the pins, slopes on the liftarms.'],
    tags: ['round', 'vase', 'cylinder', 'technic', 'case study'],
  },
  {
    id: 'math-globe', section: 'Maths case studies', name: 'Globe 21332', url: `${MATH3}#globe`,
    goal: 'A sphere from Technic polygons and plates.',
    parts: ['32016', '3958'], rule: 'A hexadecagon of #3 (157.5°) connectors with 6-stud sides; slices taper 6→4 and 4→2 with wedge plates toward the poles.',
    steps: ['Equator ring of #3 connectors on 5L axles.', 'Vertical rings.', 'Tapering slices.'],
    calc: 'technicPolygon', tags: ['sphere', 'globe', 'technic', 'polygon', 'case study'],
  },
  {
    id: 'math-shield', section: 'Maths case studies', name: "Captain America's Shield 76262", url: `${MATH3}#shield`,
    goal: 'A large disc.',
    parts: ['78443', '78444'], rule: '36 sides of 2 studs (10° each); a 6×2 wedge is 9.46°, close enough. Alternate two panel types so the edge is not jagged.',
    steps: ['36-sided hinge core.', 'Panels of 6×2 wedges.', 'Alternate the flare.'],
    calc: 'wedgeFor', tags: ['disc', 'round', 'shield', 'wedge', 'case study'],
  },
  {
    id: 'math-magic-circle', section: 'Maths case studies', name: 'The Magic Circle', url: `${MATH1}#magic-circle`,
    goal: 'Eight sections that close into a ring.',
    parts: ['3040b'], rule: 'A 45° slope\'s face is √2 studs (1.13 cm); a brick plus its half-plate lip is 1.12 cm: they meet with no visible gap.',
    steps: ['Build eight identical sections.', 'Each slope rests against the next section\'s brick and lip.'],
    tags: ['ring', 'octagon', 'slope', '45', 'case study'],
  },
  // ---------------------------------------------------------------- common techniques
  {
    id: 'common-studless-top', section: 'Common techniques', name: 'Tile the top', url: '',
    goal: 'A smooth, finished surface.',
    parts: ['3070b', '3069b', '2431'], rule: 'Tiles have no studs; finish any surface that should look smooth.',
    steps: ['Cover the top studs with tiles.'],
    recipe: [{ part: '3069b', on: -1, face: 'top' }],
    tags: ['tile', 'smooth', 'finish', 'studless'],
  },
  {
    id: 'common-running-bond', section: 'Common techniques', name: 'Stagger the joints', url: '',
    goal: 'A strong wall.',
    parts: ['3004', '3010'], rule: 'Each brick bridges the joint below it (running bond); stacked joints split apart.',
    steps: ['Put each brick over the seam between two below.'],
    recipe: [{ part: '3004', on: -1, face: 'top' }],
    tags: ['strength', 'wall', 'bond', 'stagger'],
  },
  {
    id: 'common-cheese-stagger', section: 'Building sideways (SNOT)', name: 'Cheese slope steps', url: `${SNOT}#half-plate-offsets`,
    goal: 'A smooth sideways slope from 1×1 cheese slopes.',
    parts: ['54200'], rule: 'A cheese slope is 2 plates tall with a half-plate lip: stagger each by 1.5 plates, not 2, or the lips make steps.',
    steps: ['Cheese slope on a side stud.', 'Next one 1.5 plates further (a brick + 1-plate spacer, or a half-plate offset).'],
    recipe: [{ part: '54200', on: -1, face: 'top' }],
    tags: ['slope', 'cheese', 'smooth', 'snot', 'stagger'],
  },
];

export const techniqueById = new Map(TECHNIQUES.map((t) => [t.id, t]));

/** Techniques matching a free-text query (name, goal and tags), best first. */
export function searchTechniques(query: string): Technique[] {
  const words = query.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  if (!words.length) return [];
  const score = (t: Technique) => {
    const hay = `${t.name} ${t.goal} ${t.tags.join(' ')} ${t.section}`.toLowerCase();
    return words.reduce((s, w) => s + (t.tags.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0);
  };
  return TECHNIQUES.map((t) => ({ t, s: score(t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.t);
}
