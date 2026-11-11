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


def test_flexible_chain_submodel_counts_as_one_part(tmp_path):
    seg = "\n".join(ref(0, 8 * i, "750.dat") for i in range(20))
    p = w(tmp_path / "f.mpd", f"""
0 FILE main.ldr
{ref(4, 0, '3020.dat')}
{ref(4, 100, 'flexaxle-studio-1.ldr')}
0 STEP
0 FILE flexaxle-studio-1.ldr
{seg}
0 NOFILE""")
    steps = build_steps(p)
    assert [[part for part, _c, _m in s] for s in steps] == [["3020", "flexaxle-studio-1"]]
    assert steps[0][1][2][0, 3] == 100


def test_small_stepless_submodel_is_still_expanded(tmp_path):
    p = w(tmp_path / "g.mpd", f"""
0 FILE main.ldr
{ref(4, 0, 'sub.ldr')}
0 STEP
0 FILE sub.ldr
{ref(4, 0, '3001.dat')}
{ref(4, 20, '3023.dat')}
0 NOFILE""")
    assert [len(s) for s in build_steps(p)] == [2]


def test_embedded_part_definition_is_one_part_not_its_primitives(tmp_path):
    prims = "\n".join(ref(4, 10 * i, "stud.dat") for i in range(30))
    p = w(tmp_path / "h.mpd", f"""
0 FILE main.ldr
{ref(4, 0, '61904.dat')}
0 STEP
0 FILE 61904.dat
{prims}
0 NOFILE""")
    assert [[part for part, _c, _m in s] for s in build_steps(p)] == [["61904"]]


def test_lump_mode_keeps_submodel_parts_in_the_parent_step(tmp_path):
    p = w(tmp_path / "i.mpd", f"""
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
    assert [len(s) for s in build_steps(p, expand_submodels=False)] == [3, 1]


def test_malformed_line_raises_by_default_and_is_skipped_when_collecting_warnings(tmp_path):
    p = w(tmp_path / "j.mpd", f"""
0 FILE main.ldr
{ref(4, 0, '3020.dat')}
1 191 -10 -16 -30 1 0 0 0 1 0 0 0  24866.dat
0 STEP
0 NOFILE""")
    with pytest.raises(ValueError, match="Malformed"):
        build_steps(p)
    warnings = []
    steps = build_steps(p, warnings=warnings)
    assert [len(s) for s in steps] == [1] and len(warnings) == 1 and "Malformed" in warnings[0]


def test_long_stepless_chain_with_many_distinct_names_is_one_part(tmp_path):
    names = [f"seg{i % 8}.dat" for i in range(60)]
    seg = "\n".join(ref(0, 8 * i, n) for i, n in enumerate(names))
    p = w(tmp_path / "k.mpd", f"""
0 FILE main.ldr
{ref(4, 0, 'hose-studio-1.ldr')}
0 STEP
0 FILE hose-studio-1.ldr
{seg}
0 NOFILE""")
    assert [[part for part, _c, _m in s] for s in build_steps(p)] == [["hose-studio-1"]]


from booklet_mpd.truth import build_scoped_steps


def test_scoped_steps_show_only_what_the_picture_shows(tmp_path):
    p = w(tmp_path / "s.mpd", f"""
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
    steps = build_scoped_steps(p)
    names = lambda parts: [part for part, _c, _m in parts]
    assert [(names(s["added"]), names(s["visible"]), s["file"]) for s in steps] == [
        (["3001"], [], "sub.ldr"),
        (["3001"], ["3001"], "sub.ldr"),                      # the sub-assembly's own progress only
        (["3020"], [], "main.ldr"),                            # sub is attached in this step, not yet visible before it
        (["3023"], ["3020", "3001", "3001"], "main.ldr"),      # parent now shows leaves + the attached sub-assembly
    ]


def test_build_steps_is_unchanged_by_scoping(tmp_path):
    p = w(tmp_path / "t.mpd", f"""
0 FILE main.ldr
{ref(4, 0, 'sub.ldr')}
0 STEP
0 FILE sub.ldr
{ref(4, 0, '3001.dat')}
0 STEP
0 NOFILE""")
    assert [len(s) for s in build_steps(p)] == [1]
