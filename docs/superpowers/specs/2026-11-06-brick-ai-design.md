# BrickMotion's own build AI

Status: draft for review (2026-11-06). Data downloads have started; no training yet.

## Goal

The goal is to make high-quality, varied, original LEGO builds from a text prompt or a reference picture, every one of them buildable. The model learns from open data. It is our own, trained on this Mac, and it runs inside the app.

The engine we already have stays the judge. Every piece the AI proposes still goes through `seat`, collision and `allChecks`, so the AI only has to be good. Validity is guaranteed by construction (brickify, constrained placement), not hoped for.

## Data

| Source | What | Licence | Status |
|---|---|---|---|
| LDraw OMR (library.ldraw.org/omr) | ~4,000 official LEGO sets as LDraw files, in build order (STEP lines) | CC BY 2.0 / 4.0: keep attribution (the manifest keeps set, author file and URL) | indexing, then downloading all |
| StableText2Brick (CMU, Hugging Face) | 47k brick structures on a 20×20×20 grid, each with ~5 captions | MIT | downloaded (45 MB) |
| Rebrickable sets.csv / themes.csv | theme, year and part count for every set | free download | downloaded |
| Our 124 local models (BrickMotion-Data, Downloads, Desktop) | already mined for suggestions | the user's own | in use |
| BrickNet connector data | real connection points | needs the dataset form, which the user must fill in | pending |

**Eurobricks is not scraped.**
- Its forum rules and copyright cover the MOC files posted there, and those designs belong to their builders.
- The site also blocks automated access (it returned 403).
- If you have files from there that you are allowed to use, drop them in BrickMotion-Data and the pipeline picks them up.

Everything lives in `/Users/mac/Projects/BrickMotion-Data` (outside the repo). There is about 25 GB of free disk, and the OMR is estimated at about 2 GB.

## Two ways to represent a model

1. **Shape:** a voxel grid with one cell per stud across and per plate up, plus a colour per cell (the `Voxels` class). Every source converts to it: OMR models by flattening their parts' real geometry into cells, StableText2Brick directly.
2. **Build sequence:** the parts in build order as tokens `(part, colour, connector it mates to, turn)`. Each piece is placed relative to a free connector of what is already built, never by raw coordinates. This comes from the OMR's STEP order and our connector engine.

## The models, in delivery order

### 1. Learned priors (statistics, CPU, minutes)

Mined from the OMR buildings:
- colour schemes (which wall, roof, trim and window colours go together);
- storey heights;
- window and door kinds, and their spacing along a wall;
- roof types;
- footprint shapes and proportions;
- which parts sit next to which.

These replace the hand-picked tables in `src/generate/building.ts`, so generated buildings look like real sets. Each output is also scored for **originality**: its distance to the nearest training model, reported as a percentage, like BricksChat's copy check.

### 2. Shape model: text or picture → rough shape (GPU, hours)

- **Input:** a CLIP embedding of the prompt or the reference picture. CLIP is open weights; it maps text and images into the same space.
- **Output:** a coarse coloured voxel shape (32×32×48 cells). Brickify turns it into certified bricks.
- **Architecture:**
  - a small 3D VQ-VAE compresses shapes into tokens;
  - a transformer of about 30M parameters writes those tokens, conditioned on the CLIP embedding.
  - This fits the M1 Pro's GPU through PyTorch MPS.
- **Training data:** StableText2Brick (47k, with captions) plus OMR models turned into voxels (captioned from set names and themes), augmented by mirroring, turning and recolouring.
- Because CLIP puts pictures and text in one space, a picture works as a prompt from day one. Fine-tuning on renders of OMR models with their own pictures makes it better.

#### Stage 2 as built (2026-11-06)

**v1** (trained first, from StableText2Brick only):
- 20×20×20 brick grid, occupancy only; colour comes from the prompt's colour words.
- VQ-VAE: a patch transformer (4×4×4 patches → 125 codes, codebook 512). 3D convolutions run about 50× slower on the M1's GPU, so the design uses matrix multiplies only. Test IoU 0.88.
- GPT: 10.9M parameters, 8 layers, width 320, classifier-free guidance.
- Both networks run in the browser in plain TypeScript (`src/ai/shapeModel.ts`).
- The CLIP text encoder runs through transformers.js in fp16. It matches PyTorch exactly; the 8-bit file drifts to cosine 0.87–0.94.

**v2** (more detail, the foundation for stage 3):
- **Grid:** 32×32 studs × 64 plates, on the app's own stud and plate grid. Steps are one plate high, not one brick high.
- **Colour:** each cell is one of the 32 most used LDraw colours, or "other".
- **OMR data:** every OMR model voxelised from the parts' real LDraw geometry (`python/omr/voxelise.py`). Studs are left out, columns are filled solid, so slopes keep their profile. A model too big for the grid is split into its main model's submodels.
- **StableText2Brick:** its shapes are kept and scaled to plates (×3). They have no colour, so their colour loss is masked.
- **Conditioning:**
  - CLIP text of the captions, and of set, theme and submodel names.
  - CLIP *image* embeddings of rendered OMR voxels, so a reference picture works as a prompt (stage 4) and set names aren't the only captions.
- **VQ-VAE:** 4×4×8 patches (about cubic: 80×80×64 LDU) → 512 codes, codebook 1024.
- **GPT:** writes 512 codes. It runs in a Web Worker in the app, so the page stays responsive during the roughly 10–20 s of sampling.

### 3. Detail model: next piece, like an autocomplete for building (GPU, hours)

- A transformer over build sequences from the OMR (real designers' order and techniques).
- At each step it proposes the next piece onto a free connector. Sampling is **constrained by our engine**: only placements that seat and hit nothing are allowed (masked decoding).
- This is what turns a blocky shape into a set-like model, with SNOT, slopes, tiles and details.
- It also upgrades the Suggest tab's ghost suggestions from mined habits to a learned model.

### 4. Reference pictures (after 2 and 3)

- **Fit loop:** render our model from the picture's viewpoint with the app's renderer, compare silhouette and colours, and adjust the shape. Repeat a few rounds.
- Claude's vision can read the picture's subject, proportions and colours to set the starting prompt.

## How we will measure it

- **Certified:** 100% of outputs pass `allChecks` with one connected piece. This is enforced by construction.
- **Matches the prompt or picture:** CLIP similarity between a render and the prompt or picture.
- **Original:** the share of the model not found in the nearest training set.
- **Looks like LEGO:** a person compares side by side with real sets.

## Limits

- The OMR has thousands of sets but fewer pure buildings (estimated in the hundreds). Augmentation and StableText2Brick fill in for shape; the detail model learns local patterns, which repeat across all themes.
- Training on the M1 Pro takes hours per model, not minutes, and runs as background jobs.
- OMR attribution must be kept wherever trained models or derived data are shared.
