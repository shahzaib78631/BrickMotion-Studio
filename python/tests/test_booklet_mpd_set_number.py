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


def test_filename_beats_back_cover_ad(tmp_path):
    """LEGO's '<set>-<booklet>.pdf' filename must not be hijacked by another set's ad on the back cover."""
    p = tmp_path / "40412-6324681.pdf"
    doc = pymupdf.open()
    doc.new_page()
    back = doc.new_page()
    back.insert_text((72, 72), "Check out LEGO 40271 and 75966!")
    doc.save(str(p))
    assert set_number_from_pdf(pymupdf.open(str(p))) == "40412"
