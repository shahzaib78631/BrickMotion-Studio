"""Read the parts list shown at the end of KenBrick clips.

Long clips (>= 20 s) end with one or more pages on a pale blue panel: a picture of each part
with three text lines under it, e.g. ``28x`` / ``54200`` / ``Light Yellow``. This module finds
the distinct pages in the last seconds of a clip and reads them with Tesseract (word boxes,
sparse-text mode): each ``Nx`` word is paired with the part number directly below it and the
colour words below that. Part numbers are checked against the LDraw library.

Needs the ``tesseract`` binary (Homebrew) and opencv.
"""
from __future__ import annotations

import csv
import io
import os
import re
import subprocess

import cv2
import numpy as np

PANEL_BGR = np.array([250, 235, 215], np.float32)  # pale blue panel (B, G, R)


def panel_mask(frame: np.ndarray) -> np.ndarray:
    return (np.abs(frame.astype(np.float32) - PANEL_BGR).max(2) < 22)


def pages(path: str, tail_s: float = 20.0, step_s: float = 0.25, min_panel: float = 0.15) -> list[np.ndarray]:
    """Distinct parts-list pages (cropped to the panel) in the last tail_s seconds."""
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    out: list[np.ndarray] = []
    last = None
    for f in range(max(0, n - int(tail_s * fps)), n, max(1, int(step_s * fps))):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, fr = cap.read()
        if not ok:
            continue
        m = panel_mask(fr)
        if m.mean() < min_panel:
            last = None
            continue
        rows = np.where(m.mean(1) > 0.5)[0]
        crop = fr[rows.min() : rows.max() + 1]
        small = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (180, 120)).astype(np.float32)
        if last is not None and np.abs(small - last).mean() < 4.0:
            continue  # same page as the previous frame (or still fading)
        # keep a page only once it is steady: replace the previous one if it was a fade-in
        if out and last is not None and np.abs(small - last).mean() < 12.0:
            out[-1] = crop
        else:
            out.append(crop)
        last = small
    # drop near-duplicates (a page shown twice)
    uniq: list[np.ndarray] = []
    sig = []
    for p in out:
        s = cv2.resize(cv2.cvtColor(p, cv2.COLOR_BGR2GRAY), (180, 120)).astype(np.float32)
        if all(np.abs(s - t).mean() > 6.0 for t in sig):
            uniq.append(p)
            sig.append(s)
    return uniq


def _words(img: np.ndarray, scale: int = 3) -> list[dict]:
    big = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    ok, png = cv2.imencode(".png", gray)
    cp = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11", "tsv"], input=png.tobytes(),
                        capture_output=True, check=True)
    rows = csv.DictReader(io.StringIO(cp.stdout.decode("utf-8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE)
    out = []
    for r in rows:
        t = (r.get("text") or "").strip()
        if t and float(r.get("conf") or -1) > 0:
            out.append({"t": t, "x": int(r["left"]) / scale, "y": int(r["top"]) / scale,
                        "w": int(r["width"]) / scale, "h": int(r["height"]) / scale})
    return out


_QTY = re.compile(r"^(\d{1,3})[xX×]$")
_PART = re.compile(r"^[0-9oOlIS]{3,6}[a-z]{0,3}[0-9a-z]*$")


def _qty_crop(img: np.ndarray, x: float, y_top: float, lh: float) -> int | None:
    """Re-read a quantity the page pass missed, from a binarised crop of its line."""
    y0, y1 = int(max(0, y_top - 2)), int(y_top + lh + 3)
    crop = img[y0:y1, int(max(0, x - 3)) : int(x + 4 * lh)]
    if crop.size == 0:
        return None
    g = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), None, fx=6, fy=6, interpolation=cv2.INTER_CUBIC)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bw = cv2.copyMakeBorder(bw, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=255)
    for psm in ("7", "8"):
        ok, png = cv2.imencode(".png", bw)
        cp = subprocess.run(["tesseract", "stdin", "stdout", "--psm", psm, "-c", "tessedit_char_whitelist=0123456789x"],
                            input=png.tobytes(), capture_output=True)
        m = re.search(r"(\d{1,3})x", cp.stdout.decode("utf-8", "replace"))
        if m:
            return int(m.group(1))
    return None


def read_page(img: np.ndarray, known=None) -> list[dict]:
    """[{qty, part, color, ok}] from one page, anchored on part-number words.
    `known(part) -> bool` validates part numbers (and filters non-labels)."""
    ws = _words(img)
    qs = [w for w in ws if _QTY.match(w["t"])]
    lh = float(np.median([w["h"] for w in qs])) if qs else 8.0
    labels = []
    for pw in ws:
        raw = pw["t"].lower().strip(".,;:")
        if not _PART.match(raw):
            continue
        part = _fix(raw, known)
        if known is not None and not known(part):
            continue
        labels.append((pw, part))
    out = []
    for pw, part in labels:
        x0, y0, bot = pw["x"], pw["y"], pw["y"] + pw["h"]
        # the next label to the right on the same row bounds this label's words
        nxt_x = min([q["x"] for q, _ in labels if abs((q["y"] + q["h"]) - bot) < lh and q["x"] > x0 + lh] + [1e9])
        col = [w for w in ws if x0 - 1.5 * lh < w["x"] < nxt_x - 1]
        above = [w for w in col if _QTY.match(w["t"]) and 0.3 * lh < y0 - w["y"] < 2.5 * lh]
        colour = [w for w in col if bot - 2 < w["y"] < bot + 1.8 * lh and not _QTY.match(w["t"]) and w is not pw]
        colour.sort(key=lambda w: w["x"])
        out.append({"pw": pw, "qty": int(_QTY.match(above[0]["t"]).group(1)) if above else None,
                    "qty_y": above[0]["y"] if above else None, "cy": colour[0]["y"] if colour else None,
                    "part": part, "color": " ".join(w["t"] for w in colour)})
    pitch = [o["cy"] - o["qty_y"] for o in out if o["qty_y"] is not None and o["cy"] is not None]
    pitch = float(np.median(pitch)) if pitch else 2.6 * lh
    items = []
    for o in out:
        if o["qty"] is None:
            ref = o["cy"] if o["cy"] is not None else o["pw"]["y"] + o["pw"]["h"] + 0.3 * lh
            o["qty"] = _qty_crop(img, o["pw"]["x"], ref - pitch, lh)
        items.append({"qty": o["qty"], "part": o["part"], "color": o["color"],
                      "ok": bool(known(o["part"])) if known else None})
    return items


def _fix(part: str, known) -> str:
    """Common OCR slips: O/o -> 0, l/I -> 1, S -> 5 in the numeric head of a part number."""
    if known is None or known(part):
        return part
    head = re.match(r"^[0-9oOlIS]+", part)
    if head:
        fixed = head.group(0).translate(str.maketrans("oOlIS", "00115")) + part[head.end():]
        if known(fixed):
            return fixed
    return part


def read_clip(path: str, known=None) -> dict:
    ps = pages(path)
    seen, items = set(), []
    for pg in ps:
        for it in read_page(pg, known):
            k = (it["qty"], it["part"], it["color"])
            if k not in seen:
                seen.add(k)
                items.append(it)
    return {"clip": os.path.basename(path), "pages": len(ps), "items": items,
            "pieces": sum(i["qty"] or 0 for i in items), "qty_missing": sum(i["qty"] is None for i in items)}


def clean_colour(colour: str, names: set[str]) -> str:
    """Trim words that bled in from the next label: keep the longest known prefix."""
    words = colour.replace("LightGray", "Light Gray").split()
    for k in range(len(words), 0, -1):
        if " ".join(words[:k]).lower() in names:
            return " ".join(words[:k])
    return " ".join(words[:2])


def main(argv=None) -> int:
    import argparse
    import glob
    import json
    from concurrent.futures import ProcessPoolExecutor

    ap = argparse.ArgumentParser(prog="brickheadz.video_inventory")
    ap.add_argument("videos", help="folder of clips (searched recursively)")
    ap.add_argument("--library", default=os.path.join("..", "public", "ldraw"))
    ap.add_argument("--rebrickable", default="", help="Rebrickable downloads (colors.csv.gz) for colour names")
    ap.add_argument("--min-seconds", type=float, default=20.0)
    ap.add_argument("--out", default=os.path.join("knowledge", "video_inventories.json"))
    a = ap.parse_args(argv)
    clips = []
    for f in sorted(glob.glob(os.path.join(a.videos, "**", "*.mp4"), recursive=True)):
        cap = cv2.VideoCapture(f)
        if cap.get(cv2.CAP_PROP_FRAME_COUNT) / (cap.get(cv2.CAP_PROP_FPS) or 30) >= a.min_seconds:
            clips.append(f)
    with ProcessPoolExecutor(6) as ex:
        res = list(ex.map(_read_one, [(f, a.library) for f in clips]))
    names = _colour_names(a.library, a.rebrickable)
    for r in res:
        for it in r["items"]:
            it["color"] = clean_colour(it["color"], names)
    res = [r for r in res if r["items"]]
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps({"clips": len(clips), "with_list": len(res), "items": sum(len(r["items"]) for r in res),
                      "pieces": sum(r["pieces"] for r in res), "qty_missing": sum(r["qty_missing"] for r in res)}))
    return 0


def _known(root: str):
    return lambda p: any(os.path.exists(os.path.join(root, s, p + ".dat")) for s in ("parts", "unofficial/parts"))


def _read_one(args):
    path, root = args
    try:
        return read_clip(path, _known(root))
    except Exception as exc:  # keep going over the batch
        return {"clip": os.path.basename(path), "pages": 0, "items": [], "pieces": 0, "qty_missing": 0, "error": str(exc)}


def _colour_names(root: str, rb_dir: str) -> set[str]:
    import gzip

    names = set()
    cfg = os.path.join(root, "LDConfig.ldr")
    if os.path.exists(cfg):
        for line in open(cfg, encoding="utf-8", errors="replace"):
            m = re.match(r"0\s+!COLOUR\s+(\S+)", line)
            if m:
                names.add(m.group(1).replace("_", " ").lower())
    path = os.path.join(rb_dir, "colors.csv.gz") if rb_dir else ""
    if path and os.path.exists(path):
        with gzip.open(path, "rt") as fh:
            names |= {r.split(",")[1].lower() for r in fh.read().splitlines()[1:] if "," in r}
    names |= {"light gray", "dark gray", "light yellow", "light flesh", "flesh"}  # legacy Studio/BrickLink names
    return names


if __name__ == "__main__":
    raise SystemExit(main())
