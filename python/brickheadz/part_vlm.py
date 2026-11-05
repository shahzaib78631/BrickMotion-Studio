"""Part identification by a vision LLM (Command Code headless, e.g. DeepSeek V4.1 Flash, or
OpenCode `run` for models named opencode/... such as Big Pickle or Nemotron VL).

The classifier proposes the top candidates; the LLM sees one sheet with the tracked
crop beside renders of each candidate (three views, part name) and picks a letter.
The LLM only re-ranks: it cannot name a part the classifier did not propose.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

from brickheadz import part_render as pr

MODEL = "deepseek/deepseek-v4.1-flash"
LETTERS = "ABCDEFGHJK"
VIEWS = [(30.0, 35.0, 0.0), (120.0, 35.0, 0.0), (210.0, -30.0, 0.0)]  # above, other side, from below
CELL = 150


def part_name(root: str, part: str) -> str:
    """LDraw title line of a part, e.g. 'Plate  2 x  4' (empty if not found)."""
    for sub in ("parts", "p", "unofficial/parts"):
        path = os.path.join(root, sub, part + ".dat")
        if os.path.exists(path):
            with open(path, encoding="utf-8", errors="replace") as fh:
                first = fh.readline().strip()
            return re.sub(r"\s+", " ", first[2:] if first.startswith("0 ") else first)
    return ""


def _fit(img: np.ndarray, w: int, h: int) -> np.ndarray:
    out = np.zeros((h, w, 3), np.uint8)
    if img is None or img.size == 0:
        return out
    k = min((w - 6) / img.shape[1], (h - 6) / img.shape[0])
    im = cv2.resize(img, (max(1, int(img.shape[1] * k)), max(1, int(img.shape[0] * k))),
                    interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_NEAREST)
    y0, x0 = (h - im.shape[0]) // 2, (w - im.shape[1]) // 2
    out[y0 : y0 + im.shape[0], x0 : x0 + im.shape[1]] = im
    return out


def crop_rgb(crop: np.ndarray) -> tuple[int, int, int]:
    """Median colour of the crop's non-black pixels (RGB), so renders look alike."""
    px = crop.reshape(-1, 3)
    px = px[px.max(1) > 28]
    if len(px) == 0:
        return (160, 160, 160)
    b, g, r = np.median(px, 0)
    return int(r), int(g), int(b)


def sheet(crop: np.ndarray, cands: list[str], meshes: dict, names: dict) -> np.ndarray:
    """Crop on the left (large), one row per candidate: letter, three views, name."""
    rgb = crop_rgb(crop)
    light = np.array([-0.45, -0.75, -0.48], np.float32)
    light /= np.linalg.norm(light)
    label_w, name_w = 50, 330
    row_w = label_w + 3 * CELL + name_w
    rows = []
    for i, p in enumerate(cands):
        row = np.zeros((CELL, row_w, 3), np.uint8)
        cv2.putText(row, LETTERS[i], (10, CELL // 2 + 12), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
        for j, (yw, pt, rl) in enumerate(VIEWS):
            img = pr.render(meshes[p], pr.rotation(yw, pt, rl), rgb, light, size=CELL)
            row[:, label_w + j * CELL : label_w + (j + 1) * CELL] = _fit(img, CELL, CELL)
        x = label_w + 3 * CELL + 8
        cv2.putText(row, p, (x, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        words, line, y = names.get(p, "").split(), "", 85
        for w in words:  # wrap the name
            if len(line) + len(w) > 26:
                cv2.putText(row, line, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1)
                line, y = "", y + 24
            line = (line + " " + w).strip()
        cv2.putText(row, line, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1)
        cv2.line(row, (0, CELL - 1), (row_w, CELL - 1), (70, 70, 70), 1)
        rows.append(row)
    right = np.vstack(rows)
    left = _fit(crop, 420, min(right.shape[0], 420))
    cv2.putText(left, "MYSTERY PART", (10, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 220, 255), 2)
    pad = np.zeros((right.shape[0], 420, 3), np.uint8)
    pad[: left.shape[0]] = left
    sep = np.full((right.shape[0], 6, 3), 90, np.uint8)
    out = np.hstack([pad, sep, right])
    # lift dark parts (black / dark grey renders are hard to read) without clipping light ones
    lum = float(np.median(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)[crop.max(2) > 28])) if (crop.max(2) > 28).any() else 128
    gamma = float(np.clip(np.log(0.55) / np.log(max(lum, 8) / 255.0), 0.35, 1.0))
    lut = (np.power(np.arange(256) / 255.0, gamma) * 255).astype(np.uint8)
    return cv2.LUT(out, lut)


PROMPT = """Look carefully at the image sheet.png (attached, and also in the current folder).

On the left is a MYSTERY PART: one LEGO part cropped from a 3D-rendered building animation (black background, it may be seen from any angle, sometimes partly cut off).
On the right are {n} candidate parts, one per row, labelled {letters}. Each row shows the same candidate from three angles (from above, from the other side, from below), its LDraw part number and its name.

Which candidate is the mystery part? Compare overall shape and proportions, stud count and layout, slopes, curves, holes, clips and bars. Colour does not matter (the candidates are tinted to match). Brick vs plate height matters (a brick is 3 plates tall).

Do not use any tools other than opening the image. Answer ONLY one line of JSON:
{{"pick": "<letter or NONE>", "confidence": <0-1>, "why": "<at most 12 words>"}}
If you cannot view images, answer NO IMAGE."""


def ask(sheet_img: np.ndarray, cands: list[str], log_dir: str, model: str = MODEL, effort: str = "low",
        timeout: float = 240.0) -> dict:
    """One Command Code call; returns {'pick': part or None, 'confidence', 'why', 'ms', 'ok', 'raw'}."""
    os.makedirs(log_dir, exist_ok=True)
    cv2.imwrite(os.path.join(log_dir, "sheet.png"), sheet_img)
    prompt = PROMPT.format(n=len(cands), letters=", ".join(LETTERS[: len(cands)]))
    with open(os.path.join(log_dir, "prompt.txt"), "w") as fh:
        fh.write(prompt)
    if model.startswith("opencode/") or model.startswith("nvidia/"):
        # OpenCode CLI: the sheet is attached to the message
        exe = shutil.which("opencode") or "opencode"
        args = [exe, "run", "-m", model, "-f", "sheet.png", "--dir", log_dir, prompt]
    else:
        exe = shutil.which("commandcode") or "commandcode"
        args = [exe, "-p", prompt, "-m", model, "--trust", "--skip-onboarding", "--no-session", "--no-auto-update",
                "--max-turns", "4", "--effort", effort]
    t0 = time.time()
    try:
        cp = subprocess.run(args, cwd=log_dir, capture_output=True, text=True, timeout=timeout)
        raw, ok = cp.stdout + cp.stderr, cp.returncode == 0
    except subprocess.TimeoutExpired as e:
        raw, ok = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""), False
    ms = int((time.time() - t0) * 1000)
    out = {"pick": None, "confidence": 0.0, "why": "", "ms": ms, "ok": ok, "raw": raw[-2000:]}
    m = None
    for m in re.finditer(r"\{[^{}]*\"pick\"[^{}]*\}", raw):
        pass
    if m:
        try:
            js = json.loads(m.group(0))
            letter = str(js.get("pick", "")).strip().upper()[:1]
            if letter in LETTERS[: len(cands)]:
                out["pick"] = cands[LETTERS.index(letter)]
            out["confidence"] = float(js.get("confidence", 0) or 0)
            out["why"] = str(js.get("why", ""))
        except (ValueError, TypeError):
            pass
    with open(os.path.join(log_dir, "result.json"), "w") as fh:
        json.dump({k: v for k, v in out.items() if k != "raw"} | {"cands": cands}, fh, indent=1)
    with open(os.path.join(log_dir, "output.txt"), "w") as fh:
        fh.write(raw)
    return out


def identify(items: list[tuple[int, np.ndarray, list[str]]], meshes: dict, names: dict, log_root: str,
             workers: int = 6, **kw) -> dict[int, dict]:
    """items: (track id, crop BGR, candidate parts). Parallel calls; {track id: ask() result}."""
    def one(it):
        tid, crop, cands = it
        return tid, ask(sheet(crop, cands, meshes, names), cands, os.path.join(log_root, f"track{tid:03d}"), **kw)

    with ThreadPoolExecutor(workers) as ex:
        return dict(ex.map(one, items))
