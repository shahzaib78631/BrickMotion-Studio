"""Knowledge base helpers: stud direction, part renames, colour clean-up, a tiny end-to-end build."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz import knowledge as kb

IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
# local y -> world -z (LDraw): studs (local -y) point to +z
FACING_Z = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
LIB = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "public", "ldraw")


def test_stud_dir():
    assert kb.stud_dir(IDENT, [0, 0, -1]) == "up"
    assert kb.stud_dir(FACING_Z, [0, 0, 1]) == "front"
    assert kb.stud_dir(FACING_Z, [0, 0, -1]) == "back"
    assert kb.stud_dir(FACING_Z, [1, 0, 0]) == "side"


def test_canonical_follows_moved_parts():
    if not os.path.exists(os.path.join(LIB, "parts", "3023.dat")):
        return  # library not present
    assert kb.canonical(LIB, "3023") == "3023b"
    assert kb.canonical(LIB, "3001") == "3001"


def _piece(key, part, comp, color, lo, hi, m=IDENT):
    return {"key": key, "basePart": part, "component": comp, "color": color, "figure": 0, "matrix": m, "aabb": [lo, hi]}


def test_build_counts_roles_and_hair():
    rec = {
        "id": "t", "name": "t.mpd", "frame": {"front": [0, 0, -1]}, "face": {"front": [0, 0, -1]},
        "figures": [{"headCube": {}}],
        "pieces": [
            _piece("a", "3003", "head", 14, [-20, 0, -20], [20, 24, 20]),
            _piece("b", "15068", "hair", 0, [-20, 24, -20], [20, 32, 20]),
            _piece("c", "3070b", "face", 14, [-10, 8, -24], [10, 16, -20]),
        ],
        "connections": [{"a": "a", "b": "b", "kind": "interlock", "confidence": "interlock"}],
    }
    out = kb.build([rec], "/nonexistent", {"parts": {}, "bh_sets": {}, "bh_total": 0, "colors": {}})
    assert out["role"]["hair"]["parts"]["15068"] == 1
    assert out["part"]["3003"]["roles"]["head"] == 1
    hm = out["hair_models"][0]
    assert hm["pieces"] == 1 and hm["items"][0]["attached_to"] == "head" and hm["items"][0]["studs"] == "up"
    assert hm["extent"]["above_head_plates"] == 1.0


def test_bricknet_connectors_directions_and_aliases(tmp_path):
    import json
    import lzma

    labels = {"3024.dat": {"stud": {"stud": [[0, 0, 0, 0.0, 0.0]]}, "hole": {"hole": [[0, 8, 0, 0.0, 0.0]]}},
              "87087.dat": {"stud": {"stud": [[0, 0, 0, 0.0, 0.0]], "open": [[0, 10, -10, 90.0, 0.0]]},
                            "axle": {"clip": [[0, 10, -12, -90.0, 0.0, 2]]}}}
    with lzma.open(tmp_path / "labels.json.xz", "wt") as fh:
        json.dump(labels, fh)
    ident = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    with lzma.open(tmp_path / "part_aliases.json.xz", "wt") as fh:
        json.dump({"rows": [{"src": "3024a", "dst": "3024", "final_matrix_3x4": ident}]}, fh)
    c = kb.bricknet_connectors(str(tmp_path))
    assert c["3024"] == {"studs_up": 1, "anti_studs": 1}
    assert c["87087"] == {"studs_up": 1, "studs_side": 1, "clips": 1}
    assert c["3024a"] == c["3024"]
