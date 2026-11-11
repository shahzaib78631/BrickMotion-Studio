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


def main_model_image(page, box: pymupdf.Rect | None = None) -> np.ndarray | None:
    """The largest RGB image outside every filled panel (optionally centred inside `box`)."""
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
        return None
    pix = pymupdf.Pixmap(page.parent, best["xref"])
    if pix.alpha or pix.n != 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.Pixmap(pix, 0) if pix.alpha else pix)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).copy()
