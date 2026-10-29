"""Match each callout part picture to an inventory element.

Callout and inventory pictures are the same booklet artwork at different scales, so both are
normalised (background trimmed, fitted into 48x48 on white) and compared by grayscale correlation
and the mean colour of the part in Lab.
"""
from __future__ import annotations

import glob
import json
import os

import numpy as np
import pymupdf

SIZE = 48
FIT = 40  # parts fill 40x40 inside the 48x48 frame, so even a solid block keeps an outline
BG_TOL = 18.0
SIZE_TOL = 0.15  # |ln(size ratio / k)| at which the size term reaches 0 (real spread is ~1%)
AMBIGUOUS_GAP = 0.05


def _load(path: str) -> np.ndarray:
    pix = pymupdf.Pixmap(path)
    if pix.alpha or pix.n != 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix, 0)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).astype(np.float32)


def _lab(rgb: np.ndarray) -> np.ndarray:
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]], np.float32)
    xyz /= np.array([0.95047, 1.0, 1.08883], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def _resize(img: np.ndarray, h: int, w: int) -> np.ndarray:
    ys = np.clip(((np.arange(h) + 0.5) * img.shape[0] / h).astype(int), 0, img.shape[0] - 1)
    xs = np.clip(((np.arange(w) + 0.5) * img.shape[1] / w).astype(int), 0, img.shape[1] - 1)
    return img[ys][:, xs]


def features(path: str) -> tuple[np.ndarray, np.ndarray, float] | None:
    """(48x48 grayscale on white, mean Lab colour of the part, drawn size in pixels) or None if empty."""
    img = _load(path)
    corners = np.stack([img[0, 0], img[0, -1], img[-1, 0], img[-1, -1]])
    bg = np.median(corners, axis=0)
    fg = np.linalg.norm(img - bg, axis=-1) > BG_TOL
    if fg.sum() < 4:
        return None
    ys, xs = np.nonzero(fg)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    part, mask = img[y0:y1, x0:x1].copy(), fg[y0:y1, x0:x1]
    part[~mask] = 255.0
    h, w = mask.shape
    s = FIT / max(h, w)
    nh, nw = max(1, round(h * s)), max(1, round(w * s))
    canvas = np.full((SIZE, SIZE, 3), 255.0, np.float32)
    oy, ox = (SIZE - nh) // 2, (SIZE - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = _resize(part, nh, nw)
    gray = canvas @ np.array([0.299, 0.587, 0.114], np.float32)
    return gray, _lab(img[fg]).mean(axis=0), float(np.hypot(h, w))


def score(a, b, k: float | None = None) -> float:
    """Shape correlation + colour closeness; with a known callout/inventory scale k, also drawn size."""
    ga, ca, da = a
    gb, cb, db = b
    sa, sb = ga.std(), gb.std()
    corr = float(((ga - ga.mean()) * (gb - gb.mean())).mean() / (sa * sb)) if sa > 0 and sb > 0 else 0.0
    colour = 1.0 - float(np.linalg.norm(ca - cb)) / 100.0
    if k is None:
        raw = 0.5 * corr + 0.5 * colour
    else:
        size = max(0.0, 1.0 - abs(float(np.log(da / (db * k)))) / SIZE_TOL)
        raw = 0.4 * corr + 0.4 * colour + 0.2 * size
    return float(min(1.0, max(0.0, raw)))


def _candidates(booklets: list[dict], work_dir: str) -> tuple[list[tuple[str, tuple]], dict[str, int]]:
    cands, counts = [], {}
    for b in booklets:
        for entry in b.get("inventory", []):
            counts[entry["element"]] = counts.get(entry["element"], 0) + entry["count"]
            if entry.get("crop"):
                f = features(os.path.join(work_dir, b["id"], entry["crop"]))
                if f is not None:
                    cands.append((entry["element"], f))
    if not counts:
        for path in sorted(glob.glob(os.path.join(work_dir, "rb-images", "*.jpg"))):
            f = features(path)
            if f is not None:
                cands.append((os.path.splitext(os.path.basename(path))[0], f))
    return cands, counts


def _scale(parts: list, cands: list, min_score: float) -> float | None:
    """Callout-to-candidate drawn-size ratio, from parts whose best match is clear."""
    ratios = []
    for f in parts:
        if f is None:
            continue
        ranked = sorted(((score(f, cf), cf) for _, cf in cands), key=lambda t: -t[0])
        if ranked and ranked[0][0] >= min_score and (len(ranked) == 1 or ranked[0][0] - ranked[1][0] >= AMBIGUOUS_GAP):
            ratios.append(f[2] / ranked[0][1][2])
    return float(np.median(ratios)) if len(ratios) >= 2 else None


def match_callouts(booklets: list[dict], work_dir: str, min_score: float = 0.7) -> dict:
    cands, inventory = _candidates(booklets, work_dir)
    refs = [(b["id"], step["number"], i, part) for b in booklets for step in b["steps"] for i, part in enumerate(step["callout"])]
    feats = [features(os.path.join(work_dir, bid, part["crop"])) for bid, _, _, part in refs]
    k = _scale(feats, cands, min_score) if inventory else None

    ranked: list[dict[str, float]] = []
    for f in feats:
        r: dict[str, float] = {}
        if f is not None:
            for element, cf in cands:
                r[element] = max(r.get(element, 0.0), score(f, cf, k))
        ranked.append(r)

    chosen: list[str | None] = [None] * len(refs)
    if inventory:
        left = dict(inventory)
        pairs = sorted(((s, i, e) for i, r in enumerate(ranked) for e, s in r.items() if s >= min_score), key=lambda t: -t[0])
        for s, i, e in pairs:
            if chosen[i] is None and left.get(e, 0) >= refs[i][3]["count"]:
                chosen[i] = e
                left[e] -= refs[i][3]["count"]
    for i, r in enumerate(ranked):  # nothing left fits: take the best and let over-use report it
        if chosen[i] is None and r:
            e, s = max(r.items(), key=lambda kv: kv[1])
            if s >= min_score:
                chosen[i] = e

    matches, used = [], {}
    for (bid, number, index, part), r, e in zip(refs, ranked, chosen):
        top = sorted(r.items(), key=lambda kv: -kv[1])[:3]
        if e:
            used[e] = used.get(e, 0) + part["count"]
        matches.append({
            "booklet": bid, "step": number, "index": index, "element": e,
            "score": round(r[e] if e else (top[0][1] if top else 0.0), 4),
            "alternatives": [{"element": a, "score": round(s, 4)} for a, s in top],
        })
    over = [{"element": e, "used": n, "inventory": inventory[e]} for e, n in sorted(used.items()) if e in inventory and n > inventory[e]]
    unused = [{"element": e, "left": n - used.get(e, 0)} for e, n in sorted(inventory.items()) if n > used.get(e, 0)]
    return {"matches": matches, "overUse": over, "unused": unused, "scale": k}


def match_work_dir(work_dir: str, min_score: float = 0.7) -> dict:
    booklets = []
    for path in sorted(glob.glob(os.path.join(work_dir, "*", "booklet.json"))):
        with open(path) as f:
            b = json.load(f)
        # the folder name is the booklet's id (two PDFs with one file name get distinct folders)
        b["id"] = os.path.basename(os.path.dirname(path))
        booklets.append(b)
    result = match_callouts(booklets, work_dir, min_score)
    with open(os.path.join(work_dir, "matches.json"), "w") as f:
        json.dump(result, f, indent=1)
    return result
