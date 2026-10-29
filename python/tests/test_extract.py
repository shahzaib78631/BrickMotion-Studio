"""Booklet extraction against small synthetic PDFs laid out like LEGO instruction pages."""
import json
import os

import pymupdf
import pytest

from instructions_pdf.extract import extract_booklet

PAGE = pymupdf.Rect(0, 0, 383, 289)
BG = (0.83, 0.93, 0.99)
CALLOUT = (0.70, 0.84, 0.95)
SUBBUILD = (1.0, 0.96, 0.8)


def png(rgb, w=40, h=30):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w, h), False)
    pix.set_rect(pix.irect, tuple(int(c * 255) for c in rgb))
    return pix.tobytes("png")


def page(doc):
    p = doc.new_page(width=PAGE.width, height=PAGE.height)
    p.draw_rect(PAGE, color=None, fill=BG)
    return p


def text(p, x, y, s, size):
    # y is the baseline; spans report their bbox around it
    p.insert_text((x, y), s, fontsize=size)


@pytest.fixture
def booklet(tmp_path):
    doc = pymupdf.open()
    # page 1: section 1, step 1 (one part, 2x); step 2 (two parts: 2x, 1x)
    p = page(doc)
    text(p, 60, 60, "1", 31.6)
    p.draw_rect(pymupdf.Rect(15, 15, 167, 62), color=None, fill=CALLOUT)
    p.insert_image(pymupdf.Rect(80, 25, 100, 40), stream=png((1, 0.8, 0)))
    text(p, 83, 48, "2x", 8)
    text(p, 14, 92, "1", 26)
    p.insert_image(pymupdf.Rect(40, 140, 140, 230), stream=png((0.8, 0.1, 0.1), 100, 90))
    p.draw_rect(pymupdf.Rect(196, 15, 348, 62), color=None, fill=CALLOUT)
    p.insert_image(pymupdf.Rect(220, 25, 240, 40), stream=png((0.3, 0.3, 0.3)))
    text(p, 222, 48, "2x", 8)
    p.insert_image(pymupdf.Rect(280, 25, 300, 40), stream=png((0.2, 0.9, 0.2)))
    text(p, 282, 48, "1x", 8)
    text(p, 196, 92, "2", 26)
    p.insert_image(pymupdf.Rect(220, 120, 320, 220), stream=png((0.8, 0.1, 0.1), 100, 100))
    text(p, 14, 275, "1", 10)
    # page 2: step 3 with a callout whose second part has no count, and a sub-build panel 1, 2 built 2x
    p = page(doc)
    p.draw_rect(pymupdf.Rect(15, 15, 167, 62), color=None, fill=CALLOUT)
    p.insert_image(pymupdf.Rect(30, 25, 50, 40), stream=png((0, 0, 0)))
    text(p, 32, 48, "1x", 8)
    p.insert_image(pymupdf.Rect(110, 25, 130, 40), stream=png((0.9, 0.5, 0.7)))
    text(p, 14, 92, "3", 26)
    p.draw_rect(pymupdf.Rect(187, 15, 348, 102), color=None, fill=SUBBUILD)
    text(p, 196, 60, "1", 16)
    text(p, 258, 60, "2", 16)
    p.insert_image(pymupdf.Rect(206, 23, 253, 94), stream=png((0.5, 0.5, 0.5), 47, 71))
    text(p, 321, 95, "2x", 16)
    p.insert_image(pymupdf.Rect(60, 130, 160, 230), stream=png((0.8, 0.1, 0.1), 100, 100))
    text(p, 360, 275, "2", 10)
    # page 3: inventory, 10 pairs
    p = page(doc)
    elements = ["6572522", "4211398", "302328", "300328", "302128", "6134378", "4211397", "4211445", "4211042", "4550359"]
    for i, el in enumerate(elements):
        x, y = 20 + (i % 5) * 70, 20 + (i // 5) * 120
        p.insert_image(pymupdf.Rect(x, y, x + 30, y + 25), stream=png((0.1 * i, 0.5, 0.5)))
        text(p, x, y + 36, f"{29 if i == 0 else i + 1}x", 8)
        text(p, x, y + 46, el, 8)
    pdf = tmp_path / "6668730.pdf"
    doc.save(pdf)
    out = tmp_path / "out"
    return extract_booklet(str(pdf), str(out)), out


def test_steps_in_order(booklet):
    b, _ = booklet
    assert [s["number"] for s in b["steps"]] == [1, 2, 3]
    assert b["steps"][0]["section"] == 1
    assert "section" not in b["steps"][1]
    assert b["id"] == "6668730" and b["pages"] == 3


def test_callout_counts(booklet):
    b, _ = booklet
    step1, step2 = b["steps"][0], b["steps"][1]
    assert [c["count"] for c in step1["callout"]] == [2]
    assert [c["count"] for c in step2["callout"]] == [2, 1]
    assert all(c["countFound"] for c in step1["callout"] + step2["callout"])


def test_missing_count_defaults_to_one(booklet):
    b, _ = booklet
    parts = b["steps"][2]["callout"]
    assert [(c["count"], c["countFound"]) for c in parts] == [(1, True), (1, False)]


def test_substeps(booklet):
    b, _ = booklet
    assert b["steps"][2]["substeps"] == [1, 2]
    assert b["steps"][2]["repeat"] == 2
    assert b["steps"][0]["substeps"] == []


def test_crops_and_picture_written(booklet):
    b, out = booklet
    s = b["steps"][1]
    assert s["picture"] and os.path.exists(out / s["picture"])
    assert all(os.path.exists(out / c["crop"]) for c in s["callout"])
    assert json.loads((out / "booklet.json").read_text())["steps"][1]["number"] == 2


def test_inventory(booklet):
    b, out = booklet
    inv = b["inventory"]
    assert len(inv) == 10
    assert {k: inv[0][k] for k in ("element", "count")} == {"element": "6572522", "count": 29}
    assert inv[0]["crop"] and os.path.exists(out / inv[0]["crop"])


def test_text_hash_identifies_identical_content(booklet, tmp_path):
    b, _ = booklet
    assert len(b["textHash"]) == 64
