"""Fast, deterministic regression suite. No external LDraw downloads needed."""
from collections import Counter
from pathlib import Path
import json
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ldraw_autostep as A


PART_LINE = '1 7 {x} {y} {z} 1 0 0 0 1 0 0 0 1 {name}'


def part(name='brick.dat', x=0, y=0, z=0):
    return PART_LINE.format(name=name, x=x, y=y, z=z)


@pytest.fixture
def library(tmp_path):
    root = tmp_path / 'ldraw'
    shadow = tmp_path / 'shadow'
    (root / 'parts').mkdir(parents=True)
    (shadow / 'parts').mkdir(parents=True)
    # A diagonal line has all three bbox dimensions, unlike a degenerate point.
    (root / 'parts' / 'brick.dat').write_text(
        '0 Brick\n2 16 -10 -12 -10 10 12 10\n', encoding='utf-8')
    (root / 'parts' / 'male.dat').write_text(
        '0 Male\n2 16 -10 -10 -10 10 10 10\n', encoding='utf-8')
    (root / 'parts' / 'female.dat').write_text(
        '0 Female\n2 16 -10 -10 -10 10 10 10\n', encoding='utf-8')
    (shadow / 'parts' / 'male.dat').write_text(
        '0 !LDCAD SNAP_CYL [gender=M] [pos=0 0 0] [secs=A 6 8]\n', encoding='utf-8')
    (shadow / 'parts' / 'female.dat').write_text(
        '0 !LDCAD SNAP_CYL [gender=F] [pos=0 0 0] [secs=R 6 8]\n', encoding='utf-8')
    return A.Library(str(root), str(shadow), str(tmp_path / 'cache'), offline=True)


def units(text, library, shadow=True):
    _, models = A.split_models(text)
    return A.read_units(models[0], set(), library, A.SnapDB(library), use_shadow=shadow)[1]


def test_vertices_include_lines_and_conditionals(library):
    np.testing.assert_array_equal(library.vertices('brick.dat').min(0), [-10, -12, -10])
    np.testing.assert_array_equal(library.vertices('brick.dat').max(0), [10, 12, 10])
    source = Path(library.ldraw_dir) / 'parts' / 'conditional.dat'
    source.write_text('5 24 -5 -6 -7 5 6 7 900 900 900 -900 -900 -900\n', encoding='utf-8')
    assert len(library.vertices('conditional.dat')) == 2
    np.testing.assert_array_equal(library.vertices('conditional.dat').max(0), [5, 6, 7])


def test_included_shadow_conn_scales_length_and_radius(library):
    shadow = Path(library.shadow_dir) / 'parts'
    (shadow / 'core.dat').write_text(
        '0 !LDCAD SNAP_CYL [gender=M] [pos=1 2 3] [secs=R 4 10]\n', encoding='utf-8')
    (shadow / 'scaled.dat').write_text(
        '0 !LDCAD SNAP_INCL [ref=core.dat] [pos=10 20 30] [scale=2 3 4]\n', encoding='utf-8')
    db = A.SnapDB(library)
    c = db.of('scaled.dat')[0]
    assert c.length == pytest.approx(30.0)
    assert c.radius == pytest.approx(4 * np.sqrt(2 * 4))
    np.testing.assert_array_equal(c.pos, [12, 26, 42])


def test_snap_axle_in_round_hole_is_articulated(library):
    us = units(part('male.dat') + '\n' + part('female.dat'), library)
    an = A.Analysis(us)
    assert an.snap_pairs == 1
    assert an.attach[0, 1] and not an.rigid[0, 1]


def test_snap_does_not_connect_distant_parts(library):
    us = units(part('male.dat') + '\n' + part('female.dat', x=80), library)
    an = A.Analysis(us)
    assert not an.attach[0, 1]


def test_bottom_up_assembly_and_complete_part_set(library):
    us = units('\n'.join([part(y=-48), part(y=0), part(y=-24)]), library, shadow=False)
    an = A.Analysis(us, use_shadow=False)
    steps = A.plan_steps(us, an, max_step=1, foundation=1)
    flat = [i for step in steps for i in step]
    assert sorted(flat) == [0, 1, 2]
    assert flat == [1, 2, 0]


def test_max_step_only_allows_mirror_pair_exception(library):
    us = units('\n'.join([part(), part(x=-20), part(x=20)]), library, shadow=False)
    an = A.Analysis(us, use_shadow=False)
    steps = A.plan_steps(us, an, max_step=1)
    assert sorted(i for st in steps for i in st) == [0, 1, 2]
    assert steps[0] == [0]
    assert sorted(steps[1]) == [1, 2]


def test_metadata_stays_with_following_part_after_reorder(library):
    txt = '\n'.join(['0 FILE Demo.ldr', '0 Name: Demo.ldr', part(y=-24),
                     '0 STEP', '0 BFC INVERTNEXT', '0 Assembly 1', part(y=0),
                     '0 STEP', '0 // trailer'])
    _, models = A.split_models(txt)
    header, us, trailer, dropped = A.read_units(models[0], set(), library, A.SnapDB(library), False)
    assert header == ['0 FILE Demo.ldr', '0 Name: Demo.ldr']
    assert us[1]['lines'] == ['0 BFC INVERTNEXT', '0 Assembly 1', part(y=0)]
    assert trailer == ['0 // trailer']
    assert dropped == 2
    arranged = A.emit_steps(us, [[1], [0]])
    assert arranged.index('0 BFC INVERTNEXT') + 2 == arranged.index(part(y=0))


def test_lsynth_block_is_indivisible_and_comment_anchored(library):
    txt = '\n'.join([part(), '0 // flex hose', '0 SYNTH BEGIN TEST 7',
                     '0 MLCAD HIDE ' + part(), part('male.dat'),
                     '0 SYNTH END', part(y=-24)])
    us = units(txt, library, shadow=False)
    assert [u['kind'] for u in us] == ['part', 'synth', 'part']
    assert us[1]['lines'] == ['0 // flex hose', '0 SYNTH BEGIN TEST 7',
                              '0 MLCAD HIDE ' + part(), part('male.dat'), '0 SYNTH END']
    assert [u['part'] for u in us if u['kind'] == 'part'] == ['brick.dat', 'brick.dat']
    an = A.Analysis(us, use_shadow=False)
    assert A.plan_steps(us, an, max_step=8)[-1] == [1]  # final synth-only step


def test_reject_external_path_escape(tmp_path):
    lib = A.Library(cache_dir=str(tmp_path), offline=True)
    forbidden = tmp_path / 'secret.dat'
    forbidden.write_text('top secret', encoding='utf-8')
    assert lib.ldraw('../secret.dat') is None
    assert lib.ldraw('/tmp/secret.dat') is None
    assert lib.ldraw(r'C:\secret.dat') is None
    assert lib.ldraw('s/../../secret.dat') is None
    assert A.safe_library_name('s/brick.dat')


def test_split_models_handles_mixed_line_endings():
    eol, ms = A.split_models('0 FILE model.ldr\r\n' + part() + '\n0 STEP\r' + part(y=-24) + '\r\n')
    assert eol == '\r\n'
    assert ms[0]['lines'] == ['0 FILE model.ldr', part(), '0 STEP', part(y=-24), '']


def test_assembly_only_never_looks_up_geometry(library, monkeypatch, tmp_path):
    text = ('0 FILE master.ldr\n' + part('sub.ldr') + '\n'
            '0 FILE sub.ldr\n' + part())
    input_file, output_file = tmp_path / 'model.mpd', tmp_path / 'result.mpd'
    input_file.write_text(text, encoding='utf-8')
    monkeypatch.setattr(A.Library, 'vertices', lambda self, name: pytest.fail('assembly downloaded geometry'))
    code = A.main([str(input_file), '-o', str(output_file), '--only', 'MASTER.LDR',
                   '--offline', '--no-shadow', '--ldraw', library.ldraw_dir])
    assert code == 0
    out = output_file.read_text(encoding='utf-8')
    assert out.count('0 STEP') == 1
    assert out.split('0 FILE sub.ldr')[1] == '\n' + part()


def test_geometry_definitions_are_not_reordered(tmp_path):
    text = '0 FILE part.dat\n0 STEP\n2 24 0 0 0 1 1 1\n' + part()
    a, b = tmp_path / 'in.mpd', tmp_path / 'out.mpd'
    a.write_text(text, encoding='utf-8')
    assert A.main([str(a), '-o', str(b), '--offline', '--no-shadow']) == 0
    assert b.read_text(encoding='utf-8') == text


def test_cli_json_diagnostics_strict_and_no_missing_silent(tmp_path):
    a, b, report = (tmp_path / n for n in ('in.ldr', 'out.ldr', 'report.json'))
    a.write_text(part('unknown.dat') + '\n', encoding='utf-8')
    code = A.main([str(a), '-o', str(b), '--cache', str(tmp_path / 'cache'), '--offline',
                   '--no-shadow', '--strict', '--report-json', str(report)])
    assert code == 1
    assert b.exists()
    diagnostics = json.loads(report.read_text(encoding='utf-8'))
    assert diagnostics[0]['missing_geometry'] == 1
    assert 'unknown.dat' in diagnostics[0]['notes'][0]


def test_cli_invalid_options_and_unknown_model(tmp_path):
    a, b = tmp_path / 'in.ldr', tmp_path / 'out.ldr'
    a.write_text(part(), encoding='utf-8')
    for args in (['--max-step', '0'], ['--sub-min', '4', '--sub-max', '2'],
                 ['--report-json', str(b)], ['--report-json', str(a)],
                 ['--only', 'absent.ldr'], ['--only']):
        with pytest.raises(SystemExit) as exc:
            A.main([str(a), '-o', str(b), '--offline'] + args)
        assert exc.value.code == 2
        assert not b.exists()


def test_cli_preserves_original_part_line_text_and_crlf(tmp_path, library):
    a, b = tmp_path / 'in.ldr', tmp_path / 'out.ldr'
    unusual = '1 0007 +0.000 -24.00 -0 1 0 0 0 1 0 0 0 1 brick.dat'
    text = '\r\n'.join(['0 Name: 3 bricks', part(), '0 STEP', '0 // middle', unusual,
                         '0 STEP', part(y=-48), '0 // tail', ''])
    a.write_bytes(text.encode('utf-8'))
    assert A.main([str(a), '-o', str(b), '--ldraw', library.ldraw_dir,
                   '--offline', '--no-shadow', '--max-step', '1']) == 0
    result = b.read_bytes()
    assert b'\r\n' in result and b'\n' not in result.replace(b'\r\n', b'')
    inputs = Counter(x for x in text.splitlines() if x.startswith('1 '))
    outputs = Counter(x for x in result.decode('utf-8').splitlines() if x.startswith('1 '))
    assert inputs == outputs
    assert result.decode('utf-8').count('0 STEP') == 3


def test_example_mpd_selective_planning_preserves_other_models(tmp_path):
    source = Path(__file__).resolve().parents[1] / '5590_-_whirl_n_wheel_super_truck_autostep.mpd'
    a, b = tmp_path / 'model.mpd', tmp_path / 'out.mpd'
    a.write_bytes(source.read_bytes())
    assert A.main([str(a), '-o', str(b), '--only', '5590 - Complete.ldr',
                   '--offline', '--no-shadow', '--cache', str(tmp_path / 'cache'), '-q']) == 0
    old = a.read_text(encoding='utf-8').split('0 FILE Truck.ldr', 1)[1]
    new = b.read_text(encoding='utf-8').split('0 FILE Truck.ldr', 1)[1]
    assert new == old
    raw = lambda data: Counter(x for x in data.splitlines() if x.startswith('1 '))
    assert raw(a.read_text(encoding='utf-8')) == raw(b.read_text(encoding='utf-8'))
