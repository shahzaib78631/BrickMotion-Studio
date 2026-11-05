# Render reference comparison

Compares BrickMotion renders against renders made by hand in BrickLink Studio, using only the
finished images. Nothing inside Studio is read or copied.

## Make the Studio references

Use BrickMotion's own LDraw files (`samples/*.mpd`, e.g. `8880-1.mpd`, `42000-1.mpd`), not Studio's
`.io` files. For each model:

1. In Studio, open the `.mpd` (File → Import → LDraw).
2. Render → set **background colour white**, **not transparent**, **size 1920x1080**, highest quality,
   default light position, camera in its default view (do not move it).
3. Save as `reference/studio/<model>.png`, e.g. `reference/studio/8880-1.png`.

Three to five models are enough: one simple (a few bricks), one with transparent and chrome parts,
one large.

## Make the BrickMotion render of the same model

Open the same `.mpd` in BrickMotion, use the same size and the default camera, export a normal
still (not the path-traced one), and save it as `reference/brickmotion/<model>.png`.

## Compare

```bash
node scripts/compare-renders.cjs reference/studio/8880-1.png reference/brickmotion/8880-1.png
node scripts/compare-renders.cjs --self-test
```

It prints SSIM (structure) and the tone and colour deltas. Positive means BrickMotion is
brighter, higher or warmer. Different aspect ratios are flagged, because framing will not match.
The PNGs stay out of git: only the harness is committed.
