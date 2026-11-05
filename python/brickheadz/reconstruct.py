"""Reconstruct a model from instructions — honestly.

Two modes:

* ``from_omr``  — a verified OMR/parts model gives exact geometry; the booklet
  supplies only the build *order*. Output is the authoritative assembled model
  plus a report. This is the trustworthy path for any set we have an OMR for.

* ``propose``   — no OMR: run the step-image solver. Every placement carries a
  confidence; only placements above the threshold are **committed**, the rest are
  listed for a human to correct. We never emit a silent wrong model: the report
  and the committed MPD always state what was guessed, and with what confidence.
"""
from __future__ import annotations

import json
import os

import numpy as np

from brickheadz.builder import Model, Placed
from brickheadz.export import write_mpd, write_plan

BACKGROUND = (211, 236, 247)


# ------------------------------------------------------------------ inputs ---


def steps_from_omr(path: str):
    """Parse a `0 STEP`-partitioned MPD into [(part, colour, matrix)] groups."""
    steps, cur = [], []
    for ln in open(path, errors="ignore"):
        if ln.startswith("0 STEP"):
            steps.append(cur); cur = []
        elif ln.startswith("1 "):
            f = ln.split()
            vals = list(map(float, f[2:14]))
            m = np.eye(4)
            m[:3, :3] = np.array(vals[3:12]).reshape(3, 3)
            m[:3, 3] = vals[:3]
            cur.append((f[14].lower().replace(".dat", ""), int(f[1]), m))
    if cur:
        steps.append(cur)
    return [s for s in steps if s]


def _load_rgb(path: str) -> np.ndarray:
    import pymupdf

    pix = pymupdf.Pixmap(path)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3].astype(float)


def _model_from(pieces, name: str) -> Model:
    m = Model(name)
    m.pieces = [Placed(p, c, mx, "", None, True) for p, c, mx in pieces]
    return m


# -------------------------------------------------------------- OMR mode -----


def from_omr(omr_path: str, out_dir: str, name: str = "model") -> dict:
    """Authoritative assembled model: exact geometry + instruction step order."""
    steps = steps_from_omr(omr_path)
    pieces = [pc for s in steps for pc in s]
    os.makedirs(out_dir, exist_ok=True)
    model = _model_from(pieces, name)
    write_plan(model, os.path.join(out_dir, f"{name}.plan.json"), name)
    write_mpd(model, os.path.join(out_dir, f"{name}.mpd"), name)
    counts = [len(s) for s in steps]
    report = {
        "mode": "omr",
        "name": name,
        "source": omr_path,
        "steps": len(steps),
        "pieces": len(pieces),
        "piecesPerStep": counts,
        "trusted": True,
        "note": "exact geometry from the OMR; build order from the instructions; no guessing",
    }
    with open(os.path.join(out_dir, "reconstruct.json"), "w") as f:
        json.dump(report, f, indent=1)
    with open(os.path.join(out_dir, "reconstruct.md"), "w") as f:
        f.write(_omr_md(report))
    return report


def _omr_md(r: dict) -> str:
    lines = [
        f"# Assembly: {r['name']}",
        "",
        f"- source: `{r['source']}`",
        f"- steps: **{r['steps']}**, pieces: **{r['pieces']}**",
        f"- trusted: **{r['trusted']}** — {r['note']}",
        "",
        "| step | pieces |",
        "| ---: | -----: |",
    ]
    lines += [f"| {i} | {n} |" for i, n in enumerate(r["piecesPerStep"], 1)]
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------ image mode -----


def _camera(lib, built, image_rgb, yaw, pitch, size):
    from brickheadz.instruction_place import Camera, fit_camera, foreground_mask, world_points

    pts = np.concatenate([world_points(lib, p, m) for p, _c, m in built]) if built else None
    if pts is None:
        return None
    fg = foreground_mask(image_rgb)
    ys, xs = np.where(fg)
    if not ys.size:
        return None
    c0 = Camera(yaw, pitch)
    u, v, _ = c0.project(pts)
    mw = max(1e-6, float(u.max() - u.min()))
    mh = max(1e-6, float(v.max() - v.min()))
    s = min((xs.max() - xs.min()) / mw, (ys.max() - ys.min()) / mh)
    return Camera(yaw, pitch, s, xs.min() - u.min() * s, ys.min() - v.min() * s)


def propose(lib, palette, spec, out_dir, name="proposal", yaw=30, pitch=25, size=256,
            min_confidence=0.6, y_cands=None):
    """Solve each step from its image; commit only confident placements.

    spec: [{"image": path, "parts": [[part, colour], …]}, …] or
          {"cam": {yaw,pitch,scale,ox,oy}, "steps": [...]} to pin the camera
          (otherwise it is fitted per step from the accumulated model).
    """
    from brickheadz.instruction_place import Camera, cells_of, reconstruct_step, world_points

    if isinstance(spec, dict):
        cam_override, spec_steps = spec.get("cam"), spec["steps"]
    else:
        cam_override, spec_steps = None, spec
    y_cands = y_cands or list(range(0, 40))
    occupied: set = set()
    built: list = []
    step_reports = []
    committed = flagged = unplaced = 0
    for si, step in enumerate(spec_steps, 1):
        rgb = _load_rgb(step["image"])
        h, w = rgb.shape[:2]
        s = int(max(h, w))
        if cam_override:
            cam = Camera(**cam_override)
        else:
            cam = _camera(lib, built, rgb, yaw, pitch, s) or Camera(yaw, pitch, s * 0.5, s / 2, s / 2)
        step_new = [(p, c, None, None) for p, c in step["parts"]]
        rec = reconstruct_step(lib, step_new, cam, s, occupied, y_cands, rgb, palette)
        entries = []
        for (part, colour, grid, m, score, _g) in rec:
            if m is None:
                status = "unplaced"
                unplaced += 1
            elif score >= min_confidence:
                status = "committed"
                committed += 1
                occupied.update(cells_of(lib, part, grid[0], grid[1], grid[2], np.array(grid[3]))[1])
            else:
                status = "low_confidence"
                flagged += 1
            if m is not None and status == "committed":
                built.append((part, colour, m))
            entries.append({
                "part": part, "color": colour, "status": status,
                "confidence": round(float(score), 3),
                "matrix": None if m is None else [round(float(v), 3) for v in m.ravel()],
            })
        step_reports.append({"step": si, "image": step["image"], "pieces": entries})
    total = committed + flagged + unplaced
    os.makedirs(out_dir, exist_ok=True)
    if built:
        model = _model_from(built, name)
        write_mpd(model, os.path.join(out_dir, f"{name}.committed.mpd"), name)
        write_plan(model, os.path.join(out_dir, f"{name}.committed.plan.json"), name)
    report = {
        "mode": "image",
        "name": name,
        "trusted": False,
        "minConfidence": min_confidence,
        "summary": {"total": total, "committed": committed, "lowConfidence": flagged, "unplaced": unplaced},
        "steps": step_reports,
        "note": "image-derived proposals: only placements above the confidence threshold are committed to the MPD; review the listed items",
    }
    with open(os.path.join(out_dir, "proposal.json"), "w") as f:
        json.dump(report, f, indent=1)
    with open(os.path.join(out_dir, "proposal.md"), "w") as f:
        f.write(_proposal_md(report))
    return report


def _proposal_md(r: dict) -> str:
    s = r["summary"]
    lines = [
        f"# Reconstruction proposal: {r['name']}",
        "",
        f"> **Not trusted.** Image-derived. Committed **{s['committed']}**, "
        f"low-confidence **{s['lowConfidence']}**, unplaced **{s['unplaced']}** of {s['total']} "
        f"(threshold {r['minConfidence']}). Only *committed* pieces are in the MPD.",
        "",
    ]
    for st in r["steps"]:
        lines.append(f"## Step {st['step']}  (`{os.path.basename(st['image'])}`)")
        lines.append("")
        lines.append("| part | colour | status | confidence |")
        lines.append("| --- | ---: | --- | ---: |")
        for p in st["pieces"]:
            lines.append(f"| {p['part']} | {p['color']} | {p['status']} | {p['confidence']} |")
        lines.append("")
    return "\n".join(lines)
