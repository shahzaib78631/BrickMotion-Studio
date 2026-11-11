import pymupdf
import pytest

import booklet_mpd.audit as audit
from booklet_mpd.audit import audit_pair
from booklet_mpd.pairing import Pair

BG = (0.83, 0.93, 0.99)
CALLOUT = (0.70, 0.84, 0.95)


def png(rgb, w=40, h=30):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w, h), False)
    pix.set_rect(pix.irect, tuple(int(c * 255) for c in rgb))
    return pix.tobytes("png")


def make_pdf(path):
    doc = pymupdf.open()
    p = doc.new_page(width=383, height=289)
    p.draw_rect(pymupdf.Rect(0, 0, 383, 289), color=None, fill=BG)
    p.insert_text((60, 60), "1", fontsize=31.6)
    p.draw_rect(pymupdf.Rect(15, 15, 167, 62), color=None, fill=CALLOUT)
    p.insert_image(pymupdf.Rect(80, 25, 100, 40), stream=png((1, 0.8, 0)))
    p.insert_text((83, 48), "2x", fontsize=8)
    p.insert_text((14, 92), "1", fontsize=26)
    p.insert_image(pymupdf.Rect(40, 140, 140, 230), stream=png((0.8, 0.1, 0.1), 100, 90))
    p.draw_rect(pymupdf.Rect(196, 15, 348, 62), color=None, fill=CALLOUT)
    p.insert_image(pymupdf.Rect(220, 25, 240, 40), stream=png((0.3, 0.3, 0.3)))
    p.insert_text((222, 48), "2x", fontsize=8)
    p.insert_image(pymupdf.Rect(280, 25, 300, 40), stream=png((0.2, 0.9, 0.2)))
    p.insert_text((282, 48), "1x", fontsize=8)
    p.insert_text((196, 92), "2", fontsize=26)
    p.insert_image(pymupdf.Rect(220, 120, 320, 220), stream=png((0.8, 0.1, 0.1), 100, 100))
    p.insert_text((14, 275), "1", fontsize=10)
    doc.save(path)


def make_mpd(path, per_step):
    lines = ["0 FILE a.ldr"]
    for n in per_step:
        lines += [f"1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"] * n + ["0 STEP"]
    lines.append("0 NOFILE")
    path.write_text("\n".join(lines) + "\n")


def pair(tmp_path, pdf, mpd):
    return Pair("42093", "1", pdf, mpd, "test")


def test_audit_aligns_by_callout_totals(tmp_path):
    pdf, mpd = tmp_path / "b.pdf", tmp_path / "m.mpd"
    make_pdf(pdf)
    make_mpd(mpd, [2, 3])
    r = audit_pair(pair(tmp_path, pdf, mpd), tmp_path / "work")
    assert (r["booklet_steps"], r["omr_steps"], r["alignment_ok"]) == (2, 2, True)
    assert r["aligned"] == [[0, 0], [1, 1]] and r["extraction_error"] is None
    assert r["steps_with_picture"] == 2


def test_audit_reports_extraction_failure_without_raising(tmp_path):
    pdf, mpd = tmp_path / "b.pdf", tmp_path / "m.mpd"
    pdf.write_bytes(b"not a pdf")
    make_mpd(mpd, [2])
    r = audit_pair(pair(tmp_path, pdf, mpd), tmp_path / "work")
    assert r["extraction_error"] and r["alignment_ok"] is False


def test_audit_reuses_cached_extraction(tmp_path, monkeypatch):
    pdf, mpd = tmp_path / "b.pdf", tmp_path / "m.mpd"
    make_pdf(pdf)
    make_mpd(mpd, [2, 3])
    first = audit_pair(pair(tmp_path, pdf, mpd), tmp_path / "work")

    def boom(*a, **k):
        raise AssertionError("extract_booklet called again")
    monkeypatch.setattr(audit, "extract_booklet", boom)
    assert audit_pair(pair(tmp_path, pdf, mpd), tmp_path / "work") == first


def test_audit_picks_submodel_granularity_when_root_has_one_step(tmp_path):
    pdf, mpd = tmp_path / "b.pdf", tmp_path / "m.mpd"
    make_pdf(pdf)
    part = "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"
    ref = lambda n: f"1 4 0 0 0 1 0 0 0 1 0 0 0 1 {n}.ldr"
    mpd.write_text("\n".join(["0 FILE main.ldr", ref("a"), ref("b"), "0 STEP",
                              "0 FILE a.ldr", part, part, "0 STEP",
                              "0 FILE b.ldr", part, part, part, "0 STEP", "0 NOFILE"]) + "\n")
    r = audit_pair(pair(tmp_path, pdf, mpd), tmp_path / "work")
    assert r["truth_mode"] == "expand" and r["alignment_ok"] is True
    assert r["groups"] == [[[0], [0]], [[1], [1]]]


def test_audit_survives_one_malformed_omr_line_and_records_it(tmp_path):
    pdf, mpd = tmp_path / "b.pdf", tmp_path / "m.mpd"
    make_pdf(pdf)
    good = "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"
    bad = "1 191 -10 -16 -30 1 0 0 0 1 0 0 0  24866.dat"
    mpd.write_text("\n".join(["0 FILE a.ldr", good, good, "0 STEP", good, good, good, bad, "0 STEP", "0 NOFILE"]) + "\n")
    r = audit_pair(pair(tmp_path, pdf, mpd), tmp_path / "work")
    assert r["alignment_ok"] is True and len(r["omr_warnings"]) >= 1
