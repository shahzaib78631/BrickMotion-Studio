import json
from pathlib import Path

from booklet_mpd.pairing import Pair, find_pairs, split_of


def test_split_of_is_deterministic_and_covers_all_three():
    assert split_of("42093") == split_of("42093")
    values = [split_of(str(n)) for n in range(10000, 11000)]
    assert set(values) == {"train", "validation", "test"}
    assert 0.6 <= values.count("train") / len(values) <= 0.8


def _sources(tmp_path, entries):
    p = tmp_path / "sources.json"
    p.write_text(json.dumps({"version": 1, "booklets": entries}))
    return p


def _omr(tmp_path, set_no, names=None):
    d = tmp_path / "omr" / f"{set_no}-1"
    d.mkdir(parents=True)
    for n in names or [f"{set_no}-1.mpd"]:
        (d / n).write_text("0 FILE x\n")
    return tmp_path / "omr"


def test_find_pairs_matches_by_set_number(tmp_path):
    (tmp_path / "pdf").mkdir()
    (tmp_path / "pdf/a.pdf").write_bytes(b"x")
    src = _sources(tmp_path, [{"set": "42093", "booklet": "1", "path": "pdf/a.pdf"},
                              {"set": "99999", "booklet": "2", "path": "pdf/b.pdf"}])
    pairs, skips = find_pairs(src, _omr(tmp_path, "42093"), tmp_path)
    assert [p.set_number for p in pairs] == ["42093"]
    assert isinstance(pairs[0], Pair) and pairs[0].pdf == tmp_path / "pdf/a.pdf"
    assert skips == [{"set": "99999", "reason": "no OMR model"}]


def test_find_pairs_skips_missing_pdf(tmp_path):
    src = _sources(tmp_path, [{"set": "42093", "booklet": "1", "path": "pdf/a.pdf"}])
    pairs, skips = find_pairs(src, _omr(tmp_path, "42093"), tmp_path)
    assert pairs == [] and skips == [{"set": "42093", "reason": "PDF missing"}]


def test_find_pairs_picks_set_1_file_when_several_mpds(tmp_path):
    (tmp_path / "pdf").mkdir()
    (tmp_path / "pdf/a.pdf").write_bytes(b"x")
    src = _sources(tmp_path, [{"set": "42093", "booklet": "1", "path": "pdf/a.pdf"}])
    omr = _omr(tmp_path, "42093", ["42093-1-extra.mpd", "42093-1.mpd"])
    pairs, _ = find_pairs(src, omr, tmp_path)
    assert pairs[0].omr.name == "42093-1.mpd"
