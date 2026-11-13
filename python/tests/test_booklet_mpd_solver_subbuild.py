"""Sub-build panels: found in the PDF, their parts picked, solved alone and placed as a unit."""
from __future__ import annotations

import pytest


def _case(i: int):
    from booklet_mpd.solver.dataset import ROOT, cases
    pdf = ROOT / ".cache/instructions/arrow-catalog-100/pdf/40353-6282733.pdf"
    if not pdf.exists():
        pytest.skip("40353 booklet not cached")
    try:
        return list(cases("40353"))[i]
    except Exception as error:      # answer key or extract missing
        pytest.skip(f"40353 data missing: {error}")


def test_finds_the_headlight_panel_and_its_count():
    import pymupdf
    from booklet_mpd.rawimages import subbuild_images
    from booklet_mpd.solver.dataset import ROOT
    pdf = ROOT / ".cache/instructions/arrow-catalog-100/pdf/40353-6282733.pdf"
    if not pdf.exists():
        pytest.skip("40353 booklet not cached")
    page = pymupdf.open(pdf)[3]
    subs = subbuild_images(page)
    assert [s["count"] for s in subs] == [2]
    assert subs[0]["rgb"].shape[:2] == (91, 134)
    assert subs[0]["substeps"] == 0


def test_mini_step_panel_reads_the_last_picture():
    """40271 step 5: "1" a plate on a plate, "2" the slope and round plate on them. Each mini-step picture
    shows the unit so far, so the last one (right, 65 x 121 px) holds it all."""
    import pymupdf
    from booklet_mpd.rawimages import subbuild_images
    from booklet_mpd.solver.dataset import ROOT
    pdf = ROOT / ".cache/instructions/arrow-catalog-100/pdf/40271-6225135.pdf"
    if not pdf.exists():
        pytest.skip("40271 booklet not cached")
    subs = subbuild_images(pymupdf.open(pdf)[5])
    assert [(s["count"], s["substeps"], s["rgb"].shape[:2]) for s in subs] == [(1, 2, (121, 65))]


def test_unit_parts_are_the_colours_the_panel_draws():
    from booklet_mpd.solver.picture import Picture
    from booklet_mpd.solver.subbuild import unit_parts
    from booklet_mpd.viewfit import BOOKLET_SCALE
    case = _case(1)
    sub = case.subbuilds[0]
    pic = Picture.from_rgb(sub["rgb"], sub["pts_per_px"], BOOKLET_SCALE / sub["pts_per_px"])
    parts = [(p, c) for p, c, _m in case.added]
    assert sorted(unit_parts(parts, pic, sub["count"])) == [("3024", 15), ("4070", 4)]


def test_step_2_headlights_placed_as_units():
    """Alone, each headlight brick's turn rests on edge lines of a red face (1/5 exact); as a unit with
    the white plate on its side stud, the plate's colour fixes it. Upright units first: otherwise the left
    unit hangs tipped over the side by its plate (a legal connection the panel does not draw)."""
    import os
    from assembly_model.ldraw import load_library
    from booklet_mpd.score import exact_flags
    from booklet_mpd.solver.dataset import ROOT
    from booklet_mpd.solver.evaluate import canonical
    from booklet_mpd.solver.step import solve
    if os.environ.get("BOOKLET_SOLVER_SUBBUILDS", "1") == "0":
        pytest.skip("sub-builds switched off")
    from booklet_mpd.solver.collide import Collider
    case = _case(1)
    lib = load_library(str(ROOT / "public/ldraw"))
    col = Collider(lib, use_oracle=True)
    try:
        r = solve(lib, case.visible, [(p, c) for p, c, _m in case.added], case.rgb, case.pts_per_px,
                  collider=col, subbuilds=case.subbuilds)
    finally:
        col.close()
    fitted = canonical(lib, r.placed, case.added)
    assert sum(exact_flags(lib, case.added, fitted)) == 5
