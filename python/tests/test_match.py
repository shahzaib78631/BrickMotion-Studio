"""Callout ↔ inventory matching on synthetic part pictures."""
import json
import os

import numpy as np
import pymupdf
import pytest

from instructions_pdf.match import match_callouts, match_work_dir

CALLOUT_BG = (179, 214, 242)
PAGE_BG = (212, 237, 252)


def save(path, arr):
    h, w, _ = arr.shape
    pix = pymupdf.Pixmap(pymupdf.csRGB, w, h, np.ascontiguousarray(arr, dtype=np.uint8).tobytes(), 0)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pix.save(path)


def shape(kind, rgb, scale=1.0, bg=PAGE_BG):
    n = int(round(60 * scale))
    img = np.zeros((n, n, 3), np.uint8)
    img[:] = bg
    yy, xx = np.mgrid[0:n, 0:n] / n
    if kind == "L":
        m = ((xx > 0.15) & (xx < 0.4) & (yy > 0.1) & (yy < 0.9)) | ((xx > 0.15) & (xx < 0.85) & (yy > 0.65) & (yy < 0.9))
    elif kind == "square":
        m = (xx > 0.2) & (xx < 0.8) & (yy > 0.2) & (yy < 0.8)
    elif kind == "bar":
        m = (xx > 0.05) & (xx < 0.95) & (yy > 0.4) & (yy < 0.6)
    else:  # circle
        m = (xx - 0.5) ** 2 + (yy - 0.5) ** 2 < 0.12
    img[m] = rgb
    return img


INVENTORY = [("302321", "L", (200, 20, 20), 2), ("302323", "square", (20, 60, 200), 5), ("302328", "bar", (30, 160, 50), 4)]


def make_work(tmp_path, callouts, inventory=INVENTORY, with_inventory=True):
    work = tmp_path / "work"
    inv, steps = [], []
    for element, kind, rgb, count in inventory:
        if with_inventory:
            rel = f"crops/inv_{element}.png"
            save(str(work / "b2" / rel), shape(kind, rgb))
            inv.append({"element": element, "count": count, "crop": rel})
        else:
            save(str(work / "rb-images" / f"{element}.jpg"), shape(kind, rgb, bg=(255, 255, 255)))
    for k, (kind, rgb, count) in enumerate(callouts):
        rel = f"crops/p1_s{k + 1}_c0.png"
        save(str(work / "b1" / rel), shape(kind, rgb, 0.6, CALLOUT_BG))
        steps.append({"page": 1, "number": k + 1, "picture": None, "substeps": [],
                      "callout": [{"crop": rel, "count": count, "countFound": True, "box": [0, 0, 1, 1]}]})
    b1 = {"id": "b1", "textHash": "a", "pages": 1, "steps": steps, "inventory": []}
    b2 = {"id": "b2", "textHash": "b", "pages": 1, "steps": [], "inventory": inv}
    for b in (b1, b2):
        os.makedirs(work / b["id"], exist_ok=True)
        (work / b["id"] / "booklet.json").write_text(json.dumps(b))
    return work, [b1, b2]


def test_matches_rescaled_art(tmp_path):
    work, booklets = make_work(tmp_path, [("L", (200, 20, 20), 1), ("square", (20, 60, 200), 1), ("bar", (30, 160, 50), 1)])
    m = match_callouts(booklets, str(work))["matches"]
    assert [x["element"] for x in m] == ["302321", "302323", "302328"]
    assert all(x["score"] >= 0.9 for x in m)
    assert [(x["booklet"], x["step"], x["index"]) for x in m] == [("b1", 1, 0), ("b1", 2, 0), ("b1", 3, 0)]


def test_same_shape_different_colour_picks_colour(tmp_path):
    inv = INVENTORY + [("302324", "square", (200, 20, 20), 1)]
    work, booklets = make_work(tmp_path, [("square", (200, 20, 20), 1)], inventory=inv)
    assert match_callouts(booklets, str(work))["matches"][0]["element"] == "302324"


def test_low_score_is_unmatched(tmp_path):
    work, booklets = make_work(tmp_path, [("circle", (250, 230, 20), 1)])
    m = match_callouts(booklets, str(work))["matches"][0]
    assert m["element"] is None
    assert 1 <= len(m["alternatives"]) <= 3


def test_over_use_reported(tmp_path):
    work, booklets = make_work(tmp_path, [("L", (200, 20, 20), 2), ("L", (200, 20, 20), 1)])
    r = match_callouts(booklets, str(work))
    assert r["overUse"] == [{"element": "302321", "used": 3, "inventory": 2}]
    assert {"element": "302323", "left": 5} in r["unused"]


def test_uses_rb_images_without_inventory(tmp_path):
    work, booklets = make_work(tmp_path, [("bar", (30, 160, 50), 1)], with_inventory=False)
    r = match_callouts(booklets, str(work))
    assert r["matches"][0]["element"] == "302328"
    assert r["overUse"] == [] and r["unused"] == []


def test_match_work_dir_writes_matches_json(tmp_path):
    work, _ = make_work(tmp_path, [("bar", (30, 160, 50), 1)])
    match_work_dir(str(work))
    assert json.loads((work / "matches.json").read_text())["matches"][0]["element"] == "302328"


def test_size_separates_same_shape_parts(tmp_path):
    # a 6x6 and a 4x4 plate look the same once fitted to a frame; their drawn size tells them apart
    inv = INVENTORY + [("395826", "square", (30, 30, 30), 1)]
    work, booklets = make_work(tmp_path, [("L", (200, 20, 20), 1), ("bar", (30, 160, 50), 1), ("square", (30, 30, 30), 1)], inventory=inv)
    small = shape("square", (30, 30, 30), 0.66)
    save(str(work / "b2" / "crops" / "inv_4243819.png"), small)
    booklets[1]["inventory"].append({"element": "4243819", "count": 1, "crop": "crops/inv_4243819.png"})
    # callout of the small plate, at the same 0.6 callout scale as the others
    save(str(work / "b1" / "crops" / "p1_s4_c0.png"), shape("square", (30, 30, 30), 0.6 * 0.66, CALLOUT_BG))
    booklets[0]["steps"].append({"page": 1, "number": 4, "picture": None, "substeps": [],
                                 "callout": [{"crop": "crops/p1_s4_c0.png", "count": 1, "countFound": True, "box": [0, 0, 1, 1]}]})
    m = match_callouts(booklets, str(work))
    assert [x["element"] for x in m["matches"]][2:] == ["395826", "4243819"]
    assert m["overUse"] == []


def test_inventory_counts_limit_assignment(tmp_path):
    # two identical-looking callouts, but the inventory has only one of the best element
    inv = [("A", "square", (200, 20, 20), 1), ("B", "square", (190, 25, 25), 1), ("C", "L", (20, 60, 200), 3), ("D", "bar", (30, 160, 50), 3)]
    work, booklets = make_work(tmp_path, [("L", (20, 60, 200), 1), ("bar", (30, 160, 50), 1), ("square", (200, 20, 20), 1), ("square", (200, 20, 20), 1)], inventory=inv)
    m = match_callouts(booklets, str(work))
    assert sorted(x["element"] for x in m["matches"][2:]) == ["A", "B"]
    assert m["overUse"] == []


def test_match_work_dir_names_booklets_by_folder(tmp_path):
    work, _ = make_work(tmp_path, [("bar", (30, 160, 50), 1)])
    os.rename(work / "b1", work / "b1-2")
    match_work_dir(str(work))
    assert json.loads((work / "matches.json").read_text())["matches"][0]["booklet"] == "b1-2"
