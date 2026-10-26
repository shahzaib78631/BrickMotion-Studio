"""Offline regression tests for caching, spatial matching and explainability."""
from collections import Counter
from pathlib import Path
import json
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ldraw_autostep as A


def make_lib(tmp_path):
    root = tmp_path / 'library'
    (root / 'parts').mkdir(parents=True)
    return A.Library(ldraw_dir=str(root), cache_dir=str(tmp_path / 'cache'), offline=True), root / 'parts'


def ref(name, x=0, y=0, z=0, matrix='1 0 0 0 1 0 0 0 1'):
    return f'1 16 {x} {y} {z} {matrix} {name}'


def test_hierarchical_bounds_are_exact_without_vertex_expansion(tmp_path):
    lib, parts = make_lib(tmp_path)
    (parts / 'leaf.dat').write_text(
        '3 16 -2 -1 0 7 5 4 10 -3 2\n'
        '5 24 3 2 -8 -4 3 2 800 800 800 -800 -800 -800\n', encoding='utf-8')
    (parts / 'compound.dat').write_text('\n'.join([
        ref('leaf.dat', x=13),
        ref('leaf.dat', y=25, matrix='0 -1 0 1 0 0 0 0 1'),
    ]), encoding='utf-8')
    matrix = np.array([[0.6, 0, 0.8], [0, 1, 0], [-0.8, 0, 0.6]])
    offset = np.array([20, -10, 35])
    actual = lib.bounds('compound.dat', matrix, offset)
    assert lib._geo == {}, 'the normal bounds API must not flatten referenced vertices'
    baseline = lib.vertices('compound.dat') @ matrix.T + offset
    np.testing.assert_allclose(actual[0], baseline.min(0))
    np.testing.assert_allclose(actual[1], baseline.max(0))
    first_eval = lib.geometry_stats['bounds_evaluations']
    for x in range(40):
        result = lib.bounds('compound.dat', matrix, offset + [x, 0, 0])
        np.testing.assert_allclose(result[0], actual[0] + [x, 0, 0])
    assert lib.geometry_stats['bounds_evaluations'] == first_eval
    assert lib.geometry_stats['bounds_cache_hits'] >= 40
    assert lib.geometry_stats['parsed_files'] == 2


def test_nested_missing_dependency_is_reported_even_with_partial_bounds(tmp_path):
    lib, parts = make_lib(tmp_path)
    (parts / 'outer.dat').write_text(
        '2 16 0 0 0 10 10 10\n' + ref('not_here.dat') + '\n', encoding='utf-8')
    assert lib.bounds('outer.dat') is not None
    _, models = A.split_models(ref('outer.dat'))
    us = A.read_units(models[0], set(), lib, A.SnapDB(lib), use_shadow=False)[1]
    assert us[0]['missing_geometry']
    assert us[0]['geometry_issues'] == [
        {'code': 'missing_subpart', 'path': ['outer.dat', 'not_here.dat']}]


def test_source_line_is_global_across_mpd_submodels(tmp_path):
    lib, parts = make_lib(tmp_path)
    (parts / 'brick.dat').write_text('2 16 0 0 0 1 1 1\n')
    _, models = A.split_models('\n'.join([
        '0 FILE first.ldr', '0 Name: first', ref('brick.dat'),
        '0 FILE second.ldr', '0 Name: second', ref('brick.dat')]))
    assert models[0]['start_line'] == 1
    assert models[1]['start_line'] == 4
    us = A.read_units(models[1], set(), lib, A.SnapDB(lib), False)[1]
    assert us[0]['source_line'] == 6


def test_cycles_are_diagnosed_not_recursed_forever(tmp_path):
    lib, parts = make_lib(tmp_path)
    (parts / 'loop_a.dat').write_text(
        '2 24 0 0 0 2 2 2\n' + ref('loop_b.dat') + '\n', encoding='utf-8')
    (parts / 'loop_b.dat').write_text(ref('loop_a.dat'), encoding='utf-8')
    assert lib.bounds('loop_a.dat') is not None
    details = lib.explain_geometry('loop_a.dat')
    assert details['issues'] == [{'code': 'geometry_cycle',
                                  'path': ['loop_a.dat', 'loop_b.dat', 'loop_a.dat']}]


def test_broad_phase_matches_brute_force_for_random_bounds():
    rng = np.random.default_rng(10)
    al = rng.uniform(-120, 120, (95, 3))
    ah = al + rng.uniform(0.1, 50, (95, 3))
    bl = rng.uniform(-120, 120, (78, 3))
    bh = bl + rng.uniform(0.1, 50, (78, 3))
    for pad in (0, 0.6, 1.05):
        pairs = set(A.spatial_pairs(al, ah, bl, bh, padding=pad))
        brute = {(i, j) for i in range(len(al)) for j in range(len(bl))
                 if np.all(bl[j] <= ah[i] + pad) and np.all(bh[j] >= al[i] - pad)}
        assert pairs == brute


def test_snap_sweep_prunes_distant_connectors():
    units = []
    for gender, shift in [('M', 0), ('F', 0)]:
        for i in range(120):
            x = i * 40 + shift
            c = A.Conn('CYL', gender, np.array([float(x), 0., 0.]),
                       np.array([0., 1., 0.]), 8., 4., 'R', False, 'one')
            units.append({'kind': 'part', 'part': f'{gender}{i}.dat', 'color': '16',
                          'order': len(units), 'bb': (np.array([x - 2., -4., -2.]),
                                                         np.array([x + 2., 4., 2.])),
                          'wconns': [c]})
    an = A.Analysis(units, use_shadow=True)
    assert an.snap_pairs == 120
    assert an.snap_possible_pairs == 14400
    assert an.snap_candidate_pairs == 120
    assert all(an.edge_evidence[(i, i + 120)]['source'] == 'snap' for i in range(120))


def test_rotated_obbs_reject_false_aabb_contacts():
    rotation = np.array([[2**-.5, 0, 2**-.5],
                         [0, 1, 0],
                         [-2**-.5, 0, 2**-.5]])
    local = (np.array([-20., -1., -2.]), np.array([20., 1., 2.]))
    us = []
    for i, pos in enumerate((np.array([0., 0., 0.]), np.array([5., 0., 5.]))):
        # The long axes run from (+X,+Z) to (-X,-Z); a perpendicular offset
        # of (5,+5) is enough to separate the narrow oriented boxes.
        corners = np.array([[x, y, z] for x in (local[0][0], local[1][0])
                            for y in (local[0][1], local[1][1])
                            for z in (local[0][2], local[1][2])]) @ rotation.T + pos
        us.append({'kind': 'part', 'part': f'rod{i}.dat', 'color': '16',
                   'order': i, 'local_bb': local, 'M': rotation, 't': pos,
                   'bb': (corners.min(0), corners.max(0)), 'wconns': []})
    old = A.Analysis(us, use_shadow=False, contact_mode='aabb')
    new = A.Analysis(us, use_shadow=False, contact_mode='obb')
    assert old.contact[0, 1]
    assert not new.contact[0, 1]
    assert new.obb_rejections == 1


def test_explain_json_and_dot_link_provenance(tmp_path):
    lib, parts = make_lib(tmp_path)
    (parts / 'brick.dat').write_text('2 16 -10 -12 -10 10 12 10\n', encoding='utf-8')
    a, b, report, dot = (tmp_path / n for n in ('in.ldr', 'out.ldr', 'report.json', 'links.dot'))
    text = '\n'.join([ref('brick.dat', y=0), ref('brick.dat', y=-24), ref('missing.dat', y=-50)]) + '\n'
    a.write_text(text, encoding='utf-8')
    code = A.main([str(a), '-o', str(b), '--ldraw', lib.ldraw_dir, '--offline', '--no-shadow',
                   '--report-json', str(report), '--explain', '--report-dot', str(dot), '--max-step', '1'])
    assert code == 0
    data = json.loads(report.read_text(encoding='utf-8'))[0]
    assert len(data['parts']) == 3
    assert all('selection_reason' in p for step in data['steps_detail'] for p in step['placements'])
    assert data['geometry_stats']['parsed_files'] == 1
    assert any(issue['code'] == 'missing_part' for issue in data['issues'])
    assert any(x['source'] in ('contact', 'component_bridge') for x in data['connections'])
    assert 'graph ldraw_autostep {' in dot.read_text()
    assert 'brick.dat' in dot.read_text()
    assert Counter(x for x in text.splitlines() if x.startswith('1 ')) == Counter(
        x for x in b.read_text().splitlines() if x.startswith('1 '))


def test_cli_diagnostic_option_validation(tmp_path):
    src, dst = tmp_path / 'in.ldr', tmp_path / 'out.ldr'
    src.write_text(ref('x.dat'), encoding='utf-8')
    with pytest.raises(SystemExit) as exc:
        A.main([str(src), '-o', str(dst), '--offline', '--explain'])
    assert exc.value.code == 2
    with pytest.raises(SystemExit) as exc:
        A.main([str(src), '-o', str(dst), '--report-dot', str(src), '--offline'])
    assert exc.value.code == 2


def test_invalid_transform_has_source_location(tmp_path):
    lib, parts = make_lib(tmp_path)
    _, models = A.split_models('0 FILE model.ldr\n0 Name: broken\n' +
                               ref('brick.dat', x='nan'))
    with pytest.raises(ValueError, match=r'model.ldr \(source line 3\): invalid transform'):
        A.read_units(models[0], set(), lib, A.SnapDB(lib), use_shadow=False)


def test_reference_only_explanation_has_submodel_nodes_without_geometry(tmp_path):
    a, b, report, dot = (tmp_path / name for name in ('in.mpd', 'out.mpd', 'report.json', 'graph.dot'))
    a.write_text('\n'.join(['0 FILE main.ldr', ref('a.ldr'), ref('b.ldr'),
                            '0 FILE a.ldr', ref('x.dat'),
                            '0 FILE b.ldr', ref('x.dat')]), encoding='utf-8')
    assert A.main([str(a), '-o', str(b), '--only', 'main.ldr', '--offline',
                   '--no-shadow', '--report-json', str(report), '--explain',
                   '--report-dot', str(dot), '-q']) == 0
    data = json.loads(report.read_text())[0]
    assert [x['part'] for x in data['parts']] == ['a.ldr', 'b.ldr']
    assert all(x['selection_reason'] == 'submodel_reference'
               for step in data['steps_detail'] for x in step['placements'])
    assert 'a.ldr' in dot.read_text()


def test_large_fixture_fast_fallback_preserves_original_lines(tmp_path):
    fixture = Path(__file__).resolve().parents[1] / '5590_-_whirl_n_wheel_super_truck_autostep.mpd'
    a, b, report = (tmp_path / n for n in ('input.mpd', 'output.mpd', 'report.json'))
    a.write_bytes(fixture.read_bytes())
    assert A.main([str(a), '-o', str(b), '--only', 'Truck.ldr', '--offline',
                   '--no-shadow', '-q', '--report-json', str(report), '--max-step', '6']) == 0
    before = a.read_text().splitlines()
    after = b.read_text().splitlines()
    assert Counter(x for x in before if x.startswith('1 ')) == Counter(
        x for x in after if x.startswith('1 '))
    result = json.loads(report.read_text())[0]
    assert result['units'] > 400
    assert result['analysis_stats']['aabb_candidate_pairs'] < 100
    assert 'geometry_stats' in result
    assert 'parts' not in result  # verbose explanation is opt-in
