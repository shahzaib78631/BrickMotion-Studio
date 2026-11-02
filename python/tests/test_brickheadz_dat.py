"""The MPD loader must keep embedded decorated ``.dat`` parts atomic while
recursing into ``.ldr`` submodels."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz.dat import load_pieces, parse_part_name

MPD = """0 FILE main.ldr
0 Name: main.ldr
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat
1 1 0 -24 0 1 0 0 0 1 0 0 0 1 sub.ldr
1 15 0 -48 0 1 0 0 0 1 0 0 0 1 main - 3069bpz0.dat
0 FILE sub.ldr
0 Name: sub.ldr
1 1 0 0 0 1 0 0 0 1 0 0 0 1 3022.dat
0 FILE main - 3069bpz0.dat
0 Name: main - 3069bpz0.dat
1 16 0 0 0 1 0 0 0 1 0 0 0 1 3069b.dat
"""


def test_parse_part_name():
    assert parse_part_name("41585-1 - 87079pz0.dat") == ("87079", True)
    assert parse_part_name("3068bpz0") == ("3068b", True)
    assert parse_part_name("3069b.dat") == ("3069b", False)
    assert parse_part_name("3003.dat") == ("3003", False)


def test_loader_keeps_embedded_parts_atomic(tmp_path):
    path = tmp_path / "m.mpd"
    path.write_text(MPD)
    pieces = load_pieces(str(path))
    by_part = {p.part: p for p in pieces}

    assert "3003.dat" in by_part  # plain library part
    assert "3022.dat" in by_part  # recursed into the .ldr submodel
    assert by_part["3022.dat"].submodel == "sub.ldr"

    deco = by_part["main - 3069bpz0.dat"]
    assert deco.base_part == "3069b"
    assert deco.decorated is True
    # the decorated part's own internals must not surface as separate pieces
    assert not any(p.part == "3069b.dat" for p in pieces)
    assert by_part["3003.dat"].decorated is False
