import numpy as np
import pytest

from booklet_mpd.truth import build_steps


def w(path, text):
    path.write_text(text.strip() + "\n")
    return str(path)


def ref(colour, x, name):
    return f"1 {colour} {x} 0 0 1 0 0 0 1 0 0 0 1 {name}"


def test_submodel_steps_come_first_and_are_not_repeated_in_parent(tmp_path):
    p = w(tmp_path / "a.mpd", f"""
0 FILE main.ldr
{ref(4, 0, '3020.dat')}
{ref(4, 100, 'sub.ldr')}
0 STEP
{ref(4, 0, '3023.dat')}
0 STEP
0 FILE sub.ldr
{ref(4, 0, '3001.dat')}
0 STEP
{ref(4, 20, '3001.dat')}
0 STEP
0 NOFILE""")
    steps = build_steps(p)
    assert [[part for part, _c, _m in s] for s in steps] == [["3001"], ["3001"], ["3020"], ["3023"]]
    assert steps[1][0][2][0, 3] == 120  # child offset 20 + instance offset 100


def test_second_instance_leaves_join_the_parent_step(tmp_path):
    p = w(tmp_path / "b.mpd", f"""
0 FILE main.ldr
{ref(4, 0, 'sub.ldr')}
{ref(4, 50, 'sub.ldr')}
0 STEP
0 FILE sub.ldr
{ref(4, 0, '3001.dat')}
0 STEP
{ref(4, 20, '3001.dat')}
0 STEP
0 NOFILE""")
    assert [len(s) for s in build_steps(p)] == [1, 1, 2]


def test_colour_16_inherits_instance_colour(tmp_path):
    p = w(tmp_path / "c.mpd", f"""
0 FILE main.ldr
{ref(7, 0, 'sub.ldr')}
0 STEP
0 FILE sub.ldr
{ref(16, 0, '3001.dat')}
0 STEP
0 NOFILE""")
    assert build_steps(p)[0][0][1] == 7


def test_cyclic_reference_raises(tmp_path):
    p = w(tmp_path / "d.mpd", f"""
0 FILE main.ldr
{ref(4, 0, 'sub.ldr')}
0 STEP
0 FILE sub.ldr
{ref(4, 0, 'main.ldr')}
0 STEP
0 NOFILE""")
    with pytest.raises(ValueError, match="Cyclic"):
        build_steps(p)


def test_flat_model_matches_plain_steps(tmp_path):
    p = w(tmp_path / "e.mpd", f"""
0 FILE main.ldr
{ref(4, 0, '3020.dat')}
0 STEP
{ref(4, 0, '3023.dat')}
0 STEP
0 NOFILE""")
    assert [len(s) for s in build_steps(p)] == [1, 1]
