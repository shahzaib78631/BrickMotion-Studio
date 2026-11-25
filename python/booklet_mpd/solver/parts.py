"""Read which parts each step adds: callout pictures matched to the booklet's printed parts list.

The callout box of a step shows each new part once with its count ("2x"); the parts-list pages at
the back show every element once with its element number and total count. Both are renders of the
same part by the same renderer from the same standard view, so a callout picture is identified by
the parts-list picture it looks most like (shape: aspect-kept foreground mask; colour: median
non-ink foreground colour). Identical callout pictures across steps are one part, so their summed
count must fit in the element's printed total, which settles near-ties.

Element numbers become (LDraw part, LDraw colour) through Rebrickable: cached set inventories and
element lookups (`inventory_check.Rebrickable`), never the answer key. A printed part whose LDraw
file is missing falls back to the plain part and is flagged; anything unresolved is reported.
"""
from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from ..camera_fit import normalise
from ..stepimage import fill_holes

SIZE = 64               # 32 -> 64 px: fine detail (studs, holes) survives
LINES = 32              # grid of the inside-lines descriptor
INK = 60
DARK_PAGE = 80          # a page whose background is darker than this draws on black
REBRICKABLE = Path(__file__).resolve().parents[3] / ".cache/booklet-mpd/rebrickable"


@dataclass
class Descriptor:
    mask: np.ndarray        # SIZE x SIZE aspect-kept foreground
    colour: np.ndarray      # median non-ink foreground RGB
    aspect: float
    size: float = 0.0       # foreground bounding-box diagonal in crop pixels
    lines: np.ndarray | None = None     # LINES x LINES drawn lines inside the piece (studs, holes, edges)


def _background(rgb: np.ndarray) -> np.ndarray:
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]).reshape(-1, 3)
    values, counts = np.unique((border // 8).astype(int), axis=0, return_counts=True)
    return values[counts.argmax()] * 8 + 4


def describe(rgb: np.ndarray | None) -> Descriptor | None:
    if rgb is None or rgb.size == 0:
        return None
    bg = _background(rgb)
    grey = rgb.max(-1)
    fg = np.linalg.norm(rgb.astype(float) - bg, axis=-1) > 22
    if bg.max() >= DARK_PAGE:           # on a near-black page (75277, 21036) dark pixels are page, not ink
        fg |= grey < INK
    fg = cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    fg = fill_holes(fg.astype(bool))      # white parts on pale backgrounds: the outline closes them
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg.astype(np.uint8), connectivity=8)
    if count <= 1:
        return None
    big = [i for i in range(1, count) if stats[i][4] >= 0.08 * stats[1:, 4].max()]
    fg = np.isin(labels, big)
    ys, xs = np.where(fg)
    # colour: the part's inside (outline eroded away), dark pixels kept: a black part's body is darker
    # than the ink cut-off, so dropping ink-dark pixels read black as the grey of its highlights
    inner = cv2.erode(fg.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    pix = rgb[inner] if inner.sum() >= 20 else rgb[fg]
    colour = np.median(pix, axis=0)
    # inside lines: dark strokes on a light page, light strokes on a dark one, within the piece
    lap = cv2.Laplacian(cv2.GaussianBlur(grey.astype(float), (3, 3), 0), cv2.CV_64F, ksize=3)
    strokes = (lap > 25) if bg.max() < DARK_PAGE else (lap < -25)
    lines = cv2.dilate(normalise(strokes & inner, LINES).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    return Descriptor(normalise(fg, SIZE), colour.astype(float), (np.ptp(xs) + 1) / (np.ptp(ys) + 1),
                      float(np.hypot(np.ptp(xs) + 1, np.ptp(ys) + 1)), lines)


LINES_WEIGHT = 0.15      # inside-lines overlap (gate 1: +11 parts on top of Lab + 64 px)
COLOUR_SCALE = 15.0      # CIELAB distance at which the colour term falls to 1/e


def _lab(rgb: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(np.uint8([[np.clip(rgb, 0, 255)]]), cv2.COLOR_RGB2LAB)[0, 0].astype(float)
    return lab * [100 / 255, 1, 1] - [0, 128, 128]


RENDER_YAW, RENDER_PITCH = 45.0, 30.0   # parts-list-style view of a rendered candidate
RENDERED_CONFIDENT = 0.65    # renders never match a callout as closely as LEGO's own art (0.85 -> no scale learnt)
CALLOUT_PX_PER_LDU = 2.29    # LEGO draws callouts at one scale: 2.25-2.31 px/LDU at the 300-dpi crops on 7 booklets
PARTSNET_WEIGHT = float(os.environ.get("PARTSNET_W", "0.5"))   # learned matcher's share (P5)


def _partsnet_weight() -> float:
    if "PARTSNET_W" in os.environ:
        return float(os.environ["PARTSNET_W"])
    f = REBRICKABLE.parent / "partsnet-weight.txt"
    return float(f.read_text().strip()) if f.exists() else PARTSNET_WEIGHT
SIZE_WEIGHT = 0.25        # weight of the absolute-size term once the callout / parts-list scale is known
SIZE_SHARPNESS = 5.0      # 1x5 vs 1x6 plate: ~15% longer -> term drops to ~0.5


def similarity(a: Descriptor, b: Descriptor, ratio: float | None = None) -> float:
    """`ratio`: callout size / parts-list size for the same part (one booklet draws both at fixed scales).
    Without it, shape, colour and aspect only (a 2x2 and a 3x3 plate look alike)."""
    inter = np.logical_and(a.mask, b.mask).sum()
    union = np.logical_or(a.mask, b.mask).sum()
    shape = inter / union if union else 0.0
    colour = float(np.exp(-np.linalg.norm(_lab(a.colour) - _lab(b.colour)) / COLOUR_SCALE))   # Lab: 88.1% -> 88.6%
    aspect = float(np.exp(-abs(np.log(max(a.aspect, 1e-3) / max(b.aspect, 1e-3))) * 2.0))
    base = 0.5 * shape + 0.35 * colour + 0.15 * aspect
    if a.lines is not None and b.lines is not None:
        union = np.logical_or(a.lines, b.lines).sum()
        base = (1 - LINES_WEIGHT) * base + LINES_WEIGHT * (np.logical_and(a.lines, b.lines).sum() / union if union else 1.0)
    if not ratio or not a.size or not b.size:
        return base
    size = float(np.exp(-abs(np.log(a.size / (ratio * b.size))) * SIZE_SHARPNESS))
    return (1 - SIZE_WEIGHT) * base + SIZE_WEIGHT * size


TEMPLATE_WEIGHT = float(os.environ.get("TEMPLATE_W", "0.3"))   # share of the overlay term among the top candidates
TEMPLATE_MIN = float(os.environ.get("TEMPLATE_MIN", "0.8"))  # best overlay below this: scale is off, term unused
TEMPLATE_TOP = 6          # candidates per callout picture that get the overlay term
TEMPLATE_SCALES = (0.94, 0.97, 1.0, 1.03, 1.06)


def template_score(call: np.ndarray | None, listed: np.ndarray | None, ratio: float) -> float:
    """How well the parts-list picture, scaled by the booklet's callout / parts-list ratio, lies over the
    callout picture: the best normalised correlation of the grey images over small shifts and +-6% scale.
    Both are LEGO's drawing of one render, so the same part matches almost pixel for pixel while a
    look-alike (3 studs vs 2) does not. 0 without a picture."""
    if call is None or listed is None or not ratio:
        return 0.0
    a = cv2.cvtColor(call, cv2.COLOR_RGB2GRAY).astype(np.float32)
    b = cv2.cvtColor(listed, cv2.COLOR_RGB2GRAY).astype(np.float32)
    best = 0.0
    for k in TEMPLATE_SCALES:
        r = ratio * k
        bb = cv2.resize(b, (max(1, round(b.shape[1] * r)), max(1, round(b.shape[0] * r))), interpolation=cv2.INTER_AREA)
        small, big = (bb, a) if bb.shape[0] <= a.shape[0] and bb.shape[1] <= a.shape[1] else (a, bb)
        big = cv2.copyMakeBorder(big, 8, 8, 8, 8, cv2.BORDER_REPLICATE)
        if small.shape[0] > big.shape[0] or small.shape[1] > big.shape[1] or small.std() < 1e-3:
            continue
        best = max(best, float(cv2.matchTemplate(big, small, cv2.TM_CCOEFF_NORMED).max()))
    return best


def size_ratio(descs: dict, inv_desc: list, confident: float = 0.85) -> float | None:
    """Callout / parts-list drawing scale: median size ratio of confident best matches (shape, colour
    and aspect only). None when too few callouts match confidently."""
    ratios = []
    flat = [(j, d) for j, ds in enumerate(inv_desc) if ds is not None for d in (ds if isinstance(ds, list) else [ds])]
    for d in descs.values():
        if d is None or not d.size:
            continue
        sims = sorted(((similarity(d, b), b) for _j, b in flat), key=lambda x: -x[0])
        if sims and sims[0][0] > confident and sims[0][1].size:
            ratios.append(d.size / sims[0][1].size)
    return float(np.median(ratios)) if len(ratios) >= 5 else None


# ------------------------------------------------------------------ element -> LDraw

def element_index(cache: Path = REBRICKABLE) -> dict[str, dict]:
    """element id -> {ldrawPart, ldrawAll, color, part} from every cached Rebrickable record."""
    index: dict[str, dict] = {}
    if not cache.is_dir():
        return index
    for path in sorted(cache.glob("*-*.json")):
        try:
            rows = json.loads(path.read_text())
        except (ValueError, OSError):
            continue
        if isinstance(rows, list):
            for r in rows:
                if r.get("element") and r.get("color") is not None:
                    index.setdefault(str(r["element"]), r)
    el = cache / "elements.json"
    if el.is_file():
        for k, r in json.loads(el.read_text()).items():
            if r and r.get("color") is not None:
                index[str(k)] = r
    return index


def rebrickable_client(cache: Path = REBRICKABLE):
    """Read-only Rebrickable client (key from REBRICKABLE_API_KEY, 1.1 s between calls, every answer
    cached); None when no key is set, in which case only the cache is used."""
    key = os.environ.get("REBRICKABLE_API_KEY", "")
    if not key.strip():
        return None
    from ..inventory_check import Rebrickable
    return Rebrickable(key, cache)


def resolve_element(element: str, index: dict, client=None) -> dict | None:
    if element in index:
        return index[element]
    if client is None:
        return None
    try:
        record = client.element(element)
    except Exception:
        return None
    if record and record.get("color") is not None:
        index[element] = record
        return record
    return None


_PRINT = re.compile(r"^(\d+[a-z]?)(?:pr|p|pat|pb)[0-9a-z]+$")


def ldraw_part(lib, record: dict) -> tuple[str | None, list[str]]:
    """The first LDraw id of the record the library has; a printed id falls back to its plain part."""
    flags = []
    ids = [i.lower() for i in (record.get("ldrawAll") or [])] + [str(record.get("ldrawPart") or "").lower(), str(record.get("part") or "").lower()]
    for i in ids:
        if i and lib.find(i + ".dat"):
            return i, flags
    for i in ids:
        m = _PRINT.match(i)
        if m:
            for plain in (m.group(1), re.sub(r"[a-z]$", "", m.group(1))):
                if lib.find(plain + ".dat"):
                    return plain, flags + [f"printed part {i} drawn as plain {plain}"]
    return None, flags + [f"no LDraw file for {ids[0] if ids else '?'}"]


# ------------------------------------------------------------------ booklet reading

@dataclass
class StepParts:
    parts: list[tuple[str, int]]                     # (LDraw id, colour), one entry per piece
    confidence: list[float]                          # per piece: identification confidence
    unresolved: int = 0                              # callout pieces that could not be identified
    notes: list[str] = field(default_factory=list)


UNUSED_PENALTY = 0.3      # per printed piece left unconsumed (0.02 -> 0.3: gate 1 87.4% -> 88.1%; 2.0 same)
OVER_PENALTY = 0.3        # per piece beyond an element's printed count


def assign(descs: dict, totals: dict, inv_desc: list, counts: list[int], ratio: float | None = None,
           learned: dict | None = None, template: tuple | None = None,
           valid_crop: list[bool] | None = None) -> dict:
    """Callout picture group -> (element index, similarity, margin to the runner-up element).
    Maximise total similarity subject to each group taking one element, with soft count terms:
    an element's printed count should be consumed (callout totals summed), not exceeded.
    `template`: (callout picture per group, parts-list picture per element) for `template_score`, which
    re-scores each group's TEMPLATE_TOP best elements (the others lose its share).
    `valid_crop`: per inventory entry, whether it has a healthy native PDF parts-list crop (False for
    repaired clipped crops or Rebrickable-supplemented rendered entries, which must not be penalised
    by zero PartsNet/template scores)."""
    from scipy.optimize import Bounds, LinearConstraint, milp

    keys = [k for k, d in descs.items() if d is not None]
    elems = [j for j, d in enumerate(inv_desc) if d is not None]
    if not keys or not elems:
        return {}
    sim = np.array([[max(similarity(descs[k], d, ratio) for d in (inv_desc[j] if isinstance(inv_desc[j], list) else [inv_desc[j]]))
                     for j in elems] for k in keys])
    vc_arr = np.array([bool(valid_crop[j]) for j in elems]) if valid_crop is not None else np.ones(len(elems), dtype=bool)
    if learned:                         # P5: the learned cosine per group over all inventory entries
        w_pn = _partsnet_weight()
        if w_pn > 0.0:
            cos = np.array([[learned[k][j] if k in learned else 0.0 for j in elems] for k in keys])
            has = np.array([k in learned for k in keys])[:, None] & (cos > -1.5)
            sim = np.where(has, (1.0 - w_pn) * sim + w_pn * cos, sim)
    if template:                        # overlay of the scaled parts-list picture on the callout, top candidates
        call_of, listed = template
        for g, k in enumerate(keys):
            if call_of.get(k) is None:
                continue
            top = np.argsort(-sim[g])[:TEMPLATE_TOP]
            # Only award greyscale template credit to colour-compatible candidates (prevents e.g. a yellow
            # 4x4 plate from winning greyscale correlation over a clipped dark-grey 4x4 plate!)
            scores = []
            for e in top:
                if not vc_arr[e] or listed[elems[e]] is None:
                    scores.append(0.0)
                    continue
                inv_d = inv_desc[elems[e]]
                inv_ds = inv_d if isinstance(inv_d, list) else [inv_d]
                min_cd = min(float(np.linalg.norm(_lab(descs[k].colour) - _lab(d.colour))) for d in inv_ds)
                sc_t = template_score(call_of[k], listed[elems[e]], ratio) if min_cd < 32.0 else 0.0
                scores.append(sc_t)
            if max(scores) < TEMPLATE_MIN:      # nothing lies over it: a big part drawn smaller in the callout
                continue
            sim[g, vc_arr] *= 1 - TEMPLATE_WEIGHT               # non-crop entries keep their full descriptor similarity
            for e, score in zip(top, scores):
                if vc_arr[e]:
                    sim[g, e] += TEMPLATE_WEIGHT * score
    if valid_crop is not None and not vc_arr.all():
        sim[:, ~vc_arr] -= 0.02         # tiny tie-breaker preferring healthy native PDF art on exact ties
    G, E = sim.shape
    n = G * E + 2 * E                   # x_ge, unused_e, over_e
    c = np.zeros(n)
    c[:G * E] = -sim.ravel()
    c[G * E:G * E + E] = UNUSED_PENALTY
    c[G * E + E:] = OVER_PENALTY
    rows, lo, hi = [], [], []
    for g in range(G):                  # one element per group
        r = np.zeros(n)
        r[g * E:(g + 1) * E] = 1
        rows.append(r); lo.append(1); hi.append(1)
    for e in range(E):                  # sum totals - count = over - unused
        r = np.zeros(n)
        for g in range(G):
            r[g * E + e] = totals[keys[g]]
        r[G * E + e] = 1
        r[G * E + E + e] = -1
        rows.append(r); lo.append(counts[elems[e]]); hi.append(counts[elems[e]])
    integrality = np.r_[np.ones(G * E), np.zeros(2 * E)]
    bounds = Bounds(np.zeros(n), np.r_[np.ones(G * E), np.full(2 * E, np.inf)])
    res = milp(c, constraints=LinearConstraint(np.array(rows), lo, hi), integrality=integrality, bounds=bounds,
               options={"time_limit": 20})
    out = {}
    if res.x is None:
        for g, k in enumerate(keys):
            e = int(sim[g].argmax())
            out[k] = (elems[e], float(sim[g, e]), 0.0)
        return out
    x = res.x[:G * E].reshape(G, E)
    for g, k in enumerate(keys):
        e = int(x[g].argmax())
        others = np.delete(sim[g], e)
        out[k] = (elems[e], float(sim[g, e]), float(sim[g, e] - (others.max() if len(others) else 0.0)))
    return out


def render_part_rgb(lib, part: str, colour: int, matrix: np.ndarray | None = None) -> np.ndarray | None:
    """NPR booklet-style 112x112 RGB render of an LDraw part (flat colour + internal/silhouette
    depth-edge outlines, using light-grey seams on dark parts just like LEGO instructions)."""
    from .picture import colour_rgb
    from .render import View, bounds, mesh, render
    if not len(mesh(lib, part)):
        return None
    parts = [(part, colour, np.eye(4) if matrix is None else matrix)]
    view = View(np.eye(3), RENDER_YAW, RENDER_PITCH, 1.0, (0.0, 0.0))
    lo, hi = bounds(lib, parts, view)
    k = 96.0 / float(max(hi[0] - lo[0], hi[1] - lo[1], 1.0))
    view = view.replace(scale=k)
    lo, hi = bounds(lib, parts, view)
    view = view.replace(offset=(8 - lo[0], 8 - lo[1]))
    depth, label = render(lib, parts, view, (112, 112))
    mask = (label >= 0)
    if not mask.any():
        return None
    rgb_c = np.array(colour_rgb(colour), dtype=np.float32)
    img = np.full((112, 112, 3), 255, np.uint8)
    # Subtle depth shading (front faces slightly brighter, recessed faces darker) + crisp seams
    d_fg = depth[mask]
    d_lo, d_hi = float(d_fg.min()), float(d_fg.max())
    shade = np.ones((112, 112), np.float32)
    if d_hi > d_lo + 1e-3:
        shade[mask] = 1.06 - 0.18 * ((depth[mask] - d_lo) / (d_hi - d_lo))
    shaded = np.clip(rgb_c[None, None, :] * shade[:, :, None], 0, 255).astype(np.uint8)
    img[mask] = shaded[mask]
    # Depth discontinuity edges (studs, holes, bevels) + silhouette contour
    d_fill = np.where(mask, depth, d_hi + 20.0).astype(np.float32)
    gx = np.abs(np.diff(d_fill, axis=1, prepend=d_fill[:, :1]))
    gy = np.abs(np.diff(d_fill, axis=0, prepend=d_fill[:1, :]))
    edge_in = mask & ((gx > 2.2) | (gy > 2.2))
    is_dark = float(rgb_c.max()) < 65.0
    img[edge_in] = (145, 145, 145) if is_dark else (30, 30, 30)
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(img, contours, -1, (120, 120, 120) if is_dark else (20, 20, 20), 1)
    return img


def rendered_part_images(lib, part: str, colour: int) -> list[np.ndarray]:
    """The 4 upright NPR renders of an LDraw part for PartsNet fallback matching."""
    out = []
    for turn in range(4):
        a = np.radians(90 * turn)
        m = np.eye(4)
        m[:3, :3] = [[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]]
        img = render_part_rgb(lib, part, colour, m)
        if img is not None:
            out.append(img)
    return out


def rendered_descriptors(lib, part: str, colour: int) -> list[Descriptor] | None:
    """The part drawn in the four upright turns (a parts-list picture may show any of them)."""
    out = []
    for turn in range(4):
        a = np.radians(90 * turn)
        m = np.eye(4)
        m[:3, :3] = [[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]]
        d = rendered_descriptor(lib, part, colour, m)
        if d is not None:
            out.append(d)
    return out or None


def rendered_descriptor(lib, part: str, colour: int, matrix: np.ndarray | None = None) -> Descriptor | None:
    """Descriptor of an LDraw part drawn like a parts-list picture (iso view, flat colour, dark
    outline): stands in for the printed picture when the booklet has no parts list."""
    from .picture import colour_rgb
    from .render import View, bounds, render
    from .render import mesh
    if not len(mesh(lib, part)):
        return None
    parts = [(part, colour, np.eye(4) if matrix is None else matrix)]
    view = View(np.eye(3), RENDER_YAW, RENDER_PITCH, 1.0, (0.0, 0.0))
    lo, hi = bounds(lib, parts, view)
    k = 96.0 / float(max(hi[0] - lo[0], hi[1] - lo[1], 1.0))
    view = view.replace(scale=k)
    lo, hi = bounds(lib, parts, view)
    view = view.replace(offset=(8 - lo[0], 8 - lo[1]))
    _depth, label = render(lib, parts, view, (112, 112))
    mask = (label >= 0).astype(np.uint8)
    if not mask.any():
        return None
    img = np.full((112, 112, 3), 255, np.uint8)
    img[mask > 0] = colour_rgb(colour)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(img, contours, -1, (20, 20, 20), 1)
    d = describe(img)
    if d is not None:
        d.size /= k            # in LDU: the picture is drawn at 96 px, its size stays the part's real size
    return d


_SET = re.compile(r"\b(\d{4,6})\b")


def set_number_from_pdf(doc) -> str | None:
    """The set number printed on the booklet: prefer LEGO's official '<set>-<booklet>.pdf' filename
    first (never hijacked by back-cover advertisements for other sets!), then cover-page numbers in the
    Rebrickable cache, then back-cover numbers, then the most-repeated 4-6 digit number."""
    from collections import Counter
    named = re.match(r"(\d{4,6})-\d+\.pdf$", Path(doc.name or "").name)     # LEGO's '<set>-<booklet>.pdf'
    if named:
        return named.group(1)
    cover = [doc[i] for i in sorted({0, 1}) if 0 <= i < len(doc)]
    back = [doc[i] for i in sorted({len(doc) - 2, len(doc) - 1}) if 0 <= i < len(doc) and i not in (0, 1)]
    c_cover = Counter(m for p in cover for m in _SET.findall(p.get_text()) if not m.startswith(("19", "20")) or len(m) != 4)
    for m, _c in c_cover.most_common():
        if (REBRICKABLE / f"{m}-1.json").exists():
            return m
    c_all = c_cover + Counter(m for p in back for m in _SET.findall(p.get_text()) if not m.startswith(("19", "20")) or len(m) != 4)
    for m, _c in c_all.most_common():
        if (REBRICKABLE / f"{m}-1.json").exists():
            return m
    if c_cover:
        return c_cover.most_common(1)[0][0]
    if c_all:
        return c_all.most_common(1)[0][0]
    return None


def fallback_inventory(lib, set_number: str, client, index: dict, exclude: set[tuple[str, int]] | None = None) -> list[dict]:
    """Parts list from the set's Rebrickable inventory (read-only, cached) when the booklet prints
    none — or only the missing `(ldraw_part, colour)` entries when supplementing a partial printed parts
    list (`exclude` = already-present `(part, colour)` pairs): [{'element', 'count', 'desc'}]."""
    try:
        rows = client.set_parts(f"{set_number}-1") if client is not None else None
    except Exception:
        rows = None
    if rows is None:
        cached = REBRICKABLE / f"{set_number}-1.json"
        rows = json.loads(cached.read_text()) if cached.exists() else []
    out = []
    for r in rows:
        if r.get("spare") or r.get("color") is None:
            continue
        element = str(r.get("element") or f"{r.get('part')}:{r.get('color')}")
        index.setdefault(element, {k: r.get(k) for k in ("ldrawPart", "ldrawAll", "color", "part")})
        part, _notes = ldraw_part(lib, index[element])
        if exclude is not None and (part is None or (part, int(r["color"])) in exclude):
            continue
        out.append({"element": element, "count": int(r.get("quantity", 0)),
                    "desc": rendered_descriptors(lib, part, int(r["color"])) if part else None,
                    "renders": rendered_part_images(lib, part, int(r["color"])) if part else None})
    return out


def _read(folder: Path, rel: str | None):
    if not rel:
        return None
    img = cv2.imread(str(folder / rel))
    return None if img is None else cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def step_callouts(step: dict) -> list[tuple[int, dict]]:
    """A step's callouts as (index, callout). A picture embedded twice at the same box (Technic PDFs) is one
    callout: the first is kept, with the larger of the two counts."""
    out, at = [], {}
    for ci, call in enumerate(step.get("callout", [])):
        box = call.get("box")
        key = tuple(round(v) for v in box) if box else None
        if key is not None and key in at:
            first = out[at[key]][1]
            if int(call.get("count", 1) or 1) > int(first.get("count", 1) or 1):
                out[at[key]] = (out[at[key]][0], {**first, "count": call.get("count")})
            continue
        if key is not None:
            at[key] = len(out)
        out.append((ci, call))
    return out


def _learned(pictures: dict, inventory: list, folder: Path) -> dict | None:
    """P5: cosine of the learned embedding between each callout picture and every inventory entry
    (using the printed parts-list crop when present, or the max cosine over its 4 NPR LDraw renders
    when using Rebrickable fallback / supplemented entries!). Entries without any visual return -2.0."""
    from . import partsnet
    net = partsnet.loaded(os.environ.get("PARTSNET", str(partsnet.WEIGHTS)))
    if net is None or not pictures:
        return None
    inv_imgs: list[np.ndarray] = []
    entry_slices: list[tuple[int, int]] = []
    for e in inventory:
        crop = _read(folder, e.get("crop"))
        if crop is not None:
            s = len(inv_imgs)
            inv_imgs.append(crop)
            entry_slices.append((s, s + 1))
        elif e.get("renders"):
            s = len(inv_imgs)
            inv_imgs.extend(e["renders"])
            entry_slices.append((s, len(inv_imgs)))
        else:
            entry_slices.append((-1, -1))
    if not inv_imgs:
        return None
    zi = partsnet.embed(net, inv_imgs)
    keys = list(pictures)
    zc = partsnet.embed(net, [pictures[k] for k in keys])
    raw_cos = zc @ zi.T
    out_cos = np.full((len(keys), len(inventory)), -2.0, dtype=np.float32)
    for j, (s, t) in enumerate(entry_slices):
        if s >= 0:
            out_cos[:, j] = raw_cos[:, s:t].max(axis=1)
    return {k: out_cos[i] for i, k in enumerate(keys)}


def read_parts(lib, extract: dict, folder: Path, index: dict, client=None, fallback: list[dict] | None = None) -> tuple[list[StepParts], dict]:
    """Per extracted step, the parts it adds. Returns (steps, report). `fallback`: full Rebrickable parts
    list when the booklet prints none, OR missing elements to supplement a partial printed parts list."""
    inventory = [e for e in extract.get("inventory", []) if e.get("element")]
    inv_crops = [_read(folder, e.get("crop")) for e in inventory]
    inv_desc = [describe(img) for img in inv_crops]
    used_fallback = False
    if not inventory and fallback:
        inventory = [e for e in fallback if e.get("desc") is not None]
        inv_crops = [None] * len(inventory)
        inv_desc = [e["desc"] for e in inventory]
        used_fallback = True
    records = [resolve_element(e["element"], index, client) for e in inventory]
    resolved = []
    for e, rec in zip(inventory, records):
        if rec is None:
            resolved.append((None, ["element %s unknown to Rebrickable cache" % e["element"]]))
        else:
            part, notes = ldraw_part(lib, rec)
            resolved.append(((part, int(rec["color"])) if part else None, notes))
    valid_crop = [(img is not None and d is not None) for img, d in zip(inv_crops, inv_desc)]
    # Detect & repair clipped PDF parts-list crops (e.g. a 4x4 plate cropped at the bottom of a column
    # to half its real diagonal while another colour of the same LDraw part has a healthy crop!)
    if not used_fallback:
        by_part: dict[str, list[int]] = defaultdict(list)
        for j, (res_j, d) in enumerate(zip(resolved, inv_desc)):
            if res_j[0] is not None and d is not None and not isinstance(d, list) and d.size > 0:
                by_part[res_j[0][0]].append(j)
        for _part_id, idxs in by_part.items():
            if len(idxs) < 2:
                continue
            best_j = max(idxs, key=lambda j: inv_desc[j].size)
            max_sz = inv_desc[best_j].size
            sib = inv_desc[best_j]
            for j in idxs:
                if inv_desc[j].size < 0.72 * max_sz:
                    inv_desc[j] = Descriptor(sib.mask, inv_desc[j].colour, sib.aspect, sib.size, sib.lines)
                    inv_crops[j] = None
                    valid_crop[j] = False
    # group identical callout pictures (same crop content) across steps
    groups: dict[str, list[tuple[int, int]]] = defaultdict(list)
    descs: dict[str, Descriptor | None] = {}
    pictures: dict[str, np.ndarray] = {}
    for si, step in enumerate(extract["steps"]):
        for ci, call in step_callouts(step):
            img = _read(folder, call.get("crop"))
            key = "none" if img is None else f"{img.shape}:{hash(img.tobytes())}"
            groups[key].append((si, ci))
            if key not in descs:
                descs[key] = describe(img)
                if img is not None:
                    pictures[key] = img
    counts_at = {(si, ci): int(call.get("count", 1) or 1) for si, step in enumerate(extract["steps"]) for ci, call in step_callouts(step)}
    totals = {k: sum(counts_at[si, ci] for si, ci in v) for k, v in groups.items()}
    ratio = size_ratio(descs, inv_desc, RENDERED_CONFIDENT if used_fallback else 0.85)   # parts-list scale, or callout px per LDU
    if ratio is None and used_fallback:
        ratio = CALLOUT_PX_PER_LDU
    # Supplement a partial PDF parts list with any missing Rebrickable elements (e.g. clipped off bottom of page)
    supplemented = 0
    if not used_fallback and fallback:
        have_pc = {r[0] for r in resolved if r[0] is not None}
        inv_px_per_ldu = (CALLOUT_PX_PER_LDU / ratio) if ratio else (CALLOUT_PX_PER_LDU / 1.33)
        for fe in fallback:
            if fe.get("desc") is None:
                continue
            rec = resolve_element(fe["element"], index, client)
            if rec is None:
                continue
            part, notes = ldraw_part(lib, rec)
            if part is None or (part, int(rec["color"])) in have_pc:
                continue
            have_pc.add((part, int(rec["color"])))
            scaled = [Descriptor(d.mask, d.colour, d.aspect, d.size * inv_px_per_ldu, d.lines)
                      for d in (fe["desc"] if isinstance(fe["desc"], list) else [fe["desc"]])]
            inventory.append(fe)
            inv_crops.append(None)
            inv_desc.append(scaled)
            resolved.append(((part, int(rec["color"])), notes))
            valid_crop.append(False)
            supplemented += 1
    overlay = None
    if not used_fallback and ratio and TEMPLATE_WEIGHT > 0:     # LEGO's own parts-list art, at a known scale
        overlay = (pictures, inv_crops)
    # Build learned visual embeddings for both native printed crops AND Rebrickable rendered entries!
    learned_inv = []
    for e, vc in zip(inventory, valid_crop):
        if not used_fallback and vc:
            learned_inv.append({"crop": e.get("crop")})
        elif e.get("renders"):
            learned_inv.append({"renders": e["renders"]})
        else:
            learned_inv.append({})
    learned = _learned(pictures, learned_inv, folder)
    assigned = assign(descs, totals, inv_desc, [int(e.get("count", 0) or 0) for e in inventory], ratio,
                      learned=learned, template=overlay, valid_crop=None if used_fallback else valid_crop)
    steps_out = []
    unresolved_total = 0
    for si, step in enumerate(extract["steps"]):
        parts, conf, notes = [], [], []
        unresolved = 0
        for ci, call in step_callouts(step):
            count = int(call.get("count", 1) or 1)
            key = next(k for k, v in groups.items() if (si, ci) in v)
            hit = assigned.get(key)
            target = resolved[hit[0]][0] if hit else None
            if target is None:
                unresolved += count
                notes.append(f"callout {ci}: unidentified" if not hit else f"callout {ci}: " + "; ".join(resolved[hit[0]][1]))
                continue
            notes.extend(resolved[hit[0]][1])
            c = float(min(1.0, max(0.0, hit[1])) * (0.5 + 0.5 * min(1.0, hit[2] / 0.1)))
            parts.extend([target] * count)
            conf.extend([c] * count)
        unresolved_total += unresolved
        steps_out.append(StepParts(parts, conf, unresolved, notes))
    report = {"inventory_entries": len(inventory), "inventory_resolved": sum(1 for r, _ in resolved if r),
              "callout_pictures": len(groups), "callout_pieces": sum(int(c.get("count", 1) or 1) for s in extract["steps"] for c in s.get("callout", [])),
              "unresolved_pieces": unresolved_total, "has_inventory": bool(inventory) and not used_fallback,
              "rebrickable_inventory": used_fallback, "supplemented": supplemented, "size_ratio": ratio}
    return steps_out, report
