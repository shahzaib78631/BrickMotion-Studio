"""Video -> BrickHeadz (Phase 6 extension).

A build/orbit clip is just many photos. This extracts frames with ffmpeg, scores
each for a good front "hero" shot (subject coverage, left-right symmetry,
centredness, completeness), and feeds the best frame into the image -> spec ->
render-match pipeline. No frame is ever assumed to be the right one; the selection
is explicit and reported.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import replace

import numpy as np

from brickheadz.image_spec import foreground_mask, load_pixels, spec_from_image


def probe(video: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", video],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    stream = (data.get("streams") or [{}])[0]
    duration = float(data.get("format", {}).get("duration", 1.0) or 1.0)
    return {"duration": duration, "width": int(stream.get("width", 0)), "height": int(stream.get("height", 0))}


def extract_frames(video: str, count: int = 9, directory: str | None = None) -> list[str]:
    info = probe(video)
    directory = directory or tempfile.mkdtemp(prefix="bhvideo-")
    os.makedirs(directory, exist_ok=True)
    base = os.path.splitext(os.path.basename(video))[0]
    duration = info["duration"] or 1.0
    frames = []
    for i in range(max(1, count)):
        t = duration * (0.15 + 0.7 * (i / (count - 1) if count > 1 else 0.5))
        path = os.path.join(directory, f"{base}_{i:02d}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1", path], check=True)
        if os.path.exists(path):
            frames.append(path)
    return frames


def frame_metrics(px: np.ndarray) -> dict | None:
    """Score a frame for a front, complete hero shot (higher is better)."""
    mask = foreground_mask(px)
    h, w = mask.shape
    if mask.sum() == 0:
        return None
    ys, xs = np.where(mask)
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
    fg = float(mask.mean())
    aspect = (y1 - y0 + 1) / max(1, x1 - x0 + 1)
    sub = mask[y0 : y1 + 1, x0 : x1 + 1]
    symmetry = float((sub == sub[:, ::-1]).mean())
    cx, cy = (x0 + x1) / 2 / w, (y0 + y1) / 2 / h
    centred = 1.0 - min(1.0, float(np.hypot((cx - 0.5) * 2, (cy - 0.5) * 2)))
    aspect_ok = 1.0 if 0.8 <= aspect <= 2.6 else max(0.2, 1.0 - abs(aspect - 1.7) / 2.0)
    margin = 3
    edges = 1.0 - 0.25 * sum((x0 <= margin, y0 <= margin, x1 >= w - 1 - margin, y1 >= h - 1 - margin))
    score = fg * symmetry * max(0.1, centred) * aspect_ok * edges
    return {"fg": round(fg, 3), "aspect": round(aspect, 2), "symmetry": round(symmetry, 3), "centred": round(centred, 3), "score": round(score, 4)}


def select_frame(frames: list[str]) -> tuple[str | None, list[dict]]:
    scored = []
    for path in frames:
        m = frame_metrics(load_pixels(path))
        if m:
            scored.append({"frame": os.path.basename(path), "path": path, **m})
    if not scored:
        return None, []
    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[0]["path"], scored


def build_from_video(lib, video, spec_inventory, ldconfig, pats=None, catalog=None, out=None, name="FromVideo", frames: int = 9, frames_provider=None, hints=None, vision_hint_fn=None, seed: int = 0) -> dict:
    from brickheadz.export import normalize, write_plan
    from brickheadz.render_match import fit

    paths = frames_provider() if frames_provider else extract_frames(video, frames)
    best_path, scored = select_frame(paths)
    if best_path is None:
        raise ValueError("no usable frames in the video")
    if vision_hint_fn is not None:
        hints = {**(hints or {}), **vision_hint_fn(best_path)}
    spec = replace(spec_from_image(best_path, spec_inventory, ldconfig, hints), name=name)
    import random

    best, info = fit(lib, spec, spec_inventory, pats, best_path, ldconfig, catalog, random.Random(seed))
    if best is None:
        raise ValueError("no candidate model could be built from the frame")
    cost, pattern, b, report = best
    if out:
        os.makedirs(out, exist_ok=True)
        write_plan(normalize(b.model), os.path.join(out, f"{name}.plan.json"), name)
        shutil.copyfile(best_path, os.path.join(out, f"{name}.frame.png"))
    return {
        "frame": os.path.basename(best_path),
        "frameScore": next((r["score"] for r in scored if r["path"] == best_path), None),
        "cost": round(cost, 4),
        "pattern": (pattern or {}).get("source"),
        "pieces": report["pieces"],
        "withinInventory": report["withinInventory"],
        "candidates": info["candidates"],
        "framesScored": scored,
    }
