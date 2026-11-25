"""Read a step's main-model render straight from the booklet PDF.

LEGO booklets are InDesign/Switch layouts in which every 3D render (the main model, each
sub-assembly, each callout part, even the connector line) is its own embedded raster image.
Reading the image object gives the model at native resolution without panels, connectors or
page-region render artefacts.
"""
from __future__ import annotations

import numpy as np
import pymupdf


def _panels(page) -> list[pymupdf.Rect]:
    area = page.rect.get_area()
    found = []
    for drawing in page.get_drawings():
        rect = pymupdf.Rect(drawing["rect"])
        if drawing.get("fill") and 0.015 * area <= rect.get_area() <= 0.6 * area:
            found.append(rect)
    return found


def main_model_image_info(page, box: pymupdf.Rect | None = None) -> tuple[np.ndarray | None, float | None]:
    """The largest RGB image outside every filled panel (optionally centred inside `box`) and its
    scale on the page in points per image pixel (None, None when there is no model image)."""
    panels = _panels(page)
    best, best_area = None, 0.0
    for info in page.get_image_info(xrefs=True):
        if info.get("colorspace") != 3 or not info.get("xref"):
            continue
        rect = pymupdf.Rect(info["bbox"])
        centre = pymupdf.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
        if box is not None and not box.contains(centre):
            continue
        if any(panel.contains(centre) for panel in panels):
            continue
        if rect.get_area() > best_area:
            best, best_area = info, rect.get_area()
    if best is None:
        return None, None
    pix = pymupdf.Pixmap(page.parent, best["xref"])
    if pix.alpha or pix.n != 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.Pixmap(pix, 0) if pix.alpha else pix)
    image = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).copy()
    return image, (best["bbox"][2] - best["bbox"][0]) / pix.width


def main_model_image(page, box: pymupdf.Rect | None = None) -> np.ndarray | None:
    return main_model_image_info(page, box)[0]


CALLOUT_FILL = (0.70, 0.84, 0.95)     # parts-list boxes (pale blue)
SUB_COUNT_MIN = 12.0                   # pt: a sub-build's "Nx" is printed large (parts-list counts are ~8 pt)
SUBSTEP = (15.5, 22.5)                 # pt: mini-step numbers inside a sub-build panel


def _rgb_image(page, xref: int) -> np.ndarray:
    pix = pymupdf.Pixmap(page.parent, xref)
    if pix.alpha or pix.n != 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.Pixmap(pix, 0) if pix.alpha else pix)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).copy()


def _centre(r: pymupdf.Rect) -> pymupdf.Point:
    return pymupdf.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)


def subbuild_images(page, box: pymupdf.Rect | None = None) -> list[dict]:
    """Sub-build panels of a step: filled boxes holding a small assembly built apart and then attached
    (cream in BrickHeadz/Technic booklets, white in older ones), e.g. a headlight brick with a plate on
    its side stud, "2x". A panel may hold numbered mini-steps ("1", "2", ...); each picture shows the
    unit so far, so the last one shows it all. Boxes nested in a panel (parts lists, sub-sub-builds) and
    their text are left out of it.

    Returns [{"rgb", "pts_per_px", "count", "panel", "substeps"}] for panels whose centre is inside `box`
    (the step's picture area). Whether a panel really is a sub-build (and not cover art, a finished-model
    preview or a part shown large) is decided when it is solved: the unit has to explain the picture."""
    area = page.rect.get_area()
    fills = [(pymupdf.Rect(d["rect"]), tuple(d["fill"])) for d in page.get_drawings()
             if d.get("fill") is not None and len(d["fill"]) >= 3]
    page_fill = max(fills, key=lambda f: f[0].get_area())[1] if fills else None
    candidates: list[tuple[pymupdf.Rect, tuple]] = []
    for rect, fill in fills:
        if not (0.015 * area <= rect.get_area() <= 0.6 * area) or min(fill) < 0.15:
            continue                                  # page background, outline / shadow paths
        if all(abs(a - b) < 0.04 for a, b in zip(fill, CALLOUT_FILL)):
            continue                                  # parts list
        if fill == page_fill and rect.get_area() > 0.3 * area:
            continue
        if any(abs(rect.x0 - p.x0) < 2 and abs(rect.y0 - p.y0) < 2 and abs(rect.x1 - p.x1) < 2 and abs(rect.y1 - p.y1) < 2
               for p, _f in candidates):
            continue
        candidates.append((rect, fill))
    images = [(pymupdf.Rect(i["bbox"]), i) for i in page.get_image_info(xrefs=True)
              if i.get("colorspace") == 3 and i.get("xref")]
    spans = [s for b in page.get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"] if s["text"].strip()]
    out = []
    for panel, _fill in candidates:
        if box is not None and not box.contains(_centre(panel)):
            continue
        # boxes nested in the panel that hold pictures of their own (a parts list, a sub-sub-build); a
        # plain patch behind the "Nx" count is not one
        nested = [r for r, _f in fills if r != panel and panel.contains(r) and r.get_area() < 0.9 * panel.get_area()
                  and any(r.contains(_centre(ir)) and ir.width >= 6 and ir.height >= 6 for ir, _i in images)]
        def own(r: pymupdf.Rect) -> bool:
            c = _centre(r)
            return panel.contains(c) and not any(n.contains(c) for n in nested)
        # pictures drawn in the panel (not a large render the panel only frames part of)
        inside = [(r, i) for r, i in images if own(r) and r.width >= 6 and r.height >= 6
                  and (r & panel).get_area() >= 0.8 * r.get_area()]
        if not inside:
            continue
        if any(s["text"].strip().endswith("x") and s["text"].strip()[:-1].isdigit() and s["size"] < SUB_COUNT_MIN
               and own(pymupdf.Rect(s["bbox"])) for s in spans):
            continue                                  # a parts list (small "Nx" under each part), older layouts
        count_boxes = [pymupdf.Rect(s["bbox"]) for s in spans if s["text"].strip().endswith("x") and s["text"].strip()[:-1].isdigit()]
        # mini-step numbers (not the digits of an "Nx" count, which some layouts print as a separate span)
        numbers = [(int(s["text"].strip()), pymupdf.Rect(s["bbox"])) for s in spans
                   if s["text"].strip().isdigit() and SUBSTEP[0] <= s["size"] <= SUBSTEP[1] and own(pymupdf.Rect(s["bbox"]))
                   and not any(abs(pymupdf.Rect(s["bbox"]).x0 - c.x0) < 2 and abs(pymupdf.Rect(s["bbox"]).y0 - c.y0) < 2 for c in count_boxes)]
        stages = []
        if numbers:
            # Pair every unique mini-step number (1, 2, ..., K) 1-to-1 with its nearest substantial image
            # right-of / below the number (preserving progressive build stages inside multi-step panels!)
            by_n: dict[int, pymupdf.Rect] = {}
            for n_val, n_rect in numbers:
                by_n.setdefault(n_val, n_rect)
            big_all = max(r.get_area() for r, _i in inside)
            subst = [(idx_i, r, i) for idx_i, (r, i) in enumerate(inside) if r.get_area() >= 0.12 * big_all]
            # Greedy 1-to-1 minimum-distance pairing of (step_num, substantial_image)
            pairs_cand = []
            for n_val, nr in by_n.items():
                for idx_i, r, i in subst:
                    if r.x1 >= nr.x0 - 2 and r.y1 >= nr.y0 - 2 and r.x0 >= nr.x0 - 12:
                        d2 = (r.x0 - nr.x0) ** 2 + (r.y0 - nr.y0) ** 2
                        pairs_cand.append((d2, n_val, idx_i, r, i))
            pairs_cand.sort(key=lambda x: x[0])
            used_n, used_i = set(), set()
            matched_stages: dict[int, dict] = {}
            for _d2, n_val, idx_i, _r, img_info in pairs_cand:
                if n_val in used_n or idx_i in used_i:
                    continue
                used_n.add(n_val)
                used_i.add(idx_i)
                matched_stages[n_val] = img_info
            for n_val in sorted(matched_stages):
                st_img = matched_stages[n_val]
                st_rgb = _rgb_image(page, st_img["xref"])
                stages.append({
                    "step": n_val,
                    "rgb": st_rgb,
                    "pts_per_px": (st_img["bbox"][2] - st_img["bbox"][0]) / st_rgb.shape[1],
                })
            # each mini-step's picture lies right of / below its number: the last number's nearest large picture
            last_n, last_r = max(numbers, key=lambda x: x[0])
            if last_n in matched_stages:
                best = matched_stages[last_n]
            else:
                def after(r):
                    return r.x1 >= last_r.x0 - 2 and r.y1 >= last_r.y0 - 2
                pool = [(r, i) for r, i in inside if after(r)] or inside
                big = max(r.get_area() for r, _i in pool)
                pool = [(r, i) for r, i in pool if r.get_area() >= 0.25 * big]
                best = min(pool, key=lambda x: (x[0].x0 - last_r.x0) ** 2 + (x[0].y0 - last_r.y0) ** 2)[1]
        else:
            best = max(inside, key=lambda x: x[0].get_area())[1]
        count = 1
        counts = [(s, pymupdf.Rect(s["bbox"])) for s in spans if s["text"].strip().endswith("x")
                  and s["text"].strip()[:-1].isdigit() and s["size"] >= SUB_COUNT_MIN and own(pymupdf.Rect(s["bbox"]))]
        if counts:          # the panel's own count sits at its bottom right
            s0, _r = max(counts, key=lambda x: x[1].x1 + x[1].y1)
            count = int(s0["text"].strip()[:-1])
        rgb = _rgb_image(page, best["xref"])
        out.append({"rgb": rgb, "pts_per_px": (best["bbox"][2] - best["bbox"][0]) / rgb.shape[1], "count": count,
                    "panel": [round(v, 2) for v in panel], "substeps": len({n for n, _r in numbers}),
                    "stages": stages})
    return out
