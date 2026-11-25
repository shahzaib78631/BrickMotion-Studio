"""Visual & geometric evaluation gallery for BrickGen using Metal `bmshot` + native `libbmcore` certification."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .blueprint import render_blueprint_preview
from .generate import BrickGenerator, render_with_bmshot

DEFAULT_PROMPTS = [
    ("red_sports_car", "A red LEGO sports car with black wheels, yellow headlights, and a rear spoiler", "omr", "medium", 24, 65),
    ("yellow_truck", "A yellow and black LEGO off-road pickup truck with four wheels and a front cab", "moc", "medium", 24, 70),
    ("medieval_tower", "A medieval gray stone LEGO castle watchtower with battlements and dark roof", "moc", "medium", 30, 80),
    ("space_fighter", "A white and blue LEGO space starfighter jet with angled wings and cockpit", "omr", "medium", 24, 70),
    ("cottage_house", "A cozy LEGO house building with white walls, a sloped red roof, and windows", "omr", "medium", 30, 80),
    ("brickheadz_hero", "A LEGO BrickHeadz collectible character figure with dark hair, red cape, and blue suit", "brickheadz", "medium", 24, 65),
]


def run_gallery(
    ckpt: Path,
    out_dir: Path,
    blueprint_ckpt: Path | None = None,
    n_samples: int = 6,
    cfg: float = 2.2,
    cfg_shape: float = 2.2,
    bp_weight: float = 1.8,
    temp: float = 0.90,
    pose_temp: float = 0.70,
    symmetric: str = "auto",
    seed: int = 0,
) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    gen = BrickGenerator(ckpt, blueprint_ckpt=blueprint_ckpt, load_vision=True)
    rows = []
    tiles = []

    for idx, (slug, prompt, style, scale, min_p, max_p) in enumerate(DEFAULT_PROMPTS):
        t0 = time.time()
        gm = gen.generate(
            prompt=prompt,
            n_samples=n_samples,
            rerank_clip=True,
            style=style,
            scale=scale,
            min_parts=min_p,
            max_parts=max_p,
            cfg_scale=cfg,
            cfg_shape=cfg_shape,
            bp_score_weight=bp_weight,
            temp=temp,
            pose_temp=pose_temp,
            symmetric=symmetric,
            seed=seed + idx * 101,
        )
        ldr_path = out_dir / f"{slug}.ldr"
        ldr_text = gm.to_ldr(title=slug)
        ldr_path.write_text(ldr_text)
        if gm.blueprint_grid is not None:
            render_blueprint_preview(gm.blueprint_grid, out_dir / f"{slug}_blueprint.png", size=192)

        imgs = render_with_bmshot(ldr_text, size=384, views=((0.65, 0.42), (3.79, 0.42)))
        png_path = out_dir / f"{slug}.png"
        if imgs:
            pair = np.concatenate([(im * 255).clip(0, 255).astype(np.uint8) for im in imgs], axis=1)
            Image.fromarray(pair).save(png_path)
            tiles.append((slug, prompt, style, gm, imgs[0]))

        rec = {
            "slug": slug,
            "prompt": prompt,
            "style": style,
            "pieces": gm.check.pieces,
            "overlaps": gm.check.overlaps,
            "groups": gm.check.groups,
            "stands": gm.check.stands,
            "margin_ldu": round(gm.check.margin, 1),
            "mass_g": round(gm.check.mass, 1),
            "mirrored_pairs": gm.mirrored_pairs,
            "aspect_ratio": gm.aspect_ratio,
            "blueprint_iou": gm.blueprint_iou,
            "blueprint_cov": gm.blueprint_cov,
            "rollbacks": gm.rollbacks,
            "clip_score": round(gm.clip_score, 4) if gm.clip_score is not None else None,
            "seconds_total": round(time.time() - t0, 1),
            "ldr": str(ldr_path),
            "png": str(png_path) if imgs else None,
        }
        rows.append(rec)
        print(
            f"[{idx+1}/{len(DEFAULT_PROMPTS)}] {slug:16s} | parts={rec['pieces']:3d} | "
            f"overlaps={rec['overlaps']} | groups={rec['groups']} | stands={rec['stands']} | "
            f"clip={rec['clip_score']} | {rec['seconds_total']}s",
            flush=True,
        )

    # Build 2x3 contact sheet PNG for quick inspection
    sheet_path = out_dir / "gallery.png"
    if tiles:
        tw, th = 384, 384
        pad_top, pad_bot = 36, 26
        cols, nrows = 3, (len(tiles) + 2) // 3
        canvas = Image.new("RGB", (cols * tw, nrows * (th + pad_top + pad_bot)), (248, 248, 250))
        draw = ImageDraw.Draw(canvas)
        for i, (slug, prompt, style, gm, im0) in enumerate(tiles):
            r, c = divmod(i, cols)
            x0, y0 = c * tw, r * (th + pad_top + pad_bot)
            draw.text((x0 + 8, y0 + 4), f"[{style.upper()}] {prompt[:52]}", fill=(20, 20, 25))
            if len(prompt) > 52:
                draw.text((x0 + 8, y0 + 18), prompt[52:104], fill=(60, 60, 70))
            pil = Image.fromarray((im0 * 255).clip(0, 255).astype(np.uint8))
            canvas.paste(pil, (x0, y0 + pad_top))
            cs = f"{gm.clip_score:.3f}" if gm.clip_score is not None else "-"
            status = (
                f"{gm.check.pieces} parts | ov={gm.check.overlaps} | grp={gm.check.groups} | "
                f"stands={'YES' if gm.check.stands else 'no'} | CLIP={cs}"
            )
            draw.text((x0 + 8, y0 + pad_top + th + 6), status, fill=(10, 90, 30) if gm.check.overlaps == 0 else (160, 20, 20))
        canvas.save(sheet_path)

    summary = {
        "checkpoint": str(ckpt),
        "n_prompts": len(rows),
        "zero_overlap_rate": sum(r["overlaps"] == 0 for r in rows) / max(1, len(rows)),
        "single_component_rate": sum(r["groups"] == 1 for r in rows) / max(1, len(rows)),
        "standing_rate": sum(r["stands"] for r in rows) / max(1, len(rows)),
        "mean_parts": round(float(np.mean([r["pieces"] for r in rows])), 1) if rows else 0.0,
        "mean_clip": round(float(np.mean([r["clip_score"] for r in rows if r["clip_score"] is not None])), 4)
        if any(r["clip_score"] is not None for r in rows)
        else None,
        "gallery_png": str(sheet_path) if tiles else None,
        "rows": rows,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print("\nGallery summary:", json.dumps({k: v for k, v in summary.items() if k != "rows"}, indent=2), flush=True)
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate & certify a 6-prompt visual evaluation gallery.")
    ap.add_argument("--ckpt", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/brickgen_v3.pt"))
    ap.add_argument("--blueprint-ckpt", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/gallery_v3"))
    ap.add_argument("--samples", type=int, default=6)
    ap.add_argument("--cfg", type=float, default=2.2)
    ap.add_argument("--cfg-shape", type=float, default=2.2)
    ap.add_argument("--bp-weight", type=float, default=1.8)
    ap.add_argument("--temp", type=float, default=0.90)
    ap.add_argument("--pose-temp", type=float, default=0.70)
    ap.add_argument("--symmetric", choices=["auto", "on", "off"], default="auto")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    run_gallery(
        a.ckpt,
        a.out,
        blueprint_ckpt=a.blueprint_ckpt,
        n_samples=a.samples,
        cfg=a.cfg,
        cfg_shape=a.cfg_shape,
        bp_weight=a.bp_weight,
        temp=a.temp,
        pose_temp=a.pose_temp,
        symmetric=a.symmetric,
        seed=a.seed,
    )


if __name__ == "__main__":
    main()
