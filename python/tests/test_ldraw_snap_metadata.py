"""Connector metadata must retain geometry before any placement search uses it."""
from pathlib import Path
import json
import numpy as np
from assembly_model.ldraw import LDrawLibrary,_parse_ldcad_meta,_grid


def library(tmp_path,files,shadows):
    root=tmp_path/'ldraw';parts=root/'parts';parts.mkdir(parents=True)
    for name,text in files.items():
        file=parts/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(text)
    data=tmp_path/'data';data.mkdir();(data/'ldcad-shadow.json').write_text(json.dumps({'files':shadows}))
    return LDrawLibrary(str(root))


def test_bracket_parameters_keep_spaces_case_and_ignore_comments():
    rows=_parse_ldcad_meta('0 //!LDCAD SNAP_CLEAR\n0 !LDCAD SNAP_CYL [ID=stud] [gender=M] [secs=R 6 4] [pos=0 8 0] [ori=1 0 0 0 1 0 0 0 1] [grid=C 4 C 4 20 20]')
    assert len(rows)==1
    assert rows[0]['pos']=='0 8 0' and rows[0]['secs']=='R 6 4' and rows[0]['id']=='stud'
    assert len(rows[0]['ori'].split())==9 and rows[0]['grid']=='C 4 C 4 20 20'


def test_centered_and_origin_grid_offsets():
    offsets=np.asarray(_grid('C 4 C 4 20 20'))
    assert offsets.shape==(16,3)
    assert set(offsets[:,0])=={-30,-10,10,30} and set(offsets[:,2])=={-30,-10,10,30}
    assert np.asarray(_grid('2 1 20 0')).tolist()==[[0,0,0],[20,0,0]]


def test_grid_respects_snap_orientation_and_unit_axis(tmp_path):
    lib=library(tmp_path,{'part.dat':'0 test'}, {'part.dat':'0 !LDCAD SNAP_CYL [gender=M] [secs=R 6 4] [pos=10 0 0] [ori=0 -1 0 1 0 0 0 0 1] [grid=C 2 1 20 0]'})
    snaps=lib.snaps('part.dat')
    assert {s.pos for s in snaps}=={(10,-10,0),(10,10,0)}
    assert all(s.axis==(1,0,0) and s.length==4 and s.radius==6 for s in snaps)


def test_reference_scale_normalizes_axis_and_scales_profile(tmp_path):
    lib=library(tmp_path,{'parent.dat':'1 16 0 0 0 2 0 0 0 20 0 0 0 2 child.dat','child.dat':'0'},
                {'child.dat':'0 !LDCAD SNAP_CYL [id=hole] [gender=F] [secs=R .3 1] [pos=0 1 0]'})
    snap=lib.snaps('parent.dat')[0]
    assert snap.pos==(0,20,0) and snap.axis==(0,-1,0)
    assert snap.length==20 and np.isclose(snap.radius,.6)


def test_backslash_subfiles_and_clear_only_inherited_ids(tmp_path):
    lib=library(tmp_path,{'parent.dat':'1 16 30 0 0 1 0 0 0 1 0 0 0 1 s\\child.dat','s/child.dat':'0'},
                {'s/child.dat':'0 !LDCAD SNAP_CYL [id=oldHole] [gender=F] [secs=R 6 4]\n0 !LDCAD SNAP_CYL [id=stud] [gender=M] [secs=R 6 4]',
                 'parent.dat':'0 !LDCAD SNAP_CLEAR [id=OLDHOLE]\n0 !LDCAD SNAP_CYL [id=newHole] [gender=F] [secs=R 6 4] [pos=0 8 0]'})
    snaps=lib.snaps('parent.dat')
    assert {s.id for s in snaps}=={'stud','newHole'}
    assert next(s for s in snaps if s.id=='stud').pos==(30,0,0)


def test_clear_all_retains_own_definitions_and_include_transform(tmp_path):
    lib=library(tmp_path,{'part.dat':'1 16 0 0 0 1 0 0 0 1 0 0 0 1 geometry.dat','geometry.dat':'0'},
                {'part.dat':'0 !LDCAD SNAP_CLEAR\n0 !LDCAD SNAP_INCL [ref=connector.dat] [pos=0 8 0] [grid=C 2 1 20 0]',
                 'connector.dat':'0 !LDCAD SNAP_CYL [id=own] [gender=F] [secs=R 6 4]',
                 'geometry.dat':'0 !LDCAD SNAP_CYL [id=inherited] [gender=M] [secs=R 6 4]'})
    snaps=lib.snaps('part.dat')
    assert len(snaps)==2 and all(s.id=='own' for s in snaps)
    assert {s.pos for s in snaps}=={(-10,8,0),(10,8,0)}


def test_malformed_metadata_is_diagnostic_not_phantom_connector(tmp_path):
    lib=library(tmp_path,{'part.dat':'0'}, {'part.dat':'0 !LDCAD SNAP_CYL [gender=F] [secs=R 6 4] [pos=bad value]\n0 !LDCAD SNAP_CYL [gender=F] [secs=R 6] '})
    assert lib.snaps('part.dat')==()
    assert len(lib.snap_diagnostics)==2


def test_real_plate_and_round_brick_have_bottom_connector_grids():
    root=Path(__file__).resolve().parents[2];lib=LDrawLibrary(str(root/'public/ldraw'))
    plate=[s for s in lib.snaps('3031.dat') if s.gender=='F' and s.radius==6]
    assert len(plate)==16 and {s.pos[1] for s in plate}=={8}
    assert {s.pos[0] for s in plate}=={-30,-10,10,30}
    brick=[s for s in lib.snaps('3941.dat') if s.gender=='F' and s.radius==6 and s.length==4]
    assert len(brick)==4 and {s.pos[1] for s in brick}=={24}
    hollow=[s for s in lib.snaps('stud2.dat') if s.gender=='F']
    assert len(hollow)==1 and hollow[0].axis==(0,1,0) and hollow[0].pos==(0,-4,0)
