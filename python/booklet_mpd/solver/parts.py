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

SIZE = 32
INK = 60
REBRICKABLE = Path(__file__).resolve().parents[3] / ".cache/booklet-mpd/rebrickable"


@dataclass
class Descriptor:
    mask: np.ndarray        # SIZE x SIZE aspect-kept foreground
    colour: np.ndarray      # median non-ink foreground RGB
    aspect: float


def _background(rgb: np.ndarray) -> np.ndarray:
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]).reshape(-1, 3)
    values, counts = np.unique((border // 8).astype(int), axis=0, return_counts=True)
    return values[counts.argmax()] * 8 + 4


def describe(rgb: np.ndarray | None) -> Descriptor | None:
    if rgb is None or rgb.size == 0:
        return None
    bg = _background(rgb)
    grey = rgb.max(-1)
    fg = (np.linalg.norm(rgb.astype(float) - bg, axis=-1) > 22) | (grey < INK)
    fg = cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    fg = fill_holes(fg.astype(bool))      # white parts on pale backgrounds: the outline closes them
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg.astype(np.uint8), connectivity=8)
    if count <= 1:
        return None
    big = [i for i in range(1, count) if stats[i][4] >= 0.08 * stats[1:, 4].max()]
    fg = np.isin(labels, big)
    ys, xs = np.where(fg)
    pix = rgb[fg]
    keep = pix.max(-1) >= INK
    colour = np.median(pix[keep], axis=0) if keep.any() else np.median(pix, axis=0)
    return Descriptor(normalise(fg, SIZE), colour.astype(float), (np.ptp(xs) + 1) / (np.ptp(ys) + 1))


def similarity(a: Descriptor, b: Descriptor) -> float:
    inter = np.logical_and(a.mask, b.mask).sum()
    union = np.logical_or(a.mask, b.mask).sum()
    shape = inter / union if union else 0.0
    colour = float(np.exp(-np.linalg.norm(a.colour - b.colour) / 35.0))
    aspect = float(np.exp(-abs(np.log(max(a.aspect, 1e-3) / max(b.aspect, 1e-3))) * 2.0))
    return 0.5 * shape + 0.35 * colour + 0.15 * aspect


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


UNUSED_PENALTY = 0.02     # per printed piece left unconsumed
OVER_PENALTY = 0.05       # per piece beyond an element's printed count


def assign(descs: dict, totals: dict, inv_desc: list, counts: list[int]) -> dict:
    """Callout picture group -> (element index, similarity, margin to the runner-up element).
    Maximise total similarity subject to each group taking one element, with soft count terms:
    an element's printed count should be consumed (callout totals summed), not exceeded."""
    from scipy.optimize import Bounds, LinearConstraint, milp

    keys = [k for k, d in descs.items() if d is not None]
    elems = [j for j, d in enumerate(inv_desc) if d is not None]
    if not keys or not elems:
        return {}
    sim = np.array([[similarity(descs[k], inv_desc[j]) for j in elems] for k in keys])
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


def rendered_descriptor(lib, part: str, colour: int) -> Descriptor | None:
    """Descriptor of an LDraw part drawn like a parts-list picture (iso view, flat colour, dark
    outline): stands in for the printed picture when the booklet has no parts list."""
    from .picture import colour_rgb
    from .render import View, bounds, render
    from .render import mesh
    if not len(mesh(lib, part)):
        return None
    parts = [(part, colour, np.eye(4))]
    view = View(np.eye(3), 45.0, 30.0, 1.0, (0.0, 0.0))
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
    return describe(img)


_SET = re.compile(r"\b(\d{4,6})\b")


def set_number_from_pdf(doc) -> str | None:
    """The set number printed on the booklet: the 4-6 digit number repeated most on the first and
    last pages (cover, back cover)."""
    from collections import Counter
    pages = [doc[i] for i in sorted({0, 1, len(doc) - 2, len(doc) - 1}) if 0 <= i < len(doc)]
    counts = Counter(m for p in pages for m in _SET.findall(p.get_text()) if not m.startswith(("19", "20")) or len(m) != 4)
    return counts.most_common(1)[0][0] if counts else None


def fallback_inventory(lib, set_number: str, client, index: dict) -> list[dict]:
    """Parts list from the set's Rebrickable inventory (read-only, cached) when the booklet prints
    none: [{'element', 'count', 'desc'}], pictures rendered from the LDraw parts."""
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
        out.append({"element": element, "count": int(r.get("quantity", 0)),
                    "desc": rendered_descriptor(lib, part, int(r["color"])) if part else None})
    return out


def _read(folder: Path, rel: str | None):
    if not rel:
        return None
    img = cv2.imread(str(folder / rel))
    return None if img is None else cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def read_parts(lib, extract: dict, folder: Path, index: dict, client=None, fallback: list[dict] | None = None) -> tuple[list[StepParts], dict]:
    """Per extracted step, the parts it adds. Returns (steps, report). `fallback`: parts list to use
    when the booklet prints none (`fallback_inventory`)."""
    inventory = [e for e in extract.get("inventory", []) if e.get("element")]
    inv_desc = [describe(_read(folder, e.get("crop"))) for e in inventory]
    used_fallback = False
    if not inventory and fallback:
        inventory = [e for e in fallback if e.get("desc") is not None]
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
    # group identical callout pictures (same crop content) across steps
    groups: dict[str, list[tuple[int, int]]] = defaultdict(list)
    descs: dict[str, Descriptor | None] = {}
    for si, step in enumerate(extract["steps"]):
        for ci, call in enumerate(step.get("callout", [])):
            img = _read(folder, call.get("crop"))
            key = "none" if img is None else f"{img.shape}:{hash(img.tobytes())}"
            groups[key].append((si, ci))
            if key not in descs:
                descs[key] = describe(img)
    totals = {k: sum(extract["steps"][si]["callout"][ci].get("count", 1) for si, ci in v) for k, v in groups.items()}
    assigned = assign(descs, totals, inv_desc, [int(e.get("count", 0) or 0) for e in inventory])
    steps_out = []
    unresolved_total = 0
    for si, step in enumerate(extract["steps"]):
        parts, conf, notes = [], [], []
        unresolved = 0
        for ci, call in enumerate(step.get("callout", [])):
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
              "rebrickable_inventory": used_fallback}
    return steps_out, report
