import numpy as np
import json
from pathlib import Path
import pytest
from booklet_mpd.diagnostic_audit import seed_frame_transforms,transform_parts,completion_evidence
from booklet_mpd.score import exact_flags


class Shapes:
    def triangles(self,name):
        # Point sets have the same rotational symmetries as the relevant parts.
        x,z=(2,2) if name=='square.dat' else (1,2)
        return np.array([[a,b,c] for a in (-x,x) for b in (0,1) for c in (-z,z)],float)


def pose(x=0,y=0,z=0,quarter=False):
    m=np.eye(4);m[:3,3]=[x,y,z]
    if quarter:m[:3,:3]=[[0,0,1],[0,1,0],[-1,0,0]]
    return m


def test_symmetric_seed_frame_recovers_correct_assembly_missed_by_anchor_matrices():
    lib=Shapes();pred=[('square',1,pose()),('rectangle',2,pose(-1,-1,0,True))]
    truth=[('square',1,pose()),('rectangle',2,pose(0,-1,1))]
    frames=seed_frame_transforms(lib,pred[0],truth[0])
    assert max(sum(exact_flags(lib,transform_parts(pred,t),truth)) for t in frames)==2
    # A genuinely displaced part remains incorrect in every valid seed frame.
    pred[1]=('rectangle',2,pose(-3,-1,0,True))
    assert max(sum(exact_flags(lib,transform_parts(pred,t),truth)) for t in frames)==1


def test_structural_audit_flags_repeat_and_unresolved_even_with_high_fit():
    good={'status':'ok','read':2,'placed':2,'fit_iou':.95,'number':1}
    rows=[good,{**good,'number':2,'repeat':2},{**good,'number':3,'unresolved':1}]
    result=completion_evidence(rows)
    assert result['structurallyIncompleteFrom']==2
    assert result['issues'][0]['reasons']==['unsupported-repeat']
    assert result['issues'][1]['reasons']==['unresolved-parts']
    assert result['poseCorrectness']=='not-established'


def test_a_successful_execution_never_certifies_correct_poses():
    result=completion_evidence([{'status':'ok','read':1,'placed':1,'fit_iou':.99}])
    assert result['structurallyIncompleteFrom'] is None
    assert result['poseCorrectness']=='not-established'


def test_missing_and_nonfinite_fit_or_empty_read_are_not_silent_successes():
    r=completion_evidence([{'status':'ok','read':1,'placed':0,'fit_iou':float('nan')}, {'status':'ok','read':0}])
    assert 'missing-placements' in r['issues'][0]['reasons']
    assert 'low-or-missing-fit' in r['issues'][0]['reasons']
    assert 'no-parts-read' in r['issues'][1]['reasons']


def test_real_41488_first_step_is_correct_up_to_a_symmetric_seed_frame():
    from assembly_model.ldraw import load_library
    root=Path(__file__).resolve().parents[2]
    if not (root/'public/ldraw/parts/3031.dat').exists():pytest.skip('LDraw library unavailable')
    data=json.loads((root/'benchmarks/booklet-mpd/41488-anchor-symmetry-regression.json').read_text())
    predicted=[(p,c,np.array(m)) for p,c,m in data['predicted']]
    expected=[(p,c,np.array(m)) for p,c,m in data['truth']]
    lib=load_library(str(root/'public/ldraw'))
    frames=seed_frame_transforms(lib,predicted[0],expected[0])
    assert max(sum(exact_flags(lib,transform_parts(predicted,t),expected)) for t in frames)==2


def test_real_step_two_correct_brick_wins_under_reference_camera():
    """Reference-camera diagnostic only: the correct connector candidate is scoreable."""
    import cv2,hashlib
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.render import View
    from booklet_mpd.solver.picture import Picture
    from booklet_mpd.solver.place import Scene,score_candidates
    from booklet_mpd.solver.candidates import candidates
    from booklet_mpd.solver.edges import ink_distance
    from booklet_mpd.viewfit import BOOKLET_SCALE
    root=Path(__file__).resolve().parents[2]
    data=json.loads((root/'benchmarks/booklet-mpd/41488-camera-selection-regression.json').read_text())
    source=data['sourceImage'];path=root/source['path']
    if not path.exists():pytest.skip('Run audit_booklet_solver_failure.py to materialize the source crop')
    rgb=cv2.cvtColor(cv2.imread(str(path)),cv2.COLOR_BGR2RGB)
    assert hashlib.sha256(rgb.tobytes()).hexdigest()==source['pixelSHA256']
    lib=load_library(str(root/'public/ldraw'))
    base=[(p,c,np.array(m)) for p,c,m in source['base']]
    expected=[(p,c,np.array(m)) for p,c,m in source['added'] if p=='3010']
    pts=source['ptsPerPixel'];picture=Picture.from_rgb(rgb,pts,BOOKLET_SCALE/pts)
    codes=sorted({c for p,c,m in base+[(p,c,np.array(m)) for p,c,m in source['added']]})
    fields=data['referenceCompletedModelCamera']['view'];fields={**fields,'orientation':np.array(fields['orientation'])}
    scene=Scene.build(lib,base,View(**fields),picture.classes(codes),codes,ink_distance(picture.rgb))
    scored=score_candidates(lib,scene,'3010',15,candidates(lib,'3010',base),deltas=(0.,))
    winner=max(scored,key=lambda s:s.score)
    assert exact_flags(lib,[('3010',15,winner.candidate['matrix'])],expected)==[True]
