"""Data isolation, checkpoint reuse, and preprocessing for booklet adaptation."""
from pathlib import Path
import json
import hashlib

import numpy as np
import pytest

cv2=pytest.importorskip('cv2')
torch=pytest.importorskip('torch')

from brickheadz.booklet_classifier import (
    adapt_head,classify,load_checkpoint,prepare_crop,save_checkpoint,split_booklet_rows,
)
from brickheadz.part_classifier import build_model,real_part


def image(colour=(0,0,210)):
    result=np.full((40,60,3),(242,214,179),np.uint8)
    result[10:30,15:45]=colour
    return result


def test_preprocess_removes_page_background_and_padding():
    original=image()
    padded=cv2.copyMakeBorder(original,9,14,8,13,cv2.BORDER_CONSTANT,value=(242,214,179))
    assert np.array_equal(prepare_crop(original),prepare_crop(padded))
    assert not prepare_crop(original)[0].any()
    with pytest.raises(ValueError,match='foreground'):
        prepare_crop(np.full((10,10,3),200,np.uint8))


def test_primitive_geometry_is_not_a_part_identity():
    vocab=['2431','s\\2431s01','1-4chrd','stud','87079pr0255']
    assert real_part('1-4chrd',vocab) is None
    assert real_part('stud',vocab) is None
    assert real_part('s\\2431s01',vocab)=='2431'
    assert real_part('87079pr0255',vocab)=='87079pr0255'


def test_booklet_split_excludes_reused_artwork(tmp_path):
    paths=[]
    for i,im in enumerate([image(),image((210,0,0)),image()]):
        path=tmp_path/f'{i}.png';cv2.imwrite(str(path),im);paths.append(str(path))
    def step(booklet,path):
        return {'booklet':booklet,'number':1,'parts':[{'part':'3001','color':4,'countVerified':True,
                                                    'matchScore':.99,'image':path}]}
    job={'models':[{'steps':[step('6668730',paths[0]),step('6668730',paths[1]),step('6668732',paths[2])]}]}
    rows,removed=split_booklet_rows(job)
    assert len(removed)==1 and removed[0]['path']==paths[0]
    assert sum(r['split']=='train' for r in rows)==1
    assert sum(r['split']=='test' for r in rows)==1


def test_adaptation_reuses_encoder_and_adds_new_class():
    parent=build_model(3,width=32)
    adapted,vocab=adapt_head(parent,['3001','2431','1-4chrd'],['1126'],base_parts=['3001','2431'])
    assert vocab==['3001','2431','1126']
    assert torch.equal(parent[0][0].weight,adapted[0][0].weight)
    assert not adapted[0][0].weight.requires_grad
    assert adapted[3][0].weight.requires_grad
    assert torch.equal(parent[7].weight[0],adapted[7].weight[0])


def test_safe_checkpoint_roundtrip(tmp_path):
    model=build_model(2,width=32).eval();vocab=['3001','2431']
    path=tmp_path/'model.pt'
    save_checkpoint(path,model,vocab,{'parent':'test','epoch':1})
    loaded,classes,metadata=load_checkpoint(path)
    assert classes==vocab and metadata['epoch']==1
    before=classify(model,vocab,[prepare_crop(image())])
    after=classify(loaded,classes,[prepare_crop(image())])
    assert before==after


def test_trained_artifact_preserves_frozen_encoder_and_parent():
    root=Path(__file__).resolve().parents[2]
    artifact=root/'.cache/instructions/part-learning/pilot/best.pt'
    if not artifact.exists():pytest.skip('Run the local booklet classifier pilot first')
    model,vocab,metadata=load_checkpoint(artifact)
    parent_path=Path(metadata['parent']['path'])
    assert hashlib.sha256(parent_path.read_bytes()).hexdigest()==metadata['parent']['sha256']
    parent=torch.load(parent_path,map_location='cpu',weights_only=True)
    state=model.state_dict()
    assert all(real_part(p,vocab)==p for p in vocab)
    for key in state:
        if key.startswith(('0.','1.','2.')):
            assert torch.equal(state[key],parent[key])
    assert not torch.equal(state['3.0.weight'],parent['3.0.weight'])
    assert metadata['testUsedForCheckpointSelection'] is False
