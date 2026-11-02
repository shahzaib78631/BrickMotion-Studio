"""DNA feature vector and corpus discovery."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.corpus import discover
from brickheadz.dat import load_pieces
from brickheadz.dna import build_dna, load_catalog
from brickheadz.semantics import analyze

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
BATMAN = os.path.join(ROOT, "40859-batman.mpd")


def test_dna_shape():
    lib = load_library(os.path.join(ROOT, "public", "ldraw"))
    catalog = load_catalog(os.path.join(ROOT, "public", "data", "catalog.json"))
    pieces = load_pieces(BATMAN)
    dna = build_dna(analyze(lib, pieces), pieces, catalog)

    assert set(dna) == {"proportions", "construction", "color", "parts", "face"}
    assert dna["construction"]["pieces"] == len(pieces)
    assert dna["proportions"]["total"]["hPlates"] > 0
    assert dna["color"]["palette"] >= 1
    assert 0.0 <= dna["construction"]["snotRatio"] <= 1.0
    assert dna["parts"]["vocabulary"] >= 1


def test_discover_ignores_manifest_and_non_mpd(tmp_path):
    (tmp_path / "41585 - Batman.mpd").write_text("0 FILE x\n")
    (tmp_path / "download_manifest.json").write_text('{"models": []}')
    (tmp_path / ".DS_Store").write_text("")
    models = discover(str(tmp_path))
    assert [m.id for m in models] == ["41585"]
