"""Split a LEGO instruction booklet PDF into steps, callout parts and the inventory page.

Layout facts this relies on (40859 booklets): main step numbers are 26pt text, section markers
31.6pt, sub-build numbers 16-22pt, part counts "Nx" in small (8pt) text inside pale-blue callout
boxes, and each callout part is its own embedded image. Coordinates are PDF points.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re

import pymupdf

MAIN = (25.4, 26.6)
SECTION = (31.0, 32.2)
SUB = (15.5, 22.5)
COUNT_MAX = 12.0
MIN_PART_SIDE = 6.0
CROP_DPI = 300
PICTURE_DPI = 150
NUM = re.compile(r"^\d+$")
COUNT = re.compile(r"^(\d+)x$")
ELEMENT = re.compile(r"^\d{5,8}$")


def _in(size: float, rng: tuple[float, float]) -> bool:
    return rng[0] <= size <= rng[1]


def _center(b) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _inside(b, r, pad: float = 1.0) -> bool:
    cx, cy = _center(b)
    return r[0] - pad <= cx <= r[2] + pad and r[1] - pad <= cy <= r[3] + pad


def _spans(page) -> list[dict]:
    seen, out = set(), []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for s in line["spans"]:
                t = s["text"].strip()
                if not t:
                    continue
                key = (t, tuple(round(v) for v in s["bbox"]))
                if key in seen:
                    continue
                seen.add(key)
                out.append({"text": t, "size": s["size"], "bbox": tuple(s["bbox"])})
    return out


def _images(page) -> list[tuple]:
    area = page.rect.width * page.rect.height
    out = []
    for info in page.get_image_info():
        b = tuple(info["bbox"])
        w, h = b[2] - b[0], b[3] - b[1]
        if w <= 0 or h <= 0 or w * h > 0.5 * area:
            continue
        out.append(b)
    return out


def _boxes(page) -> list[tuple]:
    area = page.rect.width * page.rect.height
    out = []
    for d in page.get_drawings():
        if not d.get("fill"):
            continue
        r = d["rect"]
        if r.width < 20 or r.height < 15 or r.width * r.height > 0.6 * area:
            continue
        out.append(((r.x0, r.y0, r.x1, r.y1), tuple(d["fill"])))
    return out


CALLOUT_FILL = (0.70, 0.84, 0.95)


def _callout_fill(fill) -> bool:
    return len(fill) >= 3 and all(abs(a - b) < 0.04 for a, b in zip(fill, CALLOUT_FILL))


def _clip(page, box, dpi: int, path: str) -> None:
    rect = pymupdf.Rect(box) & page.rect
    if rect.is_empty:
        return
    page.get_pixmap(dpi=dpi, clip=rect).save(path)


def _pair_counts(images: list[tuple], counts: list[dict]) -> list[tuple[int, bool]]:
    """Each count goes to at most one image: the nearest image whose centre is above it."""
    pairs = []
    for i, ib in enumerate(images):
        icx, icy = _center(ib)
        for j, c in enumerate(counts):
            ccx, ccy = _center(c["bbox"])
            if ccy > icy:
                pairs.append((math.hypot(ccx - icx, ccy - icy), i, j))
    result: list[tuple[int, bool]] = [(1, False)] * len(images)
    used_i, used_j = set(), set()
    for _, i, j in sorted(pairs):
        if i in used_i or j in used_j:
            continue
        used_i.add(i)
        used_j.add(j)
        result[i] = (int(COUNT.match(counts[j]["text"]).group(1)), True)
    return result


def _inventory(page, spans: list[dict], images: list[tuple], crops: str, out_dir: str, pno: int) -> list[dict]:
    counts = [s for s in spans if COUNT.match(s["text"]) and s["size"] < COUNT_MAX]
    elements = [s for s in spans if ELEMENT.match(s["text"])]
    pairs = []
    for c in counts:
        cx = _center(c["bbox"])[0]
        below = [e for e in elements if 0 <= e["bbox"][1] - c["bbox"][1] <= 18 and abs(e["bbox"][0] - c["bbox"][0]) <= 12]
        if below:
            e = min(below, key=lambda e: e["bbox"][1])
            pairs.append((c, e, cx))
    if len(pairs) < 10:
        return []
    out = []
    for k, (c, e, cx) in enumerate(pairs):
        above = [b for b in images if b[3] <= c["bbox"][1] + 2 and b[0] - 4 <= cx <= b[2] + 4]
        crop = None
        if above:
            b = min(above, key=lambda b: c["bbox"][1] - b[3])
            crop = f"crops/inv_p{pno}_{k}_{e['text']}.png"
            _clip(page, b, CROP_DPI, os.path.join(out_dir, crop))
        out.append({"element": e["text"], "count": int(COUNT.match(c["text"]).group(1)), "crop": crop})
    return out


def extract_booklet(pdf_path: str, out_dir: str) -> dict:
    doc = pymupdf.open(pdf_path)
    crops = os.path.join(out_dir, "crops")
    os.makedirs(crops, exist_ok=True)
    texts: list[str] = []
    steps: list[dict] = []
    inventory: list[dict] = []
    pending_sections: list[int] = []

    for pno, page in enumerate(doc, start=1):
        texts.append(page.get_text())
        spans = _spans(page)
        images = _images(page)
        mains = sorted(
            (s for s in spans if NUM.match(s["text"]) and _in(s["size"], MAIN)),
            key=lambda s: int(s["text"]),
        )
        pending_sections += [int(s["text"]) for s in spans if NUM.match(s["text"]) and _in(s["size"], SECTION)]
        if not mains:
            inventory += _inventory(page, spans, images, crops, out_dir, pno)
            continue

        counts = [s for s in spans if COUNT.match(s["text"]) and s["size"] < COUNT_MAX]
        page_steps = []
        for m in mains:
            st = {"page": pno, "number": int(m["text"]), "picture": None, "callout": [], "substeps": [], "_b": m["bbox"]}
            if pending_sections:
                st["section"] = pending_sections.pop(0)
                pending_sections.clear()
            page_steps.append(st)

        def nearest_step(point):
            return min(page_steps, key=lambda st: math.hypot(point[0] - _center(st["_b"])[0], point[1] - _center(st["_b"])[1]))

        # callout boxes: same image set seen once (fill and outline paths overlap)
        callout_images: set[int] = set()
        seen_sets: set[frozenset] = set()
        for box, fill in _boxes(page):
            inside = [i for i, b in enumerate(images) if _inside(b, box)
                      and b[2] - b[0] >= MIN_PART_SIDE and b[3] - b[1] >= MIN_PART_SIDE]
            box_counts = [c for c in counts if _inside(c["bbox"], box)]
            # a one-part callout may print no count: the pale-blue fill still marks it (several
            # pictures in a count-less pale-blue box are a tip panel, not a callout)
            if not inside or not (box_counts or (_callout_fill(fill) and len(inside) == 1)) or frozenset(inside) in seen_sets:
                continue
            seen_sets.add(frozenset(inside))
            callout_images.update(inside)
            below = [st for st in page_steps if st["_b"][1] >= box[3] - 2]
            owner = min(below or page_steps, key=lambda st: math.hypot(st["_b"][0] - box[0], st["_b"][1] - box[3]))
            ordered = sorted(inside, key=lambda i: (round(images[i][0]), images[i][1]))
            for (count, found), i in zip(_pair_counts([images[i] for i in ordered], box_counts), ordered):
                crop = f"crops/p{pno}_s{owner['number']}_c{len(owner['callout'])}.png"
                _clip(page, images[i], CROP_DPI, os.path.join(out_dir, crop))
                owner["callout"].append({"crop": crop, "count": count, "countFound": found, "box": [round(v, 2) for v in images[i]]})

        # step pictures: union of the remaining images nearest each step
        unions: dict[int, list[float]] = {}
        for i, b in enumerate(images):
            if i in callout_images:
                continue
            st = nearest_step(_center(b))
            u = unions.setdefault(id(st), list(b))
            unions[id(st)] = [min(u[0], b[0]), min(u[1], b[1]), max(u[2], b[2]), max(u[3], b[3])]
        for st in page_steps:
            if id(st) in unions:
                st["picture"] = f"crops/p{pno}_s{st['number']}_picture.png"
                _clip(page, unions[id(st)], PICTURE_DPI, os.path.join(out_dir, st["picture"]))

        for s in spans:
            if NUM.match(s["text"]) and _in(s["size"], SUB):
                st = nearest_step(_center(s["bbox"]))
                if int(s["text"]) not in st["substeps"]:
                    st["substeps"].append(int(s["text"]))
            m = COUNT.match(s["text"])
            if m and COUNT_MAX <= s["size"] <= SUB[1]:
                nearest_step(_center(s["bbox"]))["repeat"] = int(m.group(1))
        for st in page_steps:
            st["substeps"].sort()
            del st["_b"]
        steps += page_steps

    booklet = {
        "id": os.path.splitext(os.path.basename(pdf_path))[0],
        "textHash": hashlib.sha256("".join(texts).encode("utf-8")).hexdigest(),
        "pages": doc.page_count,
        "steps": steps,
        "inventory": inventory,
    }
    with open(os.path.join(out_dir, "booklet.json"), "w") as f:
        json.dump(booklet, f, indent=1)
    return booklet
