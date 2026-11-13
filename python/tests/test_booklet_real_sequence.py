"""Real-PDF integration tests. Evaluation poses never enter the inference API."""
from pathlib import Path
import json
import importlib.util

import numpy as np
import pytest

pytest.importorskip('cv2')
pytest.importorskip('scipy')

from assembly_model.ldraw import load_library
from brickheadz.booklet_vision import reconstruct_sequence,reconstruct_panel_build
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.parts import info
from brickheadz.reconstruct import steps_from_omr

ROOT=Path(__file__).resolve().parents[2]
JOB=ROOT/'.cache/instructions/heroes-complete-regression/placement-job.json'
REFERENCE=ROOT/'benchmarks/instructions/superman-opening-reference.ldr'

spec=importlib.util.spec_from_file_location('real_sequence_runner',ROOT/'scripts/reconstruct_real_sequence.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)


@pytest.fixture(scope='module')
def evidence():
    if not JOB.exists() or not REFERENCE.exists():
        pytest.skip('Local Superman booklet extraction/reference unavailable; run the documented real-sequence setup')
    job=json.loads(JOB.read_text());model=job['models'][0]
    lib=load_library(str(ROOT/'public/ldraw'));palette=ldconfig_rgb(str(ROOT/'public/ldraw/LDConfig.ldr'))
    steps=[]
    for s in model['steps'][:4]:
        steps.append({'number':s['number'],'rgb':runner.read_image(s['image']),
                      'parts':[(p['part'],p['color']) for p in s['parts'] for _ in range(p['count'])]})
    seed=job['unassignedInventory'][0]
    return lib,palette,steps,(seed['part'],seed['color']),model


def test_real_exploded_sequence_exact_without_truth_inference(evidence):
    lib,palette,steps,seed,_model=evidence
    built,groups,reports=reconstruct_sequence(lib,palette,steps,seed)
    # Only now load the reference, after all four steps are inferred and committed.
    expected=steps_from_omr(str(REFERENCE),preserve_empty=True)[:4]
    assert runner.evaluate_groups(lib,groups,expected)['allExact']
    assert [len(g) for g in groups]==[2,1,1,2]
    assert reports[0]['detectedArrows']==2
    assert all(s['camera']['rmsPixels']<.3 for s in reports)


def test_real_sequence_survives_resizing_and_padding(evidence):
    import cv2
    lib,palette,steps,seed,_model=evidence
    changed=[]
    for step in steps:
        rgb=cv2.resize(step['rgb'],None,fx=1.25,fy=1.25)
        bg=tuple(map(int,step['rgb'][0,0]))
        rgb=cv2.copyMakeBorder(rgb,19,31,23,17,cv2.BORDER_CONSTANT,value=bg)
        changed.append({**step,'rgb':rgb})
    built,groups,_reports=reconstruct_sequence(lib,palette,changed,seed)
    expected=steps_from_omr(str(REFERENCE),preserve_empty=True)[:4]
    assert runner.evaluate_groups(lib,groups,expected)['allExact']


def test_real_two_panel_subbuild_exact(evidence):
    lib,palette,_steps,_seed,model=evidence
    step=next(s for s in model['steps'] if s['number']==34)
    parts=[(p['part'],p['color']) for p in step['parts'] for _ in range(p['count'])]
    built,groups,reports,panels=reconstruct_panel_build(lib,palette,runner.read_image(step['image']),parts)
    expected=steps_from_omr(str(ROOT/'benchmarks/instructions/superman-34-audited.ldr'),preserve_empty=True)
    assert runner.evaluate_groups(lib,groups,expected)['allExact']
    assert len(panels)==2 and [len(g) for g in groups]==[2,1]
    assert reports[0]['detectedStuds']==8 and reports[1]['detectedStuds']==0


def test_underside_tubes_do_not_shrink_plate_body():
    lib=load_library(str(ROOT/'public/ldraw'))
    for part in ('3710','3031','3020'):
        pi=info(lib,part)
        assert pi.lo[1]==0 and pi.hi[1]==8 and pi.h==1


def test_batman_opening_holdout_uses_same_solver(evidence):
    lib,palette,_steps,_seed,_model=evidence
    job=json.loads(JOB.read_text());steps=[]
    for i,s in enumerate(job['models'][1]['steps'][:2]):
        parts=[(p['part'],p['color']) for p in s['parts'] for _ in range(p['count'])]
        if i==0:
            seed=max(parts,key=lambda pc:info(lib,pc[0]).w*info(lib,pc[0]).d)
            parts.remove(seed)
        steps.append({'number':s['number'],'rgb':runner.read_image(s['image']),'parts':parts})
    built,groups,reports=reconstruct_sequence(lib,palette,steps,seed)
    expected=steps_from_omr(str(ROOT/'benchmarks/instructions/batman-opening-reference.ldr'),preserve_empty=True)[:2]
    assert runner.evaluate_groups(lib,groups,expected)['allExact']
    assert all(s['camera']['rmsPixels']<.3 for s in reports)


def test_unusable_image_is_rejected():
    from brickheadz.booklet_vision import observe
    with pytest.raises(ValueError,match='No usable'):
        observe(np.full((100,100,3),255,np.uint8))


def test_step_evaluation_rejects_swapping_identical_pieces_between_steps(evidence):
    lib,_palette,_steps,_seed,_model=evidence
    groups=steps_from_omr(str(ROOT/'benchmarks/instructions/batman-opening-reference.ldr'),preserve_empty=True)[:2]
    incorrect=[[groups[0][0],groups[1][0]],[groups[0][1]]]
    assert runner.evaluate(lib,[p for g in incorrect for p in g],[p for g in groups for p in g])['allExact']
    assert not runner.evaluate_groups(lib,incorrect,groups)['allExact']
