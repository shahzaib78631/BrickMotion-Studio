import numpy as np
import pytest
import pymupdf

from booklet_mpd.rawimages import main_model_image

BG = (0.83, 0.93, 0.99)
PANEL = (1.0, 0.94, 0.79)


def png(rgb, w, h):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w, h), False)
    pix.set_rect(pix.irect, tuple(int(c * 255) for c in rgb))
    return pix.tobytes("png")


def booklet_page(tmp_path):
    doc = pymupdf.open()
    p = doc.new_page(width=400, height=290)
    p.draw_rect(pymupdf.Rect(0, 0, 400, 290), color=None, fill=BG)            # page background
    p.draw_rect(pymupdf.Rect(10, 10, 200, 130), color=None, fill=PANEL)       # sub-step panel
    p.insert_image(pymupdf.Rect(30, 30, 130, 120), stream=png((0.2, 0.2, 0.9), 100, 90))   # sub-assembly in the panel
    p.insert_image(pymupdf.Rect(230, 60, 370, 240), stream=png((0.8, 0.7, 0.4), 140, 180))  # main model
    p.insert_image(pymupdf.Rect(205, 140, 228, 150), stream=png((0.5, 0.5, 0.5), 23, 10))   # small connector image
    path = tmp_path / "b.pdf"
    doc.save(path)
    return pymupdf.open(path)


def test_main_model_is_the_largest_image_outside_every_panel(tmp_path):
    doc = booklet_page(tmp_path)
    img = main_model_image(doc[0])
    assert img.shape == (180, 140, 3)
    assert tuple(img[90, 70]) == (204, 178, 102)


def test_page_without_a_model_image_gives_none(tmp_path):
    doc = pymupdf.open()
    p = doc.new_page(width=200, height=200)
    p.draw_rect(pymupdf.Rect(10, 10, 130, 130), color=None, fill=PANEL)
    p.insert_image(pymupdf.Rect(30, 30, 100, 100), stream=png((0.2, 0.2, 0.9), 70, 70))
    assert main_model_image(doc[0]) is None


def test_box_restricts_which_images_are_considered(tmp_path):
    doc = booklet_page(tmp_path)
    assert main_model_image(doc[0], box=pymupdf.Rect(0, 0, 150, 150)) is None


from booklet_mpd.rawimages import main_model_image_info


def test_info_gives_page_points_per_image_pixel(tmp_path):
    doc = booklet_page(tmp_path)
    img, pts_per_px = main_model_image_info(doc[0])
    assert img.shape == (180, 140, 3)
    assert pts_per_px == pytest.approx(140 / 140)     # image drawn 140pt wide from 140px of pixels


def test_info_reflects_a_scaled_placement(tmp_path):
    doc = pymupdf.open()
    p = doc.new_page(width=400, height=290)
    p.insert_image(pymupdf.Rect(50, 50, 150, 150), stream=png((0.8, 0.7, 0.4), 200, 200))   # 200px drawn at 100pt
    img, pts_per_px = main_model_image_info(p.parent[0])
    assert pts_per_px == pytest.approx(0.5)


def test_info_none_when_no_model_image(tmp_path):
    doc = pymupdf.open()
    doc.new_page(width=200, height=200)
    assert main_model_image_info(doc[0]) == (None, None)
