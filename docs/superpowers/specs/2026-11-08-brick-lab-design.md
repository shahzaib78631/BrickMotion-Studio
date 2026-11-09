# Brick Lab: original, buildable models from a prompt

Date: 2026-11-08. Status: draft for approval.

## Intent

Typing "a pirate ship" should give a complete, original, buildable pirate ship made of real LEGO parts
(hull pieces, masts, sails, cannons, railings), at the scale of the sets we have — not a lump of bricks
and plates. The current "Sketch a shape" model predicts a coloured voxel silhouette and fills it with plain
bricks, so it can never produce real models. "Remix a real build" returns real models, but not original
ones, and its search often picks the wrong model.

The AI should make new sets itself, using what it learned from the models we have.

## Goals

- Prompt → whole model in real parts, in real poses, from the LDraw library.
- Certified buildable by the app's own `certify()`: one piece, nothing floating, nothing overlapping,
  stands without tipping.
- Original: mostly new, measured by the app's existing "% original · closest real set" check.
- Recognisable: someone looking at it would name it from the prompt.
- Set scale: 300+ pieces for a ship. Small prompts (a car, a duck) give small models.
- Gets better over time on its own data.

## Non-goals (for now)

- Instant results. The user will wait longer for better models.
- Running entirely in the browser.
- Building instructions, step order for humans, and minifigures.
- Replacing Sketch or Remix. Brick Lab is a third choice in the Generate tab.

## Anti-goals (my calls, the user had none yet — revisit after the first ships)

- A model that only passes the checks: one piece, but a pile of random parts with no shape.
- A near-copy of one real set (originality below about 60%).
- Colour confetti: more colours than the prompt and subject call for.
- Parts used in ways real builders never use them (judged against the BrickNet joint habits).

## Data and prior work

- BrickNet SFT (local, `BrickMotion-Data/bricknet`): 67,185 models, 4–100 parts (median 17), 6,457
  distinct parts, as part + joint graphs. 5 Gemini captions each (335,925 in all), plus CLIP ViT-B/32 text vectors
  (`captions_sft_clip.npy`). Our own decoder: `python/bricknet/decode.py`. Joint habits:
  `python/bricknet/habits.py`. 14,722 caption lines mention ships or boats; 766 mention pirates.
- OMR (local, `BrickMotion-Data/omr`): 1,471 downloaded sets, full size, with names and themes.
  Includes Black Seas Barracuda (6285) and Skull's Eye Schooner (6286). Too few to learn
  "pirate ship" from directly. Useful for big-model structure and as originality references.
- BrickNet paper (Kulits & Schmid, CVPR 2026): Qwen 3 models of 0.6–14B on the same graph text, up to
  100 parts. Main failure: overlaps. Even 14B averages about 19 steps before the first collision.
  Collisions are measured, not prevented; inference-time guidance is named as future work.
  No hierarchy, and sets beyond 100 parts are out of reach.
- BrickGPT (CMU, ICCV 2025): 100% valid through roll-back on failure, but only 8 plain brick types.

## How it works (decided with the user)

**1. Planner: Claude.** A prompt goes to Claude through the existing local CLI bridge
(`scripts/claude-bridge.ts`, the user's login, no API key). Claude returns a JSON plan:
sub-assemblies (hull, deck, masts, sails, cannons, cabin…), each with a short caption, a rough size in
studs, a colour palette, how many of it, and where it attaches to its parent (which face, roughly where).
Later, a planner of our own trained on OMR sets plus Brick Lab's own results replaces Claude.

**2. Builder: our own model, legal moves only.** A transformer trained on Kaggle on the 67k captioned
BrickNet models writes a model as a sequence of steps: part, colour, which existing part and connector
it attaches to, its own connector, and the joint angle (BrickNet's representation). Conditioning: the
CLIP text vector of the caption.

At each step the lab offers the model only legal moves, by masking the rest:
- only free connectors of parts already placed;
- only compatible connector types (stud ↔ hole, axle ↔ axle hole, …);
- no overlap with what is already placed;
- inside the sub-assembly's planned size.

Unlike BrickNet, collisions are prevented during generation, not measured afterwards.

Because sub-assemblies grow out of a parent that is already built, the builder is also trained to
continue a partial model: training samples are split at random points, and the first part is given
as context (my call). Claude's sub-assembly captions are asked for in the style of the BrickNet
captions (a few real captions are shown as examples), so the builder sees familiar wording.

**3. Many builds at once (sequential Monte Carlo).** Each sub-assembly grows as about 64 parallel
builds. Every few steps they are scored on model likelihood, how well a render matches the caption
(CLIP image ↔ text), stability, and staying inside the planned size. Weak builds are dropped and strong
ones copied. A sub-assembly grows from its parent's free connectors in the planned area, so the
whole model stays one piece.

**4. Evolution.** Whole models are scored for prompt match (CLIP of renders against the prompt),
certification, originality, stability and the anti-goals above. The best are kept and mutated by
regrowing one sub-assembly ("new sails", "longer hull") or swapping its plan entry, over several rounds.

**5. Self-training.** Certified, high-scoring results, together with their plans, are saved as new
training data. Each Kaggle run trains the builder (and later the planner) on the 67k plus everything good
the lab has made.

## Where it runs (my calls)

- **Training** on Kaggle (T4, 30 GPU hours a week), with the existing bundle pattern
  (`python/shape/kaggle_bundle.py`: code version, carry-over of earlier runs, stage `.done` files).
- **Generation** as a background Python job on the Mac (MPS), started from the app through a dev-server
  bridge like the Claude bridge. The app shows progress (planning, building the hull, round 3 of 8, best
  score so far) and the best model so far. The user can stop at any time and keep the best. Target at
  first: 10–30 minutes for a big ship.
- The result opens as a new project, like the other Generate options, and is checked again with the
  app's own `certify()`.
- Only one MPS job at a time (an existing constraint): generation refuses to start while training or
  another generation runs locally.

## Experiments, each with a pass or fail

| # | Experiment | Pass if |
|---|---|---|
| 1 | Builder alone, legal moves only | 100-part models with zero overlaps, against BrickNet's ~19 steps |
| 2 | With 64 parallel builds | On the 512 BrickNet validation captions, CLIP render–caption match closes at least half the gap between the current Sketch model and the real validation models (my call: BrickNet's VQAScore needs a 7B vision model we don't run, so their 0.557 is not directly comparable) |
| 3 | With the plan and sub-assemblies | A pirate ship of 300+ parts, certified, one piece, which the user calls a pirate ship on sight |
| 4 | Evolution and self-training | Scores rise across three rounds |

Work goes in this order, and the user sees the results after each experiment before the next one
starts (my call).

If 1 fails (the model keeps cornering itself), add BrickGPT-style roll-back before going further.
If 2 fails, score on more views, or use a stronger image–text model before scaling the builder.

## Constraints

- BrickNet data stays in BrickMotion-Data and is read with `python -I`. Credit BrickNet
  (Kulits & Schmid, CVPR 2026) and OMR (CC BY) wherever results or data are shown.
- BrickNet data was released for research purposes. The user confirmed (2026-11-08) that training on
  it is fine for their use.
- Do not install the external `bricknet` package; use our own decoder.
- Disk is tight (about 20 GB free): keep training data compact (npz, fp16) and clean up checkpoints.
- No commits unless the user asks.

## Left to the builder

- Model size and tokenisation (a small model trained from scratch, or a fine-tuned small Qwen),
  within Kaggle's T4 memory and the Mac's inference speed.
- The overlap test in Python: per-part occupancy from LDraw geometry (precomputed once), checked
  against the placed parts. It must agree with the app's `collisionWorld`, tested on sample models.
- The renderer used for CLIP scoring (part meshes from the LDraw library, a few fixed views).
- The exact plan JSON schema and how a planned "where it attaches" becomes a set of allowed
  connectors on the parent.
- Score weights for the parallel builds and for evolution.
