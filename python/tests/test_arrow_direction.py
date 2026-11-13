from pathlib import Path
import copy,json
import numpy as np
import pytest
pytest.importorskip('torch');pytest.importorskip('cv2');pytest.importorskip('scipy')
import torch
from brickheadz.arrow_annotations import validate_instances,transform_instances
from brickheadz.arrow_direction import ArrowDirectionNet,direction_loss,decode_direction,angular_error,evaluate,save,load,raw_tensor_images
from brickheadz.keypoint_model import KeypointNet
from brickheadz.keypoint_data import load_reviewed,letterbox,augment


def sample():
    arrow={'id':'bent','tip':[80.,50.],'head_base':[60.,50.],
           'shaft':[[20.,10.],[60.,10.],[60.,50.]],'shaft_complete':True,'direction_reviewed':True,'purpose':'unknown'}
    return {'rgb':np.full((100,100,3),220,np.uint8),'studs':[],'arrow_tips':[[80.,50.]],
            'complete':[False,True],'arrow_instances':[arrow]}


def test_bent_arrow_direction_follows_local_head_not_tail_displacement():
    row=sample();validate_instances(row);arrow=row['arrow_instances'][0]
    local=np.array(arrow['tip'])-arrow['head_base'];whole=np.array(arrow['tip'])-arrow['shaft'][0]
    assert angular_error(local,[1,0])==0 and angular_error(local,whole)>30
    transformed=transform_instances([arrow],[[0,1,0],[-1,0,99]],(100,100))[0]
    assert angular_error(np.array(transformed['tip'])-transformed['head_base'],[0,-1])==0
    assert transformed['shaft'][-1]==transformed['head_base']


def test_cropped_head_is_unknown_and_partial_shaft_remains_explicit():
    arrow=sample()['arrow_instances'][0]
    assert transform_instances([arrow],[[1,0,-65],[0,1,0]],(35,100))==[]
    cropped=transform_instances([arrow],[[1,0,-40],[0,1,0]],(60,100))[0]
    assert not cropped['shaft_complete']
    assert arrow['shaft_complete'] and arrow['shaft'][0]==[20,10]


def test_annotation_validation_rejects_identity_and_tip_errors():
    row=sample();row['arrow_instances'][0]['tip']=[70,50]
    with pytest.raises(ValueError,match='mismatch'):validate_instances(row)
    row=sample();row['arrow_instances'][0]['head_base']=[80,50]
    with pytest.raises(ValueError,match='Degenerate'):validate_instances(row)


def test_direction_decoding_uses_original_coordinates_and_abstains():
    field=np.zeros((3,128,128),np.float32);field[1]=1
    arrow=decode_direction(field,[[100,50,.8]],scale=.5,offset=(20,30))[0]
    assert arrow['direction']==[0,1] and arrow['angleDegrees']==90
    assert np.allclose(arrow['headBase'],[100,18])
    assert decode_direction(field*0,[[100,50,.8]])[0]['direction'] is None


def test_correct_tip_with_reversed_direction_fails_joint_metric():
    row=sample();row['rgb']=np.full((256,256,3),220,np.uint8)
    row['arrow_instances'][0]['head_base']=[80,30]
    heat=np.zeros((2,128,128),np.float32);heat[1,25,40]=.9
    offset=np.zeros((4,128,128),np.float32);field=np.zeros((3,128,128),np.float32);field[1]=-1
    result=evaluate([row],[(heat,offset,field)],[.3,.3],hybrid=False)['metrics']
    assert result['matchedTips']==1 and result['falsePositives']==0
    assert result['directedCorrect']==0 and result['reversed']==1
    assert result['oracleTipDirection']['meanDegrees']==180
    assert result['alwaysDownOracleBaseline']['within15Degrees']==1


def test_direction_training_leaves_detector_predictions_and_parameters_unchanged():
    torch.manual_seed(42);base=KeypointNet().eval();net=ArrowDirectionNet(base).train()
    x=torch.randn(1,3,256,256);before={k:v.clone() for k,v in base.state_dict().items()}
    with torch.no_grad():expected=base(x)
    heat,offset,field=net(x,x)
    assert torch.equal(heat,expected[0]) and torch.equal(offset,expected[1])
    assert not base.training
    value=direction_loss(field,[sample()]);value.backward()
    assert all(p.grad is None for p in base.parameters())
    assert any(p.grad is not None and p.grad.abs().sum()>0 for p in net.direction.parameters())
    opt=torch.optim.Adam(net.direction.parameters());opt.step()
    assert all(torch.equal(v,base.state_dict()[k]) for k,v in before.items())


def test_unknown_directions_have_no_loss_and_checkpoints_roundtrip(tmp_path):
    field=torch.randn(1,3,128,128,requires_grad=True)
    row=sample();row['arrow_instances']=[]
    loss=direction_loss(field,[row]);loss.backward();assert field.grad.abs().sum()==0
    net=ArrowDirectionNet();path=tmp_path/'direction.pt';save(path,net,[.2,.4],{'test':True})
    other,thresholds,meta=load(path);assert thresholds==[.2,.4] and meta['test']
    assert all(torch.equal(v,other.state_dict()[k]) for k,v in net.state_dict().items())
    torch.save({'format':'old-tip-detector'},path)
    with pytest.raises(ValueError,match='Unsupported'):load(path)


def test_direction_labels_are_complete_and_new_book_excluded_from_training():
    root=Path(__file__).resolve().parents[2];path=root/'benchmarks/instructions/arrow-direction-labels.json'
    try:rows=load_reviewed(path,root)
    except FileNotFoundError:pytest.skip('Private booklet images unavailable')
    for row in rows:validate_instances(row)
    training={r['booklet'] for r in rows if r['split']=='train'}
    new=[r for r in rows if r['booklet']=='6668733']
    assert '6668733' not in training and all(r['split']=='test' for r in new)
    assert sum(len(r['arrow_instances']) for r in new)==8
    assert any(a['shaft'] and len(a['shaft'])>2 for r in rows for a in r['arrow_instances'])


def test_augmentation_preserves_local_direction_and_original_annotations():
    row=sample();original=copy.deepcopy(row['arrow_instances'])
    transformed=augment(row,np.random.default_rng(9),focus_probability=1.)
    assert row['arrow_instances']==original
    assert len(transformed['arrow_instances'])==1
    a=transformed['arrow_instances'][0]
    assert angular_error(np.array(a['tip'])-a['head_base'],[1,0])<7


def test_raw_detail_input_keeps_black_arrow_contrast():
    from brickheadz.keypoint_model import tensor_images
    image=np.full((16,16,3),240,np.uint8);image[6:10,7:9]=0
    previous=tensor_images([image]);preserved=raw_tensor_images([image])
    assert torch.equal(previous[:,:,0,0],previous[:,:,7,8])
    assert (preserved[:,:,0,0]-preserved[:,:,7,8]).abs().min()>.9
    with pytest.raises(ValueError,match='background-preserved'):
        ArrowDirectionNet()(torch.zeros(1,3,256,256))


@pytest.mark.parametrize('use_detail',[False,True])
def test_direction_checkpoint_versions_keep_preprocessing_contract(tmp_path,use_detail):
    model=ArrowDirectionNet(use_detail=use_detail);path=tmp_path/'direction.pt'
    save(path,model,[.3,.3],{})
    restored,_,_=load(path)
    assert restored.use_detail==use_detail
    assert all(torch.equal(v,restored.state_dict()[k]) for k,v in model.state_dict().items())
