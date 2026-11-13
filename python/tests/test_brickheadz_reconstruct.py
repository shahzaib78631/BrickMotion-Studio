"""Path-A reconstruct: exact OMR assembly, and honest image-mode proposals."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz import reconstruct as R
from brickheadz.image_spec import ldconfig_rgb

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")
LDCONFIG = os.path.join(LIB, "LDConfig.ldr")

MPD = """0 FILE x
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 1 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat
1 2 0 20 0 1 0 0 0 1 0 0 0 1 3004.dat
0 NOFILE
"""


def test_steps_from_omr():
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".mpd", delete=False) as f:
        f.write(MPD)
        path = f.name
    steps = R.steps_from_omr(path)
    assert len(steps) == 2
    assert steps[0][0][0] == "3001"
    assert len(steps[1]) == 2


def test_from_omr_is_trusted(tmp_path):
    mpd = tmp_path / "m.mpd"
    mpd.write_text(MPD)
    report = R.from_omr(str(mpd), str(tmp_path), "Unit")
    assert report["trusted"] is True
    assert report["steps"] == 2 and report["pieces"] == 3
    assert (tmp_path / "Unit.mpd").exists()
    assert (tmp_path / "Unit.plan.json").exists()


def _save_png(rgb, path):
    import pymupdf

    arr = np.clip(rgb, 0, 255).astype(np.uint8)
    h, w = arr.shape[:2]
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w, h), False)
    pix.samples_mv[:] = arr.tobytes()
    pix.save(path)


def test_propose_gates_by_confidence(tmp_path):
    from brickheadz.instruction_place import CUBE_ROTATIONS, fit_camera, grid_matrix, render_pieces, world_points

    lib = load_library(LIB)
    palette = ldconfig_rgb(LDCONFIG)
    m, _, _ = grid_matrix(lib, "3001", 0, 0, 0, CUBE_ROTATIONS[0])
    cam = fit_camera(world_points(lib, "3001", m), 30, 25, 128)
    rgb, _ = render_pieces(lib, [("3001", palette[4], m, True)], cam, 128)
    img = tmp_path / "s.png"
    _save_png(rgb, str(img))
    spec = {
        "cam": {"yaw": cam.yaw, "pitch": cam.pitch, "scale": cam.scale, "ox": cam.ox, "oy": cam.oy},
        "steps": [{"image": str(img), "parts": [["3001", 4]]}],
    }
    strict = R.propose(lib, palette, spec, str(tmp_path / "a"), "t", min_confidence=1.01)
    assert strict["summary"]["committed"] == 0
    assert strict["summary"]["total"] == 1
    assert strict["trusted"] is False
    loose = R.propose(lib, palette, spec, str(tmp_path / "b"), "t", min_confidence=0.0)
    assert loose["summary"]["committed"] == 1
    assert (tmp_path / "b" / "t.committed.mpd").exists()


SUBMODEL = '''0 FILE Main.ldr
1 4 100 0 0 0 0 1 0 1 0 -1 0 0 Arm.ldr
0 STEP
0 STEP
1 1 -100 0 0 1 0 0 0 1 0 0 0 1 ARM.LDR
0 STEP
0 NOFILE
0 FILE Arm.ldr
1 16 20 0 0 1 0 0 0 1 0 0 0 1 plate.ldr
0 STEP
1 14 0 -8 0 1 0 0 0 1 0 0 0 1 3024.dat
0 NOFILE
0 FILE plate.ldr
1 16 0 -8 0 1 0 0 0 1 0 0 0 1 3023.dat
0 NOFILE
0 FILE unused.ldr
1 4 999 999 999 1 0 0 0 1 0 0 0 1 3001.dat
0 NOFILE
'''


def test_nested_repeated_subassembly_transforms_colours_and_steps(tmp_path):
    source=tmp_path/'assemblies.mpd';source.write_text(SUBMODEL)
    steps=R.steps_from_omr(str(source),preserve_empty=True)
    assert [len(s) for s in steps] == [2,0,2]
    assert [p for p,c,m in steps[0]] == ['3023','3024']
    assert [c for p,c,m in steps[0]] == [4,14]
    assert [c for p,c,m in steps[2]] == [1,14]
    assert np.allclose(steps[0][0][2][:3,3],[100,-8,-20])
    assert np.allclose(steps[2][0][2][:3,3],[-80,-8,0])
    report=R.from_omr(str(source),str(tmp_path/'out'),'nested')
    assert report['piecesPerStep']==[2,0,2]
    assert not report['buildabilityValidated']
    exported=R.steps_from_omr(str(tmp_path/'out/nested.mpd'),preserve_empty=True)
    assert [len(s) for s in exported]==[2,0,2]
    for a,b in zip([p for s in steps for p in s],[p for s in exported for p in s]):
        assert a[:2]==b[:2] and np.allclose(a[2],b[2])


def test_cyclic_and_missing_submodels_are_rejected(tmp_path):
    import pytest
    source=tmp_path/'invalid.mpd'
    source.write_text('0 FILE main.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 main.ldr\n')
    with pytest.raises(ValueError,match='Cyclic'):
        R.steps_from_omr(str(source))
    source.write_text('0 FILE main.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 missing.ldr\n')
    with pytest.raises(ValueError,match='Missing'):
        R.steps_from_omr(str(source))


def test_rejected_proposal_cannot_poison_next_step_occupancy(tmp_path,monkeypatch):
    import brickheadz.instruction_place as placer
    observations=[]
    def search(lib,parts,cam,size,occupied,*args,**kwargs):
        observations.append(set(occupied))
        occupied.add((999,999,999))
        return [('3001',4,(0,0,0,tuple(map(tuple,np.eye(3)))),np.eye(4),.1,None)]
    monkeypatch.setattr(placer,'reconstruct_step',search)
    image=tmp_path/'rectangle.png'
    _save_png(np.full((30,60,3),255),str(image))
    spec={'cam':{'yaw':30,'pitch':25,'scale':1,'ox':0,'oy':0},
          'steps':[{'image':str(image),'parts':[['3001',4]]}]*2}
    report=R.propose(None,{4:(196,40,28)},spec,str(tmp_path/'out'),min_confidence=.9)
    assert observations==[set(),set()]
    assert report['summary']['committed']==0
