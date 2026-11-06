# Model generator: prompt, picture or parts list → buildable model

Status: draft for review (2026-11-06). Nothing built yet.

## Why

Two sites already turn an idea into a real, buildable LEGO model:

- **BricksChat** (brickschat.com): you chat a prompt, optionally with a picture and your own parts or sets. About 10 minutes later you get a model of ~100 parts plus LDR/MPD files, a parts list, PDF instructions and an originality score. Its gallery has 205 builds: animals, vehicles, buildings, characters. Stud.io's stability check passed on a forum user's test builds. Its listed data sources are the LDraw parts library, Rebrickable and BrickNet, the same data we already have. The author says instructions for big builds are "not reliable at all" and the building technique is still below sets designed by people.
- **Bricktown 85** (bricktown85.com): click and get a 1985-style town building, made from a seed (`model;seed=…`) and exported as LDR. It needs no AI: it is a rule-based generator that runs in the browser. Seed 691280387514 has 835 parts, but only 24 part types in 5 colours:
  - walls: 1×1 to 1×8 bricks in running bond, one course every 24 LDU;
  - windows: 60593/60602 frames, 60594/60603 window and glass, 60608 shutters;
  - other: one door (3861), plates for the floors, and a stepped roof.
  - Every model is valid because the rules only make valid moves.

Our editor already has the hard parts these generators need, and they are exact:

- real connector mating: `partConnectors`, `freeTargets`, `seat`;
- collision: `collisionWorld`;
- the connection graph and checks: `connectionGraph.ts`, `validate.ts` (`floating`, `weak`, `overlap`);
- automatic steps: `autoSteps.ts`;
- habit suggestions mined from 124 real models, plus 22 placeable technique recipes (`src/suggest`).

What we lack is the generator around them.

Our current "Describe a set and Claude designs it" (`src/ai/prompt.ts`, `src/ai/claude.ts`) asks Claude to write every piece's grid position in one reply. It is upright only, with nothing checked while it builds. Language models are poor at exact 3D coordinates, so pieces float, overlap or never connect. That is the gap, not the model's intelligence.

## Goal

From a text prompt (and later a picture or an inventory), produce a model that:
1. only uses real parts and colours;
2. has every piece mated to at least one other through real connectors, with no overlaps;
3. is one connected whole that stands up (no weak single-stud links holding big parts);
4. opens in the editor as a normal plan with steps, so it animates and exports like any other model.

## Non-goals (for now)

- An originality or "percentage copied" check against Rebrickable sets.
- A parts shop or ordering parts.
- Accounts, payments, a public gallery.

## Anti-goals

- Anything that writes coordinates without the engine checking them. Every piece must go through `seat` + collision, so an invalid model cannot come out.
- Random filler. Each piece has a reason: the shape, a technique or a mined habit.

## The design: three layers, one validator

### 1. Shape → bricks ("brickify"), deterministic, no AI

Input: a coarse voxel shape on the stud grid, with one cell per stud and plate height and a colour per cell.

Output: bricks and plates that fill it and hold together.

- **Greedy fill:** go layer by layer and choose the largest brick or plate from an allowed list that fits the cells of one colour.
- **Bond:** offset joints from the layer below (running bond), so every brick crosses a joint under it. This is what makes the model hold together; it is the classic "legolizer" approach.
- **Repair pass:** run the existing connection graph. If a piece is floating or a component is split, merge or re-split bricks across the weak joint until there is one component.
- **Inventory mode (later):** limit how many of each part and colour can be used. Fall back to smaller parts, then to a near colour.

This layer alone gives sculptures, mosaics, buildings, and anything else that can be described as a shape.

### 2. Rule kits ("Bricktown-style"), deterministic, seeded

These are small generators for categories with strong conventions:

- **building:** footprint, wall courses, window and door openings, floors, stepped or sloped roof;
- **tree** and **wall/castle**;
- **vehicle chassis:** a plate base with wheels on axles or wheel-holders.

Each kit emits a voxel shape plus "fixtures" (window, door, wheel) that are placed by connector, never by coordinate. Kits are instant, free, and every seed gives a valid model. They also give the AI layer a toolbox of parts.

### 3. Claude agent loop (BricksChat-style)

Claude never writes coordinates directly. It works in a tool loop over our engine:

| Tool | Does |
|---|---|
| `blockout(layers)` | Claude sketches the coarse voxel shape and colours, part by part ("body", "head", "wing"); brickify turns it into bricks |
| `kit(name, params, at)` | runs a rule kit (building, tree, chassis…) |
| `open_spots(region)` | free connectors in a region, from `freeTargets` |
| `place(part, colour, on_spot, yaw)` | `seat` + collision; refused with a reason if it does not fit |
| `technique(id, anchor)` | one of the 22 solved recipes (SNOT headlight, hinge, jumper offset…) |
| `suggest(anchor)` | our habit/mirror/repeat/technique suggestions |
| `mirror(selection)` | copies one side to the other, swapping left/right parts |
| `check()` | floating, weak, overlap, components, bounding size, part count |
| `render(view)` | a small picture of the model so far (front/side/top), so Claude can see what it built |
| `undo(n)` | takes back the last n moves |

Flow:
1. Claude writes a short brief: what the model is, its size in studs, its main parts, its colours.
2. Claude makes a blockout and runs brickify.
3. Detail passes use place, technique and mirror.
4. Claude runs `check`, looks at the renders, and repairs.
5. `autoStepPlan` adds steps.

The calls go from the browser to the Claude API with the user's own key, the same as today (`src/ai/claude.ts`). The loop uses tool use with a step and part budget.

**Pictures (later):** the picture goes into the brief step. Claude reads the shape and colours from it, then makes a blockout.

## Delivery order (my call)

1. **Brickify + generator check** (layer 1), with tests: a sphere, a wall and a character head come out as one valid component.
2. **Building kit** (layer 2): a quick, visible win, comparable to Bricktown 85. Add a "Generate" button with a seed.
3. **Claude blockout → brickify** (layer 3, first half). This replaces the one-shot "Describe a set": Claude only shapes, and the engine builds.
4. **Detail agent loop** with the tools above, plus renders for self-checking.
5. **Inventory mode**, **picture input**, then printable **instructions** (we have steps and renders but no PDF export yet).

Each phase is usable on its own and is tested before the next one starts.

## Open choices left to the builder

- The exact allowed parts list for brickify. Start with basic bricks and plates from 1×1 to 2×8, then add slopes for smoother outlines.
- Turn budgets and model choice for the agent loop. Opus for the brief and blockout; a cheaper model for detail passes is an option.
- How renders are produced for the agent: an offscreen canvas from the existing renderer, at a small size.

## How we will know it works

- 20 prompts across categories: animal, vehicle, building, character, object.
- For each output: zero floating, zero overlaps, one component, and fewer than 5% weak links.
- The model is recognisable in a render. A person judges this, or Claude judges it against the prompt.
- Time per model is under 3 minutes for about 150 parts.
