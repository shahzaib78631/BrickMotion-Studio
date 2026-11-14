"""The set number when the booklet's pages carry no text: LEGO's file name '<set>-<booklet>.pdf'."""
import pymupdf

from booklet_mpd.solver.parts import set_number_from_pdf


def _blank(path):
    doc = pymupdf.open()
    doc.new_page()
    doc.save(str(path))
    return pymupdf.open(str(path))


def test_falls_back_to_the_file_name(tmp_path):
    assert set_number_from_pdf(_blank(tmp_path / "75317-6334518.pdf")) == "75317"


def test_no_number_anywhere(tmp_path):
    assert set_number_from_pdf(_blank(tmp_path / "booklet.pdf")) is None
