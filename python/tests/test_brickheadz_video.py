"""Video ingestion: frame scoring, selection, and end-to-end build (ffmpeg-free path)."""
import os
import sys

import numpy as np
import pymupdf
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.dna import load_catalog
from brickheadz.image_spec import load_pixels
from brickheadz.inventory import load
from brickheadz.video import build_from_video, frame_metrics, select_frame

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
LIB = os.path.join(ROOT, "public", "ldraw")
LDCONFIG = os.path.join(ROOT, "public", "ldraw", "LDConfig.ldr")
CATALOG = os.path.join(ROOT, "public", "data", "catalog.json")
INVENTORY = os.path.join(ROOT, "tests", "fixtures", "brickheadz", "inventory.json")


@pytest.fixture(scope="module")
def lib():
    return load_library(LIB)


def make_frame(path, box):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 320), False)
    pix.set_rect(pix.irect, (0, 0, 0))
    pix.set_rect(pymupdf.IRect(*box), (242, 205, 55))
    pix.save(str(path))
    return str(path)


@pytest.fixture
def frames(tmp_path):
    good = make_frame(tmp_path / "good.png", (60, 40, 140, 280))  # large, centred
    bad = make_frame(tmp_path / "bad.png", (0, 0, 30, 40))  # small, corner
    return good, bad


def test_frame_metrics_prefers_big_centred(frames):
    good, bad = frames
    g = frame_metrics(load_pixels(good))
    b = frame_metrics(load_pixels(bad))
    assert g and b
    assert g["score"] > b["score"]


def test_select_frame_picks_best(frames):
    good, bad = frames
    best, scored = select_frame([bad, good])
    assert best == good
    assert scored[0]["path"] == good


def test_build_from_video_end_to_end(lib, frames, tmp_path):
    good, bad = frames
    inv = load(INVENTORY)
    cat = load_catalog(CATALOG)
    out = tmp_path / "out"
    report = build_from_video(
        lib, "clip.mp4", inv, LDCONFIG, None, cat, str(out),
        name="Vid", frames_provider=lambda: [bad, good],
    )
    assert report["frame"] == "good.png"
    assert report["pieces"] > 20
    assert np.isfinite(report["cost"])
    assert (out / "Vid.plan.json").exists()
    assert (out / "Vid.frame.png").exists()
