from pathlib import Path
import numpy as np
import pytest

pytest.importorskip('torch');pytest.importorskip('cv2');pytest.importorskip('scipy')
import torch
from brickheadz.keypoint_model import KeypointNet,targets,loss,decode,point_counts,save,load
from brickheadz.keypoint_data import letterbox,augment,load_reviewed


def sample():
    return {'rgb':np.full((80,100,3),220,np.uint8),'studs':[[20.3,30.5]],'arrow_tips':[[60.,50.]],
            'complete':[True,True]}


def test_targets_preserve_subpixel_offsets_and_ignore_unknown_channels():
    row,_=letterbox(sample());row['complete']=[True,False]
    heat,offset,mask,complete=targets([row])
    assert heat.shape==(1,2,128,128) and mask.sum()==1
    assert heat[0,1].sum()==0 and complete.tolist()==[[1,0]]
    x,y=np.rint(np.array(row['studs'][0])/2).astype(int)
    recovered=(np.array([x,y])+offset[0,:2,y,x].numpy())*2
    assert np.allclose(recovered,row['studs'][0])


def test_loss_is_finite_and_backpropagates():
    net=KeypointNet();row,_=letterbox(sample())
    value=loss(net(torch.zeros(1,3,256,256)),targets([row]))
    assert torch.isfinite(value);value.backward()
    assert net.heat.weight.grad is not None


def test_decoder_uses_offset_and_one_to_one_metric():
    heat=np.zeros((2,128,128),np.float32);offset=np.zeros((4,128,128),np.float32)
    heat[0,10,12]=.9;offset[:2,10,12]=[.25,-.25]
    points=decode(heat,offset)[0]
    assert np.allclose(points[0][:2],[24.5,19.5])
    tp,fp,fn,_=point_counts([[10,10],[10.2,10.2]],[[10,10]],4)
    assert (tp,fp,fn)==(1,1,0)


def test_checkpoint_roundtrip(tmp_path):
    model=KeypointNet().eval();path=tmp_path/'kp.pt'
    save(path,model,{'test':True},(.2,.3))
    other,thresholds,metadata=load(path)
    assert thresholds==[.2,.3] and metadata['test']
    assert all(torch.equal(v,other.state_dict()[k]) for k,v in model.state_dict().items())


def test_frozen_annotations_have_disjoint_booklets_and_partial_labels():
    root=Path(__file__).resolve().parents[2]
    try:rows=load_reviewed(root/'benchmarks/instructions/keypoint-labels.json',root)
    except FileNotFoundError:pytest.skip('Private booklet images unavailable')
    train={r['booklet'] for r in rows if r['split']=='train'}
    test={r['booklet'] for r in rows if r['split']=='test'}
    assert not train&test
    assert any(not r['complete'][0] and r['complete'][1] for r in rows)
    assert len(next(r for r in rows if r['id']=='6668730-s1-panel0')['studs'])==20


def test_unlabelled_channel_contributes_no_gradient():
    row,_=letterbox(sample());row['complete']=[True,False]
    heat=torch.zeros(1,2,128,128,requires_grad=True)
    offsets=torch.zeros(1,4,128,128,requires_grad=True)
    loss((heat,offsets),targets([row])).backward()
    assert heat.grad[0,1].abs().sum()==0
    assert offsets.grad[0,2:].abs().sum()==0


def test_encoder_initialization_reuses_original_weights():
    from brickheadz.keypoint_model import initialize
    root=Path(__file__).resolve().parents[2];path=root/'python/.cache/part_classifier/model2.pt'
    if not path.exists():pytest.skip('Private video checkpoint unavailable')
    model,_meta=initialize(path)
    original=torch.load(path,map_location='cpu',weights_only=True)
    assert torch.equal(model.encoder[0][0].weight,original['0.0.weight'])
    assert not model.encoder[0][0].weight.requires_grad


def test_pose_feature_contract_and_invalid_checkpoint(tmp_path):
    from brickheadz.pose_ranker import feature_patch,PoseRanker
    rgb=np.full((30,60,3),200,np.uint8);mask=np.ones((30,60),bool)
    features=feature_patch(rgb,mask,mask,mask)
    assert features.shape==(4,48,48)
    assert np.all(features[:,30:]==0)
    path=tmp_path/'bad.pt';torch.save({'format':'other'},path)
    with pytest.raises(ValueError,match='Unsupported'):PoseRanker(path)


def test_invalid_neural_scores_cannot_bypass_candidate_validation():
    from assembly_model.ldraw import load_library
    from brickheadz.booklet_vision import Observation,solve_additions
    from brickheadz.instruction_place import Camera,grid_matrix
    root=Path(__file__).resolve().parents[2];lib=load_library(str(root/'public/ldraw'))
    matrix=grid_matrix(lib,'3022',0,0,0,np.eye(3))[0]
    obs=Observation(np.full((64,64,3),(200,0,0),np.uint8),np.ones((64,64),bool),np.empty((0,4)),np.empty((0,2)))
    def broken(*args):return [float('nan')]*len(args[3])
    with pytest.raises(ValueError,match='Invalid candidate ranker'):
        solve_additions(lib,[('3022',4,matrix)],[('3024',4)],obs,Camera(35,-35,1,32,32),{4:(200,0,0)},(2,2),candidate_ranker=broken)


def test_tiled_prediction_preserves_original_pixels_and_merges_seams(monkeypatch):
    import cv2
    import brickheadz.keypoint_model as module
    rgb=np.full((320,600,3),220,np.uint8)
    expected=[[190,100],[390,240],[590,310]]
    for x,y in expected:cv2.circle(rgb,(x,y),4,(255,0,0),-1)
    def fake_maps(model,samples,device,batch):
        result=[]
        for sample in samples:
            boxed,_=letterbox(sample);im=boxed['rgb']
            mask=((im[:,:,0]>250)&(im[:,:,1]<5)).astype(np.uint8)
            n,_,stats,centres=cv2.connectedComponentsWithStats(mask)
            heat=np.zeros((2,128,128),np.float32);offset=np.zeros((4,128,128),np.float32)
            for (x,y),stat in zip(centres[1:],stats[1:]):
                if stat[4]<40:continue
                ix,iy=np.rint(np.array([x,y])/2).astype(int)
                heat[0,iy,ix]=.9;offset[:2,iy,ix]=np.array([x,y])/2-[ix,iy]
            result.append((heat,offset))
        return result
    monkeypatch.setattr(module,'predict_maps',fake_maps)
    points=module.predict_image(None,rgb,tile_scale=1.)[0]
    assert len(points)==len(expected)
    assert point_counts(points,expected,1)[:3]==(3,0,0)
    with pytest.raises(ValueError,match='positive'):module.predict_image(None,rgb,tile_scale=0)


def test_point_matching_prioritizes_number_of_valid_pairs():
    # Exact first match would leave the second point just outside tolerance.
    tp,fp,fn,_=point_counts([[0,0],[3.9,0]],[[0,0],[-.2,0]],4)
    assert (tp,fp,fn)==(2,0,0)


def test_pdf_subset_scoring_rejects_changed_source_and_keeps_page_scope():
    import importlib.util
    root=Path(__file__).resolve().parents[2]
    spec=importlib.util.spec_from_file_location('detect_pdf_keypoints',root/'scripts/detect_pdf_keypoints.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    report={'pdfSHA256':'known','dpi':150,'pages':[{'page':2,'studs':[[10,10,.9],[100,100,.8]],'studCount':2}],'summary':{}}
    labels={'pdfSHA256':'known','dpi':150,'limitations':'small subset','samples':[
        {'id':'p2','reviewed':True,'studs_complete':True,'page':2,'pageCropPixels':[0,0,20,20],'studs':[[10,10]]}]}
    module.add_review(report,labels)
    assert report['reviewedSubset']['tp']==1 and report['reviewedSubset']['fp']==0
    module.add_steps(report,{'steps':[{'page':2,'number':1}]})
    assert report['summary']['instructionPageStudProposals']==2
    labels['dpi']=72
    with pytest.raises(ValueError,match='same PDF'):module.add_review(report,labels)


def test_red_arrow_geometry_requires_shaft_head_and_preserves_black_proposals():
    import cv2
    from brickheadz.arrow_geometry import red_arrow_tips,fuse_arrow_tips
    rgb=np.full((150,220,3),230,np.uint8)
    # A long red rectangular part is not an arrow.
    cv2.rectangle(rgb,(140,20),(155,120),(220,0,0),-1)
    cv2.line(rgb,(60,15),(60,85),(220,0,0),3)
    cv2.fillConvexPoly(rgb,np.array([[50,80],[70,80],[60,110]]),(220,0,0))
    points=red_arrow_tips(rgb)
    assert point_counts(points,[[60,110]],3)[:3]==(1,0,0)
    merged=fuse_arrow_tips(rgb,[[100,100,.8]])
    assert point_counts(merged,[[60,110],[100,100]],3)[:3]==(2,0,0)
    # A nearby learned endpoint is refined, not duplicated.
    merged=fuse_arrow_tips(rgb,[[61,108,.8]])
    assert len(merged)==1 and np.linalg.norm(np.array(merged[0][:2])-[60,110])<3


def test_arrow_training_excludes_development_and_transfer_books():
    import json
    root=Path(__file__).resolve().parents[2];path=root/'benchmarks/instructions/arrow-learning-labels.json'
    definition=json.loads(path.read_text())
    try:rows=load_reviewed(path,root)
    except FileNotFoundError:pytest.skip('Private booklet images unavailable')
    training={r['booklet'] for r in rows if r['split']=='train'}
    assert not training&set(definition['developmentBooklets'])
    assert not training&set(definition['transferTestBooklets'])
    assert any(r['arrow_tips'] and not r['complete'][0] for r in rows if r['split']=='train')


def test_arrow_geometry_rejects_real_red_brick_faces_and_recovers_underside_arrows():
    from brickheadz.arrow_geometry import red_arrow_tips
    root=Path(__file__).resolve().parents[2]
    try:rows=load_reviewed(root/'benchmarks/instructions/keypoint-labels.json',root)
    except FileNotFoundError:pytest.skip('Private booklet images unavailable')
    negatives=[s for s in rows if s['booklet']=='6668730' and s['step'] in (2,3,4)]
    assert all(len(red_arrow_tips(s['rgb']))==0 for s in negatives)
    positive=next(s for s in rows if s['id']=='6668732-s3-panel0')
    assert point_counts(red_arrow_tips(positive['rgb']),positive['arrow_tips'])[:3]==(2,0,0)
