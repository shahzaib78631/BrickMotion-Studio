"""Identify a tracked part crop against LDraw templates (stage 2).

Each candidate part is rendered as an orthographic silhouette from a grid of
viewpoints; a crop's foreground mask is compared to every template with a
scale-free IoU weighted by aspect ratio. Colour is matched separately against
the LDraw colour table. Results are ranked candidates with scores, never a
single trusted answer: silhouette alone cannot separate near-identical parts, so
each match reports its margin over the runner-up.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("part_match needs opencv-python-headless") from e

from assembly_model.ldraw import LDrawLibrary

GRID = 64
YAWS = tuple(range(0, 360, 30))
PITCHES = (15, 30, 45, 60, 75)

# Common parts across the KenBrick builds (bricks, plates, slopes, tiles, round, SNOT).
CANDIDATES = [
    "3005", "3004", "3010", "3001", "3002", "3003", "3622", "3009", "3008", "3007", "3006",
    "3024", "3023", "3710", "3020", "3021", "3022", "3795", "3623", "3666", "3460", "3832",
    "3069b", "3070b", "3068b", "2431", "87079", "3069", "63864", "6636", "4073", "6141",
    "98138", "3062b", "3941", "4589", "3794b", "87087", "99207", "4733", "2540", "3937",
    "3031", "3032", "3035", "3036", "3958", "3039", "3040b", "3037", "3038", "3045",
    "3665", "4286", "2412b", "2420", "3298", "30414", "26603", "11477", "15573", "93273",
    "85984", "54200", "3070", "14719", "4081b", "4085c", "30136", "2339", "92946", "60481",
    "87580", "22885", "4032a", "3941", "32028", "3069b", "48336", "3941", "18674", "3176",
]


def _unique(seq):
    seen, out = set(), []
    for s in seq:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _rot(yaw: float, pitch: float) -> np.ndarray:
    ry, rx = math.radians(yaw), math.radians(pitch)
    Ry = np.array([[math.cos(ry), 0, math.sin(ry)], [0, 1, 0], [-math.sin(ry), 0, math.cos(ry)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(rx), -math.sin(rx)], [0, math.sin(rx), math.cos(rx)]])
    return Rx @ Ry


def silhouette(polys: list[np.ndarray], R: np.ndarray, size: int = 256, with_size: bool = False):
    """Orthographic silhouette of a polygon list (each (n,3), n=3 or 4) as a tight bool mask."""
    if not polys:
        return None
    proj = [(p @ R.T)[:, :2] for p in polys]
    allp = np.concatenate(proj)
    lo, hi = allp.min(0), allp.max(0)
    span = float(max(hi - lo))
    if span <= 1e-6:
        return None
    s = (size - 8) / span
    q = [((p - lo) * s + 4).astype(np.int32) for p in proj]
    img = np.zeros((size, size), np.uint8)
    for p in q:  # per polygon: a list fillPoly uses even-odd fill and punches holes at overlaps
        cv2.fillConvexPoly(img, p, 255)
    ys, xs = np.where(img > 0)
    if ys.size == 0:
        return None
    mask = img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1] > 0
    if with_size:
        return mask, (mask.shape[1] / s, mask.shape[0] / s)  # (w, h) in LDU
    return mask


def normalise(mask: np.ndarray) -> tuple[np.ndarray, float]:
    """Resize a tight-cropped mask to GRID x GRID; return (mask, aspect w/h)."""
    h, w = mask.shape
    m = cv2.resize(mask.astype(np.uint8) * 255, (GRID, GRID), interpolation=cv2.INTER_AREA) > 127
    return m, w / max(1, h)


@dataclass
class Template:
    part: str
    yaw: int
    pitch: int
    mask: np.ndarray
    aspect: float
    w_ldu: float = 0.0
    h_ldu: float = 0.0


def build_templates(lib: LDrawLibrary, parts: list[str] | None = None) -> list[Template]:
    out: list[Template] = []
    for part in _unique(parts or CANDIDATES):
        name = part if part.endswith(".dat") else part + ".dat"
        if lib.find(name) is None:
            continue
        polys = [np.asarray(c) for c in lib._tri_walk(name.lower(), np.eye(4)) if len(c) >= 3]
        if not polys:
            continue
        for yaw in YAWS:
            for pitch in PITCHES:
                res = silhouette(polys, _rot(yaw, pitch), with_size=True)
                if res is None:
                    continue
                sil, (wl, hl) = res
                m, a = normalise(sil)
                out.append(Template(part, yaw, pitch, m, a, wl, hl))
    return out


def crop_mask(crop_bgr: np.ndarray, thresh: int = 28) -> np.ndarray | None:
    m = (crop_bgr.max(axis=2) > thresh).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    if n <= 1:
        return None
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h = (int(v) for v in stats[k, :4])
    return lab[y : y + h, x : x + w] == k


def score(cm: np.ndarray, ca: float, t: Template) -> float:
    inter = float((cm & t.mask).sum())
    union = float((cm | t.mask).sum())
    iou = inter / union if union else 0.0
    return iou * math.exp(-abs(math.log(ca / t.aspect)))


def rank(crop_bgr: np.ndarray, templates: list[Template], top: int = 5) -> list[dict]:
    mask = crop_mask(crop_bgr)
    if mask is None:
        return []
    cm, ca = normalise(mask)
    best: dict[str, tuple[float, Template]] = {}
    for t in templates:
        s = score(cm, ca, t)
        if t.part not in best or s > best[t.part][0]:
            best[t.part] = (s, t)
    ranked = sorted(best.values(), key=lambda v: v[0], reverse=True)[:top]
    return [{"part": t.part, "score": round(s, 3), "yaw": t.yaw, "pitch": t.pitch} for s, t in ranked]


def nearest_colour(rgb: tuple[int, int, int], table: dict[int, tuple[int, int, int]], top: int = 3) -> list[tuple[int, float]]:
    """LDraw colour ids closest to a (lit) crop colour. Crops are shaded, so this
    is a hint (hue-weighted), not an exact read."""
    c = np.array(rgb, float)
    cn = c / max(1.0, np.linalg.norm(c))
    out = []
    for cid, v in table.items():
        if cid > 500 or cid in (16, 24):
            continue
        t = np.array(v, float)
        tn = t / max(1.0, np.linalg.norm(t))
        d = float(np.linalg.norm(cn - tn)) * 2 + abs(np.linalg.norm(c) - np.linalg.norm(t)) / 255 * 0.5
        out.append((cid, d))
    out.sort(key=lambda x: x[1])
    return out[:top]

